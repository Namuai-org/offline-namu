package org.namuai.offline.core.store

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.io.TempDir
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.testing.Fixtures
import org.namuai.offline.core.testing.Harness
import org.namuai.offline.core.transfer.Phase
import org.namuai.offline.core.transfer.RunOutcome
import org.namuai.offline.core.util.SimulatedCrash
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * T10 (DL-012): kill the process at every activation checkpoint, restart,
 * reconcile, and require exactly one valid active pointer with a
 * deterministic, self-consistent state.
 */
class ActivationCrashTest {
    @TempDir
    lateinit var dir: File
    private val open = ArrayList<Harness>()

    @AfterEach
    fun tearDown() = open.forEach { it.close() }

    private companion object {
        const val SMALL_MODEL = 96 * 1024
    }

    private class Scenario(val h: Harness, val oldSha: String?, val newSha: String, val transferId: String)

    /** Builds "v1 installed (optional), v2 staged and self-testing". */
    private fun scenario(name: String, withInstalledModel: Boolean): Scenario {
        // Activation does not depend on the artifact size: small models keep 30+ scenarios cheap.
        val h = Harness(File(dir, name), model = Fixtures.ggufModel(SMALL_MODEL)).also(open::add)
        var oldSha: String? = null
        if (withInstalledModel) {
            h.installBundled()
            oldSha = h.sha
            val update = Fixtures.ggufModel(SMALL_MODEL, seed = 1234)
            val updateSha = Fixtures.sha256(update)
            h.server.artifact = update
            h.server.artifactPath = "models/aya-global-q4km/$updateSha/model.gguf"
            h.server.stableJson = h.signer.envelope(Fixtures.payload(updateSha, update.size.toLong(), sequence = 2, version = "v2"))
            assertTrue(h.service.checkForUpdateJson().contains("available"))
            val id = h.service.start("update", false)
            assertIs<RunOutcome.Staged>(h.run(id))
            return Scenario(h, oldSha, updateSha, id)
        }
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        return Scenario(h, null, h.sha, id)
    }

    @Test
    fun checkpointInventoryCoversMarkerPointerAndJournalSteps() {
        val s = scenario("inventory", withInstalledModel = true)
        s.h.service.beginSelfTest(s.transferId)
        s.h.hook.seen.clear()
        s.h.service.activate(s.transferId, true, "")
        val names = s.h.hook.seen
        for (required in listOf(
            "activate.begin", "marker.afterTmpFsync", "activate.afterMarkerPassed",
            "pointer.beforeTmpWrite", "pointer.afterPartialTmpWrite", "pointer.afterTmpWrite",
            "pointer.afterTmpFsync", "pointer.afterRename", "pointer.afterDirFsync",
            "activate.afterPointer", "activate.afterMirror", "activate.afterJournalCommit",
            "activate.afterMarkerDelete",
        )) {
            assertTrue(required in names, "missing checkpoint $required in $names")
        }
    }

    @TestFactory
    fun t10_crashAtEveryActivationCheckpoint(): List<DynamicTest> {
        // Discover the checkpoint names from a clean run so new ones are covered automatically.
        val probe = scenario("discover", withInstalledModel = true)
        probe.h.service.beginSelfTest(probe.transferId)
        probe.h.hook.seen.clear()
        probe.h.service.activate(probe.transferId, true, "")
        val checkpoints = probe.h.hook.seen.distinct()
        assertTrue(checkpoints.size >= 15, "expected marker, pointer and journal checkpoints: $checkpoints")

        return listOf(true, false).flatMap { withOld ->
            checkpoints.map { checkpoint ->
                DynamicTest.dynamicTest("crash at $checkpoint (previous model: $withOld)") {
                    crashAndRecover(checkpoint, withOld)
                }
            }
        }
    }

    private fun crashAndRecover(checkpoint: String, withOld: Boolean) {
        val s = scenario("crash-${checkpoint.replace('.', '-')}-$withOld", withOld)
        try {
            crashAndRecover(s, checkpoint, withOld)
        } finally {
            s.h.close()
            open.remove(s.h)
        }
    }

    private fun crashAndRecover(s: Scenario, checkpoint: String, withOld: Boolean) {
        val h = s.h
        h.service.beginSelfTest(s.transferId)
        h.hook.target = checkpoint // the activation dies exactly here
        assertFailsWith<SimulatedCrash> { h.service.activate(s.transferId, true, "") }

        // ---- process restart --------------------------------------------------------------
        h.restart()
        h.service.ensureReconciled()

        val read = h.service.store.pointers.read()
        val pointerSwitched = (read as? PointerRead.Valid)?.pointer?.active?.artifactId == s.newSha
        val row = h.journal.get(s.transferId)

        // Exactly one valid pointer, never a torn or temporary one.
        assertFalse(read is PointerRead.Corrupt, "pointer must never be corrupt")
        assertFalse(h.layout.activePointerTmp.exists(), "a .tmp is never promoted and is cleaned up")
        assertFalse(h.layout.pendingMarker.exists(), "marker resolved")
        assertFalse(h.layout.pendingMarkerTmp.exists())

        if (pointerSwitched) {
            val pointer = (read as PointerRead.Valid).pointer
            assertEquals(Phase.INSTALLED, row!!.phase, "journal commit is completed by recovery")
            assertEquals(s.oldSha, pointer.previous?.artifactId, "old version is retained as previous (DL-013)")
            assertTrue(h.service.store.releaseIsIntact(pointer.active))
            assertEquals(pointer.toJson(), h.journal.getMeta("active_mirror"), "mirror rewritten from the pointer")
        } else {
            // The old pointer (or none) is still the authority.
            if (withOld) {
                val pointer = assertIs<PointerRead.Valid>(read).pointer
                assertEquals(s.oldSha, pointer.active.artifactId)
                assertTrue(h.service.store.releaseIsIntact(pointer.active), "old model still works offline")
            } else {
                assertIs<PointerRead.Missing>(read)
            }
            assertNotNull(row)
            when (row.phase) {
                // Marker already said "passed": the good candidate stays staged and can be activated again.
                Phase.STAGED -> {
                    assertTrue(h.service.store.releaseIsIntact(s.newSha, row.expectedBytes))
                    assertFalse(h.journal.isBadDigest(s.newSha))
                }
                // Marker did not yet say "passed": indistinguishable from a crashed self-test → quarantine.
                Phase.FAILED -> {
                    assertEquals(ErrorCodes.MODEL_LOAD_FAILED, row.lastError)
                    assertTrue(h.journal.isBadDigest(s.newSha))
                    assertFalse(h.layout.releaseDir(s.newSha).exists(), "candidate removed, nothing else")
                }
                else -> throw AssertionError("unexpected phase ${row.phase}")
            }
        }
        val expectedState = if (pointerSwitched || withOld) "installed" else "absent"
        assertTrue(h.service.snapshotJson().contains("\"state\":\"$expectedState\""))

        // Recovery is deterministic: a second restart changes nothing.
        val pointerBytes = if (h.layout.activePointer.exists()) h.layout.activePointer.readText() else null
        val phase = h.journal.get(s.transferId)?.phase
        h.restart()
        h.service.ensureReconciled()
        assertEquals(pointerBytes, if (h.layout.activePointer.exists()) h.layout.activePointer.readText() else null)
        assertEquals(phase, h.journal.get(s.transferId)?.phase)

        // And the staged candidate can still complete activation afterwards.
        if (!pointerSwitched && phase == Phase.STAGED) {
            h.service.beginSelfTest(s.transferId)
            h.service.activate(s.transferId, true, "")
            assertEquals(s.newSha, h.service.store.currentPointer()!!.active.artifactId)
        }
    }

    @Test
    fun crashDuringSelfTestQuarantinesTheCandidateAndKeepsTheOldModel() {
        val s = scenario("selftest-crash", withInstalledModel = true)
        s.h.service.beginSelfTest(s.transferId)
        assertTrue(s.h.layout.pendingMarker.exists(), "marker is durable before the self-test starts")
        // Native crash while loading: the process dies, nothing else is written.
        s.h.restart()
        val snapshot = s.h.service.snapshotJson()
        assertTrue(snapshot.contains("\"state\":\"installed\""))
        assertTrue(snapshot.contains("\"errorCode\":\"MODEL_LOAD_FAILED\""))
        assertEquals(s.oldSha, s.h.service.store.currentPointer()!!.active.artifactId)
        assertTrue(s.h.journal.isBadDigest(s.newSha))
        assertFalse(s.h.layout.releaseDir(s.newSha).exists())
        assertFalse(s.h.layout.pendingMarker.exists())
        // No reload loop: the bad digest cannot be started again.
        val e = assertFailsWith<NamuException> { s.h.service.start("update", false) }
        assertEquals(ErrorCodes.FILE_DAMAGED, e.code)
    }

    @Test
    fun tornTemporaryPointerIsIgnored() {
        val s = scenario("torn", withInstalledModel = true)
        val before = s.h.layout.activePointer.readText()
        s.h.layout.activePointerTmp.writeText("{\"schema\":1,\"active\":{\"artifactId\":\"")
        s.h.restart()
        s.h.service.ensureReconciled()
        assertEquals(before, s.h.layout.activePointer.readText())
        assertFalse(s.h.layout.activePointerTmp.exists())
    }

    @Test
    fun corruptPointerWithATemporaryFileNeverPromotesIt() {
        val s = scenario("corrupt", withInstalledModel = false)
        s.h.service.beginSelfTest(s.transferId)
        s.h.service.activate(s.transferId, true, "")
        val good = s.h.layout.activePointer.readText()
        s.h.layout.activePointer.writeText("garbage")
        s.h.layout.activePointerTmp.writeText(good) // even a perfectly valid .tmp is not promoted
        s.h.restart()
        val snapshot = s.h.service.snapshotJson()
        assertTrue(snapshot.contains("\"state\":\"absent\""))
        assertFalse(s.h.layout.activePointerTmp.exists())
        // The verified release without a pointer is staged, not installed, and can be re-activated.
        assertEquals(Phase.STAGED, s.h.journal.get(s.transferId)!!.phase)
        assertNull(s.h.journal.getMeta("active_mirror"))
        s.h.service.beginSelfTest(s.transferId)
        assertTrue(s.h.service.activate(s.transferId, true, "").contains("\"state\":\"installed\""))
    }
}

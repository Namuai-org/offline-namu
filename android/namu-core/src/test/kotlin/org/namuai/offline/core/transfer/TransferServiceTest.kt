package org.namuai.offline.core.transfer

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.descriptor.DescriptorVerifier
import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.integer
import org.namuai.offline.core.json.obj
import org.namuai.offline.core.json.string
import org.namuai.offline.core.store.ModelStore
import org.namuai.offline.core.testing.Fixtures
import org.namuai.offline.core.testing.Harness
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Service facade (DL-001), activation, updates (SIG-003…005, T29), retention (DL-013), removal (SEC-006). */
class TransferServiceTest {
    @TempDir
    lateinit var dir: File
    private lateinit var h: Harness

    @BeforeEach
    fun setUp() {
        h = Harness(dir)
    }

    @AfterEach
    fun tearDown() = h.close()

    private fun snapshot(): JsonValue.Obj = StrictJson.parse(h.service.snapshotJson()) as JsonValue.Obj
    private fun code(block: () -> Unit): String = assertFailsWith<NamuException> { block() }.code

    private class Update(val sha: String, val bytes: ByteArray)

    private fun publishUpdate(sequence: Long, seed: Long, version: String = "v$sequence", expiresAt: String = "2027-02-01T00:00:00Z"): Update {
        val bytes = Fixtures.ggufModel(Harness.MODEL_BYTES, seed = seed)
        val sha = Fixtures.sha256(bytes)
        h.server.artifact = bytes
        h.server.artifactPath = "models/aya-global-q4km/$sha/model.gguf"
        h.server.stableJson = h.signer.envelope(
            Fixtures.payload(sha, bytes.size.toLong(), sequence = sequence, version = version, expiresAt = expiresAt),
        )
        return Update(sha, bytes)
    }

    private fun installUpdate(sequence: Long, seed: Long): Pair<String, Update> {
        val update = publishUpdate(sequence, seed)
        assertTrue(h.service.checkForUpdateJson().contains("\"available\""))
        val id = h.service.start("update", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        h.service.beginSelfTest(id)
        h.service.activate(id, true, "")
        return id to update
    }

    // ---- snapshot contract (§6.5) ------------------------------------------------------------------

    @Test
    fun snapshotHasTheContractShape() {
        val fresh = snapshot()
        assertEquals(1L, fresh.integer("schema"))
        assertEquals("absent", fresh.obj("install")!!.string("state"))
        assertIs<JsonValue.Null>(fresh.members["transfer"])
        assertIs<JsonValue.Null>(fresh.members["update"])
        assertEquals(h.model.size + SpaceRule.HEADROOM_BYTES, fresh.obj("storage")!!.integer("requiredAdditionalBytes"))
        assertEquals(JsonValue.Bool::class, fresh.obj("network")!!.members["connected"]!!::class)

        val id = h.service.start("bundled", true)
        val t = snapshot().obj("transfer")!!
        assertEquals(
            setOf(
                "transferId", "isUpdate", "artifactVersion", "artifactSha256", "phase", "expectedBytes",
                "committedBytes", "verifiedBytes", "meteredConsent", "userPaused", "restartedFromZero",
                "retryCount", "nextRetryAt", "errorCode",
            ),
            t.members.keys,
        )
        assertEquals(id, t.string("transferId"))
        assertEquals("waiting", t.string("phase"))
        assertEquals(true, (t.members["meteredConsent"] as JsonValue.Bool).value)
        assertIs<JsonValue.Null>(t.members["errorCode"])

        h.run(id)
        h.service.beginSelfTest(id)
        val done = StrictJson.parse(h.service.activate(id, true, "")) as JsonValue.Obj
        val install = done.obj("install")!!
        assertEquals("installed", install.string("state"))
        assertEquals(setOf("artifactId", "version", "bytes", "sha256", "activatedAt"), install.obj("active")!!.members.keys)
        assertEquals(h.sha, install.obj("active")!!.string("artifactId"))
        assertEquals("installed", done.obj("transfer")!!.string("phase"))
        assertEquals(0L, done.obj("storage")!!.integer("requiredAdditionalBytes"))

        val summary = StrictJson.parse(h.service.bundledDescriptorSummaryJson()) as JsonValue.Obj
        assertEquals(h.sha, summary.string("sha256"))
        assertEquals(h.model.size.toLong(), summary.integer("bytes"))
    }

    // ---- DL-001 idempotency and guards -----------------------------------------------------------------

    @Test
    fun startIsIdempotentAndOneTransferPerArtifact() {
        val id = h.service.start("bundled", false)
        assertEquals(id, h.service.start("bundled", false))
        assertEquals(id, h.service.start("bundled", true))
        assertEquals(1, h.journal.all().size)
        assertFalse(h.row(id).meteredConsent, "a repeated start never widens the consent of a live transfer")
        assertEquals(ErrorCodes.INVALID_STATE, code { h.service.start("sideload", false) })
        assertEquals(ErrorCodes.NOT_FOUND, code { h.service.start("update", false) })
        assertEquals(ErrorCodes.NOT_FOUND, code { h.service.pause("00000000-0000-4000-8000-000000000000") })
        assertEquals(ErrorCodes.NOT_FOUND, code { h.service.resume("00000000-0000-4000-8000-000000000000", false) })
        h.service.cancel("00000000-0000-4000-8000-000000000000") // idempotent
    }

    @Test
    fun ineligibleDevicesCannotStart() {
        h.eligibility.eligible = false
        assertEquals(ErrorCodes.DEVICE_INELIGIBLE, code { h.service.start("bundled", false) })
        assertTrue(h.journal.all().isEmpty())
        assertTrue(h.server.requests.isEmpty())
    }

    @Test
    fun releaseBuildsRefuseACleartextOrigin() {
        val release = h.newService(internalBuild = false)
        assertEquals(ErrorCodes.INVALID_STATE, code { release.start("bundled", false) })
        assertTrue(release.checkForUpdateJson().contains(ErrorCodes.INVALID_STATE))
        assertTrue(h.server.requests.isEmpty())
    }

    @Test
    fun selfTestGuards() {
        val id = h.service.start("bundled", false)
        assertEquals(ErrorCodes.INVALID_STATE, code { h.service.beginSelfTest(id) }) // not staged yet
        assertEquals(ErrorCodes.INVALID_STATE, code { h.service.activate(id, true, "") })
        h.run(id)
        assertEquals(ErrorCodes.NOT_FOUND, code { h.service.resolveArtifactPath("f".repeat(64)) })
        assertEquals(ErrorCodes.NOT_FOUND, code { h.service.resolveArtifactPath("../../etc/passwd") })
        // The candidate is resolvable for the self-test, and beginSelfTest is idempotent.
        assertEquals(h.release().absolutePath, h.service.resolveArtifactPath(h.sha))
        assertEquals(h.sha, h.service.beginSelfTest(id))
        assertEquals(h.sha, h.service.beginSelfTest(id))
        assertEquals(ErrorCodes.INVALID_STATE, code { h.service.cancel(id) })
        h.service.activate(id, true, "")
        h.service.activate(id, true, "") // idempotent
        assertEquals(ErrorCodes.INVALID_STATE, code { h.service.activate(id, false, "MODEL_LOAD_FAILED") })
    }

    @Test
    fun failedSelfTestMarksTheDigestBadAndKeepsTheOldPointer() {
        h.installBundled()
        val before = h.layout.activePointer.readText()
        val update = publishUpdate(2, seed = 11)
        h.service.checkForUpdateJson()
        val id = h.service.start("update", false)
        h.run(id)
        h.service.beginSelfTest(id)
        val after = StrictJson.parse(h.service.activate(id, false, "not-a-real-code")) as JsonValue.Obj
        assertEquals("failed", after.obj("transfer")!!.string("phase"))
        assertEquals(ErrorCodes.MODEL_LOAD_FAILED, after.obj("transfer")!!.string("errorCode"), "unknown codes are normalized")
        assertEquals("installed", after.obj("install")!!.string("state"))
        assertEquals(before, h.layout.activePointer.readText())
        assertTrue(h.journal.isBadDigest(update.sha))
        assertFalse(h.layout.releaseDir(update.sha).exists())
        assertFalse(h.layout.pendingMarker.exists())
        assertIs<JsonValue.Null>(after.members["update"], "a locally bad artifact is not offered again")
        assertEquals(ErrorCodes.FILE_DAMAGED, code { h.service.start("update", false) })
    }

    @Test
    fun t11_updateCannotSelfTestWhileTheRuntimeHoldsAModel() {
        h.installBundled()
        h.service.setRuntimeReference(h.sha) // a chat is using the active model
        publishUpdate(2, seed = 12)
        h.service.checkForUpdateJson()
        val id = h.service.start("update", false)
        assertIs<RunOutcome.Staged>(h.run(id)) // staging is allowed while answering
        assertEquals(ErrorCodes.ENGINE_BUSY, code { h.service.beginSelfTest(id) })
        assertEquals(Phase.STAGED, h.row(id).phase)
        h.service.setRuntimeReference("") // explicit idle transition
        h.service.beginSelfTest(id)
    }

    // ---- updates: SIG-003…005, T29 --------------------------------------------------------------------------

    @Test
    fun checkForUpdateStoresSequenceAndNeverStartsATransfer() {
        h.installBundled()
        assertTrue(h.service.checkForUpdateJson().contains("\"error\""), "no stable.json published yet")
        val update = publishUpdate(6, seed = 21)
        assertEquals("{\"status\":\"available\",\"errorCode\":null}", h.service.checkForUpdateJson())
        assertEquals("6", h.journal.getMeta(MetaKeys.HIGHEST_SEQUENCE))
        assertNotNull(h.journal.getMeta(MetaKeys.HIGHEST_SEQUENCE_PAYLOAD_SHA256))
        assertEquals(1, h.journal.all().size, "no transfer is started automatically (SIG-005)")
        assertEquals(1, h.scheduler.scheduled.size)
        val u = snapshot().obj("update")!!
        assertEquals(6L, u.integer("sequence"))
        assertEquals(update.bytes.size.toLong(), u.integer("bytes"))
        assertEquals("v6", u.string("artifactVersion"))
    }

    @Test
    fun t29_replayedAlteredAndExpiredMetadataAreRejectedAndTheModelKeepsWorking() {
        h.installBundled()
        publishUpdate(6, seed = 22)
        assertTrue(h.service.checkForUpdateJson().contains("available"))

        // Same sequence, altered payload.
        publishUpdate(6, seed = 23, version = "evil")
        assertEquals("{\"status\":\"error\",\"errorCode\":\"SIGNATURE_INVALID\"}", h.service.checkForUpdateJson())
        // Lower sequence (replay of older metadata).
        publishUpdate(5, seed = 24)
        assertTrue(h.service.checkForUpdateJson().contains(ErrorCodes.SIGNATURE_INVALID))
        // Expired metadata with a higher sequence.
        publishUpdate(7, seed = 25, expiresAt = "2026-09-17T11:59:59Z")
        assertTrue(h.service.checkForUpdateJson().contains(ErrorCodes.SIGNATURE_INVALID))
        assertEquals("6", h.journal.getMeta(MetaKeys.HIGHEST_SEQUENCE), "rejected metadata never advances the sequence")

        val s = snapshot()
        assertEquals("installed", s.obj("install")!!.string("state"))
        assertEquals("v6", s.obj("update")!!.string("artifactVersion"), "the earlier valid update is still the offer")
        assertEquals(h.release().absolutePath, h.service.resolveArtifactPath(h.sha))
    }

    @Test
    fun anUpdateThatExpiresBeforeItIsStartedCannotAuthorizeATransfer() {
        h.installBundled()
        publishUpdate(2, seed = 26)
        h.service.checkForUpdateJson()
        h.clock.now = DescriptorVerifier.parseTimestamp("2027-03-01T00:00:00Z")!!
        assertIs<JsonValue.Null>(snapshot().members["update"])
        assertEquals(ErrorCodes.SIGNATURE_INVALID, code { h.service.start("update", false) })
        assertEquals("installed", snapshot().obj("install")!!.string("state"), "SIG-004: installed models keep working")
    }

    @Test
    fun oversizedTamperedAndUnreachableDescriptors() {
        h.server.stableJson = ByteArray(70_000) { ' '.code.toByte() }
        assertTrue(h.service.checkForUpdateJson().contains(ErrorCodes.SIGNATURE_INVALID))
        h.server.stableJson = "{\"key_id\":\"test-key\",\"payload_b64\":\"e30=\",\"signature_b64\":\"AAAA\"}".toByteArray()
        assertTrue(h.service.checkForUpdateJson().contains(ErrorCodes.SIGNATURE_INVALID))
        h.network.state = NetworkState(connected = false, metered = false)
        assertEquals("{\"status\":\"error\",\"errorCode\":\"NETWORK_WAIT\"}", h.service.checkForUpdateJson())
    }

    @Test
    fun updateAlreadyActiveReportsNone() {
        h.installBundled()
        h.server.stableJson = h.signer.envelope(Fixtures.payload(h.sha, h.model.size.toLong(), sequence = 3))
        assertEquals("{\"status\":\"none\",\"errorCode\":null}", h.service.checkForUpdateJson())
        assertIs<JsonValue.Null>(snapshot().members["update"])
    }

    @Test
    fun consentIsPerTransferAndNotInheritedByAnUpdate() {
        val first = h.service.start("bundled", true)
        assertTrue(h.row(first).meteredConsent)
        h.run(first)
        h.service.beginSelfTest(first)
        h.service.activate(first, true, "")
        publishUpdate(2, seed = 27)
        h.service.checkForUpdateJson()
        val second = h.service.start("update", false)
        assertFalse(h.row(second).meteredConsent, "DL-006: a new update needs a new confirmation")
        assertTrue(h.scheduler.scheduled.last().requireUnmetered)
    }

    @Test
    fun onlyOneLiveTransferAtATime() {
        h.installBundled()
        publishUpdate(2, seed = 28)
        h.service.checkForUpdateJson()
        val id = h.service.start("update", false)
        publishUpdate(3, seed = 29)
        h.service.checkForUpdateJson()
        assertEquals(ErrorCodes.INVALID_STATE, code { h.service.start("update", false) })
        h.service.cancel(id)
        assertNotNull(h.service.start("update", false))
    }

    // ---- retention and restore (DL-013) ------------------------------------------------------------------------

    @Test
    fun previousVersionIsKeptSevenDaysAndThreeSessions() {
        h.installBundled()
        val (_, update) = installUpdate(2, seed = 31)
        var s = snapshot().obj("install")!!
        assertEquals(update.sha, s.obj("active")!!.string("artifactId"))
        assertEquals(h.sha, s.obj("previous")!!.string("artifactId"))
        assertEquals(true, (s.members["canRestorePrevious"] as JsonValue.Bool).value)

        // Three sessions but not seven days.
        repeat(3) { h.service.noteSuccessfulForegroundSession() }
        assertTrue(h.release(h.sha).exists())
        // Seven days and three sessions, but the old file is still in use.
        h.clock.now += ModelStore.RETENTION_MS
        h.service.setRuntimeReference(h.sha) // something still has the old file mapped
        h.service.noteSuccessfulForegroundSession()
        assertTrue(h.release(h.sha).exists(), "never deleted while a live runtime reference exists")
        assertNotNull(h.service.store.currentPointer()!!.previous)

        h.service.setRuntimeReference("") // clearing the reference lets retention finish
        h.service.runDeferredCleanup()
        s = snapshot().obj("install")!!
        assertIs<JsonValue.Null>(s.members["previous"])
        assertEquals(false, (s.members["canRestorePrevious"] as JsonValue.Bool).value)
        assertFalse(h.layout.releaseDir(h.sha).exists())
        assertTrue(h.release(update.sha).exists())
        assertEquals(1, h.journal.all().size, "the superseded transfer row went with its files")
    }

    @Test
    fun retentionNeedsBothConditions() {
        h.installBundled()
        installUpdate(2, seed = 32)
        h.clock.now += ModelStore.RETENTION_MS * 2
        repeat(2) { h.service.noteSuccessfulForegroundSession() }
        assertTrue(h.release(h.sha).exists(), "only two sessions")
        h.service.noteSuccessfulForegroundSession()
        assertFalse(h.layout.releaseDir(h.sha).exists())
    }

    @Test
    fun restorePreviousSwapsThePointerAtomically() {
        h.installBundled()
        val (_, update) = installUpdate(2, seed = 33)
        h.service.setRuntimeReference(update.sha)
        assertEquals(ErrorCodes.ENGINE_BUSY, code { h.service.restorePrevious() })
        h.service.setRuntimeReference("")
        val restored = (StrictJson.parse(h.service.restorePrevious()) as JsonValue.Obj).obj("install")!!
        assertEquals(h.sha, restored.obj("active")!!.string("artifactId"))
        assertEquals(update.sha, restored.obj("previous")!!.string("artifactId"))
        assertFalse(h.journal.isBadDigest(update.sha), "a manual restore does not condemn the newer version")
        assertTrue(h.release(update.sha).exists())

        // Automatic failed-trial path: the abandoned digest is marked bad and removed.
        h.service.restorePrevious(markAbandonedBad = false) // back to the update
        h.service.restorePrevious(markAbandonedBad = true)
        assertEquals(h.sha, h.service.store.currentPointer()!!.active.artifactId)
        assertNull(h.service.store.currentPointer()!!.previous)
        assertTrue(h.journal.isBadDigest(update.sha))
        assertFalse(h.layout.releaseDir(update.sha).exists())
        assertEquals(ErrorCodes.INVALID_STATE, code { h.service.restorePrevious() })
    }

    // ---- DL-014 and repair ---------------------------------------------------------------------------------------

    @Test
    fun startupChecksLengthOnlyAndRepairRehashes() {
        h.installBundled()
        val file = h.release()
        // Same length, different content: the cheap startup check cannot see it (DL-014) …
        file.setWritable(true)
        val bytes = file.readBytes().also { it[1000] = (it[1000] + 1).toByte() }
        file.writeBytes(bytes)
        h.restart()
        assertEquals("installed", snapshot().obj("install")!!.string("state"))
        // … an explicit repair rehashes and removes the damaged copy.
        h.service.setRuntimeReference(h.sha)
        assertEquals(ErrorCodes.ENGINE_BUSY, code { h.service.repair() })
        h.service.setRuntimeReference("")
        val repaired = StrictJson.parse(h.service.repair()) as JsonValue.Obj
        assertEquals("absent", repaired.obj("install")!!.string("state"))
        assertFalse(file.exists())
        assertFalse(h.journal.isBadDigest(h.sha), "the digest is fine; only the local copy was damaged")
        // The bundled descriptor remains the recovery source (SIG-004).
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
    }

    @Test
    fun wrongLengthAtStartupNeedsRepairAndAHealthyRepairKeepsTheModel() {
        h.installBundled()
        assertTrue(h.service.repair().contains("\"state\":\"installed\""))
        val file = h.release()
        file.setWritable(true)
        file.writeBytes(ByteArray(10))
        h.restart()
        assertEquals("needsRepair", snapshot().obj("install")!!.string("state"))
        assertEquals(ErrorCodes.NOT_FOUND, code { h.service.resolveArtifactPath(h.sha) })
    }

    // ---- removal (SEC-006) --------------------------------------------------------------------------------------------

    @Test
    fun removeModelAndDeleteAllRespectTheRuntimeReference() {
        h.installBundled()
        publishUpdate(4, seed = 41)
        h.service.checkForUpdateJson()
        h.service.setRuntimeReference(h.sha)
        assertEquals(ErrorCodes.ENGINE_BUSY, code { h.service.removeModel() })
        assertEquals(ErrorCodes.ENGINE_BUSY, code { h.service.deleteAllTransferData() })
        assertTrue(h.release().exists())

        h.service.setRuntimeReference("")
        h.service.removeModel()
        assertEquals("absent", snapshot().obj("install")!!.string("state"))
        assertFalse(h.layout.activePointer.exists())
        assertTrue(h.layout.releasesDir.listFiles()!!.isEmpty())
        assertTrue(h.journal.all().isEmpty())
        assertEquals("4", h.journal.getMeta(MetaKeys.HIGHEST_SEQUENCE), "anti-replay state survives a model removal")

        h.service.deleteAllTransferData()
        assertNull(h.journal.getMeta(MetaKeys.HIGHEST_SEQUENCE))
        assertIs<JsonValue.Null>(snapshot().members["update"])
    }

    @Test
    fun removeModelCancelsARunningTransfer() {
        val id = h.service.start("bundled", false)
        var outcome: RunOutcome? = null
        val started = java.util.concurrent.CountDownLatch(1)
        h.journal.onCommit = {
            started.countDown()
            Thread.sleep(50) // keep the engine busy so removal has to stop it
        }
        val worker = Thread { outcome = h.run(id) }
        worker.start()
        assertTrue(started.await(20, java.util.concurrent.TimeUnit.SECONDS))
        h.service.removeModel()
        worker.join(20_000)
        assertFalse(worker.isAlive)
        assertTrue(outcome is RunOutcome.Cancelled || outcome is RunOutcome.NothingToDo, "outcome=$outcome")
        assertNull(h.journal.get(id))
        assertFalse(h.part(id).exists())
        assertTrue(h.scheduler.cancelled.contains(id))
    }

    // ---- reconciliation (contract §6.4) ------------------------------------------------------------------------------------

    @Test
    fun reconciliationReschedulesLiveTransfersButNotPausedOrSpaceBlockedOnes() {
        val id = h.service.start("bundled", false)
        h.journal.update(id, 0) { it.copy(phase = Phase.DOWNLOADING) } // process died mid-download
        h.scheduler.scheduled.clear()
        h.restart()
        h.service.ensureReconciled()
        assertEquals(Phase.WAITING, h.row(id).phase)
        assertEquals(listOf(id), h.scheduler.scheduled.map { it.transferId })
        assertFalse(h.scheduler.scheduled[0].replace, "an already running OS job must not be replaced")

        h.service.pause(id)
        h.scheduler.scheduled.clear()
        h.restart()
        h.service.ensureReconciled()
        assertEquals(Phase.PAUSED, h.row(id).phase)
        assertTrue(h.scheduler.scheduled.isEmpty(), "pause is persistent until the user resumes (DL-006)")
    }

    @Test
    fun orphanStagingFilesAndReleaseDirectoriesAreSwept() {
        h.installBundled()
        h.layout.stagingDir.mkdirs()
        val orphanPart = File(h.layout.stagingDir, "11111111-1111-4111-8111-111111111111.part").apply { writeBytes(ByteArray(10)) }
        val orphanRelease = File(h.layout.releasesDir, "e".repeat(64)).apply { mkdirs() }
        File(orphanRelease, "model.gguf").writeBytes(ByteArray(10))
        h.restart()
        h.service.ensureReconciled()
        assertFalse(orphanPart.exists())
        assertFalse(orphanRelease.exists())
        assertTrue(h.release().exists())
    }

    @Test
    fun journalMirrorIsRewrittenFromThePointer() {
        h.installBundled()
        h.journal.putMeta(MetaKeys.ACTIVE_MIRROR, "{\"stale\":true}")
        h.restart()
        h.service.ensureReconciled()
        assertEquals(h.layout.activePointer.readText(), h.journal.getMeta(MetaKeys.ACTIVE_MIRROR))
    }
}

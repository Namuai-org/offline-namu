package org.namuai.offline.core.transfer

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.gguf.GgufInspector
import org.namuai.offline.core.gguf.GgufVerdict
import org.namuai.offline.core.testing.Fault
import org.namuai.offline.core.testing.Fixtures
import org.namuai.offline.core.testing.Harness
import java.io.File
import java.io.RandomAccessFile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Download state machine against an in-process fault server (contract §6.1,
 * §6.2, §6.4): PRD tests T03, T04, T05, T06, T07, T08, T09 plus retry,
 * redirect, network-policy and pause/cancel behaviour.
 */
class TransferEngineTest {
    @TempDir
    lateinit var dir: File
    private lateinit var h: Harness

    @BeforeEach
    fun setUp() {
        h = Harness(dir)
    }

    @AfterEach
    fun tearDown() = h.close()

    private val total get() = h.model.size.toLong()

    private fun assertStagedIntact(id: String) {
        val row = h.row(id)
        assertEquals(Phase.STAGED, row.phase)
        assertEquals(total, row.committedBytes)
        assertEquals(total, row.verifiedBytes)
        assertNull(row.lastError)
        assertFalse(h.part(id).exists(), "staging file was moved, not copied")
        assertEquals(h.sha, Fixtures.sha256(h.release().readBytes()))
        assertFalse(h.release().canWrite(), "installed files are read-only (DL-008)")
        assertNull(h.service.store.currentPointer(), "a staged release is not installed until activation")
    }

    // ---- happy path and durability (DL-003, DL-004) -------------------------------------------

    @Test
    fun freshDownloadStagesTheVerifiedRelease() {
        val id = h.service.start("bundled", false)
        assertEquals(1, h.scheduler.scheduled.size)
        assertTrue(h.scheduler.scheduled[0].requireUnmetered)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)

        val requests = h.server.artifactRequests()
        assertEquals(1, requests.size)
        assertEquals("identity", requests[0].acceptEncoding, "transparent gzip must be disabled")
        assertNull(requests[0].range)
        assertEquals("\"v1\"", h.row(id).etag)
        assertEquals(1, h.gguf.checkedFiles.size, "structural check ran exactly once, after the hash")
    }

    @Test
    fun commitsEveryFourMebibytesAndAtTheEnd() {
        val id = h.service.start("bundled", false)
        h.run(id)
        val commits = h.journal.committedHistory
        assertEquals(total, commits.last())
        assertTrue(commits.size >= 3, "9 MiB must produce at least two 4 MiB commits plus the final one: $commits")
        val deltas = (listOf(0L) + commits).zipWithNext { a, b -> b - a }
        assertTrue(deltas.dropLast(1).all { it >= TransferEngine.COMMIT_BYTES }, "interim commits are >= 4 MiB apart: $deltas")
        assertTrue(deltas.all { it < TransferEngine.COMMIT_BYTES + TransferEngine.IO_BUFFER_BYTES }, "$deltas")
    }

    @Test
    fun commitsEveryTwoSecondsOnASlowLink() {
        h.close()
        h = Harness(File(dir, "slow"), clockAutoAdvanceMs = 300) // every clock read "costs" 300 ms
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        val deltas = (listOf(0L) + h.journal.committedHistory).zipWithNext { a, b -> b - a }
        assertTrue(deltas.size > 10, "time-based commits must dominate: ${deltas.size}")
        assertTrue(deltas.all { it < TransferEngine.COMMIT_BYTES }, "no commit waited for 4 MiB")
    }

    // ---- T03: dropped connections ---------------------------------------------------------------

    @Test
    fun t03_dropAtTenFiftyAndNinetyNinePercentThenResume() {
        for (percent in listOf(10, 50, 99)) {
            h.close()
            h = Harness(File(dir, "drop$percent"))
            val dropAt = (total * percent / 100).toInt()
            h.server.faults.add(Fault.DropAfter(dropAt))
            val id = h.service.start("bundled", false)
            assertIs<RunOutcome.Staged>(h.run(id), "drop at $percent%")
            assertStagedIntact(id)

            val requests = h.server.artifactRequests()
            assertEquals(2, requests.size, "one failed GET, one resume")
            val resumedFrom = requests[1].range!!.removePrefix("bytes=").removeSuffix("-").toLong()
            assertTrue(resumedFrom in 1..dropAt.toLong(), "resume offset $resumedFrom must be durable bytes <= $dropAt")
            assertEquals("\"v1\"", requests[1].ifRange)
            assertEquals(listOf(2_000L), h.sleeper.sleeps, "first back-off step")
            assertFalse(h.row(id).restartedFromZero, "bytes were resumed, not restarted")
            assertEquals(0, h.row(id).retryCount, "durable progress resets the retry counter")
        }
    }

    @Test
    fun t03_bytesBeyondTheLastCommitAreTruncatedBeforeResuming() {
        for (processDied in listOf(true, false)) {
            h.close()
            h = Harness(File(dir, "truncate-$processDied"))
            h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
            h.server.faults.add(Fault.Status(404)) // ends the first run with durable partial bytes
            val id = h.service.start("bundled", false)
            assertIs<RunOutcome.Failed>(h.run(id))
            val committed = h.row(id).committedBytes
            assertTrue(committed > 0)
            assertEquals(committed, h.part(id).length())
            // Bytes that reached the file but never the journal (crash between write and commit).
            RandomAccessFile(h.part(id), "rw").use { it.seek(it.length()); it.write(ByteArray(7_777) { 0x55 }) }
            if (processDied) {
                h.restart()
                h.service.ensureReconciled()
                assertEquals(committed, h.part(id).length(), "reconciliation truncates to committed_bytes")
            }
            assertEquals(id, h.service.start("bundled", false)) // explicit user retry
            assertIs<RunOutcome.Staged>(h.run(id))
            assertStagedIntact(id) // the hash only matches when the garbage was discarded
            assertEquals("bytes=$committed-", h.server.artifactRequests().last().range)
        }
    }

    @Test
    fun resumeWithoutAStrongEtagRestartsFromZero() {
        h.server.etag = "W/\"weak\""
        h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        val requests = h.server.artifactRequests()
        assertEquals(2, requests.size)
        assertNull(requests[1].range, "no Range without a strong validator")
        assertTrue(h.row(id).restartedFromZero)
    }

    // ---- T04 / T05 / T06 ---------------------------------------------------------------------------

    @Test
    fun t04_okResponseToRangeRestartsStagingAndNeverAppends() {
        h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
        h.server.faults.add(Fault.IgnoreRange)
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        assertEquals(total, h.release().length(), "length is exact: nothing was appended")
        assertTrue(h.row(id).restartedFromZero, "UI must be told progress restarted (TRANSFER_RESTART)")
        assertTrue(h.journal.committedHistory.contains(0L), "committed offset visibly returned to zero")
    }

    @Test
    fun t05_wrongContentRangeIsDiscardedAndRestarted() {
        h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
        h.server.faults.add(Fault.WrongContentRange)
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        val requests = h.server.artifactRequests()
        assertEquals(3, requests.size)
        assertNull(requests[2].range, "after a bad 206 the next GET is fresh")
        assertTrue(h.row(id).restartedFromZero)
    }

    @Test
    fun t05_changedEtagIsDiscardedAndRestarted() {
        h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
        h.server.faults.add(Fault.ChangedEtag)
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        assertTrue(h.row(id).restartedFromZero)
    }

    @Test
    fun t05_objectReplacedOnTheServerIsCaughtByIfRange() {
        h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
        val id = h.service.start("bundled", false)
        h.journal.onCommit = {
            h.server.etag = "\"v2\"" // the object changed after the first bytes arrived
            h.journal.onCommit = null
        }
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        assertTrue(h.row(id).restartedFromZero, "If-Range mismatch gives 200, which restarts")
    }

    @Test
    fun t05_repeatedlyTruncatedBodyEndsInUserRetryWithoutActivation() {
        repeat(8) { h.server.faults.add(Fault.DropAfter(0)) } // headers only: never any progress
        val id = h.service.start("bundled", false)
        val outcome = assertIs<RunOutcome.Failed>(h.run(id))
        assertEquals(ErrorCodes.TRANSFER_RETRY, outcome.code)
        assertEquals(listOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L), h.sleeper.sleeps)
        assertEquals(6, h.server.artifactRequests().size, "initial attempt plus five automatic retries")
        val row = h.row(id)
        assertEquals(Phase.FAILED, row.phase)
        assertEquals(5, row.retryCount)
        assertNull(h.service.store.currentPointer())
        assertFalse(h.release().exists())
    }

    @Test
    fun t06_rangeNotSatisfiableWithIncompleteBytesRestarts() {
        h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
        h.server.faults.add(Fault.Status(416))
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        assertTrue(h.row(id).restartedFromZero)
        assertNull(h.server.artifactRequests()[2].range)
    }

    @Test
    fun t06_completeLocalFileGoesStraightToVerification() {
        val id = h.service.start("bundled", false)
        // All bytes are durable and journalled, but the process died before verification.
        h.part(id).parentFile.mkdirs()
        h.part(id).writeBytes(h.model)
        h.journal.update(id, 0) { it.copy(committedBytes = total, phase = Phase.DOWNLOADING, etag = "\"v1\"") }
        h.server.faults.add(Fault.Status(416)) // would be the answer to any further Range request
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        assertEquals(0, h.server.artifactRequests().size, "a complete file is verified, not requested again")
    }

    // ---- T07: oversized bodies -----------------------------------------------------------------------

    @Test
    fun t07_endlessBodyIsAbortedAtTheSignedBound() {
        h.server.faults.add(Fault.Oversized(3 * 1024 * 1024))
        val id = h.service.start("bundled", false)
        val outcome = assertIs<RunOutcome.Failed>(h.run(id))
        assertEquals(ErrorCodes.FILE_DAMAGED, outcome.code)
        assertTrue(h.journal.committedHistory.filter { it > 0 }.all { it <= total }, "never journalled past the bound")
        assertFalse(h.part(id).exists(), "staging removed")
        assertEquals(0, h.row(id).committedBytes)
        assertFalse(h.release().exists())
        assertTrue(h.sleeper.sleeps.isEmpty(), "no automatic retry for a damaged object")
        assertTrue(h.gguf.checkedFiles.isEmpty())
    }

    @Test
    fun t07_oversizedDeclaredLengthIsRejectedBeforeReadingTheBody() {
        h.server.faults.add(Fault.DeclaredLength(total + 1))
        val id = h.service.start("bundled", false)
        assertEquals(ErrorCodes.FILE_DAMAGED, assertIs<RunOutcome.Failed>(h.run(id)).code)
        assertTrue(h.journal.committedHistory.isEmpty(), "not a single byte was accepted")
    }

    @Test
    fun t07_failedUpdatePreservesTheInstalledModel() {
        val first = h.installBundled()
        val pointerBefore = h.layout.activePointer.readText()
        val update = Fixtures.ggufModel(Harness.MODEL_BYTES, seed = 99)
        val updateSha = Fixtures.sha256(update)
        h.server.artifact = update
        h.server.artifactPath = "models/aya-global-q4km/$updateSha/model.gguf"
        h.server.stableJson = h.signer.envelope(Fixtures.payload(updateSha, update.size.toLong(), sequence = 2, version = "aya-global-q4km-2"))
        assertTrue(h.service.checkForUpdateJson().contains("\"available\""))
        h.server.faults.add(Fault.Oversized(1024 * 1024))
        val id = h.service.start("update", false)
        assertEquals(ErrorCodes.FILE_DAMAGED, assertIs<RunOutcome.Failed>(h.run(id)).code)
        assertEquals(pointerBefore, h.layout.activePointer.readText(), "active pointer untouched")
        assertEquals(Phase.INSTALLED, h.row(first).phase)
        assertTrue(h.service.snapshotJson().contains("\"state\":\"installed\""))
        assertEquals(h.sha, Fixtures.sha256(h.release().readBytes()))
    }

    // ---- T08: integrity before parsing -----------------------------------------------------------------

    @Test
    fun t08_hashMismatchNeverReachesTheGgufParser() {
        val corrupted = h.model.copyOf().also { it[it.size / 2] = (it[it.size / 2] + 1).toByte() }
        h.server.artifact = corrupted
        val id = h.service.start("bundled", false)
        assertEquals(ErrorCodes.FILE_DAMAGED, assertIs<RunOutcome.Failed>(h.run(id)).code)
        assertTrue(h.gguf.checkedFiles.isEmpty(), "no structural parse on bytes whose hash did not pass")
        assertFalse(h.part(id).exists(), "corrupt staging removed")
        assertFalse(h.release().exists())
        assertEquals(total, h.journal.committedHistory.max(), "the download itself completed")
        assertTrue(h.sleeper.sleeps.isEmpty(), "hash errors are never retried automatically")
    }

    @Test
    fun t08_invalidBundledSignatureIsRejectedBeforeAnyRequest() {
        val env = String(h.trust.bundled!!)
        h.trust.bundled = env.replaceFirst("\"payload_b64\":\"ey", "\"payload_b64\":\"ez").toByteArray()
        val e = assertFailsWith<NamuException> { h.service.start("bundled", false) }
        assertEquals(ErrorCodes.SIGNATURE_INVALID, e.code)
        assertTrue(h.journal.all().isEmpty())
        assertTrue(h.scheduler.scheduled.isEmpty())
        assertTrue(h.server.requests.isEmpty())
        assertTrue(h.service.bundledDescriptorSummaryJson().contains("\"valid\":false"))
    }

    @Test
    fun t08_ggufArchitectureMismatchIsIncompatibleAndDamageIsDamaged() {
        h.close()
        h = Harness(File(dir, "arch"), model = Fixtures.ggufModel(Harness.MODEL_BYTES, architecture = "llama"))
        // The descriptor (signed) says cohere2 while the verified file says llama.
        val id = h.service.start("bundled", false)
        assertEquals(ErrorCodes.MODEL_INCOMPATIBLE, assertIs<RunOutcome.Failed>(h.run(id)).code)
        assertEquals(1, h.gguf.checkedFiles.size, "the parser ran once, after the hash matched")
        assertFalse(h.release().exists())

        h.close()
        val notGguf = ByteArray(Harness.MODEL_BYTES) { 1 }
        h = Harness(File(dir, "damaged"), model = notGguf)
        val id2 = h.service.start("bundled", false)
        assertEquals(ErrorCodes.FILE_DAMAGED, assertIs<RunOutcome.Failed>(h.run(id2)).code)
    }

    @Test
    fun knownBadDigestsAreRefused() {
        h.trust.knownBad = "{\"sha256\":[\"${h.sha}\"]}".toByteArray()
        val e = assertFailsWith<NamuException> { h.service.start("bundled", false) }
        assertEquals(ErrorCodes.FILE_DAMAGED, e.code)
    }

    // ---- T09: storage -------------------------------------------------------------------------------------

    @Test
    fun t09_insufficientSpaceBeforeTransferWaitsWithoutAnyRequest() {
        h.space.free = total + SpaceRule.HEADROOM_BYTES - 1
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.WaitingForSpace>(h.run(id))
        assertEquals(Phase.WAITING, h.row(id).phase)
        assertEquals(ErrorCodes.SPACE_LOW, h.row(id).lastError)
        assertTrue(h.server.requests.isEmpty())
        assertTrue(h.service.snapshotJson().contains("\"requiredAdditionalBytes\":${total + SpaceRule.HEADROOM_BYTES}"))
        // User frees space and resumes.
        h.space.free = total + SpaceRule.HEADROOM_BYTES
        h.service.resume(id, false)
        assertIs<RunOutcome.Staged>(h.run(id))
    }

    @Test
    fun t09_reserveDropsDuringTransfer() {
        val id = h.service.start("bundled", false)
        h.journal.onCommit = { h.space.free = SpaceRule.PAUSE_RESERVE_BYTES - 1 }
        assertIs<RunOutcome.WaitingForSpace>(h.run(id))
        val row = h.row(id)
        assertEquals(ErrorCodes.SPACE_LOW, row.lastError)
        assertTrue(row.committedBytes in TransferEngine.COMMIT_BYTES until total, "durable bytes are kept: ${row.committedBytes}")
        assertEquals(row.committedBytes, h.part(id).length())
        // Later there is room again: resume appends from the committed offset.
        h.journal.onCommit = null
        h.space.free = 64L * 1024 * 1024 * 1024
        h.service.resume(id, false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        assertEquals("bytes=${row.committedBytes}-", h.server.artifactRequests()[1].range)
    }

    @Test
    fun t09_probeFailureAndLowSpaceBeforeVerificationOutput() {
        val id = h.service.start("bundled", false)
        h.journal.onCommit = { row -> if (row.committedBytes == total) h.space.failing = true }
        assertIs<RunOutcome.WaitingForSpace>(h.run(id))
        assertEquals(ErrorCodes.SPACE_LOW, h.row(id).lastError)
        assertTrue(h.part(id).exists(), "the verified staging file is preserved")
        assertFalse(h.release().exists())
        h.space.failing = false
        h.service.resume(id, false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertEquals(1, h.server.artifactRequests().size, "no bytes are downloaded twice")
    }

    @Test
    fun t09_lowSpaceAtActivationKeepsTheOldPointer() {
        h.installBundled()
        val before = h.layout.activePointer.readText()
        val update = Fixtures.ggufModel(Harness.MODEL_BYTES, seed = 5)
        val updateSha = Fixtures.sha256(update)
        h.server.artifact = update
        h.server.artifactPath = "models/aya-global-q4km/$updateSha/model.gguf"
        h.server.stableJson = h.signer.envelope(Fixtures.payload(updateSha, update.size.toLong(), sequence = 2, version = "v2"))
        h.service.checkForUpdateJson()
        val id = h.service.start("update", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        h.service.beginSelfTest(id)
        h.space.free = 1024
        val e = assertFailsWith<NamuException> { h.service.activate(id, true, "") }
        assertEquals(ErrorCodes.SPACE_LOW, e.code)
        assertEquals(before, h.layout.activePointer.readText())
        assertEquals(Phase.STAGED, h.row(id).phase)
        assertFalse(h.layout.pendingMarker.exists(), "no marker is left behind to quarantine a good candidate")
        // With space back the same candidate activates.
        h.space.free = 64L * 1024 * 1024 * 1024
        h.service.beginSelfTest(id)
        assertTrue(h.service.activate(id, true, "").contains("\"artifactId\":\"$updateSha\""))
    }

    // ---- retry policy in situ (DL-007) ----------------------------------------------------------------------

    @Test
    fun serverErrorsBackOffAndHonourRetryAfter() {
        h.server.faults.add(Fault.Status(503, retryAfter = "7"))
        h.server.faults.add(Fault.Status(429))
        h.server.faults.add(Fault.Status(500))
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertEquals(listOf(7_000L, 5_000L, 15_000L), h.sleeper.sleeps)
        assertEquals(0, h.row(id).retryCount)
    }

    @Test
    fun clientErrorsAreNeverRetriedAutomatically() {
        for (code in listOf(403, 404)) {
            h.close()
            h = Harness(File(dir, "c$code"))
            h.server.faults.add(Fault.Status(code))
            val id = h.service.start("bundled", false)
            assertEquals(ErrorCodes.TRANSFER_RETRY, assertIs<RunOutcome.Failed>(h.run(id)).code)
            assertTrue(h.sleeper.sleeps.isEmpty())
            assertEquals(1, h.server.artifactRequests().size)
            // An explicit user retry (start again) works and returns the same ID (DL-001).
            assertEquals(id, h.service.start("bundled", false))
            assertIs<RunOutcome.Staged>(h.run(id))
        }
    }

    @Test
    fun waitingStateIsJournalledWhileBackingOff() {
        h.server.faults.add(Fault.Status(503))
        val id = h.service.start("bundled", false)
        var seen: TransferRecord? = null
        var nowAtSleep = 0L
        h.sleeper.onSleep = {
            seen = h.journal.get(id)
            nowAtSleep = h.clock.now
        }
        assertIs<RunOutcome.Staged>(h.run(id))
        val row = seen!!
        assertEquals(Phase.WAITING, row.phase)
        assertEquals(ErrorCodes.TRANSFER_RETRY, row.lastError)
        assertEquals(1, row.retryCount)
        assertEquals(nowAtSleep + 2_000L, row.nextRetryAt)
        assertNull(h.row(id).nextRetryAt, "cleared once the transfer moves on")
    }

    // ---- redirects and encodings (DL-003) ------------------------------------------------------------------------

    @Test
    fun sameOriginRedirectsAreFollowedManuallyUpToThree() {
        val target = "/${h.path}"
        h.server.faults.add(Fault.Redirect(target))
        h.server.faults.add(Fault.Redirect(h.server.origin + target))
        h.server.faults.add(Fault.Redirect(target))
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertEquals(4, h.server.artifactRequests().size)
    }

    @Test
    fun offOriginAndExcessiveRedirectsAreRejected() {
        h.server.faults.add(Fault.Redirect("http://127.0.0.1:1/${h.path}"))
        val id = h.service.start("bundled", false)
        assertEquals(ErrorCodes.TRANSFER_RETRY, assertIs<RunOutcome.Failed>(h.run(id)).code)
        assertEquals(1, h.server.requests.size, "the foreign location was never contacted")
        assertTrue(h.sleeper.sleeps.isEmpty())

        h.close()
        h = Harness(File(dir, "loops"))
        repeat(4) { h.server.faults.add(Fault.Redirect("/${h.path}")) }
        val id2 = h.service.start("bundled", false)
        assertIs<RunOutcome.Failed>(h.run(id2))
        assertEquals(4, h.server.artifactRequests().size)
    }

    @Test
    fun contentEncodingOtherThanIdentityIsRejected() {
        h.server.faults.add(Fault.GzipEncoded)
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.Failed>(h.run(id))
        assertTrue(h.journal.committedHistory.isEmpty())
    }

    // ---- network policy (DL-006) ---------------------------------------------------------------------------------------

    @Test
    fun meteredNetworkNeedsPerTransferConsent() {
        h.network.state = NetworkState(connected = true, metered = true)
        val id = h.service.start("bundled", false)
        assertIs<RunOutcome.WaitingForNetwork>(h.run(id))
        assertEquals(ErrorCodes.NETWORK_WAIT, h.row(id).lastError)
        assertEquals(Phase.WAITING, h.row(id).phase)
        assertTrue(h.server.requests.isEmpty(), "no bytes over a metered network without consent")

        h.service.resume(id, true) // explicit confirmation for this transfer
        val rescheduled = h.scheduler.scheduled.last()
        assertFalse(rescheduled.requireUnmetered)
        assertTrue(rescheduled.replace, "the OS job constraint changes with the consent")
        assertIs<RunOutcome.Staged>(h.run(id))
    }

    @Test
    fun losingTheNetworkIsWaitingNotFailure() {
        h.server.faults.add(Fault.DropAfter((total / 2).toInt()))
        val id = h.service.start("bundled", false)
        // Calls: 1 = before the request, 2 = after the 4 MiB commit, 3 = after the I/O error.
        h.network.calls = 0
        h.network.script = { n -> if (n >= 3) NetworkState(connected = false, metered = false) else null }
        assertIs<RunOutcome.WaitingForNetwork>(h.run(id))
        val row = h.row(id)
        assertEquals(Phase.WAITING, row.phase)
        assertEquals(ErrorCodes.NETWORK_WAIT, row.lastError)
        assertEquals(0, row.retryCount, "not counted as a failure")
        assertTrue(h.sleeper.sleeps.isEmpty())
        assertTrue(row.committedBytes > 0, "progress is kept")
        assertEquals(row.committedBytes, h.part(id).length())
    }

    @Test
    fun networkBecomingMeteredMidTransferStopsAtTheNextCommit() {
        val id = h.service.start("bundled", false)
        h.journal.onCommit = { h.network.state = NetworkState(connected = true, metered = true) }
        assertIs<RunOutcome.WaitingForNetwork>(h.run(id))
        assertTrue(h.row(id).committedBytes < total)
    }

    // ---- pause / cancel / system stop ---------------------------------------------------------------------------------------

    @Test
    fun pauseIsCooperativePersistentAndResumable() {
        val id = h.service.start("bundled", false)
        val control = h.service.newControl()
        h.journal.onCommit = { control.requestPause(); h.journal.onCommit = null }
        assertIs<RunOutcome.Paused>(h.service.runTransfer(id, control))
        val paused = h.row(id)
        assertEquals(Phase.PAUSED, paused.phase)
        assertTrue(paused.userPaused)
        assertEquals(paused.committedBytes, h.part(id).length(), "graceful stop committed everything written")
        // A scheduler wake-up must not un-pause the transfer.
        assertIs<RunOutcome.Paused>(h.run(id))
        assertEquals(1, h.server.artifactRequests().size)

        h.service.resume(id, false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertStagedIntact(id)
        assertEquals("bytes=${paused.committedBytes}-", h.server.artifactRequests()[1].range)
    }

    @Test
    fun pauseBeforeTheJobRunsIsHonoured() {
        val id = h.service.start("bundled", false)
        h.service.pause(id)
        assertEquals(Phase.PAUSED, h.row(id).phase)
        assertEquals(listOf(id), h.scheduler.cancelled)
        assertIs<RunOutcome.Paused>(h.run(id))
        assertTrue(h.server.requests.isEmpty())
    }

    @Test
    fun cancelRemovesSetupDataAndNeverRetries() {
        val id = h.service.start("bundled", false)
        val control = h.service.newControl()
        h.journal.onCommit = { control.requestCancel(); h.journal.onCommit = null }
        assertIs<RunOutcome.Cancelled>(h.service.runTransfer(id, control))
        h.service.cancel(id)
        assertNull(h.journal.get(id))
        assertFalse(h.part(id).exists())
        assertTrue(h.scheduler.cancelled.contains(id))
        val scheduledBefore = h.scheduler.scheduled.size
        h.service.cancel(id) // idempotent
        h.restart()
        h.service.ensureReconciled()
        assertEquals(scheduledBefore, h.scheduler.scheduled.size, "nothing is rescheduled after a cancel (DL-006)")
        assertIs<RunOutcome.NothingToDo>(h.run(id))
    }

    @Test
    fun systemStopCommitsAndAsksForRescheduling() {
        val id = h.service.start("bundled", false)
        val control = h.service.newControl()
        h.journal.onCommit = { control.requestStop(); h.journal.onCommit = null }
        assertIs<RunOutcome.StoppedBySystem>(h.service.runTransfer(id, control))
        val row = h.row(id)
        assertEquals(Phase.WAITING, row.phase)
        assertFalse(row.userPaused)
        assertEquals(row.committedBytes, h.part(id).length())
        assertIs<RunOutcome.Staged>(h.run(id))
    }

    @Test
    fun pauseDuringVerificationRestartsTheHashLater() {
        val id = h.service.start("bundled", false)
        val control = h.service.newControl()
        h.journal.onUpdate = { before, after ->
            if (before.phase != Phase.VERIFYING && after.phase == Phase.VERIFYING) control.requestPause()
        }
        assertIs<RunOutcome.Paused>(h.service.runTransfer(id, control))
        assertEquals(total, h.row(id).committedBytes)
        assertTrue(h.part(id).exists())
        assertTrue(h.gguf.checkedFiles.isEmpty())
        h.journal.onUpdate = null
        h.service.resume(id, false)
        assertIs<RunOutcome.Staged>(h.run(id))
        assertEquals(1, h.server.artifactRequests().size, "hash state is never serialized; only the hash restarts")
    }

    @Test
    fun aRejectingInspectorBlocksStaging() {
        h.gguf.delegate = object : GgufInspector {
            override fun check(file: File, expectedArchitecture: String): GgufVerdict = GgufVerdict.Damaged("test")
        }
        val id = h.service.start("bundled", false)
        assertEquals(ErrorCodes.FILE_DAMAGED, assertIs<RunOutcome.Failed>(h.run(id)).code)
        assertFalse(h.release().exists())
        assertFalse(h.part(id).exists())
    }
}

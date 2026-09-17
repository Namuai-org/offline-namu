package org.namuai.offline.core.transfer

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.descriptor.DescriptorVerifier
import org.namuai.offline.core.gguf.GgufInspector
import org.namuai.offline.core.gguf.GgufVerdict
import org.namuai.offline.core.hash.Sha256Streamer
import org.namuai.offline.core.json.string
import org.namuai.offline.core.store.ModelStore
import org.namuai.offline.core.util.Clock
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit

sealed class RunOutcome {
    /** Verified and moved to releases/<sha256>; waits for the foreground self-test. */
    object Staged : RunOutcome()
    object Paused : RunOutcome()
    object Cancelled : RunOutcome()

    /** waiting/NETWORK_WAIT: the scheduler should run the job again when its network constraint holds. */
    object WaitingForNetwork : RunOutcome()

    /** waiting/SPACE_LOW: only a user resume re-checks. */
    object WaitingForSpace : RunOutcome()

    /** The OS asked the job to stop; progress is committed and the job wants rescheduling. */
    object StoppedBySystem : RunOutcome()
    class Failed(val code: String) : RunOutcome()
    object NothingToDo : RunOutcome()
}

/** Progress/phase notifications for the snapshot bus; [phaseChanged] flushes immediately. */
interface EngineListener {
    fun onTransferChanged(transferId: String, phaseChanged: Boolean)
}

/** Thrown for redirects the contract forbids (off-origin, too many, missing Location). */
class RedirectRejectedException : IOException("redirect rejected")

/**
 * OkHttp download state machine (DL-003, DL-004, DL-007, DL-009; contract §6.1,
 * §6.2, §6.4 steps 1–4). It runs with no JS runtime (ARC-003): the UIDT
 * JobService (API 34+) and the foreground worker (API 29–33) both call [run].
 *
 * Invariants:
 *  - bytes are appended only for a validated 206 at the exact committed offset;
 *  - `committed_bytes` advances only after FileChannel.force (fsync-then-journal);
 *  - never more than the signed length is accepted (T07);
 *  - hash state is never serialized: the complete file is rehashed (DL-004);
 *  - the GGUF check runs only after the SHA-256 matched (DL-010, T08);
 *  - nothing here touches active.json: a failure can never disturb the
 *    installed model.
 */
class TransferEngine(
    private val client: OkHttpClient,
    modelOrigin: String,
    private val journal: Journal,
    private val store: ModelStore,
    private val networkPolicy: NetworkPolicy,
    private val spaceProbe: SpaceProbe,
    private val clock: Clock,
    private val sleeper: Sleeper,
    private val retryPolicy: RetryPolicy,
    private val ggufInspector: GgufInspector,
    private val listener: EngineListener,
) {
    private val origin: HttpUrl? = modelOrigin.toHttpUrlOrNull()
    private val layout = store.layout

    private sealed class Step {
        object Completed : Step()
        object Interrupted : Step()
        object WaitNetwork : Step()
        object WaitSpace : Step()
        object RestartFromZero : Step()
        class Transient(val retryAfterMs: Long?) : Step()
        class Fatal(val code: String, val deleteStaging: Boolean) : Step()
    }

    fun run(transferId: String, control: TransferControl): RunOutcome {
        var restarts = 0
        while (true) {
            val rec = journal.get(transferId) ?: return RunOutcome.NothingToDo
            if (control.cancelRequested) return RunOutcome.Cancelled
            when (rec.phase) {
                Phase.STAGED -> return RunOutcome.Staged
                Phase.SELF_TESTING, Phase.INSTALLED, Phase.REMOVING, Phase.ABSENT -> return RunOutcome.NothingToDo
                Phase.FAILED -> return RunOutcome.Failed(rec.lastError ?: ErrorCodes.TRANSFER_RETRY)
                else -> Unit
            }
            if (rec.userPaused || control.pauseRequested) {
                update(transferId, true) { it.copy(phase = Phase.PAUSED, userPaused = true, nextRetryAt = null) }
                return RunOutcome.Paused
            }
            if (control.stopRequested) {
                val usable = NetworkRule.usable(networkPolicy.current(), rec.meteredConsent)
                update(transferId, true) {
                    it.copy(
                        phase = Phase.WAITING,
                        lastError = if (usable) null else ErrorCodes.NETWORK_WAIT,
                        nextRetryAt = null,
                    )
                }
                return RunOutcome.StoppedBySystem
            }
            if (journal.isBadDigest(rec.artifactSha256)) {
                return fail(rec, ErrorCodes.FILE_DAMAGED, deleteStaging = true)
            }

            if (rec.committedBytes >= rec.expectedBytes) {
                val outcome = verifyAndStage(rec, control)
                if (outcome != null) return outcome
                continue // interrupted: re-evaluate the control flags
            }

            val step = try {
                downloadOnce(rec, control)
            } catch (e: IOException) {
                // Local file-system trouble outside the body loop.
                if (!SpaceRule.reserveOk(SpaceRule.safeFree(spaceProbe))) Step.WaitSpace else Step.Transient(null)
            }
            when (step) {
                Step.Completed, Step.Interrupted -> Unit
                Step.WaitNetwork -> {
                    update(transferId, true) {
                        it.copy(phase = Phase.WAITING, lastError = ErrorCodes.NETWORK_WAIT, nextRetryAt = null)
                    }
                    return RunOutcome.WaitingForNetwork
                }
                Step.WaitSpace -> {
                    update(transferId, true) {
                        it.copy(phase = Phase.WAITING, lastError = ErrorCodes.SPACE_LOW, nextRetryAt = null)
                    }
                    return RunOutcome.WaitingForSpace
                }
                Step.RestartFromZero -> {
                    restarts++
                    if (restarts > MAX_RESTARTS_PER_RUN) {
                        // A server that keeps invalidating resumes must not consume unbounded data.
                        return fail(rec, ErrorCodes.TRANSFER_RETRY, deleteStaging = true)
                    }
                    truncateToZero(rec)
                }
                is Step.Transient -> {
                    if (control.interrupted) continue
                    val current = journal.get(transferId) ?: return RunOutcome.NothingToDo
                    when (val decision = retryPolicy.next(current.retryCount, step.retryAfterMs)) {
                        RetryDecision.GiveUp -> return fail(current, ErrorCodes.TRANSFER_RETRY, deleteStaging = false)
                        is RetryDecision.After -> {
                            update(transferId, true) {
                                it.copy(
                                    phase = Phase.WAITING,
                                    lastError = ErrorCodes.TRANSFER_RETRY,
                                    retryCount = it.retryCount + 1,
                                    nextRetryAt = clock.nowMs() + decision.delayMs,
                                )
                            }
                            sleeper.sleep(decision.delayMs, control)
                        }
                    }
                }
                is Step.Fatal -> return fail(rec, step.code, step.deleteStaging)
            }
        }
    }

    // ---- download ------------------------------------------------------------------------------

    @Throws(IOException::class)
    private fun downloadOnce(rec: TransferRecord, control: TransferControl): Step {
        val base = origin ?: return Step.Fatal(ErrorCodes.TRANSFER_RETRY, deleteStaging = false)
        if (!NetworkRule.usable(networkPolicy.current(), rec.meteredConsent)) return Step.WaitNetwork

        layout.ensureDirectories()
        // DL-004: discard anything beyond the last durable commit before resuming.
        store.truncateStaging(rec)
        var current = journal.get(rec.transferId) ?: return Step.Interrupted
        val part = layout.stagingFile(rec.transferId)

        if (!SpaceRule.canStartOrResume(SpaceRule.safeFree(spaceProbe), current.expectedBytes, current.committedBytes)) {
            return Step.WaitSpace
        }
        if (current.committedBytes > 0 && !ResponseRules.isStrongEtag(current.etag)) {
            // Without a strong validator a range cannot be trusted: restart from zero (contract §6.2).
            truncateToZero(current)
            current = journal.get(rec.transferId) ?: return Step.Interrupted
        }

        val resume = current.committedBytes > 0
        val url = base.newBuilder().addEncodedPathSegments(current.artifactPath).build()
        val headers = LinkedHashMap<String, String>()
        if (resume) {
            headers["Range"] = "bytes=${current.committedBytes}-"
            headers["If-Range"] = current.etag!!
        }

        update(rec.transferId, current.phase != Phase.DOWNLOADING) {
            it.copy(phase = Phase.DOWNLOADING, lastError = null, nextRetryAt = null)
        }

        val response = try {
            execute(url, base, headers, control)
        } catch (e: RedirectRejectedException) {
            return Step.Fatal(ErrorCodes.TRANSFER_RETRY, deleteStaging = false)
        } catch (e: IOException) {
            return afterTransportFailure(current, control)
        }

        response.use { resp ->
            val facts = HttpFacts(
                code = resp.code,
                contentLength = resp.header("Content-Length"),
                contentRange = resp.header("Content-Range"),
                etag = resp.header("ETag"),
                contentEncoding = resp.header("Content-Encoding"),
                retryAfterMs = RetryPolicy.parseRetryAfter(resp.header("Retry-After"), clock.nowMs()),
            )
            val action = ResponseRules.classify(
                resume = resume,
                committedBytes = current.committedBytes,
                expectedBytes = current.expectedBytes,
                storedEtag = current.etag,
                localLength = if (part.exists()) part.length() else 0L,
                facts = facts,
            )
            return when (action) {
                is ResponseAction.Transient -> Step.Transient(action.retryAfterMs)
                is ResponseAction.Fatal -> Step.Fatal(action.code, action.deleteStaging)
                ResponseAction.RestartFromZero -> Step.RestartFromZero
                ResponseAction.VerifyLocalFile -> {
                    update(rec.transferId, false) { it.copy(committedBytes = it.expectedBytes) }
                    Step.Completed
                }
                ResponseAction.AcceptResume -> receiveBody(resp, current, current.committedBytes, control)
                is ResponseAction.AcceptFresh -> {
                    update(rec.transferId, false) { it.copy(etag = action.strongEtag) }
                    receiveBody(resp, current, 0L, control)
                }
                is ResponseAction.FreshAfterTruncate -> {
                    // 200 to a Range request: never append (T04). Progress visibly restarts.
                    truncateToZero(current)
                    update(rec.transferId, false) { it.copy(etag = action.strongEtag) }
                    receiveBody(resp, current, 0L, control)
                }
            }
        }
    }

    /** Streams the body to `.part` starting at [startOffset]; fsync-then-journal every 4 MiB or 2 s. */
    private fun receiveBody(resp: Response, rec: TransferRecord, startOffset: Long, control: TransferControl): Step {
        val body = resp.body ?: return Step.Transient(null)
        val expected = rec.expectedBytes
        val part = layout.stagingFile(rec.transferId)
        var written = startOffset
        var lastCommitBytes = startOffset
        var lastCommitAt = clock.nowMs()
        var progressed = false

        RandomAccessFile(part, "rw").use { raf ->
            val channel = raf.channel
            if (raf.length() != startOffset) raf.setLength(startOffset)
            channel.position(startOffset)

            fun commit() {
                if (written == lastCommitBytes) return
                channel.force(true) // durable file first …
                val resetRetries = !progressed
                progressed = true
                val committed = written
                // … then the journal (DL-004). Durable progress resets the retry counter (§6.1).
                update(rec.transferId, false) {
                    it.copy(
                        committedBytes = committed,
                        retryCount = if (resetRetries) 0 else it.retryCount,
                    )
                }
                lastCommitBytes = written
                lastCommitAt = clock.nowMs()
            }

            val buffer = ByteArray(IO_BUFFER_BYTES)
            val source = body.byteStream()
            while (true) {
                if (control.interrupted) {
                    commit() // graceful stop
                    return Step.Interrupted
                }
                val n = try {
                    source.read(buffer)
                } catch (e: IOException) {
                    // Truncated body / dropped connection: keep the durable bytes, then retry (T03, T05).
                    try {
                        commit()
                    } catch (io: IOException) {
                        return storageFailure()
                    }
                    return afterTransportFailure(rec, control)
                }
                if (n < 0) break
                if (n == 0) continue
                if (written + n > expected) {
                    // T07: stop accepting bytes above the signed length; nothing of this is kept.
                    return Step.Fatal(ErrorCodes.FILE_DAMAGED, deleteStaging = true)
                }
                try {
                    val wrapped = ByteBuffer.wrap(buffer, 0, n)
                    while (wrapped.hasRemaining()) channel.write(wrapped)
                    written += n
                    val now = clock.nowMs()
                    if (written - lastCommitBytes >= COMMIT_BYTES || now - lastCommitAt >= COMMIT_INTERVAL_MS) {
                        commit()
                        // Recheck during the transfer (DL-009, DL-006).
                        if (!SpaceRule.reserveOk(SpaceRule.safeFree(spaceProbe))) return Step.WaitSpace
                        if (!NetworkRule.usable(networkPolicy.current(), rec.meteredConsent)) return Step.WaitNetwork
                    }
                } catch (e: IOException) {
                    return storageFailure()
                }
            }
            try {
                commit()
            } catch (e: IOException) {
                return storageFailure()
            }
        }
        // End of stream: shorter than the signed length means a truncated body.
        return if (written == expected) Step.Completed else Step.Transient(null)
    }

    private fun storageFailure(): Step =
        if (!SpaceRule.reserveOk(SpaceRule.safeFree(spaceProbe))) Step.WaitSpace else Step.Transient(null)

    private fun afterTransportFailure(rec: TransferRecord, control: TransferControl): Step = when {
        control.interrupted -> Step.Interrupted
        // Loss of network is waiting, not failure (DL-006).
        !NetworkRule.usable(networkPolicy.current(), rec.meteredConsent) -> Step.WaitNetwork
        else -> Step.Transient(null)
    }

    /** GET with manual, same-origin-only redirect handling (max 3) and no transparent gzip. */
    @Throws(IOException::class)
    private fun execute(
        url: HttpUrl,
        base: HttpUrl,
        headers: Map<String, String>,
        control: TransferControl,
    ): Response {
        var current = url
        var hops = 0
        while (true) {
            val builder = Request.Builder().url(current).get()
                // Explicit identity disables OkHttp's transparent gzip (DL-003).
                .header("Accept-Encoding", "identity")
            for ((name, value) in headers) builder.header(name, value)
            val call = client.newCall(builder.build())
            control.setAbortAction { call.cancel() }
            val response = call.execute()
            if (response.code !in REDIRECT_CODES) return response
            val location = response.header("Location")
            response.close()
            hops++
            val next = location?.let { current.resolve(it) }
            if (hops > MAX_REDIRECTS || next == null || !sameOrigin(next, base)) {
                throw RedirectRejectedException()
            }
            current = next
        }
    }

    // ---- verification and staging (contract §6.4 steps 1–4) ------------------------------------

    /** @return the outcome, or null when interrupted by a control signal. */
    private fun verifyAndStage(rec: TransferRecord, control: TransferControl): RunOutcome? {
        val id = rec.transferId
        update(id, rec.phase != Phase.VERIFYING) {
            it.copy(phase = Phase.VERIFYING, verifiedBytes = 0, lastError = null, nextRetryAt = null)
        }
        val part = layout.stagingFile(id)
        val release = layout.releaseFile(rec.artifactSha256)
        // A crash after the rename but before the journal commit leaves the file in the release dir.
        val inPlace = !part.exists() && release.exists()
        val file: File = if (inPlace) release else part

        // 1. exact length
        if (!file.exists() || file.length() != rec.expectedBytes) {
            if (inPlace) store.deleteRelease(rec.artifactSha256)
            return fail(rec, ErrorCodes.FILE_DAMAGED, deleteStaging = true)
        }
        // 2. streaming SHA-256 over the whole file
        var lastPublishedAt = clock.nowMs()
        val digest = try {
            Sha256Streamer.hashFile(
                file,
                isCancelled = { control.interrupted },
                onProgress = { hashed ->
                    val now = clock.nowMs()
                    if (now - lastPublishedAt >= VERIFY_PUBLISH_INTERVAL_MS || hashed == rec.expectedBytes) {
                        lastPublishedAt = now
                        update(id, false) { it.copy(verifiedBytes = hashed) }
                    }
                },
            )
        } catch (e: IOException) {
            return fail(rec, ErrorCodes.FILE_DAMAGED, deleteStaging = true)
        } ?: return null
        if (digest != rec.artifactSha256) {
            if (inPlace) store.deleteRelease(rec.artifactSha256)
            return fail(rec, ErrorCodes.FILE_DAMAGED, deleteStaging = true) // staging only
        }
        // 3. structural GGUF check — only now, on hash-verified bytes (T08).
        val architecture = DescriptorVerifier.payloadOfStoredEnvelope(rec.descriptorBytes)?.string("architecture")
        if (architecture == null) {
            if (inPlace) store.deleteRelease(rec.artifactSha256)
            return fail(rec, ErrorCodes.SIGNATURE_INVALID, deleteStaging = true)
        }
        when (ggufInspector.check(file, architecture)) {
            is GgufVerdict.Damaged -> {
                if (inPlace) store.deleteRelease(rec.artifactSha256)
                return fail(rec, ErrorCodes.FILE_DAMAGED, deleteStaging = true)
            }
            is GgufVerdict.Incompatible -> {
                if (inPlace) store.deleteRelease(rec.artifactSha256)
                return fail(rec, ErrorCodes.MODEL_INCOMPATIBLE, deleteStaging = true)
            }
            GgufVerdict.Ok -> Unit
        }
        // Recheck space before verification output (DL-009); the staging file is kept.
        if (!SpaceRule.reserveOk(SpaceRule.safeFree(spaceProbe))) {
            update(id, true) { it.copy(phase = Phase.WAITING, lastError = ErrorCodes.SPACE_LOW) }
            return RunOutcome.WaitingForSpace
        }
        // 4. release directory rename, read-only, fsync.
        if (!inPlace) {
            try {
                store.installVerified(part, rec.artifactSha256)
            } catch (e: IOException) {
                if (!SpaceRule.reserveOk(SpaceRule.safeFree(spaceProbe))) {
                    update(id, true) { it.copy(phase = Phase.WAITING, lastError = ErrorCodes.SPACE_LOW) }
                    return RunOutcome.WaitingForSpace
                }
                return fail(rec, ErrorCodes.TRANSFER_RETRY, deleteStaging = false)
            }
        } else {
            release.setReadOnly()
        }
        update(id, true) {
            it.copy(phase = Phase.STAGED, verifiedBytes = it.expectedBytes, lastError = null, retryCount = 0)
        }
        return RunOutcome.Staged
    }

    // ---- helpers -------------------------------------------------------------------------------

    private fun truncateToZero(rec: TransferRecord) {
        val part = layout.stagingFile(rec.transferId)
        if (part.exists()) {
            RandomAccessFile(part, "rw").use { raf ->
                raf.setLength(0)
                raf.channel.force(true)
            }
        }
        update(rec.transferId, false) {
            it.copy(
                committedBytes = 0,
                verifiedBytes = 0,
                etag = null,
                // Only claim a restart when durable progress was really discarded (TRANSFER_RESTART).
                restartedFromZero = it.restartedFromZero || it.committedBytes > 0,
            )
        }
    }

    private fun fail(rec: TransferRecord, code: String, deleteStaging: Boolean): RunOutcome {
        if (deleteStaging) layout.stagingFile(rec.transferId).delete()
        update(rec.transferId, true) {
            it.copy(
                phase = Phase.FAILED,
                lastError = code,
                nextRetryAt = null,
                committedBytes = if (deleteStaging) 0 else it.committedBytes,
                verifiedBytes = 0,
                etag = if (deleteStaging) null else it.etag,
            )
        }
        return RunOutcome.Failed(code)
    }

    private fun update(transferId: String, phaseChanged: Boolean, mutate: (TransferRecord) -> TransferRecord) {
        journal.update(transferId, clock.nowMs(), mutate)
        listener.onTransferChanged(transferId, phaseChanged)
    }

    companion object {
        const val COMMIT_BYTES = 4L * 1024 * 1024
        const val COMMIT_INTERVAL_MS = 2_000L
        const val IO_BUFFER_BYTES = 64 * 1024
        const val MAX_REDIRECTS = 3
        const val MAX_RESTARTS_PER_RUN = 3
        const val VERIFY_PUBLISH_INTERVAL_MS = 250L
        private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)

        fun sameOrigin(a: HttpUrl, b: HttpUrl): Boolean =
            a.scheme == b.scheme && a.host == b.host && a.port == b.port

        /**
         * The only HTTP client configuration the transfer service may use:
         * redirects are handled manually, no cache, no cookies (OkHttp default
         * jar). `retryOnConnectionFailure` stays at OkHttp's default (true): it
         * is what lets OkHttp try the next resolved address (IPv6 → IPv4) of the
         * same origin; it never follows redirects or repeats a request whose
         * response already started, so [RetryPolicy] still counts every failure
         * the transfer can observe.
         */
        fun newHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .cache(null)
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

package org.namuai.offline.core.transfer

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.descriptor.CompatibilityProfile
import org.namuai.offline.core.descriptor.Descriptor
import org.namuai.offline.core.descriptor.DescriptorSource
import org.namuai.offline.core.descriptor.DescriptorVerifier
import org.namuai.offline.core.descriptor.Ed25519Verifier
import org.namuai.offline.core.descriptor.TrustBundle
import org.namuai.offline.core.descriptor.TrustSource
import org.namuai.offline.core.descriptor.VerifyContext
import org.namuai.offline.core.descriptor.VerifyResult
import org.namuai.offline.core.gguf.GgufInspector
import org.namuai.offline.core.hash.Sha256Streamer
import org.namuai.offline.core.json.JsonOut
import org.namuai.offline.core.store.ActivePointer
import org.namuai.offline.core.store.DirectorySyncer
import org.namuai.offline.core.store.InstallState
import org.namuai.offline.core.store.ModelStore
import org.namuai.offline.core.store.PendingMarker
import org.namuai.offline.core.store.StorageLayout
import org.namuai.offline.core.util.Clock
import org.namuai.offline.core.util.CrashHook
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Build configuration of contract §1 (not secrets). */
class ServiceConfig(
    val modelOrigin: String,
    val appBuild: Long,
    val runtimeBuildId: String,
    val internalBuild: Boolean,
    val promptVersions: Set<String> = setOf("namu-text-2"),
    val licenseNoticeIds: Set<String> = setOf("tiny-aya-cc-by-nc-4.0-v1"),
) {
    val profile: CompatibilityProfile
        get() = if (internalBuild) CompatibilityProfile.INTERNAL else CompatibilityProfile.PRODUCTION
}

/** DEV-002/DEV-003 native preflight; the UI check in JS is not the only gate. */
interface DeviceEligibility {
    fun isEligible(): Boolean
}

/** OS scheduling seam: UIDT JobService on API 34+, foreground WorkManager on API 29–33. */
interface TransferScheduler {
    /** [replaceExisting] is true only when the network constraint changed (new consent). */
    fun schedule(transferId: String, requireUnmetered: Boolean, remainingBytes: Long, replaceExisting: Boolean)
    fun cancel(transferId: String)
}

/** [immediate] is true for phase changes, false for coalescable progress (DL-001). */
interface SnapshotListener {
    fun onSnapshotChanged(immediate: Boolean)
}

/**
 * Native transfer service facade (DL-001): start, pause, resume, cancel,
 * snapshot, checkForUpdate, beginSelfTest/activate, removeModel and friends.
 * Pure JVM; the React module and the OS job entry points are thin callers.
 * Calls are idempotent by transfer ID. Rejections are [NamuException]s whose
 * code is a PRD §17 code, ENGINE_BUSY, NOT_FOUND or INVALID_STATE.
 */
class TransferService(
    private val config: ServiceConfig,
    private val client: OkHttpClient,
    private val journal: Journal,
    layout: StorageLayout,
    private val trust: TrustSource,
    ed25519: Ed25519Verifier,
    private val networkPolicy: NetworkPolicy,
    private val spaceProbe: SpaceProbe,
    private val eligibility: DeviceEligibility,
    private val scheduler: TransferScheduler,
    private val clock: Clock,
    sleeper: Sleeper,
    retryPolicy: RetryPolicy,
    ggufInspector: GgufInspector,
    crashHook: CrashHook,
    dirSyncer: DirectorySyncer,
) {
    private val verifier = DescriptorVerifier(ed25519)
    val store = ModelStore(layout, journal, clock, crashHook, dirSyncer)

    private val lock = ReentrantLock()
    private val runEnded = lock.newCondition()
    private val activeRuns = HashMap<String, TransferControl>()
    private var reconciled = false
    @Volatile private var runtimeReference: String? = null
    @Volatile private var listener: SnapshotListener? = null
    private var cachedUpdate: Pair<String, Descriptor>? = null // (envelope b64, descriptor)
    private var cachedBundledBytes: Long? = null

    private val engine = TransferEngine(
        client, config.modelOrigin, journal, store, networkPolicy, spaceProbe, clock, sleeper,
        retryPolicy, ggufInspector,
        object : EngineListener {
            override fun onTransferChanged(transferId: String, phaseChanged: Boolean) = notifyChanged(phaseChanged)
        },
    )

    fun setListener(value: SnapshotListener?) {
        listener = value
    }

    private fun notifyChanged(immediate: Boolean) {
        listener?.onSnapshotChanged(immediate)
    }

    // ---- reconciliation -----------------------------------------------------------------------

    /** Startup reconciliation (contract §6.4); runs once, before the first snapshot is answered. */
    fun ensureReconciled() {
        val toSchedule = lock.withLock {
            if (reconciled) return
            store.reconcile(runtimeReference)
            reconciled = true
            journal.all().filter { it.phase == Phase.WAITING && !it.userPaused && it.lastError != ErrorCodes.SPACE_LOW }
        }
        // Continue user-started, non-paused transfers (never cancelled ones: those rows are gone).
        for (row in toSchedule) schedule(row, replaceExisting = false)
        notifyChanged(true)
    }

    // ---- snapshot -----------------------------------------------------------------------------

    fun snapshotJson(): String {
        ensureReconciled()
        return lock.withLock { buildSnapshot() }
    }

    private fun currentTransfer(pointer: ActivePointer?): TransferRecord? {
        val rows = journal.all()
        return rows.lastOrNull { it.phase != Phase.INSTALLED }
            ?: rows.lastOrNull { it.artifactSha256 == pointer?.active?.artifactId }
    }

    private fun buildSnapshot(): String {
        val pointer = store.currentPointer()
        val state = store.installState(pointer)
        val transfer = currentTransfer(pointer)
        val update = availableUpdate(pointer)
        val net = networkPolicy.current()
        val free = SpaceRule.safeFree(spaceProbe)
        val required = when {
            transfer != null && transfer.phase in NEEDS_BYTES ->
                SpaceRule.requiredAdditionalBytes(transfer.expectedBytes, transfer.committedBytes)
            transfer != null && transfer.phase != Phase.INSTALLED -> 0L
            update != null -> SpaceRule.requiredAdditionalBytes(update.bytes, 0)
            state == InstallState.ABSENT -> bundledBytes()?.let { SpaceRule.requiredAdditionalBytes(it, 0) } ?: 0L
            else -> 0L
        }
        val root = linkedMapOf<String, Any?>(
            "schema" to 1L,
            "install" to linkedMapOf(
                "state" to state.wire,
                "active" to pointer?.active?.toJsonMap(),
                "previous" to pointer?.previous?.toJsonMap(),
                "canRestorePrevious" to store.canRestorePrevious(pointer),
            ),
            "transfer" to transfer?.let {
                linkedMapOf(
                    "transferId" to it.transferId,
                    "isUpdate" to (it.descriptorSource == DescriptorSource.UPDATE.wire),
                    "artifactVersion" to it.artifactVersion,
                    "artifactSha256" to it.artifactSha256,
                    "phase" to it.phase.wire,
                    "expectedBytes" to it.expectedBytes,
                    "committedBytes" to it.committedBytes,
                    "verifiedBytes" to it.verifiedBytes,
                    "meteredConsent" to it.meteredConsent,
                    "userPaused" to it.userPaused,
                    "restartedFromZero" to it.restartedFromZero,
                    "retryCount" to it.retryCount,
                    "nextRetryAt" to it.nextRetryAt,
                    "errorCode" to it.lastError,
                )
            },
            "update" to update?.let {
                linkedMapOf("artifactVersion" to it.artifactVersion, "bytes" to it.bytes, "sequence" to it.sequence)
            },
            "network" to linkedMapOf("connected" to net.connected, "metered" to net.metered),
            "storage" to linkedMapOf("freeBytes" to free, "requiredAdditionalBytes" to required),
        )
        return JsonOut.stringify(root)
    }

    // ---- descriptors --------------------------------------------------------------------------

    private fun context(source: DescriptorSource): VerifyContext = VerifyContext(
        keys = TrustBundle.parseKeys(trust.releaseKeysJson()),
        source = source,
        appBuild = config.appBuild,
        runtimeBuildId = config.runtimeBuildId,
        promptVersions = config.promptVersions,
        licenseNoticeIds = config.licenseNoticeIds,
        nowMs = clock.nowMs(),
        highestSequence = journal.getMeta(MetaKeys.HIGHEST_SEQUENCE)?.toLongOrNull() ?: 0L,
        highestSequencePayloadSha256 = journal.getMeta(MetaKeys.HIGHEST_SEQUENCE_PAYLOAD_SHA256),
        // Bundled list plus digests this device marked bad (SIG-004, DL-013).
        knownBad = TrustBundle.parseKnownBad(trust.knownBadJson()) + journal.badDigests(),
        profile = config.profile,
    )

    private fun verifyBundled(): VerifyResult {
        val bytes = trust.bundledDescriptor()
            ?: return VerifyResult.Rejected(ErrorCodes.SIGNATURE_INVALID, "bundled descriptor missing")
        return verifier.verify(bytes, context(DescriptorSource.BUNDLED))
    }

    private fun bundledBytes(): Long? {
        cachedBundledBytes?.let { return it }
        val result = verifyBundled() as? VerifyResult.Accepted ?: return null
        cachedBundledBytes = result.descriptor.bytes
        return result.descriptor.bytes
    }

    /** `{"valid","artifactVersion","bytes","sha256","errorCode"}` (contract §6.5). */
    fun bundledDescriptorSummaryJson(): String = lock.withLock {
        when (val r = verifyBundled()) {
            is VerifyResult.Accepted -> JsonOut.stringify(
                linkedMapOf(
                    "valid" to true,
                    "artifactVersion" to r.descriptor.artifactVersion,
                    "bytes" to r.descriptor.bytes,
                    "sha256" to r.descriptor.sha256,
                    "errorCode" to null,
                ),
            )
            is VerifyResult.Rejected -> JsonOut.stringify(
                linkedMapOf(
                    "valid" to false, "artifactVersion" to null, "bytes" to 0L, "sha256" to null,
                    "errorCode" to r.code,
                ),
            )
        }
    }

    /** The stored update descriptor, while it is still valid and not already active. */
    private fun availableUpdate(pointer: ActivePointer?): Descriptor? {
        val stored = journal.getMeta(MetaKeys.UPDATE_DESCRIPTOR) ?: return null
        val cached = cachedUpdate
        val descriptor = if (cached != null && cached.first == stored) {
            cached.second
        } else {
            val envelope = DescriptorVerifier.decodeBase64(stored) ?: return null
            val result = verifier.verify(envelope, context(DescriptorSource.UPDATE)) as? VerifyResult.Accepted
                ?: return null
            cachedUpdate = stored to result.descriptor
            result.descriptor
        }
        if (clock.nowMs() >= descriptor.expiresAtMs) return null // SIG-004
        if (descriptor.sha256 == pointer?.active?.artifactId) return null
        if (journal.isBadDigest(descriptor.sha256)) return null
        return descriptor
    }

    /**
     * SIG-005: only ever called from an explicit user action. Never starts a
     * transfer. `{"status":"none|available|error","errorCode":…}`.
     */
    fun checkForUpdateJson(): String {
        ensureReconciled()
        fun result(status: String, code: String?) =
            JsonOut.stringify(linkedMapOf("status" to status, "errorCode" to code))

        val base = originOrNull() ?: return result("error", ErrorCodes.INVALID_STATE)
        if (!networkPolicy.current().connected) return result("error", ErrorCodes.NETWORK_WAIT)
        val envelope: ByteArray = try {
            fetchDescriptor(base)
        } catch (e: IOException) {
            val code = if (networkPolicy.current().connected) ErrorCodes.TRANSFER_RETRY else ErrorCodes.NETWORK_WAIT
            return result("error", code)
        } ?: return result("error", ErrorCodes.SIGNATURE_INVALID) // oversized envelope

        return lock.withLock {
            when (val verdict = verifier.verify(envelope, context(DescriptorSource.UPDATE))) {
                is VerifyResult.Rejected -> result("error", verdict.code)
                is VerifyResult.Accepted -> {
                    val highest = journal.getMeta(MetaKeys.HIGHEST_SEQUENCE)?.toLongOrNull() ?: 0L
                    val pinned = journal.getMeta(MetaKeys.HIGHEST_SEQUENCE_PAYLOAD_SHA256)
                    if (verdict.descriptor.sequence > highest || pinned.isNullOrEmpty()) {
                        // SIG-003: remember the highest accepted sequence and its payload hash.
                        journal.putMeta(MetaKeys.HIGHEST_SEQUENCE, verdict.descriptor.sequence.toString())
                        journal.putMeta(MetaKeys.HIGHEST_SEQUENCE_PAYLOAD_SHA256, verdict.payloadSha256)
                    }
                    val active = store.currentPointer()?.active?.artifactId
                    if (verdict.descriptor.sha256 == active) {
                        journal.deleteMeta(MetaKeys.UPDATE_DESCRIPTOR)
                        cachedUpdate = null
                        notifyChanged(true)
                        result("none", null)
                    } else {
                        val b64 = Base64.getEncoder().encodeToString(envelope)
                        journal.putMeta(MetaKeys.UPDATE_DESCRIPTOR, b64)
                        cachedUpdate = b64 to verdict.descriptor
                        notifyChanged(true)
                        result("available", null)
                    }
                }
            }
        }
    }

    private fun originOrNull(): HttpUrl? {
        val url = config.modelOrigin.toHttpUrlOrNull() ?: return null
        // Release builds refuse a non-HTTPS origin (contract §1); the build also enforces this.
        if (!config.internalBuild && !url.isHttps) return null
        return url
    }

    /** @return envelope bytes, or null when the body exceeds the 64 KiB envelope limit. */
    @Throws(IOException::class)
    private fun fetchDescriptor(base: HttpUrl): ByteArray? {
        var current = base.newBuilder().addEncodedPathSegments("releases/stable.json").build()
        var hops = 0
        while (true) {
            val request = Request.Builder().url(current).get().header("Accept-Encoding", "identity").build()
            client.newCall(request).execute().use { response ->
                if (response.code in 300..399) {
                    hops++
                    val next = response.header("Location")?.let { current.resolve(it) }
                    if (hops > TransferEngine.MAX_REDIRECTS || next == null || !TransferEngine.sameOrigin(next, base)) {
                        throw IOException("redirect rejected")
                    }
                    current = next
                    return@use
                }
                if (response.code != 200) throw IOException("unexpected status")
                val encoding = response.header("Content-Encoding")?.trim()?.lowercase()
                if (!encoding.isNullOrEmpty() && encoding != "identity") throw IOException("encoded descriptor")
                val stream = response.body?.byteStream() ?: throw IOException("empty body")
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val n = stream.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    if (out.size() > DescriptorVerifier.MAX_ENVELOPE_BYTES) return null
                }
                return out.toByteArray()
            }
        }
    }

    // ---- start / pause / resume / cancel -------------------------------------------------------

    /** @return the transfer ID; the existing one when this artifact already has a transfer. */
    fun start(source: String, allowMetered: Boolean): String {
        ensureReconciled()
        val row = lock.withLock {
            val kind = DescriptorSource.fromWire(source)
                ?: throw NamuException(ErrorCodes.INVALID_STATE, "unknown descriptor source")
            if (!eligibility.isEligible()) throw NamuException(ErrorCodes.DEVICE_INELIGIBLE, "device not eligible")
            if (originOrNull() == null) throw NamuException(ErrorCodes.INVALID_STATE, "model origin not usable")

            val envelope: ByteArray = when (kind) {
                DescriptorSource.BUNDLED -> trust.bundledDescriptor()
                DescriptorSource.UPDATE ->
                    journal.getMeta(MetaKeys.UPDATE_DESCRIPTOR)?.let { DescriptorVerifier.decodeBase64(it) }
            } ?: throw NamuException(
                if (kind == DescriptorSource.UPDATE) ErrorCodes.NOT_FOUND else ErrorCodes.SIGNATURE_INVALID,
                "descriptor unavailable",
            )
            val accepted = when (val verdict = verifier.verify(envelope, context(kind))) {
                is VerifyResult.Rejected -> throw NamuException(verdict.code, verdict.reason)
                is VerifyResult.Accepted -> verdict
            }
            val d = accepted.descriptor
            val now = clock.nowMs()

            val existing = journal.findByArtifact(d.sha256)
            if (existing != null) {
                // Idempotent (DL-001). A failed transfer is retried by an explicit start; a paused
                // one stays paused until resume (DL-006).
                if (existing.phase == Phase.FAILED) {
                    journal.update(existing.transferId, now) {
                        it.copy(
                            phase = Phase.WAITING, lastError = null, retryCount = 0, nextRetryAt = null,
                            meteredConsent = allowMetered, userPaused = false, restartedFromZero = false,
                        )
                    }
                }
                return@withLock journal.get(existing.transferId)!!
            }
            if (store.currentPointer()?.active?.artifactId == d.sha256 &&
                store.installState() == InstallState.INSTALLED
            ) {
                throw NamuException(ErrorCodes.INVALID_STATE, "artifact already installed")
            }
            // One download at a time: leftovers of failed attempts for other artifacts are
            // cleared; anything still alive must be cancelled by the user first.
            for (other in journal.all()) {
                when (other.phase) {
                    Phase.INSTALLED -> Unit
                    Phase.FAILED -> removeRow(other)
                    else -> throw NamuException(ErrorCodes.INVALID_STATE, "another transfer exists")
                }
            }
            val transferId = UUID.randomUUID().toString()
            val record = TransferRecord(
                transferId = transferId,
                descriptorSource = kind.wire,
                descriptorBytes = envelope,
                descriptorHash = accepted.payloadSha256,
                artifactVersion = d.artifactVersion,
                artifactSha256 = d.sha256,
                artifactPath = d.path,
                phase = Phase.WAITING,
                expectedBytes = d.bytes,
                stagedFilename = "$transferId.part",
                meteredConsent = allowMetered, // per transfer, never inherited (DL-006)
                createdAt = now,
                updatedAt = now,
            )
            if (!journal.insert(record)) throw NamuException(ErrorCodes.INVALID_STATE, "transfer exists")
            record
        }
        if (row.phase == Phase.WAITING && !row.userPaused) schedule(row, replaceExisting = false)
        notifyChanged(true)
        return row.transferId
    }

    fun pause(transferId: String) {
        ensureReconciled()
        lock.withLock {
            val row = journal.get(transferId) ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown transfer")
            if (row.phase !in PAUSABLE) return
            val control = activeRuns[transferId]
            journal.update(transferId, clock.nowMs()) {
                // While an engine run is active it owns the phase; it will settle on `paused`.
                if (control == null) it.copy(userPaused = true, phase = Phase.PAUSED, nextRetryAt = null)
                else it.copy(userPaused = true)
            }
            control?.requestPause()
            awaitRunEnd(transferId, PAUSE_WAIT_MS)
        }
        scheduler.cancel(transferId)
        notifyChanged(true)
    }

    fun resume(transferId: String, allowMetered: Boolean) {
        ensureReconciled()
        var replace = false
        val row = lock.withLock {
            val current = journal.get(transferId) ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown transfer")
            when (current.phase) {
                Phase.STAGED, Phase.SELF_TESTING, Phase.INSTALLED -> return
                Phase.REMOVING, Phase.ABSENT -> throw NamuException(ErrorCodes.INVALID_STATE, "transfer is being removed")
                else -> Unit
            }
            if (current.descriptorSource == DescriptorSource.UPDATE.wire) {
                // An expired or superseded remote descriptor cannot authorize more transfer (SIG-004).
                val verdict = verifier.verify(current.descriptorBytes, context(DescriptorSource.UPDATE))
                if (verdict is VerifyResult.Rejected) {
                    journal.update(transferId, clock.nowMs()) { it.copy(phase = Phase.FAILED, lastError = verdict.code) }
                    notifyChanged(true)
                    throw NamuException(verdict.code, verdict.reason)
                }
            }
            replace = current.meteredConsent != allowMetered
            val control = activeRuns[transferId]
            if (control != null && replace) {
                // The OS job carries the old network constraint: stop it and schedule a new one.
                control.requestStop()
                awaitRunEnd(transferId, CANCEL_WAIT_MS)
            }
            val stillRunning = activeRuns.containsKey(transferId)
            val updated = journal.update(transferId, clock.nowMs()) {
                it.copy(
                    userPaused = false,
                    meteredConsent = allowMetered,
                    retryCount = 0,
                    nextRetryAt = null,
                    restartedFromZero = false,
                    phase = if (stillRunning) it.phase else Phase.WAITING,
                    lastError = if (stillRunning) it.lastError else null,
                )
            }
            if (stillRunning) activeRuns[transferId]?.wake() // cut a back-off sleep short
            updated ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown transfer")
        }
        schedule(row, replaceExisting = replace)
        notifyChanged(true)
    }

    /** DL-006: after cancel nothing is retried or rescheduled; setup data is removed. */
    fun cancel(transferId: String) {
        ensureReconciled()
        lock.withLock {
            val row = journal.get(transferId) ?: return // already cancelled: idempotent
            if (row.phase == Phase.INSTALLED || row.phase == Phase.SELF_TESTING) {
                throw NamuException(ErrorCodes.INVALID_STATE, "transfer cannot be cancelled in this phase")
            }
            activeRuns[transferId]?.requestCancel()
            awaitRunEnd(transferId, CANCEL_WAIT_MS)
            removeRow(row)
        }
        scheduler.cancel(transferId)
        notifyChanged(true)
    }

    /** Deletes staging, an unreferenced candidate release and the journal row. Caller holds the lock. */
    private fun removeRow(row: TransferRecord) {
        store.layout.stagingFile(row.transferId).delete()
        val pointer = store.currentPointer()
        val referenced = row.artifactSha256 == pointer?.active?.artifactId ||
            row.artifactSha256 == pointer?.previous?.artifactId ||
            row.artifactSha256 == runtimeReference
        if (!referenced) store.deleteRelease(row.artifactSha256)
        journal.delete(row.transferId)
    }

    private fun schedule(row: TransferRecord, replaceExisting: Boolean) {
        scheduler.schedule(
            row.transferId,
            requireUnmetered = !row.meteredConsent,
            remainingBytes = maxOf(0L, row.expectedBytes - row.committedBytes),
            replaceExisting = replaceExisting,
        )
    }

    // ---- engine entry point for the OS job ------------------------------------------------------

    /** Signals for a run the OS is about to start; keep it to deliver onStopJob. */
    fun newControl(): TransferControl = TransferControl()

    /**
     * Blocking. Called by the JobService / worker thread with no JS runtime
     * present (ARC-003). At most one run per transfer.
     */
    fun runTransfer(transferId: String, control: TransferControl): RunOutcome {
        ensureReconciled()
        lock.withLock {
            if (activeRuns.containsKey(transferId)) return RunOutcome.NothingToDo
            activeRuns[transferId] = control
        }
        val outcome = try {
            engine.run(transferId, control)
        } catch (e: Exception) {
            journal.update(transferId, clock.nowMs()) {
                it.copy(phase = Phase.FAILED, lastError = ErrorCodes.TRANSFER_RETRY, nextRetryAt = null)
            }
            RunOutcome.Failed(ErrorCodes.TRANSFER_RETRY)
        } finally {
            lock.withLock {
                activeRuns.remove(transferId)
                runEnded.signalAll()
            }
        }
        notifyChanged(true)
        return outcome
    }

    /** Caller holds the lock. */
    private fun awaitRunEnd(transferId: String, maxMs: Long) {
        var remaining = TimeUnit.MILLISECONDS.toNanos(maxMs)
        while (activeRuns.containsKey(transferId) && remaining > 0) {
            remaining = runEnded.awaitNanos(remaining)
        }
    }

    // ---- self-test and activation (DL-010…DL-012) ------------------------------------------------

    fun beginSelfTest(transferId: String): String {
        ensureReconciled()
        return lock.withLock {
            val row = journal.get(transferId) ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown transfer")
            if (row.phase == Phase.SELF_TESTING) return@withLock row.artifactSha256
            if (row.phase != Phase.STAGED) throw NamuException(ErrorCodes.INVALID_STATE, "transfer is not staged")
            val reference = runtimeReference
            if (reference != null && reference != row.artifactSha256) {
                // DL-011: never hold the old and the new context together (T11).
                throw NamuException(ErrorCodes.ENGINE_BUSY, "runtime still holds a model")
            }
            if (journal.isBadDigest(row.artifactSha256) ||
                !store.releaseIsIntact(row.artifactSha256, row.expectedBytes)
            ) {
                journal.update(transferId, clock.nowMs()) {
                    it.copy(phase = Phase.FAILED, lastError = ErrorCodes.FILE_DAMAGED, committedBytes = 0)
                }
                notifyChanged(true)
                throw NamuException(ErrorCodes.FILE_DAMAGED, "candidate release is not intact")
            }
            // Marker first, durably; a crash from here on quarantines the candidate (DL-012).
            store.writeMarker(PendingMarker(transferId, row.artifactSha256, clock.nowMs()))
            journal.update(transferId, clock.nowMs()) { it.copy(phase = Phase.SELF_TESTING, lastError = null) }
            notifyChanged(true)
            row.artifactSha256
        }
    }

    /** @return snapshot JSON. */
    fun activate(transferId: String, selfTestPassed: Boolean, failureCode: String): String {
        ensureReconciled()
        return lock.withLock {
            val row = journal.get(transferId) ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown transfer")
            val alreadyDone = (row.phase == Phase.INSTALLED && selfTestPassed) ||
                (row.phase == Phase.FAILED && !selfTestPassed)
            if (alreadyDone) return@withLock buildSnapshot()
            if (row.phase != Phase.SELF_TESTING) throw NamuException(ErrorCodes.INVALID_STATE, "no self-test in progress")

            if (selfTestPassed) {
                if (!SpaceRule.reserveOk(SpaceRule.safeFree(spaceProbe))) {
                    // DL-009 recheck before activation. The candidate stays staged; the old pointer is untouched.
                    store.deleteMarker()
                    journal.update(transferId, clock.nowMs()) {
                        it.copy(phase = Phase.STAGED, lastError = ErrorCodes.SPACE_LOW)
                    }
                    notifyChanged(true)
                    throw NamuException(ErrorCodes.SPACE_LOW, "not enough free space to activate")
                }
                if (!store.releaseIsIntact(row.artifactSha256, row.expectedBytes)) {
                    store.deleteMarker()
                    journal.update(transferId, clock.nowMs()) {
                        it.copy(phase = Phase.FAILED, lastError = ErrorCodes.FILE_DAMAGED, committedBytes = 0)
                    }
                    notifyChanged(true)
                    throw NamuException(ErrorCodes.FILE_DAMAGED, "candidate release is not intact")
                }
                try {
                    store.activate(row, runtimeReference)
                } catch (e: IOException) {
                    if (store.currentPointer()?.active?.artifactId == row.artifactSha256) {
                        // The atomic replacement already happened; only follow-up steps failed.
                        journal.update(transferId, clock.nowMs()) { it.copy(phase = Phase.INSTALLED, lastError = null) }
                        store.reconcileMirror()
                        store.deleteMarkerQuietly()
                    } else {
                        // Pointer not replaced: the old model stays active (T09).
                        store.pointers.discardTemporary()
                        store.deleteMarkerQuietly()
                        val code = if (SpaceRule.reserveOk(SpaceRule.safeFree(spaceProbe))) {
                            ErrorCodes.STORAGE_WRITE_FAILED
                        } else {
                            ErrorCodes.SPACE_LOW
                        }
                        journal.update(transferId, clock.nowMs()) { it.copy(phase = Phase.STAGED, lastError = code) }
                        notifyChanged(true)
                        throw NamuException(code, "activation could not be written")
                    }
                }
                if (journal.getMeta(MetaKeys.UPDATE_DESCRIPTOR) != null &&
                    availableUpdate(store.currentPointer()) == null
                ) {
                    journal.deleteMeta(MetaKeys.UPDATE_DESCRIPTOR)
                    cachedUpdate = null
                }
            } else {
                val code = if (failureCode in ErrorCodes.SELF_TEST_FAILURE_CODES) failureCode
                else ErrorCodes.MODEL_LOAD_FAILED
                store.quarantine(row.artifactSha256, code)
                store.deleteMarker()
                journal.update(transferId, clock.nowMs()) {
                    it.copy(phase = Phase.FAILED, lastError = code, committedBytes = 0, verifiedBytes = 0, etag = null)
                }
            }
            notifyChanged(true)
            buildSnapshot()
        }
    }

    // ---- runtime reference, retention, restore, repair, removal ----------------------------------

    fun resolveArtifactPath(artifactId: String): String {
        ensureReconciled()
        return lock.withLock {
            if (!StorageLayout.ARTIFACT_ID.matches(artifactId)) throw NamuException(ErrorCodes.NOT_FOUND, "unknown artifact")
            val pointer = store.currentPointer()
            val bytes = when (artifactId) {
                pointer?.active?.artifactId -> pointer.active.bytes
                pointer?.previous?.artifactId -> pointer.previous!!.bytes
                else -> journal.findByArtifact(artifactId)
                    ?.takeIf { it.phase == Phase.STAGED || it.phase == Phase.SELF_TESTING }
                    ?.expectedBytes
            } ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown artifact")
            if (!store.releaseIsIntact(artifactId, bytes)) throw NamuException(ErrorCodes.NOT_FOUND, "artifact not intact")
            store.layout.releaseFile(artifactId).absolutePath
        }
    }

    /**
     * Live runtime reference (DL-013); empty clears it. Only flips a flag, so it is safe on the
     * JS thread and ordered with the calls that follow it. File clean-up that became possible
     * happens in [runDeferredCleanup].
     */
    fun setRuntimeReference(artifactId: String) {
        runtimeReference = artifactId.takeIf { it.isNotEmpty() && StorageLayout.ARTIFACT_ID.matches(it) }
    }

    /** Retention and orphan sweep that had to wait for the runtime to let go of a file. */
    fun runDeferredCleanup() {
        ensureReconciled()
        lock.withLock {
            val reference = runtimeReference
            try {
                store.applyRetention(reference)
                store.sweepOrphans(reference)
            } catch (e: IOException) {
                // Clean-up is retried at the next start.
            }
        }
        notifyChanged(true)
    }

    fun noteSuccessfulForegroundSession() {
        ensureReconciled()
        lock.withLock {
            try {
                store.noteSuccessfulSession(runtimeReference)
            } catch (e: IOException) {
                throw NamuException(ErrorCodes.STORAGE_WRITE_FAILED, "pointer update failed")
            }
        }
        notifyChanged(true)
    }

    /** Manual "Restore previous version" (DL-013). @return snapshot JSON. */
    fun restorePrevious(): String = restorePrevious(markAbandonedBad = false)

    fun restorePrevious(markAbandonedBad: Boolean): String {
        ensureReconciled()
        return lock.withLock {
            if (runtimeReference != null) throw NamuException(ErrorCodes.ENGINE_BUSY, "runtime still holds a model")
            try {
                store.restorePrevious(markAbandonedBad, runtimeReference)
            } catch (e: IOException) {
                throw NamuException(ErrorCodes.STORAGE_WRITE_FAILED, "pointer update failed")
            }
            notifyChanged(true)
            buildSnapshot()
        }
    }

    /**
     * Explicit repair (DL-014): rehash the active artifact. A damaged copy is
     * removed; `previous` takes over when it is intact, otherwise the state
     * becomes absent so the bundled descriptor can be downloaded again.
     */
    fun repair(): String {
        ensureReconciled()
        val pointer = lock.withLock {
            if (runtimeReference != null) throw NamuException(ErrorCodes.ENGINE_BUSY, "runtime still holds a model")
            store.currentPointer()
        } ?: return snapshotJson()
        val file = store.layout.releaseFile(pointer.active.artifactId)
        val healthy = try {
            file.isFile && file.length() == pointer.active.bytes &&
                Sha256Streamer.hashFile(file) == pointer.active.sha256
        } catch (e: IOException) {
            false
        }
        return lock.withLock {
            if (!healthy) {
                if (runtimeReference != null) throw NamuException(ErrorCodes.ENGINE_BUSY, "runtime still holds a model")
                try {
                    store.dropDamagedActive()
                } catch (e: IOException) {
                    throw NamuException(ErrorCodes.STORAGE_WRITE_FAILED, "pointer update failed")
                }
            }
            notifyChanged(true)
            buildSnapshot()
        }
    }

    fun removeModel() {
        ensureReconciled()
        removeEverything(destroyJournal = false)
    }

    /** SEC-006: cancels transfers, removes journal, staging, releases and pointer. */
    fun deleteAllTransferData() {
        ensureReconciled()
        removeEverything(destroyJournal = true)
    }

    private fun removeEverything(destroyJournal: Boolean) {
        val ids = lock.withLock {
            // Never delete files a running engine may have mapped (SEC-006).
            if (runtimeReference != null) throw NamuException(ErrorCodes.ENGINE_BUSY, "runtime still holds a model")
            val rows = journal.all()
            for (row in rows) {
                journal.update(row.transferId, clock.nowMs()) { it.copy(phase = Phase.REMOVING, userPaused = true) }
                activeRuns[row.transferId]?.requestCancel()
            }
            for (row in rows) awaitRunEnd(row.transferId, CANCEL_WAIT_MS)
            store.deleteAllFiles()
            for (row in rows) journal.delete(row.transferId)
            journal.deleteMeta(MetaKeys.ACTIVE_MIRROR)
            if (destroyJournal) {
                journal.destroyAll()
                cachedUpdate = null
            }
            rows.map { it.transferId }
        }
        for (id in ids) scheduler.cancel(id)
        notifyChanged(true)
    }

    companion object {
        private val NEEDS_BYTES = setOf(Phase.WAITING, Phase.DOWNLOADING, Phase.PAUSED, Phase.FAILED)
        private val PAUSABLE = setOf(Phase.WAITING, Phase.DOWNLOADING, Phase.VERIFYING, Phase.PAUSED)
        const val PAUSE_WAIT_MS = 5_000L
        const val CANCEL_WAIT_MS = 10_000L
    }
}

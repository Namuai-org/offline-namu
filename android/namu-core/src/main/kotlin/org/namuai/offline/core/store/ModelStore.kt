package org.namuai.offline.core.store

import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.json.JsonOut
import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.StrictJsonException
import org.namuai.offline.core.json.integer
import org.namuai.offline.core.json.string
import org.namuai.offline.core.transfer.Journal
import org.namuai.offline.core.transfer.MetaKeys
import org.namuai.offline.core.transfer.Phase
import org.namuai.offline.core.transfer.TransferRecord
import org.namuai.offline.core.util.Clock
import org.namuai.offline.core.util.CrashHook
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption

enum class InstallState(val wire: String) {
    ABSENT("absent"),
    INSTALLED("installed"),
    NEEDS_REPAIR("needsRepair"),
}

/**
 * `pending-activation.json`, written durably before the self-test (DL-012).
 * [selfTestPassed] is a local extension of the contract's three fields: it is
 * set (durably) when JS reports a passed self-test, right before the pointer
 * replacement, so a crash inside the activation window does not quarantine a
 * candidate that already proved it loads.
 */
data class PendingMarker(
    val transferId: String,
    val artifactId: String,
    val startedAt: Long,
    val selfTestPassed: Boolean = false,
)

/**
 * Release directory, activation pointer, pending marker, startup
 * reconciliation and retention (contract §3, §6.4; DL-010…DL-014).
 *
 * `active.json` is the activation authority; the journal only mirrors it
 * (ARC-003). This class never parses model bytes.
 */
class ModelStore(
    val layout: StorageLayout,
    private val journal: Journal,
    private val clock: Clock,
    private val crashHook: CrashHook,
    dirSyncer: DirectorySyncer,
) {
    private val durable = DurableFiles(dirSyncer, crashHook)
    val pointers = ActivePointerStore(layout, durable)

    // ---- release installation (contract §6.4 step 4) -------------------------------------

    /** Moves a hash-verified staging file to `releases/<sha256>/model.gguf`, read-only. */
    @Throws(IOException::class)
    fun installVerified(stagingFile: File, artifactId: String): File {
        val dir = layout.releaseDir(artifactId)
        val target = layout.releaseFile(artifactId)
        dir.mkdirs()
        if (!dir.isDirectory) throw IOException("release directory unavailable")
        crashHook.at("install.afterMkdir")
        if (target.exists()) {
            target.setWritable(true, true)
            if (!target.delete()) throw IOException("stale release file")
        }
        // Same volume by construction (DL-008), so this is a rename, not a copy.
        Files.move(stagingFile.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
        crashHook.at("install.afterRename")
        target.setReadOnly()
        durable.syncDirectory(dir)
        durable.syncDirectory(layout.releasesDir)
        durable.syncDirectory(layout.stagingDir)
        crashHook.at("install.afterDirFsync")
        return target
    }

    fun releaseIsIntact(ref: ArtifactRef): Boolean = releaseIsIntact(ref.artifactId, ref.bytes)

    /** DL-014: existence and exact length only; no rehash on every launch. */
    fun releaseIsIntact(artifactId: String, bytes: Long): Boolean {
        if (!StorageLayout.ARTIFACT_ID.matches(artifactId)) return false
        val file = layout.releaseFile(artifactId)
        return file.isFile && file.length() == bytes
    }

    fun deleteRelease(artifactId: String) {
        if (!StorageLayout.ARTIFACT_ID.matches(artifactId)) return
        DurableFiles.deleteRecursively(layout.releaseDir(artifactId))
    }

    // ---- pending-activation marker ----------------------------------------------------------

    @Throws(IOException::class)
    fun writeMarker(marker: PendingMarker) {
        layout.root.mkdirs()
        val json = JsonOut.stringify(
            linkedMapOf(
                "transferId" to marker.transferId,
                "artifactId" to marker.artifactId,
                "startedAt" to marker.startedAt,
                "selfTestPassed" to marker.selfTestPassed,
            ),
        )
        durable.replace(layout.pendingMarker, layout.pendingMarkerTmp, json.toByteArray(Charsets.UTF_8), "marker")
    }

    /** @return the marker; [PendingMarker] with empty IDs when the file exists but is unreadable. */
    fun readMarker(): PendingMarker? {
        val file = layout.pendingMarker
        if (!file.exists()) return null
        return try {
            val o = StrictJson.parseUtf8(file.readBytes()) as? JsonValue.Obj
            val transferId = o?.string("transferId")
            val artifactId = o?.string("artifactId")
            val startedAt = o?.integer("startedAt")
            if (transferId == null || artifactId == null || startedAt == null ||
                !StorageLayout.ARTIFACT_ID.matches(artifactId)
            ) {
                PendingMarker("", "", 0)
            } else {
                PendingMarker(transferId, artifactId, startedAt, (o?.members?.get("selfTestPassed") as? JsonValue.Bool)?.value == true)
            }
        } catch (e: StrictJsonException) {
            PendingMarker("", "", 0)
        } catch (e: IOException) {
            PendingMarker("", "", 0)
        }
    }

    @Throws(IOException::class)
    fun deleteMarker() {
        durable.deleteDurably(layout.pendingMarker)
    }

    fun deleteMarkerQuietly() {
        try {
            deleteMarker()
        } catch (e: IOException) {
            // Reconciliation removes it at the next start.
        }
    }

    // ---- activation (contract §6.4 step 6) ----------------------------------------------------

    /**
     * Atomic pointer replacement, then journal mirror, then phase `installed`,
     * then marker removal. Checkpoints `activate.*` and `pointer.*` are crash
     * injection points (T10); [reconcile] repairs every intermediate state.
     */
    @Throws(IOException::class)
    fun activate(record: TransferRecord, runtimeReference: String?): ActivePointer {
        crashHook.at("activate.begin")
        val now = clock.nowMs()
        val marker = readMarker()
        writeMarker(PendingMarker(record.transferId, record.artifactSha256, marker?.startedAt ?: now, selfTestPassed = true))
        crashHook.at("activate.afterMarkerPassed")
        val old = (pointers.read() as? PointerRead.Valid)?.pointer
        val newRef = ArtifactRef(
            artifactId = record.artifactSha256,
            version = record.artifactVersion,
            bytes = record.expectedBytes,
            sha256 = record.artifactSha256,
            activatedAt = now,
        )
        val previous = when {
            old == null -> null
            old.active.artifactId == newRef.artifactId -> old.previous
            else -> old.active
        }
        val pointer = ActivePointer(newRef, previous, TrialState(now, 0))
        pointers.write(pointer)
        crashHook.at("activate.afterPointer")
        mirror(pointer)
        crashHook.at("activate.afterMirror")
        journal.update(record.transferId, now) {
            it.copy(phase = Phase.INSTALLED, lastError = null, nextRetryAt = null, retryCount = 0)
        }
        crashHook.at("activate.afterJournalCommit")
        deleteMarker()
        crashHook.at("activate.afterMarkerDelete")
        sweepOrphans(runtimeReference)
        return pointer
    }

    /** Self-test failed or crashed: mark the digest locally bad and delete the candidate only. */
    fun quarantine(artifactId: String, reason: String) {
        journal.addBadDigest(artifactId, reason, clock.nowMs())
        crashHook.at("quarantine.afterBadDigest")
        val active = (pointers.read() as? PointerRead.Valid)?.pointer?.active?.artifactId
        if (active != artifactId) deleteRelease(artifactId)
    }

    // ---- state -------------------------------------------------------------------------------

    fun currentPointer(): ActivePointer? = (pointers.read() as? PointerRead.Valid)?.pointer

    fun installState(pointer: ActivePointer? = currentPointer()): InstallState = when {
        pointer == null -> InstallState.ABSENT
        releaseIsIntact(pointer.active) -> InstallState.INSTALLED
        else -> InstallState.NEEDS_REPAIR
    }

    fun canRestorePrevious(pointer: ActivePointer?): Boolean {
        val previous = pointer?.previous ?: return false
        return releaseIsIntact(previous) && !journal.isBadDigest(previous.sha256)
    }

    /** Rewrites the journal mirror from the pointer (the pointer is the authority). */
    fun reconcileMirror() = mirror(currentPointer())

    /**
     * Repair found the active copy damaged (DL-014): promote an intact
     * `previous`, otherwise remove the pointer so the state becomes absent.
     * The damaged release directory is deleted; its digest is NOT marked bad
     * because only the local copy was corrupt.
     */
    @Throws(IOException::class)
    fun dropDamagedActive(): ActivePointer? {
        val pointer = currentPointer() ?: return null
        val now = clock.nowMs()
        val next = if (canRestorePrevious(pointer)) {
            ActivePointer(pointer.previous!!.copy(activatedAt = now), null, TrialState(now, 0))
        } else {
            null
        }
        if (next != null) pointers.write(next) else pointers.delete()
        mirror(next)
        journal.findByArtifact(pointer.active.sha256)?.let { journal.delete(it.transferId) }
        deleteRelease(pointer.active.artifactId)
        return next
    }

    private fun mirror(pointer: ActivePointer?) {
        if (pointer == null) journal.deleteMeta(MetaKeys.ACTIVE_MIRROR)
        else journal.putMeta(MetaKeys.ACTIVE_MIRROR, pointer.toJson())
    }

    // ---- retention and restore (DL-013) ----------------------------------------------------

    @Throws(IOException::class)
    fun noteSuccessfulSession(runtimeReference: String?) {
        val pointer = currentPointer() ?: return
        if (pointer.trial.successfulSessions < REQUIRED_SESSIONS) {
            val next = pointer.copy(
                trial = pointer.trial.copy(successfulSessions = pointer.trial.successfulSessions + 1),
            )
            pointers.write(next)
            mirror(next)
        }
        applyRetention(runtimeReference)
    }

    /** Deletes `previous` once 7 days AND three successful sessions passed and nothing references it. */
    @Throws(IOException::class)
    fun applyRetention(runtimeReference: String?) {
        val pointer = currentPointer() ?: return
        val previous = pointer.previous ?: return
        val oldEnough = clock.nowMs() - pointer.trial.startedAt >= RETENTION_MS
        val qualified = pointer.trial.successfulSessions >= REQUIRED_SESSIONS
        if (!oldEnough || !qualified || runtimeReference == previous.artifactId) return
        val next = pointer.copy(previous = null)
        pointers.write(next) // pointer first: a crash leaves only an orphan directory
        mirror(next)
        sweepOrphans(runtimeReference)
    }

    /**
     * Swaps the pointer to `previous`. Manual restore keeps the abandoned
     * version as the new `previous`; the automatic failed-trial path marks it
     * locally bad instead (contract §6.4).
     */
    @Throws(IOException::class)
    fun restorePrevious(markAbandonedBad: Boolean, runtimeReference: String?): ActivePointer {
        val pointer = currentPointer() ?: throw NamuException(ErrorCodes.INVALID_STATE, "no active pointer")
        val previous = pointer.previous ?: throw NamuException(ErrorCodes.INVALID_STATE, "no previous version")
        if (!canRestorePrevious(pointer)) throw NamuException(ErrorCodes.INVALID_STATE, "previous not intact")
        val now = clock.nowMs()
        val abandoned = pointer.active
        val next = ActivePointer(
            active = previous.copy(activatedAt = now),
            previous = if (markAbandonedBad) null else abandoned,
            trial = TrialState(now, 0),
        )
        pointers.write(next)
        mirror(next)
        if (markAbandonedBad) {
            journal.addBadDigest(abandoned.sha256, "failed trial", now)
            journal.findByArtifact(abandoned.sha256)?.let { row ->
                journal.update(row.transferId, now) {
                    it.copy(phase = Phase.FAILED, lastError = ErrorCodes.MODEL_LOAD_FAILED)
                }
            }
            sweepOrphans(runtimeReference)
        }
        return next
    }

    /**
     * Deletes release directories nothing refers to. A directory survives when
     * it is the active or previous artifact, holds the live runtime reference,
     * or belongs to a transfer that is verifying, staged or self-testing.
     */
    fun sweepOrphans(runtimeReference: String?) {
        val pointer = currentPointer()
        val keep = HashSet<String>()
        pointer?.active?.artifactId?.let(keep::add)
        pointer?.previous?.artifactId?.let(keep::add)
        runtimeReference?.let(keep::add)
        for (row in journal.all()) {
            when (row.phase) {
                Phase.VERIFYING, Phase.STAGED, Phase.SELF_TESTING -> keep.add(row.artifactSha256)
                // A superseded version whose retention ended: its row goes with its files.
                Phase.INSTALLED -> if (row.artifactSha256 !in keep) journal.delete(row.transferId)
                else -> Unit
            }
        }
        layout.releasesDir.listFiles()?.forEach { dir ->
            if (dir.name !in keep) DurableFiles.deleteRecursively(dir)
        }
    }

    // ---- startup reconciliation (DL-012, DL-014) -------------------------------------------

    /**
     * Runs before the first snapshot is answered. Cheap: stat calls and small
     * journal updates only, never a rehash (DL-014).
     */
    @Throws(IOException::class)
    fun reconcile(runtimeReference: String?) {
        layout.ensureDirectories()
        pointers.discardTemporary() // a .tmp is never promoted
        val pointer = currentPointer()
        val now = clock.nowMs()

        // 1. Pending marker: the process died between beginSelfTest and the end of activate.
        val marker = readMarker()
        if (marker != null) {
            if (marker.artifactId.isNotEmpty() && pointer?.active?.artifactId == marker.artifactId) {
                // The pointer replacement was already durable: finish the journal commit.
                journal.update(marker.transferId, now) { it.copy(phase = Phase.INSTALLED, lastError = null) }
            } else if (marker.artifactId.isNotEmpty() && marker.selfTestPassed) {
                // The self-test had passed; the crash hit the activation window. Keep the candidate staged.
                val intact = journal.get(marker.transferId)?.let { releaseIsIntact(it.artifactSha256, it.expectedBytes) } == true
                journal.update(marker.transferId, now) {
                    if (intact) it.copy(phase = Phase.STAGED, lastError = null)
                    else it.copy(phase = Phase.FAILED, lastError = ErrorCodes.FILE_DAMAGED, committedBytes = 0)
                }
            } else if (marker.artifactId.isNotEmpty()) {
                quarantine(marker.artifactId, "self-test did not complete")
                journal.update(marker.transferId, now) {
                    it.copy(phase = Phase.FAILED, lastError = ErrorCodes.MODEL_LOAD_FAILED, committedBytes = 0)
                }
            }
            deleteMarker()
        }

        // 2. Transfer rows.
        for (row in journal.all()) {
            val isActive = pointer?.active?.artifactId == row.artifactSha256
            val isPrevious = pointer?.previous?.artifactId == row.artifactSha256
            when (row.phase) {
                Phase.SELF_TESTING -> when {
                    isActive -> setPhase(row, Phase.INSTALLED, null)
                    marker == null || marker.artifactId != row.artifactSha256 -> {
                        // No marker names this row: an unreadable marker or a half-finished failure path.
                        if (marker != null && marker.artifactId.isEmpty()) {
                            quarantine(row.artifactSha256, "self-test did not complete")
                            setPhase(row, Phase.FAILED, ErrorCodes.MODEL_LOAD_FAILED)
                        } else if (releaseIsIntact(row.artifactSha256, row.expectedBytes) &&
                            !journal.isBadDigest(row.artifactSha256)
                        ) {
                            setPhase(row, Phase.STAGED, null)
                        } else {
                            setPhase(row, Phase.FAILED, ErrorCodes.MODEL_LOAD_FAILED)
                        }
                    }
                    else -> Unit // handled with the marker above
                }
                Phase.INSTALLED -> if (!isActive && !isPrevious) {
                    // Verified release without a pointer is staged, not installed.
                    if (releaseIsIntact(row.artifactSha256, row.expectedBytes) &&
                        !journal.isBadDigest(row.artifactSha256)
                    ) {
                        setPhase(row, Phase.STAGED, null)
                    } else {
                        journal.delete(row.transferId)
                    }
                }
                Phase.STAGED -> if (isActive) {
                    setPhase(row, Phase.INSTALLED, null)
                } else if (!releaseIsIntact(row.artifactSha256, row.expectedBytes)) {
                    journal.update(row.transferId, now) {
                        it.copy(phase = Phase.FAILED, lastError = ErrorCodes.FILE_DAMAGED, committedBytes = 0, verifiedBytes = 0)
                    }
                }
                Phase.DOWNLOADING, Phase.VERIFYING -> {
                    // No engine is running after a process start; the scheduler will pick it up again.
                    truncateStaging(row)
                    journal.update(row.transferId, now) {
                        it.copy(phase = if (it.userPaused) Phase.PAUSED else Phase.WAITING, verifiedBytes = 0)
                    }
                }
                Phase.WAITING, Phase.PAUSED, Phase.FAILED -> truncateStaging(row)
                Phase.REMOVING, Phase.ABSENT -> {
                    layout.stagingFile(row.transferId).delete()
                    journal.delete(row.transferId)
                }
            }
        }

        // 3. Staging files without a journal row are garbage.
        val known = journal.all().map { "${it.transferId}.part" }.toSet()
        layout.stagingDir.listFiles()?.forEach { if (it.name !in known) it.delete() }

        // 4. The journal mirror is rewritten from the pointer, never the other way round.
        mirror(pointer)
        sweepOrphans(runtimeReference)
        applyRetention(runtimeReference)
    }

    private fun setPhase(row: TransferRecord, phase: Phase, error: String?) {
        journal.update(row.transferId, clock.nowMs()) { it.copy(phase = phase, lastError = error) }
    }

    /** DL-004: bytes beyond the last durable commit are discarded before any resume. */
    @Throws(IOException::class)
    fun truncateStaging(row: TransferRecord) {
        val part = layout.stagingFile(row.transferId)
        if (!part.exists()) {
            if (row.committedBytes > 0 && !releaseIsIntact(row.artifactSha256, row.expectedBytes)) {
                journal.update(row.transferId, clock.nowMs()) {
                    it.copy(committedBytes = 0, verifiedBytes = 0, restartedFromZero = true, etag = null)
                }
            }
            return
        }
        RandomAccessFile(part, "rw").use { raf ->
            val length = raf.length()
            if (length < row.committedBytes) {
                // The journal claims more than the file holds: nothing can be trusted.
                raf.setLength(0)
                raf.channel.force(true)
                journal.update(row.transferId, clock.nowMs()) {
                    it.copy(committedBytes = 0, verifiedBytes = 0, restartedFromZero = true, etag = null)
                }
            } else if (length > row.committedBytes) {
                raf.setLength(row.committedBytes)
                raf.channel.force(true)
            }
        }
    }

    /** removeModel / deleteAllTransferData: every model file, pointer and marker. */
    fun deleteAllFiles() {
        DurableFiles.deleteRecursively(layout.stagingDir)
        DurableFiles.deleteRecursively(layout.releasesDir)
        layout.activePointer.delete()
        layout.activePointerTmp.delete()
        layout.pendingMarker.delete()
        layout.pendingMarkerTmp.delete()
        layout.ensureDirectories()
    }

    companion object {
        const val RETENTION_MS = 7L * 24 * 3600 * 1000
        const val REQUIRED_SESSIONS = 3L
    }
}

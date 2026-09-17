package org.namuai.offline.core.store

import org.namuai.offline.core.descriptor.DescriptorVerifier
import org.namuai.offline.core.json.JsonOut
import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.StrictJsonException
import org.namuai.offline.core.json.integer
import org.namuai.offline.core.json.obj
import org.namuai.offline.core.json.string
import java.io.File
import java.io.IOException

data class ArtifactRef(
    val artifactId: String,
    val version: String,
    val bytes: Long,
    val sha256: String,
    val activatedAt: Long,
) {
    fun toJsonMap(): Map<String, Any?> = linkedMapOf(
        "artifactId" to artifactId,
        "version" to version,
        "bytes" to bytes,
        "sha256" to sha256,
        "activatedAt" to activatedAt,
    )
}

data class TrialState(val startedAt: Long, val successfulSessions: Long)

/** `active.json` (contract §6.4): the activation authority (DL-012, ARC-003). */
data class ActivePointer(val active: ArtifactRef, val previous: ArtifactRef?, val trial: TrialState) {
    fun toJson(): String = JsonOut.stringify(
        linkedMapOf(
            "schema" to 1L,
            "active" to active.toJsonMap(),
            "previous" to previous?.toJsonMap(),
            "trial" to linkedMapOf(
                "startedAt" to trial.startedAt,
                "successfulSessions" to trial.successfulSessions,
            ),
        ),
    )

    companion object {
        /** Null for anything that is not a complete, well-formed schema-1 pointer. */
        fun parse(bytes: ByteArray): ActivePointer? {
            val root = try {
                StrictJson.parseUtf8(bytes) as? JsonValue.Obj ?: return null
            } catch (e: StrictJsonException) {
                return null
            }
            if (root.integer("schema") != 1L) return null
            val active = root.obj("active")?.let(::parseRef) ?: return null
            val previous = when (val p = root.members["previous"]) {
                null, is JsonValue.Null -> null
                is JsonValue.Obj -> parseRef(p) ?: return null
                else -> return null
            }
            val trialObj = root.obj("trial") ?: return null
            val startedAt = trialObj.integer("startedAt") ?: return null
            val sessions = trialObj.integer("successfulSessions") ?: return null
            if (sessions < 0) return null
            return ActivePointer(active, previous, TrialState(startedAt, sessions))
        }

        private fun parseRef(o: JsonValue.Obj): ArtifactRef? {
            val artifactId = o.string("artifactId") ?: return null
            val version = o.string("version") ?: return null
            val bytes = o.integer("bytes") ?: return null
            val sha256 = o.string("sha256") ?: return null
            val activatedAt = o.integer("activatedAt") ?: return null
            if (!DescriptorVerifier.SHA256_HEX.matches(artifactId) || artifactId != sha256 || bytes < 1) return null
            return ArtifactRef(artifactId, version, bytes, sha256, activatedAt)
        }
    }
}

sealed class PointerRead {
    class Valid(val pointer: ActivePointer) : PointerRead()
    object Missing : PointerRead()
    object Corrupt : PointerRead()
}

class ActivePointerStore(private val layout: StorageLayout, private val durable: DurableFiles) {

    fun read(): PointerRead {
        val file: File = layout.activePointer
        if (!file.exists()) return PointerRead.Missing
        val bytes = try {
            if (file.length() > MAX_POINTER_BYTES) return PointerRead.Corrupt
            file.readBytes()
        } catch (e: IOException) {
            return PointerRead.Corrupt
        }
        val pointer = ActivePointer.parse(bytes) ?: return PointerRead.Corrupt
        return PointerRead.Valid(pointer)
    }

    /** Atomic durable replacement; checkpoints are named `pointer.*` for crash injection (T10). */
    @Throws(IOException::class)
    fun write(pointer: ActivePointer) {
        layout.root.mkdirs()
        durable.replace(
            layout.activePointer,
            layout.activePointerTmp,
            pointer.toJson().toByteArray(Charsets.UTF_8),
            "pointer",
        )
    }

    @Throws(IOException::class)
    fun delete() {
        durable.deleteDurably(layout.activePointer)
    }

    /** Recovery never promotes a leftover temporary pointer (contract §6.4). */
    fun discardTemporary() {
        layout.activePointerTmp.delete()
        layout.pendingMarkerTmp.delete()
    }

    companion object {
        const val MAX_POINTER_BYTES = 16 * 1024L
    }
}

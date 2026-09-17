package org.namuai.offline.core.transfer

/** DL-015 transfer phases; wire names are the contract strings. */
enum class Phase(val wire: String) {
    ABSENT("absent"),
    WAITING("waiting"),
    DOWNLOADING("downloading"),
    PAUSED("paused"),
    VERIFYING("verifying"),
    STAGED("staged"),
    SELF_TESTING("selfTesting"),
    INSTALLED("installed"),
    FAILED("failed"),
    REMOVING("removing");

    companion object {
        fun fromWire(value: String): Phase = values().firstOrNull { it.wire == value } ?: FAILED
    }
}

/** One row of `transfers` (DL-002, contract §5). Never contains chat data. */
data class TransferRecord(
    val transferId: String,
    val descriptorSource: String,
    val descriptorBytes: ByteArray,
    val descriptorHash: String,
    val artifactVersion: String,
    val artifactSha256: String,
    val artifactPath: String,
    val phase: Phase,
    val expectedBytes: Long,
    val committedBytes: Long = 0,
    val verifiedBytes: Long = 0,
    val etag: String? = null,
    val stagedFilename: String? = null,
    val osTaskId: String? = null,
    val meteredConsent: Boolean = false,
    val userPaused: Boolean = false,
    val restartedFromZero: Boolean = false,
    val retryCount: Int = 0,
    val nextRetryAt: Long? = null,
    val lastError: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
)

object MetaKeys {
    const val HIGHEST_SEQUENCE = "highest_sequence"
    const val HIGHEST_SEQUENCE_PAYLOAD_SHA256 = "highest_sequence_payload_sha256"
    const val ACTIVE_MIRROR = "active_mirror"
    const val UPDATE_DESCRIPTOR = "update_descriptor"
    const val JOURNAL_SCHEMA = "journal_schema"
}

/**
 * Native transfer journal (ARC-003, DL-002): authoritative for transfer
 * progress, owned only by the transfer service. Every method is atomic and
 * durable before it returns.
 */
interface Journal {
    /** @return false when a transfer for the same artifact already exists (one per artifact, DL-001). */
    fun insert(record: TransferRecord): Boolean
    fun get(transferId: String): TransferRecord?
    fun findByArtifact(artifactSha256: String): TransferRecord?
    fun all(): List<TransferRecord>

    /** Atomic read-modify-write; `updated_at` is set to [nowMs]. Null when the row is gone. */
    fun update(transferId: String, nowMs: Long, mutate: (TransferRecord) -> TransferRecord): TransferRecord?
    fun delete(transferId: String)

    fun getMeta(key: String): String?
    fun putMeta(key: String, value: String)
    fun deleteMeta(key: String)

    fun addBadDigest(sha256: String, reason: String, nowMs: Long)
    fun isBadDigest(sha256: String): Boolean
    fun badDigests(): Set<String>

    /** SEC-006: removes every row and, where the backing store allows, the files themselves. */
    fun destroyAll()
}

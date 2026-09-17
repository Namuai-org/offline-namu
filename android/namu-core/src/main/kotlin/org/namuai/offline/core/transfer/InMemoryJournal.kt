package org.namuai.offline.core.transfer

/** Test/double implementation of [Journal]; also documents the expected semantics. */
class InMemoryJournal : Journal {
    private val lock = Any()
    private val rows = LinkedHashMap<String, TransferRecord>()
    private val meta = HashMap<String, String>()
    private val bad = LinkedHashMap<String, String>()

    override fun insert(record: TransferRecord): Boolean = synchronized(lock) {
        if (rows.containsKey(record.transferId)) return false
        if (rows.values.any { it.artifactSha256 == record.artifactSha256 }) return false
        rows[record.transferId] = record
        true
    }

    override fun get(transferId: String): TransferRecord? = synchronized(lock) { rows[transferId] }

    override fun findByArtifact(artifactSha256: String): TransferRecord? =
        synchronized(lock) { rows.values.firstOrNull { it.artifactSha256 == artifactSha256 } }

    override fun all(): List<TransferRecord> = synchronized(lock) { rows.values.sortedBy { it.createdAt } }

    override fun update(
        transferId: String,
        nowMs: Long,
        mutate: (TransferRecord) -> TransferRecord,
    ): TransferRecord? = synchronized(lock) {
        val current = rows[transferId] ?: return null
        val next = mutate(current).copy(transferId = current.transferId, updatedAt = nowMs)
        rows[transferId] = next
        next
    }

    override fun delete(transferId: String): Unit = synchronized(lock) { rows.remove(transferId) }

    override fun getMeta(key: String): String? = synchronized(lock) { meta[key] }
    override fun putMeta(key: String, value: String): Unit = synchronized(lock) { meta[key] = value }
    override fun deleteMeta(key: String): Unit = synchronized(lock) { meta.remove(key) }

    override fun addBadDigest(sha256: String, reason: String, nowMs: Long): Unit =
        synchronized(lock) { bad.putIfAbsent(sha256, reason) }

    override fun isBadDigest(sha256: String): Boolean = synchronized(lock) { bad.containsKey(sha256) }
    override fun badDigests(): Set<String> = synchronized(lock) { bad.keys.toSet() }

    override fun destroyAll(): Unit = synchronized(lock) {
        rows.clear()
        meta.clear()
        bad.clear()
    }
}

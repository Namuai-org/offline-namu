package org.namuai.offline.core.transfer

/**
 * Smallest possible SQL seam so the journal logic and SQL text are verified on
 * a plain JVM (sqlite-jdbc in tests) and reused unchanged on Android
 * (android.database.sqlite). Implementations MUST open the database in WAL
 * mode with `synchronous=FULL` (contract §5) and serialize access.
 */
interface SqlDriver {
    /** Bind types: String, Long, ByteArray, null. */
    fun execute(sql: String, args: List<Any?> = emptyList())

    /** Rows of column values typed Long, String, ByteArray or null. */
    fun query(sql: String, args: List<String> = emptyList()): List<List<Any?>>

    /** BEGIN IMMEDIATE … COMMIT, or ROLLBACK when [block] throws. Not re-entrant. */
    fun <T> transaction(block: () -> T): T

    /** Closes the database, deletes its files (db, -wal, -shm) and reopens it empty (SEC-006). */
    fun recreate()
}

/** [Journal] over SQLite with exactly the schema of native-contract §5. */
class SqlJournal(private val driver: SqlDriver) : Journal {

    init {
        createSchema()
    }

    private fun createSchema() {
        driver.transaction {
            for (statement in SCHEMA) driver.execute(statement)
            driver.execute(
                "INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)",
                listOf(MetaKeys.JOURNAL_SCHEMA, JOURNAL_SCHEMA_VERSION),
            )
        }
    }

    override fun insert(record: TransferRecord): Boolean = driver.transaction {
        val clash = driver.query(
            "SELECT transfer_id FROM transfers WHERE transfer_id = ? OR artifact_sha256 = ?",
            listOf(record.transferId, record.artifactSha256),
        )
        if (clash.isNotEmpty()) {
            false
        } else {
            driver.execute(
                "INSERT INTO transfers ($COLUMNS) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)",
                listOf(
                    record.transferId, record.descriptorSource, record.descriptorBytes,
                    record.descriptorHash, record.artifactVersion, record.artifactSha256,
                    record.artifactPath, record.phase.wire, record.expectedBytes,
                    record.committedBytes, record.verifiedBytes, record.etag,
                    record.stagedFilename, record.osTaskId,
                    flag(record.meteredConsent), flag(record.userPaused), flag(record.restartedFromZero),
                    record.retryCount.toLong(), record.nextRetryAt, record.lastError,
                    record.createdAt, record.updatedAt,
                ),
            )
            true
        }
    }

    override fun get(transferId: String): TransferRecord? =
        driver.query("SELECT $COLUMNS FROM transfers WHERE transfer_id = ?", listOf(transferId))
            .firstOrNull()?.let(::toRecord)

    override fun findByArtifact(artifactSha256: String): TransferRecord? =
        driver.query("SELECT $COLUMNS FROM transfers WHERE artifact_sha256 = ?", listOf(artifactSha256))
            .firstOrNull()?.let(::toRecord)

    override fun all(): List<TransferRecord> =
        driver.query("SELECT $COLUMNS FROM transfers ORDER BY created_at ASC, transfer_id ASC").map(::toRecord)

    override fun update(
        transferId: String,
        nowMs: Long,
        mutate: (TransferRecord) -> TransferRecord,
    ): TransferRecord? = driver.transaction {
        val current = driver.query("SELECT $COLUMNS FROM transfers WHERE transfer_id = ?", listOf(transferId))
            .firstOrNull()?.let(::toRecord)
        if (current == null) {
            null
        } else {
            val next = mutate(current).copy(transferId = current.transferId, updatedAt = nowMs)
            driver.execute(
                "UPDATE transfers SET descriptor_source=?, descriptor_bytes=?, descriptor_hash=?, " +
                    "artifact_version=?, artifact_path=?, phase=?, expected_bytes=?, committed_bytes=?, " +
                    "verified_bytes=?, etag=?, staged_filename=?, os_task_id=?, metered_consent=?, " +
                    "user_paused=?, restarted_from_zero=?, retry_count=?, next_retry_at=?, last_error=?, " +
                    "updated_at=? WHERE transfer_id=?",
                listOf(
                    next.descriptorSource, next.descriptorBytes, next.descriptorHash,
                    next.artifactVersion, next.artifactPath, next.phase.wire, next.expectedBytes,
                    next.committedBytes, next.verifiedBytes, next.etag, next.stagedFilename,
                    next.osTaskId, flag(next.meteredConsent), flag(next.userPaused),
                    flag(next.restartedFromZero), next.retryCount.toLong(), next.nextRetryAt,
                    next.lastError, next.updatedAt, next.transferId,
                ),
            )
            next
        }
    }

    override fun delete(transferId: String) {
        driver.transaction { driver.execute("DELETE FROM transfers WHERE transfer_id = ?", listOf(transferId)) }
    }

    override fun getMeta(key: String): String? =
        driver.query("SELECT value FROM meta WHERE key = ?", listOf(key)).firstOrNull()?.get(0) as String?

    override fun putMeta(key: String, value: String) {
        driver.transaction {
            driver.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", listOf(key, value))
        }
    }

    override fun deleteMeta(key: String) {
        driver.transaction { driver.execute("DELETE FROM meta WHERE key = ?", listOf(key)) }
    }

    override fun addBadDigest(sha256: String, reason: String, nowMs: Long) {
        driver.transaction {
            driver.execute(
                "INSERT OR IGNORE INTO bad_digests(sha256, reason, marked_at) VALUES (?, ?, ?)",
                listOf(sha256, reason, nowMs),
            )
        }
    }

    override fun isBadDigest(sha256: String): Boolean =
        driver.query("SELECT sha256 FROM bad_digests WHERE sha256 = ?", listOf(sha256)).isNotEmpty()

    override fun badDigests(): Set<String> =
        driver.query("SELECT sha256 FROM bad_digests").map { it[0] as String }.toSet()

    override fun destroyAll() {
        driver.recreate()
        createSchema()
    }

    private fun flag(value: Boolean): Long = if (value) 1L else 0L

    private fun toRecord(row: List<Any?>): TransferRecord = TransferRecord(
        transferId = row[0] as String,
        descriptorSource = row[1] as String,
        descriptorBytes = row[2] as ByteArray,
        descriptorHash = row[3] as String,
        artifactVersion = row[4] as String,
        artifactSha256 = row[5] as String,
        artifactPath = row[6] as String,
        phase = Phase.fromWire(row[7] as String),
        expectedBytes = row[8] as Long,
        committedBytes = row[9] as Long,
        verifiedBytes = row[10] as Long,
        etag = row[11] as String?,
        stagedFilename = row[12] as String?,
        osTaskId = row[13] as String?,
        // row[14] = resume_data (iOS only; always NULL on Android)
        meteredConsent = (row[15] as Long) != 0L,
        userPaused = (row[16] as Long) != 0L,
        restartedFromZero = (row[17] as Long) != 0L,
        retryCount = (row[18] as Long).toInt(),
        nextRetryAt = row[19] as Long?,
        lastError = row[20] as String?,
        createdAt = row[21] as Long,
        updatedAt = row[22] as Long,
    )

    companion object {
        const val JOURNAL_SCHEMA_VERSION = "1"
        const val DATABASE_FILE_NAME = "transfer-journal.sqlite"

        private const val COLUMNS =
            "transfer_id, descriptor_source, descriptor_bytes, descriptor_hash, artifact_version, " +
                "artifact_sha256, artifact_path, phase, expected_bytes, committed_bytes, verified_bytes, " +
                "etag, staged_filename, os_task_id, resume_data, metered_consent, user_paused, " +
                "restarted_from_zero, retry_count, next_retry_at, last_error, created_at, updated_at"

        /** Verbatim from docs/engineering/native-contract.md §5 (plus IF NOT EXISTS). */
        val SCHEMA: List<String> = listOf(
            """
            CREATE TABLE IF NOT EXISTS transfers (
              transfer_id TEXT PRIMARY KEY,
              descriptor_source TEXT NOT NULL,
              descriptor_bytes BLOB NOT NULL,
              descriptor_hash TEXT NOT NULL,
              artifact_version TEXT NOT NULL,
              artifact_sha256 TEXT NOT NULL UNIQUE,
              artifact_path TEXT NOT NULL,
              phase TEXT NOT NULL,
              expected_bytes INTEGER NOT NULL,
              committed_bytes INTEGER NOT NULL DEFAULT 0,
              verified_bytes INTEGER NOT NULL DEFAULT 0,
              etag TEXT,
              staged_filename TEXT,
              os_task_id TEXT,
              resume_data BLOB,
              metered_consent INTEGER NOT NULL DEFAULT 0,
              user_paused INTEGER NOT NULL DEFAULT 0,
              restarted_from_zero INTEGER NOT NULL DEFAULT 0,
              retry_count INTEGER NOT NULL DEFAULT 0,
              next_retry_at INTEGER,
              last_error TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """.trimIndent(),
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS bad_digests (sha256 TEXT PRIMARY KEY, reason TEXT NOT NULL, marked_at INTEGER NOT NULL)",
        )
    }
}

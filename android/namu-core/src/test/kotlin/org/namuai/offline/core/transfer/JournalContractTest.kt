package org.namuai.offline.core.transfer

import org.junit.jupiter.api.io.TempDir
import org.namuai.offline.core.testing.JdbcSqlDriver
import java.io.File
import java.sql.SQLException
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Behaviour every [Journal] must have (DL-002); run against both implementations. */
abstract class JournalContract {
    abstract fun journal(): Journal

    protected fun record(id: String, sha: String, createdAt: Long = 10) = TransferRecord(
        transferId = id,
        descriptorSource = "bundled",
        descriptorBytes = byteArrayOf(1, 2, 3, 0, -1),
        descriptorHash = "h".repeat(64),
        artifactVersion = "v1",
        artifactSha256 = sha,
        artifactPath = "models/x/model.gguf",
        phase = Phase.WAITING,
        expectedBytes = 2_143_977_056L,
        stagedFilename = "$id.part",
        createdAt = createdAt,
        updatedAt = createdAt,
    )

    @Test
    fun insertGetAndOneTransferPerArtifact() {
        val j = journal()
        assertTrue(j.insert(record("t1", "a".repeat(64))))
        assertFalse(j.insert(record("t2", "a".repeat(64))), "one transfer per artifact")
        assertFalse(j.insert(record("t1", "b".repeat(64))), "transfer IDs are unique")
        assertTrue(j.insert(record("t3", "c".repeat(64), createdAt = 20)))
        val row = j.get("t1")!!
        assertContentEquals(byteArrayOf(1, 2, 3, 0, -1), row.descriptorBytes)
        assertEquals(2_143_977_056L, row.expectedBytes)
        assertEquals(Phase.WAITING, row.phase)
        assertNull(row.etag)
        assertNull(row.nextRetryAt)
        assertEquals("t3", j.findByArtifact("c".repeat(64))!!.transferId)
        assertNull(j.findByArtifact("d".repeat(64)))
        assertEquals(listOf("t1", "t3"), j.all().map { it.transferId })
    }

    @Test
    fun updateIsReadModifyWriteOverEveryMutableColumn() {
        val j = journal()
        j.insert(record("t1", "a".repeat(64)))
        val next = j.update("t1", 99) {
            it.copy(
                phase = Phase.DOWNLOADING, committedBytes = 4_194_304, verifiedBytes = 7, etag = "\"e\"",
                osTaskId = "7301", meteredConsent = true, userPaused = true, restartedFromZero = true,
                retryCount = 3, nextRetryAt = 12345, lastError = "TRANSFER_RETRY",
                transferId = "hijack", // identity can never be changed by an update
            )
        }!!
        assertEquals("t1", next.transferId)
        val row = j.get("t1")!!
        assertEquals(Phase.DOWNLOADING, row.phase)
        assertEquals(4_194_304, row.committedBytes)
        assertEquals(7, row.verifiedBytes)
        assertEquals("\"e\"", row.etag)
        assertEquals("7301", row.osTaskId)
        assertTrue(row.meteredConsent && row.userPaused && row.restartedFromZero)
        assertEquals(3, row.retryCount)
        assertEquals(12345L, row.nextRetryAt)
        assertEquals("TRANSFER_RETRY", row.lastError)
        assertEquals(99, row.updatedAt)
        assertEquals(10, row.createdAt)
        val cleared = j.update("t1", 100) { it.copy(etag = null, nextRetryAt = null, lastError = null) }!!
        assertNull(cleared.etag)
        assertNull(j.get("t1")!!.nextRetryAt)
        assertNull(j.update("missing", 1) { it })
        j.delete("t1")
        assertNull(j.get("t1"))
    }

    @Test
    fun metaAndBadDigests() {
        val j = journal()
        assertNull(j.getMeta(MetaKeys.HIGHEST_SEQUENCE))
        j.putMeta(MetaKeys.HIGHEST_SEQUENCE, "6")
        j.putMeta(MetaKeys.HIGHEST_SEQUENCE, "7")
        assertEquals("7", j.getMeta(MetaKeys.HIGHEST_SEQUENCE))
        j.deleteMeta(MetaKeys.HIGHEST_SEQUENCE)
        assertNull(j.getMeta(MetaKeys.HIGHEST_SEQUENCE))

        assertFalse(j.isBadDigest("a".repeat(64)))
        j.addBadDigest("a".repeat(64), "MODEL_LOAD_FAILED", 5)
        j.addBadDigest("a".repeat(64), "again", 6)
        assertTrue(j.isBadDigest("a".repeat(64)))
        assertEquals(setOf("a".repeat(64)), j.badDigests())
    }

    @Test
    fun destroyAllRemovesEverything() {
        val j = journal()
        j.insert(record("t1", "a".repeat(64)))
        j.putMeta(MetaKeys.UPDATE_DESCRIPTOR, "x")
        j.addBadDigest("b".repeat(64), "r", 1)
        j.destroyAll()
        assertTrue(j.all().isEmpty())
        assertNull(j.getMeta(MetaKeys.UPDATE_DESCRIPTOR))
        assertTrue(j.badDigests().isEmpty())
        assertTrue(j.insert(record("t1", "a".repeat(64))), "usable again after a wipe")
    }
}

class InMemoryJournalTest : JournalContract() {
    override fun journal(): Journal = InMemoryJournal()
}

/**
 * Runs the contract against a real SQLite through sqlite-jdbc (TEST-ONLY
 * dependency), using the very SQL text the Android SqliteJournal executes.
 */
class SqlJournalTest : JournalContract() {
    @TempDir
    lateinit var dir: File
    private val drivers = ArrayList<JdbcSqlDriver>()

    private fun dbFile() = File(File(dir, "journal").apply { mkdirs() }, SqlJournal.DATABASE_FILE_NAME)
    private fun driver() = JdbcSqlDriver(dbFile()).also(drivers::add)
    override fun journal(): Journal = SqlJournal(driver())

    @org.junit.jupiter.api.AfterEach
    fun close() = drivers.forEach { it.close() }

    @Test
    fun usesWalAndSynchronousFull() {
        val d = driver()
        SqlJournal(d)
        assertEquals("wal", (d.query("PRAGMA journal_mode")[0][0] as String).lowercase())
        assertEquals(2L, d.query("PRAGMA synchronous")[0][0], "2 = FULL")
    }

    @Test
    fun schemaMatchesTheContract() {
        val d = driver()
        SqlJournal(d)
        val columns = d.query("PRAGMA table_info(transfers)").map { it[1] as String }
        assertEquals(
            listOf(
                "transfer_id", "descriptor_source", "descriptor_bytes", "descriptor_hash", "artifact_version",
                "artifact_sha256", "artifact_path", "phase", "expected_bytes", "committed_bytes", "verified_bytes",
                "etag", "staged_filename", "os_task_id", "resume_data", "metered_consent", "user_paused",
                "restarted_from_zero", "retry_count", "next_retry_at", "last_error", "created_at", "updated_at",
            ),
            columns,
        )
        assertEquals(listOf("key", "value"), d.query("PRAGMA table_info(meta)").map { it[1] })
        assertEquals(listOf("sha256", "reason", "marked_at"), d.query("PRAGMA table_info(bad_digests)").map { it[1] })
        assertEquals("1", SqlJournal(d).getMeta(MetaKeys.JOURNAL_SCHEMA))
    }

    @Test
    fun uniqueArtifactIsEnforcedBySqliteItself() {
        val d = driver()
        val j = SqlJournal(d)
        j.insert(record("t1", "a".repeat(64)))
        assertFailsWith<SQLException> {
            d.execute(
                "INSERT INTO transfers (transfer_id, descriptor_source, descriptor_bytes, descriptor_hash, " +
                    "artifact_version, artifact_sha256, artifact_path, phase, expected_bytes, created_at, updated_at) " +
                    "VALUES ('t9','bundled',x'00','h','v',?, 'p','waiting',1,1,1)",
                listOf("a".repeat(64)),
            )
        }
    }

    @Test
    fun rowsSurviveReopenAndAFailedTransactionRollsBack() {
        val first = driver()
        val j = SqlJournal(first)
        j.insert(record("t1", "a".repeat(64)))
        j.update("t1", 5) { it.copy(committedBytes = 8_388_608) }
        assertFailsWith<IllegalStateException> {
            j.update("t1", 6) { throw IllegalStateException("boom") }
        }
        first.close()
        drivers.remove(first)

        val reopened = SqlJournal(driver())
        val row = assertNotNull(reopened.get("t1"))
        assertEquals(8_388_608, row.committedBytes)
        assertEquals(5, row.updatedAt, "the failed update left no trace")
    }

    @Test
    fun destroyAllDeletesTheDatabaseFiles() {
        val d = driver()
        val j = SqlJournal(d)
        j.insert(record("t1", "a".repeat(64)))
        assertTrue(dbFile().exists())
        val before = dbFile().length()
        j.destroyAll()
        assertTrue(dbFile().exists(), "reopened empty")
        assertTrue(j.all().isEmpty())
        assertTrue(before > 0)
    }
}

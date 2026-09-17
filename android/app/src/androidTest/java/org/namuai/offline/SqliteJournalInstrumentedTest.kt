package org.namuai.offline

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.namuai.offline.core.transfer.MetaKeys
import org.namuai.offline.core.transfer.Phase
import org.namuai.offline.core.transfer.SqlJournal
import org.namuai.offline.core.transfer.TransferRecord
import org.namuai.offline.transfer.AndroidSqlDriver
import java.io.File

/**
 * NOT RUN in this repository's bootstrap environment (no Android SDK / device).
 * Device-side twin of namu-core's SqlJournalTest: the same SqlJournal over
 * android.database.sqlite (contract §5, DL-002).
 *
 *   ./gradlew :app:connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class SqliteJournalInstrumentedTest {
    private lateinit var file: File
    private lateinit var driver: AndroidSqlDriver

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.noBackupFilesDir, "journal-test-${System.nanoTime()}")
        file = File(dir, SqlJournal.DATABASE_FILE_NAME)
        driver = AndroidSqlDriver(file)
    }

    @After
    fun tearDown() {
        file.parentFile?.deleteRecursively()
    }

    private fun record(id: String, sha: String) = TransferRecord(
        transferId = id,
        descriptorSource = "bundled",
        descriptorBytes = byteArrayOf(1, 2, 3, 0, -1),
        descriptorHash = "h".repeat(64),
        artifactVersion = "v1",
        artifactSha256 = sha,
        artifactPath = "models/x/model.gguf",
        phase = Phase.WAITING,
        expectedBytes = 2_143_977_056L,
        createdAt = 10,
        updatedAt = 10,
    )

    @Test
    fun walWithSynchronousFull() {
        SqlJournal(driver)
        assertEquals("wal", (driver.query("PRAGMA journal_mode")[0][0] as String).lowercase())
        assertEquals(2L, driver.query("PRAGMA synchronous")[0][0])
    }

    @Test
    fun rowsSurviveReopenAndOneTransferPerArtifact() {
        val journal = SqlJournal(driver)
        assertTrue(journal.insert(record("t1", "a".repeat(64))))
        assertFalse(journal.insert(record("t2", "a".repeat(64))))
        journal.update("t1", 20) { it.copy(committedBytes = 4_194_304, etag = "\"e\"", phase = Phase.DOWNLOADING) }
        journal.putMeta(MetaKeys.HIGHEST_SEQUENCE, "6")

        val reopened = SqlJournal(AndroidSqlDriver(file))
        val row = reopened.get("t1")
        assertNotNull(row)
        assertEquals(4_194_304L, row!!.committedBytes)
        assertEquals(Phase.DOWNLOADING, row.phase)
        assertArrayEquals(byteArrayOf(1, 2, 3, 0, -1), row.descriptorBytes)
        assertEquals("6", reopened.getMeta(MetaKeys.HIGHEST_SEQUENCE))
    }

    @Test
    fun failedUpdateRollsBackAndDestroyAllRemovesEverything() {
        val journal = SqlJournal(driver)
        journal.insert(record("t1", "a".repeat(64)))
        try {
            journal.update("t1", 30) { throw IllegalStateException("boom") }
        } catch (expected: IllegalStateException) {
            // rolled back
        }
        assertEquals(10L, journal.get("t1")!!.updatedAt)
        journal.destroyAll()
        assertNull(journal.get("t1"))
        assertTrue(journal.all().isEmpty())
    }
}

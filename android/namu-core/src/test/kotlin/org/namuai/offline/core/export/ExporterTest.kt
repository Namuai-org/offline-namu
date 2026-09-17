package org.namuai.offline.core.export

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.io.TempDir
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.integer
import org.namuai.offline.core.json.string
import org.namuai.offline.core.testing.FakeClock
import org.namuai.offline.core.testing.FakeSpace
import java.io.File
import java.sql.Connection
import java.sql.DriverManager
import java.util.zip.ZipFile
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** SEC-004 / SEC-005 / T23 against a real SQLite file with the PRD §12 chat schema. */
class ExporterTest {
    @TempDir
    lateinit var dir: File
    private lateinit var dbFile: File
    private lateinit var writer: Connection
    private lateinit var exports: File
    private val clock = FakeClock()
    private val space = FakeSpace()
    private val hooked = 0x199.toChar() // Hausa hooked k
    private val opened = ArrayList<JdbcReadOnlyDb>()

    private val labels = ExportLabels.parse(
        """{"created":"Created","updated":"Updated","responseLanguage":"Response language",
           "languageNames":{"auto":"Same as my message","ha":"Hausa","fr":"Français","en":"English"},
           "you":"You","namu":"Namu","interrupted":"Answer interrupted","lengthLimited":"Length limit reached",
           "untitled":"Untitled"}""",
    )!!

    /** TEST-ONLY read connection; [onQuery] lets a test commit from another connection mid-export. */
    private inner class JdbcReadOnlyDb(override val supportsReadTransaction: Boolean) : ReadOnlyDb {
        private val c = DriverManager.getConnection("jdbc:sqlite:${dbFile.absolutePath}")
        var turnQueries = 0
        var onTurnQuery: ((Int) -> Unit)? = null

        override fun beginRead() { c.createStatement().use { it.execute("BEGIN") } }
        override fun endRead() { c.createStatement().use { it.execute("COMMIT") } }
        override fun query(sql: String, args: List<String>): List<List<Any?>> {
            val rows = c.prepareStatement(sql).use { st ->
                args.forEachIndexed { i, a -> st.setString(i + 1, a) }
                st.executeQuery().use { rs ->
                    val n = rs.metaData.columnCount
                    val out = ArrayList<List<Any?>>()
                    while (rs.next()) out.add((1..n).map { i -> rs.getObject(i).let { v -> if (v is Int) v.toLong() else v } })
                    out
                }
            }
            if (sql.contains("FROM turns")) {
                turnQueries++
                onTurnQuery?.invoke(turnQueries)
            }
            return rows
        }
        override fun close() = c.close()
    }

    private fun open(readTransaction: Boolean = true) = JdbcReadOnlyDb(readTransaction).also(opened::add)
    private fun exporter() = Exporter(ExportStore(exports, clock), space, clock, "1.0.0")

    @BeforeEach
    fun createChatDatabase() {
        dbFile = File(dir, Exporter.CHAT_DB_FILE_NAME)
        exports = File(dir, "namu-exports")
        writer = DriverManager.getConnection("jdbc:sqlite:${dbFile.absolutePath}")
        writer.createStatement().use { st ->
            st.execute("PRAGMA journal_mode=WAL")
            st.execute(
                "CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, title_is_custom INTEGER NOT NULL DEFAULT 0, " +
                    "response_language TEXT NOT NULL DEFAULT 'auto', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            )
            st.execute(
                "CREATE TABLE turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, " +
                    "ordinal INTEGER NOT NULL, user_text TEXT NOT NULL, selected_attempt_id TEXT, created_at INTEGER NOT NULL, " +
                    "UNIQUE(conversation_id, ordinal))",
            )
            st.execute(
                "CREATE TABLE assistant_attempts (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, " +
                    "attempt_number INTEGER NOT NULL, content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, finish_reason TEXT, " +
                    "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(turn_id, attempt_number))",
            )
        }
        conversation("c1", "Ina ${hooked}wana? / notes: v1", "ha", 1_789_646_400_000, 1_789_650_000_000)
        turn("c1", 1, "Sannu", "Barka da zuwa", "complete", "eos", rejected = "old rejected attempt")
        turn("c1", 2, "Tell me more", "Partial ans", "interrupted", null)
        turn("c1", 3, "Long one", "Very long", "complete", "length")
        turn("c1", 4, "No answer yet", null, null, null)
        conversation("c2", "", "auto", 1_789_646_500_000, 1_789_646_500_000)
        turn("c2", 1, "Bonjour", "Salut", "stopped", null)
    }

    @AfterEach
    fun closeAll() {
        opened.forEach { it.close() }
        writer.close()
    }

    private fun conversation(id: String, title: String, language: String, created: Long, updated: Long) {
        writer.prepareStatement("INSERT INTO conversations(id,title,response_language,created_at,updated_at) VALUES (?,?,?,?,?)").use {
            it.setString(1, id); it.setString(2, title); it.setString(3, language); it.setLong(4, created); it.setLong(5, updated)
            it.execute()
        }
    }

    private fun turn(conversation: String, ordinal: Int, user: String, answer: String?, status: String?, finish: String?, rejected: String? = null) {
        val turnId = "$conversation-t$ordinal"
        val selected = answer?.let { "$turnId-a2" }
        writer.prepareStatement("INSERT INTO turns(id,conversation_id,ordinal,user_text,selected_attempt_id,created_at) VALUES (?,?,?,?,?,1)").use {
            it.setString(1, turnId); it.setString(2, conversation); it.setInt(3, ordinal); it.setString(4, user); it.setString(5, selected)
            it.execute()
        }
        fun attempt(id: String, number: Int, content: String, st: String, fin: String?) =
            writer.prepareStatement("INSERT INTO assistant_attempts(id,turn_id,attempt_number,content,status,finish_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,1,1)").use {
                it.setString(1, id); it.setString(2, turnId); it.setInt(3, number); it.setString(4, content); it.setString(5, st); it.setString(6, fin)
                it.execute()
            }
        if (rejected != null) attempt("$turnId-a1", 1, rejected, "complete", "eos")
        if (answer != null) attempt(selected!!, 2, answer, status!!, finish)
    }

    @Test
    fun singleConversationMatchesTheContractFormat() {
        val store = ExportStore(exports, clock)
        val id = exporter().exportConversation(open(), dbFile, "c1", labels)
        val file = assertNotNull(store.fileOf(id))
        assertEquals("Ina ${hooked}wana_ _ notes_ v1.txt", file.name)
        val bytes = file.readBytes()
        assertFalse(bytes[0] == 0xEF.toByte(), "no BOM")
        val expected = """
            Ina ${hooked}wana? / notes: v1
            Created: 2026-09-17T12:00:00Z
            Updated: 2026-09-17T13:00:00Z
            Response language: Hausa

            You:
            Sannu

            Namu:
            Barka da zuwa

            You:
            Tell me more

            Namu:
            Partial ans
            [Answer interrupted]

            You:
            Long one

            Namu:
            Very long
            [Length limit reached]

            You:
            No answer yet

        """.trimIndent()
        assertEquals(expected, String(bytes, Charsets.UTF_8))
        assertFalse(String(bytes).contains("old rejected attempt"), "only the selected attempt is exported")
        assertFalse(String(bytes).contains("\r"))
    }

    @Test
    fun allConversationsZipHasTextFilesAndIndex() {
        val id = exporter().exportAll(open(), dbFile, labels)
        val file = ExportStore(exports, clock).fileOf(id)!!
        assertTrue(Regex("namu-export-\\d{8}-\\d{6}\\.zip").matches(file.name), file.name)
        ZipFile(file).use { zip ->
            val names = zip.entries().toList().map { it.name }
            assertEquals(listOf("conversations/1-Ina ${hooked}wana_ _ notes_ v1.txt", "conversations/2-Untitled.txt", "index.json"), names)
            val second = zip.getInputStream(zip.getEntry(names[1])).readBytes().toString(Charsets.UTF_8)
            assertTrue(second.startsWith("Untitled\nCreated: "))
            assertTrue(second.contains("Response language: Same as my message\n"))
            assertTrue(second.endsWith("Namu:\nSalut\n[Answer interrupted]\n"))
            val index = StrictJson.parseUtf8(zip.getInputStream(zip.getEntry("index.json")).readBytes()) as JsonValue.Obj
            assertEquals(1L, index.integer("export_schema"))
            assertEquals("1.0.0", index.string("app_version"))
            val list = (index.members["conversations"] as JsonValue.Arr).items.map { it as JsonValue.Obj }
            assertEquals(listOf("c1", "c2"), list.map { it.string("id") })
            assertEquals(4L, list[0].integer("turns"))
            assertEquals(names[0], list[0].string("file"))
            assertEquals("2026-09-17T12:00:00Z", list[0].string("created_at"))
        }
    }

    @Test
    fun turnsStreamInPagesOfTwoHundred() {
        conversation("big", "Big", "en", 1, 2)
        writer.autoCommit = false
        for (i in 1..450) turn("big", i, "q$i", "a$i", "complete", "eos")
        writer.commit()
        writer.autoCommit = true
        val db = open()
        val id = exporter().exportConversation(db, dbFile, "big", labels)
        assertEquals(3, db.turnQueries, "450 turns = pages of 200 + 200 + 50")
        val text = ExportStore(exports, clock).fileOf(id)!!.readText()
        assertEquals(450, Regex("^You:$", RegexOption.MULTILINE).findAll(text).count())
        assertTrue(text.indexOf("q199\n") < text.indexOf("q200\n") && text.indexOf("q200\n") < text.indexOf("q201\n"))
    }

    @Test
    fun oneReadTransactionIsAConsistentSnapshot() {
        conversation("big", "Big", "en", 1, 2)
        for (i in 1..250) turn("big", i, "q$i", "a$i", "complete", "eos")
        val db = open(readTransaction = true)
        db.onTurnQuery = { n -> if (n == 1) turn("big", 251, "LATE", "LATE", "complete", "eos") } // commit mid-export
        val id = exporter().exportConversation(db, dbFile, "big", labels)
        val text = ExportStore(exports, clock).fileOf(id)!!.readText()
        assertFalse(text.contains("LATE"), "a commit during the export is invisible to the snapshot")
        assertEquals(250, Regex("^You:$", RegexOption.MULTILINE).findAll(text).count())
    }

    @Test
    fun withoutReadTransactionsAChangedDatabaseRestartsTheExport() {
        conversation("big", "Big", "en", 1, 2)
        for (i in 1..250) turn("big", i, "q$i", "a$i", "complete", "eos")
        val db = open(readTransaction = false)
        db.onTurnQuery = { n -> if (n == 1) turn("big", 251, "LATE", "LATE", "complete", "eos") }
        val id = exporter().exportConversation(db, dbFile, "big", labels)
        val text = ExportStore(exports, clock).fileOf(id)!!.readText()
        assertEquals(251, Regex("^You:$", RegexOption.MULTILINE).findAll(text).count(), "the repeated export is consistent")
        assertEquals(1, exports.listFiles()!!.size, "the inconsistent first attempt was removed")

        // A database that never stops changing ends in ENGINE_BUSY with nothing left behind.
        var extra = 300
        db.onTurnQuery = { turn("big", ++extra, "x", "y", "complete", "eos") }
        val e = assertFailsWith<NamuException> { exporter().exportConversation(db, dbFile, "big", labels) }
        assertEquals(ErrorCodes.ENGINE_BUSY, e.code)
        assertEquals(1, exports.listFiles()!!.size)
    }

    @Test
    fun t23_failuresRemoveThePartialExportAndLeaveTheDatabaseUntouched() {
        val before = dbFile.readBytes().size
        space.free = 1024
        assertEquals(ErrorCodes.SPACE_LOW, assertFailsWith<NamuException> { exporter().exportAll(open(), dbFile, labels) }.code)
        space.free = 64L * 1024 * 1024 * 1024
        assertEquals(ErrorCodes.NOT_FOUND, assertFailsWith<NamuException> { exporter().exportConversation(open(), dbFile, "nope", labels) }.code)
        // A read failure in the middle of the export.
        val db = open()
        db.onTurnQuery = { throw IllegalStateException("disk error") }
        assertEquals(ErrorCodes.DATABASE_RECOVERY, assertFailsWith<NamuException> { exporter().exportAll(db, dbFile, labels) }.code)
        assertTrue(exports.listFiles().isNullOrEmpty(), "no partial export is left")
        assertEquals(before, dbFile.readBytes().size)
        assertEquals(2, open().query("SELECT id FROM conversations").size)
    }

    @Test
    fun storeSweepsAfterTwentyFourHoursAndValidatesIds() {
        val store = ExportStore(exports, clock)
        val old = exporter().exportConversation(open(), dbFile, "c1", labels)
        val fresh = exporter().exportConversation(open(), dbFile, "c2", labels)
        File(exports, old).setLastModified(clock.now - ExportStore.MAX_AGE_MS - 1)
        File(exports, fresh).setLastModified(clock.now - ExportStore.MAX_AGE_MS + 60_000)
        assertEquals(1, store.sweep())
        assertNull(store.fileOf(old))
        assertNotNull(store.fileOf(fresh))
        assertNull(store.fileOf("../$fresh"))
        assertNull(store.fileOf("not-an-id"))
        store.delete("../..") // ignored
        assertTrue(exports.exists())
        store.delete(fresh)
        assertNull(store.fileOf(fresh))
        exporter().exportAll(open(), dbFile, labels)
        store.deleteAll()
        assertTrue(exports.listFiles()!!.isEmpty())
    }

    @Test
    fun safeTitleRules() {
        assertEquals("conversation", ExportText.safeTitle(""))
        assertEquals("conversation", ExportText.safeTitle("   "))
        assertEquals("a_b_c", ExportText.safeTitle("a/b\\c"))
        assertEquals("___", ExportText.safeTitle("../"))
        assertEquals("Caf" + 0xe9.toChar() + " 2026_-x", ExportText.safeTitle("Caf" + 0xe9.toChar() + " 2026_-x"))
        assertEquals(60, ExportText.safeTitle("x".repeat(200)).length)
        val emoji = String(Character.toChars(0x1F600))
        val cut = ExportText.safeTitle("y".repeat(59) + "a" + emoji)
        assertEquals(60, cut.length)
        // An astral letter straddling the 60-unit boundary is dropped whole, never split.
        val astralLetter = String(Character.toChars(0x10400))
        val straddle = ExportText.safeTitle("z".repeat(59) + astralLetter)
        assertEquals("z".repeat(59), straddle)
        assertNull(ExportLabels.parse("{\"created\":1}"))
        assertNull(ExportLabels.parse("not json"))
    }
}

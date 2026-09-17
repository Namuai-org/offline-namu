package org.namuai.offline.core.export

import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.core.json.JsonOut
import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.StrictJsonException
import org.namuai.offline.core.json.obj
import org.namuai.offline.core.json.string
import org.namuai.offline.core.store.DurableFiles
import org.namuai.offline.core.store.StorageLayout
import org.namuai.offline.core.transfer.SpaceProbe
import org.namuai.offline.core.transfer.SpaceRule
import org.namuai.offline.core.util.Clock
import java.io.BufferedWriter
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.io.Writer
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Read-only view of namu.sqlite for the exporter (contract §7). The exporter
 * owns this connection; it never writes and never shares the JS connection.
 */
interface ReadOnlyDb : Closeable {
    /** True when [beginRead]/[endRead] give one deferred read transaction (a WAL snapshot). */
    val supportsReadTransaction: Boolean
    fun beginRead()
    fun endRead()

    /** Column values typed Long, String, ByteArray or null. */
    fun query(sql: String, args: List<String> = emptyList()): List<List<Any?>>
}

/** Localized strings supplied by JS so native code carries no string tables (SEC-004). */
class ExportLabels(
    val created: String,
    val updated: String,
    val responseLanguage: String,
    val languageNames: Map<String, String>,
    val you: String,
    val namu: String,
    val interrupted: String,
    val lengthLimited: String,
    val untitled: String,
) {
    companion object {
        fun parse(json: String): ExportLabels? {
            val o = try {
                StrictJson.parse(json) as? JsonValue.Obj ?: return null
            } catch (e: StrictJsonException) {
                return null
            }
            val names = o.obj("languageNames")?.members
                ?.mapNotNull { (k, v) -> (v as? JsonValue.Str)?.let { k to it.value } }?.toMap() ?: return null
            return ExportLabels(
                created = o.string("created") ?: return null,
                updated = o.string("updated") ?: return null,
                responseLanguage = o.string("responseLanguage") ?: return null,
                languageNames = names,
                you = o.string("you") ?: return null,
                namu = o.string("namu") ?: return null,
                interrupted = o.string("interrupted") ?: return null,
                lengthLimited = o.string("lengthLimited") ?: return null,
                untitled = o.string("untitled") ?: "conversation",
            )
        }
    }
}

object ExportText {
    private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC)
    private val STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)

    fun iso(epochMs: Long): String = ISO.format(Instant.ofEpochMilli(epochMs))
    fun stamp(epochMs: Long): String = STAMP.format(Instant.ofEpochMilli(epochMs))

    /**
     * Contract §7: every character outside letters/digits/space/`-_` becomes
     * `_`, trimmed to 60 UTF-16 units, fallback `conversation`. Hausa letters
     * such as ƙ, ɗ, ɓ are letters and are preserved (LOC-002).
     */
    fun safeTitle(title: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < title.length) {
            val cp = title.codePointAt(i)
            val keep = Character.isLetterOrDigit(cp) || cp == ' '.code || cp == '-'.code || cp == '_'.code
            if (keep) sb.appendCodePoint(cp) else sb.append('_')
            i += Character.charCount(cp)
        }
        var cut = sb.toString()
        if (cut.length > 60) {
            var end = 60
            if (Character.isHighSurrogate(cut[end - 1])) end-- // never split a surrogate pair
            cut = cut.substring(0, end)
        }
        cut = cut.trim()
        return if (cut.isEmpty()) "conversation" else cut
    }
}

/** Export directory management: `<exports>/<export-id>/<single file>` (SEC-005). */
class ExportStore(private val exportsDir: File, private val clock: Clock) {

    fun newExportDir(): Pair<String, File> {
        val id = UUID.randomUUID().toString()
        val dir = File(exportsDir, id)
        if (!dir.mkdirs()) throw IOException("export directory unavailable")
        return id to dir
    }

    /** The one file of a finished export, or null. Export IDs are validated app-generated UUIDs. */
    fun fileOf(exportId: String): File? {
        if (!StorageLayout.TRANSFER_ID.matches(exportId)) return null
        val files = File(exportsDir, exportId).listFiles { f -> f.isFile } ?: return null
        return files.singleOrNull()
    }

    fun delete(exportId: String) {
        if (!StorageLayout.TRANSFER_ID.matches(exportId)) return
        DurableFiles.deleteRecursively(File(exportsDir, exportId))
    }

    /** Removes leftovers older than 24 hours; returns how many were removed. Called on every start. */
    fun sweep(): Int {
        val cutoff = clock.nowMs() - MAX_AGE_MS
        var removed = 0
        exportsDir.listFiles()?.forEach { entry ->
            if (entry.lastModified() < cutoff) {
                DurableFiles.deleteRecursively(entry)
                removed++
            }
        }
        return removed
    }

    fun deleteAll() {
        exportsDir.listFiles()?.forEach { DurableFiles.deleteRecursively(it) }
    }

    companion object {
        const val MAX_AGE_MS = 24L * 3600 * 1000
    }
}

/**
 * Streaming text/ZIP export (SEC-004, contract §7). Rows are paged (LIMIT 200)
 * and written straight to disk; the history is never assembled in memory.
 *
 * Consistency: with [ReadOnlyDb.supportsReadTransaction] the whole export runs
 * in ONE read transaction. Otherwise (Android API 29–34, whose framework has no
 * read-only transaction API) the export is validated optimistically with
 * `PRAGMA data_version`: if any other connection committed while the export
 * ran, the partial file is discarded and the export is repeated; after
 * [MAX_ATTEMPTS] it fails with ENGINE_BUSY. A successful export is therefore
 * always a consistent snapshot. The source database is never written (T23).
 */
class Exporter(
    private val store: ExportStore,
    private val spaceProbe: SpaceProbe,
    private val clock: Clock,
    private val appVersion: String,
) {
    private class Conversation(val id: String, val title: String, val language: String, val createdAt: Long, val updatedAt: Long)

    fun exportConversation(db: ReadOnlyDb, dbFile: File, conversationId: String, labels: ExportLabels): String =
        run(db, dbFile) { dir ->
            val c = conversation(db, conversationId) ?: throw NamuException(ErrorCodes.NOT_FOUND, "unknown conversation")
            val file = File(dir, ExportText.safeTitle(displayTitle(c, labels)) + ".txt")
            FileOutputStream(file).use { out ->
                val writer = utf8Writer(out)
                writeConversation(db, c, labels, writer)
                writer.flush()
                out.fd.sync()
            }
        }

    fun exportAll(db: ReadOnlyDb, dbFile: File, labels: ExportLabels): String = run(db, dbFile) { dir ->
        val now = clock.nowMs()
        val file = File(dir, "namu-export-${ExportText.stamp(now)}.zip")
        FileOutputStream(file).use { out ->
            ZipOutputStream(out).use { zip ->
                val index = ArrayList<Map<String, Any?>>()
                var n = 0
                var offset = 0
                while (true) {
                    val page = db.query(
                        "SELECT id, title, response_language, created_at, updated_at FROM conversations " +
                            "ORDER BY created_at ASC, id ASC LIMIT $PAGE OFFSET $offset",
                    ).map(::toConversation)
                    for (c in page) {
                        n++
                        val name = "conversations/$n-${ExportText.safeTitle(displayTitle(c, labels))}.txt"
                        zip.putNextEntry(ZipEntry(name))
                        val writer = utf8Writer(NonClosing(zip))
                        val turns = writeConversation(db, c, labels, writer)
                        writer.flush()
                        zip.closeEntry()
                        index.add(
                            linkedMapOf(
                                "id" to c.id, "title" to c.title, "file" to name,
                                "created_at" to ExportText.iso(c.createdAt),
                                "updated_at" to ExportText.iso(c.updatedAt),
                                "turns" to turns.toLong(),
                            ),
                        )
                    }
                    if (page.size < PAGE) break
                    offset += PAGE
                }
                zip.putNextEntry(ZipEntry("index.json"))
                val json = JsonOut.stringify(
                    linkedMapOf(
                        "export_schema" to 1L,
                        "exported_at" to ExportText.iso(now),
                        "app_version" to appVersion,
                        "conversations" to index,
                    ),
                )
                zip.write(json.toByteArray(Charsets.UTF_8))
                zip.closeEntry()
                zip.finish()
                out.fd.sync()
            }
        }
    }

    // ---- snapshot strategy -----------------------------------------------------------------------

    private fun run(db: ReadOnlyDb, dbFile: File, write: (File) -> Unit): String {
        // Text output is smaller than the database that holds it (plus indexes), so this bounds it.
        val needed = dbFile.length() + RESERVE_BYTES
        if (SpaceRule.safeFree(spaceProbe) < needed) throw NamuException(ErrorCodes.SPACE_LOW, "not enough space to export")

        var attempt = 0
        while (true) {
            attempt++
            val (id, dir) = try {
                store.newExportDir()
            } catch (e: IOException) {
                throw NamuException(ErrorCodes.STORAGE_WRITE_FAILED, "export directory unavailable")
            }
            var consistent = false
            try {
                if (db.supportsReadTransaction) {
                    db.beginRead()
                    try {
                        write(dir)
                    } finally {
                        db.endRead()
                    }
                    consistent = true
                } else {
                    val before = dataVersion(db)
                    write(dir)
                    consistent = dataVersion(db) == before
                }
            } catch (e: NamuException) {
                store.delete(id)
                throw e
            } catch (e: IOException) {
                store.delete(id) // failure or low space removes the partial export (T23)
                val low = SpaceRule.safeFree(spaceProbe) < RESERVE_BYTES
                throw NamuException(if (low) ErrorCodes.SPACE_LOW else ErrorCodes.STORAGE_WRITE_FAILED, "export failed")
            } catch (e: RuntimeException) {
                store.delete(id)
                throw NamuException(ErrorCodes.DATABASE_RECOVERY, "chat database could not be read")
            }
            if (consistent) return id
            store.delete(id)
            if (attempt >= MAX_ATTEMPTS) throw NamuException(ErrorCodes.ENGINE_BUSY, "database kept changing during export")
        }
    }

    private fun dataVersion(db: ReadOnlyDb): Long = db.query("PRAGMA data_version").first()[0] as Long

    // ---- formatting (contract §7) ----------------------------------------------------------------

    private fun displayTitle(c: Conversation, labels: ExportLabels) = c.title.ifBlank { labels.untitled }

    private fun conversation(db: ReadOnlyDb, id: String): Conversation? = db.query(
        "SELECT id, title, response_language, created_at, updated_at FROM conversations WHERE id = ?",
        listOf(id),
    ).firstOrNull()?.let(::toConversation)

    private fun toConversation(row: List<Any?>) = Conversation(
        id = row[0] as String,
        title = row[1] as String,
        language = row[2] as String,
        createdAt = row[3] as Long,
        updatedAt = row[4] as Long,
    )

    /** UTF-8 without BOM, `\n` newlines. @return number of turns written. */
    private fun writeConversation(db: ReadOnlyDb, c: Conversation, labels: ExportLabels, out: Writer): Int {
        out.write(displayTitle(c, labels).replace('\n', ' ').replace('\r', ' '))
        out.write("\n${labels.created}: ${ExportText.iso(c.createdAt)}\n")
        out.write("${labels.updated}: ${ExportText.iso(c.updatedAt)}\n")
        out.write("${labels.responseLanguage}: ${labels.languageNames[c.language] ?: c.language}\n")

        var turns = 0
        var after = Long.MIN_VALUE
        while (true) {
            // Only the selected attempt is exported; the LEFT JOIN keeps turns without one.
            val page = db.query(
                "SELECT t.ordinal, t.user_text, a.content, a.status, a.finish_reason " +
                    "FROM turns t LEFT JOIN assistant_attempts a ON a.id = t.selected_attempt_id " +
                    "WHERE t.conversation_id = ? AND t.ordinal > ? ORDER BY t.ordinal ASC LIMIT $PAGE",
                listOf(c.id, after.toString()),
            )
            for (row in page) {
                after = row[0] as Long
                turns++
                out.write("\n${labels.you}:\n${row[1] as String}\n")
                val content = row[2] as String?
                if (content != null) {
                    out.write("\n${labels.namu}:\n$content\n")
                    if (row[3] in INTERRUPTED_STATUSES) out.write("[${labels.interrupted}]\n")
                    if (row[4] == "length") out.write("[${labels.lengthLimited}]\n")
                }
            }
            if (page.size < PAGE) break
        }
        return turns
    }

    private fun utf8Writer(out: OutputStream): Writer = BufferedWriter(OutputStreamWriter(out, Charsets.UTF_8), 64 * 1024)

    /** Lets a per-entry writer be flushed/closed without closing the ZIP stream. */
    private class NonClosing(private val inner: OutputStream) : OutputStream() {
        override fun write(b: Int) = inner.write(b)
        override fun write(b: ByteArray, off: Int, len: Int) = inner.write(b, off, len)
        override fun flush() = inner.flush()
        override fun close() = Unit
    }

    companion object {
        const val PAGE = 200
        const val MAX_ATTEMPTS = 3
        const val RESERVE_BYTES = 8L * 1024 * 1024
        const val CHAT_DB_FILE_NAME = "namu.sqlite"
        private val INTERRUPTED_STATUSES = setOf("interrupted", "stopped", "failed")
    }
}

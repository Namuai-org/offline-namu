package org.namuai.offline.transfer

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import org.namuai.offline.core.transfer.SqlDriver
import java.io.File

/**
 * android.database.sqlite behind the core [SqlDriver] seam (contract §5):
 * WAL with `synchronous=FULL`, one database owned only by the transfer
 * service, never shared with the chat database. All SQL text and journal
 * logic live in namu-core's SqlJournal, which is JVM-tested against SQLite.
 */
class AndroidSqlDriver(private val file: File) : SqlDriver {
    private val lock = Any()
    private var db: SQLiteDatabase = open()

    private fun open(): SQLiteDatabase {
        file.parentFile?.mkdirs()
        val params = SQLiteDatabase.OpenParams.Builder()
            .addOpenFlags(SQLiteDatabase.CREATE_IF_NECESSARY)
            .setJournalMode("WAL")
            .setSynchronousMode("FULL")
            .build()
        return SQLiteDatabase.openDatabase(file, params)
    }

    override fun execute(sql: String, args: List<Any?>) {
        synchronized(lock) {
            if (args.isEmpty()) db.execSQL(sql) else db.execSQL(sql, args.toTypedArray())
        }
    }

    override fun query(sql: String, args: List<String>): List<List<Any?>> {
        synchronized(lock) {
            db.rawQuery(sql, args.toTypedArray()).use { cursor ->
                val rows = ArrayList<List<Any?>>(cursor.count)
                val columns = cursor.columnCount
                while (cursor.moveToNext()) {
                    val row = ArrayList<Any?>(columns)
                    for (i in 0 until columns) {
                        row.add(
                            when (cursor.getType(i)) {
                                Cursor.FIELD_TYPE_NULL -> null
                                Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(i)
                                Cursor.FIELD_TYPE_BLOB -> cursor.getBlob(i)
                                else -> cursor.getString(i)
                            },
                        )
                    }
                    rows.add(row)
                }
                return rows
            }
        }
    }

    override fun <T> transaction(block: () -> T): T {
        synchronized(lock) {
            db.beginTransactionNonExclusive() // BEGIN IMMEDIATE
            try {
                val result = block()
                db.setTransactionSuccessful()
                return result
            } finally {
                db.endTransaction()
            }
        }
    }

    /** SEC-006: close, delete the database with its -wal/-shm/-journal files, reopen empty. */
    override fun recreate() {
        synchronized(lock) {
            db.close()
            SQLiteDatabase.deleteDatabase(file)
            db = open()
        }
    }
}

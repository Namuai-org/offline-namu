package org.namuai.offline.export

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.os.Build
import org.namuai.offline.core.export.ReadOnlyDb
import java.io.File

/**
 * The exporter's OWN read-only connection to namu.sqlite (contract §7); the JS
 * (op-sqlite) connection is never shared and the file is never written.
 *
 * Read transaction: android.database.sqlite only offers BEGIN EXCLUSIVE /
 * BEGIN IMMEDIATE (both write transactions, which a read-only connection
 * refuses) until API 35 added `beginTransactionReadOnly()`. A literal
 * "BEGIN" through execSQL/rawQuery is rewritten by SQLiteSession into an
 * exclusive transaction, and a long-lived Cursor is no snapshot either: every
 * CursorWindow refill re-executes the statement. Therefore:
 *  - API 35+: one deferred read transaction = one consistent WAL snapshot;
 *  - API 29–34: [supportsReadTransaction] is false and namu-core's Exporter
 *    validates the export with `PRAGMA data_version` on this single connection
 *    (opened without the WAL pool, so every statement runs on the same
 *    connection) and repeats it when another connection committed meanwhile.
 */
class AndroidReadOnlyDb(file: File) : ReadOnlyDb {
    private val db: SQLiteDatabase =
        SQLiteDatabase.openDatabase(file.absolutePath, null, SQLiteDatabase.OPEN_READONLY)

    override val supportsReadTransaction: Boolean = Build.VERSION.SDK_INT >= 35

    override fun beginRead() {
        if (Build.VERSION.SDK_INT >= 35) db.beginTransactionReadOnly()
    }

    override fun endRead() {
        if (Build.VERSION.SDK_INT >= 35 && db.inTransaction()) {
            db.setTransactionSuccessful()
            db.endTransaction()
        }
    }

    override fun query(sql: String, args: List<String>): List<List<Any?>> {
        db.rawQuery(sql, args.toTypedArray()).use { cursor ->
            val rows = ArrayList<List<Any?>>()
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

    override fun close() = db.close()
}

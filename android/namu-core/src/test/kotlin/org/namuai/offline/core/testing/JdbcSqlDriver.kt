package org.namuai.offline.core.testing

import org.namuai.offline.core.transfer.SqlDriver
import java.io.File
import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement

/**
 * TEST-ONLY [SqlDriver] over sqlite-jdbc. It configures the connection the way
 * the Android driver must: WAL + synchronous=FULL (contract §5).
 */
class JdbcSqlDriver(private val file: File) : SqlDriver {
    private var connection: Connection = open()

    private fun open(): Connection {
        val c = DriverManager.getConnection("jdbc:sqlite:${file.absolutePath}")
        c.createStatement().use { it.execute("PRAGMA journal_mode=WAL") }
        c.createStatement().use { it.execute("PRAGMA synchronous=FULL") }
        return c
    }

    private fun bind(statement: PreparedStatement, args: List<Any?>) {
        args.forEachIndexed { index, value ->
            when (value) {
                null -> statement.setNull(index + 1, java.sql.Types.NULL)
                is String -> statement.setString(index + 1, value)
                is Long -> statement.setLong(index + 1, value)
                is ByteArray -> statement.setBytes(index + 1, value)
                else -> throw IllegalArgumentException("unsupported bind type")
            }
        }
    }

    @Synchronized
    override fun execute(sql: String, args: List<Any?>) {
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            statement.execute()
        }
    }

    @Synchronized
    override fun query(sql: String, args: List<String>): List<List<Any?>> {
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            statement.executeQuery().use { rs ->
                val columns = rs.metaData.columnCount
                val rows = ArrayList<List<Any?>>()
                while (rs.next()) {
                    rows.add(
                        (1..columns).map { i ->
                            when (val v = rs.getObject(i)) {
                                null -> null
                                is Int -> v.toLong()
                                is Long -> v
                                is String -> v
                                is ByteArray -> v
                                else -> throw IllegalStateException("unexpected column type ${v.javaClass}")
                            }
                        },
                    )
                }
                return rows
            }
        }
    }

    @Synchronized
    override fun <T> transaction(block: () -> T): T {
        connection.createStatement().use { it.execute("BEGIN IMMEDIATE") }
        try {
            val result = block()
            connection.createStatement().use { it.execute("COMMIT") }
            return result
        } catch (t: Throwable) {
            connection.createStatement().use { it.execute("ROLLBACK") }
            throw t
        }
    }

    @Synchronized
    override fun recreate() {
        connection.close()
        for (suffix in listOf("", "-wal", "-shm", "-journal")) File(file.path + suffix).delete()
        connection = open()
    }

    @Synchronized
    fun close() = connection.close()
}

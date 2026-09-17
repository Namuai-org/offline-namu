package org.namuai.offline.platform

import android.content.Context
import java.io.File

/**
 * `noBackupFilesDir/namu-data` (contract §2, SEC-001): holds namu.sqlite with
 * its -wal/-shm files, diagnostics and preference files. The directory is
 * app-private and outside every backup domain.
 */
object ChatDataDirectory {
    fun directory(context: Context): File = File(context.applicationContext.noBackupFilesDir, "namu-data")

    fun prepare(context: Context): File {
        val dir = directory(context)
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) {
            throw java.io.IOException("chat data directory unavailable")
        }
        return dir
    }

    /**
     * Bytes the person's chats cost on this device: the chat database and its
     * journal files only. The diagnostics ring and preference files in the same
     * folder are the app's own and are not counted (S07 "Saved chats size").
     */
    fun sizeBytes(context: Context): Long =
        directory(context).listFiles()
            ?.filter { it.isFile && it.name.startsWith(CHAT_DATABASE_FILE_NAME) }
            ?.sumOf { it.length() } ?: 0L

    const val CHAT_DATABASE_FILE_NAME = "namu.sqlite"

    /** SEC-006. The JS side guarantees the chat database is closed and the engine unloaded. */
    fun deleteAll(context: Context): Boolean {
        val dir = directory(context)
        if (!dir.exists()) return true
        return dir.deleteRecursively()
    }
}

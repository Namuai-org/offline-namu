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

    fun sizeBytes(context: Context): Long = sizeOf(directory(context))

    private fun sizeOf(file: File): Long {
        if (!file.exists()) return 0L
        if (file.isFile) return file.length()
        return file.listFiles()?.sumOf { sizeOf(it) } ?: 0L
    }

    /** SEC-006. The JS side guarantees the chat database is closed and the engine unloaded. */
    fun deleteAll(context: Context): Boolean {
        val dir = directory(context)
        if (!dir.exists()) return true
        return dir.deleteRecursively()
    }
}

package org.namuai.offline.core.store

import org.namuai.offline.core.util.CrashHook
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/** fsync of a directory entry. Android supplies an android.system.Os based implementation. */
interface DirectorySyncer {
    @Throws(IOException::class)
    fun sync(directory: File)
}

/** Portable NIO implementation: open the directory read-only and force it. */
object NioDirectorySyncer : DirectorySyncer {
    override fun sync(directory: File) {
        FileChannel.open(directory.toPath(), StandardOpenOption.READ).use { it.force(true) }
    }
}

/**
 * DL-012 durable replace: write `<name>.tmp` → FileChannel.force(true) →
 * atomic rename over the target → fsync the directory. A crash at any point
 * leaves either the complete old file or the complete new file, never a mix;
 * a leftover `.tmp` is never promoted by recovery.
 */
class DurableFiles(private val dirSyncer: DirectorySyncer, private val crashHook: CrashHook) {

    @Throws(IOException::class)
    fun replace(target: File, tmp: File, content: ByteArray, checkpointPrefix: String) {
        crashHook.at("$checkpointPrefix.beforeTmpWrite")
        FileChannel.open(
            tmp.toPath(),
            StandardOpenOption.CREATE,
            StandardOpenOption.WRITE,
            StandardOpenOption.TRUNCATE_EXISTING,
        ).use { channel ->
            val half = content.size / 2
            writeFully(channel, ByteBuffer.wrap(content, 0, half))
            // A crash here leaves a torn .tmp; recovery must ignore it.
            crashHook.at("$checkpointPrefix.afterPartialTmpWrite")
            writeFully(channel, ByteBuffer.wrap(content, half, content.size - half))
            crashHook.at("$checkpointPrefix.afterTmpWrite")
            channel.force(true)
        }
        crashHook.at("$checkpointPrefix.afterTmpFsync")
        Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
        crashHook.at("$checkpointPrefix.afterRename")
        syncDirectory(target.parentFile)
        crashHook.at("$checkpointPrefix.afterDirFsync")
    }

    @Throws(IOException::class)
    fun deleteDurably(file: File) {
        if (file.exists() && !file.delete()) throw IOException("delete failed")
        syncDirectory(file.parentFile)
    }

    @Throws(IOException::class)
    fun syncDirectory(directory: File?) {
        if (directory != null) dirSyncer.sync(directory)
    }

    private fun writeFully(channel: FileChannel, buffer: ByteBuffer) {
        while (buffer.hasRemaining()) channel.write(buffer)
    }

    companion object {
        fun deleteRecursively(file: File) {
            if (file.isDirectory) {
                // Release directories/files are read-only (0444); make them removable first.
                file.setWritable(true, true)
                file.listFiles()?.forEach { deleteRecursively(it) }
            }
            file.delete()
        }
    }
}

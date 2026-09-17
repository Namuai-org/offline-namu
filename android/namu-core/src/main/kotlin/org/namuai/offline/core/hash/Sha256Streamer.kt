package org.namuai.offline.core.hash

import org.namuai.offline.core.util.Hex
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * Streaming SHA-256 over the complete file (contract §6.4 step 2). Hash state
 * is never serialized: an interrupted verification starts again from byte 0
 * (DL-004).
 */
object Sha256Streamer {
    const val BUFFER_BYTES = 8 * 1024 * 1024

    /**
     * @param isCancelled polled between buffers; when true the result is null.
     * @param onProgress total bytes hashed so far, called after every buffer.
     * @return lower-case hex digest, or null when cancelled.
     */
    @Throws(IOException::class)
    fun hashFile(
        file: File,
        isCancelled: () -> Boolean = { false },
        onProgress: (Long) -> Unit = {},
        bufferBytes: Int = BUFFER_BYTES,
    ): String? {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(bufferBytes)
        var total = 0L
        FileInputStream(file).use { input ->
            while (true) {
                if (isCancelled()) return null
                val n = input.read(buffer)
                if (n < 0) break
                if (n > 0) {
                    digest.update(buffer, 0, n)
                    total += n
                    onProgress(total)
                }
            }
        }
        return Hex.encode(digest.digest())
    }
}

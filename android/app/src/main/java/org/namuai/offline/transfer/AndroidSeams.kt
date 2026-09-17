package org.namuai.offline.transfer

import android.content.Context
import android.os.StatFs
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import org.namuai.offline.core.descriptor.DescriptorVerifier
import org.namuai.offline.core.descriptor.TrustSource
import org.namuai.offline.core.store.DirectorySyncer
import org.namuai.offline.core.transfer.SpaceProbe
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/** DL-009: bytes available to the app on the volume that holds staging and releases. */
class StatFsSpaceProbe(private val directory: File) : SpaceProbe {
    override fun freeBytes(): Long {
        directory.mkdirs()
        return StatFs(directory.absolutePath).availableBytes
    }
}

/** DL-012: fsync of a directory entry through the POSIX layer. */
object OsDirectorySyncer : DirectorySyncer {
    override fun sync(directory: File) {
        try {
            val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
            try {
                Os.fsync(fd)
            } finally {
                Os.close(fd)
            }
        } catch (e: ErrnoException) {
            throw IOException("directory sync failed")
        }
    }
}

/** Contract §1: bundled trust files under assets/namu/. Missing files are reported as null. */
class AssetTrustSource(context: Context) : TrustSource {
    private val assets = context.applicationContext.assets

    override fun releaseKeysJson(): ByteArray? = read("namu/release-keys.json")
    override fun bundledDescriptor(): ByteArray? = read("namu/initial-descriptor.json")
    override fun knownBadJson(): ByteArray? = read("namu/known-bad.json")

    private fun read(path: String): ByteArray? = try {
        assets.open(path).use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                out.write(buffer, 0, n)
                // Bounded read: trust files are small; an envelope is at most 64 KiB (SIG-002).
                if (out.size() > 4 * DescriptorVerifier.MAX_ENVELOPE_BYTES) return null
            }
            out.toByteArray()
        }
    } catch (e: IOException) {
        null
    }
}

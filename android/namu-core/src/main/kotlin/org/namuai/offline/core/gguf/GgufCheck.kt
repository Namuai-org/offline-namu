package org.namuai.offline.core.gguf

import java.io.BufferedInputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream

class GgufFormatException(message: String) : Exception(message)

sealed class GgufVerdict {
    object Ok : GgufVerdict()

    /** Structural bound violation → FILE_DAMAGED. */
    class Damaged(val reason: String) : GgufVerdict()

    /** `general.architecture` differs from the signed descriptor → MODEL_INCOMPATIBLE. */
    class Incompatible(val found: String) : GgufVerdict()
}

/** Seam so tests can prove the structural check never runs on unverified bytes (T08, DL-010). */
interface GgufInspector {
    fun check(file: File, expectedArchitecture: String): GgufVerdict
}

/**
 * Bounded structural GGUF header reader (contract §6.4 step 3), port of
 * model-release/dev/gguf-header.mjs. It walks only the metadata key/value
 * section inside a 64 MiB window, never touches tensor data and never calls
 * the native inference parser. Callers MUST have verified the SHA-256 first.
 */
object GgufCheck : GgufInspector {
    const val MAX_KV = 4096L
    const val MAX_TENSORS = 65_536L
    const val MAX_KEY_BYTES = 1 shl 20
    const val MAX_ARCHITECTURE_BYTES = 256
    const val HEADER_WINDOW = 64L * 1024 * 1024
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    private const val TYPE_STRING = 8
    private const val TYPE_ARRAY = 9

    private fun scalarSize(type: Long): Int = when (type) {
        0L, 1L, 7L -> 1
        2L, 3L -> 2
        4L, 5L, 6L -> 4
        10L, 11L, 12L -> 8
        else -> -1
    }

    override fun check(file: File, expectedArchitecture: String): GgufVerdict {
        val found = try {
            readArchitecture(file)
        } catch (e: GgufFormatException) {
            return GgufVerdict.Damaged(e.message ?: "format")
        } catch (e: IOException) {
            return GgufVerdict.Damaged("io")
        }
        return if (found == expectedArchitecture) GgufVerdict.Ok else GgufVerdict.Incompatible(found)
    }

    @Throws(GgufFormatException::class, IOException::class)
    fun readArchitecture(file: File): String {
        val window = minOf(file.length(), HEADER_WINDOW)
        FileInputStream(file).use { raw ->
            return Reader(BufferedInputStream(raw, 64 * 1024), window).readArchitecture()
        }
    }

    private class Reader(private val input: InputStream, private val window: Long) {
        private var offset = 0L
        private val scratch = ByteArray(8)

        private fun need(n: Long) {
            if (n < 0 || offset + n > window) throw GgufFormatException("metadata exceeds header window")
        }

        private fun readFully(target: ByteArray, length: Int) {
            need(length.toLong())
            var done = 0
            while (done < length) {
                val r = input.read(target, done, length - done)
                if (r < 0) throw EOFException()
                done += r
            }
            offset += length
        }

        private fun skipFully(n: Long) {
            need(n)
            var left = n
            while (left > 0) {
                val skipped = input.skip(left)
                if (skipped > 0) {
                    left -= skipped
                } else {
                    if (input.read() < 0) throw EOFException()
                    left -= 1
                }
            }
            offset += n
        }

        private fun u32(): Long {
            readFully(scratch, 4)
            return (scratch[0].toLong() and 0xff) or
                ((scratch[1].toLong() and 0xff) shl 8) or
                ((scratch[2].toLong() and 0xff) shl 16) or
                ((scratch[3].toLong() and 0xff) shl 24)
        }

        private fun u64(): Long {
            readFully(scratch, 8)
            var v = 0L
            for (i in 7 downTo 0) v = (v shl 8) or (scratch[i].toLong() and 0xff)
            if (v < 0 || v > MAX_SAFE_INTEGER) throw GgufFormatException("length out of range")
            return v
        }

        private fun str(limit: Int): String {
            val len = u64()
            if (len > limit) throw GgufFormatException("string too long")
            need(len)
            val bytes = ByteArray(len.toInt())
            readFully(bytes, bytes.size)
            return String(bytes, Charsets.UTF_8)
        }

        private fun skipValue(type: Long, depth: Int) {
            val scalar = scalarSize(type)
            when {
                scalar > 0 -> skipFully(scalar.toLong())
                type == TYPE_STRING.toLong() -> skipFully(u64())
                type == TYPE_ARRAY.toLong() -> {
                    if (depth > 1) throw GgufFormatException("nested arrays not allowed")
                    val inner = u32()
                    val count = u64()
                    val innerScalar = scalarSize(inner)
                    if (innerScalar > 0) {
                        // count <= 2^53 and size <= 8, so the product cannot overflow a Long.
                        skipFully(innerScalar.toLong() * count)
                    } else {
                        var i = 0L
                        // Every element consumes >= 8 bytes, so the window bounds this loop.
                        while (i < count) {
                            skipValue(inner, depth + 1)
                            i++
                        }
                    }
                }
                else -> throw GgufFormatException("unknown value type")
            }
        }

        fun readArchitecture(): String {
            try {
                val magic = ByteArray(4)
                readFully(magic, 4)
                if (magic[0] != 'G'.code.toByte() || magic[1] != 'G'.code.toByte() ||
                    magic[2] != 'U'.code.toByte() || magic[3] != 'F'.code.toByte()
                ) {
                    throw GgufFormatException("bad magic")
                }
                val version = u32()
                if (version != 2L && version != 3L) throw GgufFormatException("unsupported version")
                val tensors = u64()
                val kvCount = u64()
                if (tensors > MAX_TENSORS || kvCount > MAX_KV) throw GgufFormatException("counts out of bounds")
                var i = 0L
                while (i < kvCount) {
                    val key = str(MAX_KEY_BYTES)
                    val type = u32()
                    if (key == "general.architecture") {
                        if (type != TYPE_STRING.toLong()) throw GgufFormatException("architecture is not a string")
                        return str(MAX_ARCHITECTURE_BYTES)
                    }
                    skipValue(type, 0)
                    i++
                }
                throw GgufFormatException("general.architecture missing")
            } catch (e: EOFException) {
                throw GgufFormatException("metadata exceeds header window")
            }
        }
    }
}

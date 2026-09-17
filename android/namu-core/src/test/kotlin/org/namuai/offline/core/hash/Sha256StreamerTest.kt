package org.namuai.offline.core.hash

import org.junit.jupiter.api.io.TempDir
import org.namuai.offline.core.testing.Fixtures
import java.io.File
import java.util.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class Sha256StreamerTest {
    @TempDir
    lateinit var dir: File

    @Test
    fun knownAnswer() {
        val f = File(dir, "abc").apply { writeText("abc") }
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Sha256Streamer.hashFile(f))
        val empty = File(dir, "empty").apply { writeBytes(ByteArray(0)) }
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Sha256Streamer.hashFile(empty))
    }

    @Test
    fun usesAnEightMebibyteBufferAndReportsMonotonicProgress() {
        assertEquals(8 * 1024 * 1024, Sha256Streamer.BUFFER_BYTES)
        val bytes = ByteArray(20 * 1024 * 1024 + 17).also { Random(3).nextBytes(it) }
        val f = File(dir, "big").apply { writeBytes(bytes) }
        val progress = ArrayList<Long>()
        val digest = Sha256Streamer.hashFile(f, onProgress = { progress.add(it) })
        assertEquals(Fixtures.sha256(bytes), digest)
        assertEquals(bytes.size.toLong(), progress.last())
        assertTrue(progress.zipWithNext().all { (a, b) -> b > a })
        assertTrue(progress.size >= 3, "20 MiB through an 8 MiB buffer needs at least three reads")
    }

    @Test
    fun cancellationReturnsNullWithoutADigest() {
        val f = File(dir, "c").apply { writeBytes(ByteArray(64 * 1024)) }
        var reads = 0
        val digest = Sha256Streamer.hashFile(f, isCancelled = { reads++ >= 2 }, bufferBytes = 4096)
        assertNull(digest)
    }
}

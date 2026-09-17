package org.namuai.offline.core.gguf

import org.junit.jupiter.api.io.TempDir
import org.namuai.offline.core.testing.Fixtures
import org.namuai.offline.core.testing.GgufBuilder
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

/** Contract §6.4 step 3 with synthesized headers; mirrors model-release/dev/gguf-header.mjs. */
class GgufCheckTest {
    @TempDir
    lateinit var dir: File

    private fun file(bytes: ByteArray): File = File(dir, "m-${System.nanoTime()}.gguf").apply { writeBytes(bytes) }

    @Test
    fun readsArchitectureFromV3AndV2() {
        assertEquals("cohere2", GgufCheck.readArchitecture(file(Fixtures.ggufModel(4096))))
        val v2 = GgufBuilder(version = 2).kvString("general.architecture", "llama").build()
        assertEquals("llama", GgufCheck.readArchitecture(file(v2)))
    }

    @Test
    fun skipsScalarsStringsAndArraysBeforeTheKey() {
        val b = GgufBuilder()
            .kvU32("a.u32", 7)
            .kvRaw("a.f64", 12, ByteArray(8))
            .kvRaw("a.bool", 7, ByteArray(1))
            .kvString("a.str", "x".repeat(500))
            .kvU8Array("a.bytes", 100_000)
            .kvStringArray("a.tokens", List(2000) { "tok$it" })
            .kvString("general.architecture", "cohere2")
        assertEquals("cohere2", GgufCheck.readArchitecture(file(b.build())))
    }

    @Test
    fun verdictMapsMismatchToIncompatibleAndDamageToDamaged() {
        val good = file(Fixtures.ggufModel(4096, architecture = "llama"))
        assertIs<GgufVerdict.Ok>(GgufCheck.check(good, "llama"))
        assertEquals("llama", assertIs<GgufVerdict.Incompatible>(GgufCheck.check(good, "cohere2")).found)
        assertIs<GgufVerdict.Damaged>(GgufCheck.check(file("GGUX0000".toByteArray()), "cohere2"))
        assertIs<GgufVerdict.Damaged>(GgufCheck.check(File(dir, "missing.gguf"), "cohere2"))
    }

    @Test
    fun rejectsBadMagicVersionAndCounts() {
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(GgufBuilder(magic = "GGML").build())) }
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(GgufBuilder(version = 1).build())) }
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(GgufBuilder(version = 4).build())) }
        val manyKv = GgufBuilder().apply { kvCountOverride = 4097 }.build()
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(manyKv)) }
        val manyTensors = GgufBuilder().apply { tensorCountOverride = 65_537 }.kvString("general.architecture", "x").build()
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(manyTensors)) }
        val hugeCount = GgufBuilder().apply { kvCountOverride = -1 }.build() // 2^64-1
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(hugeCount)) }
    }

    @Test
    fun rejectsMissingOrMistypedArchitecture() {
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(GgufBuilder().kvU32("x", 1).build())) }
        val mistyped = GgufBuilder().kvU32("general.architecture", 1).build()
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(mistyped)) }
        val longArch = GgufBuilder().kvString("general.architecture", "a".repeat(257)).build()
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(longArch)) }
    }

    @Test
    fun boundsEveryLengthByTheFileWindow() {
        val b = GgufBuilder()
        // A string value claiming 1 GiB in a tiny file.
        val lyingString = GgufBuilder().kvRaw("k", 8, b.u64(1L shl 30)).kvString("general.architecture", "x").build()
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(lyingString)) }
        // A scalar array claiming 2^40 elements.
        val lyingArray = GgufBuilder().kvRaw("k", 9, b.u32(10) + b.u64(1L shl 40)).build()
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(lyingArray)) }
        // A key longer than 1 MiB.
        val longKey = GgufBuilder().apply { kvCountOverride = 1 }.build() + b.u64((1L shl 20) + 1)
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(longKey)) }
        // Truncated in the middle of a key/value.
        val full = GgufBuilder().kvString("general.architecture", "cohere2").build()
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(full.copyOf(full.size - 3))) }
        // Unknown value type and arrays nested deeper than the reference allows.
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(GgufBuilder().kvRaw("k", 99, ByteArray(4)).build())) }
        val nested = b.u32(9) + b.u64(1) + b.u32(9) + b.u64(1) + b.u32(9) + b.u64(0)
        assertFailsWith<GgufFormatException> { GgufCheck.readArchitecture(file(GgufBuilder().kvRaw("k", 9, nested).build())) }
    }
}

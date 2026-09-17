package org.namuai.offline.core.json

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StrictJsonTest {
    private fun obj(text: String) = StrictJson.parse(text) as JsonValue.Obj

    @Test
    fun parsesObjectsArraysAndScalars() {
        val o = obj("""{"a":1,"b":[true,false,null,"x"],"c":{"d":-12},"e":1.5e3}""")
        assertEquals(1L, o.integer("a"))
        assertEquals(4, (o.members["b"] as JsonValue.Arr).items.size)
        assertEquals(-12L, o.obj("c")!!.integer("d"))
        assertNull(o.integer("e"), "fraction/exponent is not an integer")
        assertIs<JsonValue.Num>(o.members["e"])
    }

    @Test
    fun rejectsDuplicateKeysAtAnyDepth() {
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"a":1,"a":2}""") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"x":{"y":[{"k":1,"k":1}]}}""") }
        // Escaped spelling of the same key is still a duplicate.
        assertFailsWith<StrictJsonException> { StrictJson.parse("{\"a\":1,\"\\u0061\":2}") }
    }

    @Test
    fun boundsDepthAtSixteen() {
        val ok = "[".repeat(16) + "]".repeat(16)
        val tooDeep = "[".repeat(17) + "]".repeat(17)
        StrictJson.parse(ok)
        assertFailsWith<StrictJsonException> { StrictJson.parse(tooDeep) }
    }

    @Test
    fun integersMustBeExact() {
        assertEquals(9007199254740991L, obj("""{"n":9007199254740991}""").integer("n"))
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"n":9007199254740992}""") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"n":123456789012345678901234567890}""") }
        assertNull(obj("""{"n":1.0}""").integer("n"))
        assertNull(obj("""{"n":1e2}""").integer("n"))
        assertNull(obj("""{"n":"1"}""").integer("n"))
    }

    @Test
    fun rejectsMalformedNumbersAndTokens() {
        for (bad in listOf("01", "1.", "-", "+1", ".5", "1e", "0x10", "NaN", "tru", "nul", "'a'", "")) {
            assertFailsWith<StrictJsonException>(bad) { StrictJson.parse(bad) }
        }
    }

    @Test
    fun rejectsTrailingDataAndUnterminatedInput() {
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"a":1} x""") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"a":1}{}""") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"a":1""") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"a":"x""") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("""{"a":1,}""") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("""[1,]""") }
        StrictJson.parse(" \n\t{\"a\" : 1 }\r\n")
    }

    @Test
    fun stringEscapes() {
        val source = "\"a\\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\u0199\""
        val s = (StrictJson.parse(source) as JsonValue.Str).value
        val expected = "a\"\\/" + 8.toChar() + 12.toChar() + "\n\r\t" + 0xe9.toChar() + 0x199.toChar()
        assertEquals(expected, s)
        assertFailsWith<StrictJsonException> { StrictJson.parse("\"\\x\"") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("\"\\u12\"") }
        assertFailsWith<StrictJsonException> { StrictJson.parse("\"\\u12G4\"") }
        // A raw control character inside a string is not allowed.
        assertFailsWith<StrictJsonException> { StrictJson.parse("\"a" + 1.toChar() + "b\"") }
    }

    @Test
    fun utf8IsStrict() {
        // Hausa hooked letters (LOC-002) survive exactly.
        val hooked = "" + 0x199.toChar() + " " + 0x257.toChar() + " " + 0x253.toChar()
        val bytes = ("{\"t\":\"" + hooked + "\"}").toByteArray(Charsets.UTF_8)
        assertEquals(hooked, (StrictJson.parseUtf8(bytes) as JsonValue.Obj).string("t"))
        val quote = '"'.code.toByte()
        assertFailsWith<StrictJsonException> { StrictJson.parseUtf8(byteArrayOf(quote, 0xC3.toByte(), 0x28, quote)) }
        // A byte order mark is rejected (stricter than the Node reference, which strips it).
        assertFailsWith<StrictJsonException> {
            StrictJson.parseUtf8(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), '1'.code.toByte()))
        }
    }

    @Test
    fun typedGettersRejectWrongTypes() {
        val o = obj("""{"s":"x","a":["p","q"],"m":["p",1]}""")
        assertEquals("x", o.string("s"))
        assertNull(o.string("a"))
        assertEquals(listOf("p", "q"), o.stringArray("a"))
        assertNull(o.stringArray("m"))
        assertNull(o.stringArray("s"))
        assertTrue(o.members.containsKey("m"))
    }

    @Test
    fun writerRoundTrips() {
        val json = JsonOut.stringify(
            linkedMapOf("a" to 1L, "b" to listOf("x\n\"y\"", null, true), "c" to mapOf("d" to 8_000_000_000L)),
        )
        val back = StrictJson.parse(json) as JsonValue.Obj
        assertEquals(1L, back.integer("a"))
        assertEquals(8_000_000_000L, back.obj("c")!!.integer("d"))
        assertEquals("x\n\"y\"", ((back.members["b"] as JsonValue.Arr).items[0] as JsonValue.Str).value)
    }
}

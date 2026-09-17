package org.namuai.offline.core.transfer

import org.namuai.offline.core.ErrorCodes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

/** Decision table of contract §6.2 (T04, T05, T06, T07 at rule level). */
class ResponseRulesTest {
    private val b = 1000L
    private val etag = "\"v1\""

    private fun facts(
        code: Int,
        length: String? = null,
        range: String? = null,
        tag: String? = etag,
        encoding: String? = null,
        retryAfter: Long? = null,
    ) = HttpFacts(code, length, range, tag, encoding, retryAfter)

    private fun fresh(f: HttpFacts) = ResponseRules.classify(false, 0, b, null, 0, f)
    private fun resume(f: HttpFacts, p: Long = 400, local: Long = 400) = ResponseRules.classify(true, p, b, etag, local, f)

    @Test
    fun freshGet() {
        assertEquals(etag, assertIs<ResponseAction.AcceptFresh>(fresh(facts(200, length = "1000"))).strongEtag)
        assertIs<ResponseAction.AcceptFresh>(fresh(facts(200, length = null)))
        assertNull(assertIs<ResponseAction.AcceptFresh>(fresh(facts(200, tag = "W/\"v1\""))).strongEtag, "weak ETags are never stored")
        assertNull(assertIs<ResponseAction.AcceptFresh>(fresh(facts(200, tag = null))).strongEtag)
        // Content-Length must equal the signed size, in either direction (T07).
        for (bad in listOf("999", "1001", "abc", "-1")) {
            val fatal = assertIs<ResponseAction.Fatal>(fresh(facts(200, length = bad)))
            assertEquals(ErrorCodes.FILE_DAMAGED, fatal.code)
            assertEquals(true, fatal.deleteStaging)
        }
        assertIs<ResponseAction.Transient>(fresh(facts(206, range = "bytes 0-999/1000")))
    }

    @Test
    fun resumeAcceptsOnlyTheExactRange_T05() {
        assertIs<ResponseAction.AcceptResume>(resume(facts(206, length = "600", range = "bytes 400-999/1000")))
        assertIs<ResponseAction.AcceptResume>(resume(facts(206, range = "bytes 400-999/1000", tag = null)))
        for (bad in listOf("bytes 401-999/1000", "bytes 400-998/1000", "bytes 400-999/1001", "bytes 400-999/*", "bytes 0-999/1000", null)) {
            assertIs<ResponseAction.RestartFromZero>(resume(facts(206, range = bad)), "range=$bad")
        }
        assertIs<ResponseAction.RestartFromZero>(resume(facts(206, range = "bytes 400-999/1000", tag = "\"v2\"")))
        assertIs<ResponseAction.RestartFromZero>(resume(facts(206, range = "bytes 400-999/1000", tag = "W/\"v1\"")))
        assertIs<ResponseAction.RestartFromZero>(resume(facts(206, length = "601", range = "bytes 400-999/1000")))
    }

    @Test
    fun okOnResumeNeverAppends_T04() {
        val action = assertIs<ResponseAction.FreshAfterTruncate>(resume(facts(200, length = "1000", tag = "\"v2\"")))
        assertEquals("\"v2\"", action.strongEtag)
        assertIs<ResponseAction.Fatal>(resume(facts(200, length = "5000")))
    }

    @Test
    fun rangeNotSatisfiable_T06() {
        assertIs<ResponseAction.VerifyLocalFile>(resume(facts(416), p = 1000, local = 1000))
        assertIs<ResponseAction.RestartFromZero>(resume(facts(416), p = 400, local = 400))
        assertIs<ResponseAction.RestartFromZero>(resume(facts(416), p = 400, local = 1001))
        assertIs<ResponseAction.Fatal>(fresh(facts(416)))
    }

    @Test
    fun retryableAndFatalStatuses() {
        assertEquals(9_000L, assertIs<ResponseAction.Transient>(fresh(facts(503, retryAfter = 9_000L))).retryAfterMs)
        for (code in listOf(408, 429, 500, 502, 504)) assertIs<ResponseAction.Transient>(fresh(facts(code)))
        for (code in listOf(400, 401, 403, 404, 410)) {
            val fatal = assertIs<ResponseAction.Fatal>(fresh(facts(code)))
            assertEquals(ErrorCodes.TRANSFER_RETRY, fatal.code)
            assertEquals(false, fatal.deleteStaging, "valid partial data is retained")
        }
        assertIs<ResponseAction.Transient>(fresh(facts(204)))
    }

    @Test
    fun contentEncodingMustBeIdentity() {
        assertIs<ResponseAction.Fatal>(fresh(facts(200, encoding = "gzip")))
        assertIs<ResponseAction.Fatal>(resume(facts(206, range = "bytes 400-999/1000", encoding = "br")))
        assertIs<ResponseAction.AcceptFresh>(fresh(facts(200, encoding = "identity")))
        assertIs<ResponseAction.AcceptFresh>(fresh(facts(200, encoding = " Identity ")))
    }

    @Test
    fun strongEtagDetection() {
        assertEquals(true, ResponseRules.isStrongEtag("\"abc\""))
        assertEquals(true, ResponseRules.isStrongEtag("\"\""))
        for (weak in listOf("W/\"abc\"", "abc", "\"", "", null)) assertEquals(false, ResponseRules.isStrongEtag(weak))
    }
}

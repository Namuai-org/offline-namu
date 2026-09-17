package org.namuai.offline.core.transfer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** DL-007 timing. */
class RetryPolicyTest {
    private fun delay(policy: RetryPolicy, used: Int, retryAfter: Long? = null): Long =
        assertIs<RetryDecision.After>(policy.next(used, retryAfter)).delayMs

    @Test
    fun backoffScheduleWithoutJitter() {
        val p = RetryPolicy { 0.0 }
        assertEquals(listOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L), (0..4).map { delay(p, it) })
    }

    @Test
    fun jitterIsAtMostTwentyPercentAndNeverNegative() {
        val max = RetryPolicy { 1.0 }
        assertEquals(listOf(2_400L, 6_000L, 18_000L, 36_000L, 72_000L), (0..4).map { delay(max, it) })
        val wild = RetryPolicy { 7.5 } // a broken random source is clamped
        assertEquals(2_400L, delay(wild, 0))
        val real = RetryPolicy()
        repeat(200) {
            val d = delay(real, 2)
            assertTrue(d in 15_000L..18_000L, "delay $d outside 15 s … 18 s")
        }
    }

    @Test
    fun fiveAutomaticRetriesThenUserRetry() {
        val p = RetryPolicy { 0.0 }
        assertEquals(5, RetryPolicy.MAX_AUTOMATIC_RETRIES)
        assertIs<RetryDecision.After>(p.next(4, null))
        assertIs<RetryDecision.GiveUp>(p.next(5, null))
        assertIs<RetryDecision.GiveUp>(p.next(6, null))
        assertIs<RetryDecision.GiveUp>(p.next(-1, null))
    }

    @Test
    fun retryAfterIsHonouredUpToFifteenMinutes() {
        val p = RetryPolicy { 0.0 }
        assertEquals(120_000L, delay(p, 0, 120_000L))
        assertEquals(900_000L, delay(p, 0, 3_600_000L))
        assertEquals(60_000L, delay(p, 4, 1_000L), "a shorter Retry-After never undercuts the back-off")
    }

    @Test
    fun parsesRetryAfterHeader() {
        val now = 1_789_646_400_000L // 2026-09-17T12:00:00Z
        assertEquals(7_000L, RetryPolicy.parseRetryAfter("7", now))
        assertEquals(0L, RetryPolicy.parseRetryAfter("0", now))
        assertEquals(RetryPolicy.MAX_RETRY_AFTER_MS, RetryPolicy.parseRetryAfter("99999999999", now))
        assertEquals(90_000L, RetryPolicy.parseRetryAfter("Thu, 17 Sep 2026 12:01:30 GMT", now))
        assertEquals(0L, RetryPolicy.parseRetryAfter("Thu, 17 Sep 2026 11:00:00 GMT", now))
        assertNull(RetryPolicy.parseRetryAfter("soon", now))
        assertNull(RetryPolicy.parseRetryAfter(null, now))
        assertNull(RetryPolicy.parseRetryAfter("-5", now))
    }

    @Test
    fun retryableStatuses() {
        for (code in listOf(408, 429, 500, 502, 503, 504, 599)) assertTrue(RetryPolicy.isRetryableStatus(code))
        for (code in listOf(200, 206, 301, 400, 401, 403, 404, 416)) assertTrue(!RetryPolicy.isRetryableStatus(code))
    }
}

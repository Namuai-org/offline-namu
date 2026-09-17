package org.namuai.offline.core.transfer

import org.namuai.offline.core.testing.FakeSpace
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** DL-009 and DL-006 arithmetic. */
class SpaceAndNetworkRuleTest {
    private val gib = 1024L * 1024 * 1024
    private val b = 2_143_977_056L

    @Test
    fun requiredAdditionalIsRemainingPlusOneGib() {
        assertEquals(b + gib, SpaceRule.requiredAdditionalBytes(b, 0))
        assertEquals((b - 1_000_000) + gib, SpaceRule.requiredAdditionalBytes(b, 1_000_000))
        assertEquals(gib, SpaceRule.requiredAdditionalBytes(b, b))
        assertEquals(gib, SpaceRule.requiredAdditionalBytes(b, b + 5), "never negative")
    }

    @Test
    fun startAndReserveThresholds() {
        assertTrue(SpaceRule.canStartOrResume(b + gib, b, 0))
        assertFalse(SpaceRule.canStartOrResume(b + gib - 1, b, 0))
        assertTrue(SpaceRule.canStartOrResume(gib + 10, b, b - 10))
        assertTrue(SpaceRule.reserveOk(256L * 1024 * 1024))
        assertFalse(SpaceRule.reserveOk(256L * 1024 * 1024 - 1))
    }

    @Test
    fun aFailingProbeCountsAsNoSpace() {
        val probe = FakeSpace().apply { failing = true }
        assertEquals(0L, SpaceRule.safeFree(probe))
        assertEquals(0L, SpaceRule.safeFree(FakeSpace(free = -4)))
    }

    @Test
    fun meteredNeedsPerTransferConsent() {
        assertTrue(NetworkRule.usable(NetworkState(connected = true, metered = false), meteredConsent = false))
        assertFalse(NetworkRule.usable(NetworkState(connected = true, metered = true), meteredConsent = false))
        assertTrue(NetworkRule.usable(NetworkState(connected = true, metered = true), meteredConsent = true))
        assertFalse(NetworkRule.usable(NetworkState(connected = false, metered = false), meteredConsent = true))
    }
}

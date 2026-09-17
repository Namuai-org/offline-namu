package org.namuai.offline.core.util

import org.namuai.offline.core.testing.FakeClock
import org.namuai.offline.core.testing.ManualExecutor
import kotlin.test.Test
import kotlin.test.assertEquals

/** DL-001: at most four progress events per second; phase changes flush immediately. */
class CoalescerTest {
    @Test
    fun progressIsCoalescedWithATrailingEmission() {
        val clock = FakeClock(now = 1_000)
        val executor = ManualExecutor()
        var emitted = 0
        val c = Coalescer(clock, executor, 250) { emitted++ }

        c.submit(false) // first one goes out
        assertEquals(1, emitted)
        repeat(50) { clock.now += 2; c.submit(false) } // 100 ms of chatter
        assertEquals(1, emitted)
        assertEquals(1, executor.pending.size, "exactly one trailing emission is scheduled")
        assertEquals(248L, executor.pending[0].first)
        clock.now = 1_250
        executor.runAll()
        assertEquals(2, emitted)
        clock.now = 1_300
        c.submit(false)
        assertEquals(2, emitted, "still inside the 250 ms window of the trailing emission")
        clock.now = 1_500
        c.submit(false)
        assertEquals(3, emitted)
    }

    @Test
    fun phaseChangesFlushImmediately() {
        val clock = FakeClock(now = 0)
        var emitted = 0
        val c = Coalescer(clock, ManualExecutor(), 250) { emitted++ }
        c.submit(false)
        c.submit(true)
        c.submit(true)
        assertEquals(3, emitted)
    }

    @Test
    fun neverMoreThanFourProgressEventsPerSecond() {
        val clock = FakeClock(now = 0)
        val executor = ManualExecutor()
        val times = ArrayList<Long>()
        val c = Coalescer(clock, executor, 250) { times.add(clock.now) }
        for (t in 0L..2_000L step 10) {
            clock.now = t
            val due = executor.pending.filter { true }
            if (due.isNotEmpty() && times.isNotEmpty() && t - times.last() >= 250) executor.runAll()
            c.submit(false)
        }
        assertEquals(true, times.zipWithNext().all { (a, b) -> b - a >= 250 }, times.toString())
    }
}

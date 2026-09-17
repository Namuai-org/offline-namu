package org.namuai.offline.core.util

/** Delayed execution seam. Android: Handler.postDelayed; tests: a manual queue. */
interface DelayedExecutor {
    fun schedule(delayMs: Long, task: () -> Unit)
}

/**
 * DL-001 / contract §6.1: progress snapshots to JS are at least [minIntervalMs]
 * (250 ms → four per second) apart; phase changes flush immediately. A trailing
 * emission guarantees the last progress value is never lost.
 */
class Coalescer(
    private val clock: Clock,
    private val executor: DelayedExecutor,
    private val minIntervalMs: Long = 250L,
    private val emit: () -> Unit,
) {
    private val lock = Any()
    private var lastEmitAt = Long.MIN_VALUE
    private var trailingScheduled = false

    fun submit(immediate: Boolean) {
        var emitNow = false
        var delay = -1L
        synchronized(lock) {
            val now = clock.nowMs()
            val elapsed = if (lastEmitAt == Long.MIN_VALUE) Long.MAX_VALUE else now - lastEmitAt
            if (immediate || elapsed >= minIntervalMs) {
                lastEmitAt = now
                emitNow = true
            } else if (!trailingScheduled) {
                trailingScheduled = true
                delay = minIntervalMs - elapsed
            }
        }
        if (emitNow) emit()
        if (delay >= 0) executor.schedule(delay) { fireTrailing() }
    }

    private fun fireTrailing() {
        synchronized(lock) {
            trailingScheduled = false
            lastEmitAt = clock.nowMs()
        }
        emit()
    }
}

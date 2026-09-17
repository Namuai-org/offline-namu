package org.namuai.offline.core.util

/** Injected wall clock (UTC epoch milliseconds) so tests are deterministic. */
interface Clock {
    fun nowMs(): Long
}

object SystemClock : Clock {
    override fun nowMs(): Long = System.currentTimeMillis()
}

/**
 * Named crash-injection points (T10, DL-012). Production uses [NoCrash]; tests
 * throw [SimulatedCrash] at a checkpoint to model process death there.
 */
interface CrashHook {
    fun at(checkpoint: String)
}

object NoCrash : CrashHook {
    override fun at(checkpoint: String) = Unit
}

class SimulatedCrash(val checkpoint: String) : Error("simulated crash at $checkpoint")

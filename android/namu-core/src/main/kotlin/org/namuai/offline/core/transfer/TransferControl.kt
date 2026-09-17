package org.namuai.offline.core.transfer

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Cooperative, out-of-band signals for one engine run. Pause and cancel come
 * from the user (DL-006); stop comes from the OS (JobService.onStopJob /
 * worker cancellation) and means "commit and let the scheduler run us again".
 */
class TransferControl {
    @Volatile var pauseRequested = false
        private set
    @Volatile var cancelRequested = false
        private set
    @Volatile var stopRequested = false
        private set

    private val lock = ReentrantLock()
    private val signalled = lock.newCondition()
    private var wakeups = 0L
    private var abortAction: (() -> Unit)? = null

    val interrupted: Boolean
        get() = pauseRequested || cancelRequested || stopRequested

    fun requestPause() { pauseRequested = true; fire(abort = true) }
    fun requestCancel() { cancelRequested = true; fire(abort = true) }
    fun requestStop() { stopRequested = true; fire(abort = true) }

    /** Ends a back-off sleep early (user pressed Retry/Resume) without aborting I/O. */
    fun wake() = fire(abort = false)

    /** The engine registers how to unblock its current blocking call (OkHttp Call.cancel). */
    fun setAbortAction(action: (() -> Unit)?) {
        val runNow = lock.withLock {
            abortAction = action
            action != null && interrupted
        }
        if (runNow) action?.invoke()
    }

    /** Blocks up to [millis]; returns early when any signal or wake-up arrives. */
    fun await(millis: Long) {
        lock.withLock {
            val seen = wakeups
            var remaining = TimeUnit.MILLISECONDS.toNanos(millis)
            while (!interrupted && wakeups == seen && remaining > 0) {
                remaining = signalled.awaitNanos(remaining)
            }
        }
    }

    private fun fire(abort: Boolean) {
        val action = lock.withLock {
            wakeups++
            signalled.signalAll()
            if (abort) abortAction else null
        }
        action?.invoke()
    }
}

/** Back-off sleep seam; tests substitute a recorder that returns immediately. */
interface Sleeper {
    fun sleep(millis: Long, control: TransferControl)
}

object RealSleeper : Sleeper {
    override fun sleep(millis: Long, control: TransferControl) = control.await(millis)
}

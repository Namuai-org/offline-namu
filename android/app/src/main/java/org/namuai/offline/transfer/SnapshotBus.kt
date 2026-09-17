package org.namuai.offline.transfer

import android.os.Handler
import android.os.HandlerThread
import org.namuai.offline.core.transfer.SnapshotListener
import org.namuai.offline.core.util.Coalescer
import org.namuai.offline.core.util.DelayedExecutor
import org.namuai.offline.core.util.SystemClock
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Fans transfer snapshots out to JS (when a React instance exists) and to the
 * progress notification. Progress is coalesced to >= 250 ms apart (four per
 * second, DL-001); phase changes flush immediately. The coalescing logic is
 * namu-core's JVM-tested [Coalescer]; this class only supplies the thread.
 */
class SnapshotBus(private val snapshotJson: () -> String) : SnapshotListener {

    fun interface Subscriber {
        fun onSnapshot(json: String)
    }

    private val thread = HandlerThread("namu-snapshots").apply { start() }
    private val handler = Handler(thread.looper)
    private val subscribers = CopyOnWriteArraySet<Subscriber>()

    private val coalescer = Coalescer(
        SystemClock,
        object : DelayedExecutor {
            override fun schedule(delayMs: Long, task: () -> Unit) {
                handler.postDelayed({ task() }, delayMs)
            }
        },
        MIN_INTERVAL_MS,
    ) { handler.post { deliver() } }

    fun subscribe(subscriber: Subscriber) {
        subscribers.add(subscriber)
    }

    fun unsubscribe(subscriber: Subscriber) {
        subscribers.remove(subscriber)
    }

    override fun onSnapshotChanged(immediate: Boolean) = coalescer.submit(immediate)

    private fun deliver() {
        if (subscribers.isEmpty()) return
        val json = try {
            snapshotJson()
        } catch (e: Exception) {
            return
        }
        for (s in subscribers) s.onSnapshot(json)
    }

    companion object {
        const val MIN_INTERVAL_MS = 250L
    }
}

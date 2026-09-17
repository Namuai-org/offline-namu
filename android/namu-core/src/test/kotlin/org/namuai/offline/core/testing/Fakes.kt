package org.namuai.offline.core.testing

import org.namuai.offline.core.descriptor.TrustSource
import org.namuai.offline.core.gguf.GgufCheck
import org.namuai.offline.core.gguf.GgufInspector
import org.namuai.offline.core.gguf.GgufVerdict
import org.namuai.offline.core.transfer.DeviceEligibility
import org.namuai.offline.core.transfer.InMemoryJournal
import org.namuai.offline.core.transfer.Journal
import org.namuai.offline.core.transfer.NetworkPolicy
import org.namuai.offline.core.transfer.NetworkState
import org.namuai.offline.core.transfer.Sleeper
import org.namuai.offline.core.transfer.SpaceProbe
import org.namuai.offline.core.transfer.TransferControl
import org.namuai.offline.core.transfer.TransferRecord
import org.namuai.offline.core.transfer.TransferScheduler
import org.namuai.offline.core.util.Clock
import org.namuai.offline.core.util.CrashHook
import org.namuai.offline.core.util.DelayedExecutor
import org.namuai.offline.core.util.SimulatedCrash
import java.io.File
import java.io.IOException

class FakeClock(@Volatile var now: Long = 1_789_646_400_000L, private val autoAdvanceMs: Long = 0) : Clock {
    override fun nowMs(): Long {
        val value = now
        now += autoAdvanceMs
        return value
    }
}

/** Records every back-off and advances the fake clock instead of sleeping. */
class RecordingSleeper(private val clock: FakeClock) : Sleeper {
    val sleeps = ArrayList<Long>()
    @Volatile var onSleep: ((Long) -> Unit)? = null
    override fun sleep(millis: Long, control: TransferControl) {
        sleeps.add(millis)
        onSleep?.invoke(millis)
        clock.now += millis
    }
}

class FakeNetwork(@Volatile var state: NetworkState = NetworkState(connected = true, metered = false)) : NetworkPolicy {
    @Volatile var calls = 0
    /** Optional script: state for the n-th call (1-based); falls back to [state]. */
    @Volatile var script: ((Int) -> NetworkState?)? = null
    override fun current(): NetworkState {
        calls++
        return script?.invoke(calls) ?: state
    }
}

class FakeSpace(@Volatile var free: Long = 64L * 1024 * 1024 * 1024) : SpaceProbe {
    @Volatile var failing = false
    @Volatile var calls = 0
    /** Optional script: value for the n-th call (1-based); falls back to [free]. */
    @Volatile var script: ((Int) -> Long?)? = null
    override fun freeBytes(): Long {
        calls++
        if (failing) throw IOException("statfs failed")
        return script?.invoke(calls) ?: free
    }
}

class RecordingScheduler : TransferScheduler {
    data class Scheduled(val transferId: String, val requireUnmetered: Boolean, val remainingBytes: Long, val replace: Boolean)
    val scheduled = ArrayList<Scheduled>()
    val cancelled = ArrayList<String>()
    override fun schedule(transferId: String, requireUnmetered: Boolean, remainingBytes: Long, replaceExisting: Boolean) {
        scheduled.add(Scheduled(transferId, requireUnmetered, remainingBytes, replaceExisting))
    }
    override fun cancel(transferId: String) {
        cancelled.add(transferId)
    }
}

class FixedEligibility(var eligible: Boolean = true) : DeviceEligibility {
    override fun isEligible(): Boolean = eligible
}

class TestTrust(
    var keys: ByteArray?,
    var bundled: ByteArray?,
    var knownBad: ByteArray? = """{"sha256":[]}""".toByteArray(),
) : TrustSource {
    override fun releaseKeysJson(): ByteArray? = keys
    override fun bundledDescriptor(): ByteArray? = bundled
    override fun knownBadJson(): ByteArray? = knownBad
}

/** Proves the structural parser is only reached with hash-verified bytes (T08). */
class SpyGgufInspector(@Volatile var delegate: GgufInspector = GgufCheck) : GgufInspector {
    val checkedFiles = ArrayList<String>()
    override fun check(file: File, expectedArchitecture: String): GgufVerdict {
        checkedFiles.add(file.name)
        return delegate.check(file, expectedArchitecture)
    }
}

/** Journal decorator that lets a test observe and react to durable commits. */
class SpyJournal(private val inner: Journal = InMemoryJournal()) : Journal by inner {
    val committedHistory = ArrayList<Long>()
    @Volatile var onCommit: ((TransferRecord) -> Unit)? = null
    /** Called after every row update with (before, after). */
    @Volatile var onUpdate: ((TransferRecord, TransferRecord) -> Unit)? = null

    override fun update(transferId: String, nowMs: Long, mutate: (TransferRecord) -> TransferRecord): TransferRecord? {
        val before = inner.get(transferId)
        val after = inner.update(transferId, nowMs, mutate)
        if (before != null && after != null && after.committedBytes != before.committedBytes) {
            committedHistory.add(after.committedBytes)
            onCommit?.invoke(after)
        }
        if (before != null && after != null) onUpdate?.invoke(before, after)
        return after
    }
}

/** Throws [SimulatedCrash] once when [target] is reached; records every checkpoint name. */
class CrashAt(@Volatile var target: String? = null) : CrashHook {
    val seen = ArrayList<String>()
    override fun at(checkpoint: String) {
        seen.add(checkpoint)
        if (checkpoint == target) {
            target = null
            throw SimulatedCrash(checkpoint)
        }
    }
}

class ManualExecutor : DelayedExecutor {
    val pending = ArrayList<Pair<Long, () -> Unit>>()
    override fun schedule(delayMs: Long, task: () -> Unit) {
        pending.add(delayMs to task)
    }
    fun runAll() {
        val copy = ArrayList(pending)
        pending.clear()
        copy.forEach { it.second() }
    }
}

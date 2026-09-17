package org.namuai.offline.modules

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import org.namuai.offline.specs.NativeNamuTransferSpec
import org.namuai.offline.transfer.SnapshotBus
import org.namuai.offline.transfer.TransferRuntime
import java.util.concurrent.Executors

/**
 * JS façade of the native transfer service (contract §3–§6). Thin by design:
 * every rule lives in namu-core's TransferService. JS observes snapshots and
 * requests transitions; it can never declare an artifact installed (ARC-003).
 */
class NamuTransferModule(reactContext: ReactApplicationContext) : NativeNamuTransferSpec(reactContext) {
    // A small pool: a long repair() (rehash) must not block snapshot().
    private val executor = Executors.newFixedThreadPool(3)
    private val runtime: TransferRuntime get() = TransferRuntime.get(reactApplicationContext)
    private val service get() = runtime.service

    private val subscriber = SnapshotBus.Subscriber { json ->
        // Not set until JS has created the module object; nothing is listening before that.
        if (mEventEmitterCallback != null) {
            emitOnSnapshot(Arguments.createMap().apply { putString("json", json) })
        }
    }

    override fun initialize() {
        super.initialize()
        runtime.bus.subscribe(subscriber)
    }

    override fun invalidate() {
        runtime.bus.unsubscribe(subscriber)
        executor.shutdown()
        super.invalidate()
    }

    override fun snapshot(promise: Promise) = executor.resolve(promise) { service.snapshotJson() }

    override fun getBundledDescriptorSummary(promise: Promise) =
        executor.resolve(promise) { service.bundledDescriptorSummaryJson() }

    override fun start(source: String, allowMetered: Boolean, promise: Promise) =
        executor.resolve(promise) { service.start(source, allowMetered) }

    override fun pause(transferId: String, promise: Promise) = executor.resolve(promise) { service.pause(transferId) }

    override fun resume(transferId: String, allowMetered: Boolean, promise: Promise) =
        executor.resolve(promise) { service.resume(transferId, allowMetered) }

    override fun cancel(transferId: String, promise: Promise) = executor.resolve(promise) { service.cancel(transferId) }

    /** SIG-005: only ever reached from the explicit "Check for updates" action. */
    override fun checkForUpdate(promise: Promise) = executor.resolve(promise) { service.checkForUpdateJson() }

    override fun beginSelfTest(transferId: String, promise: Promise) =
        executor.resolve(promise) { service.beginSelfTest(transferId) }

    override fun activate(transferId: String, selfTestPassed: Boolean, failureCode: String, promise: Promise) =
        executor.resolve(promise) { service.activate(transferId, selfTestPassed, failureCode) }

    override fun resolveArtifactPath(artifactId: String, promise: Promise) =
        executor.resolve(promise) { service.resolveArtifactPath(artifactId) }

    override fun setRuntimeReference(artifactId: String) {
        // Synchronous spec method: the flag flips here, on the calling thread, so it is ordered
        // with the calls JS makes next. File clean-up runs on the executor, never on the JS thread.
        service.setRuntimeReference(artifactId)
        try {
            executor.execute {
                try {
                    service.runDeferredCleanup()
                } catch (e: Exception) {
                    // Retried at the next start.
                }
            }
        } catch (e: RuntimeException) {
            // Module invalidated.
        }
    }

    override fun noteSuccessfulForegroundSession(promise: Promise) =
        executor.resolve(promise) { service.noteSuccessfulForegroundSession() }

    override fun restorePrevious(markAbandonedBad: Boolean, promise: Promise) =
        executor.resolve(promise) { service.restorePrevious(markAbandonedBad) }

    override fun repair(promise: Promise) = executor.resolve(promise) { service.repair() }

    override fun removeModel(promise: Promise) = executor.resolve(promise) { service.removeModel() }

    override fun deleteAllTransferData(promise: Promise) = executor.resolve(promise) { service.deleteAllTransferData() }
}

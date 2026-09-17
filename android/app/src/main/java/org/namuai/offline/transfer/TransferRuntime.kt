package org.namuai.offline.transfer

import android.content.Context
import org.namuai.offline.BuildConfig
import org.namuai.offline.core.descriptor.TinkEd25519Verifier
import org.namuai.offline.core.gguf.GgufCheck
import org.namuai.offline.core.store.StorageLayout
import org.namuai.offline.core.transfer.RealSleeper
import org.namuai.offline.core.transfer.RetryPolicy
import org.namuai.offline.core.transfer.ServiceConfig
import org.namuai.offline.core.transfer.SnapshotListener
import org.namuai.offline.core.transfer.SqlJournal
import org.namuai.offline.core.transfer.TransferEngine
import org.namuai.offline.core.transfer.TransferRecord
import org.namuai.offline.core.transfer.TransferService
import org.namuai.offline.core.util.Coalescer
import org.namuai.offline.core.util.DelayedExecutor
import org.namuai.offline.core.util.NoCrash
import org.namuai.offline.core.util.SystemClock
import org.namuai.offline.platform.AndroidEligibility
import java.io.Closeable
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Process-wide composition root of the native transfer service (ARC-003). It is
 * created from Application.onCreate and from the OS job entry points, so it
 * works in a process that has no Activity and no JS runtime. All behaviour is
 * in namu-core; this class only wires Android implementations of the seams.
 */
class TransferRuntime private constructor(context: Context) {
    private val appContext = context.applicationContext

    /** DL-008: noBackupFilesDir/namu-models, staging and releases on the same volume. */
    val layout = StorageLayout(File(appContext.noBackupFilesDir, "namu-models")).also { it.ensureDirectories() }

    private val journal = SqlJournal(AndroidSqlDriver(File(layout.journalDir, SqlJournal.DATABASE_FILE_NAME)))
    private val watchers = CopyOnWriteArraySet<SnapshotListener>()
    private val timer = Executors.newSingleThreadScheduledExecutor()

    private val network = AndroidNetworkPolicy(appContext) { fanOut(true) }

    val service = TransferService(
        ServiceConfig(
            modelOrigin = BuildConfig.MODEL_ORIGIN,
            appBuild = BuildConfig.VERSION_CODE.toLong(),
            runtimeBuildId = BuildConfig.RUNTIME_BUILD_ID,
            internalBuild = BuildConfig.INTERNAL_BUILD,
        ),
        TransferEngine.newHttpClient(),
        journal,
        layout,
        AssetTrustSource(appContext),
        TinkEd25519Verifier(),
        network,
        StatFsSpaceProbe(layout.root),
        AndroidEligibility(appContext),
        AndroidTransferScheduler(appContext),
        SystemClock,
        RealSleeper,
        RetryPolicy(),
        GgufCheck,
        NoCrash,
        OsDirectorySyncer,
    )

    val bus = SnapshotBus { service.snapshotJson() }

    init {
        service.setListener(object : SnapshotListener {
            override fun onSnapshotChanged(immediate: Boolean) = fanOut(immediate)
        })
        network.start()
    }

    private fun fanOut(immediate: Boolean) {
        bus.onSnapshotChanged(immediate)
        for (w in watchers) w.onSnapshotChanged(immediate)
    }

    fun currentRecord(transferId: String): TransferRecord? = try {
        journal.get(transferId)
    } catch (e: RuntimeException) {
        null
    }

    /** Notification updates for a running job, at most one per second. */
    fun watchProgress(transferId: String, onProgress: (TransferRecord?) -> Unit): Closeable {
        val coalescer = Coalescer(
            SystemClock,
            object : DelayedExecutor {
                override fun schedule(delayMs: Long, task: () -> Unit) {
                    timer.schedule({ task() }, delayMs, TimeUnit.MILLISECONDS)
                }
            },
            NOTIFICATION_INTERVAL_MS,
        ) { onProgress(currentRecord(transferId)) }
        val listener = object : SnapshotListener {
            override fun onSnapshotChanged(immediate: Boolean) = coalescer.submit(false)
        }
        watchers.add(listener)
        return Closeable { watchers.remove(listener) }
    }

    companion object {
        private const val NOTIFICATION_INTERVAL_MS = 1_000L

        @Volatile private var instance: TransferRuntime? = null

        fun get(context: Context): TransferRuntime =
            instance ?: synchronized(this) {
                instance ?: TransferRuntime(context).also { instance = it }
            }

        /**
         * Application.onCreate: build the runtime and run startup reconciliation
         * (contract §6.4) off the main thread so reading chats is never delayed (DL-014).
         */
        fun warmUp(context: Context) {
            val appContext = context.applicationContext
            Thread({
                try {
                    get(appContext).service.ensureReconciled()
                } catch (e: Exception) {
                    // Reconciliation is retried by the first service call.
                }
            }, "namu-reconcile").start()
        }
    }
}

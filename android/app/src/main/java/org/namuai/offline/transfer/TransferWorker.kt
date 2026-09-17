package org.namuai.offline.transfer

import android.content.Context
import android.content.pm.ServiceInfo
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.namuai.offline.core.transfer.RunOutcome

/**
 * API 29–33 path (contract §6.2): a CoroutineWorker promoted to a foreground
 * service of type dataSync. Runs with no JS runtime (ARC-003).
 */
class TransferWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo(null)

    private fun foregroundInfo(transferId: String?): ForegroundInfo {
        val runtime = TransferRuntime.get(applicationContext)
        val record = transferId?.let { runtime.currentRecord(it) }
        return ForegroundInfo(
            NotificationHelper.NOTIFICATION_ID,
            NotificationHelper.build(applicationContext, record),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    override suspend fun doWork(): Result {
        val transferId = inputData.getString(AndroidTransferScheduler.EXTRA_TRANSFER_ID) ?: return Result.failure()
        val runtime = TransferRuntime.get(applicationContext)
        try {
            setForeground(foregroundInfo(transferId))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // API 31+ may refuse a foreground start from the background. The worker then runs
            // inside the normal execution window; progress is durable, so a stop only costs a retry.
        }

        val control = runtime.service.newControl()
        val progress = runtime.watchProgress(transferId) { record ->
            NotificationHelper.update(applicationContext, record)
        }
        val outcome = try {
            coroutineScope {
                // Worker cancellation (constraint lost, cancelUniqueWork) → graceful engine stop:
                // the engine commits, journals and returns, which lets this scope finish.
                val watcher = launch {
                    try {
                        awaitCancellation()
                    } finally {
                        control.requestStop()
                    }
                }
                try {
                    withContext(Dispatchers.IO) { runtime.service.runTransfer(transferId, control) }
                } finally {
                    watcher.cancel()
                }
            }
        } finally {
            progress.close()
        }
        return when (outcome) {
            // Run again when the network constraint is met again.
            is RunOutcome.WaitingForNetwork, is RunOutcome.StoppedBySystem -> Result.retry()
            else -> Result.success()
        }
    }
}

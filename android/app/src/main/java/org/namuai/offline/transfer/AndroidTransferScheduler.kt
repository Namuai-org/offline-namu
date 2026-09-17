package org.namuai.offline.transfer

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.PersistableBundle
import androidx.annotation.RequiresApi
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import org.namuai.offline.core.transfer.TransferScheduler

/**
 * Contract §6.2 execution: API 34+ user-initiated data transfer job, API 29–33
 * foreground WorkManager worker. Both only start the same core TransferEngine.
 * One live transfer exists at a time, so one job ID / unique work name suffices.
 */
class AndroidTransferScheduler(context: Context) : TransferScheduler {
    private val appContext = context.applicationContext

    override fun schedule(transferId: String, requireUnmetered: Boolean, remainingBytes: Long, replaceExisting: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            scheduleUidt(transferId, requireUnmetered, remainingBytes, replaceExisting)
        } else {
            scheduleWorker(transferId, requireUnmetered, replaceExisting)
        }
    }

    override fun cancel(transferId: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            appContext.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
        } else {
            WorkManager.getInstance(appContext).cancelUniqueWork(UNIQUE_WORK)
        }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun scheduleUidt(transferId: String, requireUnmetered: Boolean, remainingBytes: Long, replace: Boolean) {
        val scheduler = appContext.getSystemService(JobScheduler::class.java) ?: return
        // Scheduling an existing job ID cancels the running job: only do that on purpose.
        if (!replace && scheduler.getPendingJob(JOB_ID) != null) return

        val network = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        // DL-006: unmetered only, unless the user consented to metered use for THIS transfer.
        if (requireUnmetered) network.addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)

        val extras = PersistableBundle().apply { putString(EXTRA_TRANSFER_ID, transferId) }
        val job = JobInfo.Builder(JOB_ID, ComponentName(appContext, UidtTransferJobService::class.java))
            .setUserInitiated(true)
            .setRequiredNetwork(network.build())
            .setEstimatedNetworkBytes(remainingBytes.coerceAtLeast(0L), 0L)
            .setExtras(extras)
            .build()
        try {
            // RESULT_FAILURE (e.g. app not visible): the journal keeps phase `waiting`; the next
            // foreground start reconciles and schedules again. Nothing is lost.
            scheduler.schedule(job)
        } catch (e: RuntimeException) {
            // SecurityException/IllegalArgumentException: same recovery path as RESULT_FAILURE.
        }
    }

    private fun scheduleWorker(transferId: String, requireUnmetered: Boolean, replace: Boolean) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (requireUnmetered) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequest.Builder(TransferWorker::class.java)
            .setConstraints(constraints)
            .setInputData(Data.Builder().putString(EXTRA_TRANSFER_ID, transferId).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        WorkManager.getInstance(appContext).enqueueUniqueWork(
            UNIQUE_WORK,
            if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
            request,
        )
    }

    companion object {
        const val JOB_ID = 7301
        const val UNIQUE_WORK = "namu-model-transfer"
        const val EXTRA_TRANSFER_ID = "transferId"
    }
}

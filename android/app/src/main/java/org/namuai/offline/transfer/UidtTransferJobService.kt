package org.namuai.offline.transfer

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build
import androidx.annotation.RequiresApi
import org.namuai.offline.core.transfer.RunOutcome
import org.namuai.offline.core.transfer.TransferControl
import java.util.concurrent.ConcurrentHashMap

/**
 * API 34+ user-initiated data transfer job (contract §6.2, D06). The system
 * may start this service in a fresh process with no Activity and no JS
 * runtime: everything it needs comes from [TransferRuntime] (ARC-003).
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class UidtTransferJobService : JobService() {
    private val controls = ConcurrentHashMap<Int, TransferControl>()

    override fun onStartJob(params: JobParameters): Boolean {
        val transferId = params.extras.getString(AndroidTransferScheduler.EXTRA_TRANSFER_ID) ?: return false
        val runtime = TransferRuntime.get(applicationContext)
        val control = runtime.service.newControl()
        controls[params.jobId] = control

        // UIDT jobs must post their notification promptly.
        setNotification(
            params,
            NotificationHelper.NOTIFICATION_ID,
            NotificationHelper.build(this, runtime.currentRecord(transferId)),
            JOB_END_NOTIFICATION_POLICY_REMOVE,
        )

        Thread({
            val progress = runtime.watchProgress(transferId) { record ->
                try {
                    setNotification(
                        params,
                        NotificationHelper.NOTIFICATION_ID,
                        NotificationHelper.build(this, record),
                        JOB_END_NOTIFICATION_POLICY_REMOVE,
                    )
                } catch (e: RuntimeException) {
                    // The job already ended; the last notification is removed by the system.
                }
            }
            val outcome = try {
                runtime.service.runTransfer(transferId, control)
            } finally {
                progress.close()
                controls.remove(params.jobId)
            }
            // Only a network wait asks the scheduler to run the job again under its constraint;
            // pause, cancel, failures and SPACE_LOW wait for the user (DL-006, DL-007).
            val reschedule = outcome is RunOutcome.WaitingForNetwork
            if (!control.stopRequested) jobFinished(params, reschedule)
        }, "namu-transfer").start()
        return true // work continues on the thread above
    }

    override fun onStopJob(params: JobParameters): Boolean {
        val control = controls[params.jobId] ?: return false
        if (params.stopReason == JobParameters.STOP_REASON_USER) {
            // Stopped from the system Task Manager: treat as a user pause and do not reschedule (D06).
            control.requestPause()
            return false
        }
        if (params.stopReason == JobParameters.STOP_REASON_CANCELLED_BY_APP) {
            // Our own scheduler.cancel() after pause/cancel/remove: the service already signalled.
            control.requestStop()
            return false
        }
        // Constraint lost, timeout, system pressure…: commit gracefully and ask to be run again.
        control.requestStop()
        return true
    }
}

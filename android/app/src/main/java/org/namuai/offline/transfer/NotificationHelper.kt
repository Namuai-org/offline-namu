package org.namuai.offline.transfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.namuai.offline.MainActivity
import org.namuai.offline.R
import org.namuai.offline.core.transfer.Phase
import org.namuai.offline.core.transfer.TransferRecord

/**
 * Low-importance progress notification required by UIDT jobs (API 34+) and by
 * the foreground worker (API 29–33). It shows progress only: no file names,
 * URLs or error details (PRD §17).
 */
object NotificationHelper {
    const val CHANNEL_ID = "namu_transfer"
    const val NOTIFICATION_ID = 7301

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.namu_transfer_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = context.getString(R.string.namu_transfer_channel_description)
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    fun build(context: Context, record: TransferRecord?): Notification {
        ensureChannel(context)
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val verifying = record?.phase == Phase.VERIFYING
        val done = if (verifying) record?.verifiedBytes ?: 0L else record?.committedBytes ?: 0L
        val total = record?.expectedBytes ?: 0L
        val percent = if (total > 0) ((done * 100) / total).toInt().coerceIn(0, 100) else 0
        val title = context.getString(
            if (verifying) R.string.namu_transfer_verifying else R.string.namu_transfer_title,
        )
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(context.getString(R.string.namu_transfer_progress, percent))
            .setProgress(100, percent, total <= 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(open)
            .build()
    }

    /** Best effort; without POST_NOTIFICATIONS the system simply drops it. */
    fun update(context: Context, record: TransferRecord?) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        try {
            manager.notify(NOTIFICATION_ID, build(context, record))
        } catch (e: SecurityException) {
            // Notification permission revoked: the transfer itself is unaffected.
        }
    }
}

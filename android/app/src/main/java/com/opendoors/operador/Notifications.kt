package com.opendoors.operador

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * What reaches the lock screen, and how loudly.
 *
 * Three channels rather than one, because they are three different promises.
 * A death exit must break through Do Not Disturb; a DCA fill must not. The
 * engine already grades its own alerts — this maps that grading onto the only
 * thing Android lets the user actually control, which is the channel.
 *
 * `info` alerts are deliberately NOT notified at all. They are in the feed and
 * on the dashboard. A phone that buzzes on every heartbeat is a phone whose
 * notifications get turned off, and then the death exit does not arrive either.
 */
object Notifications {

    const val CHANNEL_CRITICAL = "critical"
    const val CHANNEL_ACTIVITY = "activity"
    const val CHANNEL_WATCH = "watch"

    /** Fixed id: the ongoing notification is replaced, never stacked. */
    const val ID_ONGOING = 1

    /** Alert notifications start above the fixed ids and use the alert sequence. */
    private const val ID_ALERT_BASE = 1000

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return

        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CRITICAL, "Riesgo", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Salidas por muerte, posiciones detenidas y el corte de emergencia. Estas te despiertan."
                enableVibration(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ACTIVITY, "Actividad", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Escaleras congeladas, escaneos vacíos, proveedores degradados."
            },
        )
        manager.createNotificationChannel(
            // MIN, because this one is always present. A permanent notification
            // that makes a sound is a permanent annoyance.
            NotificationChannel(CHANNEL_WATCH, "Vigilancia", NotificationManager.IMPORTANCE_MIN).apply {
                description = "El aviso permanente de que la app está vigilando el motor."
                setShowBadge(false)
            },
        )
    }

    /** The persistent notice. It is also the app's honest status line. */
    fun ongoing(context: Context, text: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_stat_operador)
            .setContentTitle("Operador")
            .setContentText(text)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(openApp(context))
            .build()

    fun update(context: Context, text: String) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        runCatching {
            NotificationManagerCompat.from(context).notify(ID_ONGOING, ongoing(context, text))
        }
    }

    /**
     * Raises one notification per alert, keyed by its sequence — so the same
     * alert seen twice replaces itself instead of arriving twice, and two
     * different alerts never collapse into one.
     */
    fun raise(context: Context, alert: Api.Alert) {
        val critical = alert.level == "critical"
        val channel = if (critical) CHANNEL_CRITICAL else CHANNEL_ACTIVITY

        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_operador)
            .setContentTitle(prefix(alert) + alert.title)
            .setContentText(alert.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.body))
            .setWhen(alert.at)
            .setAutoCancel(true)
            .setCategory(if (critical) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (critical) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openApp(context))
            .build()

        runCatching {
            NotificationManagerCompat.from(context).notify(ID_ALERT_BASE + alert.seq.toInt(), notification)
        }
    }

    private fun prefix(alert: Api.Alert): String = when (alert.kind) {
        "death-exit" -> "☠️ "
        "position-halted" -> "⛔ "
        "kill-switch" -> "🛑 "
        "ladder-frozen" -> "❄️ "
        else -> ""
    }

    private fun openApp(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }
}

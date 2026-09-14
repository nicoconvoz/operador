package com.opendoors.operador

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The part that keeps watching after you close the app.
 *
 * It polls the engine's alert log from a cursor and raises a system
 * notification for anything that is not routine. A foreground service is the
 * only way Android lets an app keep doing that, and the permanent notification
 * it requires is not a tax — it is the honest statement that something is
 * running on your behalf.
 *
 * Two deliberate choices:
 *
 * - **A cursor, not a subscription.** Telegram pushed and forgot; a phone that
 *   was off missed the message. Here the phone asks "what happened after
 *   sequence N", so being asleep costs latency, never the alert.
 * - **Unreachable is not quiet.** Losing the server is itself news. The
 *   ongoing notice says so rather than continuing to look healthy, because a
 *   monitor that cannot tell "nothing happened" from "I cannot see" is worse
 *   than no monitor.
 */
class WatchService : Service() {

    private val running = AtomicBoolean(false)
    private var worker: Thread? = null

    /** So a persistent failure is reported once, not every minute. */
    private var lastReportedTrouble: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground("Iniciando…")

        if (running.compareAndSet(false, true)) {
            worker = Thread({ loop() }, "operador-watch").apply {
                isDaemon = false
                start()
            }
        }
        // START_STICKY: if Android kills the process for memory, it comes back.
        // A watchdog that does not restart is a watchdog that was never there.
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        worker?.interrupt()
        super.onDestroy()
    }

    private fun startInForeground(text: String) {
        val notification = Notifications.ongoing(this, text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(Notifications.ID_ONGOING, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(Notifications.ID_ONGOING, notification)
        }
    }

    private fun loop() {
        val prefs = Prefs(this)
        while (running.get()) {
            if (prefs.configured && prefs.watching) {
                runCatching { poll(prefs) }.onFailure { Log.w(TAG, "poll failed", it) }
            } else {
                Notifications.update(this, if (prefs.configured) "En pausa" else "Sin servidor configurado")
            }

            val waitMs = prefs.pollSeconds * 1000L
            // Sleep in slices so stopping the service is immediate rather than
            // taking up to a full poll interval.
            val slice = 2_000L
            var slept = 0L
            while (running.get() && slept < waitMs) {
                try {
                    Thread.sleep(minOf(slice, waitMs - slept))
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return
                }
                slept += slice
            }
        }
    }

    private fun poll(prefs: Prefs) {
        when (val status = Api.status(prefs)) {
            is Api.Result.Ok -> {
                lastReportedTrouble = null
                drainAlerts(prefs, status.value.cursor)
                Notifications.update(this, describe(status.value))
            }
            is Api.Result.Refused -> trouble("El servidor rechazó: " + status.message)
            is Api.Result.Unreachable -> trouble("No se puede contactar al motor")
        }
    }

    /**
     * Reads forward from the phone's own cursor until it catches up.
     *
     * The cursor advances ONLY after the notifications for that page have been
     * raised. A crash between the read and the notification therefore replays
     * the page rather than skipping it — the same trade the Telegram poller
     * made, and for the same reason: a duplicate alert is a nuisance, a
     * missing one is the whole failure.
     */
    private fun drainAlerts(prefs: Prefs, serverCursor: Long) {
        if (serverCursor <= prefs.cursor) return

        // A fresh install starts from now rather than replaying a month of
        // history into the notification shade.
        if (prefs.cursor == 0L) {
            prefs.cursor = serverCursor
            return
        }

        var guard = 0
        while (prefs.cursor < serverCursor && guard < MAX_PAGES) {
            guard += 1
            val page = Api.alertsSince(prefs, prefs.cursor, PAGE_SIZE)
            if (page !is Api.Result.Ok) return

            val alerts = page.value
            if (alerts.isEmpty()) return

            for (alert in alerts) {
                // info stays in the feed. Notifying every heartbeat is how a
                // channel earns itself a permanent mute.
                if (alert.level != "info") Notifications.raise(this, alert)
            }
            prefs.cursor = alerts.last().seq
        }
    }

    private fun describe(status: Api.Status): String {
        val parts = mutableListOf<String>()
        parts += if (status.killSwitchEngaged) "DETENIDO" else "Funcionando"
        parts += status.positions.toString() + (if (status.positions == 1) " posición" else " posiciones")
        if (status.frozen > 0) parts += status.frozen.toString() + " congeladas"
        parts += if (status.engineStale) {
            // The failure that looks exactly like nothing happening.
            "motor en silencio desde " + stamp(status.lastEngineUpdate)
        } else {
            "visto " + stamp(status.lastEngineUpdate)
        }
        return parts.joinToString(" · ")
    }

    private fun stamp(at: Long?): String =
        if (at == null) "nunca" else SimpleDateFormat("HH:mm", Locale.US).format(Date(at))

    private fun trouble(message: String) {
        Notifications.update(this, message)
        if (lastReportedTrouble == message) return
        lastReportedTrouble = message
        Log.w(TAG, message)
    }

    companion object {
        private const val TAG = "OperadorWatch"
        private const val PAGE_SIZE = 50
        private const val MAX_PAGES = 20

        fun start(context: Context) {
            val intent = Intent(context, WatchService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, WatchService::class.java))
        }
    }
}

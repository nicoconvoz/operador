package com.opendoors.operador

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * A phone reboots at 4am for an update and the watch is gone until someone
 * opens the app — which, for a monitor, means it was never a monitor. This
 * brings it back.
 *
 * Only if the user had it watching: a reboot must not undo a deliberate pause.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = Prefs(context)
        if (prefs.configured && prefs.watching) WatchService.start(context)
    }
}

package com.opendoors.operador

import android.content.Context
import android.content.SharedPreferences

/**
 * Everything the app needs to know, and nothing it should not keep.
 *
 * The control token lives in private SharedPreferences. It is worth being
 * clear about what it protects: the token can only STOP the engine. It cannot
 * place an order, move a coin, or reach a wallet — so the worst a stolen token
 * buys is the ability to halt your own trading, which is the failure mode we
 * chose on purpose.
 */
class Prefs(context: Context) {

    private val store: SharedPreferences =
        context.applicationContext.getSharedPreferences("operador", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = store.getString(KEY_URL, "") ?: ""
        set(value) = store.edit().putString(KEY_URL, normalise(value)).apply()

    var controlToken: String
        get() = store.getString(KEY_TOKEN, "") ?: ""
        set(value) = store.edit().putString(KEY_TOKEN, value.trim()).apply()

    /**
     * The last alert sequence this phone has actually shown. The server is
     * asked for what came after it, so a notification is never raised twice
     * and a phone that was off catches up rather than starting from now.
     */
    var cursor: Long
        get() = store.getLong(KEY_CURSOR, 0L)
        set(value) = store.edit().putLong(KEY_CURSOR, value).apply()

    var pollSeconds: Int
        get() = store.getInt(KEY_POLL, DEFAULT_POLL_SECONDS)
        set(value) = store.edit().putInt(KEY_POLL, value.coerceIn(30, 3600)).apply()

    var watching: Boolean
        get() = store.getBoolean(KEY_WATCHING, true)
        set(value) = store.edit().putBoolean(KEY_WATCHING, value).apply()

    val configured: Boolean get() = serverUrl.isNotEmpty()

    fun endpoint(path: String): String = serverUrl.trimEnd('/') + path

    companion object {
        private const val KEY_URL = "server_url"
        private const val KEY_TOKEN = "control_token"
        private const val KEY_CURSOR = "cursor"
        private const val KEY_POLL = "poll_seconds"
        private const val KEY_WATCHING = "watching"

        /**
         * A minute. Fast enough that a death exit reaches the phone while it
         * still matters, slow enough to be invisible on the battery — and the
         * engine only decides once every fifteen anyway.
         */
        const val DEFAULT_POLL_SECONDS = 60

        /** Accepts "192.168.1.5:3100" and makes it a URL. */
        fun normalise(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) return ""
            val hasScheme = trimmed.startsWith("http://") || trimmed.startsWith("https://")
            return if (hasScheme) trimmed else "http://" + trimmed
        }
    }
}

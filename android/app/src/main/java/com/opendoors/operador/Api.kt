package com.opendoors.operador

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * The engine, over HTTP. Built on HttpURLConnection and org.json, both of
 * which ship with Android — three libraries to poll two endpoints would be
 * more dependency than program.
 *
 * Every call returns a result rather than throwing, and "could not reach the
 * server" is a DIFFERENT result from "the server said no". A monitor that
 * collapses those two treats a lost signal as good news, which is the exact
 * failure it exists to prevent.
 */
object Api {

    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>

        /** Reached the server; it refused. */
        data class Refused(val status: Int, val message: String) : Result<Nothing>

        /** Never reached it. */
        data class Unreachable(val cause: String) : Result<Nothing>
    }

    data class Status(
        val killSwitchEngaged: Boolean,
        val engineStale: Boolean,
        val lastEngineUpdate: Long?,
        val positions: Int,
        val frozen: Int,
        val cursor: Long,
    )

    data class Alert(
        val seq: Long,
        val kind: String,
        val level: String,
        val at: Long,
        val title: String,
        val body: String,
    )

    private const val TIMEOUT_MS = 12_000

    fun status(prefs: Prefs): Result<Status> = map(request(prefs.endpoint("/api/phone"), null, null)) { json ->
        Status(
            killSwitchEngaged = json.optBoolean("killSwitchEngaged", false),
            engineStale = json.optBoolean("engineStale", true),
            lastEngineUpdate = if (json.isNull("lastEngineUpdate")) null else json.optLong("lastEngineUpdate"),
            positions = json.optInt("positions", 0),
            frozen = json.optInt("frozen", 0),
            cursor = json.optLong("cursor", 0L),
        )
    }

    fun alertsSince(prefs: Prefs, since: Long, limit: Int = 50): Result<List<Alert>> {
        val url = prefs.endpoint("/api/alerts?since=" + since + "&limit=" + limit)
        return map(request(url, null, null)) { json ->
            val array: JSONArray = json.optJSONArray("alerts") ?: JSONArray()
            (0 until array.length()).map { index ->
                val item = array.getJSONObject(index)
                Alert(
                    seq = item.optLong("seq"),
                    kind = item.optString("kind"),
                    level = item.optString("level", "info"),
                    at = item.optLong("at"),
                    title = item.optString("title"),
                    body = item.optString("body"),
                )
            }
        }
    }

    /** Stops the engine, or lets it go again. The only write the app can make. */
    fun control(prefs: Prefs, action: String, detail: String): Result<Boolean> {
        if (prefs.controlToken.isEmpty()) return Result.Refused(401, "no control token set")
        val body = JSONObject().put("action", action).put("detail", detail).toString()
        return map(request(prefs.endpoint("/api/control"), body, prefs.controlToken)) { json ->
            json.optBoolean("engaged", action == "kill")
        }
    }

    private fun <T, R> map(result: Result<T>, transform: (T) -> R): Result<R> = when (result) {
        is Result.Ok -> try {
            Result.Ok(transform(result.value))
        } catch (e: Exception) {
            Result.Refused(200, "unreadable response: " + e.message)
        }
        is Result.Refused -> result
        is Result.Unreachable -> result
    }

    private fun request(url: String, body: String?, token: String?): Result<JSONObject> {
        var connection: HttpURLConnection? = null
        return try {
            val opened = URL(url).openConnection() as HttpURLConnection
            connection = opened
            opened.connectTimeout = TIMEOUT_MS
            opened.readTimeout = TIMEOUT_MS
            opened.requestMethod = if (body == null) "GET" else "POST"
            opened.setRequestProperty("Accept", "application/json")
            if (token != null) opened.setRequestProperty("Authorization", "Bearer " + token)
            if (body != null) {
                opened.doOutput = true
                opened.setRequestProperty("Content-Type", "application/json")
                opened.outputStream.use { it.write(body.toByteArray()) }
            }

            val status = opened.responseCode
            val stream = if (status in 200..299) opened.inputStream else opened.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()

            if (status !in 200..299) {
                val message = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
                Result.Refused(status, message.ifEmpty { "HTTP " + status })
            } else {
                Result.Ok(JSONObject(text.ifEmpty { "{}" }))
            }
        } catch (e: Exception) {
            Result.Unreachable(e.message ?: e.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }
}

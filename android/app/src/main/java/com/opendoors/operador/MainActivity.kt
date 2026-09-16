package com.opendoors.operador

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * The dashboard, on a phone.
 *
 * An APK cannot contain the system: the dashboard is a server that reads
 * Postgres, and no phone hosts that. So this is a shell around a URL — and
 * saying so plainly matters, because an app that pretends to hold the data
 * would leave you staring at a cached screen during exactly the outage you
 * needed to see.
 *
 * What it adds over a browser tab is the part a browser cannot do: it keeps
 * watching when it is closed, and it can stop the engine.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private var webView: WebView? = null
    private var statusLabel: TextView? = null

    private val main = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        Notifications.createChannels(this)
        requestNotificationPermission()
        render()
    }

    // No reload on resume. The page refreshes itself by fetching, and it does
    // so when it becomes visible — reloading on top of that threw away the
    // canvas, snapped every orbit back to its starting angle and dropped the
    // viewer's selection, which reads as the screen flinching for no reason.
    // The ⟳ button stays, for when someone wants the whole page rebuilt.

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val view = webView
        if (view != null && view.canGoBack()) view.goBack() else super.onBackPressed()
    }

    // ---------------------------------------------------------------- render

    private fun render() {
        if (!prefs.configured) {
            setContentView(setupScreen())
            return
        }
        setContentView(dashboardScreen())
        if (prefs.watching) WatchService.start(this)
    }

    /** First run: the app has to be told where the engine lives. */
    private fun setupScreen(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
            setPadding(dp(24), dp(48), dp(24), dp(24))
        }

        root.addView(heading("Operador by Open Doors"))
        root.addView(
            note(
                "Esta app muestra el panel de tu motor y lo vigila mientras está cerrada. " +
                    "No ejecuta el motor: apúntala a la máquina que lo corre.",
            ),
        )

        val url = field("http://192.168.1.10:3100", prefs.serverUrl)
        root.addView(label("Dirección del servidor"))
        root.addView(url)

        val token = field("opcional", prefs.controlToken)
        token.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        root.addView(label("Token de control"))
        root.addView(
            note("Solo hace falta para detener el motor desde el teléfono. Nunca puede abrir una orden."),
        )
        root.addView(token)

        root.addView(
            Button(this).apply {
                text = "Conectar"
                setOnClickListener {
                    val candidate = Prefs.normalise(url.text.toString())
                    if (candidate.isEmpty()) {
                        toast("Ingresa la dirección de la máquina que corre el motor")
                        return@setOnClickListener
                    }
                    prefs.serverUrl = candidate
                    prefs.controlToken = token.text.toString()
                    render()
                }
                layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(20) }
            },
        )

        return ScrollView(this).apply {
            setBackgroundColor(BACKGROUND)
            addView(root)
        }
    }

    private fun dashboardScreen(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
            fitsSystemWindows = true
        }

        root.addView(topBar())

        val content = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
        }
        content.addView(buildWebView())
        root.addView(content)

        reload()
        return root
    }

    private fun topBar(): View {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(BACKGROUND)
            setPadding(dp(14), dp(8), dp(8), dp(8))
        }

        statusLabel = TextView(this).apply {
            text = hostOf(prefs.serverUrl)
            setTextColor(DIM)
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f)
        }
        bar.addView(statusLabel)

        // The kill switch, spelled out. It was a power glyph until a device
        // without that codepoint drew it as an empty box — the most
        // consequential control in the app, rendered as nothing. A word cannot
        // go missing from a font.
        bar.addView(stopButton())
        bar.addView(barButton("⟳") { reload() })
        bar.addView(barButton("⚙") { openSettings() })
        return bar
    }

    private fun stopButton(): TextView = TextView(this).apply {
        text = "PARAR"
        setTextColor(Color.parseColor("#ff6b6b"))
        textSize = 12f
        setPadding(dp(10), dp(5), dp(10), dp(5))
        background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = dp(6).toFloat()
            setStroke(dp(1), Color.parseColor("#5a2a2a"))
        }
        isClickable = true
        setOnClickListener { confirmKillSwitch() }
    }

    private fun barButton(glyph: String, onClick: () -> Unit): TextView = TextView(this).apply {
        text = glyph
        setTextColor(Color.parseColor("#c9d1d9"))
        textSize = 17f
        setPadding(dp(14), dp(6), dp(14), dp(6))
        isClickable = true
        setOnClickListener { onClick() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val view = WebView(this)
        view.setBackgroundColor(BACKGROUND) // No white flash before the page paints.
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
            builtInZoomControls = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }
        // A WebView ignores downloads unless told otherwise — the link does
        // nothing at all, with no error and no hint that anything was meant to
        // happen. The tape is capped at ten rows on screen and the rest lives
        // behind that link, so silently dropping it would put the audit trail
        // out of reach of the device the operator actually watches this on.
        //
        // Handed to the SYSTEM browser rather than downloaded here: it already
        // knows how to save a file, ask for permission, and show it in the
        // notification shade, and none of that is worth reimplementing for one
        // CSV.
        view.setDownloadListener { url, _, _, _, _ ->
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: Exception) {
                // No browser to take it. Saying so beats a button that does
                // nothing twice.
                Toast.makeText(this, "No hay navegador para abrir la descarga", Toast.LENGTH_SHORT).show()
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                // Only the main document: a failed favicon must not paint an
                // error over a page that loaded fine.
                if (request?.isForMainFrame != true) return
                showLoadFailure()
            }

            /**
             * The renderer died. Survive it.
             *
             * Android runs a WebView's rendering in its OWN process and reclaims
             * it under memory pressure — and a canvas animating at 60fps is a
             * prime candidate. Returning false, which is what NOT overriding
             * this does, tells Android to kill the whole app process with it.
             *
             * From the outside that is indistinguishable from the app reopening
             * on its own: the process dies, Android restarts it, onCreate runs,
             * and the reader is back on the first screen at the top. Which is
             * exactly what it looked like, because it is exactly what happened.
             *
             * The dead WebView cannot be reused — it has to be thrown away and
             * rebuilt. Returning true is what keeps everything else alive:
             * the foreground service, the alert cursor, the process.
             */
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                val container = view?.parent as? FrameLayout
                view?.let {
                    container?.removeView(it)
                    it.destroy()
                }
                webView = null

                if (container != null) {
                    container.addView(buildWebView())
                    reload()
                    // Said out loud. A screen that silently rebuilt itself is a
                    // screen the reader cannot trust, and this is the one event
                    // that used to take the app down without explanation.
                    toast(
                        if (detail?.didCrash() == true) "El visor se cayó y se reconstruyó"
                        else "Android liberó memoria; el visor se reconstruyó",
                    )
                }
                return true
            }
        }
        view.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)
        webView = view
        return view
    }

    private fun reload() {
        webView?.loadUrl(prefs.serverUrl)
    }

    private fun showLoadFailure() {
        val view = webView ?: return
        val message = "No se pudo contactar a " + hostOf(prefs.serverUrl) +
            ". El panel del motor tiene que estar corriendo y en la misma red."
        view.loadDataWithBaseURL(
            null,
            """
            <html><body style="background:#0d1117;color:#8b949e;font:14px system-ui;padding:32px">
              <p style="color:#ff6b6b">$message</p>
              <p>Verifica la dirección en la máquina que corre <code>npm run dev</code>.</p>
            </body></html>
            """.trimIndent(),
            "text/html",
            "utf-8",
            null,
        )
    }

    // -------------------------------------------------------------- controls

    /**
     * The kill switch, behind a confirmation.
     *
     * Confirmed because a mis-tap that stops a running engine is expensive,
     * and because "are you sure" is the cheapest possible guard against a
     * pocket. It stops NEW positions only — the death watch keeps running on
     * everything already open, which is the asymmetry the engine was built
     * around.
     */
    private fun confirmKillSwitch() {
        if (prefs.controlToken.isEmpty()) {
            toast("Primero configura un token de control en Ajustes")
            openSettings()
            return
        }

        AlertDialog.Builder(this)
            .setTitle("¿Detener la apertura de nuevas posiciones?")
            .setMessage(
                "El motor deja de entrar en nada nuevo. Las posiciones abiertas se MANTIENEN y la vigilancia " +
                    "de muerte sigue corriendo sobre ellas. No se vende nada.",
            )
            .setPositiveButton("Detener el motor") { _, _ -> sendControl("kill") }
            .setNeutralButton("Volver a arrancarlo") { _, _ -> sendControl("resume") }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    private fun sendControl(action: String) {
        Thread {
            val result = Api.control(prefs, action, "from the Android app")
            main.post {
                when (result) {
                    is Api.Result.Ok ->
                        toast(if (result.value) "Motor DETENIDO" else "Motor funcionando de nuevo")
                    is Api.Result.Refused ->
                        toast("Rechazado: " + result.message)
                    is Api.Result.Unreachable ->
                        toast("No se pudo contactar al motor: queda como estaba")
                }
                // The page picks the new state up on its next poll; forcing a
                // reload here would undo exactly the flicker this removed.
            }
        }.start()
    }

    private fun openSettings() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(14), dp(22), dp(0))
        }

        val url = field("http://192.168.1.10:3100", prefs.serverUrl)
        layout.addView(label("Dirección del servidor"))
        layout.addView(url)

        val token = field("opcional", prefs.controlToken)
        token.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        layout.addView(label("Token de control"))
        layout.addView(token)

        val poll = field("60", prefs.pollSeconds.toString())
        poll.inputType = InputType.TYPE_CLASS_NUMBER
        layout.addView(label("Consultar cada (segundos)"))
        layout.addView(poll)

        val watchToggle = Button(this).apply {
            text = if (prefs.watching) "Vigilando en segundo plano — toca para pausar" else "En pausa — toca para vigilar"
            setOnClickListener {
                prefs.watching = !prefs.watching
                if (prefs.watching) WatchService.start(this@MainActivity) else WatchService.stop(this@MainActivity)
                text = if (prefs.watching) "Vigilando en segundo plano — toca para pausar" else "En pausa — toca para vigilar"
            }
        }
        layout.addView(watchToggle)

        if (!ignoringBatteryOptimisations()) {
            layout.addView(
                note(
                    "Android puede retrasar las consultas de esta app mientras el teléfono duerme. " +
                        "Exceptúala de la optimización de batería para respetar el intervalo.",
                ),
            )
            layout.addView(
                Button(this).apply {
                    text = "Permitir consultas en segundo plano"
                    setOnClickListener { requestBatteryExemption() }
                },
            )
        }

        AlertDialog.Builder(this)
            .setTitle("Ajustes")
            .setView(ScrollView(this).apply { addView(layout) })
            .setPositiveButton("Guardar") { _, _ ->
                prefs.serverUrl = url.text.toString()
                prefs.controlToken = token.text.toString()
                prefs.pollSeconds = poll.text.toString().toIntOrNull() ?: Prefs.DEFAULT_POLL_SECONDS
                statusLabel?.text = hostOf(prefs.serverUrl)
                render()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    // ----------------------------------------------------------- permissions

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!granted) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    private fun ignoringBatteryOptimisations(): Boolean {
        val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return true
        return power.isIgnoringBatteryOptimizations(packageName)
    }

    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        runCatching {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
            )
        }.onFailure {
            // Some OEM builds hide the direct intent; the list screen always exists.
            runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
        }
    }

    // ---------------------------------------------------------------- pieces

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(Color.WHITE)
        textSize = 19f
        setPadding(0, 0, 0, dp(8))
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(DIM)
        textSize = 12f
        setPadding(0, dp(14), 0, dp(2))
    }

    private fun note(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(DIM)
        textSize = 12f
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun field(hint: String, value: String) = EditText(this).apply {
        this.hint = hint
        setText(value)
        setTextColor(Color.WHITE)
        setHintTextColor(Color.parseColor("#4d5764"))
        textSize = 15f
        setSingleLine()
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private fun hostOf(url: String): String = runCatching { Uri.parse(url).authority ?: url }.getOrDefault(url)

    private companion object {
        val BACKGROUND: Int = Color.parseColor("#0d1117")
        val DIM: Int = Color.parseColor("#8b949e")

    }
}

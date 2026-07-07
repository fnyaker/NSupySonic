package org.nsupysonic.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Full-screen WebView hosting the NSupySonic SPA (<server>/app/), bridged to
 * PlayerService so playback gets a real MediaSession + foreground service.
 *
 * The bridge is injected from HERE (assets/nsshim.js replaces
 * navigator.mediaSession before the page runs), so it works with whatever SPA
 * version the server ships — no webapp change or server rebuild required.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var webView: WebView
    private lateinit var errorView: View
    private lateinit var shimJs: String

    private var service: PlayerService? = null
    private var bound = false
    private var serviceStarted = false
    private var pendingState: PlayerService.State? = null
    private var mainFrameFailed = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = (binder as PlayerService.LocalBinder).service
            service?.commandSink = { cmd, value -> runOnUiThread { runJsCommand(cmd, value) } }
            pendingState?.let { service?.update(it) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
        }
    }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) toastNotificationsHint()
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (!prefs.configured) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webview)
        errorView = findViewById(R.id.error_view)
        findViewById<View>(R.id.btn_retry).setOnClickListener { reload() }
        findViewById<View>(R.id.btn_settings).setOnClickListener { openSettings() }

        shimJs = assets.open("nsshim.js").bufferedReader().use { it.readText() }

        askNotificationPermission()

        // Bind (without starting) right away so the command sink is wired
        // before the first playback state shows up.
        bound = bindService(
            Intent(this, PlayerService::class.java), connection, Context.BIND_AUTO_CREATE
        )

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Auto-advance to the next track must not require a tap.
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString NSupySonicApp/1.0"
        }
        webView.addJavascriptInterface(Bridge(), "NSNative")

        // Install the mediaSession-capturing shim before any page script runs.
        // The onPageStarted fallback below covers WebViews without the feature
        // (the shim is idempotent, double injection is harmless).
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
            WebViewCompat.addDocumentStartJavaScript(webView, shimJs, setOf("*"))

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(
                view: WebView?, url: String?, favicon: android.graphics.Bitmap?
            ) {
                view?.evaluateJavascript(shimJs, null)
            }

            override fun onReceivedSslError(
                view: WebView?, handler: SslErrorHandler?, error: SslError?
            ) {
                // Opt-in only: the user unticked "verify SSL" for a self-signed cert.
                if (!prefs.verifySsl) handler?.proceed()
                else {
                    handler?.cancel()
                    showError(getString(R.string.error_ssl))
                }
            }

            override fun onReceivedError(
                view: WebView?, request: WebResourceRequest?, error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true)
                    showError(getString(R.string.error_unreachable, prefs.baseUrl()))
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false
                // Keep the app's own origin inside; hand anything else to the system.
                if (url.toString().startsWith(prefs.baseUrl())) return false
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (_: Exception) {
                    true
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                if (!mainFrameFailed) errorView.visibility = View.GONE
            }

            override fun onRenderProcessGone(
                view: WebView?, detail: RenderProcessGoneDetail?
            ): Boolean {
                // The renderer died (OOM kill). Rebuild the whole activity —
                // reusing the dead WebView would crash the app.
                recreate()
                return true
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                // Keep the process (and the music) alive instead of finishing.
                else moveTaskToBack(true)
            }
        })

        webView.loadUrl(prefs.appUrl())
    }

    // Reopening the settings relaunches us (singleTask) via onNewIntent rather
    // than onCreate, so the WebView keeps showing the OLD server until the app
    // is killed. Reload here when the configured origin no longer matches what's
    // loaded, so a host/port/SSL change takes effect immediately.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!prefs.configured) return
        if (::webView.isInitialized &&
            webView.url?.startsWith(prefs.baseUrl()) != true
        ) {
            mainFrameFailed = false
            errorView.visibility = View.GONE
            webView.loadUrl(prefs.appUrl())
        }
    }

    // NOTE: webView.onPause() is deliberately NOT called from onPause() — that
    // is precisely what killed background playback in the browser. The
    // foreground service keeps the process alive; the WebView keeps decoding.

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else if (!NotificationManagerCompat.from(this).areNotificationsEnabled())
            toastNotificationsHint()
    }

    private fun toastNotificationsHint() {
        Toast.makeText(this, R.string.notifications_hint, Toast.LENGTH_LONG).show()
    }

    private fun reload() {
        mainFrameFailed = false
        errorView.visibility = View.GONE
        webView.loadUrl(prefs.appUrl())
    }

    private fun openSettings() {
        startActivity(
            Intent(this, SetupActivity::class.java).putExtra(SetupActivity.EXTRA_FORCE, true)
        )
    }

    private fun showError(message: String) {
        mainFrameFailed = true
        findViewById<TextView>(R.id.error_message).text = message
        errorView.visibility = View.VISIBLE
    }

    private fun runJsCommand(cmd: String, value: Double?) {
        if (!::webView.isInitialized) return
        val arg = value?.let { ", $it" } ?: ""
        webView.evaluateJavascript(
            "window.__nsNativeCmd && window.__nsNativeCmd('$cmd'$arg)", null
        )
    }

    private fun handleState(state: PlayerService.State) {
        if (!state.active) return
        // Promote to a foreground service on the FIRST actual playback — not on
        // mere app open with a restored (paused) session, which would flash a
        // pointless notification.
        if (!serviceStarted) {
            if (!state.playing) {
                pendingState = state
                return
            }
            serviceStarted = true
            ContextCompat.startForegroundService(this, Intent(this, PlayerService::class.java))
        }
        pendingState = state
        service?.update(state)
    }

    inner class Bridge {
        @JavascriptInterface
        fun publish(json: String) {
            val state = PlayerService.State.fromJson(json) ?: return
            runOnUiThread { handleState(state) }
        }

        @JavascriptInterface
        fun openServerSettings() {
            runOnUiThread { openSettings() }
        }
    }

    override fun onDestroy() {
        if (bound) {
            service?.commandSink = null
            try {
                unbindService(connection)
            } catch (_: Exception) {
            }
            // The WebView (the actual audio) dies with us — take the service down.
            if (isFinishing) stopService(Intent(this, PlayerService::class.java))
        }
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}

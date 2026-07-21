package org.nsupysonic.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.IBinder
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
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
import androidx.core.content.FileProvider
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

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
    private val shareExecutor = Executors.newSingleThreadExecutor()

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
            // Only relax mixed content for the self-signed / http home-server case
            // (SSL verification turned off). With verification ON, keep the safer
            // compatibility mode instead of blanket-allowing http on an https page.
            mixedContentMode =
                if (prefs.verifySsl) WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                else WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString NSupySonicApp/1.0"
        }
        webView.addJavascriptInterface(Bridge(), "NSNative")

        // A plain WebView silently drops any navigation whose response is
        // Content-Disposition: attachment (the share sheet's "Télécharger"
        // button, and its Web Share fallback on devices without navigator.share)
        // — without this listener nothing visible happens at all. Hand the
        // request off to the system DownloadManager instead, carrying the
        // session cookie so the auth-protected /api/share/* URLs still work.
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startDownload(url, userAgent, contentDisposition, mimeType)
        }

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
                // Keep the app's own origin inside; hand anything else to the
                // system. Compare scheme/host/port (a bare startsWith let
                // "https://host.evil.com" or "https://host:57223" masquerade as
                // the configured "https://host[:5722]").
                val base = android.net.Uri.parse(prefs.baseUrl())
                if (url.scheme == base.scheme && url.host == base.host && url.port == base.port)
                    return false
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

    private fun startDownload(
        url: String, userAgent: String?, contentDisposition: String?, mimeType: String?
    ) {
        val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
        try {
            val cookie = CookieManager.getInstance().getCookie(url)
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                if (!cookie.isNullOrEmpty()) addRequestHeader("Cookie", cookie)
                if (!userAgent.isNullOrEmpty()) addRequestHeader("User-Agent", userAgent)
                setMimeType(mimeType?.takeIf { it.isNotEmpty() } ?: "application/octet-stream")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                setTitle(fileName)
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            Toast.makeText(this, getString(R.string.download_started, fileName), Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
            // A full Downloads dir, DownloadManager disabled by the user, etc.
            // — surface it rather than silently doing nothing.
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show()
        }
    }

    // Web Share API file support is spotty inside a plain android.webkit.WebView
    // (unlike Chrome proper, it typically has no file-sharing plumbing wired up,
    // only text/url) — so ShareSheet.svelte calls this bridge directly instead
    // of navigator.share when it detects window.NSNative.shareFile. Fetching +
    // handing off natively guarantees a real OS share sheet regardless of the
    // hosting WebView's Web Share API completeness.
    private fun startShare(rawUrl: String) {
        val verify = prefs.verifySsl
        val cookie = try {
            CookieManager.getInstance().getCookie(rawUrl)
        } catch (_: Exception) {
            null
        }
        shareExecutor.execute {
            try {
                val conn = URL(rawUrl).openConnection() as HttpURLConnection
                Ssl.apply(conn, verify)
                conn.connectTimeout = 15000
                conn.readTimeout = 60000
                conn.instanceFollowRedirects = true
                if (!cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", cookie)
                if (conn.responseCode !in 200..299)
                    throw java.io.IOException("HTTP ${conn.responseCode}")
                val mimeType =
                    conn.contentType?.substringBefore(";")?.trim().takeUnless { it.isNullOrEmpty() }
                        ?: "application/octet-stream"
                val fileName =
                    URLUtil.guessFileName(rawUrl, conn.getHeaderField("Content-Disposition"), mimeType)

                // One slot: a fresh share replaces whatever was queued before —
                // nothing here needs to outlive the single chooser it feeds.
                val dir = File(cacheDir, "shared").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val outFile = File(dir, fileName)
                conn.inputStream.use { input -> outFile.outputStream().use { input.copyTo(it) } }

                val uri = FileProvider.getUriForFile(
                    this@MainActivity, "$packageName.fileprovider", outFile
                )
                runOnUiThread {
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = mimeType
                        putExtra(Intent.EXTRA_STREAM, uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    startActivity(Intent.createChooser(send, null))
                }
            } catch (_: Exception) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, R.string.share_failed, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun runJsCommand(cmd: String, value: Double?) {
        if (!::webView.isInitialized) return
        val arg = value?.let { ", $it" } ?: ""
        webView.evaluateJavascript(
            "window.__nsNativeCmd && window.__nsNativeCmd('$cmd'$arg)", null
        )
    }

    private fun handleState(state: PlayerService.State) {
        if (!state.active) {
            // Playback wound down (queue emptied / logged out): let the service
            // clear its media notification instead of leaving a stale one up.
            if (serviceStarted) service?.update(state)
            pendingState = state
            return
        }
        // Promote to a foreground service on the FIRST actual playback — not on
        // mere app open with a restored (paused) session, which would flash a
        // pointless notification.
        if (!serviceStarted) {
            if (!state.playing) {
                pendingState = state
                return
            }
            try {
                ContextCompat.startForegroundService(this, Intent(this, PlayerService::class.java))
            } catch (_: Exception) {
                // Background FGS-start can be blocked (Android 12+) if we slipped
                // to the background between the play tap and this call — retry on
                // the next state once we're foregrounded again.
                pendingState = state
                return
            }
            serviceStarted = true
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

        // Detected by ShareSheet.svelte (window.NSNative.shareFile) in preference
        // to navigator.share/canShare, which is unreliable for files in a plain
        // WebView. `url` is the absolute /api/share/(file|clip)/... URL.
        @JavascriptInterface
        fun shareFile(url: String) {
            startShare(url)
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
        shareExecutor.shutdownNow()
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}

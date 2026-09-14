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
import android.content.ContentValues
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.os.IBinder
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
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
import androidx.lifecycle.Lifecycle
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.dialog.MaterialAlertDialogBuilder
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

    companion object {
        /** Upper bound on a single Bridge.saveText payload (16 MB of chars). */
        private const val MAX_SAVE_TEXT = 16 * 1024 * 1024
        /** How long away counts as "long enough that the page may be gone". */
        private const val PING_AFTER_MS = 45_000L
        /** How long the page gets to answer that ping before we rebuild it. */
        private const val PING_TIMEOUT_MS = 5_000L
    }

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
    // Set the moment the WebView is destroyed (renderer death or activity
    // teardown). TOUCHING a destroyed WebView — evaluateJavascript, loadUrl,
    // even leaving it in the view tree to be drawn — is a native use-after-free
    // in the WebView provider, which is exactly what a memory-tagging /
    // hardened-allocator build turns from "usually gets away with it" into a
    // hard crash. Every entry point below checks this first.
    private var webViewDead = false
    // The WebView must be rebuilt before there is anything to look at: the
    // renderer died while we were in the background, and rebuilding is deferred
    // to the moment the user actually comes back (see onRenderProcessGone).
    private var pendingRebuild = false
    // Last in-app URL the page reached, so a rebuild puts the user back on the
    // screen they left instead of at the app's front door.
    private var lastAppUrl: String? = null
    // When we were last stopped, so onResume can tell a quick trip to the
    // settings from hours in the background.
    private var leftAt = 0L
    private var pingToken = 0

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = (binder as PlayerService.LocalBinder).service
            service?.commandSink = { cmd, value -> runOnUiThread { runJsCommand(cmd, value) } }
            pendingState?.let { service?.update(it) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // The sink closes over THIS activity's WebView; a service that comes
            // back (onServiceConnected) installs a fresh one.
            service?.commandSink = null
            service = null
        }
    }

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) toastNotificationsHint()
        }

    // Réglages → "Se connecter avec mon compte Deezer": DeezerLoginActivity
    // hosts Deezer's own login page and hands back nothing but the resulting
    // ARL, which the SPA then saves through /api/settings.
    private var deezerLoginPending = false
    private val deezerLoginLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            deezerLoginPending = false
            val arl = result.data?.getStringExtra(DeezerLoginActivity.EXTRA_ARL)
            deliverArl(if (result.resultCode == RESULT_OK) arl else null)
        }

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

        configureWebView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!webViewDead && webView.canGoBack()) webView.goBack()
                // Keep the process (and the music) alive instead of finishing.
                else moveTaskToBack(true)
            }
        })

        webView.loadUrl(prefs.appUrl())
    }

    /**
     * Everything that makes a bare WebView *our* WebView. Split out of onCreate
     * so a WebView whose renderer the system killed can be replaced by an
     * identically configured one, in place, without restarting the activity.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView) {
        wv.settings.apply {
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
        wv.addJavascriptInterface(Bridge(), "NSNative")

        // A plain WebView silently drops any navigation whose response is
        // Content-Disposition: attachment (the share sheet's "Télécharger"
        // button, and its Web Share fallback on devices without navigator.share)
        // — without this listener nothing visible happens at all. Hand the
        // request off to the system DownloadManager instead, carrying the
        // session cookie so the auth-protected /api/share/* URLs still work.
        wv.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            startDownload(url, userAgent, contentDisposition, mimeType)
        }

        // Install the mediaSession-capturing shim before any page script runs,
        // scoped to the configured server's origin — NOT "*", which handed the
        // shim (and the NSNative bridge it drives) to any page or cross-origin
        // frame the WebView happened to load. The onPageStarted fallback below
        // covers WebViews without the feature, and any origin rule the API
        // rejects (the shim is idempotent, double injection is harmless).
        val origin = serverOrigin()
        if (origin != null &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) {
            try {
                WebViewCompat.addDocumentStartJavaScript(wv, shimJs, setOf(origin))
            } catch (_: Exception) {
                // Unsupported origin rule — onPageStarted still injects it.
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun onPageStarted(
                view: WebView?, url: String?, favicon: android.graphics.Bitmap?
            ) {
                if (isServerUrl(url)) view?.evaluateJavascript(shimJs, null)
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
                // system. Compares scheme/host/port (a bare startsWith let
                // "https://host.evil.com" or "https://host:57223" masquerade as
                // the configured "https://host[:5722]").
                if (isServerUri(url)) return false
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

            // Every navigation the page makes, hash routes included: the screen
            // a rebuilt WebView should come back to.
            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                if (isServerUrl(url)) lastAppUrl = url
            }

            override fun onRenderProcessGone(
                view: WebView?, detail: RenderProcessGoneDetail?
            ): Boolean {
                // The renderer died (OOM kill). The WebView is now unusable: it
                // must be detached and destroyed BEFORE anything else touches
                // it. Merely leaving it in the layout until the activity is torn
                // down means the view system keeps measuring/drawing a WebView
                // whose renderer is gone — a native use-after-free, and one of
                // the few crashes an app hosting a WebView can actually cause.
                disposeWebView()
                // The audio went with the renderer, so the media notification
                // is now a card whose buttons reach nothing. Take it down.
                dropPlayback()
                // Rebuild only for a user who is there to see it. Reloading the
                // page with the screen off is what turned a long background
                // pause into "I have to restart the app": the reload can fail
                // (off the home network, no connectivity), parking the app on an
                // error screen, and the fresh renderer it built is every bit as
                // killable as the one we just lost — so it could die again, and
                // again, until the user came back to a blank page. Waiting costs
                // nothing: there is no audio left to keep alive.
                pendingRebuild = true
                if (!isFinishing && !isDestroyed &&
                    lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
                ) {
                    // Posted: we are inside a callback from the WebView provider
                    // whose WebView we just destroyed — let that stack unwind
                    // before building its replacement.
                    errorView.post { rebuildWebView() }
                }
                return true
            }
        }
    }

    /**
     * Replace a dead (or wedged) WebView with a fresh one, on the screen the
     * user was last on.
     *
     * This is the whole answer to "I left it paused in the background and had to
     * restart the app": the audio, the queue and the UI all live in the
     * renderer process, which Android is free to kill while nobody is looking at
     * it, and a destroyed WebView can only ever show a blank page again. The
     * SPA persists its session, so a rebuilt page comes back on the same track
     * at the same position.
     */
    private fun rebuildWebView() {
        if (isFinishing || isDestroyed) return
        disposeWebView() // no-op when the renderer death already did it
        val root = findViewById<FrameLayout>(R.id.root) ?: return
        val wv = WebView(this)
        wv.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
        )
        // Index 0: under the error overlay, exactly where the XML had it.
        root.addView(wv, 0)
        webView = wv
        webViewDead = false
        pendingRebuild = false
        pingToken++ // a liveness ping still in flight is about a WebView that's gone
        mainFrameFailed = false
        errorView.visibility = View.GONE
        configureWebView(wv)
        val back = lastAppUrl?.takeIf { isServerUrl(it) } ?: prefs.appUrl()
        wv.loadUrl(back)
        offerBatteryExemptionOnce()
    }

    /**
     * We just caught Android killing the player in the background — the one
     * moment where asking about battery optimization is neither nagging nor a
     * guess. Offered once, ever; the setup screen keeps the same button for
     * anyone who says no here.
     */
    @SuppressLint("BatteryLife")
    private fun offerBatteryExemptionOnce() {
        if (prefs.batteryOffered) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        prefs.batteryOffered = true
        try {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.battery_killed_title)
                .setMessage(R.string.battery_killed_message)
                .setNegativeButton(R.string.battery_killed_later, null)
                .setPositiveButton(R.string.battery_killed_action) { _, _ ->
                    try {
                        startActivity(
                            Intent(
                                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                Uri.parse("package:$packageName")
                            )
                        )
                    } catch (_: Exception) {
                        startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                    }
                }
                .show()
        } catch (_: Exception) {
            // Activity going away under us — the offer isn't worth a crash.
        }
    }

    /**
     * The page (and with it the audio) is gone: take the media notification down
     * rather than leave a card up whose buttons reach nothing.
     */
    private fun dropPlayback() {
        serviceStarted = false
        pendingState = null
        service?.update(
            PlayerService.State(
                active = false, playing = false, title = "", artist = "", album = "",
                cover = "", position = 0.0, duration = 0.0
            )
        )
    }

    /**
     * Ask the page whether it is still alive, and rebuild it if it isn't.
     *
     * onRenderProcessGone catches a renderer the system kills outright, but not
     * every way a long background stay can leave the page unusable (a renderer
     * frozen past waking up, a WebView provider updated out from under us). What
     * the user sees is a blank or frozen screen whose only cure used to be
     * killing the app — so when we come back from a long absence, one round trip
     * through the renderer settles it.
     */
    private fun pingPage() {
        if (webViewDead || !::webView.isInitialized) return
        // Never worth asking when the page is audibly alive — music playing IS
        // the answer, and a rebuild would be the very outage we're preventing.
        if (pendingState?.playing == true) return
        // Nothing to suspect on the first resume of a launch: the page is still
        // loading, and a load slower than the timeout is not a dead renderer.
        if (leftAt == 0L) return
        if (SystemClock.elapsedRealtime() - leftAt < PING_AFTER_MS) return
        val token = ++pingToken
        var answered = false
        try {
            webView.evaluateJavascript("1") { answered = true }
        } catch (_: Exception) {
            return // torn down under us; onRenderProcessGone owns that case
        }
        // Posted on the error overlay, not on the WebView: a WebView that gets
        // destroyed in the meantime takes its pending messages with it, and this
        // is precisely the message that has to survive that.
        errorView.postDelayed({
            if (!answered && token == pingToken && !webViewDead &&
                !isFinishing && !isDestroyed
            ) rebuildWebView()
        }, PING_TIMEOUT_MS)
    }

    // Reopening the settings relaunches us (singleTask) via onNewIntent rather
    // than onCreate, so the WebView keeps showing the OLD server until the app
    // is killed. Reload here when the configured origin no longer matches what's
    // loaded, so a host/port/SSL change takes effect immediately.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!prefs.configured) return
        if (::webView.isInitialized && !webViewDead && !isServerUrl(webView.url)) {
            mainFrameFailed = false
            errorView.visibility = View.GONE
            webView.loadUrl(prefs.appUrl())
        }
    }

    override fun onStop() {
        super.onStop()
        leftAt = SystemClock.elapsedRealtime()
    }

    override fun onResume() {
        super.onResume()
        // Coming back to a page that died while we were away: rebuild it now
        // that there is someone to see it (onRenderProcessGone deferred this),
        // or retry a load that failed in the background — off the home network,
        // say — instead of parking the user on an error screen with a button.
        if (pendingRebuild || webViewDead) rebuildWebView()
        else if (mainFrameFailed) reload()
        else pingPage()

        // The login screen can go away without ever delivering a result — the
        // launcher icon re-entering this singleTask activity clears it off the
        // top, and so does a low-memory kill. Answer the SPA anyway, or its
        // promise stays pending and the button stays stuck on "Connexion en
        // cours…". Posted so a real result still in flight wins the race
        // (onActivityResult runs before onResume, but not before this post).
        if (deezerLoginPending && ::webView.isInitialized && !webViewDead) {
            webView.post {
                if (!deezerLoginPending) return@post
                deezerLoginPending = false
                deliverArl(null)
            }
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
        if (webViewDead || !::webView.isInitialized) return
        mainFrameFailed = false
        errorView.visibility = View.GONE
        webView.loadUrl(prefs.appUrl())
    }

    // -- origin checks ---------------------------------------------------------
    // One place decides what "our server" means, so the navigation guard, the
    // shim injection and the JS bridge can't drift apart.

    /** The default port a scheme implies, so ":443" and "" compare equal. */
    private fun effectivePort(u: Uri): Int =
        if (u.port > 0) u.port
        else when (u.scheme?.lowercase()) {
            "https" -> 443
            "http" -> 80
            else -> -1
        }

    private fun isServerUri(u: Uri): Boolean {
        val base = Uri.parse(prefs.baseUrl())
        if (base.host.isNullOrEmpty()) return false
        return u.scheme.equals(base.scheme, ignoreCase = true) &&
            u.host.equals(base.host, ignoreCase = true) &&
            effectivePort(u) == effectivePort(base)
    }

    private fun isServerUrl(url: String?): Boolean {
        if (url.isNullOrEmpty()) return false
        return try {
            isServerUri(Uri.parse(url))
        } catch (_: Exception) {
            false
        }
    }

    /** "scheme://host[:port]" of the configured server, for origin rules. */
    private fun serverOrigin(): String? {
        val u = Uri.parse(prefs.baseUrl())
        val scheme = u.scheme ?: return null
        val host = u.host ?: return null
        if (host.isEmpty()) return null
        return if (u.port > 0) "$scheme://$host:${u.port}" else "$scheme://$host"
    }

    /** Detach + destroy the WebView exactly once. */
    private fun disposeWebView() {
        if (webViewDead || !::webView.isInitialized) return
        webViewDead = true
        try {
            // Nothing else may touch the WebView here — after a renderer death
            // even stopLoading() goes through the dead process. Detach, destroy.
            // Removing it from the view tree BEFORE destroy() is required — a
            // destroyed WebView left attached is drawn from freed native memory.
            (webView.parent as? android.view.ViewGroup)?.removeView(webView)
            webView.destroy()
        } catch (_: Exception) {
            /* already gone */
        }
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

    /** Save `text` as `name` in the public Downloads folder. */
    private fun writeToDownloads(name: String, text: String) {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)
            .ifEmpty { "nsupysonic.txt" }
        try {
            val bytes = text.toByteArray(Charsets.UTF_8)
            if (Build.VERSION.SDK_INT >= 29) {
                // Scoped storage: MediaStore owns Downloads, no permission needed.
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = contentResolver
                val uri = resolver.insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, values
                ) ?: throw java.io.IOException("no download uri")
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                    ?: throw java.io.IOException("no output stream")
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS
                )
                dir.mkdirs()
                java.io.File(dir, safe).writeBytes(bytes)
            }
            Toast.makeText(this, getString(R.string.download_started, safe), Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_SHORT).show()
        }
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
        // The bridge is reachable from any frame the WebView runs, so the URL is
        // untrusted input: without this it would fetch ANY host with that host's
        // cookies and hand the body to the OS share sheet. Only our own server.
        if (!isServerUrl(rawUrl)) {
            Toast.makeText(this, R.string.share_failed, Toast.LENGTH_SHORT).show()
            return
        }
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

    /**
     * Hand the captured ARL (or null, when the user backed out) to the SPA's
     * pending `window.__nsDeezerArl` callback.
     *
     * The ARL is a full-account credential, so it is only ever delivered to a
     * page served by the CONFIGURED server — never to whatever else the WebView
     * may be showing at the moment the login screen closes.
     */
    private fun deliverArl(arl: String?) {
        if (webViewDead || !::webView.isInitialized) return
        if (!isServerUrl(webView.url)) return
        val payload =
            if (arl.isNullOrEmpty()) "null"
            else org.json.JSONObject().put("arl", arl).toString()
        try {
            webView.evaluateJavascript(
                "window.__nsDeezerArl && window.__nsDeezerArl($payload)", null
            )
        } catch (_: Exception) {
            /* WebView torn down under us */
        }
    }

    private fun runJsCommand(cmd: String, value: Double?) {
        // A media-button command is posted to the main looper, so it can land
        // AFTER the activity tore its WebView down (or after the renderer died).
        // Evaluating JS on a destroyed WebView is a native use-after-free.
        if (webViewDead || !::webView.isInitialized) return
        val arg = value?.let { ", $it" } ?: ""
        try {
            webView.evaluateJavascript(
                "window.__nsNativeCmd && window.__nsNativeCmd('$cmd'$arg)", null
            )
        } catch (_: Exception) {
            /* WebView torn down under us */
        }
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
        /**
         * This app's versionName, read by the web player (lib/appversion.js) at
         * startup: it compares it against the version the server publishes and,
         * when this one is older, offers the download. Read from the package
         * manager rather than BuildConfig so it always matches what is actually
         * installed.
         */
        @JavascriptInterface
        fun appVersion(): String =
            try {
                packageManager.getPackageInfo(packageName, 0).versionName ?: ""
            } catch (_: Exception) {
                ""
            }

        @JavascriptInterface
        fun publish(json: String) {
            val state = PlayerService.State.fromJson(json) ?: return
            runOnUiThread { handleState(state) }
        }

        @JavascriptInterface
        fun openServerSettings() {
            runOnUiThread { openSettings() }
        }

        /**
         * Open Deezer's login page and report the captured ARL back through
         * `window.__nsDeezerArl({arl})` — or `null` if the user gave up.
         *
         * Detected by the SPA (lib/nativeDeezer.js) to offer "se connecter avec
         * mon compte Deezer" instead of pasting an ARL by hand. There is no
         * email/password endpoint left at Deezer that a server could call, so
         * signing in on Deezer's own page is both the only thing that works and
         * the only design where the password never reaches us.
         */
        @JavascriptInterface
        fun deezerLogin() {
            runOnUiThread {
                try {
                    deezerLoginPending = true
                    deezerLoginLauncher.launch(
                        Intent(this@MainActivity, DeezerLoginActivity::class.java)
                    )
                } catch (_: Exception) {
                    // Activity missing / launch refused: unblock the caller
                    // rather than leaving its promise pending for ever.
                    deezerLoginPending = false
                    deliverArl(null)
                }
            }
        }

        // Detected by ShareSheet.svelte (window.NSNative.shareFile) in preference
        // to navigator.share/canShare, which is unreliable for files in a plain
        // WebView. `url` is the absolute /api/share/(file|clip)/... URL.
        @JavascriptInterface
        fun shareFile(url: String) {
            startShare(url)
        }

        /**
         * Write a text file straight to Downloads.
         *
         * The web path builds a Blob and clicks an <a download>, which reaches
         * setDownloadListener as a `blob:` URL — and DownloadManager only speaks
         * http(s), so saving the diagnostic log from the app failed with nothing
         * to show for it. There is no way to read a blob: URL from the native
         * side, so the text comes across the bridge instead.
         */
        @JavascriptInterface
        fun saveText(name: String, text: String) {
            // Bounded: the diagnostic log is a few hundred KB at most, and this
            // writes to the shared Downloads folder.
            if (text.length > MAX_SAVE_TEXT) {
                runOnUiThread {
                    Toast.makeText(
                        this@MainActivity, R.string.download_failed, Toast.LENGTH_SHORT
                    ).show()
                }
                return
            }
            runOnUiThread { writeToDownloads(name, text) }
        }
    }

    override fun onDestroy() {
        service?.commandSink = null
        if (bound) {
            try {
                unbindService(connection)
            } catch (_: Exception) {
            }
            bound = false
        }
        // The WebView (the actual audio) dies with us — take the service down.
        if (isFinishing) stopService(Intent(this, PlayerService::class.java))
        shareExecutor.shutdownNow()
        disposeWebView()
        super.onDestroy()
    }
}

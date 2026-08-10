package org.nsupysonic.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * Captures the Deezer ARL by letting the user sign in on **Deezer's own login
 * page**, hosted in a throwaway WebView.
 *
 * Deezer has no email/password endpoint we could call: the legacy web one
 * (`ajax/action.php` + reCAPTCHA) answers 403 since 2024, and the mobile
 * gateway (`mobile_userAuth`, which does return an ARL) needs keys extracted
 * from Deezer's own binaries. What still works — and is the only thing that
 * should — is a real browser session: the user types their credentials on
 * deezer.com, Deezer sets its `arl` session cookie, and we read that one cookie
 * out of the WebView's jar and hand it back.
 *
 * The credentials therefore never touch this app, and never touch the
 * NSupySonic server: only the resulting ARL crosses back, and only to a page
 * served by the configured server (see MainActivity.deliverDeezerArl).
 *
 * This WebView deliberately has **no JavaScript bridge** — the NSNative
 * interface is never attached here, so nothing on deezer.com can reach the
 * player, the service or the file helpers.
 */
class DeezerLoginActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_ARL = "arl"

        private const val LOGIN_URL = "https://www.deezer.com/login"

        /** Every Deezer origin whose jar can hold (or hold a stale) `arl`. */
        private val DEEZER_URLS = listOf(
            "https://www.deezer.com/",
            "https://deezer.com/",
            "https://auth.deezer.com/",
            "https://account.deezer.com/",
        )

        /**
         * Same shape the server accepts (supysonic/deezer/__init__.py) — the
         * value goes out as a Cookie header, so anything outside this alphabet
         * is header injection and is not an ARL anyway.
         */
        private val ARL_RE = Regex("[0-9A-Za-z._-]{32,255}")

        /**
         * Cookie polling interval while this screen is up.
         *
         * There is no cookie-change callback in the framework, and Deezer's
         * login is an XHR — the `arl` cookie routinely lands with no navigation
         * at all, so onPageFinished misses it. A short tick, bounded to the
         * lifetime of this one screen and stopped the instant the ARL shows up,
         * is the only reliable observer.
         */
        private const val POLL_MS = 600L
    }

    private lateinit var webView: WebView
    private var webViewDead = false
    private var done = false

    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            if (done || isFinishing) return
            val arl = harvestArl()
            if (arl != null) succeed(arl) else handler.postDelayed(this, POLL_MS)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_deezer_login)
        webView = findViewById(R.id.deezer_webview)
        findViewById<View>(R.id.btn_cancel).setOnClickListener { cancel() }

        // Start from a clean Deezer jar so the ARL that comes back is always the
        // account the user just signed into — never a leftover session from a
        // previous link. Scoped to deezer.com: removeAllCookies() would also
        // sign the user out of their own NSupySonic server.
        clearDeezerCookies()

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(webView, true)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Drop the "; wv" marker that identifies an embedded WebView: sign-in
            // pages routinely degrade or refuse outright when they see it, and
            // this one has to render a real login form to be of any use.
            userAgentString = userAgentString.replace("; wv", "")
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(
                view: WebView?, sslHandler: SslErrorHandler?, error: SslError?
            ) {
                // Never relax this. The "verify SSL" preference exists for the
                // user's own self-signed home server; deezer.com is a public
                // host on the real internet and a bad certificate there means
                // someone is between us and the password being typed.
                sslHandler?.cancel()
                Toast.makeText(
                    this@DeezerLoginActivity, R.string.deezer_login_ssl, Toast.LENGTH_LONG
                ).show()
                cancel()
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean {
                val scheme = request?.url?.scheme?.lowercase()
                // Keep the whole sign-in journey (Deezer, and the SSO providers
                // it delegates to) inside this WebView, but swallow app links —
                // `intent://`/`market://`/`deezer://` would bounce the user into
                // the Deezer app or the Play Store mid-login and strand us.
                return scheme != "http" && scheme != "https"
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                // The post-login navigation usually lands before the next tick —
                // finishing here shaves the poll interval off the happy path.
                harvestArl()?.let { succeed(it) }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!webViewDead && webView.canGoBack()) webView.goBack() else cancel()
            }
        })

        webView.loadUrl(LOGIN_URL)
    }

    override fun onResume() {
        super.onResume()
        if (!done) handler.post(poll)
    }

    override fun onPause() {
        handler.removeCallbacks(poll)
        super.onPause()
    }

    /** The `arl` cookie from any Deezer origin, or null while there isn't one. */
    private fun harvestArl(): String? {
        val cookies = CookieManager.getInstance()
        for (url in DEEZER_URLS) {
            val raw = try {
                cookies.getCookie(url)
            } catch (_: Exception) {
                null
            } ?: continue
            for (part in raw.split(';')) {
                val pair = part.trim()
                if (!pair.startsWith("arl=")) continue
                val value = pair.substring(4).trim()
                if (ARL_RE.matches(value)) return value
            }
        }
        return null
    }

    /**
     * Expire every cookie on the Deezer origins.
     *
     * There is no "remove cookies for this domain" API, so each one is
     * overwritten with an already-expired copy — on the host itself and on the
     * `.deezer.com` parent, since a cookie set for the parent domain is not
     * cleared by expiring a host-only one of the same name.
     */
    private fun clearDeezerCookies() {
        val cookies = CookieManager.getInstance()
        for (url in DEEZER_URLS) {
            val raw = try {
                cookies.getCookie(url)
            } catch (_: Exception) {
                null
            } ?: continue
            val host = Uri.parse(url).host
            for (part in raw.split(';')) {
                val name = part.substringBefore('=').trim()
                if (name.isEmpty()) continue
                cookies.setCookie(url, "$name=; Max-Age=0; Path=/")
                cookies.setCookie(url, "$name=; Max-Age=0; Path=/; Domain=.deezer.com")
                if (host != null) cookies.setCookie(url, "$name=; Max-Age=0; Path=/; Domain=$host")
            }
        }
        try {
            cookies.flush()
        } catch (_: Exception) {
            /* nothing to flush */
        }
    }

    private fun succeed(arl: String) {
        if (done) return
        done = true
        handler.removeCallbacks(poll)
        // The ARL is a full-account credential: now that it is on its way to the
        // server the user chose, don't leave a second copy sitting in this
        // app's cookie jar. Expiring the cookie locally does not end the Deezer
        // session — the token we just captured stays valid.
        clearDeezerCookies()
        setResult(RESULT_OK, Intent().putExtra(EXTRA_ARL, arl))
        finish()
    }

    private fun cancel() {
        if (done) return
        done = true
        handler.removeCallbacks(poll)
        setResult(RESULT_CANCELED)
        finish()
    }

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        // Same rule as MainActivity: detach before destroy, and never touch the
        // WebView afterwards — a destroyed WebView left in the view tree is
        // drawn from freed native memory.
        if (!webViewDead && ::webView.isInitialized) {
            webViewDead = true
            try {
                (webView.parent as? android.view.ViewGroup)?.removeView(webView)
                webView.destroy()
            } catch (_: Exception) {
                /* already gone */
            }
        }
        super.onDestroy()
    }
}

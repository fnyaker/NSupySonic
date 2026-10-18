package org.nsupysonic.app

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The native side's GETs (cover art for the notification, files for the share
 * sheet), with the rules the WebView's own requests follow:
 *
 *  - CLEARTEXT only to the configured server. The manifest has to allow http
 *    because a home server may well be http://192.168.1.10 — and the manifest
 *    cannot know which host that is — so the narrowing happens here.
 *  - The session COOKIE only to the configured server. Redirects are followed
 *    by hand: HttpURLConnection re-sends a header set with setRequestProperty
 *    to wherever a redirect points, which handed the session to any host the
 *    server (or a man in the middle) redirected to.
 *  - The pinned certificate only for the configured server (Ssl.apply): any
 *    other host gets the system's checks, whatever "verify SSL" says.
 */
object Net {
    private const val MAX_REDIRECTS = 5

    /**
     * Open [url] and return the connection once it answered 2xx (the caller
     * reads and disconnects it). [cookie] goes only to the configured server.
     */
    fun get(
        prefs: Prefs, url: String, cookie: String?, connectTimeout: Int, readTimeout: Int
    ): HttpURLConnection {
        var current = url
        for (hop in 0..MAX_REDIRECTS) {
            val ours = prefs.isServerUrl(current)
            val scheme = Prefs.originOf(current)?.substringBefore("://")
                ?: throw IOException("not an http(s) URL")
            if (scheme == "http" && !ours) throw IOException("cleartext refused off the server")
            val conn = URL(current).openConnection() as HttpURLConnection
            Ssl.apply(conn, prefs.verifySsl, if (ours) prefs.pinForUrl(current) else null)
            conn.connectTimeout = connectTimeout
            conn.readTimeout = readTimeout
            conn.instanceFollowRedirects = false
            if (ours && !cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", cookie)
            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location")
                conn.disconnect()
                if (location.isNullOrEmpty()) throw IOException("redirect without Location")
                current = URL(URL(current), location).toString()
                continue
            }
            if (code !in 200..299) {
                conn.disconnect()
                throw IOException("HTTP $code")
            }
            return conn
        }
        throw IOException("too many redirects")
    }
}

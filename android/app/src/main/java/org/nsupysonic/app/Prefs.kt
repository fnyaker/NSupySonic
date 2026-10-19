package org.nsupysonic.app

import android.content.Context
import android.net.Uri

/** Server settings entered on first launch (host/port/SSL verification). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var host: String
        get() = sp.getString("host", "") ?: ""
        set(v) = sp.edit().putString("host", v.trim()).apply()

    var port: String
        get() = sp.getString("port", "") ?: ""
        set(v) = sp.edit().putString("port", v.trim()).apply()

    var verifySsl: Boolean
        get() = sp.getBoolean("verifySsl", true)
        set(v) = sp.edit().putBoolean("verifySsl", v).apply()

    var configured: Boolean
        get() = sp.getBoolean("configured", false)
        set(v) = sp.edit().putBoolean("configured", v).apply()

    /**
     * Whether we've already offered the battery-optimization exemption after
     * catching Android killing the player in the background. Asked at most once:
     * the offer is worth making, nagging isn't.
     */
    var batteryOffered: Boolean
        get() = sp.getBoolean("batteryOffered", false)
        set(v) = sp.edit().putBoolean("batteryOffered", v).apply()

    /**
     * The server certificate trusted on first use, as Ssl.fingerprint spells it
     * — only consulted when [verifySsl] is off, and only for the origin it was
     * pinned on: pointing the app at another server starts from no pin.
     */
    fun pinFor(origin: String?): String? {
        if (origin == null) return null
        if (sp.getString("pinOrigin", null) != origin) return null
        return sp.getString("pinCert", null)
    }

    fun setPin(origin: String, fingerprint: String) =
        sp.edit().putString("pinOrigin", origin).putString("pinCert", fingerprint).apply()

    fun clearPin() = sp.edit().remove("pinOrigin").remove("pinCert").apply()

    /** The configured server's origin (see [originOf]). */
    fun serverOrigin(): String? = originOf(baseUrl())

    /** Whether [url] is on the configured server: scheme, host AND port. */
    fun isServerUrl(url: String?): Boolean {
        val mine = serverOrigin() ?: return false
        return originOf(url) == mine
    }

    /** The pin that applies to [url]: the server's, never another host's. */
    fun pinForUrl(url: String?): String? =
        if (isServerUrl(url)) pinFor(serverOrigin()) else null

    /**
     * Normalized origin: scheme defaults to https, the optional port field is
     * inserted into the AUTHORITY (host) only when the host doesn't already
     * carry one — never after a path (the old code produced ".../musique:5722"
     * for a reverse-proxied sub-path host).
     */
    fun baseUrl(): String = buildBaseUrl(host, port)

    /** The SPA entry point served by supysonic/webui/spa.py. */
    fun appUrl(): String = appUrlFor(host, port)

    companion object {
        fun buildBaseUrl(host: String, port: String): String {
            var raw = host.trim().trimEnd('/')
            if (raw.isEmpty()) return ""
            if (!raw.contains("://")) raw = "https://$raw"
            val schemeEnd = raw.indexOf("://") + 3
            val scheme = raw.substring(0, schemeEnd)        // "https://"
            val rest = raw.substring(schemeEnd)             // "host[:port][/path]"
            val slash = rest.indexOf('/')
            val authority = if (slash >= 0) rest.substring(0, slash) else rest
            val path = if (slash >= 0) rest.substring(slash) else ""
            val p = port.trim()
            val auth =
                if (p.isNotEmpty() && !authority.contains(":")) "$authority:$p" else authority
            return "$scheme$auth$path"
        }

        fun appUrlFor(host: String, port: String): String = buildBaseUrl(host, port) + "/app/"

        /**
         * "scheme://host:port" with the port always spelled out (":443" and ""
         * compare equal) and scheme/host lowercased, or null for anything that
         * is not http(s) with a host. ONE definition of "same server", shared by
         * the navigation guard, the shim, the JS bridge, the certificate pin
         * and the native fetches, so they cannot drift apart.
         */
        fun originOf(url: String?): String? {
            if (url.isNullOrEmpty()) return null
            val u = try {
                Uri.parse(url)
            } catch (_: Exception) {
                return null
            }
            val scheme = u.scheme?.lowercase() ?: return null
            val defaultPort = when (scheme) {
                "https" -> 443
                "http" -> 80
                else -> return null
            }
            val host = u.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            val port = if (u.port > 0) u.port else defaultPort
            return "$scheme://$host:$port"
        }
    }
}

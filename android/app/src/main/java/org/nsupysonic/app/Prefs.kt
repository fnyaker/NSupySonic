package org.nsupysonic.app

import android.content.Context

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
    }
}

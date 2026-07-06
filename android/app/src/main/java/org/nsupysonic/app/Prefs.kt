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
     * appended only when the host doesn't already carry one.
     */
    fun baseUrl(): String {
        var h = host.trim().trimEnd('/')
        if (!h.contains("://")) h = "https://$h"
        val p = port.trim()
        if (p.isNotEmpty() && !h.substringAfter("://").contains(":")) h = "$h:$p"
        return h
    }

    /** The SPA entry point served by supysonic/webui/spa.py. */
    fun appUrl(): String = baseUrl() + "/app/"
}

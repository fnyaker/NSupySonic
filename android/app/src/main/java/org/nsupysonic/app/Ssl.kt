package org.nsupysonic.app

import java.net.HttpURLConnection
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * Trust-all plumbing for the native HTTP fetches (reachability check, cover
 * art), applied ONLY when the user unticked "verify SSL" in the setup screen —
 * the whole point being self-signed home-server certificates.
 */
object Ssl {
    private val trustAll = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }

    private val insecureFactory by lazy {
        SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustAll), SecureRandom())
        }.socketFactory
    }

    private val anyHost = HostnameVerifier { _, _ -> true }

    /** Relax certificate/hostname checks on this connection if asked to. */
    fun apply(conn: HttpURLConnection, verifySsl: Boolean) {
        if (!verifySsl && conn is HttpsURLConnection) {
            conn.sslSocketFactory = insecureFactory
            conn.hostnameVerifier = anyHost
        }
    }
}

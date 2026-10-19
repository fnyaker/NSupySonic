package org.nsupysonic.app

import android.net.http.SslCertificate
import android.os.Build
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.Certificate
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Self-signed home servers, without trusting everybody.
 *
 * Unticking "verify SSL" used to install a trust-all manager and a hostname
 * verifier that said yes to anything, which is worse than no TLS at all: the
 * padlock stays, and anyone on the café Wi-Fi can present any certificate. Now
 * it means TRUST ON FIRST USE: the certificate the server presents the first
 * time (in the setup screen, or on the WebView's first load) is pinned by its
 * SHA-256, and from then on a chain the system accepts OR that exact
 * certificate is accepted — nothing else. A renewed certificate is trusted
 * again by re-saving the server settings.
 */
object Ssl {
    /** SHA-256 of the certificate's DER, "AB:CD:…" — stored and shown as is. */
    fun fingerprint(cert: Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(cert.encoded)
            .joinToString(":") { "%02X".format(it) }

    /** The leaf the WebView is complaining about, as a real X509Certificate. */
    fun fingerprint(cert: SslCertificate?): String? {
        if (cert == null) return null
        return try {
            val x509 = if (Build.VERSION.SDK_INT >= 29) cert.x509Certificate
            else SslCertificate.saveState(cert).getByteArray("x509-certificate")?.let {
                CertificateFactory.getInstance("X.509")
                    .generateCertificate(ByteArrayInputStream(it)) as X509Certificate
            }
            x509?.let { fingerprint(it) }
        } catch (_: Exception) {
            null
        }
    }

    private val systemTrust: X509TrustManager by lazy {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as KeyStore?)
        tmf.trustManagers.filterIsInstance<X509TrustManager>().first()
    }

    /** The system's verdict, or the pinned leaf. Never "anything". */
    private class PinnedTrust(private val pin: String) : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {
            throw CertificateException("no client certificates here")
        }

        override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
            if (chain.isNullOrEmpty()) throw CertificateException("empty chain")
            try {
                systemTrust.checkServerTrusted(chain, authType)
            } catch (e: CertificateException) {
                if (fingerprint(chain[0]) != pin) throw e
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = systemTrust.acceptedIssuers
    }

    private val factories = ConcurrentHashMap<String, SSLSocketFactory>()

    private fun factoryFor(pin: String): SSLSocketFactory =
        factories.getOrPut(pin) {
            SSLContext.getInstance("TLS").apply {
                init(null, arrayOf(PinnedTrust(pin)), SecureRandom())
            }.socketFactory
        }

    /**
     * The pinned certificate IS the server's identity — a self-signed cert
     * rarely names the IP or LAN name it is reached by — so it passes on its
     * own; anything else goes through the normal hostname check.
     */
    private fun verifierFor(pin: String) = HostnameVerifier { host, session ->
        val leaf = try {
            session.peerCertificates.firstOrNull()
        } catch (_: Exception) {
            null
        }
        (leaf != null && fingerprint(leaf) == pin) ||
            HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session)
    }

    /**
     * Accept the pinned certificate on this connection too. [pin] must be the
     * one pinned for THIS connection's server (Prefs.pinForUrl); with no pin
     * the connection keeps the system's checks, untouched.
     */
    fun apply(conn: HttpURLConnection, verifySsl: Boolean, pin: String?) {
        if (verifySsl || pin == null || conn !is HttpsURLConnection) return
        conn.sslSocketFactory = factoryFor(pin)
        conn.hostnameVerifier = verifierFor(pin)
    }

    /**
     * Setup only: the fingerprint of the certificate [url] presents, or null
     * when the system already trusts it (nothing to pin) or nothing answered.
     *
     * The handshake is REFUSED once the leaf is recorded, so not one byte is
     * sent over a connection nobody has vouched for yet.
     */
    fun presentedFingerprint(url: String, timeoutMs: Int = 6000): String? {
        var seen: String? = null
        var trusted = false
        val recorder = object : X509TrustManager {
            override fun checkClientTrusted(c: Array<X509Certificate>?, a: String?) {
                throw CertificateException("no client certificates here")
            }

            override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {
                if (chain.isNullOrEmpty()) throw CertificateException("empty chain")
                seen = fingerprint(chain[0])
                trusted = try {
                    systemTrust.checkServerTrusted(chain, authType)
                    true
                } catch (_: CertificateException) {
                    false
                }
                throw CertificateException("recorded, not trusted")
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        try {
            val conn = URL(url).openConnection() as? HttpsURLConnection ?: return null
            conn.sslSocketFactory = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf(recorder), SecureRandom())
            }.socketFactory
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.connect()
            conn.disconnect()
        } catch (_: Exception) {
            // Expected: the recorder always refuses.
        }
        return if (trusted) null else seen
    }
}

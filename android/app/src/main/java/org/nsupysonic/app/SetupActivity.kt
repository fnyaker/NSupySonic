package org.nsupysonic.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * First-launch (and on-demand) server configuration: URL, optional port and
 * SSL verification toggle. Reachability is checked before saving, with an
 * explicit "continue anyway" escape hatch (e.g. configuring on cellular for a
 * LAN-only server).
 */
class SetupActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_FORCE = "force"
    }

    private lateinit var prefs: Prefs
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        // Already configured and not explicitly reopened: straight to the app.
        if (prefs.configured && !intent.getBooleanExtra(EXTRA_FORCE, false)) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_setup)
        val hostField = findViewById<EditText>(R.id.field_host)
        val portField = findViewById<EditText>(R.id.field_port)
        val sslCheck = findViewById<CheckBox>(R.id.check_ssl)
        val connectBtn = findViewById<Button>(R.id.btn_connect)
        val batteryBtn = findViewById<Button>(R.id.btn_battery)

        hostField.setText(prefs.host)
        portField.setText(prefs.port)
        sslCheck.isChecked = prefs.verifySsl

        connectBtn.setOnClickListener {
            val host = hostField.text.toString().trim()
            if (host.isEmpty()) {
                hostField.error = getString(R.string.setup_host_required)
                return@setOnClickListener
            }
            val port = portField.text.toString().trim()
            val verify = sslCheck.isChecked

            connectBtn.isEnabled = false
            connectBtn.setText(R.string.setup_checking)
            executor.execute {
                // Probe with the ENTERED values without persisting them first —
                // persisting before validation left a bad host saved if the user
                // hit Retry then backed out. Only proceed() commits the settings.
                val appUrl = Prefs.appUrlFor(host, port)
                // Verification off: learn the certificate first (the handshake
                // is refused, nothing is sent), then probe trusting THAT one
                // certificate only. Null when the system already trusts it.
                val fingerprint =
                    if (!verify && appUrl.startsWith("https://", ignoreCase = true))
                        Ssl.presentedFingerprint(appUrl)
                    else null
                val ok = probe(appUrl, verify, fingerprint)
                runOnUiThread {
                    connectBtn.isEnabled = true
                    connectBtn.setText(R.string.setup_connect)
                    if (ok) confirmThenProceed(host, port, verify, fingerprint)
                    else MaterialAlertDialogBuilder(this)
                        .setTitle(R.string.setup_unreachable_title)
                        .setMessage(getString(R.string.setup_unreachable, Prefs.buildBaseUrl(host, port)))
                        .setPositiveButton(R.string.setup_retry, null)
                        .setNegativeButton(R.string.setup_continue_anyway) { _, _ ->
                            confirmThenProceed(host, port, verify, fingerprint)
                        }
                        .show()
                }
            }
        }

        batteryBtn.setOnClickListener { requestIgnoreBatteryOptimizations() }
    }

    /**
     * A certificate the system does not vouch for is shown before it is
     * trusted: its fingerprint can be compared with the server's own
     * (`openssl x509 -noout -fingerprint -sha256`), and once accepted it is the
     * ONLY certificate this app takes for that server. Skipped when it is the
     * one already pinned.
     */
    private fun confirmThenProceed(
        host: String, port: String, verifySsl: Boolean, fingerprint: String?
    ) {
        val origin = Prefs.originOf(Prefs.buildBaseUrl(host, port))
        if (fingerprint == null || prefs.pinFor(origin) == fingerprint) {
            proceed(host, port, verifySsl, fingerprint)
            return
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.setup_trust_title)
            .setMessage(getString(R.string.setup_trust_message, Prefs.buildBaseUrl(host, port), fingerprint))
            .setNegativeButton(R.string.setup_trust_cancel, null)
            .setPositiveButton(R.string.setup_trust_accept) { _, _ ->
                proceed(host, port, verifySsl, fingerprint)
            }
            .show()
    }

    private fun proceed(host: String, port: String, verifySsl: Boolean, fingerprint: String?) {
        prefs.host = host
        prefs.port = port
        prefs.verifySsl = verifySsl
        // A pin only ever means something with verification off. Re-saving
        // the settings is also how a renewed certificate gets trusted: the
        // fresh one replaces the old pin. With no certificate learnt here
        // ("continue anyway"), the WebView pins on its first load instead.
        val origin = prefs.serverOrigin()
        when {
            verifySsl || origin == null -> prefs.clearPin()
            fingerprint != null -> prefs.setPin(origin, fingerprint)
        }
        prefs.configured = true
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /** Any HTTP answer at all proves the server is there — auth comes later. */
    private fun probe(url: String, verifySsl: Boolean, pin: String?): Boolean = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        Ssl.apply(conn, verifySsl, pin)
        conn.connectTimeout = 6000
        conn.readTimeout = 6000
        conn.instanceFollowRedirects = true
        conn.responseCode
        conn.disconnect()
        true
    } catch (_: Exception) {
        false
    }

    /**
     * Exempting the app from battery optimization is what lets a player paused
     * for hours survive on aggressive OEM builds. Sideload-only affordance.
     */
    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimizations() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            MaterialAlertDialogBuilder(this)
                .setMessage(R.string.setup_battery_already)
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }
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

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }
}

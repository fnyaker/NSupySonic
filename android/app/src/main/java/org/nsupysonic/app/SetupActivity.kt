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
                val ok = probe(Prefs.appUrlFor(host, port), verify)
                runOnUiThread {
                    connectBtn.isEnabled = true
                    connectBtn.setText(R.string.setup_connect)
                    if (ok) proceed(host, port, verify)
                    else MaterialAlertDialogBuilder(this)
                        .setTitle(R.string.setup_unreachable_title)
                        .setMessage(getString(R.string.setup_unreachable, Prefs.buildBaseUrl(host, port)))
                        .setPositiveButton(R.string.setup_retry, null)
                        .setNegativeButton(R.string.setup_continue_anyway) { _, _ ->
                            proceed(host, port, verify)
                        }
                        .show()
                }
            }
        }

        batteryBtn.setOnClickListener { requestIgnoreBatteryOptimizations() }
    }

    private fun proceed(host: String, port: String, verifySsl: Boolean) {
        prefs.host = host
        prefs.port = port
        prefs.verifySsl = verifySsl
        prefs.configured = true
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    /** Any HTTP answer at all proves the server is there — auth comes later. */
    private fun probe(url: String, verifySsl: Boolean): Boolean = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        Ssl.apply(conn, verifySsl)
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

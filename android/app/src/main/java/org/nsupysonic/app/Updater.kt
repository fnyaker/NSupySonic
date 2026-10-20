package org.nsupysonic.app

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * The app's own update, fetched from the configured server and installed in place.
 *
 * The server serves the APK at /api/android/apk (supysonic/webui/androidapk.py);
 * this downloads it with the session cookie (Net: our server only), then checks,
 * BEFORE asking Android, that it is this app (same package), newer (a higher
 * versionCode) and signed with the certificate this install carries. Android
 * refuses a differently signed update anyway; checking first is what lets the
 * page say why ("signature différente") instead of an installer error.
 *
 * Progress and the outcome reach the page through `window.__nsUpdate({state,…})`:
 * download (progress 0..1), install (the system dialog is up), permission (the
 * user must allow installs from this app — the settings screen is opened, and
 * coming back resumes), uptodate, error (reason: network | invalid | package |
 * signature | permission).
 */
class Updater(
    private val activity: Activity,
    private val prefs: Prefs,
    private val cookieFor: (String) -> String?,
    private val report: (JSONObject) -> Unit,
) {
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var running = false
    // A verified APK waiting for the "install unknown apps" permission.
    private var waiting: File? = null

    fun start() {
        if (running) return
        val base = prefs.baseUrl()
        val url = "$base/api/android/apk"
        if (!prefs.isServerUrl(url)) return
        running = true
        val cookie = cookieFor(url)
        executor.execute {
            try {
                val apk = download(url, cookie) ?: return@execute
                val reason = verify(apk)
                if (reason != null) {
                    apk.delete()
                    if (reason == "uptodate") send("uptodate") else send("error", reason)
                    return@execute
                }
                activity.runOnUiThread { install(apk) }
            } finally {
                running = false
            }
        }
    }

    /** Called from onResume: back from the permission screen, carry on. */
    fun resume() {
        val apk = waiting ?: return
        waiting = null
        if (canInstall()) install(apk) else send("error", "permission")
    }

    fun shutdown() = executor.shutdownNow()

    private fun download(url: String, cookie: String?): File? {
        val dir = File(activity.cacheDir, "update").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, "nsupysonic.apk")
        try {
            // The first request may make the server fetch the release itself.
            val conn = Net.get(prefs, url, cookie, 15000, 120000)
            try {
                val total = conn.contentLengthLong
                if (total > MAX_BYTES) throw java.io.IOException("too large")
                var done = 0L
                var lastSent = -1
                conn.inputStream.use { input ->
                    out.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            done += n
                            if (done > MAX_BYTES) throw java.io.IOException("too large")
                            output.write(buf, 0, n)
                            if (total > 0) {
                                val pct = (done * 100 / total).toInt()
                                if (pct != lastSent) {
                                    lastSent = pct
                                    send("download", progress = pct / 100.0)
                                }
                            }
                        }
                    }
                }
            } finally {
                conn.disconnect()
            }
            return out
        } catch (_: Exception) {
            out.delete()
            send("error", "network")
            return null
        }
    }

    /** null when [apk] may be installed, else why not. */
    @Suppress("DEPRECATION")
    private fun verify(apk: File): String? {
        val pm = activity.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
        else PackageManager.GET_SIGNATURES
        val archive = try {
            pm.getPackageArchiveInfo(apk.path, flags)
        } catch (_: Exception) {
            null
        } ?: return "invalid"
        if (archive.packageName != activity.packageName) return "package"
        val installed = try {
            pm.getPackageInfo(activity.packageName, flags)
        } catch (_: Exception) {
            return "invalid"
        }
        if (versionCode(archive) <= versionCode(installed)) return "uptodate"
        if (!sameSigner(archive, installed)) return "signature"
        return null
    }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode
        else info.versionCode.toLong()

    /**
     * Android's own rule, checked ahead of it: one signer, and the update's
     * lineage (its key and the keys it rotated from) includes the installed
     * app's key; several signers, the same set. When the archive's signers
     * cannot be read (some platform versions do not fill them for an archive),
     * the installer stays the judge.
     */
    @Suppress("DEPRECATION")
    private fun sameSigner(archive: PackageInfo, installed: PackageInfo): Boolean {
        if (Build.VERSION.SDK_INT >= 28) {
            val theirs = archive.signingInfo ?: return true
            val ours = installed.signingInfo ?: return true
            val current = digests(ours.apkContentsSigners)
            if (theirs.hasMultipleSigners() || ours.hasMultipleSigners())
                return digests(theirs.apkContentsSigners) == current
            val lineage = digests(theirs.signingCertificateHistory) +
                digests(theirs.apkContentsSigners)
            return lineage.isEmpty() || lineage.containsAll(current)
        }
        val theirs = digests(archive.signatures)
        return theirs.isEmpty() || theirs == digests(installed.signatures)
    }

    private fun digests(sigs: Array<android.content.pm.Signature>?): Set<String> {
        val md = MessageDigest.getInstance("SHA-256")
        return (sigs ?: emptyArray()).map { sig ->
            md.digest(sig.toByteArray()).joinToString("") { b -> "%02x".format(b) }
        }.toSet()
    }

    private fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()

    private fun install(apk: File) {
        if (!canInstall()) {
            waiting = apk
            send("permission")
            try {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}")
                    )
                )
            } catch (_: Exception) {
                waiting = null
                send("error", "permission")
            }
            return
        }
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            send("install")
            activity.startActivity(view)
        } catch (_: Exception) {
            send("error", "invalid")
        }
    }

    private fun send(state: String, reason: String? = null, progress: Double? = null) {
        val msg = JSONObject().put("state", state)
        if (reason != null) msg.put("reason", reason)
        if (progress != null) msg.put("progress", progress)
        activity.runOnUiThread { report(msg) }
    }

    companion object {
        private const val MAX_BYTES = 200L * 1024 * 1024
    }
}

package org.nsupysonic.app

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The offline downloads' audio, in the app's own storage (lot N4).
 *
 * The page keeps what it lists (titles, covers) in IndexedDB; the heavy part,
 * the audio, lives here as plain files under `filesDir/offline`, fetched by the
 * app itself from the server (Net: the session cookie, the pinned certificate),
 * so a 40 MB FLAC never crosses the renderer as a Blob. Each file is named by a
 * hash of the page's track key, so no key, whatever it holds, names a path;
 * a small JSON beside it remembers the key and the type.
 *
 * The page plays a download from `<server origin>/__nsoffline/<key>`, which
 * [serve] answers from the file (byte ranges included) without the network;
 * the native player reads the same URL straight off the disk ([fileFor]).
 */
class OfflineStore private constructor(
    context: Context,
    private val prefs: Prefs,
    private val cookieFor: (String) -> String?,
) {
    /**
     * Where progress goes: the current activity's page. One store per PROCESS,
     * since a download outlives the activity that started it (a rebuilt
     * activity takes the sink over and sees it finish).
     */
    @Volatile var sink: ((String) -> Unit)? = null

    private val dir = File(context.filesDir, "offline").apply { mkdirs() }
    private val pool = Executors.newFixedThreadPool(PARALLEL)
    private val running = ConcurrentHashMap<String, Boolean>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private val gate = YieldGate()

    private fun name(key: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        return d.joinToString("") { "%02x".format(it) }.substring(0, 40)
    }

    private fun audio(key: String) = File(dir, name(key) + ".audio")
    private fun part(key: String) = File(dir, name(key) + ".part")
    private fun meta(key: String) = File(dir, name(key) + ".json")

    /** Downloads the server's [url] as [key]. False when refused outright. */
    fun download(key: String, url: String): Boolean {
        if (!keyOk(key) || !prefs.isServerUrl(url)) return false
        if (running.putIfAbsent(key, true) != null) return true
        cancelled.remove(key)
        pool.execute {
            try {
                fetch(key, url)
            } catch (e: Exception) {
                part(key).delete()
                send(key, "error", JSONObject().put("msg", e.message ?: e.javaClass.simpleName))
            } finally {
                running.remove(key)
            }
        }
        return true
    }

    fun cancel(key: String) {
        if (running.containsKey(key)) cancelled.add(key)
    }

    private fun fetch(key: String, url: String) {
        // The person's music first: a download waits for the link to be free
        // before it even connects (see YieldGate).
        if (!gate.awaitClear { key in cancelled }) throw IOException("cancelled")
        val tmp = part(key)
        tmp.delete()
        var got = 0L
        var total = -1L
        var type = "audio/flac"
        var lastSent = 0L
        var failures = 0
        while (true) {
            val headers = HashMap<String, String>()
            headers["Accept-Encoding"] = "identity"
            if (got > 0) headers["Range"] = "bytes=$got-"
            val c = Net.get(prefs, url, cookieFor(url), CONNECT_MS, READ_MS, headers)
            var paused = false
            try {
                if (got > 0) {
                    // A resume is only a resume when the server says where it
                    // starts; anything else starts the file again.
                    val from = Regex("bytes (\\d+)-").find(c.getHeaderField("Content-Range") ?: "")
                        ?.groupValues?.get(1)?.toLongOrNull()
                    if (c.responseCode != 206 || from != got) {
                        got = 0L
                        tmp.delete()
                    }
                }
                if (got == 0L) {
                    type = (c.contentType ?: "audio/flac").substringBefore(';').trim().take(64)
                    total = c.contentLengthLong
                }
                // A file the server can resume (an archived track: its length
                // known, byte ranges served) steps aside ENTIRELY while the
                // player needs the link — the connection closed, nothing in
                // flight — and picks up at the same byte. One it could not
                // resume (a live transcode) trickles instead.
                val resumable = total > 0 &&
                    (c.getHeaderField("Accept-Ranges") ?: "").contains("bytes", ignoreCase = true)
                c.inputStream.use { input ->
                    FileOutputStream(tmp, got > 0).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            if (key in cancelled) throw IOException("cancelled")
                            val slow = gate.yielding()
                            if (slow && resumable) {
                                paused = true
                                break
                            }
                            val n = input.read(buf, 0, if (slow) YieldGate.TRICKLE_BYTES else buf.size)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            got += n
                            if (slow) gate.trickle(n)
                            val now = System.currentTimeMillis()
                            if (now - lastSent >= PROGRESS_MS) {
                                lastSent = now
                                send(key, "progress", JSONObject().put("r", got).put("t", total))
                            }
                        }
                        out.fd.sync()
                    }
                }
            } catch (e: IOException) {
                // A connection that dropped under a download (a proxy timing
                // out a trickle, a phone changing networks) picks up where it
                // stopped rather than failing the track.
                if (key in cancelled || got == 0L || ++failures > RESUMES) throw e
                paused = true
            } finally {
                c.disconnect()
            }
            if (!paused) break
            if (!gate.awaitClear { key in cancelled }) throw IOException("cancelled")
        }
        if (got == 0L) throw IOException("empty body")
        if (total > 0 && got != total) throw IOException("cut short ($got of $total)")
        publish(key, type)
        send(key, "done", JSONObject().put("size", got).put("type", type))
    }

    /** The page's lease on the link (see YieldGate); 0 ends it. */
    fun yieldFor(ms: Long) = gate.hold(ms)

    private fun publish(key: String, type: String) {
        val tmp = part(key)
        val m = JSONObject().put("id", key).put("type", type).put("size", tmp.length())
        meta(key).writeText(m.toString())
        if (!tmp.renameTo(audio(key))) throw IOException("could not store the file")
    }

    /**
     * One piece of a file the page already holds (a download made before this
     * store existed, moved here once): [b64] goes at [offset], which must be
     * where the previous piece ended. True when written.
     */
    fun put(key: String, offset: Long, b64: String): Boolean {
        if (!keyOk(key) || running.containsKey(key)) return false
        return try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val tmp = part(key)
            if (offset == 0L) tmp.delete()
            if (tmp.length() != offset) return false
            FileOutputStream(tmp, true).use { it.write(bytes) }
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Finishes what [put] wrote. The size stored, or -1. */
    fun commit(key: String, type: String): Long {
        if (!keyOk(key)) return -1
        val tmp = part(key)
        if (!tmp.isFile || tmp.length() == 0L) return -1
        return try {
            FileOutputStream(tmp, true).use { it.fd.sync() }
            val size = tmp.length()
            publish(key, type.substringBefore(';').trim().take(64).ifEmpty { "audio/flac" })
            size
        } catch (_: Exception) {
            tmp.delete()
            -1
        }
    }

    fun remove(key: String) {
        if (!keyOk(key)) return
        cancel(key)
        audio(key).delete()
        part(key).delete()
        meta(key).delete()
    }

    fun clear() {
        for (k in running.keys) cancelled.add(k)
        dir.listFiles()?.forEach { it.delete() }
    }

    /** Every stored download: `[{id, type, size}]`. */
    fun list(): String {
        val out = JSONArray()
        dir.listFiles { f -> f.name.endsWith(".json") }?.forEach { f ->
            try {
                val m = JSONObject(f.readText())
                val a = File(dir, f.name.removeSuffix(".json") + ".audio")
                if (a.isFile) out.put(m.put("size", a.length()))
            } catch (_: Exception) {
                /* a half-written record: not listed */
            }
        }
        return out.toString()
    }

    /** Bytes free where the downloads go. */
    fun free(): Long = dir.usableSpace

    private fun send(key: String, state: String, o: JSONObject) {
        sink?.invoke(o.put("id", key).put("st", state).toString())
    }

    /** The stored file the URL names, if it is one of ours and present. */
    fun fileFor(url: String?): Pair<File, String>? {
        if (url == null || !prefs.isServerUrl(url)) return null
        val u = Uri.parse(url)
        val path = u.encodedPath ?: return null
        if (!path.startsWith(PATH)) return null
        val key = Uri.decode(path.substring(PATH.length))
        if (!keyOk(key)) return null
        val f = audio(key)
        if (!f.isFile) return null
        val type = try {
            JSONObject(meta(key).readText()).optString("type", "audio/flac")
        } catch (_: Exception) {
            "audio/flac"
        }
        return f to type
    }

    fun isOfflineUrl(url: String?): Boolean {
        if (url == null || !prefs.isServerUrl(url)) return false
        return Uri.parse(url).encodedPath?.startsWith(PATH) == true
    }

    /** The WebView's answer for an offline URL: the file, or a 404. */
    fun serve(url: String, range: String?): WebResourceResponse {
        val hit = fileFor(url) ?: return WebResourceResponse(
            "text/plain", "utf-8", 404, "Not downloaded", mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0))
        )
        val (file, type) = hit
        val size = file.length()
        val headers = HashMap<String, String>()
        headers["Accept-Ranges"] = "bytes"
        headers["Cache-Control"] = "no-store"
        if (!RangeBody.isRange(range)) {
            headers["Content-Length"] = size.toString()
            return WebResourceResponse(type, null, 200, "OK", headers, file.inputStream())
        }
        val span = RangeBody.bounds(range, size)
        if (span == null) {
            headers["Content-Range"] = "bytes */$size"
            return WebResourceResponse(
                type, null, 416, "Range Not Satisfiable", headers, ByteArrayInputStream(ByteArray(0))
            )
        }
        val (start, end) = span[0] to span[1]
        headers["Content-Range"] = "bytes $start-$end/$size"
        // No Content-Length: the WebView sets it from the range it applies
        // itself, on a body that starts at byte 0 (see RangeBody).
        return WebResourceResponse(type, null, 206, "Partial Content", headers, RangeBody.of(file, end))
    }

    companion object {
        @Volatile private var instance: OfflineStore? = null

        /** The process's store. */
        fun shared(context: Context): OfflineStore =
            instance ?: synchronized(this) {
                instance ?: OfflineStore(
                    context.applicationContext, Prefs(context.applicationContext),
                    cookieFor = { url ->
                        try {
                            CookieManager.getInstance().getCookie(url)
                        } catch (_: Exception) {
                            null
                        }
                    },
                ).also { instance = it }
            }

        const val PATH = "/__nsoffline/"
        private const val PARALLEL = 2
        private const val PROGRESS_MS = 250L
        private const val CONNECT_MS = 15000
        private const val READ_MS = 60000
        private const val RESUMES = 3
        private val KEY = Regex("[A-Za-z0-9:_-]{1,96}")
        fun keyOk(key: String) = KEY.matches(key)
    }
}

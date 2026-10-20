package org.nsupysonic.app

import android.content.Context
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import org.json.JSONObject
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.util.concurrent.atomic.AtomicInteger

/**
 * The page's audio elements, played by Media3/ExoPlayer in the app's process.
 *
 * The web player keeps its whole logic — the queue, the crossfade, the
 * normalization riding the volume — and only the ELEMENT changes:
 * lib/audio/nativeplayer.js puts one of these players behind the
 * HTMLMediaElement interface Player.svelte is written against. Each player is
 * an id; the page sends commands (Bridge.naCmd) and gets its state back through
 * `window.__nsAudio(id, state)`, on every change and four times a second while
 * it plays. Every state echoes the sequence number of the last command applied
 * (`c`), which is how the page tells a report that predates its last pause or
 * seek from one that answers it.
 *
 * Rules the WebView's own media requests follow, kept here:
 *  - sources are the configured server's URLs only (Prefs.isServerUrl), read
 *    through Net (the session cookie to that server only, its pinned
 *    certificate, redirects followed by hand);
 *  - the audio focus is the APP's: ONE request for all the players, since a
 *    crossfade has two playing at once and two requests would make the first
 *    lose the focus to the second;
 *  - nothing outlives the page that made it: every player belongs to the
 *    document that made it (a token it draws at load), the first player a new
 *    document asks for releases the old document's, the page releases its own
 *    on `pagehide`, and the WebView going away releases them all (releaseAll).
 *
 * Everything runs on the main looper: the bridge's binder thread only posts.
 */
@OptIn(UnstableApi::class)
class NativeAudio(
    private val context: Context,
    private val prefs: Prefs,
    private val cookieFor: (String) -> String?,
    private val emit: (Int, String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val nextId = AtomicInteger(1)
    private val live = AtomicInteger(0)
    private val slots = HashMap<Int, Slot>()
    private var page = ""
    private val audioManager = context.getSystemService(AudioManager::class.java)
    private var focusRequest: AudioFocusRequest? = null
    private var hasFocus = false
    private val pausedByFocus = HashSet<Int>()

    /** A new player's id; one the app cannot make answers with an error at once. */
    fun create(page: String): Int {
        val id = nextId.getAndIncrement()
        main.post {
            if (page != this.page) {
                // A new document: what the last one made answers to nobody.
                for (s in slots.values.toList()) s.release()
                slots.clear()
                pausedByFocus.clear()
                this.page = page
            }
            // A page that leaks players is told on the first one it cannot have.
            if (live.get() >= MAX_PLAYERS) {
                refuse(id)
                return@post
            }
            live.incrementAndGet()
            try {
                slots[id] = Slot(id)
            } catch (_: Exception) {
                live.decrementAndGet()
                refuse(id)
            }
        }
        return id
    }

    private fun refuse(id: Int) =
        emit(id, JSONObject().put("c", 0).put("ev", "error").put("code", 4).put("msg", "no player").toString())

    fun command(id: Int, json: String) {
        val o = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        main.post { slots[id]?.command(o) }
    }

    /** The page that owned the players is gone (reload, navigation, teardown). */
    fun releaseAll() {
        val run = Runnable {
            for (s in slots.values.toList()) s.release()
            slots.clear()
            pausedByFocus.clear()
            abandonFocus()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
    }

    // --- the audio focus, for all the players at once ------------------------

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change -> onFocus(change) }

    private fun requestFocus() {
        if (hasFocus) return
        val req = focusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            // A notification ducking us is the system's job.
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener(focusListener, main)
            .build()
            .also { focusRequest = it }
        // Denied (a phone call): play anyway, as the WebView did.
        hasFocus = audioManager?.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonFocus() {
        val req = focusRequest ?: return
        if (hasFocus) audioManager?.abandonAudioFocusRequest(req)
        hasFocus = false
    }

    private fun onFocus(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                hasFocus = false
                pausedByFocus.clear()
                for (s in slots.values) s.player.playWhenReady = false
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                for (s in slots.values) if (s.player.playWhenReady) {
                    pausedByFocus.add(s.id)
                    s.player.playWhenReady = false
                }
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasFocus = true
                for (id in pausedByFocus) slots[id]?.player?.playWhenReady = true
                pausedByFocus.clear()
            }
        }
    }

    // --- one player ----------------------------------------------------------

    private inner class Slot(val id: Int) : Player.Listener {
        val player: ExoPlayer = ExoPlayer.Builder(context)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(DataSource.Factory { ServerDataSource(prefs, cookieFor) })
            )
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                false // the focus is handled above, once for every player
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        private var lastCmd = 0L
        private var hasItem = false
        private var prepared = false
        private var pendingSeek = false
        private var released = false
        private val tick = object : Runnable {
            override fun run() {
                if (released || !player.isPlaying) return
                send("tick")
                main.postDelayed(this, TICK_MS)
            }
        }

        init {
            player.addListener(this)
        }

        fun command(o: JSONObject) {
            if (released) return
            lastCmd = maxOf(lastCmd, o.optLong("c", lastCmd))
            when (o.optString("op")) {
                "src" -> {
                    val url = o.optString("url")
                    pendingSeek = false
                    player.stop()
                    player.clearMediaItems()
                    hasItem = false
                    prepared = false
                    if (!prefs.isServerUrl(url)) {
                        error(4, "source refused")
                        return
                    }
                    player.playWhenReady = false
                    player.volume = o.optDouble("v", 1.0).toFloat().coerceIn(0f, 1f)
                    player.setPlaybackSpeed(rate(o.optDouble("r", 1.0)))
                    player.setMediaItem(MediaItem.fromUri(url))
                    hasItem = true
                    if (o.optBoolean("pre", true)) prepare()
                    send(null)
                }
                "clear" -> {
                    pendingSeek = false
                    player.stop()
                    player.clearMediaItems()
                    hasItem = false
                    prepared = false
                    send(null)
                }
                "play" -> {
                    if (hasItem) prepare()
                    if (player.playbackState == Player.STATE_ENDED) player.seekTo(0)
                    requestFocus()
                    pausedByFocus.remove(id)
                    player.playWhenReady = true
                    send(null)
                }
                "pause" -> {
                    pausedByFocus.remove(id)
                    player.playWhenReady = false
                    send(null)
                }
                "seek" -> {
                    val ms = (o.optDouble("t", 0.0) * 1000).toLong().coerceAtLeast(0)
                    if (!hasItem) {
                        send("seeked")
                        return
                    }
                    prepare()
                    pendingSeek = true
                    player.seekTo(ms)
                    // A seek that needs no buffering may never leave READY.
                    if (player.playbackState == Player.STATE_READY) {
                        pendingSeek = false
                        send("seeked")
                    } else send(null)
                }
                "volume" -> player.volume = o.optDouble("v", 1.0).toFloat().coerceIn(0f, 1f)
                "rate" -> {
                    player.setPlaybackSpeed(rate(o.optDouble("r", 1.0)))
                    send(null)
                }
                "release" -> {
                    release()
                    slots.remove(id)
                }
            }
        }

        private fun prepare() {
            if (prepared) return
            prepared = true
            player.prepare()
        }

        private fun rate(r: Double): Float =
            if (r.isNaN()) 1f else r.toFloat().coerceIn(0.25f, 4f)

        fun release() {
            if (released) return
            released = true
            main.removeCallbacks(tick)
            pausedByFocus.remove(id)
            live.decrementAndGet()
            try {
                player.removeListener(this)
                player.release()
            } catch (_: Exception) {
                /* already gone */
            }
        }

        private fun send(ev: String?) {
            if (released) return
            val o = JSONObject()
                .put("c", lastCmd)
                .put("st", player.playbackState)
                .put("p", player.playWhenReady)
                .put("t", player.currentPosition / 1000.0)
                .put("b", player.bufferedPosition / 1000.0)
                .put("sk", hasItem && player.isCurrentMediaItemSeekable)
            val d = player.duration
            if (hasItem && d != C.TIME_UNSET && d > 0) o.put("d", d / 1000.0)
            if (ev != null) o.put("ev", ev)
            emit(id, o.toString())
        }

        private fun error(code: Int, msg: String) {
            if (released) return
            emit(id, JSONObject().put("c", lastCmd).put("ev", "error").put("code", code).put("msg", msg).toString())
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_READY && pendingSeek) {
                pendingSeek = false
                send("seeked")
            } else send(null)
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = send(null)

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            main.removeCallbacks(tick)
            if (isPlaying) main.postDelayed(tick, TICK_MS)
        }

        override fun onPlayerError(e: PlaybackException) {
            pendingSeek = false
            prepared = false // a play() after an error prepares again
            // HTMLMediaElement's codes: 2 network, 3 decode, 4 source not supported.
            val code = when (e.errorCode) {
                in 3000..3999 -> 4
                in 4000..5999 -> 3
                else -> 2
            }
            error(code, e.errorCodeName)
        }
    }

    companion object {
        private const val MAX_PLAYERS = 6
        private const val TICK_MS = 250L
    }
}

/**
 * The server's audio, read through Net: Range requests for seeking, the session
 * cookie, the pinned certificate. A server that answers a ranged request with
 * the whole file (200) is read past the bytes before the range.
 */
@OptIn(UnstableApi::class)
class ServerDataSource(
    private val prefs: Prefs,
    private val cookieFor: (String) -> String?,
) : BaseDataSource(true) {
    private var conn: HttpURLConnection? = null
    private var input: InputStream? = null
    private var uri: Uri? = null
    private var remaining = C.LENGTH_UNSET.toLong()
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        transferInitializing(dataSpec)
        val url = dataSpec.uri.toString()
        if (!prefs.isServerUrl(url)) throw IOException("not the server")
        val headers = HashMap<String, String>()
        // Compressed bytes would not match the byte offsets ExoPlayer asks for.
        headers["Accept-Encoding"] = "identity"
        val unset = C.LENGTH_UNSET.toLong()
        if (dataSpec.position > 0 || dataSpec.length != unset) {
            val end = if (dataSpec.length == unset) "" else (dataSpec.position + dataSpec.length - 1).toString()
            headers["Range"] = "bytes=${dataSpec.position}-$end"
        }
        val c = Net.get(prefs, url, cookieFor(url), CONNECT_MS, READ_MS, headers)
        conn = c
        val stream = c.inputStream
        input = stream
        var skip = if (c.responseCode == 200) dataSpec.position else 0L
        val total = c.contentLengthLong
        val buf = ByteArray(16 * 1024)
        while (skip > 0) {
            val n = stream.read(buf, 0, minOf(buf.size.toLong(), skip).toInt())
            if (n < 0) throw EOFException()
            skip -= n
        }
        val skipped = if (c.responseCode == 200) dataSpec.position else 0L
        remaining = when {
            dataSpec.length != unset -> dataSpec.length
            total >= 0 -> total - skipped
            else -> unset
        }
        opened = true
        transferStarted(dataSpec)
        return remaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        val unset = C.LENGTH_UNSET.toLong()
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val want = if (remaining == unset) length else minOf(length.toLong(), remaining).toInt()
        val n = input?.read(buffer, offset, want) ?: return C.RESULT_END_OF_INPUT
        if (n < 0) {
            if (remaining != unset) throw EOFException()
            return C.RESULT_END_OF_INPUT
        }
        if (remaining != unset) remaining -= n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        try {
            input?.close()
        } catch (_: IOException) {
        } finally {
            input = null
            conn?.disconnect()
            conn = null
            if (opened) {
                opened = false
                transferEnded()
            }
        }
    }

    companion object {
        private const val CONNECT_MS = 15_000
        // A first play is the server fetching from Deezer as it streams.
        private const val READ_MS = 30_000
    }
}

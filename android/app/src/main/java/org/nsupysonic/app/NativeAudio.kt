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
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import org.json.JSONObject
import java.io.EOFException
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.Channels
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
 * Two things the page cannot do for itself, because it may not be running:
 *  - CONTINUE. Hidden behind a locked screen the page is silent as far as
 *    Chromium knows (the sound comes out of here), and a hidden silent page is
 *    throttled and then frozen: the `ended` of a track reached a page that only
 *    ran again once somebody unlocked the phone. So while it is hidden the page
 *    names the track that follows (op `next`) and the player that finishes
 *    starts it on its own, reporting `adv`; the page catches up when it wakes
 *    (Player.svelte#onNativeAdvance).
 *  - SEEK IN A STREAM WITH NO LENGTH. A first play, or the first play at an
 *    Opus quality, is generated as it is sent: no Content-Length, no ranges, so
 *    ExoPlayer has no seek map and sends any seek back to 0. Such a seek is
 *    held (`chase`): the position reported is the target, the stream is read
 *    to its end (the buffer is sized to hold a whole track, which is also what
 *    lets the server finish its cached copy), then the same URL is opened
 *    again — now a file with ranges — at the target, muted until it lands.
 *
 * Everything runs on the main looper: the bridge's binder thread only posts.
 */
@OptIn(UnstableApi::class)
class NativeAudio(
    private val context: Context,
    private val prefs: Prefs,
    private val cookieFor: (String) -> String?,
    private val emit: (Int, String) -> Unit,
    // A download in the app's storage (OfflineStore), played off the disk.
    private val localFile: (String) -> File? = { null },
    // The analysis frames (NativeAnalysis), for lib/audio/engine.js.
    emitFrames: ((String) -> Unit)? = null,
    // A player went on to the next track by itself: what the page said of it
    // (title, artist, album, cover, duration), for the notification.
    private val onAdvance: (JSONObject?) -> Unit = {},
) {
    /** The rhythm analyser on what the players play; null without the native core. */
    val analysis: NativeAnalysis? = if (emitFrames != null && NsCore.available) NativeAnalysis(emitFrames) else null

    // The EQ and the bass lift every player's chain applies (NsProcessor).
    @Volatile private var fx = NsProcessor.Fx(0, FloatArray(10), 0f)

    /** The page's effects: `{eq: [10 dB], bass: 0..1}` (graph.js's settings). */
    fun setFx(json: String) {
        val o = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        val bands = FloatArray(10)
        o.optJSONArray("eq")?.let { a ->
            for (i in 0 until minOf(10, a.length())) {
                val v = a.optDouble(i, 0.0)
                bands[i] = if (v.isFinite()) v.toFloat().coerceIn(-16f, 16f) else 0f
            }
        }
        val amount = o.optDouble("bass", 0.0).let { if (it.isFinite()) it.coerceIn(0.0, 1.0) else 0.0 }
        fx = NsProcessor.Fx(fx.version + 1, bands, (amount * 12).toFloat())
    }

    /** One command for the analyser (NativeAnalysis.command). */
    fun analyse(json: String) {
        val a = analysis ?: return
        main.post { a.command(json) }
    }

    private val main = Handler(Looper.getMainLooper())
    private val nextId = AtomicInteger(1)
    private val live = AtomicInteger(0)
    private val slots = HashMap<Int, Slot>()
    private var page = ""
    private val audioManager = context.getSystemService(AudioManager::class.java)
    private var focusRequest: AudioFocusRequest? = null
    private var hasFocus = false
    private val pausedByFocus = HashSet<Int>()
    // The player the page told to play last: the one that goes on by itself.
    private var lastPlayed = 0

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
            analysis?.release()
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

    /** What follows the current track, as the page named it (op `next`). */
    private class Next(val url: String, val atMs: Long, val vol: Float, val key: String, val meta: JSONObject?)

    private inner class Slot(val id: Int) : Player.Listener {
        val proc = NsProcessor(id, analysis) { fx }
        val player: ExoPlayer = ExoPlayer.Builder(context, Renderers(context, proc))
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(DataSource.Factory {
                    ServerDataSource(prefs, cookieFor, localFile) { u -> main.post { onSourceRead(u) } }
                })
            )
            // A whole track in memory rather than ExoPlayer's 50 s: a stream with
            // no length can only be sought once it has been read to its end, and
            // the server only keeps its copy of a stream somebody read whole.
            .setLoadControl(
                DefaultLoadControl.Builder()
                    .setBufferDurationsMs(BUFFER_MS, BUFFER_MS, 2_500, 5_000)
                    .setTargetBufferBytes(BUFFER_BYTES)
                    .setPrioritizeTimeOverSizeThresholds(false)
                    .build()
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
        private var url = ""
        // The current source was read from its first byte to its last.
        private var complete = false
        // A seek held in a stream with no seek map (ms), -1 when none.
        private var chaseMs = -1L
        private var chaseTries = 0
        private var chaseReopened = false
        // The page's volume, kept while a chase holds the player muted.
        private var vol = 1f
        // What follows, in order, as the page last named it.
        private var next: List<Next> = emptyList()
        // The key of the track this player went on to by itself, until the next source.
        private var curKey = ""
        private val window = Timeline.Window()
        private val chaseTimeout = Runnable { endChase() }
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
                    cancelChase()
                    next = emptyList()
                    curKey = ""
                    complete = false
                    this.url = url
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
                    proc.startAt = 0.0
                    setVol(o.optDouble("v", 1.0))
                    player.setPlaybackSpeed(rate(o.optDouble("r", 1.0)))
                    player.setMediaItem(MediaItem.fromUri(url))
                    hasItem = true
                    if (o.optBoolean("pre", true)) prepare()
                    send(null)
                }
                "clear" -> {
                    cancelChase()
                    next = emptyList()
                    curKey = ""
                    complete = false
                    url = ""
                    pendingSeek = false
                    player.stop()
                    player.clearMediaItems()
                    hasItem = false
                    prepared = false
                    send(null)
                }
                "play" -> {
                    if (hasItem) prepare()
                    if (chaseMs < 0 && player.playbackState == Player.STATE_ENDED) {
                        proc.startAt = 0.0
                        player.seekTo(0)
                    }
                    requestFocus()
                    pausedByFocus.remove(id)
                    // The analyser follows the player told to play last: the
                    // incoming track of a crossfade, the one the page names.
                    analysis?.analysed = id
                    lastPlayed = id
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
                    if (knownUnseekable()) {
                        startChase(ms)
                        return
                    }
                    cancelChase()
                    pendingSeek = true
                    proc.startAt = ms / 1000.0
                    player.seekTo(ms)
                    // A seek that needs no buffering may never leave READY.
                    if (player.playbackState == Player.STATE_READY) {
                        pendingSeek = false
                        send("seeked")
                    } else send(null)
                }
                "volume" -> setVol(o.optDouble("v", 1.0))
                "next" -> next = parseNext(o)
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

        private fun setVol(v: Double) {
            vol = if (v.isFinite()) v.toFloat().coerceIn(0f, 1f) else 1f
            if (!(chaseMs >= 0 && chaseReopened)) player.volume = vol
        }

        /** `{q: [{url, at, v, k, meta}]}`; anything that is not the server's ends the list. */
        private fun parseNext(o: JSONObject): List<Next> {
            val a = o.optJSONArray("q") ?: return emptyList()
            val out = ArrayList<Next>()
            for (i in 0 until minOf(a.length(), MAX_NEXT)) {
                val e = a.optJSONObject(i) ?: break
                val u = e.optString("url")
                if (u.isEmpty() || !prefs.isServerUrl(u)) break
                val at = e.optDouble("at", 0.0).let { if (it.isFinite() && it > 0) (it * 1000).toLong() else 0L }
                val v = e.optDouble("v", 1.0).let { if (it.isFinite()) it.toFloat().coerceIn(0f, 1f) else 1f }
                out.add(Next(u, at, v, e.optString("k").take(128), e.optJSONObject("meta")))
            }
            return out
        }

        /** Whether the current source is known to have no seek map. */
        private fun knownUnseekable(): Boolean {
            val tl = player.currentTimeline
            if (tl.isEmpty) return false
            val i = player.currentMediaItemIndex
            if (i < 0 || i >= tl.windowCount) return false
            tl.getWindow(i, window)
            return !window.isPlaceholder && !window.isSeekable
        }

        // --- a seek in a stream with no length ---------------------------------

        private fun startChase(ms: Long) {
            val first = chaseMs < 0
            chaseMs = ms
            chaseTries = 0
            if (first) {
                main.removeCallbacks(chaseTimeout)
                main.postDelayed(chaseTimeout, CHASE_MAX_MS)
            }
            send(null)
            if (!chaseReopened && (complete || player.playbackState == Player.STATE_ENDED)) reopen()
        }

        /** The same URL again, which the server now has whole, at the target. */
        private fun reopen() {
            if (chaseMs < 0 || url.isEmpty()) return
            if (++chaseTries > CHASE_TRIES) {
                endChase()
                return
            }
            chaseReopened = true
            complete = false
            player.volume = 0f
            proc.startAt = chaseMs / 1000.0
            player.setMediaItem(MediaItem.fromUri(url), chaseMs)
            prepared = false
            prepare()
        }

        private fun onSourceRead(u: String) {
            if (released || u != url) return
            complete = true
            if (chaseMs >= 0) reopen()
        }

        private fun cancelChase() {
            if (chaseMs < 0) return
            chaseMs = -1
            chaseReopened = false
            main.removeCallbacks(chaseTimeout)
            player.volume = vol
        }

        /** Gave up: the position is where the sound really is. */
        private fun endChase() {
            if (chaseMs < 0) return
            cancelChase()
            send("seeked")
        }

        /** The page names the track that follows; this player goes on to it by itself. */
        private fun advance(n: Next) {
            next = next.drop(1)
            cancelChase()
            url = n.url
            complete = false
            pendingSeek = false
            vol = n.vol
            player.volume = vol
            proc.startAt = n.atMs / 1000.0
            player.setMediaItem(MediaItem.fromUri(n.url), n.atMs)
            hasItem = true
            prepared = false
            prepare()
            curKey = n.key.ifEmpty { "-" }
            send("adv")
            onAdvance(n.meta)
        }

        private fun rate(r: Double): Float =
            if (r.isNaN()) 1f else r.toFloat().coerceIn(0.25f, 4f)

        fun release() {
            if (released) return
            released = true
            main.removeCallbacks(tick)
            main.removeCallbacks(chaseTimeout)
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
            val chasing = chaseMs >= 0
            val o = JSONObject()
                .put("c", lastCmd)
                .put("st", player.playbackState)
                .put("p", player.playWhenReady)
                // A held seek reads as the element's would: at its target.
                .put("t", (if (chasing) chaseMs else player.currentPosition) / 1000.0)
                .put("b", player.bufferedPosition / 1000.0)
                .put("sk", hasItem && player.isCurrentMediaItemSeekable)
                // Any position can be asked for: a stream with no length is chased.
                .put("sc", true)
            // Every state says it, so a page that missed the first (frozen) still learns it.
            if (curKey.isNotEmpty()) o.put("k", curKey).put("u", url)
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
            if (chaseMs >= 0) {
                if (chaseReopened && state == Player.STATE_READY) {
                    if (knownUnseekable()) {
                        // Still generated as it is sent: muted, read it whole again.
                        if (complete) reopen()
                        return
                    }
                    if (kotlin.math.abs(player.currentPosition - chaseMs) > 1_000) player.seekTo(chaseMs)
                    cancelChase()
                    send("seeked")
                    return
                }
                if (state == Player.STATE_ENDED) {
                    // Read to its end, so the server has it whole.
                    complete = true
                    reopen()
                    return
                }
                send(null)
                return
            }
            if (state == Player.STATE_ENDED) {
                val n = next.firstOrNull()
                if (n != null && id == lastPlayed && player.playWhenReady) {
                    advance(n)
                    return
                }
            }
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
            cancelChase()
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

    /** A player whose audio sink runs its PCM through [proc]. */
    private class Renderers(context: Context, private val proc: NsProcessor) : DefaultRenderersFactory(context) {
        override fun buildAudioSink(
            context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean
        ): AudioSink? = DefaultAudioSink.Builder(context)
            .setEnableFloatOutput(enableFloatOutput)
            .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
            .setAudioProcessors(arrayOf<AudioProcessor>(proc))
            .build()
    }

    companion object {
        private const val MAX_PLAYERS = 6
        private const val TICK_MS = 250L
        // The buffer: a whole track of anything but a very long lossless one.
        private const val BUFFER_MS = 30 * 60 * 1000
        private const val BUFFER_BYTES = 32 * 1024 * 1024
        // A held seek gives up after this, or after this many reopenings.
        private const val CHASE_MAX_MS = 60_000L
        private const val CHASE_TRIES = 4
        // How many tracks ahead the page may name.
        private const val MAX_NEXT = 12
    }
}

/**
 * The server's audio, read through Net: Range requests for seeking, the session
 * cookie, the pinned certificate. A server that answers a ranged request with
 * the whole file (200) is read past the bytes before the range. A download's
 * URL (OfflineStore.PATH) is read from its file instead, with no network.
 */
@OptIn(UnstableApi::class)
class ServerDataSource(
    private val prefs: Prefs,
    private val cookieFor: (String) -> String?,
    private val localFile: (String) -> File? = { null },
    // The URL was read from its first byte to its last (NativeAudio's chase).
    private val onWhole: (String) -> Unit = {},
) : BaseDataSource(true) {
    private var conn: HttpURLConnection? = null
    private var fromStart = false
    private var input: InputStream? = null
    private var uri: Uri? = null
    private var remaining = C.LENGTH_UNSET.toLong()
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        fromStart = dataSpec.position == 0L && dataSpec.length == C.LENGTH_UNSET.toLong()
        transferInitializing(dataSpec)
        val url = dataSpec.uri.toString()
        if (!prefs.isServerUrl(url)) throw IOException("not the server")
        val unset0 = C.LENGTH_UNSET.toLong()
        localFile(url)?.let { f ->
            val raf = RandomAccessFile(f, "r")
            raf.seek(dataSpec.position)
            input = Channels.newInputStream(raf.channel)
            val left = f.length() - dataSpec.position
            if (left < 0) throw EOFException()
            remaining = if (dataSpec.length != unset0) minOf(dataSpec.length, left) else left
            opened = true
            transferStarted(dataSpec)
            return remaining
        }
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
        if (remaining == 0L) return whole()
        val want = if (remaining == unset) length else minOf(length.toLong(), remaining).toInt()
        val n = input?.read(buffer, offset, want) ?: return C.RESULT_END_OF_INPUT
        if (n < 0) {
            if (remaining != unset) throw EOFException()
            return whole()
        }
        if (remaining != unset) remaining -= n
        bytesTransferred(n)
        return n
    }

    private fun whole(): Int {
        if (fromStart) {
            fromStart = false
            uri?.let { onWhole(it.toString()) }
        }
        return C.RESULT_END_OF_INPUT
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

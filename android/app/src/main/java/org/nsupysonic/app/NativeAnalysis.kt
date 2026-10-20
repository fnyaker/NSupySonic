package org.nsupysonic.app

import android.os.SystemClock
import android.util.Base64
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * The rhythm analyser on the NATIVE player's sound (lot N5): what the page's
 * AudioWorklet does for an element it can route, done here for the players it
 * cannot (NativeAudio). The same Rust crate (NsCore) reads the PCM each
 * player's [NsProcessor] hands it — after the EQ and the bass lift, as the
 * worklet taps the graph after them — and its frames go to the page in
 * batches through `window.__nsFrames`, each stamped with the MEDIA time its
 * audio starts at. lib/audio/engine.js holds a frame until the element's own
 * clock reaches that time, so a kick is drawn when it is heard: ExoPlayer's
 * position already accounts for the output path.
 *
 * One analyser for every player: it follows the player told to play last
 * (the incoming one of a crossfade, which is also the track the page names).
 * The page drives it with the worklet's own messages (start, level, seed,
 * lock, pin, profile, range, groove, reset, sleep), as JSON.
 *
 * Thread rules: [feed] runs on a player's playback thread, [command] on the
 * main looper; both hold the lock, and nothing in either blocks.
 */
class NativeAnalysis(private val emit: (String) -> Unit) {
    private val lock = Any()
    private var h = 0L
    private var sr = 0f
    private var input: FloatBuffer? = null
    private var output: FloatBuffer? = null
    private var frameLen = 0
    private var hop = 512
    private var frameAt = 0 // the "frame" field's offset in a frame
    private var layout = ""

    // What the page asked for, kept so a new analyser (another sample rate)
    // starts in the same state.
    @Volatile private var started = false
    @Volatile private var awake = true
    private var level = 0
    private var gen = 0
    private var families: FloatArray? = null

    /** The player whose sound is analysed. */
    @Volatile var analysed = 0

    /** Whether [el]'s sound is wanted now (read without the lock, per buffer). */
    fun wants(el: Int): Boolean = started && awake && el == analysed

    private var pushed = 0L // samples pushed since the analyser was made

    // The batch going out.
    private var batch: ByteBuffer = ByteBuffer.allocate(0)
    private var batchFrames = 0
    private val batchMt = DoubleArray(MAX_BATCH)
    private var batchEl = 0
    private var batchAt = 0L

    fun command(json: String) {
        val o = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        if (!NsCore.available) return
        synchronized(lock) {
            when (o.optString("t")) {
                "start" -> {
                    started = true
                    awake = true
                    level = o.optInt("level", 0).coerceIn(0, 2)
                    gen = o.optInt("gen", 0)
                    families = o.optJSONArray("families")?.let { a ->
                        FloatArray(minOf(a.length(), FAMILIES_MAX)) { a.optDouble(it, 0.0).toFloat() }
                    }
                    if (h != 0L) {
                        configure()
                        ready()
                    }
                }
                "level" -> {
                    level = o.optInt("level", 0).coerceIn(0, 2)
                    NsCore.analyserSetLevel(h, level)
                }
                "seed" -> NsCore.analyserSeed(h, f(o, "bpm"), f(o, "conf"))
                "lock" -> NsCore.analyserLockTempo(h, f(o, "bpm"))
                "pin" -> NsCore.analyserPinFamily(h, o.optInt("i", -1))
                "profile" -> NsCore.analyserSetProfile(h, f(o, "lull"), o.optBoolean("kicks", true))
                "range" -> NsCore.analyserSetRange(h, f(o, "lo"), f(o, "hi"))
                "liveRange" -> NsCore.analyserSetLiveRange(h, o.optBoolean("on", false))
                "groove" -> NsCore.analyserSetGroove(h, o.optInt("g", 0))
                "reset" -> {
                    NsCore.analyserReset(h)
                    gen = o.optInt("gen", gen)
                    batchFrames = 0
                }
                "sleep" -> {
                    awake = !o.optBoolean("on", false)
                    if (!awake) batchFrames = 0
                }
                "close" -> {
                    started = false
                    free()
                }
            }
        }
    }

    private fun f(o: JSONObject, k: String): Float {
        val v = o.optDouble(k, 0.0)
        return if (v.isFinite()) v.toFloat() else 0f
    }

    private fun free() {
        if (h != 0L) NsCore.analyserFree(h)
        h = 0L
        input = null
        output = null
        batchFrames = 0
    }

    /** The analyser for [rate], made (or remade) on the playback thread that needs it. */
    private fun ensure(rate: Float): Boolean {
        if (h != 0L && rate == sr) return true
        free()
        if (!NsCore.available) return false
        val n = NsCore.analyserNew(rate)
        if (n == 0L) return false
        h = n
        sr = rate
        input = NsCore.analyserInput(n)?.order(ByteOrder.nativeOrder())?.asFloatBuffer()
        output = NsCore.analyserOutput(n)?.order(ByteOrder.nativeOrder())?.asFloatBuffer()
        frameLen = NsCore.analyserFrameLen(n)
        hop = NsCore.analyserHop(n).coerceAtLeast(1)
        layout = NsCore.layout()
        frameAt = offsetOf(layout, "frame")
        pushed = 0
        batch = ByteBuffer.allocate(MAX_BATCH * frameLen * 4).order(ByteOrder.LITTLE_ENDIAN)
        if (input == null || output == null || frameLen <= 0) {
            free()
            return false
        }
        configure()
        ready()
        return true
    }

    private fun configure() {
        families?.let { t ->
            val inp = input ?: return@let
            inp.clear()
            inp.put(t, 0, minOf(t.size, inp.capacity()))
            NsCore.analyserLoadFamilies(h, minOf(t.size, inp.capacity()))
        }
        NsCore.analyserSetLevel(h, level)
        // The genre is the server's (see rhythm.worklet.js): no live rules.
        NsCore.analyserSetClassify(h, false)
        NsCore.analyserSetLiveRange(h, false)
    }

    private fun ready() {
        if (!started) return
        emit(
            JSONObject().put("t", "ready").put("layout", layout).put("hop", hop)
                .put("lookahead", 4).put("frameLen", frameLen).put("sampleRate", sr.toDouble())
                .toString()
        )
    }

    /**
     * [frames] interleaved frames of [channels] samples from player [el], at
     * [rate], whose LAST sample is heard at media time [endSec].
     */
    fun feed(el: Int, buf: FloatBuffer, frames: Int, channels: Int, rate: Float, endSec: Double) {
        if (el != analysed || !started) return
        synchronized(lock) {
            if (!started || !awake || el != analysed) return
            if (!ensure(rate)) return
            val inp = input ?: return
            var done = 0
            while (done < frames) {
                val n = minOf(frames - done, inp.capacity())
                inp.clear()
                for (i in 0 until n) {
                    var s = 0f
                    val base = (done + i) * channels
                    for (c in 0 until channels) s += buf.get(base + c)
                    inp.put(i, s / channels)
                }
                val k = NsCore.analyserPush(h, n)
                pushed += n
                done += n
                // The media time of the end of this piece.
                val end = endSec - (frames - done) / rate.toDouble()
                if (k > 0) collect(el, k, end)
            }
            val now = SystemClock.uptimeMillis()
            if (batchFrames > 0 && now - batchAt >= BATCH_MS) flush()
        }
    }

    private fun collect(el: Int, k: Int, end: Double) {
        val out = output ?: return
        if (batchFrames > 0 && el != batchEl) flush()
        for (i in 0 until k) {
            if (batchFrames >= MAX_BATCH) flush()
            if (batchFrames == 0) {
                batchEl = el
                batchAt = SystemClock.uptimeMillis()
                batch.clear()
            }
            val base = i * frameLen
            val j = out.get(base + frameAt).toDouble()
            // Frame j's audio started j·hop samples into the analyser's input.
            batchMt[batchFrames] = end - (pushed - j * hop) / sr
            for (x in 0 until frameLen) batch.putFloat(out.get(base + x))
            batchFrames++
        }
    }

    private fun flush() {
        if (batchFrames == 0) return
        val bytes = ByteArray(batchFrames * frameLen * 4)
        batch.flip()
        batch.get(bytes)
        batch.clear()
        val mt = JSONArray()
        for (i in 0 until batchFrames) mt.put(Math.round(batchMt[i] * 1e5) / 1e5)
        val o = JSONObject().put("t", "f").put("gen", gen).put("el", batchEl).put("n", batchFrames)
            .put("b", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("mt", mt)
        batchFrames = 0
        emit(o.toString())
    }

    fun release() {
        synchronized(lock) {
            started = false
            free()
        }
    }

    companion object {
        private const val MAX_BATCH = 16
        private const val BATCH_MS = 40L
        private const val FAMILIES_MAX = 16384

        /** Where field [name] starts in a frame, by the layout "name:len;…". */
        fun offsetOf(layout: String, name: String): Int {
            var at = 0
            for (part in layout.split(';', ',')) {
                val kv = part.split(':')
                if (kv.size != 2) continue
                if (kv[0].trim() == name) return at
                at += kv[1].trim().toIntOrNull() ?: 0
            }
            return 0
        }
    }
}

/**
 * What one native player's PCM goes through before the AudioTrack (lot N5):
 * the Rust output chain (NsCore: the ten-band EQ, the bass shelf and its two
 * compressors — graph.js's processing, the same formulas) and a copy to the
 * analyser. 16-bit PCM only, which is what DefaultAudioSink hands its
 * processors; anything else, or no native core, and it is not in the path.
 *
 * Runs on the player's playback thread. Settings arrive through [settings]
 * (written on the main looper, read here by version), and the media time of
 * what comes in is counted from [startAt], which the player sets on every new
 * source and seek: a flush starts the count again from there, and a flush with
 * none pending (a speed change) continues it.
 */
@OptIn(UnstableApi::class)
class NsProcessor(
    private val el: Int,
    private val analysis: NativeAnalysis?,
    private val settings: () -> Fx,
) : BaseAudioProcessor() {
    /** EQ bands (dB), the bass lift (dB, 0..12), and a version to notice a change by. */
    class Fx(val version: Int, val eq: FloatArray, val bassDb: Float) {
        val flat: Boolean get() = bassDb <= 0.001f && eq.all { kotlin.math.abs(it) < 0.01f }
    }

    @Volatile var startAt: Double = Double.NaN

    private var chain = 0L
    private var chainRate = 0f
    private var chainCh = 0
    private var buf: FloatBuffer? = null
    private var applied = -1
    private var count = 0L // frames since the base
    private var base = 0.0

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (!NsCore.available || inputAudioFormat.encoding != C.ENCODING_PCM_16BIT ||
            inputAudioFormat.channelCount !in 1..8
        ) return AudioProcessor.AudioFormat.NOT_SET
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val size = inputBuffer.remaining()
        if (size == 0) return
        val fmt = inputAudioFormat
        val ch = fmt.channelCount
        val frames = size / (2 * ch)
        val out = replaceOutputBuffer(size)
        val fx = settings()
        val wantFx = !fx.flat
        val wantAnalysis = analysis != null && analysis.wants(el)
        if (!wantFx && !wantAnalysis) {
            out.put(inputBuffer)
            out.flip()
            count += frames
            return
        }
        if (!ensureChain(fmt.sampleRate.toFloat(), ch)) {
            out.put(inputBuffer)
            out.flip()
            count += frames
            return
        }
        if (fx.version != applied) {
            applied = fx.version
            for (b in 0 until 10) NsCore.chainSetEq(chain, b, fx.eq.getOrElse(b) { 0f })
            NsCore.chainSetBass(chain, fx.bassDb.coerceIn(0f, 12f))
        }
        val fb = buf ?: return
        val src = inputBuffer.order(ByteOrder.nativeOrder())
        val piece = fb.capacity() / ch
        var left = frames
        while (left > 0) {
            val n = minOf(left, piece)
            fb.clear()
            for (i in 0 until n * ch) fb.put(i, src.getShort().toFloat() / 32768f)
            NsCore.chainProcess(chain, n)
            count += n
            if (wantAnalysis) analysis?.feed(el, fb, n, ch, fmt.sampleRate.toFloat(), base + count / fmt.sampleRate.toDouble())
            for (i in 0 until n * ch) {
                out.putShort(Math.round(fb.get(i) * 32768f).coerceIn(-32768, 32767).toShort())
            }
            left -= n
        }
        // A frame's odd trailing bytes, if any (never for whole PCM frames).
        while (src.hasRemaining()) out.put(src.get())
        out.flip()
    }

    private fun ensureChain(rate: Float, ch: Int): Boolean {
        if (chain != 0L && rate == chainRate && ch == chainCh) return true
        freeChain()
        val c = NsCore.chainNew(rate, ch)
        if (c == 0L) return false
        chain = c
        chainRate = rate
        chainCh = ch
        buf = NsCore.chainBuffer(c)?.order(ByteOrder.nativeOrder())?.asFloatBuffer()
        applied = -1
        if (buf == null) {
            freeChain()
            return false
        }
        return true
    }

    private fun freeChain() {
        if (chain != 0L) NsCore.chainFree(chain)
        chain = 0L
        buf = null
    }

    override fun onFlush() {
        val s = startAt
        if (!s.isNaN()) {
            base = s
            count = 0
            startAt = Double.NaN
        }
        // The filters' memory is the previous position's (a seek). A processor
        // that is not in the path is flushed too, with no chain and maybe no core.
        if (chain != 0L) NsCore.chainClear(chain)
    }

    override fun onReset() {
        freeChain()
        count = 0
        base = 0.0
    }
}

package org.nsupysonic.app

import android.util.Log
import java.nio.ByteBuffer

/**
 * The native audio core (android/nscore, Rust): the rhythm analyser the web app
 * runs in its AudioWorklet, compiled for the device, and the output chain
 * (normalization, fades, EQ, bass) a native player will run its PCM through.
 *
 * Optional by construction: a build without the library (Gradle run without
 * nscore/build-android.sh first) or with one of another ABI version simply has
 * [available] false, and the app plays through the WebView as it always did.
 *
 * Every object is a HANDLE (a Long, 0 = none) and its buffers are direct
 * ByteBuffers over the library's own memory, fetched once: a call only says how
 * much of them to use, nothing is copied across. Read them in nativeOrder().
 * The library accepts 0 everywhere and does nothing with it.
 */
object NsCore {
    /** The JNI surface this code was written against (nscore's ABI_VERSION). */
    private const val ABI = 1

    val available: Boolean by lazy {
        try {
            System.loadLibrary("nscore")
            val abi = abiVersion()
            if (abi != ABI) Log.w("NsCore", "libnscore ABI $abi, expected $ABI: not used")
            abi == ABI
        } catch (e: Throwable) {
            Log.i("NsCore", "native core not available: ${e.message}")
            false
        }
    }

    /** What the page is told (Bridge.nativeCore): present, and which analyser sources. */
    fun describe(): String {
        val o = org.json.JSONObject().put("available", available)
        if (available) o.put("abi", abiVersion()).put("hash", srcHash())
        return o.toString()
    }

    @JvmStatic external fun abiVersion(): Int
    @JvmStatic external fun srcHash(): Long
    @JvmStatic external fun layout(): String

    @JvmStatic external fun analyserNew(sampleRate: Float): Long
    @JvmStatic external fun analyserFree(h: Long)
    @JvmStatic external fun analyserInput(h: Long): ByteBuffer?
    @JvmStatic external fun analyserOutput(h: Long): ByteBuffer?
    @JvmStatic external fun analyserFrameLen(h: Long): Int
    @JvmStatic external fun analyserHop(h: Long): Int
    @JvmStatic external fun analyserPush(h: Long, n: Int): Int
    @JvmStatic external fun analyserLoadFamilies(h: Long, n: Int): Boolean
    @JvmStatic external fun analyserSetLevel(h: Long, level: Int)
    @JvmStatic external fun analyserSeed(h: Long, bpm: Float, conf: Float): Boolean
    @JvmStatic external fun analyserLockTempo(h: Long, bpm: Float): Boolean
    @JvmStatic external fun analyserSetRange(h: Long, lo: Float, hi: Float)
    @JvmStatic external fun analyserPinFamily(h: Long, id: Int)
    @JvmStatic external fun analyserSetGroove(h: Long, groove: Int)
    @JvmStatic external fun analyserSetProfile(h: Long, dropLullBeats: Float, kicks: Boolean)
    @JvmStatic external fun analyserSetClassify(h: Long, on: Boolean)
    @JvmStatic external fun analyserSetLiveRange(h: Long, on: Boolean)
    @JvmStatic external fun analyserReset(h: Long)

    @JvmStatic external fun chainNew(sampleRate: Float, channels: Int): Long
    @JvmStatic external fun chainFree(h: Long)
    @JvmStatic external fun chainBuffer(h: Long): ByteBuffer?
    @JvmStatic external fun chainProcess(h: Long, frames: Int)
    @JvmStatic external fun chainSetGain(h: Long, db: Float, rampMs: Float)
    @JvmStatic external fun chainFadeTo(h: Long, to: Float, ms: Float)
    @JvmStatic external fun chainFade(h: Long): Float
    @JvmStatic external fun chainSetEq(h: Long, band: Int, db: Float)
    @JvmStatic external fun chainSetBass(h: Long, db: Float)
    @JvmStatic external fun chainClear(h: Long)
}

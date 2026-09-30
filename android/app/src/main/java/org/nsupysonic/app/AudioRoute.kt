package org.nsupysonic.app

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * Which output the music is going to, told to the page (lib/audio/output.js).
 *
 * The page plays DIRECT — the WebView's own media pipeline, never Web Audio —
 * on a Bluetooth output: on Android, a Web Audio context that hosts an
 * AudioWorklet renders on the worklet thread and hands its audio to the device
 * through a FIFO, and an A2DP sink pulls in bursts large and irregular enough
 * that the FIFO is padded with silence and then drops what arrives late. Heard
 * through a car radio's AAC link it is the report this exists for: the music
 * sounds sped up, with pieces cut out. The WebView cannot see what it is
 * playing to, so it is told from here.
 *
 * No permission is needed: AudioManager lists output devices to any app, and
 * a Bluetooth device's product name is its advertised name ("KMM-BT309").
 * Media goes to the most recently connected external sink by Android's routing
 * policy — Bluetooth, then USB, then wired, then HDMI, then the speaker — which
 * is the order [current] ranks them in.
 */
class AudioRoute(context: Context, private val onChange: (String) -> Unit) {

    private val am: AudioManager? = context.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var last = ""
    private var started = false

    private val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = changed()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = changed()
    }

    /** Start listening; the callback also reports the devices present now. */
    fun start() {
        if (started) return
        started = true
        try {
            am?.registerAudioDeviceCallback(callback, main)
        } catch (_: Exception) {
            started = false
        }
    }

    fun stop() {
        if (!started) return
        started = false
        try {
            am?.unregisterAudioDeviceCallback(callback)
        } catch (_: Exception) {
        }
    }

    private fun changed() {
        val json = current()
        if (json != last) {
            last = json
            onChange(json)
        }
    }

    /** The route as JSON: {"kind": "bluetooth"|"usb"|"wired"|"hdmi"|"speaker"|"unknown", "name": …}. */
    fun current(): String {
        val devices: Array<AudioDeviceInfo> = try {
            am?.getDevices(AudioManager.GET_DEVICES_OUTPUTS) ?: emptyArray<AudioDeviceInfo>()
        } catch (_: Exception) {
            emptyArray<AudioDeviceInfo>()
        }
        var best: AudioDeviceInfo? = null
        var bestRank = Int.MAX_VALUE
        for (d in devices) {
            val r = rank(d.type)
            if (r < bestRank) {
                best = d
                bestRank = r
            }
        }
        val o = JSONObject()
        o.put("kind", if (best == null) "unknown" else kindOf(best.type))
        o.put("name", best?.let { clean(it.productName?.toString()) } ?: "")
        o.put("type", best?.type ?: 0)
        return o.toString()
    }

    private fun rank(type: Int): Int = when (kindOf(type)) {
        "bluetooth" -> 0
        "usb" -> 1
        "wired" -> 2
        "hdmi" -> 3
        "speaker" -> 4
        else -> 9
    }

    private fun kindOf(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
        AudioDeviceInfo.TYPE_BLE_BROADCAST,
        AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY,
        AudioDeviceInfo.TYPE_DOCK -> "usb"
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_LINE_ANALOG,
        AudioDeviceInfo.TYPE_LINE_DIGITAL,
        AudioDeviceInfo.TYPE_AUX_LINE -> "wired"
        AudioDeviceInfo.TYPE_HDMI,
        AudioDeviceInfo.TYPE_HDMI_ARC,
        AudioDeviceInfo.TYPE_HDMI_EARC -> "hdmi"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        else -> "other"
    }

    /** A device names itself: keep it printable and short before it reaches a page. */
    private fun clean(name: String?): String =
        (name ?: "").filter { it.isLetterOrDigit() || it in " -_.()'&+#/" }.trim().take(60)
}

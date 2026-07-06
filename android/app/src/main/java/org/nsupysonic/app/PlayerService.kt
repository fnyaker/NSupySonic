package org.nsupysonic.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.media.session.MediaButtonReceiver
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Foreground media service for the WebView player.
 *
 * The AUDIO stays in the WebView (all the webapp's cache/offline/recovery
 * logic keeps working); this service is the part Android actually requires to
 * keep that audio alive: a foreground service with a MediaSession, which
 * yields the media notification, lockscreen controls, Bluetooth buttons — and
 * a process the OS won't kill after a long pause.
 */
class PlayerService : Service() {

    data class State(
        val active: Boolean,
        val playing: Boolean,
        val title: String,
        val artist: String,
        val album: String,
        val cover: String,
        val position: Double, // seconds
        val duration: Double, // seconds
        val hasPrev: Boolean,
        val hasNext: Boolean,
    ) {
        companion object {
            fun fromJson(json: String): State? = try {
                val o = JSONObject(json)
                State(
                    active = o.optBoolean("active"),
                    playing = o.optBoolean("playing"),
                    title = o.optString("title"),
                    artist = o.optString("artist"),
                    album = o.optString("album"),
                    cover = o.optString("cover"),
                    position = o.optDouble("position", 0.0),
                    duration = o.optDouble("duration", 0.0),
                    hasPrev = o.optBoolean("hasPrev"),
                    hasNext = o.optBoolean("hasNext"),
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    companion object {
        const val CHANNEL_ID = "playback"
        const val NOTIFICATION_ID = 1
        const val ACTION_DISMISS = "org.nsupysonic.app.DISMISS"
    }

    inner class LocalBinder : Binder() {
        val service: PlayerService get() = this@PlayerService
    }

    /** Transport commands back to the WebView; set by MainActivity on bind. */
    var commandSink: ((String, Double?) -> Unit)? = null

    private val binder = LocalBinder()
    private lateinit var session: MediaSessionCompat
    private var state: State? = null
    private var foregrounded = false
    private var notifKey = "" // last (title|playing|art) actually rendered

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val artExecutor = Executors.newSingleThreadExecutor()
    private var artUrl: String? = null
    private var artBitmap: Bitmap? = null

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID, getString(R.string.channel_playback),
                NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
        )

        session = MediaSessionCompat(this, "NSupySonic")
        session.setCallback(object : MediaSessionCompat.Callback() {
            override fun onPlay() = send("play")
            override fun onPause() = send("pause")
            override fun onSkipToNext() = send("next")
            override fun onSkipToPrevious() = send("prev")
            override fun onSeekTo(pos: Long) = send("seek", pos / 1000.0)
            override fun onStop() = send("pause")
        })
        session.isActive = true

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nsupysonic:playback")
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "nsupysonic:stream")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        MediaButtonReceiver.handleIntent(session, intent)
        if (intent?.action == ACTION_DISMISS) {
            // Swiped away while paused: stop playback state, drop foreground.
            send("pause")
            stopForeground(STOP_FOREGROUND_REMOVE)
            foregrounded = false
            notifKey = ""
            return START_NOT_STICKY
        }
        // startForegroundService contract: show a notification right away.
        if (!foregrounded) {
            startForeground(NOTIFICATION_ID, buildNotification())
            foregrounded = true
        }
        // A restart without the WebView would be a zombie — don't be sticky.
        return START_NOT_STICKY
    }

    private fun send(cmd: String, value: Double? = null) {
        commandSink?.invoke(cmd, value)
    }

    /** Called from MainActivity (main thread) with each bridge state. */
    fun update(s: State) {
        state = s
        if (!s.active) return

        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, s.album)
                .putLong(
                    MediaMetadataCompat.METADATA_KEY_DURATION,
                    if (s.duration > 0) (s.duration * 1000).toLong() else -1
                )
                .apply { artBitmap?.let { putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) } }
                .build()
        )
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
                        PlaybackStateCompat.ACTION_SEEK_TO or
                        PlaybackStateCompat.ACTION_STOP or
                        (if (s.hasNext) PlaybackStateCompat.ACTION_SKIP_TO_NEXT else 0L) or
                        (if (s.hasPrev) PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS else 0L)
                )
                .setState(
                    if (s.playing) PlaybackStateCompat.STATE_PLAYING
                    else PlaybackStateCompat.STATE_PAUSED,
                    (s.position * 1000).toLong(),
                    if (s.playing) 1f else 0f
                )
                .build()
        )

        if (s.playing) acquireLocks() else releaseLocks()
        fetchArtIfNeeded(s.cover)

        // Re-render the notification only on real changes — the position bar
        // reads live from the session, not from the notification itself.
        val key = "${s.title}|${s.artist}|${s.playing}|${s.hasPrev}|${s.hasNext}|${artBitmap != null}"
        if (!foregrounded) {
            startForeground(NOTIFICATION_ID, buildNotification())
            foregrounded = true
            notifKey = key
        } else if (key != notifKey) {
            notifKey = key
            notifySafe()
        }
    }

    private fun notifySafe() {
        try {
            NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification())
        } catch (_: SecurityException) {
            // Notifications denied — playback still works, just uncontrollable
            // from the shade. The foreground service itself is unaffected.
        }
    }

    private fun buildNotification(): Notification {
        val s = state
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val dismissIntent = PendingIntent.getService(
            this, 1,
            Intent(this, PlayerService::class.java).setAction(ACTION_DISMISS),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_note)
            .setContentTitle(s?.title?.ifEmpty { getString(R.string.app_name) }
                ?: getString(R.string.app_name))
            .setContentText(s?.artist ?: "")
            .setLargeIcon(artBitmap)
            .setContentIntent(contentIntent)
            .setDeleteIntent(dismissIntent)
            .setOngoing(s?.playing == true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )

        builder.addAction(
            R.drawable.ic_prev, getString(R.string.action_prev),
            MediaButtonReceiver.buildMediaButtonPendingIntent(
                this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            )
        )
        if (s?.playing == true) {
            builder.addAction(
                R.drawable.ic_pause, getString(R.string.action_pause),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this, PlaybackStateCompat.ACTION_PAUSE
                )
            )
        } else {
            builder.addAction(
                R.drawable.ic_play, getString(R.string.action_play),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this, PlaybackStateCompat.ACTION_PLAY
                )
            )
        }
        builder.addAction(
            R.drawable.ic_next, getString(R.string.action_next),
            MediaButtonReceiver.buildMediaButtonPendingIntent(
                this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            )
        )
        return builder.build()
    }

    // -- album art ------------------------------------------------------------

    private fun fetchArtIfNeeded(url: String) {
        if (url.isEmpty() || url == artUrl) return
        artUrl = url
        artBitmap = null
        val verify = Prefs(this).verifySsl
        artExecutor.execute {
            val bmp = try {
                val conn = URL(url).openConnection() as HttpURLConnection
                Ssl.apply(conn, verify)
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.inputStream.use { BitmapFactory.decodeStream(it) }
            } catch (_: Exception) {
                null
            }
            if (bmp != null && url == artUrl) {
                Handler(Looper.getMainLooper()).post {
                    artBitmap = bmp
                    state?.let { update(it) } // re-render metadata + notification
                }
            }
        }
    }

    // -- locks ------------------------------------------------------------------
    // A partial wakelock + wifi lock while actually PLAYING keeps Doze from
    // freezing the WebView's decode/stream loop on aggressive OEM builds. Both
    // are released on pause — while paused, the foreground service alone is
    // what keeps the process (and the paused player) alive.

    private fun acquireLocks() {
        try {
            if (wakeLock?.isHeld != true) wakeLock?.acquire(4 * 60 * 60 * 1000L)
            if (wifiLock?.isHeld != true) wifiLock?.acquire()
        } catch (_: Exception) {
        }
    }

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Task swiped away: the WebView (and its audio) died with the activity.
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        releaseLocks()
        session.isActive = false
        session.release()
        artExecutor.shutdownNow()
        super.onDestroy()
    }
}

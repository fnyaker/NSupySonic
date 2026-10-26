package org.nsupysonic.app

/**
 * Downloads give the link back to what the person is listening to.
 *
 * The page knows when the track that is playing (or the next one, being
 * preloaded) needs the network: it calls [hold] with a lease, renewed while it
 * lasts, and [hold] with 0 when it is over. While a lease runs, a download does
 * not start, and one in progress steps aside: a file the server can resume is
 * closed and picked up at the same byte once the lease ends (nothing left in
 * flight to compete with the track), and one it cannot (a live transcode) is
 * read at a TRICKLE ([TRICKLE_BYTES] every [TRICKLE_MS]) — the receive window
 * then holds the server to that rate, while the connection never sits idle long
 * enough for a proxy's send timeout (nginx's is 60 s) to cut it.
 *
 * The same idea as Media3's PriorityTaskManager (a download proceeds only while
 * no playback task of higher priority is registered) and Chromium's
 * ResourceScheduler (delayable requests wait while important ones are in
 * flight), at the one place this app controls: its own reads.
 *
 * A lease expires by itself ([MAX_LEASE_MS] at most): a page that died while
 * holding it must not stop the downloads for good.
 */
class YieldGate(private val now: () -> Long = { android.os.SystemClock.elapsedRealtime() }) {
    private val lock = Object()
    @Volatile private var until = 0L

    /** Yield for the next [ms] milliseconds (capped); 0 or less ends it now. */
    fun hold(ms: Long) {
        synchronized(lock) {
            until = if (ms > 0) now() + minOf(ms, MAX_LEASE_MS) else 0L
            lock.notifyAll()
        }
    }

    fun yielding(): Boolean = now() < until

    /**
     * Waits while yielding, [stop] checked at least every half second. True
     * when clear, false when [stop] said so.
     */
    fun awaitClear(stop: () -> Boolean): Boolean {
        synchronized(lock) {
            while (yielding()) {
                if (stop()) return false
                lock.wait(minOf(500L, maxOf(1L, until - now())))
            }
        }
        return !stop()
    }

    /** The pause after a trickled read of [n] bytes; ends early when the lease does. */
    fun trickle(n: Int) {
        val ms = n.toLong() * TRICKLE_MS / TRICKLE_BYTES
        synchronized(lock) {
            val end = now() + ms
            while (yielding()) {
                val left = end - now()
                if (left <= 0) break
                lock.wait(left)
            }
        }
    }

    companion object {
        const val MAX_LEASE_MS = 60_000L
        const val TRICKLE_BYTES = 4096
        const val TRICKLE_MS = 1000L
    }
}

package org.nsupysonic.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.concurrent.thread

class YieldGateTest {
    private fun clock() = { System.nanoTime() / 1_000_000 }

    @Test
    fun aLeaseHoldsUntilItEnds() {
        val g = YieldGate(clock())
        g.hold(300)
        assertTrue(g.yielding())
        val t0 = System.nanoTime()
        assertTrue(g.awaitClear { false })
        val waited = (System.nanoTime() - t0) / 1_000_000
        assertTrue("waited $waited ms", waited in 250..1500)
        assertFalse(g.yielding())
    }

    @Test
    fun endingTheLeaseWakesTheDownloadAtOnce() {
        val g = YieldGate(clock())
        g.hold(30_000)
        thread { Thread.sleep(100); g.hold(0) }
        val t0 = System.nanoTime()
        assertTrue(g.awaitClear { false })
        val waited = (System.nanoTime() - t0) / 1_000_000
        assertTrue("waited $waited ms", waited < 1000)
    }

    @Test
    fun aCancelledDownloadStopsWaiting() {
        val g = YieldGate(clock())
        g.hold(30_000)
        var stop = false
        thread { Thread.sleep(100); stop = true }
        val t0 = System.nanoTime()
        assertFalse(g.awaitClear { stop })
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 2000)
    }

    @Test
    fun aDeadPageCannotHoldForEver() {
        var now = 0L
        val g = YieldGate { now }
        g.hold(10 * 60_000L)
        now = 59_000
        assertTrue(g.yielding())
        now = 60_001
        assertFalse(g.yielding())
    }

    @Test
    fun theTrickleIsFourKilobytesASecond() {
        val g = YieldGate(clock())
        g.hold(30_000)
        val t0 = System.nanoTime()
        g.trickle(2048) // half a trickle step: half a second
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertTrue("paused $ms ms", ms in 450..1200)
        assertEquals(4096, YieldGate.TRICKLE_BYTES)
        assertEquals(1000L, YieldGate.TRICKLE_MS)
    }

    @Test
    fun noLeaseNoPause() {
        val g = YieldGate(clock())
        val t0 = System.nanoTime()
        g.trickle(1 shl 20)
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 50)
    }

    @Test
    fun theTrickleEndsWithTheLease() {
        val g = YieldGate(clock())
        g.hold(30_000)
        thread { Thread.sleep(100); g.hold(0) }
        val t0 = System.nanoTime()
        g.trickle(1 shl 20) // would be 256 s
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000)
    }
}

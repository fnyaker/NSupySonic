package org.nsupysonic.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.io.InputStream

/**
 * RangeBody against what the WebView does with it. [webView] is a line-for-line
 * model of Chromium's loader for intercepted responses
 * (components/embedder_support/android/util/: InputStreamReader::Seek, then
 * AndroidStreamReaderURLLoader reading to the end of the stream): the stream's
 * `available()` is the resource's size, the range is checked against it, the
 * first `start` bytes are skipped, the rest is sent.
 */
class RangeBodyTest {
    private val size = 1_000_003
    private val bytes = ByteArray(size) { (it * 31 + it / 7).toByte() }
    private val file: File = File.createTempFile("rangebody", ".flac").apply {
        deleteOnExit()
        writeBytes(bytes)
    }

    /** What the page receives for [header]; null when the loader refuses it. */
    private fun webView(body: InputStream, header: String): ByteArray? {
        val total = body.available().toLong()
        val (a, b) = Regex("bytes=(\\d*)-(\\d*)").matchEntire(header)!!.destructured
        val first = if (a.isEmpty()) total - b.toLong() else a.toLong()
        val last = if (a.isEmpty() || b.isEmpty()) total - 1 else minOf(b.toLong(), total - 1)
        if (first < 0 || first > last) return null
        var toSkip = first
        while (toSkip > 0) {
            val s = body.skip(toSkip)
            if (s <= 0) return null
            toSkip -= s
        }
        return body.readBytes()
    }

    /** What the app answers for [header], as the page receives it. */
    private fun served(header: String): ByteArray? {
        val span = RangeBody.bounds(header, size.toLong()) ?: return null
        return webView(RangeBody.of(file, span[1]), header)
    }

    private fun expect(start: Int, end: Int) = bytes.copyOfRange(start, end + 1)

    @Test
    fun theFirstRequestOfAMediaElement() {
        assertArrayEquals(expect(0, size - 1), served("bytes=0-"))
    }

    @Test
    fun aReadFromTheMiddleGetsTheMiddle() {
        // What a seek asks for: it used to get the bytes from 2 x 400 000 on.
        assertArrayEquals(expect(400_000, size - 1), served("bytes=400000-"))
    }

    @Test
    fun aReadNearTheEndIsServed() {
        // Ogg and FLAC are read at their end for the duration: past the middle,
        // the old body was refused outright.
        assertArrayEquals(expect(size - 65_536, size - 1), served("bytes=${size - 65_536}-"))
    }

    @Test
    fun aClosedRangeStopsAtItsEnd() {
        assertArrayEquals(expect(500_000, 500_009), served("bytes=500000-500009"))
        assertArrayEquals(expect(0, 0), served("bytes=0-0"))
        assertArrayEquals(expect(size - 1, size - 1), served("bytes=${size - 1}-${size + 50}"))
    }

    @Test
    fun aSuffixRange() {
        assertEquals(size - 100L, RangeBody.bounds("bytes=-100", size.toLong())!![0])
        assertArrayEquals(expect(size - 100, size - 1), served("bytes=-100"))
    }

    @Test
    fun whatCannotBeServedIsSaidSo() {
        assertNull(RangeBody.bounds("bytes=${size}-", size.toLong()))
        assertNull(RangeBody.bounds("bytes=10-5", size.toLong()))
        assertNull(RangeBody.bounds("bytes=-0", size.toLong()))
        assertEquals(false, RangeBody.isRange("bytes=0-1,5-6"))
        assertEquals(false, RangeBody.isRange(null))
        assertEquals(true, RangeBody.isRange(" bytes=5- "))
    }
}

package org.nsupysonic.app

import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream

/**
 * The body a WebView is handed for a `Range` request on a stored download.
 *
 * The WebView applies the range ITSELF. When `shouldInterceptRequest` answers
 * a request that carries `Range: bytes=a-b`, Chromium's loader for intercepted
 * responses (components/embedder_support/android/util/
 * android_stream_reader_url_loader.cc, InputStreamReader::Seek) reads
 * `available()` as the size of the WHOLE resource, checks the range against
 * it, then `skip()`s `a` bytes of the stream it was given and sends what
 * follows. So the stream must start at byte 0 of the file.
 *
 * Handing it a stream already positioned at `a` (what this app did first) is
 * skipped a SECOND time: the page got the bytes from 2a on, and a range
 * starting past the middle of the file was refused outright, because
 * `available()` then said the file was shorter than `a`. The first request of
 * a media element is `bytes=0-`, which is why a download began to play and
 * then broke on the first read further on (Ogg and FLAC are read at their end
 * for the duration, a seek reads from the middle) — on the page's own
 * `<audio>`; the app's player reads the file directly and never met it.
 *
 * What this stream adds is the END of the range: it stops at byte `b`, which
 * the loader does not enforce (it reads to the end of the stream).
 */
class RangeBody(input: InputStream, limit: Long) : FilterInputStream(input) {
    private var left = limit

    override fun read(): Int {
        if (left <= 0) return -1
        val r = super.read()
        if (r >= 0) left--
        return r
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        if (left <= 0) return -1
        val n = super.read(b, off, minOf(len.toLong(), left).toInt())
        if (n > 0) left -= n
        return n
    }

    override fun skip(n: Long): Long {
        if (n <= 0 || left <= 0) return 0
        val s = super.skip(minOf(n, left))
        if (s > 0) left -= s
        return s
    }

    /** What is left to send, from the stream's current position: the loader's "size". */
    override fun available(): Int = minOf(left, super.available().toLong()).toInt()

    override fun markSupported(): Boolean = false

    companion object {
        private val RANGE = Regex("bytes=(\\d*)-(\\d*)")

        /** Whether [header] is a single byte range this class reads. */
        fun isRange(header: String?): Boolean = header != null && RANGE.matches(header.trim())

        /** `[start, end]` of a single-range `Range` header on a [size]-byte file; null if unsatisfiable or not one. */
        fun bounds(header: String?, size: Long): LongArray? {
            val m = header?.let { RANGE.matchEntire(it.trim()) } ?: return null
            val (a, b) = m.destructured
            val start: Long
            val end: Long
            if (a.isEmpty()) {
                val n = b.toLongOrNull() ?: return null
                if (n <= 0) return null
                start = maxOf(0L, size - n)
                end = size - 1
            } else {
                start = a.toLongOrNull() ?: return null
                end = if (b.isEmpty()) size - 1 else minOf(b.toLongOrNull() ?: return null, size - 1)
            }
            if (start >= size || end < start) return null
            return longArrayOf(start, end)
        }

        /** The body for `[start, end]` of [file]: from byte 0, ending at [end] (see the class). */
        fun of(file: File, end: Long): InputStream = RangeBody(FileInputStream(file), end + 1)
    }
}

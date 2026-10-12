"""Is this the same recording? Measured on the audio, not on the metadata.

The auto-match of an unavailable track compares a REFERENCE — the 30-second
preview Deezer still serves for the dead track, the only audio of it left
anywhere — with a candidate's audio, and replaces the track only when the two
are the same recording to within ``THRESHOLD``.

How: both sides are decoded by ffmpeg to mono 11 025 Hz, turned into a log
band-energy spectrogram (40 bands, 80 Hz - 5 kHz, 23 ms hop), and the
reference is slid along the candidate. Every lag is scored at once (the sum of
the bands' cross-correlations, by FFT), the best few are re-scored exactly
(Pearson correlation of the two spectrograms over their overlap) and the best
of those is the answer. The band range stops at 5 kHz on purpose: Deezer's
preview is an MP3 and a YouTube stream an Opus, and above that the codecs
themselves disagree — about the encoding, not about the music.

What the number means was MEASURED, not assumed (tests/test_audiomatch.py,
real ffmpeg, on an arranged record and a faded MP3 128 "preview" of it): the
same master as FLAC, Opus 128 (YouTube) or 6 dB down scores 0.9991-0.9999, a
remaster (treble +4 dB, compressed) 0.992 — the same performance, accepted —
while the same arrangement re-performed with timing drifting by only 10 ms
reads 0.981, the instrumental 0.74, a version 3 % faster 0.42, another song
0.37. The threshold sits between "same recording" and "another performance".
Two things made those numbers: aligning to the SAMPLE (``match``: on the hop
grid alone the same master read 0.984) and the floor below.

Needs numpy (which comes with the extractor stack and is in the image);
``available()`` says whether it is there, and nothing else in the app depends
on it.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import threading

logger = logging.getLogger(__name__)

SR = 11025
N_FFT = 1024
HOP = 256
BANDS = 40
F_LO, F_HI = 80.0, 5000.0
# Anything this far under the clip's own peak is "silence". 40, measured: at
# 60 an Opus encode of the very master read 0.985, because Opus fills a nearly
# empty band with noise 3 dB above the original's near-silence, and that
# disagreement is the codec's, not the music's (40 dB: 0.9991).
FLOOR_DB = 40.0
EDGE_TRIM_S = 1.5        # a preview fades in and out: not part of the music
MIN_OVERLAP_S = 12.0     # less than this in common decides nothing
MAX_SECONDS = 20 * 60    # a candidate longer than this is read this far
THRESHOLD = 0.99
PEAKS = 5                # lags re-scored exactly


class MatchError(Exception):
    """The audio could not be read (the message says why)."""


def available() -> bool:
    try:
        import numpy  # noqa: F401
    except ImportError:
        return False
    return shutil.which("ffmpeg") is not None


def _cmd(src: str, seconds: float | None) -> list:
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if src == "pipe:0":
        cmd.remove("-nostdin")
    cmd += ["-i", src, "-vn", "-ac", "1", "-ar", str(SR)]
    if seconds:
        cmd += ["-t", f"{seconds:.3f}"]
    return cmd + ["-f", "f32le", "pipe:1"]


def decode(src: str | None = None, chunks=None, seconds: float | None = MAX_SECONDS):
    """Mono float32 samples of a file (``src``) or of an iterable of bytes."""
    import numpy as np

    cmd = _cmd(src or "pipe:0", seconds)
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE if chunks is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise MatchError(f"ffmpeg could not start: {exc}") from exc

    feeder = None
    if chunks is not None:
        def feed():
            try:
                for chunk in chunks:
                    proc.stdin.write(chunk)
            except (BrokenPipeError, ValueError, OSError):
                pass  # ffmpeg has read what it needed (-t) and left
            finally:
                close = getattr(chunks, "close", None)
                if close:
                    try:
                        close()
                    except Exception:
                        pass
                try:
                    proc.stdin.close()
                except OSError:
                    pass

        feeder = threading.Thread(target=feed, name="audiomatch-feed", daemon=True)
        feeder.start()
    if chunks is None:
        out, err = proc.communicate()
    else:
        out, err = proc.stdout.read(), proc.stderr.read()
        proc.stdout.close()
        proc.stderr.close()
    proc.wait()
    if feeder:
        feeder.join(5)
    samples = np.frombuffer(out, dtype=np.float32)
    if samples.size < SR:  # under a second of audio is no audio
        tail = (err or b"").decode("utf-8", "replace").strip().splitlines()[-2:]
        raise MatchError("ffmpeg decoded no audio" + (": " + " / ".join(tail) if tail else ""))
    return samples


def _band_edges(n_fft: int):
    """``(lo, hi)`` bin index arrays: band b is bins lo[b]..hi[b]-1 (at least one)."""
    import numpy as np

    freqs = np.fft.rfftfreq(n_fft, 1.0 / SR)
    edges = np.geomspace(F_LO, F_HI, BANDS + 1)
    lo = np.searchsorted(freqs, edges[:-1])
    hi = np.searchsorted(freqs, edges[1:])
    hi = np.maximum(hi, lo + 1)  # a band narrower than a bin reads its nearest bin
    return lo, hi


_BANDS_CACHE = {}


def features(samples, trim_edges: bool = False):
    """``(frames, BANDS)`` log band energy, floored FLOOR_DB under its peak."""
    import numpy as np

    x = np.asarray(samples, dtype=np.float32)
    if trim_edges:
        cut = int(EDGE_TRIM_S * SR)
        if x.size > 4 * cut:
            x = x[cut:-cut]
    if x.size < N_FFT:
        raise MatchError("too short to compare")
    n = 1 + (x.size - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    win = np.hanning(N_FFT).astype(np.float32)
    spec = np.abs(np.fft.rfft(x[idx] * win, axis=1)) ** 2
    edges = _BANDS_CACHE.get(N_FFT)
    if edges is None:
        edges = _BANDS_CACHE[N_FFT] = _band_edges(N_FFT)
    lo, hi = edges
    # Band means from a running sum over the bins: no matrix product, so no
    # BLAS — whose threads would spread one background job over every core,
    # outside the renice that keeps it behind the music.
    cs = np.concatenate([np.zeros((spec.shape[0], 1)), np.cumsum(spec, axis=1)], axis=1)
    db = 10.0 * np.log10((cs[:, hi] - cs[:, lo]) / (hi - lo) + 1e-12)
    return np.maximum(db, db.max() - FLOOR_DB).astype(np.float32)


def _pearson(a, b) -> float:
    import numpy as np

    a = a - a.mean()
    b = b - b.mean()
    den = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / den) if den > 0 else 0.0


def compare(ref, cand) -> tuple[float, float, float]:
    """``(score, offset_s, overlap_s)`` of the reference's best position.

    ``offset_s`` is where the reference starts in the candidate (negative when
    the candidate starts inside it). ``score`` is 0 when no position leaves
    MIN_OVERLAP_S in common.
    """
    import numpy as np

    min_ov = int(MIN_OVERLAP_S * SR / HOP)
    nr, nc = ref.shape[0], cand.shape[0]
    if min(nr, nc) < min_ov:
        return 0.0, 0.0, 0.0
    r = ref - ref.mean(axis=0)
    c = cand - cand.mean(axis=0)
    size = 1
    while size < nr + nc:
        size *= 2
    # sum over bands of xcorr(c, r): lag L puts ref frame 0 on cand frame L.
    acc = np.zeros(size, dtype=np.float64)
    fr = np.fft.rfft(r, size, axis=0)
    fc = np.fft.rfft(c, size, axis=0)
    acc = np.fft.irfft((fc * np.conj(fr)).sum(axis=1), size)
    lags = np.concatenate([np.arange(0, nc), np.arange(-(nr - 1), 0)])
    vals = np.concatenate([acc[:nc], acc[size - (nr - 1):]])
    overlap = np.minimum(nc, lags + nr) - np.maximum(0, lags)
    ok = overlap >= min_ov
    if not ok.any():
        return 0.0, 0.0, 0.0
    # Normalise by the overlap so a long overlap is not favoured for its length.
    score_rough = np.where(ok, vals / np.maximum(overlap, 1), -np.inf)
    best = (0.0, 0, 0)
    tried = set()
    for k in np.argsort(score_rough)[::-1][:PEAKS]:
        for lag in range(int(lags[k]) - 2, int(lags[k]) + 3):
            if lag in tried:
                continue
            tried.add(lag)
            a0, a1 = max(0, -lag), min(nr, nc - lag)
            if a1 - a0 < min_ov:
                continue
            s = _pearson(ref[a0:a1], cand[a0 + lag:a1 + lag])
            if s > best[0]:
                best = (s, lag, a1 - a0)
    s, lag, ov = best
    return s, lag * HOP / SR, ov * HOP / SR


def match(ref_samples, cand_samples) -> tuple[float, float, float]:
    """``compare`` on the hop grid, then aligned to the SAMPLE around its lag.

    Two encodings of one master land on the hop grid up to half a hop (11.6 ms)
    apart, and on a kick's attack that alone is a percent and a half of
    correlation — measured, the same master read 0.984 on the grid and 0.9999
    aligned. The candidate is re-read shifted within one hop either side,
    every 32 samples and then every 4 around the best of those.
    """
    cut = int(EDGE_TRIM_S * SR) if ref_samples.size > 4 * int(EDGE_TRIM_S * SR) else 0
    ref_x = ref_samples[cut:ref_samples.size - cut] if cut else ref_samples
    ref = features(ref_x)
    s, off, ov = compare(ref, features(cand_samples))
    if s <= 0:
        return s, off, ov
    min_len = int(MIN_OVERLAP_S * SR)
    cache = {}

    def at(pos):
        if pos in cache:
            return cache[pos]
        a0 = max(0, -pos)  # samples of the reference before the candidate starts
        seg = cand_samples[max(0, pos):pos + ref_x.size]
        v = -1.0
        if seg.size >= min_len:
            r = ref if a0 == 0 and seg.size == ref_x.size else features(ref_x[a0:a0 + seg.size])
            c = features(seg)
            n = min(len(r), len(c))
            v = _pearson(r[:n], c[:n])
        cache[pos] = v
        return v

    start = int(round(off * SR))
    coarse = max(range(start - HOP, start + HOP + 1, 32), key=at)
    pos = max(range(coarse - 32, coarse + 33, 4), key=at)
    best = max(at(pos), s)
    return best, (pos if at(pos) >= s else start) / SR, ov


def score_files(ref_path: str, cand_path: str | None = None, cand_chunks=None):
    """``(score, offset_s, overlap_s)`` of a reference file against a candidate."""
    ref = decode(ref_path, seconds=120)
    cand = decode(cand_path, chunks=cand_chunks)
    return match(ref, cand)

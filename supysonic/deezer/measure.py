# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The spectral measures, written out (numpy), as the twin of ``webapp/measure`` (Rust).

``analysis._spectral`` asks ffmpeg's ``aspectralstats`` for these numbers. A
browser cannot run that filter, so the client needs the same numbers computed by
code we own, and "the same" has to be demonstrated rather than hoped for. This
module is the reference for that code: the definitions below were recovered from
ffmpeg's output frame by frame (see docs/agents/analysis-genre.md (Analysis on the client PC)) and agree with
it to rounding (entropy was recovered from 99 real tracks: see below).

Definitions (a frame is 2048 samples of ONE channel, Hann window, hop 1024, at the
source's own rate; the magnitude spectrum is |rfft|/2048 over the first 1024 bins,
Nyquist excluded; f[k] = k·rate/2048):

- centroid  Σ f·m / Σ m                      spread  sqrt(Σ (f-centroid)²·m / Σ m)
- flatness  exp(mean ln m) / mean m          rolloff f[first k with cumsum(m) ≥ 0.85·Σ m]
- flux      ‖m − m_previous_frame‖₂ (the first frame against zeros)
- entropy   −Σ m·log2(m) / log2(1024) over the RAW magnitudes (not normalised to a
            probability: it exceeds 1 on loud broadband frames)

Known difference: on band-limited LOSSY material (mp3/ogg cut at 16 kHz) the quietest
bins are float32 rounding noise inside ffmpeg, so its flatness reads higher than any
other FFT's (3-6x on such files); on the lossless library it was measured at a median
ratio of 0.99, worst 0.80, over 99 real tracks (none of this moves a verdict: the rules'
fuzzy bands are wider).

Frames of all channels are pooled, then medians / the 90th percentile are taken,
exactly as ``analysis._parse_spectral`` does.
"""

from __future__ import annotations

import numpy as np

WIN = 2048
HOP = 1024
ROLLOFF = 0.85


def _hann():
    return np.hanning(WIN)


def frame_stats(x, rate):
    """Per-frame descriptors of one channel: dict of arrays, ffmpeg's framing
    (the first frame is half silence, as ffmpeg's is). The transform runs in
    FLOAT32 like ffmpeg's: its rounding noise is what the geometric mean of the
    quietest bins (flatness) is made of on band-limited material, so a double
    precision transform reads systematically flatter-looking-less than ffmpeg."""
    x = np.asarray(x, dtype=np.float32)
    n = len(x)
    if n < WIN // 2:
        return None
    padded = np.concatenate([np.zeros(HOP, np.float32), x])
    count = max(1, (len(padded) - WIN) // HOP + 1)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(count)[:, None]
    frames = padded[idx] * _hann().astype(np.float32)
    mag32 = np.abs(np.fft.rfft(frames, axis=1))[:, : WIN // 2] / np.float32(WIN)
    mag = mag32.astype(np.float64)
    f = np.arange(WIN // 2) * (rate / WIN)
    s = mag.sum(axis=1)
    ok = s > 0
    mag, s = mag[ok], s[ok]
    if len(mag) == 0:
        return None
    centroid = (mag * f).sum(axis=1) / s
    spread = np.sqrt((mag * (f[None, :] - centroid[:, None]) ** 2).sum(axis=1) / s)
    flat = np.exp(np.mean(np.log(mag + 1e-30), axis=1)) / mag.mean(axis=1)
    cum = np.cumsum(mag, axis=1)
    k = (cum < ROLLOFF * s[:, None]).sum(axis=1)
    rolloff = f[np.minimum(k, len(f) - 1)]
    prev = np.vstack([np.zeros((1, mag.shape[1])), mag[:-1]])
    flux = np.sqrt(((mag - prev) ** 2).sum(axis=1))
    # ffmpeg's "entropy" is NOT a probability entropy: it is -sum(m*log2(m)) over the
    # RAW magnitudes (m = |X|/2048, not divided by their sum), over log2(1024). It
    # exceeds 1 on loud broadband frames. Matches to 2e-5 frame by frame.
    ent = -(mag * np.log2(np.where(mag > 0, mag, 1.0))).sum(axis=1) / np.log2(mag.shape[1])
    return {"centroid": centroid, "spread": spread, "flatness": flat, "rolloff": rolloff,
            "flux": flux, "entropy": ent}


def _pct(xs, q):
    """``analysis._pct``: the nearest-rank value, not an interpolation."""
    if len(xs) == 0:
        return 0.0
    s = np.sort(np.asarray(xs))
    return float(s[max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))])


def summarize(series):
    """The pooled series (name -> list of per-frame values) as ``_parse_spectral``'s dict."""
    def med(v):
        return float(np.median(v)) if len(v) else 0.0

    flux = np.asarray(series["flux"])
    mflux = med(flux)
    return {
        "centroid": med(series["centroid"]),
        "spread": med(series["spread"]),
        "flatness": med(series["flatness"]),
        "flatness_hi": _pct(series["flatness"], 0.9),
        "entropy": med(series["entropy"]),
        "rolloff": med(series["rolloff"]),
        "flux_peak": (_pct(flux, 0.9) / mflux) if mflux > 1e-9 else 1.0,
        "frames": int(len(series["centroid"])),
    }


def measure(channels, rate):
    """``channels``: a list of 1-D float arrays at ``rate``. Returns the summary."""
    pooled = {k: [] for k in ("centroid", "spread", "flatness", "rolloff", "flux", "entropy")}
    for ch in channels:
        st = frame_stats(ch, rate)
        if st is None:
            continue
        for k in pooled:
            pooled[k].extend(st[k].tolist())
    if not pooled["centroid"]:
        return None
    return summarize(pooled)

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The spectral measures, written out (numpy), as the twin of ``webapp/measure`` (Rust).

``analysis._spectral`` asks ffmpeg's ``aspectralstats`` for these numbers. A
browser cannot run that filter, so the client needs the same numbers computed by
code we own, and "the same" has to be demonstrated rather than hoped for. This
module is the reference for that code: the definitions below were recovered from
ffmpeg's output frame by frame (see docs/claude/client-analysis.md) and agree with
it to rounding for everything except ENTROPY, where ffmpeg's number is a quantity
we could not reproduce (correlation 0.8 with Shannon entropy at best); that one
is a calibrated stand-in (``ENTROPY_FIT``) and is the least trustworthy.

Definitions (a frame is 2048 samples of ONE channel, Hann window, hop 1024, at the
source's own rate; the magnitude spectrum is |rfft|/2048 over the first 1024 bins,
Nyquist excluded; f[k] = k·rate/2048):

- centroid  Σ f·m / Σ m                      spread  sqrt(Σ (f-centroid)²·m / Σ m)
- flatness  exp(mean ln m) / mean m          rolloff f[first k with cumsum(m) ≥ 0.85·Σ m]
- flux      ‖m − m_previous_frame‖₂ (the first frame against zeros)

Frames of all channels are pooled, then medians / the 90th percentile are taken,
exactly as ``analysis._parse_spectral`` does.
"""

from __future__ import annotations

import numpy as np

WIN = 2048
HOP = 1024
ROLLOFF = 0.85

#: entropy_ffmpeg ≈ a·H + b where H is the Shannon entropy of the normalised
#: magnitude, divided by log2(bins). Fitted per-track-median on real music; see the doc.
ENTROPY_FIT = (1.0, 0.0)


def _hann():
    return np.hanning(WIN)


def frame_stats(x, rate):
    """Per-frame descriptors of one channel: dict of arrays, ffmpeg's framing
    (the first frame is half silence, as ffmpeg's is)."""
    x = np.asarray(x, dtype=np.float32)
    n = len(x)
    if n < WIN // 2:
        return None
    padded = np.concatenate([np.zeros(HOP, np.float32), x])
    count = max(1, (len(padded) - WIN) // HOP + 1)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(count)[:, None]
    frames = padded[idx] * _hann().astype(np.float32)
    mag = (np.abs(np.fft.rfft(frames, axis=1))[:, : WIN // 2] / WIN).astype(np.float64)
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
    p = mag / s[:, None]
    h = -(p * np.log2(np.where(p > 0, p, 1.0))).sum(axis=1) / np.log2(mag.shape[1])
    a, b = ENTROPY_FIT
    return {"centroid": centroid, "spread": spread, "flatness": flat, "rolloff": rolloff,
            "flux": flux, "entropy": a * h + b}


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

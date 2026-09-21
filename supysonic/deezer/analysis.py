# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What a whole track sounds like — measured once, on the server.

WHY THIS EXISTS. The web player's animation engine needs a tempo and a style.
Both are properties of the WHOLE piece, and a detector that has to work them out
live spends the first fifteen seconds of every track converging — through
exactly the part (the intro) that is least representative of it. Worse, it pays
that cost again on every device, on every play. So the same reasoning that puts
the loudness on the server puts these here: the audio does not change, so the
answer does not either. Measure once, keep it, serve it.

What stays on the client is what genuinely is per-moment: the beat PHASE (which
has to be locked to the audio clock of the thing actually playing), the kick, the
onsets, the transients. The client keeps its live tracker for those, and takes
the global answers from here — a served BPM means its tempo search starts locked
instead of hunting.

HOW IT MEASURES, and why it needs nothing new installed:

- The TEMPO is Deezer's own, when Deezer has one. Its public API publishes a
  ``bpm`` per track: exact, free, and already right for most of the library.
  Anything else (a local upload, a track Deezer has no figure for) is measured
  from a low-passed envelope — one ffmpeg pass, then an autocorrelation over a
  handful of windows in plain Python.
- The DESCRIPTORS come from ffmpeg's own ``aspectralstats`` and ``ebur128``
  filters: spectral centroid, spread, flatness, entropy, rolloff and flux per
  frame, plus integrated loudness and loudness range for the whole file. That is
  a second pass and no Python dependency at all — no numpy, no model, nothing to
  install on a self-hosted server that did not already need ffmpeg to transcode.

EVERY MEASURE IT CLASSIFIES ON IS PHYSICAL OR SCALE-FREE — beats per minute,
hertz, decibels, ratios in 0..1. That is deliberate: the client's live classifier
works on its own normalized feature scales, and the two must not be expected to
agree on a threshold. They are independent readings, and where this one exists it
is the authority; the client's is what covers a track nobody has measured yet.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

from concurrent.futures import ThreadPoolExecutor

from ..db import GenreTag, Track, TrackAnalysis, now

logger = logging.getLogger(__name__)

# Bump to re-measure everything: a stored row whose version is older is stale.
ANALYSIS_VERSION = 1

# Never analyse more than this much of a file. Ten minutes is far more than any
# verdict needs, and it is what stops a two-hour DJ set costing two hours of
# decoding.
MAX_SECONDS = 600
# One ffmpeg run must not be able to spin forever on a broken file.
FFMPEG_TIMEOUT = 300
# How sure a trained head has to be before it overrides the rules. Below this
# the track is simply unlike anything it was taught, and a confident-sounding
# wrong label is worse than the honest general answer.
#
# The number this is compared against is the head's POST-temperature
# confidence, not its raw softmax: the studio fits a temperature on held-out
# folds and the server divides the logits by it before the softmax (see
# deezer/genre.py). That is deliberate and it is what makes this threshold
# mean the same thing for a head trained today and one trained after another
# ten tags — an uncalibrated softmax on a few hundred examples drifts upward as
# the model fits harder, and a fixed threshold would quietly accept more of its
# mistakes over time.
MODEL_MIN_CONFIDENCE = 0.45
# ...and it must also be clear of the runner-up by this much. A head that puts
# 0.6 on "uptempo" and 0.55 on "frenchcore" has not decided anything; one that
# puts 0.5 and 0.02 has. Requiring both is what stops a confident-sounding wrong
# label from the top-probability threshold alone, and it is cheap — the
# probabilities are already computed.
MODEL_MIN_MARGIN = 0.12
# Analysis is background work with no deadline: one at a time keeps it from
# competing with streaming for the box.
_slot = threading.BoundedSemaphore(1)
_inflight: set[str] = set()
_inflight_lock = threading.Lock()


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


# --- fuzzy helpers ---------------------------------------------------------
def _in_range(x, lo, hi, w=None):
    if w is None:
        w = (hi - lo) * 0.45
    if lo <= x <= hi:
        return 1.0
    if x < lo:
        return max(0.0, 1 - (lo - x) / w)
    return max(0.0, 1 - (x - hi) / w)


def _above(x, t, w):
    return max(0.0, min(1.0, (x - t) / w))


def _below(x, t, w):
    return max(0.0, min(1.0, (t - x) / w))


def _median(xs):
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def _pct(xs, q):
    if not xs:
        return 0.0
    s = sorted(xs)
    i = max(0, min(len(s) - 1, int(round(q * (len(s) - 1)))))
    return s[i]


# --- pass 1: spectral descriptors + loudness -------------------------------
_STAT = re.compile(
    r"lavfi\.aspectralstats\.(?:\d+\.)?([a-z_]+)=(-?[\d.]+(?:[eE][-+]?\d+)?|nan|inf|-inf)"
)
_LUFS = re.compile(r"^\s*I:\s*(-?[\d.]+)\s*LUFS", re.M)
_LRA = re.compile(r"^\s*LRA:\s*(-?[\d.]+)\s*LU", re.M)

# The descriptors worth keeping. aspectralstats prints more; collecting only
# these keeps a ten-minute track to a few tens of thousands of floats.
_WANTED = ("centroid", "spread", "flatness", "entropy", "rolloff", "flux")


def _spectral(path):
    """Whole-file spectral descriptors and loudness, in one decode."""
    cmd = [
        "ffmpeg", "-nostats", "-v", "info", "-i", path,
        "-map", "0:a:0", "-t", str(MAX_SECONDS),
        # Mono at 22 kHz: the descriptors below are about the shape of the
        # spectrum, not its top octave, and this quarters the filtering cost.
        "-ac", "1", "-ar", "22050",
        # ebur128 passes the audio through, so both measurements ride one decode.
        # Its summary goes to stderr; the per-frame stats go to stdout.
        "-af", "ebur128=peak=none,aspectralstats=win_size=2048,"
               "ametadata=mode=print:file=-",
        "-f", "null", "-",
    ]
    proc = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=FFMPEG_TIMEOUT, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exited {proc.returncode}")
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")

    series = {k: [] for k in _WANTED}
    for name, raw in _STAT.findall(out):
        if name not in series:
            continue
        try:
            v = float(raw)
        except ValueError:
            continue
        if math.isfinite(v):
            series[name].append(v)
    if not series["centroid"]:
        raise ValueError("no spectral frames")

    lufs = _LUFS.search(err)
    lra = _LRA.search(err)
    flux = series["flux"]
    med_flux = _median(flux)
    return {
        "centroid": _median(series["centroid"]),
        "spread": _median(series["spread"]),
        "flatness": _median(series["flatness"]),
        "flatness_hi": _pct(series["flatness"], 0.9),
        "entropy": _median(series["entropy"]),
        "rolloff": _median(series["rolloff"]),
        # Scale-free: how much the busiest frames stand out from the typical
        # one. The absolute flux depends on the master's level; this does not.
        "flux_peak": (_pct(flux, 0.9) / med_flux) if med_flux > 1e-9 else 1.0,
        "lufs": float(lufs.group(1)) if lufs else None,
        # Loudness range, in LU. This is the single best "how squashed is this"
        # axis there is: a limitered hardcore master sits near 3, a live string
        # quartet near 15, and no normalization of ours is involved.
        "lra": float(lra.group(1)) if lra else None,
        "frames": len(series["centroid"]),
    }


# --- pass 2: tempo from a low-band envelope --------------------------------
ENV_HZ = 100  # the onset grid, in samples per second
_SR = 1000  # the decoded envelope's sample rate


def _low_envelope(path):
    """A 100 Hz onset function built from the low band, at C speed.

    ffmpeg low-passes and decimates to 1 kHz unsigned 8-bit; the per-frame peak
    is then a ``max``/``min`` over a ten-byte slice, which is a C loop. No
    Python-level sample processing happens at all.
    """
    cmd = [
        "ffmpeg", "-v", "0", "-i", path,
        "-map", "0:a:0", "-t", str(MAX_SECONDS),
        "-af", "lowpass=f=170",
        "-ac", "1", "-ar", str(_SR), "-f", "u8", "pipe:1",
    ]
    raw = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=FFMPEG_TIMEOUT, check=True,
    ).stdout
    if not raw:
        raise ValueError("no audio decoded")
    per = _SR // ENV_HZ
    env = []
    for i in range(0, len(raw) - per + 1, per):
        chunk = raw[i : i + per]
        env.append(max(max(chunk) - 128, 128 - min(chunk)))
    # Positive difference: an onset is energy ARRIVING, not energy present.
    odf = [0.0] * len(env)
    for i in range(1, len(env)):
        d = env[i] - env[i - 1]
        if d > 0:
            odf[i] = float(d)
    return odf


MIN_BPM, MAX_BPM = 55, 300
HARMONICS = 3


def _smooth(xs, sigma=2.0):
    r = max(1, int(math.ceil(sigma * 2.5)))
    k = [math.exp(-(i * i) / (2 * sigma * sigma)) for i in range(-r, r + 1)]
    tot = sum(k)
    k = [v / tot for v in k]
    n = len(xs)
    out = [0.0] * n
    for i in range(n):
        acc = 0.0
        for j in range(-r, r + 1):
            x = i + j
            if 0 <= x < n:
                acc += xs[x] * k[j + r]
        out[i] = acc
    return out


def _window_tempo(win):
    """Best lag for one window of the onset function, and how clear it was."""
    n = len(win)
    mean = sum(win) / n
    energy = sum((v - mean) ** 2 for v in win)
    if energy < 1e-9:
        return None
    lag_min = int(60 * ENV_HZ / MAX_BPM)
    lag_max = int(60 * ENV_HZ / MIN_BPM)
    acf_max = min(n - 200, lag_max * HARMONICS)
    if acf_max <= lag_min:
        return None
    acf = [0.0] * (acf_max + 2)
    for lag in range(lag_min, acf_max + 1):
        s = 0.0
        for i in range(lag, n):
            s += (win[i] - mean) * (win[i - lag] - mean)
        acf[lag] = s / energy

    weight = 1.0 + sum(1.0 / h for h in range(2, HARMONICS + 1))
    best = best_lag = 0.0
    second = 0.0
    for lag in range(lag_min, min(lag_max, acf_max) + 1):
        s = acf[lag]
        for h in range(2, HARMONICS + 1):
            x = lag * h
            if x > acf_max:
                break
            s += acf[x] / h
        s /= weight
        s *= _prior(60 * ENV_HZ / lag)
        if s > best:
            second, best, best_lag = best, s, lag
        elif s > second:
            second = s
    if not best_lag:
        return None
    margin = max(0.0, (best - second) / (best + 1e-9)) if second > 0 else 1.0
    return best_lag, max(0.0, min(1.0, best * 2.2)) * (0.35 + 0.65 * margin)


PRIOR_LO, PRIOR_HI, PRIOR_SIGMA = 90.0, 200.0, 0.55


def _prior(bpm):
    """A plateau over the tempi a beat grid is normally written in.

    Deliberately not a bell on 120: the roll-off keeps a 300 BPM reading from
    being invented out of noise, while a bell would spend its slope halving
    every fast track — which is most of what this server is pointed at.
    """
    if bpm < PRIOR_LO:
        d = math.log(bpm / PRIOR_LO)
    elif bpm > PRIOR_HI:
        d = math.log(bpm / PRIOR_HI)
    else:
        return 1.0
    return math.exp(-(d * d) / (2 * PRIOR_SIGMA * PRIOR_SIGMA))


def _fold_half_ratio(odf, period):
    """How strong the half-period position is, relative to the strongest one."""
    p = max(2, int(round(period)))
    fold = [0.0] * p
    total = 0.0
    for i, v in enumerate(odf):
        fold[i % p] += v
        total += v
    if total < 1e-6:
        return -1.0
    w = max(1, int(round(0.03 * ENV_HZ)))
    around = lambda c: sum(fold[(c + j) % p] for j in range(-w, w + 1))  # noqa: E731
    p0 = max(range(p), key=lambda k: fold[k])
    a = around(p0)
    return (around(p0 + p // 2) / a) if a > 1e-9 else 0.0


def _grid_share(odf, period):
    """How concentrated the bass onsets are on the beat grid, 0..1."""
    p = max(2, int(round(period)))
    fold = [0.0] * p
    total = 0.0
    for i, v in enumerate(odf):
        fold[i % p] += v
        total += v
    if total < 1e-6:
        return 0.0
    w = max(2, int(round(p * 0.05)))
    best = max(
        sum(fold[(k + j) % p] for j in range(-w, w + 1)) for k in range(p)
    )
    baseline = min(1.0, (2 * w + 1) / p)
    return max(0.0, min(1.0, ((best / total) - baseline) / max(1e-6, 1 - baseline) * 1.25))


def _measure_tempo(path):
    """(bpm, confidence, grid_share) measured from the file itself."""
    odf = _smooth(_low_envelope(path))
    n = len(odf)
    win = 8 * ENV_HZ
    if n < win:
        return None, 0.0, 0.0
    # Vote across windows spread over the track rather than one long
    # autocorrelation: it is far cheaper, and a track that changes tempo or has
    # a long ambient intro gets outvoted rather than averaged into nonsense.
    starts = []
    count = max(1, min(8, n // win))
    for i in range(count):
        starts.append(int(i * (n - win) / max(1, count - 1)) if count > 1 else 0)
    votes = {}
    conf_sum = 0.0
    for st in starts:
        r = _window_tempo(odf[st : st + win])
        if not r:
            continue
        lag, conf = r
        # Bucket by BPM to the nearest whole number, so windows that agree
        # within the grid's own resolution count as the same vote.
        key = round(60 * ENV_HZ / lag)
        v = votes.setdefault(key, [0.0, 0])
        v[0] += conf
        v[1] += 1
        conf_sum += conf
    if not votes:
        return None, 0.0, 0.0
    bpm = max(votes.items(), key=lambda kv: kv[1][0])[0]
    period = 60 * ENV_HZ / bpm

    # The octave, arbitrated by the bass: does it fill the gap between beats
    # (then the period is half of this) or skip every other one (then double)?
    dbl = _fold_half_ratio(odf, period * 2)
    if 0 <= dbl < 0.35 and 60 / (period * 2 / ENV_HZ) >= MIN_BPM:
        period *= 2
    else:
        half = _fold_half_ratio(odf, period)
        if half >= 0.72 and 60 / (period / 2 / ENV_HZ) <= MAX_BPM:
            period /= 2
    bpm = 60 * ENV_HZ / period
    agree = votes[max(votes, key=lambda k: votes[k][0])][1] / max(1, len(starts))
    conf = min(1.0, (conf_sum / max(1, len(starts))) * agree * 1.4)
    return round(bpm, 2), round(conf, 3), round(_grid_share(odf, period), 3)


# --- the classifier ---------------------------------------------------------
# Same ids as the client's, so a verdict from either side prints the same label.
# The weights, however, are written against PHYSICAL measures — hertz, decibels,
# beats per minute — because that is what this side actually has.
FAMILIES = [
    ("ambient", "Ambient", "sustain", lambda f: (
        _below(f["pulse"], 0.3, 0.3) * _below(f["flux_peak"], 2.2, 1.2)
        * _below(f["centroid"], 2600, 1400))),
    ("strings", "Cordes / classique", "sustain", lambda f: (
        _below(f["flatness"], 0.26, 0.2) * _above(f["lra"], 8.5, 5)
        * _below(f["pulse"], 0.4, 0.3) * _in_range(f["centroid"], 500, 2600, 1400))),
    ("jazz", "Jazz / acoustique", "voice", lambda f: (
        _in_range(f["bpm"], 80, 165, 45) * _below(f["flatness"], 0.42, 0.25)
        * _above(f["lra"], 6.5, 4) * _below(f["pulse"], 0.55, 0.3))),
    ("vocalPop", "Pop / chanson", "voice", lambda f: (
        _in_range(f["bpm"], 84, 138, 32) * _in_range(f["lra"], 4, 9.5, 4)
        * _below(f["flatness"], 0.46, 0.25) * _in_range(f["centroid"], 900, 3200, 1400))),
    ("rnb", "R&B / soul", "voice", lambda f: (
        _in_range(f["bpm"], 60, 100, 25) * _below(f["flatness"], 0.42, 0.25)
        * _in_range(f["lra"], 4, 10, 4))),
    ("hiphop", "Hip-hop", "groove", lambda f: (
        _in_range(f["bpm"], 70, 105, 22) * _above(f["pulse"], 0.35, 0.3)
        * _below(f["centroid"], 2600, 1200))),
    ("house", "House", "groove", lambda f: (
        _in_range(f["bpm"], 116, 128, 12) * _above(f["pulse"], 0.45, 0.3)
        * _below(f["flatness"], 0.42, 0.22))),
    ("techno", "Techno", "groove", lambda f: (
        _in_range(f["bpm"], 125, 150, 16) * _above(f["pulse"], 0.5, 0.3)
        * _in_range(f["flatness"], 0.2, 0.5, 0.2))),
    ("trance", "Trance", "groove", lambda f: (
        _in_range(f["bpm"], 132, 145, 12) * _above(f["pulse"], 0.45, 0.3)
        * _above(f["rolloff"], 6500, 2500) * _below(f["flatness"], 0.45, 0.22))),
    ("dance", "Dance / EDM", "groove", lambda f: (
        _in_range(f["bpm"], 118, 136, 10) * _above(f["pulse"], 0.5, 0.3)
        * _above(f["rolloff"], 6000, 3000) * _below(f["flatness"], 0.5, 0.25))),
    ("dnb", "Drum & bass", "groove", lambda f: (
        _in_range(f["bpm"], 160, 182, 10) * _in_range(f["pulse"], 0.25, 0.7, 0.25)
        * _below(f["flatness"], 0.5, 0.2) * _above(f["flux_peak"], 1.5, 0.8))),
    ("dubstep", "Dubstep", "groove", lambda f: (
        _in_range(f["bpm"], 136, 148, 8) * _below(f["pulse"], 0.55, 0.3)
        * _below(f["centroid"], 2200, 1400) * _below(f["lra"], 8, 3))),
    ("disco", "Disco / funk", "groove", lambda f: (
        _in_range(f["bpm"], 106, 124, 10) * _above(f["pulse"], 0.45, 0.3)
        * _below(f["flatness"], 0.42, 0.22) * _in_range(f["lra"], 5, 12, 4))),
    ("psytrance", "Psytrance", "groove", lambda f: (
        _in_range(f["bpm"], 138, 152, 10) * _above(f["pulse"], 0.55, 0.3)
        * _in_range(f["flatness"], 0.25, 0.55, 0.2) * _above(f["rolloff"], 6500, 3000))),
    ("hardstyle", "Hardstyle", "hard", lambda f: (
        _in_range(f["bpm"], 145, 162, 12) * _above(f["pulse"], 0.45, 0.3)
        * _below(f["lra"], 6.5, 3.5))),
    ("hardtekk", "Hardtekk", "hard", lambda f: (
        _in_range(f["bpm"], 138, 165, 14) * _above(f["pulse"], 0.45, 0.3)
        * _above(f["flatness"], 0.3, 0.22) * _below(f["lra"], 7.5, 4))),
    ("zaag", "Zaag", "hard", lambda f: (
        _in_range(f["bpm"], 150, 210, 28) * _in_range(f["flatness"], 0.32, 0.6, 0.2)
        * _above(f["centroid"], 2200, 1500) * _below(f["lra"], 7, 3.5))),
    ("frenchcore", "Frenchcore", "hard", lambda f: (
        _in_range(f["bpm"], 185, 230, 25) * _above(f["pulse"], 0.4, 0.3)
        * _above(f["flatness"], 0.38, 0.25) * _below(f["lra"], 6, 3))),
    ("uptempo", "Uptempo", "hard", lambda f: (
        _in_range(f["bpm"], 220, 300, 35) * _above(f["flatness"], 0.45, 0.25)
        * _below(f["lra"], 5.5, 3))),
    ("krach", "Deutscher Krach", "hard", lambda f: (
        _in_range(f["bpm"], 190, 300, 45) * _above(f["flatness"], 0.55, 0.2)
        * _below(f["lra"], 4, 2.5) * _above(f["entropy"], 0.75, 0.2))),
    ("pieep", "Pieep", "hard", lambda f: (
        _in_range(f["bpm"], 170, 260, 40) * _above(f["centroid"], 3600, 1600)
        * _above(f["rolloff"], 8000, 2500) * _below(f["flatness"], 0.55, 0.25))),
    ("hardcore", "Hardcore", "hard", lambda f: (
        _in_range(f["bpm"], 148, 195, 18) * _above(f["pulse"], 0.45, 0.3)
        * _in_range(f["flatness"], 0.4, 0.75, 0.2) * _below(f["lra"], 6.5, 3))),
    ("tribecore", "Tribe", "hard", lambda f: (
        _in_range(f["bpm"], 150, 190, 20) * _above(f["pulse"], 0.45, 0.3)
        * _in_range(f["flatness"], 0.32, 0.62, 0.2) * _above(f["entropy"], 0.55, 0.2)
        * _above(f["flux_peak"], 1.4, 0.8))),
    ("speedcore", "Speedcore", "hard", lambda f: (
        _in_range(f["bpm"], 245, 300, 22) * _above(f["flatness"], 0.5, 0.22)
        * _below(f["lra"], 5, 2.5) * _above(f["entropy"], 0.65, 0.25))),
    ("industrial", "Indus", "hard", lambda f: (
        _in_range(f["bpm"], 140, 185, 22) * _above(f["pulse"], 0.4, 0.3)
        * _above(f["flatness_hi"], 0.5, 0.25) * _above(f["entropy"], 0.6, 0.25)
        * _below(f["lra"], 6, 3))),
    ("rawstyle", "Rawstyle", "hard", lambda f: (
        _in_range(f["bpm"], 148, 163, 10) * _above(f["pulse"], 0.45, 0.3)
        * _in_range(f["flatness"], 0.45, 0.72, 0.18) * _below(f["lra"], 5.5, 2.5))),
    ("hardtechno", "Hard techno", "hard", lambda f: (
        _in_range(f["bpm"], 138, 162, 12) * _above(f["pulse"], 0.55, 0.3)
        * _in_range(f["flatness"], 0.3, 0.6, 0.2) * _below(f["lra"], 6, 3))),
    ("rock", "Rock", "rock", lambda f: (
        _in_range(f["bpm"], 95, 170, 35) * _in_range(f["flatness"], 0.28, 0.62, 0.2)
        * _in_range(f["lra"], 5, 11, 4) * _below(f["pulse"], 0.55, 0.3))),
    ("metal", "Metal", "rock", lambda f: (
        _in_range(f["bpm"], 130, 220, 45) * _above(f["flatness"], 0.42, 0.22)
        * _below(f["lra"], 7, 3.5) * _below(f["pulse"], 0.6, 0.3))),
    ("brutal", "Death / brutal", "rock", lambda f: (
        _in_range(f["bpm"], 200, 300, 40) * _above(f["flatness"], 0.55, 0.2)
        * _below(f["lra"], 5, 2.5) * _below(f["pulse"], 0.6, 0.3))),
    # --- urbain / global ----------------------------------------------------
    ("rap", "Rap", "voice", lambda f: (
        _in_range(f["bpm"], 80, 105, 18) * _above(f["pulse"], 0.35, 0.3)
        * _below(f["flatness"], 0.4, 0.22) * _in_range(f["centroid"], 700, 2600, 1200))),
    ("trap", "Trap", "groove", lambda f: (
        _in_range(f["bpm"], 128, 152, 12) * _below(f["pulse"], 0.68, 0.3)
        * _below(f["centroid"], 2400, 1200) * _below(f["lra"], 7, 3))),
    ("reggaeton", "Reggaeton", "groove", lambda f: (
        _in_range(f["bpm"], 86, 104, 10) * _above(f["pulse"], 0.45, 0.3)
        * _below(f["flatness"], 0.45, 0.22) * _below(f["centroid"], 2800, 1400))),
    ("afrohouse", "Afro house", "groove", lambda f: (
        _in_range(f["bpm"], 116, 126, 8) * _above(f["pulse"], 0.5, 0.3)
        * _below(f["flatness"], 0.42, 0.22) * _above(f["flux_peak"], 1.3, 0.6))),
    ("amapiano", "Amapiano", "groove", lambda f: (
        _in_range(f["bpm"], 106, 120, 8) * _above(f["pulse"], 0.45, 0.3)
        * _below(f["centroid"], 2400, 1200) * _below(f["lra"], 7, 3))),
    ("garage", "UK garage", "groove", lambda f: (
        _in_range(f["bpm"], 126, 140, 8) * _in_range(f["pulse"], 0.3, 0.7, 0.25)
        * _above(f["flux_peak"], 1.4, 0.6) * _below(f["flatness"], 0.45, 0.22))),
    ("breakbeat", "Breakbeat", "groove", lambda f: (
        _in_range(f["bpm"], 125, 152, 10) * _in_range(f["pulse"], 0.3, 0.7, 0.25)
        * _above(f["flux_peak"], 1.5, 0.7) * _below(f["flatness"], 0.5, 0.2))),
    ("dancehall", "Dancehall", "groove", lambda f: (
        _in_range(f["bpm"], 88, 112, 10) * _above(f["pulse"], 0.45, 0.3)
        * _below(f["flatness"], 0.42, 0.22) * _below(f["centroid"], 2600, 1300))),
    ("reggae", "Reggae", "groove", lambda f: (
        _in_range(f["bpm"], 58, 92, 12) * _below(f["flatness"], 0.42, 0.22)
        * _in_range(f["centroid"], 700, 2800, 1300) * _below(f["lra"], 8, 3))),
    # --- house / downtempo --------------------------------------------------
    ("synthwave", "Synthwave", "groove", lambda f: (
        _in_range(f["bpm"], 98, 122, 10) * _above(f["pulse"], 0.4, 0.3)
        * _below(f["flatness"], 0.4, 0.2) * _in_range(f["centroid"], 1200, 3200, 1400))),
    ("funk", "Funk", "groove", lambda f: (
        _in_range(f["bpm"], 95, 125, 12) * _above(f["pulse"], 0.45, 0.3)
        * _below(f["flatness"], 0.42, 0.2) * _above(f["flux_peak"], 1.4, 0.6))),
    ("lofi", "Lo-fi", "sustain", lambda f: (
        _in_range(f["bpm"], 68, 98, 12) * _below(f["pulse"], 0.5, 0.3)
        * _below(f["centroid"], 2200, 1200) * _below(f["lra"], 7, 3))),
    # --- voix / racines -----------------------------------------------------
    ("pop", "Pop", "voice", lambda f: (
        _in_range(f["bpm"], 88, 132, 14) * _above(f["pulse"], 0.4, 0.3)
        * _below(f["flatness"], 0.42, 0.22) * _in_range(f["centroid"], 1000, 3400, 1300))),
    ("soul", "Soul", "voice", lambda f: (
        _in_range(f["bpm"], 58, 102, 16) * _below(f["flatness"], 0.4, 0.2)
        * _in_range(f["centroid"], 700, 2800, 1300) * _in_range(f["lra"], 5, 12, 4))),
    ("blues", "Blues", "voice", lambda f: (
        _in_range(f["bpm"], 58, 122, 18) * _below(f["flatness"], 0.42, 0.22)
        * _in_range(f["lra"], 6, 14, 4) * _in_range(f["centroid"], 700, 3000, 1300))),
    ("country", "Country", "voice", lambda f: (
        _in_range(f["bpm"], 78, 142, 20) * _below(f["flatness"], 0.4, 0.2)
        * _in_range(f["lra"], 6, 14, 4) * _in_range(f["centroid"], 900, 3200, 1300))),
    ("folk", "Folk", "voice", lambda f: (
        _in_range(f["bpm"], 78, 132, 18) * _below(f["flatness"], 0.35, 0.2)
        * _below(f["pulse"], 0.5, 0.3) * _in_range(f["lra"], 7, 15, 4))),
    # --- rock ---------------------------------------------------------------
    ("punk", "Punk", "rock", lambda f: (
        _in_range(f["bpm"], 140, 205, 20) * _above(f["flatness"], 0.4, 0.22)
        * _below(f["lra"], 7, 3) * _below(f["pulse"], 0.6, 0.3))),
    ("indie", "Indie", "rock", lambda f: (
        _in_range(f["bpm"], 98, 152, 18) * _in_range(f["flatness"], 0.3, 0.6, 0.2)
        * _in_range(f["lra"], 5, 11, 4) * _below(f["pulse"], 0.55, 0.3))),
    ("hardrock", "Hard rock", "rock", lambda f: (
        _in_range(f["bpm"], 98, 152, 18) * _above(f["flatness"], 0.4, 0.22)
        * _in_range(f["lra"], 4, 9, 3) * _below(f["pulse"], 0.6, 0.3))),
    # --- scène / party ------------------------------------------------------
    ("phonk", "Phonk", "groove", lambda f: (
        _in_range(f["bpm"], 128, 168, 14) * _below(f["pulse"], 0.72, 0.3)
        * _below(f["centroid"], 2600, 1300) * _below(f["lra"], 7, 3)
        * _above(f["flux_peak"], 1.3, 0.6))),
    ("hardpingpong", "Hard pingpong", "hard", lambda f: (
        _in_range(f["bpm"], 155, 200, 18) * _above(f["pulse"], 0.5, 0.3)
        * _above(f["flatness"], 0.4, 0.22) * _below(f["lra"], 6, 3)
        * _above(f["flux_peak"], 1.5, 0.7))),
    ("germanparty", "German party", "hard", lambda f: (
        _in_range(f["bpm"], 148, 185, 16) * _above(f["pulse"], 0.45, 0.3)
        * _in_range(f["flatness"], 0.38, 0.68, 0.2) * _below(f["lra"], 6.5, 3))),
    # The catch-all: clearly machine-made and clearly rhythmic, nothing more
    # specific fitting. Weak on purpose — it should only ever win by default.
    ("electronic", "Électronique", "groove", lambda f: (
        0.3 * _above(f["pulse"], 0.3, 0.3) * _above(f["bpm"], 100, 40))),
]

ARCHETYPES = ("sustain", "voice", "groove", "hard", "rock")
# --- the wider catalogue ----------------------------------------------------
# The families above are what a heuristic on six descriptors can honestly
# SEPARATE. They are not what a listener calls their music: nobody has a shelf
# labelled "hard", they have gabber and frenchcore and speedcore, and those three
# want three different pictures (webapp/src/lib/viz/skins.js dresses every name
# below differently).
#
# So the studio's vocabulary is deliberately wider than the detector's. Nothing
# here is ever GUESSED — `classify` only ever returns a FAMILIES id — but every
# one of them can be tagged by hand and then predicted by the trained head,
# which is exactly the mechanism that can tell hardtekk from frenchcore when a
# heuristic cannot.
#
# The labels are chosen so the animation engine resolves them: it lowercases and
# strips everything but letters and digits before looking a name up, so "Boom
# bap" and "boombap" are the same genre. `webapp/test/viz.test.mjs` reads this
# list and fails if any of them stops resolving.
EXTRA_GENRES = [
    # --- techno & machine ---------------------------------------------------
    ("Minimal", "groove"), ("Detroit", "groove"), ("Acid techno", "groove"),
    ("Schranz", "hard"), ("Industrial techno", "hard"), ("Peaktime", "groove"),
    ("EBM", "groove"), ("IDM", "groove"), ("Glitch", "groove"),
    ("Experimental", "sustain"), ("Noise", "hard"),
    # --- house & disco ------------------------------------------------------
    ("Deep house", "groove"), ("Tech house", "groove"), ("Prog house", "groove"),
    ("Melodic house", "groove"), ("Bigroom", "hard"), ("Electro house", "groove"),
    ("French house", "groove"), ("Ghetto house", "groove"), ("Gqom", "groove"),
    ("Italo disco", "voice"), ("Nu disco", "groove"), ("Boogie", "voice"),
    ("Eurodance", "voice"), ("Hard house", "hard"), ("Hardbass", "hard"),
    ("Jumpstyle", "hard"),
    # --- garage & breaks ----------------------------------------------------
    ("Two step", "groove"), ("Speed garage", "groove"),
    ("Bassline", "hard"), ("Big beat", "groove"), ("Nu breaks", "groove"),
    ("Jersey club", "groove"), ("Moombahton", "groove"), ("Glitch hop", "groove"),
    # --- drum & bass --------------------------------------------------------
    ("Liquid DnB", "groove"), ("Neurofunk", "hard"), ("Jump up", "hard"),
    ("Jungle", "groove"), ("Darkstep", "hard"), ("Drumfunk", "groove"),
    # --- bass ---------------------------------------------------------------
    ("Brostep", "hard"), ("Riddim", "hard"), ("Melodic dubstep", "sustain"),
    ("Future bass", "voice"), ("Trap EDM", "hard"), ("Hard trap", "hard"),
    # --- trance & psy -------------------------------------------------------
    ("Uplifting trance", "sustain"), ("Prog trance", "groove"),
    ("Vocal trance", "voice"), ("Hard trance", "hard"), ("Goa", "groove"),
    ("Full on", "hard"), ("Darkpsy", "hard"), ("Hitech", "hard"),
    ("Forest", "groove"), ("Psydub", "sustain"),
    # --- hard ---------------------------------------------------------------
    ("Gabber", "hard"), ("UK hardcore", "hard"), ("Happy hardcore", "voice"),
    ("Terrorcore", "hard"), ("Extratone", "hard"), ("Hardtek", "hard"),
    ("Acidcore", "hard"), ("Raggatek", "hard"), ("Industrial hardcore", "hard"),
    ("Crossbreed", "hard"), ("Doomcore", "hard"), ("Breakcore", "hard"),
    ("Lolicore", "hard"), ("Makina", "hard"), ("Euphoric hardstyle", "hard"),
    ("Rawphase", "hard"), ("Tekk", "hard"), ("Bouncy", "hard"),
    # --- urban --------------------------------------------------------------
    ("Boom bap", "groove"), ("Drill", "groove"), ("UK drill", "groove"),
    ("Cloud rap", "voice"), ("Emo rap", "voice"), ("G funk", "groove"),
    ("Lofi hiphop", "sustain"), ("Grime", "groove"), ("Dembow", "groove"),
    ("Afrobeats", "voice"), ("Afroswing", "voice"),
    # --- rock & metal -------------------------------------------------------
    ("Garage rock", "rock"), ("Psych rock", "rock"), ("Prog rock", "rock"),
    ("Hardcore punk", "rock"), ("Post punk", "rock"), ("Pop punk", "rock"),
    ("Ska punk", "rock"), ("Ska", "voice"), ("Grunge", "rock"), ("Emo", "rock"),
    ("Shoegaze", "sustain"), ("Heavy metal", "rock"), ("Thrash", "rock"),
    ("Death metal", "rock"), ("Black metal", "rock"), ("Doom", "rock"),
    ("Sludge", "rock"), ("Metalcore", "rock"), ("Deathcore", "rock"),
    ("Djent", "rock"), ("Nu metal", "rock"), ("Power metal", "rock"),
    ("Symphonic metal", "sustain"),
    # --- pop & vocal --------------------------------------------------------
    ("Synthpop", "voice"), ("Dream pop", "sustain"), ("Hyperpop", "voice"),
    ("K-pop", "voice"), ("J-pop", "voice"), ("City pop", "voice"),
    ("Vaporwave", "sustain"), ("Future funk", "groove"), ("Latin pop", "voice"),
    ("Chanson", "voice"), ("Schlager", "voice"), ("Neo soul", "voice"),
    ("Motown", "voice"), ("Gospel", "voice"),
    # --- chill & downtempo --------------------------------------------------
    ("Chillhop", "sustain"), ("Downtempo", "sustain"), ("Trip hop", "groove"),
    ("Chillout", "sustain"), ("Dub", "groove"), ("Dub techno", "groove"),
    ("Retrowave", "voice"), ("Outrun", "groove"), ("Darksynth", "hard"),
    ("Darkwave", "sustain"), ("Coldwave", "sustain"), ("Gothic", "sustain"),
    ("Witch house", "groove"),
    # --- still --------------------------------------------------------------
    ("Dark ambient", "sustain"), ("Drone", "sustain"), ("New age", "sustain"),
    ("Minimalism", "sustain"),
    # --- played -------------------------------------------------------------
    ("Bebop", "voice"), ("Swing", "voice"), ("Big band", "voice"),
    ("Smooth jazz", "voice"), ("Jazz fusion", "voice"), ("Delta blues", "voice"),
    ("Bluegrass", "voice"), ("Singer songwriter", "voice"), ("Celtic", "voice"),
    ("Flamenco", "voice"), ("Tango", "voice"), ("Salsa", "voice"),
    ("Cumbia", "voice"), ("Samba", "voice"), ("Bossa nova", "voice"),
    ("Rocksteady", "groove"), ("Afrobeat", "groove"), ("Highlife", "voice"),
    ("Kizomba", "voice"), ("Bollywood", "voice"), ("Arabic", "voice"),
    # --- classical ----------------------------------------------------------
    ("Classical", "sustain"), ("Orchestral", "sustain"), ("Opera", "voice"),
    ("Choral", "voice"), ("Baroque", "sustain"), ("Romantic", "sustain"),
    ("Piano", "sustain"), ("Film score", "sustain"), ("Soundtrack", "sustain"),
    # --- other --------------------------------------------------------------
    ("Chiptune", "groove"), ("Eightbit", "groove"),
]


FAMILY_LABEL = {fid: label for fid, label, _a, _w in FAMILIES}


def known_genres():
    """``[(label, archetype), ...]`` — the vocabulary the studio offers.

    The families the heuristic can guess come first, so tagging starts by
    confirming a guess; the wider catalogue follows, so a sub-genre a heuristic
    could never separate is still one keystroke away instead of being retyped by
    hand. Nothing in the second half is ever returned by `classify`.

    Deduplicated on the label, family first. The studio keys its tags by name,
    so a label appearing in both lists seeds ONE tag — and the caller counting
    what it asked for against what it got is then quietly off by one, which is
    exactly how a stray "UK garage" in both halves was found.
    """
    out = []
    seen = set()
    for label, arch in [(l, a) for _fid, l, a, _fn in FAMILIES] + list(EXTRA_GENRES):
        if label in seen:
            continue
        seen.add(label)
        out.append((label, arch))
    return out


def classify(features):
    """(style, confidence, archetype, weights) from whole-file measures."""
    f = dict(features)
    # A track with no tempo cannot be judged by any of the tempo-driven
    # families; let the two that do not need one carry it rather than scoring
    # them all off a BPM of zero.
    tempo_trust = 0.0 if not f.get("bpm") else max(0.25, min(1.0, f.get("bpm_confidence", 0.5) * 1.6))
    raw = {}
    total = 0.0
    for fid, _label, _arch, fn in FAMILIES:
        try:
            w = max(0.0, float(fn(f)))
        except Exception:  # a missing measure must never break the verdict
            w = 0.0
        if fid not in ("ambient", "strings"):
            w *= tempo_trust
        raw[fid] = w
        total += w
    if total < 1e-6:
        return None, 0.0, None, {}
    for k in raw:
        raw[k] /= total

    arche = dict.fromkeys(ARCHETYPES, 0.0)
    for fid, _label, arch, _fn in FAMILIES:
        arche[arch] += raw[fid]

    ranked = sorted(raw.items(), key=lambda kv: kv[1], reverse=True)
    top_id, top = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    conf = max(0.0, min(1.0, top * 2.4 * (0.45 + 0.55 * ((top - second) / top if top else 0))))
    arch = next(a for fid, _l, a, _w in FAMILIES if fid == top_id)
    return top_id, round(conf, 3), arch, {k: round(v, 4) for k, v in arche.items()}


# --- the job ----------------------------------------------------------------
def _deezer_bpm(provider, track):
    """Deezer's own figure for one of its tracks, or None.

    Its public API publishes a bpm per track. Where it has one it is exact and
    free, which beats anything we could measure — and it is the same reasoning
    that takes the loudness from Deezer's GAIN rather than metering the file.
    """
    if not track.deezer_id or provider is None:
        return None
    try:
        if not provider.available():
            return None
        data = provider.dz.api.get_track(str(track.deezer_id))
    except Exception:
        return None
    try:
        bpm = float((data or {}).get("bpm") or 0)
    except (TypeError, ValueError):
        return None
    return bpm if MIN_BPM <= bpm <= MAX_BPM else None


def analyze_track(track: Track, provider=None, force: bool = False):
    """Measure one archived track and store the verdict. Returns the row."""
    if not track or not track.path or not os.path.isfile(track.path):
        return None
    if not ffmpeg_available():
        return None
    existing = TrackAnalysis.get_or_none(TrackAnalysis.track == track)
    if existing and not force and existing.version >= ANALYSIS_VERSION:
        return existing

    t0 = time.monotonic()
    try:
        feats = _spectral(track.path)
    except Exception:
        logger.warning("analysis: spectral pass failed for %s", track.path, exc_info=True)
        return None

    bpm = _deezer_bpm(provider, track)
    source = "deezer" if bpm else None
    bpm_conf = 0.95 if bpm else 0.0
    pulse = 0.0
    try:
        measured, conf, pulse = _measure_tempo(track.path)
        if not bpm and measured:
            bpm, bpm_conf, source = measured, conf, "measured"
    except Exception:
        logger.warning("analysis: tempo pass failed for %s", track.path, exc_info=True)

    # The frozen extractor's vector, when this server can make one. It is what
    # the tagging studio trains on and what a trained head reads; producing it
    # here means it rides the same single decode budget as everything else.
    vec = None
    try:
        from . import embedding as emb

        if emb.available():
            vec = emb.ensure_embedding(track)
    except Exception:
        logger.warning("analysis: embedding failed for %s", track.path, exc_info=True)

    feats.update(
        bpm=bpm or 0.0,
        bpm_confidence=bpm_conf,
        pulse=pulse,
        # Defaults keep the classifier honest when ebur128 said nothing.
        lra=feats.get("lra") if feats.get("lra") is not None else 7.0,
        lufs=feats.get("lufs"),
    )
    style, style_conf, arch, weights = classify(feats)
    source = "heuristic"
    model_dist = None
    # A label the user applied by hand is the strongest signal there is, and the
    # ONLY one that is not a guess: it is a person saying what this track is. It
    # is applied before the head, so tagging a track also makes it a better
    # training example rather than being argued with by the model it trained.
    tag = manual_tag(track)
    if tag is not None:
        style = tag.name
        style_conf = 1.0
        source = "tag"
        if tag.archetype in ARCHETYPES:
            arch = tag.archetype
    # Failing that, a head trained on the user's OWN vocabulary outranks the
    # heuristic, and should: the rules below encode what genres tend to look
    # like in general, while the head was taught what they look like in THIS
    # library. It only speaks when it is reasonably sure, so an unfamiliar track
    # still falls through to the rules rather than being forced into the nearest
    # label.
    elif vec is not None:
        try:
            from . import genre as gen

            guess = gen.predict(vec)
            if guess:
                label, conf, dist, margin = guess
                if conf >= MODEL_MIN_CONFIDENCE and margin >= MODEL_MIN_MARGIN:
                    style, style_conf = label, conf
                    arch = gen.archetype_for(label) or arch
                    source = "model"
                    model_dist = dist
        except Exception:
            logger.warning("analysis: genre head failed for %s", track.path, exc_info=True)

    payload = {
        "centroid": round(feats["centroid"], 1),
        "rolloff": round(feats["rolloff"], 1),
        "spread": round(feats["spread"], 1),
        "flatness": round(feats["flatness"], 4),
        "entropy": round(feats["entropy"], 4),
        "fluxPeak": round(feats["flux_peak"], 3),
        "lufs": round(feats["lufs"], 2) if feats["lufs"] is not None else None,
        "lra": round(feats["lra"], 2),
        "pulse": pulse,
        "archetypes": weights,
        "styleSource": source,
        "model": model_dist,
        "embedded": vec is not None,
        "took": round(time.monotonic() - t0, 2),
    }
    row = existing or TrackAnalysis(track=track)
    row.version = ANALYSIS_VERSION
    row.analyzed = now()
    row.bpm = bpm
    row.bpm_confidence = bpm_conf
    row.bpm_source = source
    row.style = style
    row.style_confidence = style_conf
    row.archetype = arch
    row.data = json.dumps(payload, separators=(",", ":"))
    row.save(force_insert=existing is None)
    logger.info(
        "analysed %s: %s bpm (%s), %s (%.2f) in %.1fs",
        track.path, bpm, source, style, style_conf, payload["took"],
    )
    return row


def payload_for(row, tag=None):
    """What the API serves for one track.

    ``tag`` is the track's manual label, when it has one. A hand-applied genre
    outranks anything a head or the rules produced — the user said so — so it is
    served in place of the measured style rather than next to it, and its label
    is the tag's own name (a label the user invented has no entry in
    ``FAMILY_LABEL``).
    """
    if row is None and tag is None:
        return None
    if tag is not None:
        return {
            "bpm": row.bpm if row is not None else None,
            "bpmConfidence": row.bpm_confidence if row is not None else 0,
            "bpmSource": row.bpm_source if row is not None else None,
            "style": tag.name,
            "styleLabel": tag.name,
            "styleConfidence": 1.0,
            "archetype": tag.archetype,
            "archetypes": {},
            "styleSource": "tag",
            "embedded": False,
            "pulse": 0,
            "lufs": None,
            "lra": None,
            "version": row.version if row is not None else 0,
            "analysed": row is not None,
        }
    try:
        data = json.loads(row.data) if row.data else {}
    except (TypeError, ValueError):
        data = {}
    return {
        "bpm": row.bpm,
        "bpmConfidence": row.bpm_confidence,
        "bpmSource": row.bpm_source,
        "style": row.style,
        "styleLabel": FAMILY_LABEL.get(row.style or "", ""),
        "styleConfidence": row.style_confidence,
        "archetype": row.archetype,
        "archetypes": data.get("archetypes") or {},
        # Where the style came from: the user's own trained head, or the rules.
        "styleSource": data.get("styleSource", "heuristic"),
        "embedded": bool(data.get("embedded")),
        "pulse": data.get("pulse", 0),
        "lufs": data.get("lufs"),
        "lra": data.get("lra"),
        "version": row.version,
        "analysed": True,
    }


def manual_tag(track):
    """The track's hand-applied genre, or None.

    One tag per track (see webui/genre.py::genre_label), so this is a single
    row rather than a list to arbitrate.
    """
    if track is None:
        return None
    try:
        from ..db import TrackTag

        row = (
            TrackTag.select(TrackTag, GenreTag)
            .join(GenreTag)
            .where(TrackTag.track == track)
            .first()
        )
        return row.tag if row is not None else None
    except Exception:
        logger.debug("analysis: could not read the manual tag", exc_info=True)
        return None


def request_analysis(track: Track, provider=None) -> bool:
    """Queue a measurement because a CLIENT asked, rather than the archiver.

    Same daemon-thread-and-semaphore job as ``queue_analysis``, but gated on
    something the archiver's call site does not need to care about: there has to
    be a way to reach a verdict. Without a trained head there is no genre to
    gain — the rules only ever name the broad families the browser already
    computes live — but a tempo is still worth having, so the bar is "a head is
    loaded OR the extractor is usable".

    Returns whether the job was accepted, so the caller can tell the client to
    come back for the answer. A refused request is not an error: it means this
    server has nothing to add, and the client keeps its own reading.
    """
    if track is None or not ffmpeg_available():
        return False
    if not track.path or not os.path.isfile(track.path):
        return False
    if not _can_measure():
        return False
    key = str(track.id)
    with _inflight_lock:
        if key in _inflight:
            return True
    queue_analysis(track, provider)
    with _inflight_lock:
        return key in _inflight


def _can_measure() -> bool:
    try:
        from . import embedding as emb
        from . import genre as gen

        if gen.active_head() is not None:
            return True
        return emb.available() and bool(emb.model_path())
    except Exception:
        return False


def queue_analysis(track: Track, provider=None):
    """Measure a track in the background. Never blocks, never raises.

    Archiving is what makes a track ours, and this is a consequence of it — so
    it is queued there, exactly like the lyrics and the cover. It runs on a
    daemon thread behind a one-at-a-time semaphore: the analysis has no deadline
    and must never be the reason a download, a stream or a shutdown waits.
    """
    if not track or not ffmpeg_available():
        return
    key = str(track.id)
    with _inflight_lock:
        if key in _inflight:
            return
        _inflight.add(key)

    def run():
        try:
            with _slot:
                analyze_track(track, provider)
        except Exception:
            logger.warning("analysis: background job failed for %s", key, exc_info=True)
        finally:
            with _inflight_lock:
                _inflight.discard(key)

    threading.Thread(target=run, name="dz-analysis", daemon=True).start()


# -- running something over the whole library --------------------------------
# Both backfills below walk every archived track. On a real library that is six
# figures of rows and hours of ffmpeg, which makes three things non-negotiable.
#
# NEVER MATERIALISE THE LIBRARY. `list(Track.select())` built every Track object
# in the database before the first measurement ran — gigabytes of Python for a
# job whose working set is one track. An `iterator()` fixes the memory and
# replaces it with a cursor that has to stay open for the whole run.
#
# SO: KEYSET PAGINATION. A short query per page, ordered by primary key, each
# page starting after the last id of the one before. The cursor is a plain
# value — which is the second reason for it.
#
# BECAUSE A LIBRARY JOB MUST SURVIVE THE PROCESS. It runs on a thread inside the
# web server; a container restart, a worker recycle or an OOM kills it mid-run,
# and re-reading a hundred thousand already-measured tracks to get back to where
# it was is not a resume, it is a punishment. The cursor is written to `Meta`
# after every page and cleared at the end, so the next start picks it up.
PAGE_SIZE = 200
#: How long a checkpoint is worth resuming from. Past this the library has
#: probably changed enough that starting over is the honest answer.
RESUME_MAX_AGE = 7 * 24 * 3600


def _checkpoint_read(key, force):
    """The id to resume after, or None to start from the beginning."""
    from ..db import Meta

    row = Meta.get_or_none(Meta.key == key)
    if row is None:
        return None
    try:
        state = json.loads(row.value)
        if bool(state.get("force")) != bool(force):
            return None  # a different run: "re-measure everything" is not this one
        if time.time() - float(state.get("at") or 0) > RESUME_MAX_AGE:
            return None
        return uuid.UUID(state["after"])
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def _checkpoint_write(key, after, force):
    from ..db import Meta

    payload = json.dumps({"after": str(after), "force": bool(force), "at": time.time()})
    row = Meta.get_or_none(Meta.key == key)
    if row is None:
        Meta.create(key=key, value=payload)
    else:
        row.value = payload
        row.save()


def _checkpoint_clear(key):
    from ..db import Meta

    Meta.delete().where(Meta.key == key).execute()


def _archived_pages(after=None):
    """Archived tracks in primary-key order, one bounded page at a time."""
    while True:
        query = Track.select().where(Track.last_modification > 0)
        if after is not None:
            query = query.where(Track.id > after)
        rows = list(query.order_by(Track.id).limit(PAGE_SIZE))
        if not rows:
            return
        yield rows
        after = rows[-1].id


def auto_workers(requested=None) -> int:
    """How many tracks to measure at once.

    Asked of the machine, not of the operator: nobody knows how many cores a VM
    has better than the VM does, and a server that sat at one core while eight
    were idle was slow for no reason at all. Half of them, so the other half
    keeps streaming, transcoding and answering the database. An explicit number
    still wins — the studio offers one — but 0 or None means "work it out".
    """
    from .workload import cpu_workers

    try:
        n = int(requested or 0)
    except (TypeError, ValueError):
        n = 0
    return max(1, min(16, n)) if n > 0 else cpu_workers()


def _walk_library(work, workers, stats, report, key, force, limit=None):
    """Run `work(track)` over the whole archive, in parallel, resumably.

    `work` returns nothing and updates `stats` itself (it is the only thing that
    knows what "done" means for its job).
    """
    from ..db import close_connection, open_connection
    from .workload import renice

    workers = auto_workers(workers)
    after = _checkpoint_read(key, force)
    if after is not None:
        logger.info("%s: resuming after track %s", key, after)
    # Hours of ffmpeg and inference must never take a time slice from the thread
    # serving a stream. Called only from a job thread or the CLI, never from a
    # request thread — a renice is for the life of the thread.
    renice(12)

    def guarded(track):
        # Peewee connections are thread-local and the pool's threads are not the
        # caller's: each takes its own and gives it back, or the run leaks one
        # connection per worker.
        open_connection(reuse=True)
        try:
            work(track)
        finally:
            close_connection()

    pool = (
        ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix="dz-batch",
            initializer=lambda: renice(12),
        )
        if workers > 1
        else None
    )
    try:
        for page in _archived_pages(after):
            if pool is None:
                for track in page:
                    work(track)
            else:
                list(pool.map(guarded, page))
            _checkpoint_write(key, page[-1].id, force)
            if limit is not None and stats["done"] >= limit:
                return  # partial by request: keep the cursor so the next run resumes
        _checkpoint_clear(key)
    finally:
        if pool is not None:
            pool.shutdown(wait=True)


ANALYSIS_CURSOR_KEY = "analysis_cursor"
EMBED_CURSOR_KEY = "embed_cursor"


def backfill(provider=None, force=False, limit=None, progress=None, on_stats=None,
             workers=None):
    """Measure every archived track that has no current verdict.

    The safety net for what the archive event cannot see: tracks archived before
    this existed, and anything measured by an older version of the analysis.

    `workers` runs that many tracks at once; None sizes it from the machine.
    Each one is one to three ffmpeg passes plus (optionally) the extractor, so it
    is the box's CPU and disk that bound it, not Python. Above one the Deezer
    client is left out on purpose — its session is not meant to be hammered from
    several threads, and a locally measured tempo is a fine substitute.
    `on_stats` reports the running counters after every track.
    """
    say = progress or (lambda *_: None)
    report = on_stats or (lambda *_: None)
    if not ffmpeg_available():
        say("ffmpeg not found; nothing to do.")
        return {
            "scanned": 0, "done": 0, "skipped": 0, "failed": 0,
            "error": "ffmpeg is not installed (analysis decodes audio with it)",
        }
    workers = auto_workers(workers)
    if workers > 1:
        provider = None

    stats = {"scanned": 0, "done": 0, "skipped": 0, "failed": 0, "error": None,
             "workers": workers}
    lock = threading.Lock()

    def work(track):
        with lock:
            if limit is not None and stats["done"] >= limit:
                return
            stats["scanned"] += 1
        if not track.path or not os.path.isfile(track.path):
            with lock:
                stats["skipped"] += 1
                report(stats)
            return
        existing = TrackAnalysis.get_or_none(TrackAnalysis.track == track)
        if existing and not force and existing.version >= ANALYSIS_VERSION:
            with lock:
                stats["skipped"] += 1
                report(stats)
            return
        try:
            row = analyze_track(track, provider, force=force)
        except Exception:
            logger.warning("analysis: failed for %s", track.path, exc_info=True)
            row = None
        with lock:
            if row is None:
                stats["failed"] += 1
                if stats["error"] is None:
                    stats["error"] = f"{os.path.basename(track.path)}: analysis failed"
            else:
                stats["done"] += 1
                if stats["done"] % 25 == 0:
                    say(f"  {stats['done']} analysed...")
            report(stats)

    _walk_library(work, workers, stats, report, ANALYSIS_CURSOR_KEY, force, limit)
    return stats


def backfill_embeddings(force=False, limit=None, progress=None, on_stats=None,
                        workers=None):
    """Extract the frozen vector for every archived track that lacks one.

    Separate from `backfill` because it has a different cost profile and a
    different prerequisite: it needs onnxruntime and the model file, and it is
    the slow one. Running it is how a library becomes taggable.

    `on_stats` is called after every track with the running counters, so the web
    UI can show progress without this function knowing anything about it.
    """
    from . import embedding as emb

    say = progress or (lambda *_: None)
    report = on_stats or (lambda *_: None)
    why = emb.why_unavailable()
    if why:
        say(f"Extractor unavailable: {why}")
        return {"scanned": 0, "done": 0, "skipped": 0, "failed": 0, "error": why}
    # One check up front. A model that cannot load would otherwise be reported as
    # thousands of per-track failures, which tells the operator nothing.
    load_err = emb.session_error()
    if load_err:
        say(f"Extractor unusable: {load_err}")
        return {"scanned": 0, "done": 0, "skipped": 0, "failed": 0, "error": load_err}

    workers = auto_workers(workers)
    stats = {"scanned": 0, "done": 0, "skipped": 0, "failed": 0, "error": None,
             "workers": workers}
    lock = threading.Lock()

    def work(track):
        with lock:
            if limit is not None and stats["done"] >= limit:
                return
            stats["scanned"] += 1
        if not track.path or not os.path.isfile(track.path):
            with lock:
                stats["skipped"] += 1
                report(stats)
            return
        if not force and emb.vector_is_current(emb.load_embedding(track)):
            with lock:
                stats["skipped"] += 1
                report(stats)
            return
        vec, reason = emb.embed_file_verbose(track.path)
        ok = vec is not None and emb.save_embedding(track, vec)
        with lock:
            if not ok:
                stats["failed"] += 1
                # Keep the LAST reason, not the first: a run that starts fine
                # and then loses the model has everything to say in its tail,
                # and the first line ("that one file is too short") hid it.
                if reason:
                    stats["error"] = reason
            else:
                stats["done"] += 1
                if stats["done"] % 20 == 0:
                    say(f"  {stats['done']} embedded...")
            report(stats)

    _walk_library(work, workers, stats, report, EMBED_CURSOR_KEY, force, limit)
    return stats

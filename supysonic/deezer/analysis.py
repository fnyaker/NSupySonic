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

from ..db import Track, TrackAnalysis, now

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
MODEL_MIN_CONFIDENCE = 0.45
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
    ("rock", "Rock", "rock", lambda f: (
        _in_range(f["bpm"], 95, 170, 35) * _in_range(f["flatness"], 0.28, 0.62, 0.2)
        * _in_range(f["lra"], 5, 11, 4) * _below(f["pulse"], 0.55, 0.3))),
    ("metal", "Metal", "rock", lambda f: (
        _in_range(f["bpm"], 130, 220, 45) * _above(f["flatness"], 0.42, 0.22)
        * _below(f["lra"], 7, 3.5) * _below(f["pulse"], 0.6, 0.3))),
    ("brutal", "Death / brutal", "rock", lambda f: (
        _in_range(f["bpm"], 200, 300, 40) * _above(f["flatness"], 0.55, 0.2)
        * _below(f["lra"], 5, 2.5) * _below(f["pulse"], 0.6, 0.3))),
    # The catch-all: clearly machine-made and clearly rhythmic, nothing more
    # specific fitting. Weak on purpose — it should only ever win by default.
    ("electronic", "Électronique", "groove", lambda f: (
        0.3 * _above(f["pulse"], 0.3, 0.3) * _above(f["bpm"], 100, 40))),
]

ARCHETYPES = ("sustain", "voice", "groove", "hard", "rock")
FAMILY_LABEL = {fid: label for fid, label, _a, _w in FAMILIES}


def known_genres():
    """``[(label, archetype), ...]`` — the vocabulary this engine already knows.

    The studio seeds its tag list from this, so the genres the heuristic can
    already guess arrive ready to confirm instead of being retyped by hand.
    """
    return [(label, arch) for _fid, label, arch, _fn in FAMILIES]


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
    # A head trained on the user's OWN vocabulary outranks the heuristic, and
    # should: the rules below encode what genres tend to look like in general,
    # while the head was taught what they look like in THIS library. It only
    # speaks when it is reasonably sure, so an unfamiliar track still falls
    # through to the rules rather than being forced into the nearest label.
    if vec is not None:
        try:
            from . import genre as gen

            guess = gen.predict(vec)
            if guess and guess[1] >= MODEL_MIN_CONFIDENCE:
                style, style_conf = guess[0], guess[1]
                arch = gen.archetype_for(guess[0]) or arch
                source = "model"
                model_dist = guess[2]
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


def payload_for(row):
    """What the API serves for one track."""
    if row is None:
        return None
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
    }


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


def backfill(provider=None, force=False, limit=None, progress=None):
    """Measure every archived track that has no current verdict.

    The safety net for what the archive event cannot see: tracks archived before
    this existed, and anything measured by an older version of the analysis.
    Synchronous and one at a time on purpose — this is a maintenance command,
    not something that should ever compete with playback for the box.
    """
    say = progress or (lambda *_: None)
    if not ffmpeg_available():
        say("ffmpeg not found; nothing to do.")
        return {"scanned": 0, "done": 0, "skipped": 0, "failed": 0}

    stats = {"scanned": 0, "done": 0, "skipped": 0, "failed": 0}
    query = Track.select().where(Track.last_modification > 0).order_by(Track.created)
    for track in query:
        if limit is not None and stats["done"] >= limit:
            break
        stats["scanned"] += 1
        if not track.path or not os.path.isfile(track.path):
            stats["skipped"] += 1
            continue
        existing = TrackAnalysis.get_or_none(TrackAnalysis.track == track)
        if existing and not force and existing.version >= ANALYSIS_VERSION:
            stats["skipped"] += 1
            continue
        try:
            row = analyze_track(track, provider, force=force)
        except Exception:
            logger.warning("analysis: failed for %s", track.path, exc_info=True)
            row = None
        if row is None:
            stats["failed"] += 1
            continue
        stats["done"] += 1
        if stats["done"] % 25 == 0:
            say(f"  {stats['done']} analysed...")
    return stats


def backfill_embeddings(force=False, limit=None, progress=None, on_stats=None):
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
        return {"scanned": 0, "done": 0, "skipped": 0, "failed": 0}

    stats = {"scanned": 0, "done": 0, "skipped": 0, "failed": 0}
    for track in Track.select().where(Track.last_modification > 0).order_by(Track.created):
        if limit is not None and stats["done"] >= limit:
            break
        stats["scanned"] += 1
        if not track.path or not os.path.isfile(track.path):
            stats["skipped"] += 1
            report(stats)
            continue
        if not force and emb.load_embedding(track) is not None:
            stats["skipped"] += 1
            report(stats)
            continue
        vec = emb.embed_file(track.path)
        if vec is None or not emb.save_embedding(track, vec):
            stats["failed"] += 1
            report(stats)
            continue
        stats["done"] += 1
        if stats["done"] % 20 == 0:
            say(f"  {stats['done']} embedded...")
        report(stats)
    return stats

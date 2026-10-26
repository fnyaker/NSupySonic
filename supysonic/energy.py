# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""How intense each title of the library is, 0 (the calmest) to 1.

Spotify's ``energy`` is "a perceptual measure of intensity and activity…
energetic tracks feel fast, loud, and noisy. Perceptual features contributing
to this attribute include dynamic range, perceived loudness, timbre, onset
rate, and general entropy" (Web API reference). The server already measured
each of these once per file (``deezer/analysis.py``, ``track_analysis``):

==================  =====================================  =======
Spotify's feature   what we have                           weight
==================  =====================================  =======
perceived loudness  integrated loudness, LUFS              0.25
dynamic range       loudness range, LRA (less = more)      0.15
timbre              spectral centroid (brighter = more)    0.15
onset rate          peak spectral flux                     0.20
(fast)              tempo, when trusted                    0.15
general entropy     spectral entropy                       0.10
==================  =====================================  =======

Each measure is turned into its RANK in the library (0..1) before they are
averaged: the scales (dB, Hz, BPM) cannot be added, and a rank needs no
threshold of ours — "Énergique" is the louder, denser fifth of THIS library,
whatever it holds. A measure a row lacks is left out of its average; a row
with none has no energy (None) and is neither favoured nor excluded.

The whole map is built from one read of ``track_analysis`` and kept in
memory; it is rebuilt in a background thread when it is older than ``TTL``
(the stale one answers meanwhile), so no click waits for it after the first.
"""

import bisect
import json
import logging
import math
import threading
import time

from .db import TrackAnalysis

logger = logging.getLogger(__name__)

#: (key in the row's data, sign, weight); "bpm" is the column.
FEATURES = (
    ("lufs", 1, 0.25),
    ("lra", -1, 0.15),
    ("centroid", 1, 0.15),
    ("fluxPeak", 1, 0.20),
    ("bpm", 1, 0.15),
    ("entropy", 1, 0.10),
)
#: Below this confidence the measured tempo is not used.
BPM_TRUSTED = 0.3
#: How long a map is served before a rebuild is started.
TTL = 600

_lock = threading.Lock()
_state = {"at": 0.0, "map": None, "building": False}


def _ranks(values):
    """``{key: rank in 0..1}`` (mid-rank for ties)."""
    if not values:
        return {}
    ordered = sorted(values.values())
    n = len(ordered)
    if n == 1:
        return {k: 0.5 for k in values}
    out = {}
    for k, v in values.items():
        lo = bisect.bisect_left(ordered, v)
        hi = bisect.bisect_right(ordered, v) - 1
        out[k] = ((lo + hi) / 2.0) / (n - 1)
    return out


def compute(rows):
    """``{track id: energy}`` from ``[(track, bpm, bpm_confidence, data)]``."""
    per = {name: {} for name, _s, _w in FEATURES}
    for tid, bpm, conf, data in rows:
        try:
            d = json.loads(data) if data else {}
        except (TypeError, ValueError):
            d = {}
        if not isinstance(d, dict):
            d = {}
        for name, sign, _w in FEATURES:
            if name == "bpm":
                v = bpm if bpm and (conf or 0) >= BPM_TRUSTED else None
            else:
                v = d.get(name)
            try:
                v = float(v) if v is not None else None
            except (TypeError, ValueError):
                v = None
            if v is not None and v == v:  # not NaN
                per[name][tid] = sign * v
    ranks = {name: _ranks(vals) for name, vals in per.items()}
    out = {}
    tids = set()
    for vals in per.values():
        tids.update(vals)
    for tid in tids:
        total = weight = 0.0
        for name, _sign, w in FEATURES:
            r = ranks[name].get(tid)
            if r is not None:
                total += w * r
                weight += w
        if weight >= 0.3:  # a lone measure does not make an energy
            out[tid] = total / weight
    # The average of ranks bunches toward the middle: rank it once more so
    # the notches cut the library into even shares.
    return _ranks(out)


def _build():
    rows = (
        TrackAnalysis.select(TrackAnalysis.track, TrackAnalysis.bpm,
                             TrackAnalysis.bpm_confidence, TrackAnalysis.data)
        .tuples()
    )
    return compute(rows)


def _rebuild_in_background():
    from .db import close_connection, open_connection

    def run():
        try:
            open_connection()
            m = _build()
            with _lock:
                _state.update(at=time.monotonic(), map=m)
        except Exception:
            logger.warning("energy: rebuild failed", exc_info=True)
        finally:
            with _lock:
                _state["building"] = False
            try:
                close_connection()
            except Exception:  # nosec B110 - the thread is ending either way
                pass

    threading.Thread(target=run, name="energy-map", daemon=True).start()


def energies():
    """The map, built here the first time, then refreshed in the background."""
    with _lock:
        m, at, building = _state["map"], _state["at"], _state["building"]
        if m is not None and time.monotonic() - at > TTL and not building:
            _state["building"] = True
            stale = True
        else:
            stale = False
    if m is None:
        m = _build()
        with _lock:
            _state.update(at=time.monotonic(), map=m)
        return m
    if stale:
        _rebuild_in_background()
    return m


def invalidate():
    with _lock:
        _state.update(at=0.0, map=None)


#: The notches the Flow starts from: (name, energy aimed at; None is "any").
STEPS = (
    ("Libre", None),
    ("Très calme", 0.1),
    ("Calme", 0.3),
    ("Modéré", 0.5),
    ("Énergique", 0.7),
    ("Intense", 0.9),
)
#: A title this far from the aim weighs e^-1 as much: about one notch
#: (0.2 apart) is e^-2.8, so a notch means that notch.
BAND = 0.12
#: A title with no energy measured weighs this much when an energy is asked.
UNKNOWN = 0.3


def fit(e, target) -> float:
    """How well an energy matches the aim (1 on it, never quite 0)."""
    if target is None:
        return 1.0
    if e is None:
        return UNKNOWN
    x = (e - target) / BAND
    return max(1e-12, math.exp(-x * x))


def step_name(target) -> str:
    if target is None:
        return STEPS[0][0]
    return min(STEPS[1:], key=lambda s: abs(s[1] - target))[0]

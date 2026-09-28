# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""How a track is BUILT, as the player's analyser heard it.

The frozen extractor hears timbre well and tempo poorly, and it learnt Discogs'
styles — none of which is Pieep or Deutscher Krach. What tells those apart is
what the web player's analyser already reads kick by kick (webapp/rhythm/src/
style.rs): where the kick's pitch starts, the piep on its attack, how long it
rings, the rolls, the saw buzz, whether every beat carries a kick. The player
averages those over the groove of a track it plays and posts the summary
(``webapp/src/lib/genre/construction.js``); it is kept here, beside the audio
like the embedding, and the genre head reads it next to the vector and the
served tempo (genre.assemble).

Every value is clamped and every post is merged into a running mean whose
weight is capped: a post counts for at most MAX_FRAMES_PER_POST frames (more
than the loud part of any one track holds) and the stored summary for at most
MAX_WEIGHT, so once a summary has two plays behind it no single post — honest
or not — moves it more than a third of the way.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading

logger = logging.getLogger(__name__)

#: The descriptors, in the order the head reads them (construction.js).
KEYS = (
    "kickF0", "piep", "tail", "lead", "buzz", "screech", "offbeat", "density", "roll", "four",
    "kSoft", "kHard", "kIndus",
)
#: What the head reads next to the vector: the served tempo, then those.
EXTRAS = ("tempo",) + KEYS
# The kick's pitch is in hertz; everything else is a share or a rate near 0..1.
_RANGE = {"kickF0": (0.0, 2000.0)}
_DEFAULT_RANGE = (-1.0, 16.0)
#: A summary's weight is capped (in analysis frames, ~94 a second): newer plays
#: keep mattering, and one long post cannot outweigh everything before it.
MAX_WEIGHT = 60000
#: ~5 minutes of groove: a whole play of any one track, not an hour's worth.
MAX_FRAMES_PER_POST = 30000
SUFFIX = ".live.json"

_lock = threading.Lock()


def sidecar_path(track) -> str | None:
    if not track or not track.path:
        return None
    base, _ext = os.path.splitext(track.path)
    return base + SUFFIX


def load(track) -> dict | None:
    """``{"n": frames, "features": {key: value}}`` or None."""
    p = sidecar_path(track)
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        n = int(data.get("n") or 0)
        feats = data.get("features") or {}
        out = {k: float(feats[k]) for k in KEYS if k in feats and math.isfinite(float(feats[k]))}
        return {"n": n, "features": out} if n > 0 and out else None
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def clean(payload) -> tuple[int, dict]:
    """``(frames, {key: value})`` from a posted summary, or ValueError."""
    if not isinstance(payload, dict):
        raise ValueError("a summary is an object")
    try:
        n = int(payload.get("n"))
    except (TypeError, ValueError):
        raise ValueError("n must be a frame count")
    if n < 1:
        raise ValueError("n must be a frame count")
    feats = payload.get("features")
    if not isinstance(feats, dict):
        raise ValueError("features must be an object")
    out = {}
    for k in KEYS:
        if k not in feats:
            continue
        try:
            v = float(feats[k])
        except (TypeError, ValueError):
            raise ValueError(f"{k} is not a number")
        if not math.isfinite(v):
            raise ValueError(f"{k} is not finite")
        lo, hi = _RANGE.get(k, _DEFAULT_RANGE)
        out[k] = min(hi, max(lo, v))
    if not out:
        raise ValueError("no known descriptor")
    return min(n, MAX_FRAMES_PER_POST), out


def merge_and_save(track, n, features) -> dict | None:
    """Fold a new summary into the stored one (a mean weighted by frames, the
    stored weight capped at MAX_WEIGHT) and write it. Returns what is stored."""
    p = sidecar_path(track)
    if not p:
        return None
    with _lock:
        have = load(track)
        if have:
            w_old = min(MAX_WEIGHT, have["n"])
            w_new = min(MAX_WEIGHT, n)
            merged = {}
            for k in KEYS:
                a = have["features"].get(k)
                b = features.get(k)
                if a is None and b is None:
                    continue
                if a is None:
                    merged[k] = b
                elif b is None:
                    merged[k] = a
                else:
                    merged[k] = (a * w_old + b * w_new) / (w_old + w_new)
            total = min(MAX_WEIGHT, w_old + w_new)
        else:
            merged, total = dict(features), min(MAX_WEIGHT, n)
        doc = {"v": 1, "n": total, "features": {k: round(v, 5) for k, v in merged.items()}}
        tmp = p + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fp:
                json.dump(doc, fp, separators=(",", ":"))
            os.replace(tmp, p)
        except OSError:
            logger.warning("construction: could not write %s", p, exc_info=True)
            try:
                os.unlink(tmp)
            except OSError:
                pass
            return None
        return doc


def raw_extras(bpm, summary) -> dict:
    """The head's raw extra inputs for a track: ``{"tempo": log2(bpm/120)}``
    when the tempo is plausible, plus the construction features."""
    out = {}
    try:
        b = float(bpm or 0)
    except (TypeError, ValueError):
        b = 0.0
    if 20 < b < 400:
        out["tempo"] = math.log2(b / 120.0)
    if summary and summary.get("features"):
        for k, v in summary["features"].items():
            if k in KEYS:
                out[k] = v
    return out

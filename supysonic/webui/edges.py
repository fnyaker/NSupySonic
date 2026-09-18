# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Where a track's audio actually starts and stops.

Files are not their music: a master usually carries a beat of digital silence
at the head and a tail of room noise or plain zeroes after the last note. A
crossfade that ignores them fades one track's silence into another track's
silence, which is exactly the gap it was meant to remove — so the web player
asks for these bounds before it blends two tracks, and starts each one where
its audio does.

The measurement is ffmpeg's ``silencedetect``, run once per (file, threshold)
and cached. One full pass rather than two windowed ones: a pass over the head
and another over the tail would be cheaper, but the tail one needs the file's
exact duration to place its window, and getting that reliably costs a probe of
its own — while the full pass reports the duration itself, as the ``time=`` of
the last progress line. One code path, exact bounds, cached forever.

This is deliberately NOT part of archiving: it only ever measures a file that is
already on disk. A player asking about the next track must never be what starts
a download — the answer would arrive minutes late and the request would hold an
HTTP thread the whole time. When the file is not there the endpoint says so and
the player simply plays the track untrimmed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess

from flask import current_app, jsonify, request, send_file

from . import login_required, webapi
from .share import (
    FFMPEG_TIMEOUT,
    _Busy,
    _busy_response,
    _ffmpeg_available,
    _ffmpeg_slot,
    _resolve_media,
)

logger = logging.getLogger(__name__)

# What counts as silence, in dBFS. The default matches the web player's.
DEFAULT_THRESHOLD = -45.0
MIN_THRESHOLD = -90.0
MAX_THRESHOLD = -20.0
# A silence has to last this long to count, so the gap between two notes is
# never mistaken for the end of the track.
MIN_SILENCE = 0.1
# Never hand back a trim bigger than this, whatever the file says. A track that
# opens with a minute of near-silence is a real track, and a player that skipped
# into it would look broken; past this point the right answer is "play it all".
MAX_TRIM = 30.0

_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*(-?[\d.]+)")
_TIME = re.compile(r"time=\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")


def _clamp_threshold(raw):
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD
    return max(MIN_THRESHOLD, min(MAX_THRESHOLD, v))


def _local_path(mid):
    """The media's file, only if it is already archived. Never fetches."""
    track, episode = _resolve_media(mid)
    if episode is not None:
        path = episode.path
        return (path, str(episode.id), episode.duration or 0) if path else (None, None, 0)
    if track is None:
        return None, None, 0
    return track.path, str(track.id), track.duration or 0


def _detect(path, threshold):
    """Run silencedetect over the whole file.

    Returns ``(intervals, duration)`` where intervals is a list of
    ``(start, end_or_None)`` — ``None`` meaning the silence runs to the end of
    the file, which is precisely the case the trailing trim is looking for.
    """
    cmd = [
        "ffmpeg", "-nostats", "-v", "info", "-i", path,
        "-map", "0:a:0",
        # Mono at 8 kHz before the filter: silence is a level question, and
        # resampling down first makes the filter and everything after it cheap.
        # The decode dominates either way and cannot be avoided.
        "-ac", "1", "-ar", "8000",
        "-af", f"silencedetect=noise={threshold}dB:d={MIN_SILENCE}",
        "-f", "null", "-",
    ]
    proc = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=FFMPEG_TIMEOUT,
        check=False,
    )
    err = proc.stderr.decode("utf-8", "replace")
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exited {proc.returncode}")

    intervals = []
    open_start = None
    for line in err.splitlines():
        m = _SIL_START.search(line)
        if m:
            # A start with no end before it closes is a malformed run; keep the
            # newest, which is what the tail check cares about.
            open_start = max(0.0, float(m.group(1)))
            intervals.append([open_start, None])
            continue
        m = _SIL_END.search(line)
        if m and intervals and intervals[-1][1] is None:
            intervals[-1][1] = max(0.0, float(m.group(1)))

    duration = 0.0
    for m in _TIME.finditer(err):
        duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return intervals, duration


def _edges(intervals, duration):
    """Turn detected silences into (start, end) of the actual audio."""
    start = 0.0
    end = duration
    if intervals:
        first_start, first_end = intervals[0]
        # Leading silence only counts when it starts AT the beginning.
        if first_start <= 0.05 and first_end is not None:
            start = first_end
        last_start, last_end = intervals[-1]
        # A silence with no end ran to EOF: that is the trailing one.
        if last_end is None and last_start > start:
            end = last_start
    # Past the cap the answer is "play it all", not "skip an arbitrary 30 s":
    # a track opening on ninety seconds of near-silence is a hidden-track
    # arrangement, and jumping a third of the way into it is not a trim.
    if start > MAX_TRIM:
        start = 0.0
    if duration > 0:
        if end < duration - MAX_TRIM:
            end = duration
        end = min(end, duration)
    # A file that measures as silent end to end (a broken decode, a threshold
    # the user pushed to -20) must not come back as a zero-length track.
    if not (end > start + 1.0):
        return 0.0, duration
    return round(start, 3), round(end, 3)


@webapi.route("/audio/edges/<mid>")
@login_required
def audio_edges(mid):
    """Where the audio starts and stops inside the file, in seconds."""
    threshold = _clamp_threshold(request.args.get("db"))
    path, key, db_duration = _local_path(mid)
    # Not archived (or not ours): say so plainly. The player treats this as
    # "no trimming for this one" and carries on — it is not an error.
    if not path or not os.path.isfile(path):
        return jsonify({"ready": False, "duration": db_duration})
    try:
        mtime = int(os.path.getmtime(path))
    except OSError:
        return jsonify({"ready": False, "duration": db_duration})

    cache = current_app.cache
    ckey = f"edges-{key}-{mtime}-{threshold:g}"
    if cache.has(ckey):
        return send_file(cache.get(ckey), mimetype="application/json")

    if not _ffmpeg_available():
        return jsonify({"ready": False, "duration": db_duration})
    try:
        with _ffmpeg_slot():
            intervals, duration = _detect(path, threshold)
    except _Busy:
        return _busy_response()
    except Exception:
        logger.warning("edges: silence detection failed for %s", mid, exc_info=True)
        return jsonify({"ready": False, "duration": db_duration})

    if duration <= 0:
        duration = float(db_duration or 0)
    start, end = _edges(intervals, duration)
    payload = json.dumps(
        {
            "ready": True,
            "start": start,
            "end": end,
            "duration": round(duration, 3),
            "threshold": threshold,
        }
    ).encode("utf-8")
    return send_file(cache.set(ckey, payload), mimetype="application/json")

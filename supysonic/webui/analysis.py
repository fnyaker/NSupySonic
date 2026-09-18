# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Serving the whole-track analysis (tempo + style) to the player.

The measurement itself lives in ``supysonic/deezer/analysis.py``; this is only
the way out. It reads and never computes: a request must never be what starts a
three-second ffmpeg pass, because the player asks about tracks it is *about* to
play and an answer that arrives a minute later is no answer at all. Anything not
yet measured comes back as a plain absence, and the client falls back to its own
live detector — which is exactly what it did before this existed.

Batched like ``/api/gains`` and for the same reason: the player wants the whole
run it is about to play, in one call, before any of it starts.
"""

from __future__ import annotations

import logging

from flask import jsonify, request

from ..db import Track, TrackAnalysis
from . import _may_access_track, _valid_id, login_required, webapi

logger = logging.getLogger(__name__)

ANALYSIS_BATCH_MAX = 100


def _rows_for(ids):
    """{universal id -> payload} for the ids that have a stored verdict."""
    from ..deezer import analysis as ana
    from ..deezer import ids as dz_ids

    out = {}
    if not ids:
        return out
    # One query for the lot, keyed by the canonical uuid5 that IS the row's
    # primary key, so this is an index lookup rather than a scan on deezer_id.
    keys = {}
    for i in ids:
        try:
            keys[dz_ids.track_uuid(i)] = i
        except Exception:
            continue
    if not keys:
        return out
    rows = (
        TrackAnalysis.select(TrackAnalysis, Track)
        .join(Track)
        .where(TrackAnalysis.track.in_(list(keys)))
    )
    for row in rows:
        ident = keys.get(row.track.id)
        if ident is None:
            continue
        out[ident] = ana.payload_for(row)
    return out


@webapi.route("/analysis/<mid>")
@login_required
def track_analysis(mid):
    """The verdict for one track, or ``{"ready": false}``."""
    from ..deezer import analysis as ana

    row = None
    if _valid_id(mid):
        found = _rows_for([str(mid)])
        if found:
            return jsonify({"ready": True, **found[str(mid)]})
    else:
        track = Track.get_or_none(Track.id == mid)
        if track is not None and _may_access_track(track):
            row = TrackAnalysis.get_or_none(TrackAnalysis.track == track)
    if row is None:
        return jsonify({"ready": False})
    return jsonify({"ready": True, **ana.payload_for(row)})


@webapi.route("/analyses", methods=["POST"])
@login_required
def track_analyses():
    """Verdicts for a whole run of tracks in ONE call."""
    data = request.get_json(silent=True) or {}
    raw = data.get("ids") or []
    if not isinstance(raw, list):
        return jsonify({"error": "ids must be a list"}), 400
    ids = list(dict.fromkeys(str(x) for x in raw if _valid_id(x)))[:ANALYSIS_BATCH_MAX]
    return jsonify({"analyses": _rows_for(ids)})

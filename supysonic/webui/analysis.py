# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Serving the whole-track analysis (tempo + style) to the player.

The measurement itself lives in ``supysonic/deezer/analysis.py``; this is only
the way out. A request must never be what *waits* on a three-second ffmpeg pass,
because the player asks about tracks it is *about* to play and an answer that
arrives a minute later is no answer at all.

But an unmeasured track is not a dead end either. When the server has a way to
reach a verdict — the operator's own trained head, or the frozen extractor plus
a head trained on it — the request puts the track on the BACKGROUND queue and
returns straight away, naming it in ``pending``. The client keeps its own live
reading in the meantime, polls for the ids it was told about, and swaps to the
served genre the moment it lands. That is the difference between "we know the
genre" and "we will know it shortly", and both are useful.

Anything the server genuinely cannot measure comes back as a plain absence, and
the client falls back to its own live detector — which is exactly what it did
before this existed.

Batched like ``/api/gains`` and for the same reason: the player wants the whole
run it is about to play, in one call, before any of it starts.
"""

from __future__ import annotations

import logging
import threading

from flask import current_app, jsonify, request

from ..db import Meta, Track, TrackAnalysis, now
from . import _may_access_track, _valid_id, admin_required, login_required, webapi

logger = logging.getLogger(__name__)

ANALYSIS_BATCH_MAX = 100
ANALYSIS_WORKERS_MAX = 8
# How many unmeasured tracks ONE request may put on the background queue. The
# player asks about the run it is about to play, so a handful is all a real
# window needs; the cap is what keeps a request for a thousand ids from turning
# into a thousand decode jobs.
ANALYSIS_QUEUE_MAX = 3
# The admin's parallelism choice lives in the Meta KV table, like the upload
# quota: it is a server-wide cost, not a per-request one.
_WORKERS_META_KEY = "analysis_workers"


def _workers() -> int:
    row = Meta.get_or_none(Meta.key == _WORKERS_META_KEY)
    if row is not None:
        try:
            return max(1, min(ANALYSIS_WORKERS_MAX, int(row.value)))
        except (TypeError, ValueError):
            pass
    return 1


def _set_workers(value: int) -> int:
    value = max(1, min(ANALYSIS_WORKERS_MAX, int(value)))
    row = Meta.get_or_none(Meta.key == _WORKERS_META_KEY)
    if row is None:
        Meta.create(key=_WORKERS_META_KEY, value=str(value))
    else:
        row.value = str(value)
        row.save()
    return value


# -- the analysis backfill job -----------------------------------------------
# Tempo + style (+ the embedding, when the extractor is there) for the whole
# library, run in a worker the studio polls. `workers` runs that many tracks at
# once — the work is ffmpeg, so the box bounds it, not Python.
_analysis_lock = threading.Lock()
_analysis_job = {
    "running": False,
    "started": None,
    "finished": None,
    "force": False,
    "workers": 1,
    "total": 0,
    "scanned": 0,
    "done": 0,
    "skipped": 0,
    "failed": 0,
    "error": None,
}


def _analysis_job_json() -> dict:
    with _analysis_lock:
        return dict(_analysis_job)


def _run_analysis(app, force, workers, limit):
    from ..db import close_connection, open_connection
    from ..deezer.analysis import backfill

    with app.app_context():
        try:
            open_connection(reuse=True)

            def on_stats(stats):
                with _analysis_lock:
                    _analysis_job.update(stats)

            provider = getattr(app, "deezer", None)
            stats = backfill(
                provider=provider,
                force=force,
                limit=limit,
                workers=workers,
                on_stats=on_stats,
            )
            with _analysis_lock:
                _analysis_job.update(stats)
        except Exception as exc:
            logger.warning("Analysis backfill crashed", exc_info=True)
            with _analysis_lock:
                _analysis_job["error"] = str(exc)
        finally:
            with _analysis_lock:
                _analysis_job["running"] = False
                _analysis_job["finished"] = now().isoformat()
            try:
                close_connection()
            except Exception:
                pass


@webapi.route("/analysis/backfill", methods=["POST"])
@login_required
@admin_required
def analysis_backfill_start():
    """(Re)measure the library: tempo, style, and the embedding when possible."""
    from ..deezer.analysis import ffmpeg_available

    if not ffmpeg_available():
        return jsonify({"error": "ffmpeg n'est pas installé sur le serveur"}), 400
    data = request.get_json(silent=True) or {}
    force = bool(data.get("force"))
    try:
        workers = int(data.get("workers") or _workers())
    except (TypeError, ValueError):
        workers = _workers()
    workers = _set_workers(workers)
    with _analysis_lock:
        if _analysis_job["running"]:
            return jsonify({"ok": True, **_analysis_job})
        _analysis_job.update(
            running=True,
            started=now().isoformat(),
            finished=None,
            force=force,
            workers=workers,
            total=Track.select().where(Track.last_modification > 0).count(),
            scanned=0,
            done=0,
            skipped=0,
            failed=0,
            error=None,
        )
    app = current_app._get_current_object()
    threading.Thread(
        target=_run_analysis,
        args=(app, force, workers, None),
        name="analysis-backfill",
        daemon=True,
    ).start()
    return jsonify({"ok": True, **_analysis_job_json()})


@webapi.route("/analysis/backfill")
@login_required
@admin_required
def analysis_backfill_status():
    return jsonify({"workers": _workers(), **_analysis_job_json()})


def _rows_for(ids):
    """{universal id -> payload} for the ids that have a verdict to serve.

    A track the user tagged by hand is served even when nothing has measured it:
    the label IS a verdict, and it outranks anything the measurement would have
    said. That is the whole point of the tag button — the player gets the right
    genre immediately, not after the next backfill.
    """
    from ..db import GenreTag, TrackTag
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
    tagged = {}
    tags = (
        TrackTag.select(TrackTag, GenreTag)
        .join(GenreTag)
        .where(TrackTag.track.in_(list(keys)))
    )
    for t in tags:
        tagged.setdefault(t.track_id, t.tag)
    seen = set()
    for row in rows:
        ident = keys.get(row.track.id)
        if ident is None:
            continue
        seen.add(row.track.id)
        out[ident] = ana.payload_for(row, tag=tagged.get(row.track.id))
    # A tag with no measurement at all still has an answer to give.
    for track_id, tag in tagged.items():
        if track_id in seen:
            continue
        ident = keys.get(track_id)
        if ident is not None:
            out[ident] = ana.payload_for(None, tag=tag)
    return out


def _missing(ids, found):
    """The ids we have nothing to say about — one lookup, then queued.

    Deliberately does NOT queue here: this is the pure half, so the single-track
    and batch paths agree on what "missing" means before either of them decides
    to spend the box's CPU on it.
    """
    return [i for i in ids if i not in found]


def _queue_missing(ids, limit=ANALYSIS_QUEUE_MAX):
    """Ask the background job to measure the first few of these, and say which.

    Never blocks: `request_analysis` starts a daemon thread and returns. The ids
    it accepted come back as `pending`, and the client polls for them. The list
    is taken in the order the caller sent them — play order — so the track that
    is about to play is the one measured first.
    """
    from ..deezer import analysis as ana
    from ..deezer import ids as dz_ids

    accepted = []
    if not ids:
        return accepted
    provider = getattr(current_app, "deezer", None)
    for ident in ids:
        if len(accepted) >= limit:
            break
        try:
            track_id = dz_ids.track_uuid(ident)
        except Exception:
            continue
        track = Track.get_or_none(Track.id == track_id)
        if track is None or not _may_access_track(track):
            continue
        try:
            if ana.request_analysis(track, provider):
                accepted.append(ident)
        except Exception:
            logger.debug("analysis: could not queue %s", ident, exc_info=True)
    return accepted


@webapi.route("/analysis/<mid>")
@login_required
def track_analysis(mid):
    """The verdict for one track, or ``{"ready": false}``.

    When there is nothing to serve and the server CAN measure, the measurement
    is put on the background queue and the id comes back in ``pending``: the
    client polls, and adopts the genre the moment it exists instead of carrying
    its own guess for the rest of the track. The request itself never waits on
    it — see the module docstring.
    """
    from ..db import GenreTag, TrackTag
    from ..deezer import analysis as ana

    if _valid_id(mid):
        found = _rows_for([str(mid)])
        if found:
            return jsonify({"ready": True, **found[str(mid)]})
        pending = _queue_missing([str(mid)])
        return jsonify({"ready": False, "pending": pending})
    track = Track.get_or_none(Track.id == mid)
    if track is None or not _may_access_track(track):
        return jsonify({"ready": False})
    row = TrackAnalysis.get_or_none(TrackAnalysis.track == track)
    tag = (
        TrackTag.select(TrackTag, GenreTag)
        .join(GenreTag)
        .where(TrackTag.track == track)
        .first()
    )
    tag = tag.tag if tag is not None else None
    if row is not None or tag is not None:
        return jsonify({"ready": True, **ana.payload_for(row, tag=tag)})
    pending = [str(mid)] if ana.request_analysis(track) else []
    return jsonify({"ready": False, "pending": pending})


@webapi.route("/analyses", methods=["POST"])
@login_required
def track_analyses():
    """Verdicts for a whole run of tracks in ONE call."""
    data = request.get_json(silent=True) or {}
    raw = data.get("ids") or []
    if not isinstance(raw, list):
        return jsonify({"error": "ids must be a list"}), 400
    ids = list(dict.fromkeys(str(x) for x in raw if _valid_id(x)))[:ANALYSIS_BATCH_MAX]
    found = _rows_for(ids)
    # Only the tracks the player is about to reach, and only while the server
    # has a way to reach a verdict. `pending` is the client's to-do list.
    pending = _queue_missing(_missing(ids, found))
    return jsonify({"analyses": found, "pending": pending})

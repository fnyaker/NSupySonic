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

The FIRST play is the case none of that covers: the verdict is measured from the
archived file, and the file is being written by that very play. Deezer's own
tempo needs no file, so a Deezer track with no verdict is looked up in the
background and served as a PROVISIONAL verdict — the published bpm alone,
flagged ``provisional`` — until the measurement replaces it (see
``tempo_hints`` in ``supysonic/deezer/analysis.py``).

Anything the server genuinely cannot measure comes back as a plain absence, and
the client falls back to its own live detector — which is exactly what it did
before this existed.

Batched like ``/api/gains`` and for the same reason: the player wants the whole
run it is about to play, in one call, before any of it starts.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

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
# ...and how many PUBLISHED tempos it may have looked up. One small public-API
# request each, on one background worker; the player's window is the current
# track and the six after it.
TEMPO_HINT_MAX = 8
# The admin's parallelism choice lives in the Meta KV table, like the upload
# quota: it is a server-wide cost, not a per-request one.
_WORKERS_META_KEY = "analysis_workers"


def _workers() -> int:
    """The admin's parallelism choice, or 0 meaning "size it from the machine".

    Auto is the default, and that is the whole point: a nine-core VM measuring
    one track at a time was slow for no reason, and nobody should have to be
    told how many cores their server has in order to get the other eight used.
    """
    row = Meta.get_or_none(Meta.key == _WORKERS_META_KEY)
    if row is not None:
        try:
            return max(0, min(ANALYSIS_WORKERS_MAX, int(row.value)))
        except (TypeError, ValueError):
            pass
    return 0


def _set_workers(value: int) -> int:
    value = max(0, min(ANALYSIS_WORKERS_MAX, int(value)))
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
    # WHICH tracks failed and why, not just how many. A counter alone sent the
    # operator to the container logs (or to guessing) every time, which is the
    # whole reason this job was impossible to debug from the app.
    "failures": [],
    "failure_reasons": {},
    "cancel": False,
    "stage": None,
    "mode": None,
    "embed_done": 0,
}


def _job_snapshot(job: dict) -> dict:
    """A copy safe to hand to jsonify while the job thread is still running.

    ``dict(job)`` is shallow, so the failure ledger it returned was the very
    list the worker threads append to — and serialising a list that is being
    appended to is a "changed size during iteration" 500 in the middle of a
    poll. The containers are small; copying them is free.
    """
    out = dict(job)
    out["failures"] = list(job.get("failures") or ())
    out["failure_reasons"] = dict(job.get("failure_reasons") or {})
    return out


def _analysis_job_json() -> dict:
    with _analysis_lock:
        return _job_snapshot(_analysis_job)


#: How the maintenance job gives way to the people using the app.
#: ``night`` is the scheduled window (nobody is expected to be there, and the
#: listening gate stops it the moment somebody is); ``now`` is the button,
#: pressed in the middle of the day, so it takes half of one worker's time.
THROTTLE_MODES = {
    "night": dict(duty=0.9, listen_quiet=45.0, max_load=0.75),
    "now": dict(duty=0.5, listen_quiet=45.0, max_load=0.6),
}
NOW_WORKERS_MAX = 2

#: The Throttle of the job in flight (the studio reads WHY it is paused).
_throttle = None

_SCHEDULE_KEY = "analysis_schedule"
SCHEDULE_DEFAULT = {"enabled": True, "at": "03:00", "hours": 6}


def _run_analysis(app, force, workers, limit, mode="now", deadline=None):
    """The whole maintenance pass, in order of cost: re-decide what a new head
    changes (no audio), measure what is unmeasured or measured by an older
    release, re-extract what the extractor changed, then re-decide once more
    with the new vectors. Each stage is resumable and gated by the Throttle."""
    from ..db import close_connection, open_connection
    from ..deezer import analysis as ana
    from ..deezer import embedding as emb
    from ..deezer.workload import Throttle

    global _throttle

    def cancelled():
        with _analysis_lock:
            if _analysis_job.get("cancel"):
                return True
        return deadline is not None and time.time() >= deadline

    throttle = Throttle(stop=cancelled, **THROTTLE_MODES.get(mode, THROTTLE_MODES["now"]))
    _throttle = throttle

    def set_stage(name):
        with _analysis_lock:
            _analysis_job["stage"] = name

    with app.app_context():
        try:
            open_connection(reuse=True)

            def on_stats(stats):
                # Called under the backfill's own lock, so the ledger is
                # consistent at this instant — copy it here and the job state
                # never aliases a container the workers keep mutating.
                snap = _job_snapshot(stats)
                snap.pop("workers", None)
                with _analysis_lock:
                    _analysis_job.update(snap)

            provider = getattr(app, "deezer", None)
            set_stage("measure")
            stats = ana.backfill(
                provider=provider, force=force, limit=limit, workers=workers,
                on_stats=on_stats, throttle=throttle,
            )
            snap = _job_snapshot(stats)
            snap.pop("workers", None)
            with _analysis_lock:
                _analysis_job.update(snap)
            embedded = 0
            if not cancelled() and not emb.why_unavailable() and not emb.session_error():
                set_stage("embed")
                es = ana.backfill_embeddings(
                    force=False, limit=limit, workers=workers, throttle=throttle,
                    on_stats=lambda st: _analysis_job.update(embed_done=st.get("done", 0)),
                )
                embedded = es.get("done", 0)
            if not cancelled():
                set_stage("decide")
                from . import genre as _wg

                _wg.start_relabel(app)
        except Exception as exc:
            logger.warning("Analysis backfill crashed", exc_info=True)
            with _analysis_lock:
                _analysis_job["error"] = str(exc)
        finally:
            _throttle = None
            with _analysis_lock:
                _analysis_job["running"] = False
                _analysis_job["stage"] = None
                _analysis_job["finished"] = now().isoformat()
            try:
                close_connection()
            except Exception:
                pass


def _effective_workers(requested, mode):
    from ..deezer.analysis import auto_workers

    n = auto_workers(requested)
    return min(n, NOW_WORKERS_MAX) if mode == "now" else n


def start_job(app, force=False, workers=None, mode="now", deadline=None, total=None):
    """Start the maintenance job unless one is already running. True if started.

    The one place a job begins — the button, the boot resume and the nightly
    window all come through here, so they cannot disagree about the state."""
    effective = _effective_workers(_workers() if workers is None else workers, mode)
    with _analysis_lock:
        if _analysis_job["running"]:
            return False
        _analysis_job.update(
            running=True, started=now().isoformat(), finished=None, force=force,
            workers=effective, total=total or 0, scanned=0, done=0, skipped=0,
            failed=0, error=None, failures=[], failure_reasons={}, cancel=False,
            stage="measure", mode=mode, embed_done=0,
        )
    threading.Thread(
        target=_run_analysis, args=(app, force, effective, None, mode, deadline),
        name="analysis-backfill", daemon=True,
    ).start()
    return True


def _library_total():
    return Track.select().where(Track.last_modification > 0).count()


def plan():
    """What is out of date, and at which step — SQL counts, no file read.

    ``current`` is a track fully up to date; the others can overlap (a track
    measured by an old release is usually also due an embedding and a verdict),
    so ``todo`` counts DISTINCT tracks with anything left to do."""
    from ..deezer import embedding as emb
    from ..deezer.analysis import ANALYSIS_VERSION, current_head_id

    total = _library_total()
    rows = TrackAnalysis.select().where(TrackAnalysis.version > 0)
    measured = rows.count()
    head = current_head_id()
    extractor = not emb.why_unavailable()
    stale_measure = TrackAnalysis.select().where(
        TrackAnalysis.version < ANALYSIS_VERSION).count()
    stale_embed = (
        TrackAnalysis.select().where(TrackAnalysis.embed_version < emb.EMBED_VERSION).count()
        if extractor else 0
    )
    stale_decide = TrackAnalysis.select().where(
        (TrackAnalysis.decided_head.is_null()) | (TrackAnalysis.decided_head != head)
    ).count()
    cond = (TrackAnalysis.version < ANALYSIS_VERSION) | (
        (TrackAnalysis.decided_head.is_null()) | (TrackAnalysis.decided_head != head)
    )
    if extractor:
        cond = cond | (TrackAnalysis.embed_version < emb.EMBED_VERSION)
    todo_rows = TrackAnalysis.select().where(cond).count()
    unmeasured = max(0, total - measured)
    return {
        "total": total,
        "unmeasured": unmeasured,
        "stale_measure": stale_measure,
        "stale_embed": stale_embed,
        "stale_decide": stale_decide,
        "todo": unmeasured + todo_rows,
        "current": max(0, total - unmeasured - todo_rows),
        "version": ANALYSIS_VERSION,
        "embed_version": emb.EMBED_VERSION,
        "extractor": extractor,
    }


def schedule_settings():
    row = Meta.get_or_none(Meta.key == _SCHEDULE_KEY)
    out = dict(SCHEDULE_DEFAULT)
    if row is not None:
        try:
            saved = json.loads(row.value)
            if isinstance(saved, dict):
                out.update({k: saved[k] for k in out if k in saved})
        except (TypeError, ValueError):
            pass
    return out


def _clean_schedule(data):
    from ..deezer.scheduler import _parse_at

    at = str(data.get("at", SCHEDULE_DEFAULT["at"]))
    h, m = _parse_at(at, default=(3, 0))
    try:
        hours = max(1, min(23, int(data.get("hours", SCHEDULE_DEFAULT["hours"]))))
    except (TypeError, ValueError):
        hours = SCHEDULE_DEFAULT["hours"]
    return {"enabled": bool(data.get("enabled", True)), "at": f"{h:02d}:{m:02d}", "hours": hours}


def _window(settings, at_time):
    """``(start, end)`` of the window containing ``at_time``, else of the next
    one to start today. A window may run past midnight, so yesterday's is tried
    first."""
    from datetime import timedelta

    h, m = (int(x) for x in settings["at"].split(":"))
    today = at_time.replace(hour=h, minute=m, second=0, microsecond=0)
    span = timedelta(hours=settings["hours"])
    yesterday = today - timedelta(days=1)
    if yesterday <= at_time < yesterday + span:
        return yesterday, yesterday + span
    return today, today + span


def window_due(settings, at_time, last_fired):
    """The deadline (epoch seconds) of a window to run now, or None. A window is
    run once per day; a restart in the middle of one joins it."""
    if not settings.get("enabled"):
        return None
    start, end = _window(settings, at_time)
    if not (start <= at_time < end):
        return None
    if last_fired == start.date().isoformat():
        return None
    return end.timestamp()


def schedule_loop(app):
    """The nightly window: once a day, from ``at`` for ``hours``, run whatever
    is out of date. Polls once a minute so a change of settings applies at once
    and a restart inside the window joins it."""
    import time as _t
    from datetime import datetime

    def loop():
        _t.sleep(RESUME_DELAY)
        last = None
        while True:
            try:
                with app.app_context():
                    from ..db import close_connection, open_connection

                    open_connection(reuse=True)
                    try:
                        settings = schedule_settings()
                        deadline = window_due(settings, datetime.now(), last)
                        if deadline is not None:
                            p = plan()
                            if p["todo"] and start_job(
                                app, mode="night", deadline=deadline, total=p["total"]
                            ):
                                start, _ = _window(settings, datetime.now())
                                last = start.date().isoformat()
                                logger.info("Nightly analysis window: %s tracks to do", p["todo"])
                            elif not p["todo"]:
                                start, _ = _window(settings, datetime.now())
                                last = start.date().isoformat()
                    finally:
                        close_connection()
            except Exception:
                logger.warning("Analysis schedule check failed", exc_info=True)
            _t.sleep(60)

    threading.Thread(target=loop, name="analysis-schedule", daemon=True).start()


#: Let the server finish coming up before a library job takes the disk.
RESUME_DELAY = 45


def resume_if_interrupted(app):
    """Pick a library job back up after a restart that cut it short.

    A run over a real library is hours of work on a thread inside the web
    server, and it does not get to choose when the container is restarted. The
    checkpoint is what makes resuming CHEAP; this is what makes it AUTOMATIC —
    otherwise "analyse everything" silently means "analyse everything, unless
    something interrupts you, in which case wait to be asked again", and the
    operator finds out weeks later that two thirds of the library was never
    measured. It resumes under the same Throttle as everything else.
    """
    from ..deezer.analysis import ANALYSIS_CURSOR_KEY, _checkpoint_read

    def start():
        import time as _t

        _t.sleep(RESUME_DELAY)
        with app.app_context():
            from ..db import close_connection, open_connection

            try:
                open_connection(reuse=True)
                state = _checkpoint_read(ANALYSIS_CURSOR_KEY, force=False)
                forced = _checkpoint_read(ANALYSIS_CURSOR_KEY, force=True)
                if state is None and forced is None:
                    return
                force = state is None
                total = _library_total()
            except Exception:
                logger.debug("Could not read the analysis checkpoint", exc_info=True)
                return
            finally:
                try:
                    close_connection()
                except Exception:
                    pass
        logger.info("Resuming the interrupted analysis backfill")
        start_job(app, force=force, mode="now", total=total)

    threading.Thread(target=start, name="analysis-resume", daemon=True).start()


@webapi.route("/analysis/backfill", methods=["POST"])
@login_required
@admin_required
def analysis_backfill_start():
    """(Re)measure the library — the "Lancer maintenant" button. Gated by the
    Throttle like the nightly run: it pauses while anybody listens."""
    from ..deezer.analysis import ffmpeg_available

    if not ffmpeg_available():
        return jsonify({"error": "ffmpeg n'est pas installé sur le serveur"}), 400
    data = request.get_json(silent=True) or {}
    force = bool(data.get("force"))
    raw = data.get("workers")
    try:
        workers = _workers() if raw is None else int(raw)
    except (TypeError, ValueError):
        workers = _workers()
    workers = _set_workers(workers)
    start_job(current_app._get_current_object(), force=force, workers=workers,
              mode="now", total=_library_total())
    return jsonify({"ok": True, **_analysis_job_json()})


@webapi.route("/analysis/backfill/stop", methods=["POST"])
@login_required
@admin_required
def analysis_backfill_stop():
    """Ask the running job to stop after the track in hand. It resumes where it
    left off (the checkpoint) the next time it runs."""
    with _analysis_lock:
        if _analysis_job["running"]:
            _analysis_job["cancel"] = True
    return jsonify({"ok": True, **_analysis_job_json()})


@webapi.route("/analysis/plan")
@login_required
@admin_required
def analysis_plan():
    """What is out of date and at which step, plus the nightly window."""
    return jsonify({**plan(), "schedule": schedule_settings()})


@webapi.route("/analysis/schedule", methods=["PUT"])
@login_required
@admin_required
def analysis_schedule_set():
    clean = _clean_schedule(request.get_json(silent=True) or {})
    row = Meta.get_or_none(Meta.key == _SCHEDULE_KEY)
    value = json.dumps(clean)
    if row is None:
        Meta.create(key=_SCHEDULE_KEY, value=value)
    else:
        row.value = value
        row.save()
    return jsonify({"ok": True, "schedule": clean})


@webapi.route("/analysis/backfill")
@login_required
@admin_required
def analysis_backfill_status():
    from ..deezer.analysis import auto_workers

    # Two different numbers, two different names. `workers` is what the RUNNING
    # job uses; `workers_setting` is what the admin chose, where 0 means "size
    # it from the machine" and `workers_auto` says what that comes to here. They
    # used to share one key, so the job's value silently shadowed the setting
    # and the studio showed a number nobody had picked.
    return jsonify(
        {
            **_analysis_job_json(),
            "paused": _throttle.reason if _throttle is not None else None,
            "workers_setting": _workers(),
            "workers_auto": auto_workers(0),
        }
    )


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


def _tempo_hints(ids):
    """``({id: provisional payload}, waiting)`` for Deezer tracks with no verdict.

    Only for rows the caller may read (an upload has no published tempo, and
    this is not a way to make the server fetch arbitrary ids), and only a
    handful per request. Never waits: what is not in hand yet comes back in
    ``waiting``, for the client to ask again.
    """
    from ..deezer import analysis as ana
    from ..deezer import ids as dz_ids

    provider = getattr(current_app, "deezer", None)
    if provider is None or not ids:
        return {}, []
    keys = {}
    for ident in ids[:TEMPO_HINT_MAX]:
        try:
            keys[dz_ids.track_uuid(ident)] = ident
        except Exception:
            continue
    if not keys:
        return {}, []
    allowed = [
        keys[t.id]
        for t in Track.select().where(Track.id.in_(list(keys)))
        if t.deezer_id and _may_access_track(t)
    ]
    # Play order, as the caller sent them: the track about to play first.
    allowed.sort(key=ids.index)
    known, waiting = ana.tempo_hints(allowed, provider)
    return {i: ana.provisional_payload(bpm) for i, bpm in known.items()}, waiting


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
        hints, waiting = _tempo_hints([str(mid)])
        if hints:
            return jsonify({"ready": True, **hints[str(mid)], "pending": pending})
        return jsonify({"ready": False, "pending": pending + [i for i in waiting if i not in pending]})
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


@webapi.route("/analysis/<mid>/live", methods=["POST"])
@login_required
def track_construction(mid):
    """How a track is BUILT, as the player's analyser heard it while it played
    (webapp/src/lib/genre/construction.js): kept beside the audio and read by
    the genre head next to the embedding (deezer/construction.py).

    Only for a track the caller may read and that is archived (the summary
    lives beside the file). Every value is clamped and merged into a running
    mean of capped weight, so a post can refine a summary, never take it over.
    """
    from ..deezer import analysis as ana
    from ..deezer import construction as cx
    from ..deezer import genre as gen
    from ..deezer import ids as dz_ids

    try:
        if _valid_id(mid):
            track = Track.get_or_none(Track.id == dz_ids.track_uuid(str(mid)))
        else:
            track = Track.get_or_none(Track.id == uuid.UUID(str(mid)))
    except (ValueError, AttributeError, TypeError):
        track = None
    if track is None or not _may_access_track(track):
        return jsonify({"error": "unknown track"}), 404
    try:
        n, features = cx.clean(request.get_json(silent=True))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not track.path or not os.path.isfile(track.path):
        # Nothing on disk to keep it beside: a summary for a stream that was
        # never archived is simply not kept.
        return jsonify({"stored": False}), 202
    doc = cx.merge_and_save(track, n, features)
    if doc is None:
        return jsonify({"stored": False}), 202
    # A head that reads construction decides this track again, now.
    if gen.reads_extras():
        row = TrackAnalysis.get_or_none(TrackAnalysis.track == track)
        if row is not None:
            ana.redecide(row)
    return jsonify({"stored": True, "n": doc["n"]})


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
    missing = _missing(ids, found)
    # Only the tracks the player is about to reach, and only while the server
    # has a way to reach a verdict. `pending` is the client's to-do list.
    pending = _queue_missing(missing)
    # A track nobody has measured still has a tempo, if Deezer published one:
    # served now when it is in hand, looked up for the next poll when it is not.
    hints, waiting = _tempo_hints(missing)
    found.update(hints)
    pending += [i for i in waiting if i not in pending]
    # The verdicts' generation: when a new head has been re-applied to the
    # library, the player drops what it kept on the device (lib/analysis.js).
    return jsonify({"analyses": found, "pending": pending, "gen": ana_gen()})


def ana_gen():
    from ..deezer import analysis as ana

    try:
        return ana.verdict_generation()
    except Exception:
        return 0

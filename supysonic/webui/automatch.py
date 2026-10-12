"""The auto-match, run: when a track turns unavailable, and on the admin's button.

``deezer/automatch.decide`` listens and returns a verdict; this applies it —
with the ADMIN's scope (every playlist, everyone's favourites, mirrored to the
Deezer account), since the account owner is who switched it on — and reports.

Two ways in, one track at a time between them (``_busy``):
- the EVENT: ``library.mark_unavailable`` calls ``notify`` the first time a
  Deezer track is found dead, and a single worker thread takes it from a
  bounded queue. Event-driven like the rest of the archive: never a timer.
- the JOB (``POST /api/automatch/run``, admin): every unavailable Deezer track,
  with progress, for what was already dead before the switch existed or
  failed to match then.

Switch: ``Meta dz.automatch``, ON by default (the user's choice), and nothing
runs without numpy + ffmpeg (``audiomatch.available``). A transport failure
stops a job rather than turning every remaining track into a failure: Deezer
being unreachable is not an answer about any of them.
"""

from __future__ import annotations

import collections
import logging
import os
import queue
import threading
import uuid as uuidlib

from flask import current_app, has_app_context, jsonify, request

from ..db import Meta, Track, now
from ..deezer import audiomatch
from ..deezer import automatch as am
from . import admin_required, login_required, webapi

logger = logging.getLogger(__name__)

ENABLED_KEY = "dz.automatch"
QUEUE_MAX = 500
RECENT_MAX = 50
FAILURE_SAMPLE_MAX = 40

_state_lock = threading.Lock()
_busy = threading.Lock()                 # one track at a time, job or event
_queue: "queue.Queue[tuple]" = queue.Queue(QUEUE_MAX)
_queued: set = set()
_worker = None
_job: dict | None = None                 # the running manual job
_last: dict | None = None                # the last finished one
_recent: collections.deque = collections.deque(maxlen=RECENT_MAX)


def available() -> bool:
    return audiomatch.available()


def enabled() -> bool:
    if not available():
        return False
    row = Meta.get_or_none(Meta.key == ENABLED_KEY)
    return row is None or row.value != "0"


def _youtube_enabled() -> bool:
    try:
        from .youtube import enabled as yt_enabled

        return yt_enabled()
    except Exception:
        return False


# -- one track -----------------------------------------------------------------------

def _target_row(app, provider, c: am.Candidate):
    from ..deezer import archive

    if c.source == "local":
        return Track.get_or_none(Track.id == uuidlib.UUID(c.id))
    if c.source == "deezer":
        return archive.find_local_track(c.id) or archive.import_track(provider, c.id)
    from ..deezer import youtube as yt

    archive_dir = provider.archive_dir
    row = yt.find_track(c.id) or yt.upsert_track(c.hit, archive_dir)
    try:
        # It was downloaded to be heard: archived from that file, no second fetch.
        row = yt.ensure_archived(row, archive_dir, c.hit, produced=c.path)
    except Exception:
        logger.info("Archiving the YouTube stand-in %s failed", c.id, exc_info=True)
    finally:
        if c.path and os.path.exists(c.path):
            os.remove(c.path)
    return row


def process(app, track_id) -> dict:
    """Listen for, and apply, a stand-in for one track. Returns the outcome."""
    from .availability import replace_everywhere

    track = Track.get_or_none(Track.id == track_id)
    if track is None or track.unavailable is None:
        return {"status": "skipped", "reason": "no longer unavailable"}
    if track.path and os.path.isfile(track.path):
        return {"status": "skipped", "reason": "archived: it plays"}
    provider = getattr(app, "deezer", None)
    if provider is None:
        return {"status": "error", "reason": "the Deezer proxy is off"}
    dead = {
        str(t.deezer_id)
        for t in Track.select(Track.deezer_id).where(
            Track.unavailable.is_null(False) & Track.deezer_id.is_null(False)
        )
    }
    v = am.decide(
        provider, track, provider.archive_dir,
        youtube_enabled=_youtube_enabled(),
        store=getattr(app, "cache", None),
        dead=frozenset(dead),
    )
    out = {
        "status": v.status,
        "reason": v.reason,
        "score": round(v.score, 4),
        "tried": [[label, result] for label, result in v.tried],
        "track": {"id": str(track.deezer_id or track.id), "title": track.title,
                  "artist": track.artist.name if track.artist else ""},
    }
    if v.status != "match":
        return out
    c = v.best
    target = _target_row(app, provider, c)
    if target is None or target.id == track.id:
        out.update(status="error", reason="the stand-in's row could not be made")
        return out
    playlists, favorites = replace_everywhere(app, track, target, None, True)
    out["by"] = {"id": str(target.deezer_id or target.id), "title": c.title,
                 "artist": c.artist, "album": c.album, "source": c.source}
    out["playlists"], out["favorites"] = playlists, favorites
    with _state_lock:
        _recent.appendleft({**out, "at": now().isoformat()})
    logger.info(
        "Auto-matched %s (%s) with %s %s at %.2f %%",
        track.deezer_id, track.title, c.source, c.id, v.score * 100,
    )
    return out


# -- the event -------------------------------------------------------------------------

def notify(track) -> None:
    """``library.mark_unavailable`` hook: a Deezer track was just found dead."""
    if not has_app_context() or not getattr(track, "deezer_id", None):
        return
    try:
        if not enabled():
            return
    except Exception:
        return
    app = current_app._get_current_object()
    with _state_lock:
        if track.id in _queued:
            return
        try:
            _queue.put_nowait((app, track.id))
        except queue.Full:
            return  # the admin's job is the catch-up
        _queued.add(track.id)
    if not app.testing:  # under tests, drain() is called explicitly
        _ensure_worker()


def _ensure_worker():
    global _worker
    with _state_lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_work, name="automatch", daemon=True)
        _worker.start()


def _run_one(app, track_id) -> dict:
    from ..db import close_connection, open_connection

    with app.app_context():
        open_connection(reuse=True)
        try:
            with _busy:
                return process(app, track_id)
        finally:
            try:
                close_connection()
            except Exception:
                pass


def _work():
    from ..deezer import workload

    workload.renice()
    while True:
        app, track_id = _queue.get()
        try:
            _run_one(app, track_id)
        except Exception:
            logger.warning("Auto-match of %s failed", track_id, exc_info=True)
        finally:
            with _state_lock:
                _queued.discard(track_id)


def drain(app) -> list:
    """Process the queued events here and now (tests; no thread involved)."""
    outs = []
    while True:
        try:
            _, track_id = _queue.get_nowait()
        except queue.Empty:
            return outs
        try:
            outs.append(_run_one(app, track_id))
        finally:
            with _state_lock:
                _queued.discard(track_id)


# -- the job ---------------------------------------------------------------------------

def _snapshot(job):
    if job is None:
        return None
    return {k: (list(v) if isinstance(v, list) else dict(v) if isinstance(v, dict) else v)
            for k, v in job.items()}


def _run_job(app, job):
    from ..db import close_connection, open_connection
    from deezerpy.errors import is_transport_failure
    from ..deezer import workload

    global _job, _last
    workload.renice()
    try:
        with app.app_context():
            open_connection(reuse=True)
            ids = [
                t.id for t in Track.select(Track.id)
                .where(Track.unavailable.is_null(False) & Track.deezer_id.is_null(False))
                .order_by(Track.unavailable.desc())
            ]
            close_connection()
        with _state_lock:
            job["total"] = len(ids)
        for tid in ids:
            if job.get("cancel"):
                break
            try:
                out = _run_one(app, tid)
            except Exception as exc:
                if is_transport_failure(exc):
                    with _state_lock:
                        job["stopped"] = "Deezer is unreachable: stopped, nothing was decided"
                    break
                logger.warning("Auto-match of %s failed", tid, exc_info=True)
                out = {"status": "error", "reason": f"{type(exc).__name__}: {exc}"[:200]}
            with _state_lock:
                job["done"] += 1
                st = out.get("status", "error")
                job["counts"][st] = job["counts"].get(st, 0) + 1
                if st == "match":
                    job["replaced"].append(out)
                elif st in ("error", "no_match", "no_reference") and len(job["failures"]) < FAILURE_SAMPLE_MAX:
                    job["failures"].append(out)
                if out.get("reason"):
                    key = out["reason"].split(" (")[0][:80] if st != "no_match" else "below 99 %"
                    job["reasons"][key] = job["reasons"].get(key, 0) + 1
    finally:
        with _state_lock:
            job["running"] = False
            job["finished"] = now().isoformat()
            _last, _job = job, None


@webapi.route("/automatch")
@login_required
@admin_required
def automatch_status():
    with _state_lock:
        job, last, recent = _snapshot(_job), _snapshot(_last), list(_recent)
    row = Meta.get_or_none(Meta.key == ENABLED_KEY)
    return jsonify({
        "available": available(),
        "enabled": enabled(),
        "switched_off": row is not None and row.value == "0",
        "threshold": audiomatch.THRESHOLD,
        "youtube": _youtube_enabled(),
        "job": job,
        "last": last,
        "recent": recent,
    })


@webapi.route("/automatch/settings", methods=["PUT"])
@login_required
@admin_required
def automatch_settings():
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get("enabled"), bool):
        return jsonify({"error": "enabled must be a boolean"}), 400
    value = "1" if data["enabled"] else "0"
    row = Meta.get_or_none(Meta.key == ENABLED_KEY)
    if row is None:
        Meta.create(key=ENABLED_KEY, value=value)
    elif row.value != value:
        row.value = value
        row.save()
    return automatch_status()


@webapi.route("/automatch/run", methods=["POST"])
@login_required
@admin_required
def automatch_run():
    global _job
    if not available():
        return jsonify({"error": "numpy and ffmpeg are needed to compare audio"}), 503
    if getattr(current_app, "deezer", None) is None:
        return jsonify({"error": "the Deezer proxy is off"}), 503
    with _state_lock:
        if _job is not None:
            return jsonify({"error": "already running", "job": _snapshot(_job)}), 409
        _job = {
            "id": uuidlib.uuid4().hex, "running": True, "started": now().isoformat(),
            "total": None, "done": 0, "counts": {}, "reasons": {},
            "replaced": [], "failures": [], "stopped": None,
        }
        job = _job
    app = current_app._get_current_object()
    if app.testing and request.args.get("sync") == "1":
        _run_job(app, job)
    else:
        threading.Thread(target=_run_job, args=(app, job), name="automatch-job",
                         daemon=True).start()
    return jsonify({"ok": True, "job": _snapshot(job)})


@webapi.route("/automatch/cancel", methods=["POST"])
@login_required
@admin_required
def automatch_cancel():
    with _state_lock:
        if _job is not None:
            _job["cancel"] = True
    return automatch_status()


def install():
    """Hook the event into the DB layer (called when the blueprint loads)."""
    from ..deezer import library

    if notify not in library.UNAVAILABLE_HOOKS:
        library.UNAVAILABLE_HOOKS.append(notify)


install()

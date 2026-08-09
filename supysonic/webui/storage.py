# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Making the archive complete, and telling the admin what it costs.

Two jobs live here.

**The archive is the point.** Everything in your favorites, your playlists and
your subscribed podcasts should exist as a file on the server, so that the day
Deezer removes it — or the day Deezer is simply down — nothing of yours is lost.
Archiving is event-driven (see ``deezer/backfill.py``): playing, starring,
favoriting or subscribing queues the audio right then. This is the button that
sweeps up whatever those events could not see — and the one place that reports
what the archive costs.

**Nothing here ever deletes archived audio.** The backfill only adds. The cache
flush empties the *derived* caches (transcodes, cover thumbnails) — files that
are regenerated on demand — and cannot touch ``archive_dir`` at all.
"""

from __future__ import annotations

import logging
import os
import os.path
import shutil
import threading

from flask import current_app, jsonify, request

from ..db import Track
from ..deezer import backfill
from . import admin_required, login_required, webapi

logger = logging.getLogger(__name__)


# -- the backfill job -------------------------------------------------------
# One at a time, in a worker thread, with a progress counter the UI polls. It is
# deliberately sequential: this competes with real playback for the same Deezer
# session and the same bandwidth, and a burst of parallel FLAC downloads would
# make the app worse for as long as it runs.

_job_lock = threading.Lock()
_job = {
    "running": False,
    "scope": None,
    "done": 0,
    "total": 0,
    "archived": 0,
    "failed": 0,
    "unavailable": 0,
    "error": None,
}


def _snapshot():
    with _job_lock:
        return dict(_job)


@webapi.route("/archive/status")
@login_required
@admin_required
def archive_status():
    return jsonify(_snapshot())


@webapi.route("/archive/backfill", methods=["POST"])
@login_required
@admin_required
def archive_backfill():
    """Archive everything of mine that isn't on disk yet.

    Never deletes, never re-downloads what is already archived: a re-run is
    always safe, and on a complete archive it costs one pass over the database.

    Admin-only: this makes the server pull gigabytes onto a shared volume, so it
    belongs to the account that owns the library, not to every guest.
    """
    data = request.get_json(silent=True) or {}
    scope = str(data.get("scope") or "all")
    if scope not in backfill.SCOPES:
        return jsonify({"error": "invalid scope"}), 400

    provider = getattr(current_app, "deezer", None)
    if provider is None:
        return jsonify({"error": "Deezer proxy disabled"}), 503

    if backfill.is_sweeping():
        # The nightly sync is already sweeping. Say so now instead of starting a
        # thread whose only job would be to find the lock taken.
        return jsonify({"ok": True, "running": True, "busy": True, **_snapshot()})

    with _job_lock:
        if _job["running"]:
            return jsonify({"ok": True, "running": True, **_job})
        _job.update(
            running=True, scope=scope, done=0, total=0, archived=0, failed=0,
            unavailable=0, error=None,
        )

    app = current_app._get_current_object()
    user = request.webuser
    threading.Thread(
        target=_run_backfill,
        args=(app, scope, user.id),
        name="archive-backfill",
        daemon=True,
    ).start()
    return jsonify({"ok": True, "running": True})


def _run_backfill(app, scope, user_id):
    from ..db import User, close_connection, open_connection

    try:
        with app.app_context():
            open_connection(reuse=True)
            user = User.get_or_none(User.id == user_id)
            if user is None:
                with _job_lock:
                    _job["error"] = "unknown user"
                return
            # Through sweep_for, not collect+run directly: that is what holds the
            # single-sweep lock, so pressing the button while the nightly sync is
            # already sweeping reports "busy" instead of running a second pass
            # over the same missing tracks.
            stats = backfill.sweep_for(
                app.deezer,
                user,
                scope,
                on_event=_bump,
                on_total=lambda n: _set("total", n),
            )
            if stats.get("skipped"):
                with _job_lock:
                    _job["error"] = "busy"
            logger.info("Archive backfill finished: %s", stats)
    except Exception as exc:
        logger.warning("Archive backfill crashed", exc_info=True)
        with _job_lock:
            _job["error"] = str(exc)
    finally:
        with _job_lock:
            _job["running"] = False
        try:
            close_connection()
        except Exception:
            pass


def _bump(field, by=1):
    with _job_lock:
        _job[field] = _job.get(field, 0) + by


def _set(field, value):
    with _job_lock:
        _job[field] = value


# -- storage ----------------------------------------------------------------


def _dir_size(path: str) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return total


@webapi.route("/storage")
@login_required
@admin_required
def storage():
    """What the archive is costing, and how much room is left for it.

    Walking the archive tree is the only honest way to size it (files land there
    from several paths), so it is done once per request — admin-only, and not on
    any hot path.
    """
    archive_dir = current_app.config["DEEZER"].get("archive_dir")
    out = {
        "archive_dir": archive_dir,
        "archive_bytes": 0,
        "disk_total": 0,
        "disk_free": 0,
        "cache_bytes": 0,
        "transcode_bytes": 0,
        "cache_limit": 0,
        "transcode_limit": 0,
        "tracks_total": 0,
        "tracks_archived": 0,
    }
    if archive_dir and os.path.isdir(archive_dir):
        try:
            usage = shutil.disk_usage(archive_dir)
            out["disk_total"] = usage.total
            out["disk_free"] = usage.free
        except OSError:
            pass
        out["archive_bytes"] = _dir_size(archive_dir)

    cache = getattr(current_app, "cache", None)
    transcode = getattr(current_app, "transcode_cache", None)
    if cache is not None:
        out["cache_bytes"] = cache.size
        out["cache_limit"] = cache.max_size
    if transcode is not None:
        out["transcode_bytes"] = transcode.size
        out["transcode_limit"] = transcode.max_size

    out["tracks_total"] = Track.select().where(Track.deezer_id.is_null(False)).count()
    # NOTE the parentheses. Python binds `&` TIGHTER than `>`, so the obvious
    # spelling builds `(deezer_id IS NOT NULL AND last_modification) > 0` —
    # which SQLite happily evaluates and Postgres rejects outright ("argument of
    # AND must be type boolean"). That is a 500 that only ever shows up in
    # production. `last_modification` is 0 until _finalize_archive stamps it, so
    # this counts what is actually on disk without a stat() per row.
    out["tracks_archived"] = (
        Track.select()
        .where(Track.deezer_id.is_null(False) & (Track.last_modification > 0))
        .count()
    )
    return jsonify(out)


def _empty(cache):
    """Actually empty a Cache, protected entries included.

    ``Cache.clear()`` politely skips anything written in the last few minutes
    (its eviction protection, which exists so a file being streamed right now
    isn't pulled from under the reader). For a button whose entire promise is
    "free this space", that means pressing it right after listening to something
    does nothing visible. So each entry is expired first, then deleted — and a
    file still open by a request simply fails its own delete and stays, which is
    the one case where the protection was right.
    """
    for key in list(getattr(cache, "_files", {}).keys()):
        try:
            entry = cache._files.get(key)
            if entry is not None:
                cache._files[key] = entry.__class__(entry.size, 0)
            cache.delete(key)
        except Exception:
            continue  # in use, or already gone: leave it alone


# -- archive rules ----------------------------------------------------------


@webapi.route("/archive/rules")
@login_required
@admin_required
def archive_rules():
    """The rules in force, plus the vocabulary the UI needs to render them."""
    from ..deezer import rules

    return jsonify(
        {
            "rules": rules.load(current_app._get_current_object()),
            "defaults": rules.DEFAULTS,
            "events": list(rules.EVENTS),
            "artist_scopes": list(rules.ARTIST_SCOPES),
            "cleanup_orders": list(rules.CLEANUP_ORDERS),
            # The master switch lives in the config file, not in these rules;
            # the UI greys everything out when it is off rather than pretending
            # the per-event switches still mean something.
            "archive_library": bool(
                current_app.config["DEEZER"].get("archive_library", True)
            ),
        }
    )


@webapi.route("/archive/rules", methods=["POST"])
@login_required
@admin_required
def set_archive_rules():
    from ..deezer import rules

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "invalid payload"}), 400
    written = rules.save(data)
    logger.info("Archive rules updated by %s: %s", request.webuser.name, written)
    return jsonify({"ok": True, "rules": rules.load(current_app._get_current_object())})


# -- cleanup ----------------------------------------------------------------
# The only thing in this project that deletes archived audio. Admin-only, off
# unless configured, and previewable before it runs.


@webapi.route("/archive/cleanup/preview")
@login_required
@admin_required
def cleanup_preview():
    from ..deezer import cleanup

    return jsonify(cleanup.preview(current_app._get_current_object()))


@webapi.route("/archive/cleanup", methods=["POST"])
@login_required
@admin_required
def cleanup_run():
    """Free space now, under the configured rules.

    Refuses when the rules are off — this is not a "delete my archive" button,
    it is the manual trigger for a policy the admin has already written down.
    """
    from ..deezer import cleanup

    app = current_app._get_current_object()
    stats = cleanup.run(app, force=True)
    if stats.get("skipped"):
        return jsonify({"ok": False, "error": "cleanup disabled or already running", **stats}), 409
    logger.info(
        "Archive cleanup run by %s: %d file(s), %d bytes",
        request.webuser.name,
        stats["deleted"],
        stats["freed"],
    )
    return jsonify({"ok": True, **stats})


@webapi.route("/cache/flush", methods=["POST"])
@login_required
@admin_required
def flush_cache():
    """Empty the DERIVED caches: transcodes and proxied cover art.

    These are regenerated on demand, so throwing them away costs nothing but the
    CPU to rebuild them. The archive is not a cache and is never touched here —
    there is no code path in this file that can delete an archived file.
    """
    freed = 0
    for name in ("transcode_cache", "cache"):
        c = getattr(current_app, name, None)
        if c is None:
            continue
        try:
            before = c.size
            _empty(c)
            freed += max(0, before - c.size)
        except Exception:
            logger.warning("Could not flush %s", name, exc_info=True)
    logger.info("Caches flushed by %s (%d bytes)", request.webuser.name, freed)
    return jsonify({"ok": True, "freed": freed})

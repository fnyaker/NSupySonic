# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Automatic Deezer sync, run from a background thread in the web app.

Out of the box (Deezer enabled + a ``sync_user``) it syncs **on startup** and
then **daily**, so playlists, favorites and the smart-tracklist playlists
(Nouveautés, Découverte…) stay fresh in Subsonic with zero manual steps.

Config (`[deezer]`):
- ``sync_interval`` — minutes between syncs (takes precedence if > 0).
- ``sync_at`` — daily time ``HH:MM`` (used when no interval). Defaults to 04:00.
- ``sync_on_start`` — run once shortly after boot (default: yes).

With a single web worker this runs once; keep one worker (the default image
does) for multi-worker setups.
"""

import logging
import threading
import time
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

_BOOT_DELAY = 20  # let the web server come up before the first sync

# While Deezer is unreachable a sync has nothing to do but fail on every single
# entity, so it is postponed rather than run. These bound the postponement: try
# again every _OUTAGE_RETRY seconds, and give up after _OUTAGE_MAX_WAIT (the
# next scheduled run takes over — the point is to catch a short outage across
# the sync window, not to spin all day).
_OUTAGE_RETRY = 300
_OUTAGE_MAX_WAIT = 3600

# At most one sync at a time, whether triggered by the scheduler or the manual
# /api/sync endpoint — two DeezerImporter.sync() runs in parallel duplicate work
# and race on the same DB rows. The web layer reads this to report status and to
# avoid launching a redundant manual run.
_sync_lock = threading.Lock()


def is_syncing() -> bool:
    return _sync_lock.locked()


def _seconds_until(hour: int, minute: int) -> float:
    now = datetime.now()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def _parse_at(at, default=(4, 0)):
    try:
        hour, minute = (int(x) for x in str(at).split(":", 1))
        if 0 <= hour < 24 and 0 <= minute < 60:
            return hour, minute
    except (ValueError, AttributeError):
        pass
    if at:
        logger.warning("Invalid [deezer] sync_at=%r (expected HH:MM); using default", at)
    return default


def maybe_start(app):
    """Start the auto-sync thread when Deezer is configured. Returns it or None."""
    cfg = app.config["DEEZER"]
    if getattr(app, "deezer", None) is None or not cfg.get("sync_user"):
        return None

    try:
        interval = int(cfg.get("sync_interval") or 0)
    except (TypeError, ValueError):
        interval = 0

    on_start = cfg.get("sync_on_start", True)
    if interval > 0:
        schedule = ("interval", interval)
        logger.info("Deezer auto-sync every %d min", interval)
    else:
        schedule = ("daily", _parse_at(cfg.get("sync_at")))
        logger.info("Deezer auto-sync daily at %02d:%02d", *schedule[1])

    t = threading.Thread(
        target=_loop, args=(app, schedule, on_start), name="deezer-sync", daemon=True
    )
    t.start()
    return t


def _reachable(app) -> bool:
    """Is Deezer answering right now? (cached health check, never raises)"""
    provider = getattr(app, "deezer", None)
    if provider is None:
        return False
    try:
        return bool(provider.check_login().get("ok"))
    except Exception:
        return False


def _run_sync(app, scan_local=True) -> bool:
    """Run one sync. Returns False when it was postponed (Deezer unreachable).

    The local scan is NOT postponed: importing files the user dropped into the
    archive has nothing to do with Deezer, and is exactly the kind of thing that
    must keep working while Deezer is down.
    """
    from ..db import close_connection, open_connection
    from .importer import DeezerImporter

    # Skip if a sync (scheduled or manual) is already in flight — never run two.
    if not _sync_lock.acquire(blocking=False):
        logger.info("Deezer sync already running; skipping this trigger")
        return True

    cfg = app.config["DEEZER"]
    try:
        open_connection(reuse=True)
        # Pick up any user-dropped local files first (independent of Deezer being
        # reachable), then run the Deezer sync.
        if scan_local and cfg.get("scan_local", True) and cfg.get("archive_dir"):
            try:
                from . import local

                out = local.scan_local(cfg["archive_dir"])
                if out["added"] or out["removed"]:
                    logger.info("Local scan: %s", out)
            except Exception as exc:
                logger.warning("Local scan failed: %s", exc)
        if not _reachable(app):
            # Every call would fail against a dead host: a full sync would just
            # be a few thousand pointless failures in the log, and would leave
            # the real sync unrun. Postpone it instead (see _run_when_reachable).
            logger.info("Deezer is unreachable; postponing the sync")
            return False
        importer = DeezerImporter(app.deezer, cfg["sync_user"])
        out = importer.sync(cfg)
        logger.info("Deezer sync done: %s", out)
        # Then make the archive match what the sync just imported. A sync that
        # only writes database rows leaves your favorites, playlists and
        # podcasts hostage to Deezer until you happen to press play on them —
        # which may be after Deezer has removed them. Adds only; never deletes.
        if cfg.get("archive_library", True):
            try:
                from ..db import User
                from . import backfill

                user = User.get_or_none(User.name == cfg["sync_user"])
                if user is not None:
                    stats = backfill.sweep_for(app.deezer, user)
                    if stats.get("total"):
                        logger.info("Archive sweep: %s", stats)
            except Exception as exc:
                logger.warning("Archive sweep failed: %s", exc)
    except Exception as exc:
        logger.warning("Deezer sync failed: %s", exc)
    finally:
        try:
            close_connection()
        except Exception:
            pass
        _sync_lock.release()
    return True


def _run_when_reachable(app) -> None:
    """Run a sync, retrying at intervals while Deezer is unreachable."""
    if _run_sync(app):
        return
    waited = 0
    while waited < _OUTAGE_MAX_WAIT:
        time.sleep(_OUTAGE_RETRY)
        waited += _OUTAGE_RETRY
        # The local scan already ran on the first attempt; only Deezer is pending.
        if _run_sync(app, scan_local=False):
            return
    logger.info("Deezer still unreachable; leaving this sync to the next run")


def _loop(app, schedule, on_start):
    kind, value = schedule

    if on_start:
        time.sleep(_BOOT_DELAY)
        _run_when_reachable(app)

    while True:
        if kind == "interval":
            time.sleep(value * 60)
        else:
            time.sleep(_seconds_until(*value))
        _run_when_reachable(app)
        if kind == "daily":
            time.sleep(60)  # step past the trigger minute

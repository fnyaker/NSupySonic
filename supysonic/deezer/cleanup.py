# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Free space in the archive when the disk runs out — and nothing else.

This is the ONLY code in the project that deletes archived audio, so it is
written to be hard to fire by accident:

* it is **off by default** and does nothing at all until an admin turns it on
  and sets a free-space floor;
* it only ever considers audio we can **fetch again from Deezer** (a row with a
  ``deezer_id``). A file someone uploaded exists nowhere else — deleting it
  would destroy the only copy, so uploads are never candidates, whatever the
  settings say;
* what "yours" means is configurable, but favourites, playlist tracks and
  podcast episodes are protected by default;
* a track played recently is never a candidate, regardless of everything above;
* it stops the moment the free-space target is met — it frees what is needed,
  not everything it is allowed to touch.

The Track row survives the delete: the title, the album, the position in your
playlists and the Deezer id all stay, so the track keeps working — the next play
simply archives it again. Only the bytes go.
"""

from __future__ import annotations

import logging
import os
import os.path
import shutil
import threading
from datetime import timedelta

from ..db import PlaylistTrack, StarredTrack, Track, now
from . import rules

logger = logging.getLogger(__name__)

GB = 1024**3

# One cleanup at a time, and never one running under another's feet.
_lock = threading.Lock()


def is_running() -> bool:
    return _lock.locked()


def free_bytes(archive_dir: str) -> int:
    try:
        return shutil.disk_usage(archive_dir).free
    except OSError:
        return -1


def deficit(app, settings=None) -> int:
    """How many bytes short of the configured floor we are (0 = fine).

    Cheap enough to call after every archived file: one statvfs.
    """
    settings = settings or rules.load(app)
    if not settings.get("clean_on"):
        return 0
    floor_gb = float(settings.get("clean_min_free_gb") or 0)
    if floor_gb <= 0:
        return 0
    archive_dir = _archive_dir(app)
    if not archive_dir:
        return 0
    free = free_bytes(archive_dir)
    if free < 0:
        return 0
    want = int(floor_gb * GB)
    return max(0, want - free)


def _archive_dir(app):
    try:
        path = app.config["DEEZER"].get("archive_dir")
    except Exception:
        return None
    return path if path and os.path.isdir(path) else None


def _protected_ids(settings) -> set:
    """Track ids the settings say must never be touched.

    Done as two id queries rather than joins on the candidate query: the sets
    are small (what you own), the candidate table is not, and this keeps the
    protection legible — the reason a track is spared is the reason a human
    would give.
    """
    keep = set()
    if settings.get("clean_keep_fav", True):
        keep.update(r.starred_id for r in StarredTrack.select(StarredTrack.starred))
    if settings.get("clean_keep_playlist", True):
        keep.update(r.track_id for r in PlaylistTrack.select(PlaylistTrack.track))
    return keep


def candidates(app, settings=None) -> list:
    """Deletable archived tracks, best-to-delete first.

    "Deletable" is: re-fetchable from Deezer, actually on disk, not protected,
    and not played within the staleness window. Ordering is the admin's
    priority setting.
    """
    settings = settings or rules.load(app)
    stale_days = int(settings.get("clean_stale_days") or 0)
    cutoff = now() - timedelta(days=stale_days)

    # deezer_id NOT NULL is the load-bearing condition: it is what makes the
    # audio re-fetchable. Uploads (NULL) can never match, by construction.
    query = Track.select().where(
        Track.deezer_id.is_null(False) & (Track.last_modification > 0)
    )
    # Never touch something played recently. `last_play` NULL means "never
    # played here", which is stale by definition — those are the discography
    # tracks that nobody has listened to, exactly what this is for.
    query = query.where(Track.last_play.is_null(True) | (Track.last_play < cutoff))

    order = settings.get("clean_order") or "oldest_play"
    if order == "least_played":
        query = query.order_by(Track.play_count.asc(), Track.last_play.asc())
    elif order == "oldest":
        query = query.order_by(Track.created.asc())
    elif order == "largest":
        pass  # size isn't in the DB; sorted below, after stat()
    else:  # oldest_play — a plain LRU
        query = query.order_by(Track.last_play.asc(), Track.play_count.asc())

    keep = _protected_ids(settings)
    out = []
    for track in query:
        if track.id in keep:
            continue
        try:
            size = os.path.getsize(track.path)
        except OSError:
            continue  # already gone: nothing to free
        out.append((track, size))

    out.extend(_episode_candidates(settings, cutoff))
    if order == "largest":
        out.sort(key=lambda pair: pair[1], reverse=True)
    return out


def _episode_candidates(settings, cutoff) -> list:
    """Podcast episodes, when the admin has unprotected them.

    An episode of a show Deezer has dropped (``channel.gone``) is never a
    candidate: that audio is the only copy left, which is the whole reason the
    channel became a local podcast. Staleness uses the publish date — an episode
    has no play counter, and one nobody has bookmarked in months is exactly what
    this is meant to reclaim.
    """
    if settings.get("clean_keep_podcast", True):
        return []
    from ..db import PodcastChannel, PodcastEpisode, PodcastProgress

    listened = {
        p.episode_id
        for p in PodcastProgress.select(PodcastProgress.episode).where(
            PodcastProgress.updated > cutoff
        )
    }
    out = []
    query = (
        PodcastEpisode.select(PodcastEpisode, PodcastChannel)
        .join(PodcastChannel)
        .where(PodcastChannel.gone.is_null(True))
    )
    for episode in query:
        if episode.id in listened or not episode.path:
            continue
        if episode.publish_date and episode.publish_date > cutoff:
            continue
        try:
            size = os.path.getsize(episode.path)
        except OSError:
            continue
        out.append((episode, size))
    return out


def _is_episode(row) -> bool:
    return hasattr(row, "channel_id")


def _flag_removed(row) -> None:
    """Mark the row as no longer archived, without touching anything else."""
    from ..db import PodcastEpisode

    if _is_episode(row):
        PodcastEpisode.update(path=None, status="new").where(
            PodcastEpisode.id == row.id
        ).execute()
    else:
        Track.update(last_modification=0).where(Track.id == row.id).execute()


def _card(row, size) -> dict:
    if _is_episode(row):
        return {
            "id": str(row.id),
            "title": row.title,
            "artist": row.channel.title or "",
            "bytes": size,
            "play_count": 0,
            "last_play": None,
            "podcast": True,
        }
    return {
        "id": str(row.id),
        "title": row.title,
        "artist": row.artist.name if row.artist else "",
        "bytes": size,
        "play_count": row.play_count,
        "last_play": row.last_play.isoformat() if row.last_play else None,
    }


def preview(app, limit: int = 50) -> dict:
    """What a run would delete right now, without deleting anything.

    The admin sees the actual list, in the order the rules put it, before
    anything is removed. A destructive feature that cannot be inspected first is
    one nobody should be asked to turn on.

    With a deficit, the list is what the run would take (it stops at the floor).
    Without one, it is the head of the eligible queue — "this is what would go
    first, if it came to that".
    """
    settings = rules.load(app)
    need = deficit(app, settings)
    rows = candidates(app, settings) if settings.get("clean_on") else []

    freed, picked = 0, []
    for track, size in rows:
        if need and freed >= need:
            break
        if not need and len(picked) >= limit:
            break
        freed += size
        if len(picked) < limit:
            picked.append(_card(track, size))

    archive_dir = _archive_dir(app)
    return {
        "enabled": bool(settings.get("clean_on")),
        "free_bytes": free_bytes(archive_dir) if archive_dir else 0,
        "needed_bytes": need,
        "eligible": len(rows),
        "would_free": freed if need else 0,
        "tracks": picked,
        "running": is_running(),
    }


def run(app, force: bool = False) -> dict:
    """Delete until the free-space floor is met. Returns what happened.

    ``force`` runs the same selection with the same protections even when the
    disk is not short yet — the manual "libérer de la place maintenant" button —
    but it still refuses to run when the feature is off, and it still stops at
    the configured floor.
    """
    settings = rules.load(app)
    stats = {"deleted": 0, "freed": 0, "skipped": False}
    if not settings.get("clean_on"):
        stats["skipped"] = True
        return stats

    need = deficit(app, settings)
    if not need and not force:
        return stats
    if not need and force:
        # Nothing to reclaim: with no deficit there is no honest amount to free,
        # so a forced run on a healthy disk is a no-op rather than a guess.
        return stats

    if not _lock.acquire(blocking=False):
        logger.info("Archive cleanup already running; skipping this trigger")
        stats["skipped"] = True
        return stats
    try:
        for track, size in candidates(app, settings):
            if stats["freed"] >= need:
                break
            try:
                os.remove(track.path)
            except OSError as exc:
                logger.info("Cleanup: could not remove %s (%s)", track.path, exc)
                continue
            # The row stays: the entry keeps its place in every playlist / show
            # and downloads again on demand. Flagging it "not archived" is what
            # the rest of the app reads (0 for a track, NULL path for an
            # episode) — a row still claiming a file that is gone is worse than
            # no row at all.
            try:
                _flag_removed(track)
            except Exception:
                logger.warning("Cleanup: could not flag %s", track.id, exc_info=True)
            stats["deleted"] += 1
            stats["freed"] += size
        logger.info(
            "Archive cleanup freed %.2f GB (%d file(s))",
            stats["freed"] / GB,
            stats["deleted"],
        )
    finally:
        _lock.release()
    return stats


def maybe_run(app) -> None:
    """Called after archiving something. Cheap no-op unless the disk is short.

    Event-driven like everything else here: the archive only grows when we grow
    it, so the moment right after a download is exactly when the free space can
    have crossed the floor — and the only moment it can have. No timer.
    """
    try:
        settings = rules.load(app)
        if not settings.get("clean_on") or is_running():
            return
        if not deficit(app, settings):
            return
        threading.Thread(
            target=_run_in_context, args=(app,), name="archive-cleanup", daemon=True
        ).start()
    except Exception:
        logger.debug("Cleanup check failed", exc_info=True)


def _run_in_context(app):
    from ..db import close_connection, open_connection

    try:
        with app.app_context():
            open_connection(reuse=True)
            run(app)
    except Exception:
        logger.warning("Archive cleanup crashed", exc_info=True)
    finally:
        try:
            close_connection()
        except Exception:
            pass

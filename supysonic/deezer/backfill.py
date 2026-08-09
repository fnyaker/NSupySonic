# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Keep a copy of everything you own — as you acquire it, and as a safety net.

Two halves, and the order matters.

**Events** (``archive_now`` / ``archive_tracks`` / ``archive_entity`` /
``archive_show``) are the normal path: the moment something becomes yours — you
star a track, you favorite an album or a playlist, you add tracks to a playlist,
you subscribe to a show — its audio is queued for archiving right then. Playing
something already archives it (the stream is teed to disk), so between the two,
the archive keeps itself current with no clock involved. There is deliberately
NO polling loop: the app knows the instant it happens, so asking again on a
timer would be work for nothing.

**The sweep** (``collect`` / ``run`` / ``sweep_for``) is the safety net for what
the events could not cover — items that arrived through a Deezer-side change we
only learn about at sync time, or a download that failed while the server was
offline. It walks what you own and archives whatever has no file on disk.

Both only ever ADD: nothing here deletes, moves or re-fetches an archived file,
so running any of it again is always safe and, on a complete archive, costs one
pass over the database.
"""

from __future__ import annotations

import logging
import os.path
import threading

from ..db import (
    Playlist,
    PlaylistTrack,
    PodcastChannel,
    PodcastEpisode,
    StarredTrack,
    Track,
)

logger = logging.getLogger(__name__)

SCOPES = ("all", "favorites", "playlists", "podcasts")


def _needs_file(row) -> bool:
    path = getattr(row, "path", None)
    return not path or not os.path.isfile(path)


def collect(user_id, admin: bool, scope: str = "all"):
    """``(tracks, episodes)`` that belong to this user and aren't archived yet.

    An admin owns the shared library, so their sweep covers every playlist and
    every subscribed show; anyone else only sweeps their own.
    """
    tracks, episodes = [], []
    seen = set()

    def add(track):
        if track.id in seen:  # a favorite that also sits in three playlists
            return
        seen.add(track.id)
        if track.deezer_id and _needs_file(track):
            tracks.append(track)

    if scope in ("all", "favorites"):
        for t in (
            Track.select()
            .join(StarredTrack, on=(StarredTrack.starred == Track.id))
            .where(StarredTrack.user == user_id)
        ):
            add(t)

    if scope in ("all", "playlists"):
        q = Track.select().join(PlaylistTrack, on=(PlaylistTrack.track == Track.id))
        if not admin:
            q = q.join(Playlist, on=(PlaylistTrack.playlist == Playlist.id)).where(
                Playlist.user == user_id
            )
        for t in q.distinct():
            add(t)

    if scope in ("all", "podcasts"):
        q = PodcastEpisode.select().join(
            PodcastChannel, on=(PodcastEpisode.channel == PodcastChannel.id)
        )
        if not admin:
            q = q.where(PodcastChannel.user == user_id)
        episodes = [e for e in q if _needs_file(e)]

    return tracks, episodes


def run(provider, tracks, episodes, on_event=None, should_stop=None) -> dict:
    """Archive each of them, one at a time. Returns a summary.

    Sequential on purpose: this shares a Deezer session and a network link with
    whatever the user is actually listening to, and a burst of parallel FLAC
    downloads would make the app worse for as long as the sweep runs.

    ``on_event(kind)`` is called after every item (``"archived"``,
    ``"unavailable"``, ``"failed"``, plus ``"done"``), so a caller can report
    progress; ``should_stop()`` lets one abandon the sweep (shutdown, a newer
    run taking over).
    """
    from . import archive
    from .provider import TrackUnavailable

    stats = {"archived": 0, "unavailable": 0, "failed": 0, "done": 0}

    def event(kind):
        stats[kind] = stats.get(kind, 0) + 1
        if on_event:
            try:
                on_event(kind)
            except Exception:
                pass

    for track in tracks:
        if should_stop and should_stop():
            break
        try:
            archive.ensure_archived(provider, track)
            event("archived")
        except TrackUnavailable:
            # Deezer says it's gone; the archiver has already flagged the row.
            # Counted apart from a failure — there is nothing to retry here, and
            # the UI can offer a replacement instead of pretending it broke.
            event("unavailable")
        except Exception as exc:
            logger.info("Backfill: %s could not be archived (%s)", track.deezer_id, exc)
            event("failed")
        finally:
            event("done")

    for episode in episodes:
        if should_stop and should_stop():
            break
        try:
            archive.ensure_episode_archived(provider, episode)
            event("archived")
        except Exception as exc:
            logger.info("Backfill: episode %s could not be archived (%s)", episode.id, exc)
            event("failed")
        finally:
            event("done")

    return stats


# Only one sweep at a time, whichever asked for it: the one after a sync and the
# "archive everything now" button both go through sweep_for, so they share this.
# Two concurrent sweeps would fetch the same missing tracks twice and fight over
# the same Deezer session for no gain — the per-track lock in ensure_archived
# would serialize them anyway, more expensively.
_sweep_lock = threading.Lock()

IDLE = {"archived": 0, "unavailable": 0, "failed": 0, "done": 0, "total": 0}


def is_sweeping() -> bool:
    return _sweep_lock.locked()


# -- event-driven archiving -------------------------------------------------
# The sweep is the safety net; THIS is the normal path. Whenever something
# enters your library — you star a track, you favourite a playlist or an album,
# you add tracks to a playlist, you subscribe to a show — its audio is queued for
# archiving right then. No polling: the app already knows the moment it happens,
# so asking again later would be work for nothing.
#
# Everything goes through the existing background download queue (bounded, with
# its own worker pool), and every call is fail-soft: archiving is a consequence
# of the action, never a condition for it.


def archiving_enabled(app) -> bool:
    """The same switch the nightly sweep obeys (``[deezer] archive_library``).

    Turning it off must turn off ALL automatic archiving, not just the sweep —
    otherwise favouriting an album would still pull gigabytes onto a disk whose
    owner explicitly asked us not to.
    """
    try:
        return bool(app.config["DEEZER"].get("archive_library", True))
    except Exception:
        return True


def archive_now(app, deezer_ids=(), episode_ids=()) -> int:
    """Queue Deezer track / episode ids for background archiving. Best effort."""
    pf = getattr(app, "deezer_prefetch", None)
    if pf is None or not archiving_enabled(app):
        return 0
    queued = 0
    try:
        ids = [str(i) for i in deezer_ids if i]
        if ids:
            queued += pf.download_ids(ids)
        eps = [str(i) for i in episode_ids if i]
        if eps:
            queued += pf.download_episode_ids(eps)
    except Exception:
        logger.debug("Could not queue an archive", exc_info=True)
    return queued


def archive_tracks(app, tracks) -> int:
    """Queue the Track rows that have no file on disk yet.

    The cheap path: the rows are already in hand (a playlist you just built, an
    album you just starred through Subsonic), so nothing has to ask Deezer what
    they contain.
    """
    ids = []
    for t in tracks or ():
        try:
            if getattr(t, "deezer_id", None) and _needs_file(t):
                ids.append(t.deezer_id)
        except Exception:
            continue
    return archive_now(app, deezer_ids=ids)


def archive_entity(app, provider, kind: str, deezer_id):
    """Archive everything a favourited album / playlist contains.

    Runs in a worker thread: listing an album or a playlist is a Deezer call, and
    starring something must stay instant. An ARTIST is deliberately not covered —
    favouriting one doesn't add a finite set of tracks to your library, it would
    mean downloading a discography nobody asked for.

    Returns the thread (or ``None`` when there is nothing to do).
    """
    if kind not in ("album", "playlist") or not deezer_id:
        return None
    if provider is None or not archiving_enabled(app):
        return None

    def work():
        try:
            if kind == "album":
                raw = provider.get_album_tracks(deezer_id)
            else:
                raw = provider.get_playlist_tracks(deezer_id)
            ids = [str(t.get("SNG_ID")) for t in (raw or []) if t.get("SNG_ID")]
            if ids:
                n = archive_now(app, deezer_ids=ids)
                logger.info("Archiving %d track(s) from favourited %s %s", n, kind, deezer_id)
        except Exception as exc:
            logger.info("Could not archive %s %s: %s", kind, deezer_id, exc)

    thread = threading.Thread(target=work, name="archive-entity", daemon=True)
    thread.start()
    return thread


def archive_show(app, channel) -> int:
    """Queue every episode of a show that isn't on disk yet."""
    if channel is None:
        return 0
    try:
        missing = [str(e.id) for e in channel.episodes if _needs_file(e)]
    except Exception:
        return 0
    return archive_now(app, episode_ids=missing)


def sweep_for(
    provider, user, scope: str = "all", on_event=None, should_stop=None, on_total=None
):
    """Collect + run for one user. What the scheduler and the button both call.

    Returns ``{"skipped": True}`` when another sweep already holds the lock —
    the caller reports that rather than queueing a duplicate. ``on_total(n)`` is
    called once the size of the job is known, before any download starts, so a
    progress bar has a denominator.
    """
    if not _sweep_lock.acquire(blocking=False):
        logger.info("Archive sweep already running; skipping this trigger")
        return {**IDLE, "skipped": True}
    try:
        tracks, episodes = collect(user.id, bool(user.admin), scope)
        total = len(tracks) + len(episodes)
        if on_total:
            try:
                on_total(total)
            except Exception:
                pass
        if not total:
            return dict(IDLE)
        logger.info("Archiving %d missing item(s) for %s", total, user.name)
        stats = run(
            provider, tracks, episodes, on_event=on_event, should_stop=should_stop
        )
        stats["total"] = total
        return stats
    finally:
        _sweep_lock.release()

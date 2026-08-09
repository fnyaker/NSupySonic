# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Keep a copy of everything you own — as you acquire it, and as a safety net.

Two halves, and the order matters.

**Events** (``archive_now`` / ``archive_tracks`` / ``archive_entity`` /
``archive_show``) are the normal path: the moment something becomes yours — you
star a track, you favorite an album, a playlist or an artist, you add tracks to a
playlist, you subscribe to a show — its audio is queued for archiving. Playing
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
import time

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
# enters your library — you star a track, you favourite a playlist, an album or
# an artist, you add tracks to a playlist, you subscribe to a show — its audio is
# queued for archiving right then. No polling: the app already knows the moment
# it happens, so asking again later would be work for nothing.
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


def archive_tracks(app, tracks, event: str | None = None) -> int:
    """Queue the Track rows that have no file on disk yet.

    The cheap path: the rows are already in hand (a playlist you just built, an
    album you just starred through Subsonic), so nothing has to ask Deezer what
    they contain.

    ``event`` names the rule that authorises this (see ``rules.EVENTS``); when
    the admin has turned that event off, nothing is queued.
    """
    from . import rules

    if event and not rules.enabled(app, event):
        return 0
    ids = []
    for t in tracks or ():
        try:
            if getattr(t, "deezer_id", None) and _needs_file(t):
                ids.append(t.deezer_id)
        except Exception:
            continue
    return archive_now(app, deezer_ids=ids)


ENTITY_KINDS = ("album", "playlist", "artist")

# Which admin rule authorises each favourite.
ENTITY_EVENTS = {
    "album": "on_fav_album",
    "playlist": "on_fav_playlist",
    "artist": "on_fav_artist",
}

# How long a feeder thread waits before offering the overflow again.
QUEUE_RETRY_DELAY = 30


def _song_ids(raw) -> list:
    """Deduplicated ``SNG_ID``s out of a gw tracklist."""
    out, seen = [], set()
    for t in raw or ():
        sid = str((t or {}).get("SNG_ID") or "")
        if sid and sid not in seen:
            seen.add(sid)
            out.append(sid)
    return out


def _queue_all(app, deezer_ids, label: str) -> int:
    """Feed ids into the download queue, waiting for room instead of dropping.

    The queue is bounded — every entry is a full FLAC — and a discography can be
    several thousand tracks, far more than it holds. Silently dropping the
    overflow would leave the archive incomplete with nothing to notice it, so
    this feeder simply waits for the workers to drain some and offers the rest.

    It runs in a daemon thread, so a restart just abandons the tail; the nightly
    sweep is what catches up on anything still missing.
    """
    pending = list(deezer_ids)
    queued = 0
    while pending:
        if getattr(app, "deezer_prefetch", None) is None or not archiving_enabled(app):
            break
        n = archive_now(app, deezer_ids=pending)
        queued += n
        pending = pending[n:]
        if pending:
            logger.info(
                "Archive queue full; %d track(s) of %s still waiting",
                len(pending),
                label,
            )
            time.sleep(QUEUE_RETRY_DELAY)
    return queued


def _releases(provider, artist_id, scope: str, limit: int) -> list:
    """The album ids to take from an artist, per the configured scope.

    ``all`` is Deezer's own ``all`` tab: albums + singles + EPs + "more",
    deduplicated, without the guest appearances that belong to somebody else's
    record. ``releases`` is the same list cut to the ``limit`` most recent — the
    setting for a server that cannot hold every discography.
    """
    tabs = provider.get_artist_discography(artist_id) or {}
    releases = [r for r in (tabs.get("all") or []) if (r or {}).get("id")]
    if scope == "releases":
        # Most recent first. gw's order is not reliable, so sort explicitly; a
        # missing date sorts last rather than winning by accident.
        releases.sort(key=lambda r: str(r.get("release_date") or ""), reverse=True)
        releases = releases[: max(1, limit)]

    out, seen = [], set()
    for release in releases:
        aid = str(release.get("id") or "")
        if aid and aid not in seen:
            seen.add(aid)
            out.append(aid)
    return out


def _top_track_ids(provider, artist_id, limit: int) -> list:
    """The artist's most-played tracks, for the ``top`` scope."""
    raw = provider.get_artist_top(artist_id, limit=max(1, limit)) or []
    out, seen = [], set()
    for t in raw:
        tid = str((t or {}).get("id") or (t or {}).get("SNG_ID") or "")
        if tid and tid not in seen:
            seen.add(tid)
            out.append(tid)
    return out[: max(1, limit)]


def _archive_discography(app, provider, artist_id) -> int:
    """What a favourited artist brings in, per the admin's artist rules.

    Releases are fed album by album so the first one starts downloading while
    the rest is still being listed.
    """
    from . import rules

    settings = rules.load(app)
    scope = settings.get("artist_scope") or "all"
    limit = int(settings.get("artist_limit") or 5)

    if scope == "top":
        ids = _top_track_ids(provider, artist_id, limit)
        total = _queue_all(app, ids, f"artist {artist_id}")
        logger.info(
            "Archiving %d top track(s) of favourited artist %s", total, artist_id
        )
        return total

    album_ids = _releases(provider, artist_id, scope, limit)

    total = 0
    queued_tracks = set()
    for aid in album_ids:
        try:
            ids = _song_ids(provider.get_album_tracks(aid))
        except Exception as exc:  # one unreadable release must not stop the rest
            logger.info("Discography %s: album %s unreadable (%s)", artist_id, aid, exc)
            continue
        # The same recording turns up on the album, the single and the deluxe
        # edition. Queueing it three times would cost three queue slots for one
        # file (ensure_archived would then no-op twice).
        ids = [i for i in ids if i not in queued_tracks]
        queued_tracks.update(ids)
        total += _queue_all(app, ids, f"artist {artist_id}")
    logger.info(
        "Archiving %d track(s) from %d release(s) of favourited artist %s (%s)",
        total,
        len(album_ids),
        artist_id,
        scope,
    )
    return total


def archive_entity(app, provider, kind: str, deezer_id):
    """Archive everything a favourited album / playlist / artist contains.

    Runs in a worker thread: listing any of them is one or more Deezer calls, and
    favouriting something must stay instant. An artist means the whole
    discography — that is the point of favouriting one — so it is fed release by
    release rather than in one burst.

    Returns the thread (or ``None`` when there is nothing to do).
    """
    from . import rules

    if kind not in ENTITY_KINDS or not deezer_id:
        return None
    if provider is None or not archiving_enabled(app):
        return None
    if getattr(app, "deezer_prefetch", None) is None:
        return None
    if not rules.enabled(app, ENTITY_EVENTS[kind]):
        return None

    def work():
        try:
            if kind == "artist":
                _archive_discography(app, provider, deezer_id)
                return
            if kind == "album":
                raw = provider.get_album_tracks(deezer_id)
            else:
                raw = provider.get_playlist_tracks(deezer_id)
            ids = _song_ids(raw)
            if ids:
                n = _queue_all(app, ids, f"{kind} {deezer_id}")
                logger.info(
                    "Archiving %d track(s) from favourited %s %s", n, kind, deezer_id
                )
        except Exception as exc:
            logger.info("Could not archive %s %s: %s", kind, deezer_id, exc)

    thread = threading.Thread(target=work, name="archive-entity", daemon=True)
    thread.start()
    return thread


def archive_show(app, channel) -> int:
    """Queue every episode of a show that isn't on disk yet."""
    from . import rules

    if channel is None or not rules.enabled(app, "on_podcast"):
        return 0
    try:
        missing = [str(e.id) for e in channel.episodes if _needs_file(e)]
    except Exception:
        return 0
    return archive_now(app, episode_ids=missing)


# Playing an album fires one /api/listen per track, all carrying the SAME
# context. Without this, a 30-track album would mean 30 identical tracklist
# fetches and 30 worker threads racing to queue the same ids. One pass per
# container per hour is plenty: the queue skips what is already on disk anyway.
_CONTEXT_TTL = 3600
_recent_contexts = {}
_context_lock = threading.Lock()


def _first_time_seen(key: str) -> bool:
    now_ = time.monotonic()
    cutoff = now_ - _CONTEXT_TTL
    with _context_lock:
        for old in [k for k, at in _recent_contexts.items() if at < cutoff]:
            del _recent_contexts[old]
        # `is None`, not a 0 default: monotonic() counts from boot, so for the
        # first hour of uptime `0 > cutoff` is true and every context would look
        # like one we had just handled.
        seen = _recent_contexts.get(key)
        if seen is not None and seen > cutoff:
            return False
        _recent_contexts[key] = now_
        return True


def archive_play_context(app, provider, context):
    """Playing a track archives the album / playlist it came from.

    Opt-in (``on_play_context``): it turns "I pressed play on one song" into a
    whole-release download, which is exactly what some libraries want and
    exactly what a small disk cannot afford. The track itself is archived by the
    act of playing it, with or without this.

    ``context`` is the player's ``{"kind": ..., "id": ...}`` — the same shape
    the SPA already sends to /api/listen.
    """
    from . import rules

    if not rules.enabled(app, "on_play_context"):
        return None
    kind = str((context or {}).get("kind") or "")
    cid = str((context or {}).get("id") or "")
    if kind not in ENTITY_KINDS or kind == "artist" or not cid.isdigit():
        # Only a finite, named container. A radio/flow/search queue has no
        # tracklist to archive, and an artist context here would mean pulling a
        # discography because someone pressed play — never implicit.
        return None
    # Reuses the favourite path, but gated on its own rule: the entity events
    # must not be able to authorise a play.
    if getattr(app, "deezer_prefetch", None) is None or provider is None:
        return None
    if not archiving_enabled(app):
        return None
    if not _first_time_seen(f"{kind}:{cid}"):
        return None

    def work():
        try:
            raw = (
                provider.get_album_tracks(cid)
                if kind == "album"
                else provider.get_playlist_tracks(cid)
            )
            ids = _song_ids(raw)
            if ids:
                n = _queue_all(app, ids, f"played {kind} {cid}")
                logger.info("Archiving %d track(s) from played %s %s", n, kind, cid)
        except Exception as exc:
            logger.info("Could not archive played %s %s: %s", kind, cid, exc)

    thread = threading.Thread(target=work, name="archive-play-context", daemon=True)
    thread.start()
    return thread


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

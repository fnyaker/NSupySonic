# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Make the archive complete: fetch what you own but haven't played yet.

Audio is normally archived on first play, which is fine for the thing you are
listening to and useless for everything else: your favorites, your playlists and
your podcasts stay hostage to Deezer until the day you happen to press play on
them — which may be the day after Deezer removed them.

This walks what you own and archives whatever has no file on disk. It only ever
ADDS: nothing here deletes, moves or re-fetches an archived file, so running it
again is always safe and, on a complete archive, costs one pass over the
database.

Used by the nightly sync (so it keeps up on its own) and by the "archive
everything now" button in the settings.
"""

from __future__ import annotations

import logging
import os.path

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


def sweep_for(provider, user, scope: str = "all", on_event=None, should_stop=None):
    """Collect + run for one user. What the scheduler and the button both call."""
    tracks, episodes = collect(user.id, bool(user.admin), scope)
    total = len(tracks) + len(episodes)
    if not total:
        return {"archived": 0, "unavailable": 0, "failed": 0, "done": 0, "total": 0}
    logger.info("Archiving %d missing item(s) for %s", total, user.name)
    stats = run(provider, tracks, episodes, on_event=on_event, should_stop=should_stop)
    stats["total"] = total
    return stats

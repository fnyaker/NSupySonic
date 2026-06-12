# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Fetch-and-archive a Deezer track on demand, plus helpers to import metadata.

``ensure_archived`` is the streaming seam: when a Deezer-backed Track has no
file yet, it resolves a playable URL, stream-decrypts the (preferably FLAC)
audio into the track's archive path, tags it, and updates the row. Once on
disk the track behaves like any other local file (transcoding, caching, cover
extraction all work unchanged).
"""

from __future__ import annotations

import logging
import os
import os.path
import re
import time
from pathlib import Path

from ..db import Album, Artist, Playlist, Track
from . import ids, library
from .metadata import meta_from_gw, tag_file
from .provider import EXT_FOR_FORMAT, NOMINAL_BITRATE, DeezerError

logger = logging.getLogger(__name__)

_LINK_RE = re.compile(
    r"(?:deezer\.com|deezer\.page\.link|dzr\.page\.link)/(?:[a-z]{2}/)?"
    r"(track|album|playlist|artist)/(\d+)"
)


def parse_deezer_ref(ref: str):
    """Parse a Deezer URL or ``type:id`` / ``type id`` into ``(type, id)``."""
    ref = str(ref).strip()
    m = _LINK_RE.search(ref)
    if m:
        return m.group(1), m.group(2)
    m = re.fullmatch(r"(track|album|playlist|artist)[ :/](\d+)", ref)
    if m:
        return m.group(1), m.group(2)
    if ref.isdigit():
        return "track", ref
    raise ValueError(f"unrecognized Deezer reference: {ref!r}")


def _bitrate_for(path: str, fmt: str, duration: int) -> int:
    try:
        size = os.path.getsize(path)
        if duration > 0:
            return max(1, int(size * 8 / duration / 1000))
    except OSError:
        pass
    return NOMINAL_BITRATE.get(fmt, 320)


def ensure_archived(provider, track: Track) -> None:
    """Fetch + decrypt + tag the FLAC for `track` into its archive path.

    Idempotent and serialized per Deezer track id, so concurrent plays and the
    preloader never download the same track twice.
    """
    if not track.deezer_id:
        return
    if os.path.isfile(track.path):
        return

    with provider.track_lock(track.deezer_id):
        if os.path.isfile(track.path):
            return

        url, fmt, info, used_id = provider.resolve(track.deezer_id)

        # The path's extension was guessed at import time; fix it if the format
        # we actually got differs (e.g. FLAC unavailable -> MP3).
        ext = EXT_FOR_FORMAT.get(fmt, ".mp3")
        base, cur_ext = os.path.splitext(track.path)
        if cur_ext.lower() != ext:
            track.path = base + ext

        logger.info("Archiving Deezer track %s (%s) -> %s", track.deezer_id, fmt, track.path)
        provider.download_to(url, used_id, track.path)

        meta = meta_from_gw(info)
        cover = provider.fetch_cover(meta.get("md5_image"))
        try:
            tag_file(Path(track.path), meta, cover)
        except Exception as exc:  # tagging must never break playback
            logger.warning("Tagging failed for %s: %s", track.path, exc)

        track.bitrate = _bitrate_for(track.path, fmt, track.duration)
        track.has_art = bool(cover)
        track.last_modification = int(time.time())
        track.save()


# -- metadata import (Deezer -> supysonic rows) --------------------------


def find_local_track(sng_id) -> Track | None:
    """The already-imported Track for a Deezer id, looked up in the DB with no
    network call. Returns None if it was never imported.

    Track ids are a deterministic uuid5 of the Deezer id, so this is a direct
    primary-key lookup — it lets streaming serve archived audio even when Deezer
    is unreachable.
    """
    try:
        return Track[ids.track_uuid(sng_id)]
    except Track.DoesNotExist:
        return None


def import_track(provider, sng_id) -> Track:
    root = library.get_root_folder(provider.archive_dir)
    info = provider.get_track_info(sng_id)
    return library.upsert_track(info, root, provider.default_quality)


def import_album(provider, alb_id) -> list[Track]:
    root = library.get_root_folder(provider.archive_dir)
    tracks = provider.get_album_tracks(alb_id)
    return [library.upsert_track(t, root, provider.default_quality) for t in tracks]


def import_playlist_tracks(provider, playlist_id) -> list[Track]:
    """Import every track of a Deezer playlist (rows only, no ordering)."""
    root = library.get_root_folder(provider.archive_dir)
    tracks = provider.get_playlist_tracks(playlist_id)
    return [library.upsert_track(t, root, provider.default_quality) for t in tracks]


# -- cover art fallback for not-yet-archived Deezer entities -------------


def deezer_cover_path(provider, cache, eid: str):
    """Return a cached cover path fetched from Deezer for a Deezer id, or None.

    Resolves the id to an Album/Track (cover via md5 CDN), or an Artist/Playlist
    (image via Deezer's public image endpoint). Ids are type-namespaced uuid5,
    so only one lookup matches.
    """
    import uuid

    try:
        key = uuid.UUID(str(eid))
    except ValueError:
        return None

    data = None
    try:
        alb = Album[key]
        data = provider.fetch_cover(alb.cover_md5) if alb.cover_md5 else None
    except Album.DoesNotExist:
        try:
            data = provider.fetch_image("artist", Artist[key].deezer_id)
        except Artist.DoesNotExist:
            try:
                data = provider.fetch_image("playlist", Playlist[key].deezer_id)
            except Playlist.DoesNotExist:
                try:
                    tr = Track[key]
                    data = (
                        provider.fetch_cover(tr.album.cover_md5)
                        if tr.album.cover_md5
                        else None
                    )
                except Track.DoesNotExist:
                    return None

    if not data:
        return None
    return cache.set(f"{eid}-deezer-cover", data)

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Materialize Deezer entities as regular supysonic DB rows.

Every Deezer track becomes a real ``Track`` row whose ``path`` points at a
deterministic location inside the Deezer archive folder (the file itself is
fetched lazily on first play). Artists, albums and the per-album folders are
upserted with deterministic ids so re-syncing never duplicates anything.
"""

from __future__ import annotations

import os
import os.path
import re

from ..db import Folder, Artist, Album, Track
from . import ids
from .provider import EXT_FOR_FORMAT, NOMINAL_BITRATE

DEEZER_ROOT_NAME = "Deezer"

_ILLEGAL = re.compile(r'[/\\:*?"<>|]')


class ImportCache:
    """Per-run in-memory cache so a bulk import doesn't re-query shared rows.

    A playlist of thousands of tracks shares a handful of artists/albums; caching
    them turns thousands of lookups into a few.
    """

    def __init__(self):
        self.artists = {}  # deezer art_id -> Artist
        self.albums = {}   # deezer alb_id -> Album
        self.folders = {}  # path -> Folder


def sanitize(name: str) -> str:
    """Make a string safe as a single path component."""
    name = _ILLEGAL.sub("_", (name or "").strip(" ."))
    return name or "untitled"


def get_root_folder(archive_dir: str) -> Folder:
    """Return (creating if needed) the root library Folder for the archive."""
    archive_dir = os.path.abspath(os.path.expanduser(archive_dir))
    try:
        return Folder.get(path=archive_dir)
    except Folder.DoesNotExist:
        os.makedirs(archive_dir, exist_ok=True)
        return Folder.create(root=True, name=DEEZER_ROOT_NAME, path=archive_dir)


def get_album_folder(root: Folder, artist_name: str, album_name: str, cache=None) -> Folder:
    path = os.path.join(root.path, sanitize(artist_name), sanitize(album_name))
    if cache is not None and path in cache.folders:
        return cache.folders[path]
    try:
        folder = Folder.get(path=path)
    except Folder.DoesNotExist:
        folder = Folder.create(
            root=False, name=sanitize(album_name), path=path, parent=root
        )
    if cache is not None:
        cache.folders[path] = folder
    return folder


def normalize_track(t: dict) -> dict:
    """Flatten a gateway track dict (song.getData / playlist / album list)."""
    title = t.get("SNG_TITLE", "")
    version = t.get("VERSION") or ""
    if version and version not in title:
        title = f"{title} {version}".strip()
    date = str(t.get("PHYSICAL_RELEASE_DATE") or t.get("DIGITAL_RELEASE_DATE") or "")
    year = int(date[:4]) if date[:4].isdigit() else None
    return {
        "sng_id": str(t.get("SNG_ID")),
        "title": title or "[unknown]",
        "artist": t.get("ART_NAME", "") or "[unknown]",
        "art_id": str(t.get("ART_ID")),
        "album": t.get("ALB_TITLE", "") or "[non-album tracks]",
        "alb_id": str(t.get("ALB_ID")),
        "cover_md5": t.get("ALB_PICTURE", "") or None,
        "duration": int(t.get("DURATION") or 0),
        "number": int(t.get("TRACK_NUMBER") or 0),
        "disc": int(t.get("DISK_NUMBER") or 0),
        "year": year,
    }


def upsert_artist(art_id, name: str, cache=None) -> Artist:
    key = str(art_id)
    if cache is not None and key in cache.artists:
        return cache.artists[key]
    aid = ids.artist_uuid(art_id)
    try:
        artist = Artist[aid]
        if name and artist.name != name:
            artist.name = name
            artist.save()
    except Artist.DoesNotExist:
        artist = Artist.create(id=aid, name=name or "[unknown]", deezer_id=key)
    if cache is not None:
        cache.artists[key] = artist
    return artist


def upsert_album(alb_id, name: str, artist: Artist, cover_md5, cache=None) -> Album:
    key = str(alb_id)
    if cache is not None and key in cache.albums:
        return cache.albums[key]
    aid = ids.album_uuid(alb_id)
    try:
        album = Album[aid]
        if cover_md5 and not album.cover_md5:
            album.cover_md5 = cover_md5
            album.save()
    except Album.DoesNotExist:
        album = Album.create(
            id=aid,
            name=name or "[non-album tracks]",
            artist=artist,
            deezer_id=key,
            cover_md5=cover_md5,
        )
    if cache is not None:
        cache.albums[key] = album
    return album


def _track_path(root: Folder, artist: str, album: str, number: int, title: str, ext: str):
    fname = f"{int(number or 0):02d} - {sanitize(title)}{ext}"
    return os.path.join(root.path, sanitize(artist), sanitize(album), fname)


def _unique_path(path: str, tid) -> str:
    """Avoid path_hash collisions between distinct Deezer tracks."""
    base, ext = os.path.splitext(path)
    candidate = path
    n = 0
    while True:
        try:
            existing = Track.get(path=candidate)
        except Track.DoesNotExist:
            return candidate
        if existing.id == tid:
            return candidate
        n += 1
        candidate = f"{base} ({n}){ext}"


def upsert_track(t: dict, root: Folder, default_quality: str = "FLAC", cache=None) -> Track:
    """Create or update the supysonic Track row for a Deezer track dict."""
    f = normalize_track(t)
    tid = ids.track_uuid(f["sng_id"])
    artist = upsert_artist(f["art_id"], f["artist"], cache=cache)
    album = upsert_album(f["alb_id"], f["album"], artist, f["cover_md5"], cache=cache)
    folder = get_album_folder(root, f["artist"], f["album"], cache=cache)

    try:
        track = Track[tid]
        # Refresh mutable metadata; keep path/bitrate/has_art if already archived.
        track.title = f["title"]
        track.artist = artist
        track.album = album
        track.disc = f["disc"]
        track.number = f["number"]
        track.duration = f["duration"]
        track.year = f["year"]
        track.deezer_id = f["sng_id"]
        track.save()
        return track
    except Track.DoesNotExist:
        ext = EXT_FOR_FORMAT.get(default_quality, ".flac")
        path = _unique_path(_track_path(root, f["artist"], f["album"], f["number"], f["title"], ext), tid)
        return Track.create(
            id=tid,
            deezer_id=f["sng_id"],
            disc=f["disc"],
            number=f["number"],
            title=f["title"],
            year=f["year"],
            genre=None,
            duration=f["duration"],
            has_art=False,
            album=album,
            artist=artist,
            bitrate=NOMINAL_BITRATE.get(default_quality, 320),
            path=path,
            last_modification=0,
            root_folder=root,
            folder=folder,
        )

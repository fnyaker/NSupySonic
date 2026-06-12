# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Import user-dropped audio files in the archive directory as local tracks.

Any audio file placed under ``archive_dir`` that isn't already a known track
becomes a first-class supysonic ``Track`` row — so it shows up in browsing,
search, playlists and the jukebox exactly like a Deezer track, in every Subsonic
client, with no extra plumbing. Local tracks carry ``deezer_id = NULL`` (the
marker the rest of the code uses to tell "local" from "Deezer"), so the Deezer
sync never touches them.

This is deliberately NOT supysonic's folder scanner: that one prunes any Track
whose file is missing, which would wipe every not-yet-downloaded (lazy) Deezer
row. Here we only *add* untracked files and only prune *local* tracks whose file
disappeared.
"""

from __future__ import annotations

import logging
import os
import os.path
from datetime import datetime

import mediafile

from ..db import Album, Artist, Track
from . import ids, library

logger = logging.getLogger(__name__)

# Formats mediafile/ffmpeg can read; "peu importe le format".
AUDIO_EXTS = {
    "flac", "mp3", "m4a", "mp4", "aac", "alac", "ogg", "oga", "opus", "wav",
    "wma", "aif", "aiff", "aifc", "ape", "wv", "mpc", "dsf",
}


def _load_tag(path):
    try:
        return mediafile.MediaFile(path)
    except mediafile.UnreadableFileError:
        return None
    except Exception:  # pragma: no cover - corrupt/odd files
        logger.debug("Could not read tags for %s", path, exc_info=True)
        return None


def _local_artist(name: str) -> Artist:
    name = (name or "[unknown]")[:255]
    aid = ids.local_artist_uuid(name)
    try:
        return Artist[aid]
    except Artist.DoesNotExist:
        return Artist.create(id=aid, name=name, deezer_id=None)


def _local_album(artist: Artist, album_name: str) -> Album:
    album_name = (album_name or "[non-album tracks]")[:255]
    aid = ids.local_album_uuid(artist.name, album_name)
    try:
        return Album[aid]
    except Album.DoesNotExist:
        return Album.create(
            id=aid, name=album_name, artist=artist, deezer_id=None, cover_md5=None
        )


def import_local_file(path: str, root) -> Track | None:
    """Create the local Track row for one audio file (None if unreadable)."""
    tag = _load_tag(path)
    if tag is None:
        return None
    basename = os.path.basename(path)
    artist_name = (tag.artist or tag.albumartist or "[unknown]")[:255]
    albumartist = (tag.albumartist or artist_name)[:255]
    album_name = (tag.album or "[non-album tracks]")[:255]

    artist = _local_artist(artist_name)
    album = _local_album(_local_artist(albumartist), album_name)
    folder = library.get_album_folder(root, albumartist, album_name)
    mtime = int(os.path.getmtime(path))

    return Track.create(
        id=ids.local_track_uuid(path),
        deezer_id=None,  # the "local" marker
        disc=tag.disc or 1,
        number=tag.track or 1,
        title=(tag.title or os.path.splitext(basename)[0])[:255],
        year=tag.year,
        genre=tag.genre,
        duration=int(tag.length or 0),
        has_art=bool(tag.images),
        album=album,
        artist=artist,
        bitrate=(tag.bitrate or 0) // 1000,
        path=path,
        last_modification=mtime,
        root_folder=root,
        folder=folder,
        created=datetime.fromtimestamp(mtime),
    )


def scan_local(archive_dir: str) -> dict:
    """Import every untracked audio file under ``archive_dir`` as a local track.

    Idempotent: files already backing a Track (Deezer or local) are skipped.
    Local tracks whose file vanished are pruned; Deezer rows are never touched.
    Returns ``{"added": n, "removed": n}``.
    """
    root = library.get_root_folder(archive_dir)
    tracked = {t.path: t for t in Track.select(Track.id, Track.path, Track.deezer_id)}

    added = 0
    seen = set()
    for dirpath, _dirs, files in os.walk(archive_dir):
        for fn in files:
            ext = os.path.splitext(fn)[1][1:].lower()
            if ext not in AUDIO_EXTS:
                continue
            path = os.path.join(dirpath, fn)
            seen.add(path)
            if path in tracked:
                continue
            try:
                if import_local_file(path, root) is not None:
                    added += 1
            except Exception:  # pragma: no cover
                logger.warning("Failed to import local file %s", path, exc_info=True)

    removed = 0
    for path, track in tracked.items():
        if track.deezer_id is None and path not in seen and not os.path.isfile(path):
            track.delete_instance(recursive=True)
            removed += 1

    if added or removed:
        logger.info("Local scan: +%d new, -%d removed", added, removed)
    return {"added": added, "removed": removed}

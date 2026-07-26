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
from datetime import datetime

from ..db import Folder, Artist, Album, Track, PodcastChannel, PodcastEpisode
from . import ids
from .provider import EXT_FOR_FORMAT, NOMINAL_BITRATE

DEEZER_ROOT_NAME = "Deezer"
PODCAST_DIR_NAME = "Podcasts"

# Album art is archived next to the audio as a plain sidecar so it is served
# straight from disk (like the FLAC) and survives Deezer pulling the source.
COVER_FILENAME = "cover.jpg"

_ILLEGAL = re.compile(r'[/\\:*?"<>|]')
# Control characters, NUL above all. These reach us from Deezer metadata and,
# more realistically, from the ID3/Vorbis tags of files users upload — and every
# filesystem call raises ValueError on an embedded null, so a single stray byte
# in a tag turned a perfectly good file into an unexplained import failure.
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# Filesystems cap a single path component at 255 **bytes**, not characters: a
# 255-character CJK album title is ~765 bytes and makes os.makedirs fail with
# ENAMETOOLONG, so an ordinary release simply refused to archive. The budget is
# well under the limit to leave room for the "NN - " prefix and the extension
# that track_archive_path appends.
_MAX_COMPONENT_BYTES = 200


class ImportCache:
    """Per-run in-memory cache so a bulk import doesn't re-query shared rows.

    A playlist of thousands of tracks shares a handful of artists/albums; caching
    them turns thousands of lookups into a few.
    """

    def __init__(self):
        self.artists = {}  # deezer art_id -> Artist
        self.albums = {}   # deezer alb_id -> Album
        self.folders = {}  # path -> Folder


def _truncate_bytes(name: str, limit: int) -> str:
    """Cut `name` to at most `limit` UTF-8 bytes without splitting a character."""
    raw = name.encode("utf-8")
    if len(raw) <= limit:
        return name
    return raw[:limit].decode("utf-8", "ignore")


def sanitize(name: str) -> str:
    """Make a string safe as a single path component."""
    name = _CONTROL.sub("", _ILLEGAL.sub("_", name or ""))
    # Strip before AND after truncating: the cut can land on a space or a dot,
    # and a component ending in either is silently rewritten by Windows.
    name = _truncate_bytes(name.strip(" ."), _MAX_COMPONENT_BYTES).strip(" .")
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


def save_album_cover(folder: Folder, data: bytes) -> str | None:
    """Persist album art as a ``cover.jpg`` sidecar in the album folder.

    Mirrors how the audio is archived: the image lands on disk next to the
    tracks and the ``Folder.cover_art`` marker is set, so every cover endpoint
    (Subsonic ``getCoverArt`` and the web ``/api/cover``) serves it locally with
    no Deezer call — it keeps showing even once Deezer drops the source.

    Idempotent (writes the file at most once); returns the cover path or None.
    """
    if not data or folder is None:
        return None
    path = os.path.join(folder.path, COVER_FILENAME)
    try:
        os.makedirs(folder.path, exist_ok=True)
        if not os.path.isfile(path):
            tmp = f"{path}.part"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, path)
    except OSError:
        return None
    if folder.cover_art != COVER_FILENAME:
        folder.cover_art = COVER_FILENAME
        folder.save()
    return path


def album_cover_file(album) -> str | None:
    """On-disk ``cover.jpg`` path for an archived album, or None if not present.

    Looks the album's tracks up for a folder carrying a cover marker (set by
    ``save_album_cover``) and returns the file only if it really exists.
    """
    track = (
        album.tracks.join(Folder, on=Track.folder)
        .where(Folder.cover_art.is_null(False))
        .first()
    )
    if track is None:
        return None
    path = os.path.join(track.folder.path, track.folder.cover_art)
    return path if os.path.isfile(path) else None


def _parse_gain(raw):
    """Deezer's per-track ReplayGain (``GAIN``) arrives as a string in dB, e.g.
    ``"-8.4"``. Return it as a float, or None when absent/unparseable."""
    if raw in (None, ""):
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def normalize_track(t: dict) -> dict:
    """Flatten a gateway track dict (song.getData / playlist / album list)."""
    title = t.get("SNG_TITLE", "")
    version = t.get("VERSION") or ""
    if version and version not in title:
        title = f"{title} {version}".strip()
    date = str(t.get("PHYSICAL_RELEASE_DATE") or t.get("DIGITAL_RELEASE_DATE") or "")
    year = int(date[:4]) if date[:4].isdigit() else None
    return {
        "gain": _parse_gain(t.get("GAIN")),
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
        if f["gain"] is not None:
            track.gain = f["gain"]
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
            gain=f["gain"],
            path=path,
            last_modification=0,
            root_folder=root,
            folder=folder,
        )


# -- podcasts (shows / episodes) -----------------------------------------

_DESC_MAX = 4096


def _trunc(s, limit=_DESC_MAX):
    if s and len(s) > limit:
        return s[:limit]
    return s or None


def podcast_root_path(archive_dir: str) -> str:
    base = os.path.abspath(os.path.expanduser(archive_dir))
    return os.path.join(base, PODCAST_DIR_NAME)


def episode_archive_path(archive_dir, channel_title, publish_date, title) -> str:
    """Deterministic ``<archive>/Podcasts/<Show>/<YYYY-MM-DD - Title>.mp3`` path."""
    datestr = publish_date.strftime("%Y-%m-%d") if publish_date else "0000-00-00"
    fname = f"{datestr} - {sanitize(title)}.mp3"
    return os.path.join(
        podcast_root_path(archive_dir), sanitize(channel_title or "Podcast"), fname
    )


def normalize_show(data: dict) -> dict:
    """Flatten a gateway ``deezer.pageShow`` ``DATA`` (show) object."""
    return {
        "show_id": str(data.get("SHOW_ID")),
        "title": data.get("SHOW_NAME") or "[unknown podcast]",
        "description": _trunc(data.get("SHOW_DESCRIPTION")),
        "cover_md5": data.get("SHOW_ART_MD5") or None,
    }


def normalize_episode(ep: dict) -> dict:
    """Flatten a gateway show-page episode object."""
    ts = ep.get("EPISODE_PUBLISHED_TS")
    try:
        ts = int(ts)
    except (TypeError, ValueError):
        ts = 0
    return {
        "episode_id": str(ep.get("EPISODE_ID")),
        "title": ep.get("EPISODE_TITLE") or "[untitled episode]",
        "description": _trunc(ep.get("EPISODE_DESCRIPTION")),
        "duration": int(ep.get("DURATION") or 0),
        "stream_url": ep.get("EPISODE_DIRECT_STREAM_URL") or None,
        "image_md5": ep.get("EPISODE_IMAGE_MD5") or ep.get("SHOW_ART_MD5") or None,
        "publish_date": datetime.fromtimestamp(ts) if ts else None,
        "available": bool(ep.get("AVAILABLE", True)),
    }


def show_url(show_id) -> str:
    return f"https://www.deezer.com/show/{show_id}"


def upsert_channel(user, show: dict, url=None) -> PodcastChannel:
    """Create or refresh the PodcastChannel row for a normalized show dict."""
    cid = ids.show_uuid(show["show_id"])
    url = url or show_url(show["show_id"])
    try:
        channel = PodcastChannel[cid]
        channel.title = show["title"]
        channel.description = show["description"]
        channel.cover_art_md5 = show["cover_md5"]
        channel.deezer_id = show["show_id"]
        channel.url = url
        channel.error_message = None
        channel.last_fetched = now_dt()
        channel.save()
    except PodcastChannel.DoesNotExist:
        channel = PodcastChannel.create(
            id=cid,
            user=user,
            deezer_id=show["show_id"],
            url=url,
            title=show["title"],
            description=show["description"],
            cover_art_md5=show["cover_md5"],
            last_fetched=now_dt(),
        )
    return channel


def upsert_episode(channel: PodcastChannel, ep: dict) -> PodcastEpisode:
    """Create or refresh a PodcastEpisode row (metadata only; audio on demand)."""
    eid = ids.episode_uuid(ep["episode_id"])
    try:
        episode = PodcastEpisode[eid]
        # Refresh mutable metadata; keep path/status/bitrate/play_offset.
        episode.title = ep["title"]
        episode.description = ep["description"]
        episode.duration = ep["duration"]
        episode.stream_url = ep["stream_url"]
        episode.image_md5 = ep["image_md5"]
        episode.publish_date = ep["publish_date"]
        episode.save()
        return episode
    except PodcastEpisode.DoesNotExist:
        return PodcastEpisode.create(
            id=eid,
            channel=channel,
            deezer_id=ep["episode_id"],
            title=ep["title"],
            description=ep["description"],
            duration=ep["duration"],
            publish_date=ep["publish_date"],
            stream_url=ep["stream_url"],
            image_md5=ep["image_md5"],
            status="new",
        )


def now_dt():
    from ..db import now

    return now()

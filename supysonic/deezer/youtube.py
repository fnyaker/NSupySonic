# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""YouTube as a FALLBACK source: for a track Deezer does not have.

Never a second catalogue. It is reached in exactly two ways, both of them a
person asking for it: the search screen's "YouTube" box (off by default) and
the "search YouTube too" button of a dead track's replacement sheet. Every
design choice below is about calling YouTube as little as possible:

- **Searching is ONE request** to YouTube Music's own API (``ytmusicapi``,
  ``filter="songs"``: title, artists, album, duration and square art in one
  answer, ~0.9 s), kept a day per query — empty answers too. yt-dlp is never
  used to search.
- **A hit costs nothing until it is played.** Its metadata is remembered on the
  server (``remember`` / ``recall``) under the UUID the row WILL have
  (``ids.youtube_track_uuid``), so playing, starring or adding it to a playlist
  creates the row from what the search already said — no second request.
- **The audio is fetched once, on the first play, and archived for good**
  (``ensure_archived``: one yt-dlp extraction + one download, ~2 s for a
  five-minute track). Nothing prefetches it, nothing bulk-archives it, and the
  cleanup never deletes it (it only ever considers rows with a ``deezer_id``),
  so YouTube is never asked about the same track twice.
- **The original stream is KEPT, not converted.** YouTube has no lossless
  audio: its best is Opus at ~130-160 kbit/s (format 251). It is remuxed into an
  Ogg ``.opus`` file with ``-c copy`` — not one sample re-encoded — and served
  as is; only a client asking for LESS than that gets a transcode. Turning it
  into FLAC would store five times the bytes of exactly the same sound.

A failure to reach YouTube is never a verdict about the video (the same rule as
Deezer's): only YouTube ANSWERING that a video is gone raises
``YoutubeUnavailable``. And a YouTube that refuses us (rate limit, bot check)
is left alone for a while (``_hold``), instead of being asked again by every
play.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import os.path
import re
import shutil
import tempfile
import threading
import time
from collections import OrderedDict

from peewee import IntegrityError

from ..db import Album, Artist, Folder, Track, db
from . import ids, library

logger = logging.getLogger(__name__)

# Where YouTube archives live, under the archive directory: kept apart from the
# Deezer tree so a person browsing the folders sees where a file came from.
DIR_NAME = "YouTube"
# Downloads are staged in a dot-directory: the local scanner skips those, so a
# half-written file is never imported as somebody's upload.
STAGING_DIR = ".youtube-staging"

# A video id is eleven characters of base64url. Anything else never reaches a
# URL we build.
_VIDEO_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{11}\Z")

SEARCH_TTL = 24 * 3600          # a query's answer, positive or empty
SEARCH_CACHE_MAX = 256          # queries kept in memory
HIT_CACHE_MAX = 4096            # hits remembered in memory (the disk keeps more)
SEARCH_LIMIT = 20

# How long YouTube is left alone after it refused or could not be reached.
# Refusals (HTTP 429, "confirm you're not a bot") are a statement about US, and
# asking again at once is how a short block becomes a long one.
HOLD_TRANSPORT = 60
HOLD_REFUSED = 15 * 60

# At most this many downloads at once, whatever the number of listeners.
_download_slots = threading.BoundedSemaphore(2)

_lock = threading.Lock()
_search_cache: "OrderedDict[str, tuple[float, list]]" = OrderedDict()
_hits: "OrderedDict[str, dict]" = OrderedDict()
_track_locks: dict[str, threading.Lock] = {}
_held_until = 0.0
_held_reason = ""
_ytmusic = None


class YoutubeError(Exception):
    """YouTube could not be asked, or did not answer usefully. No verdict."""


class YoutubeUnavailable(YoutubeError):
    """YouTube ANSWERED that this video cannot be played (removed, private,
    blocked). The one error allowed to condemn a track."""


class YoutubeHeld(YoutubeError):
    """We are leaving YouTube alone for a while; nothing was asked."""


# -- installation & health -----------------------------------------------------


def installed() -> bool:
    """Whether the optional dependencies are there (``supysonic[youtube]``)."""
    try:
        import yt_dlp  # noqa: F401
        import ytmusicapi  # noqa: F401
    except ImportError:
        return False
    return True


def held() -> tuple[bool, int, str]:
    """``(held, seconds left, why)``: whether YouTube is being left alone."""
    left = _held_until - time.monotonic()
    return (left > 0, max(0, int(left)), _held_reason if left > 0 else "")


def _hold(seconds: int, reason: str) -> None:
    global _held_until, _held_reason
    with _lock:
        until = time.monotonic() + seconds
        if until > _held_until:
            _held_until, _held_reason = until, reason
    logger.warning("YouTube left alone for %d s: %s", seconds, reason)


def _check_held() -> None:
    h, left, why = held()
    if h:
        raise YoutubeHeld(f"YouTube paused for {left} s ({why})")


def reset() -> None:
    """Forget every cache and hold (tests)."""
    global _held_until, _held_reason, _ytmusic
    with _lock:
        _search_cache.clear()
        _hits.clear()
        _held_until, _held_reason = 0.0, ""
        _ytmusic = None


def valid_video_id(value) -> bool:
    return bool(_VIDEO_ID_RE.fullmatch(str(value or "")))


# -- search ----------------------------------------------------------------------


def _client():
    """One YouTube Music client for the process, on a session that has a
    timeout and the per-host breaker (ytmusicapi's own default is 30 s)."""
    global _ytmusic
    if _ytmusic is None:
        from deezerpy import _Session
        from ytmusicapi import YTMusic

        _ytmusic = YTMusic(requests_session=_Session())
    return _ytmusic


def _norm_query(query: str) -> str:
    return " ".join((query or "").lower().split())[:200]


def _best_thumb(thumbs) -> str | None:
    """The largest square art, asked at 544 px (Google's image server scales on
    the URL; the search answers with a 120 px variant)."""
    if not thumbs:
        return None
    best = max(
        (t for t in thumbs if isinstance(t, dict) and t.get("url")),
        key=lambda t: (t.get("width") or 0),
        default=None,
    )
    if best is None:
        return None
    url = str(best["url"])
    if not url.startswith("https://"):
        return None
    return re.sub(r"=w\d+-h\d+", "=w544-h544", url)


def normalize_hit(raw: dict) -> dict | None:
    """A YouTube Music search entry -> the few fields we keep. None if unusable."""
    if not isinstance(raw, dict):
        return None
    vid = raw.get("videoId")
    if not valid_video_id(vid):
        return None
    artists = [
        {"id": str(a.get("id") or ""), "name": str(a.get("name") or "")[:255]}
        for a in raw.get("artists") or []
        if isinstance(a, dict) and a.get("name")
    ][:8]
    album = raw.get("album") if isinstance(raw.get("album"), dict) else {}
    try:
        duration = int(raw.get("duration_seconds") or 0)
    except (TypeError, ValueError):
        duration = 0
    return {
        "video_id": vid,
        "title": str(raw.get("title") or "")[:255] or vid,
        "artists": artists,
        "album": str(album.get("name") or "")[:255] or None,
        "album_id": str(album.get("id") or "")[:64] or None,
        "duration": max(0, duration),
        "explicit": bool(raw.get("isExplicit")),
        "thumb": _best_thumb(raw.get("thumbnails")),
    }


def search(query: str, limit: int = SEARCH_LIMIT, store=None) -> list[dict]:
    """Songs matching ``query``: one request, cached a day (misses too).

    Raises ``YoutubeError`` when YouTube could not be asked — the caller shows
    that, rather than an empty list that would read as "nothing on YouTube".
    """
    key = _norm_query(query)
    if not key:
        return []
    now = time.monotonic()
    with _lock:
        cached = _search_cache.get(key)
        if cached is not None and now - cached[0] < SEARCH_TTL:
            _search_cache.move_to_end(key)
            return list(cached[1][:limit])
    _check_held()
    try:
        raw = _client().search(key, filter="songs", limit=SEARCH_LIMIT) or []
    except Exception as exc:
        _hold_for(exc)
        raise YoutubeError(f"YouTube search failed: {exc}") from exc
    hits = [h for h in (normalize_hit(r) for r in raw) if h is not None]
    with _lock:
        _search_cache[key] = (now, hits)
        while len(_search_cache) > SEARCH_CACHE_MAX:
            _search_cache.popitem(last=False)
    for h in hits:
        remember(h, store)
    return list(hits[:limit])


def _hold_for(exc: Exception) -> None:
    """Back off after a failure: long for a refusal, short for the network."""
    text = str(exc).lower()
    if (
        "429" in text
        or "too many requests" in text
        or "not a bot" in text
        or "sign in to confirm" in text
    ):
        _hold(HOLD_REFUSED, "YouTube refused the request")
    else:
        _hold(HOLD_TRANSPORT, "YouTube could not be reached")


# -- hits: what a search said, kept until it is played ----------------------------


def track_uuid(video_id: str):
    return ids.youtube_track_uuid(video_id)


def _hit_key(tid) -> str:
    return f"yt-hit-{tid}"


def remember(hit: dict, store=None) -> None:
    """Keep a hit's metadata under its future row id (memory, and ``store`` —
    the app's disk cache — so a restart does not lose what was on screen)."""
    tid = str(track_uuid(hit["video_id"]))
    with _lock:
        _hits[tid] = hit
        _hits.move_to_end(tid)
        while len(_hits) > HIT_CACHE_MAX:
            _hits.popitem(last=False)
    if store is not None:
        try:
            store.set(_hit_key(tid), json.dumps(hit).encode("utf-8"))
        except Exception:  # pragma: no cover - a full disk is not a failed search
            logger.debug("Could not persist YouTube hit %s", tid, exc_info=True)


def recall(tid, store=None) -> dict | None:
    """The hit a search returned under this row id, if we still know it."""
    tid = str(tid)
    with _lock:
        hit = _hits.get(tid)
    if hit is not None:
        return hit
    if store is None:
        return None
    try:
        if not store.has(_hit_key(tid)):
            return None
        hit = normalize_stored(json.loads(store.get_value(_hit_key(tid))))
    except Exception:
        return None
    if hit is None or str(track_uuid(hit["video_id"])) != tid:
        return None
    with _lock:
        _hits[tid] = hit
    return hit


def normalize_stored(data) -> dict | None:
    """A hit read back from disk, checked field by field like a new one."""
    if not isinstance(data, dict) or not valid_video_id(data.get("video_id")):
        return None
    thumb = data.get("thumb")
    return {
        "video_id": data["video_id"],
        "title": str(data.get("title") or data["video_id"])[:255],
        "artists": [
            {"id": str(a.get("id") or ""), "name": str(a.get("name") or "")[:255]}
            for a in data.get("artists") or []
            if isinstance(a, dict) and a.get("name")
        ][:8],
        "album": (str(data["album"])[:255] if data.get("album") else None),
        "album_id": (str(data["album_id"])[:64] if data.get("album_id") else None),
        "duration": max(0, int(data.get("duration") or 0)),
        "explicit": bool(data.get("explicit")),
        "thumb": thumb if isinstance(thumb, str) and thumb.startswith("https://") else None,
    }


# -- rows ----------------------------------------------------------------------------


def _artist_row(hit: dict) -> Artist:
    first = (hit.get("artists") or [{}])[0]
    name = first.get("name") or "[unknown]"
    key = first.get("id") or name
    aid = ids.youtube_artist_uuid(key)
    row = Artist.get_or_none(Artist.id == aid)
    if row is not None:
        return row
    return library.create_or_get(
        lambda: Artist.create(id=aid, name=name, deezer_id=None),
        lambda: Artist.get_or_none(Artist.id == aid),
    )


def _album_row(hit: dict, artist: Artist) -> Album:
    name = hit.get("album") or hit["title"]
    key = hit.get("album_id") or f"{artist.id}/{name}"
    aid = ids.youtube_album_uuid(key)
    row = Album.get_or_none(Album.id == aid)
    if row is not None:
        return row
    return library.create_or_get(
        lambda: Album.create(
            id=aid, name=name, artist=artist, deezer_id=None, cover_md5=None
        ),
        lambda: Album.get_or_none(Album.id == aid),
    )


def _folder(root: Folder, artist_name: str, album_name: str) -> Folder:
    path = os.path.join(
        root.path, DIR_NAME, library.sanitize(artist_name), library.sanitize(album_name)
    )
    row = Folder.get_or_none(Folder.path == path)
    if row is not None:
        return row
    return library.create_or_get(
        lambda: Folder.create(
            root=False, name=library.sanitize(album_name), path=path, parent=root
        ),
        lambda: Folder.get_or_none(Folder.path == path),
    )


def display_artist(hit: dict) -> str:
    names = [a["name"] for a in hit.get("artists") or [] if a.get("name")]
    return ", ".join(names) or "[unknown]"


def upsert_track(hit: dict, archive_dir: str) -> Track:
    """The row for a hit (created once; nothing is downloaded here)."""
    tid = track_uuid(hit["video_id"])
    row = Track.get_or_none(Track.id == tid)
    if row is not None:
        return row
    root = library.get_root_folder(archive_dir)
    artist = _artist_row(hit)
    album = _album_row(hit, artist)
    folder = _folder(root, artist.name, album.name)
    fname = f"{library.sanitize(hit['title'])} [{hit['video_id']}].opus"
    path = os.path.join(folder.path, fname)
    try:
        with db.atomic():
            return Track.create(
                id=tid,
                deezer_id=None,
                youtube_id=hit["video_id"],
                disc=1,
                number=1,
                title=hit["title"],
                year=None,
                genre=None,
                duration=hit.get("duration") or 0,
                has_art=False,
                album=album,
                artist=artist,
                bitrate=0,  # known once the file is here
                gain=None,
                path=path,
                last_modification=0,  # "not archived", like a Deezer row
                root_folder=root,
                folder=folder,
            )
    except IntegrityError:
        row = Track.get_or_none(Track.id == tid)
        if row is None:
            raise
        return row


def find_track(video_id: str) -> Track | None:
    if not valid_video_id(video_id):
        return None
    return Track.get_or_none(Track.id == track_uuid(video_id))


# -- the audio ---------------------------------------------------------------------


def _lock_for(key: str) -> threading.Lock:
    with _lock:
        lk = _track_locks.get(key)
        if lk is None:
            lk = _track_locks[key] = threading.Lock()
        return lk


# yt-dlp words its errors for people; these are the ones that mean the video
# itself cannot be played — never the network, never a refusal of US.
_GONE_MARKERS = (
    "video unavailable",
    "this video is not available",
    "this video has been removed",
    "private video",
    "this video is private",
    "account associated with this video has been terminated",
    "not made this video available in your country",
    "blocked it in your country",
    "copyright",
)


def _classify(exc: Exception) -> YoutubeError:
    text = str(exc).lower()
    if (
        "429" in text
        or "too many requests" in text
        or "not a bot" in text
        or "sign in to confirm" in text
    ):
        _hold(HOLD_REFUSED, "YouTube refused the download")
        return YoutubeError(str(exc))
    if any(m in text for m in _GONE_MARKERS):
        return YoutubeUnavailable(str(exc))
    if any(
        m in text
        for m in ("timed out", "connection", "unable to download", "network", "resolve")
    ):
        _hold(HOLD_TRANSPORT, "YouTube could not be reached")
    return YoutubeError(str(exc))


def looks_like_audio(head: bytes) -> bool:
    """An Ogg page or an MP4/M4A box: what the remux can produce."""
    return head[:4] == b"OggS" or head[4:8] == b"ftyp"


def _download(video_id: str, workdir: str) -> str:
    """One extraction + one download; returns the remuxed file's path."""
    from yt_dlp import YoutubeDL

    opts = {
        # Opus (251/250) first; AAC only when YouTube has no Opus for it.
        "format": "bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio",
        "outtmpl": os.path.join(workdir, "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": 15,
        "retries": 2,
        "fragment_retries": 2,
        "cachedir": False,
        "js_runtimes": {"deno": {}, "node": {}, "quickjs": {}},
        # "best": keep the codec YouTube sent and only change the container —
        # webm/Opus becomes an Ogg .opus, not one sample re-encoded.
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "best"}],
    }
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(
            f"https://music.youtube.com/watch?v={video_id}", download=True
        )
    for req in (info or {}).get("requested_downloads") or []:
        fp = req.get("filepath")
        if fp and os.path.isfile(fp):
            return fp
    for fn in os.listdir(workdir):
        if fn.startswith(video_id) and not fn.endswith((".part", ".ytdl")):
            return os.path.join(workdir, fn)
    raise YoutubeError("yt-dlp produced no file")


def download_audio(video_id: str, workdir: str) -> str:
    """The audio of a video into ``workdir``, for the auto-match to LISTEN to.

    Same download, same slots, same holds as a first play — but nothing is
    archived and no row is touched: a candidate the comparison rejects leaves
    nothing behind. The one it accepts is handed to ``ensure_archived``
    (``produced=``) so it is not downloaded twice.
    """
    if not valid_video_id(video_id):
        raise YoutubeError("not a YouTube video id")
    _check_held()
    with _download_slots:
        try:
            return _download(video_id, workdir)
        except YoutubeError:
            raise
        except Exception as exc:
            raise _classify(exc) from exc


def fetch_thumbnail(url: str | None) -> bytes | None:
    """The square art (Google's image CDN, not YouTube's API). Best-effort."""
    if not url or not url.startswith("https://"):
        return None
    try:
        from deezerpy import _Session

        with _Session() as s:
            r = s.get(url, timeout=(5, 10))
        if r.status_code == 200 and r.content[:3] == b"\xff\xd8\xff":
            return r.content[: 4 * 1024 * 1024]
        if r.status_code == 200 and r.content[:8] == b"\x89PNG\r\n\x1a\n":
            return _to_jpeg(r.content)
    except Exception:
        logger.debug("YouTube art fetch failed for %s", url, exc_info=True)
    return None


def _to_jpeg(data: bytes) -> bytes | None:
    try:
        from io import BytesIO

        from PIL import Image

        out = BytesIO()
        Image.open(BytesIO(data)).convert("RGB").save(out, "JPEG", quality=90)
        return out.getvalue()
    except Exception:
        return None


def tag_file(path: str, hit: dict, cover: bytes | None) -> None:
    """Title, artists, album and the art, in the container's own tag format."""
    import base64

    names = [a["name"] for a in hit.get("artists") or [] if a.get("name")]
    album = hit.get("album") or hit["title"]
    if path.endswith((".opus", ".ogg")):
        from mutagen.flac import Picture
        from mutagen.oggopus import OggOpus

        audio = OggOpus(path)
        audio["title"] = hit["title"]
        if names:
            audio["artist"] = names
            audio["albumartist"] = names[0]
        audio["album"] = album
        audio["comment"] = f"https://music.youtube.com/watch?v={hit['video_id']}"
        if cover:
            pic = Picture()
            pic.type, pic.mime, pic.data = 3, "image/jpeg", cover
            audio["metadata_block_picture"] = [
                base64.b64encode(pic.write()).decode("ascii")
            ]
        audio.save()
        return
    if path.endswith((".m4a", ".mp4")):
        from mutagen.mp4 import MP4, MP4Cover

        audio = MP4(path)
        audio["\xa9nam"] = hit["title"]
        if names:
            audio["\xa9ART"] = names
            audio["aART"] = names[0]
        audio["\xa9alb"] = album
        if cover:
            audio["covr"] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_JPEG)]
        audio.save()


def _probe(path: str) -> tuple[int, int]:
    """(duration s, bitrate kbit/s) of the archived file."""
    try:
        import mutagen

        f = mutagen.File(path)
        duration = int(getattr(f.info, "length", 0) or 0)
    except Exception:
        duration = 0
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    bitrate = int(size * 8 / duration / 1000) if duration > 0 and size else 0
    return duration, bitrate


def save_metadata(track: Track, hit: dict) -> None:
    """A ``<track>.json`` sidecar: where the file came from, readable without
    the database. A whitelist — nothing of yt-dlp's (signed URLs) ever lands."""
    data = {
        "source": "youtube",
        "video_id": hit["video_id"],
        "title": hit["title"],
        "artists": [a["name"] for a in hit.get("artists") or []],
        "album": hit.get("album"),
        "album_id": hit.get("album_id"),
        "url": f"https://music.youtube.com/watch?v={hit['video_id']}",
    }
    with open(library.metadata_path(track), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)


def hit_from_track(track: Track) -> dict:
    """What we know about a row's video without asking anyone."""
    return {
        "video_id": track.youtube_id,
        "title": track.title,
        "artists": [{"id": "", "name": track.artist.name}],
        "album": track.album.name,
        "album_id": None,
        "duration": track.duration or 0,
        "explicit": False,
        "thumb": None,
    }


def ensure_archived(
    track: Track, archive_dir: str, hit: dict | None = None, produced: str | None = None
) -> Track:
    """Download, tag and publish the audio of a YouTube row. Idempotent.

    Serialized per video: two listeners pressing play at once cost ONE
    download. Raises ``YoutubeUnavailable`` (and records it) only when YouTube
    answered that the video is gone.
    """
    vid = track.youtube_id
    if not valid_video_id(vid):
        raise YoutubeError("not a YouTube track")
    if os.path.isfile(track.path):
        return track
    with _lock_for(vid):
        track = Track.get_by_id(track.id)  # another thread may have just done it
        if os.path.isfile(track.path):
            return track
        if not (produced and os.path.isfile(produced)):
            # A file already in hand needs nothing from YouTube.
            _check_held()
        hit = hit or hit_from_track(track)
        staging = os.path.join(archive_dir, STAGING_DIR)
        os.makedirs(staging, exist_ok=True)
        workdir = tempfile.mkdtemp(prefix=f"{vid}.", dir=staging)
        try:
            if produced and os.path.isfile(produced):
                # Already downloaded (the auto-match listened to it): moved in,
                # tagged and published like a download of our own.
                moved = os.path.join(workdir, os.path.basename(produced))
                shutil.move(produced, moved)
                produced = moved
            else:
                produced = None
            with contextlib.nullcontext() if produced else _download_slots:
                logger.info("Archiving YouTube video %s", vid)
                try:
                    if produced is None:
                        produced = _download(vid, workdir)
                except YoutubeError:
                    raise
                except Exception as exc:
                    err = _classify(exc)
                    if isinstance(err, YoutubeUnavailable):
                        logger.info("YouTube has no playable source for %s", vid)
                        library.mark_unavailable(track)
                    raise err from exc
            with open(produced, "rb") as fh:
                head = fh.read(16)
            if not looks_like_audio(head):
                raise YoutubeError("YouTube sent something that is not audio")
            cover = fetch_thumbnail(hit.get("thumb"))
            try:
                tag_file(produced, hit, cover)
            except Exception as exc:  # tags never stop the music
                logger.warning("Tagging %s failed: %s", produced, exc)
            ext = os.path.splitext(produced)[1].lower() or ".opus"
            dest = os.path.splitext(track.path)[0] + ext
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            os.replace(produced, dest)  # same filesystem: atomic
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

        duration, bitrate = _probe(dest)
        if cover:
            try:
                library.save_album_cover(track.folder, cover)
            except Exception:
                logger.debug("Cover sidecar failed for %s", dest, exc_info=True)
        track.path = dest
        track.duration = duration or track.duration
        track.bitrate = bitrate
        track.has_art = bool(cover)
        track.last_modification = int(time.time())
        track.unavailable = None
        track.save()
        try:
            save_metadata(track, hit)
        except Exception:
            logger.debug("Metadata sidecar failed for %s", dest, exc_info=True)
        try:
            from . import analysis as analysis_mod

            analysis_mod.queue_analysis(track, None)
        except Exception:
            logger.debug("Queueing analysis failed for %s", dest, exc_info=True)
        return track

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
from uuid import uuid4

from ..db import Album, Artist, Playlist, Track, PodcastChannel, PodcastEpisode
from . import ids, library
from .metadata import meta_from_gw, tag_file
from .provider import EXT_FOR_FORMAT, NOMINAL_BITRATE, DeezerError

logger = logging.getLogger(__name__)

# Audio mimetype for an archived file, by extension (FLAC normally; MP3 when
# Deezer had no lossless source for the track).
_MIME_FOR_EXT = {".flac": "audio/flac", ".mp3": "audio/mpeg"}


def _mime_for_path(path) -> str:
    return _MIME_FOR_EXT.get(os.path.splitext(str(path))[1].lower(), "audio/flac")


def _fixed_ext_path(path: str, fmt: str) -> str:
    """The archive path's extension was guessed at import time; correct it to
    match the format actually obtained (e.g. FLAC unavailable -> MP3)."""
    ext = EXT_FOR_FORMAT.get(fmt, ".mp3")
    base, cur_ext = os.path.splitext(path)
    return base + ext if cur_ext.lower() != ext else path

_LINK_RE = re.compile(
    r"(?:deezer\.com|deezer\.page\.link|dzr\.page\.link)/(?:[a-z]{2}/)?"
    r"(track|album|playlist|artist|show|episode)/(\d+)"
)


def parse_deezer_ref(ref: str):
    """Parse a Deezer URL or ``type:id`` / ``type id`` into ``(type, id)``."""
    ref = str(ref).strip()
    m = _LINK_RE.search(ref)
    if m:
        return m.group(1), m.group(2)
    m = re.fullmatch(r"(track|album|playlist|artist|show|episode)[ :/](\d+)", ref)
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
        track.path = _fixed_ext_path(track.path, fmt)

        logger.info("Archiving Deezer track %s (%s) -> %s", track.deezer_id, fmt, track.path)
        provider.download_to(url, used_id, track.path)
        _finalize_archive(provider, track, fmt, info)


def _finalize_archive(provider, track: Track, fmt: str, info: dict) -> None:
    """Tag the freshly-archived file and update the Track row (bitrate / art)."""
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


def ensure_episode_archived(provider, episode: PodcastEpisode) -> None:
    """Fetch a podcast episode's MP3 into its archive path (idempotent).

    Same contract as ``ensure_archived`` but for spoken-word episodes: the
    source is an external MP3 (no FLAC, no Blowfish), archived once then served
    locally. Serialized per Deezer episode id.
    """
    if episode.path and os.path.isfile(episode.path):
        return

    with provider.track_lock(f"ep:{episode.deezer_id}"):
        if episode.path and os.path.isfile(episode.path):
            return

        path = library.episode_archive_path(
            provider.archive_dir,
            episode.channel.title,
            episode.publish_date,
            episode.title,
        )
        episode.status = "downloading"
        episode.save()
        logger.info("Archiving Deezer episode %s -> %s", episode.deezer_id, path)
        try:
            url = provider.resolve_episode(episode)
            provider.download_episode_to(url, path)
        except Exception:
            episode.status = "error"
            episode.save()
            raise

        episode.path = path
        episode.bitrate = _bitrate_for(path, "MP3_128", episode.duration)
        episode.status = "completed"
        episode.save()


def find_local_episode(episode_id) -> PodcastEpisode | None:
    """The already-imported PodcastEpisode for a Deezer episode id, or None."""
    try:
        return PodcastEpisode[ids.episode_uuid(episode_id)]
    except PodcastEpisode.DoesNotExist:
        return None


def import_show(provider, user, show_id, episode_limit=None) -> PodcastChannel:
    """Import a Deezer show + its episodes (metadata only) as rows.

    ``episode_limit`` caps how many recent episodes to import (None = all).
    """
    page = provider.get_show_page(show_id, nb=episode_limit or 200)
    channel = library.upsert_channel(user, library.normalize_show(page["DATA"]))
    if episode_limit:
        raw_eps = page.get("EPISODES", {}).get("data", [])[:episode_limit]
    else:
        raw_eps = provider.get_show_episodes(show_id)
    for raw in raw_eps:
        library.upsert_episode(channel, library.normalize_episode(raw))
    return channel


def open_live_stream(provider, track: Track, on_abort=None):
    """Stream-first playback for a cold (not-yet-archived) track.

    Resolves the source synchronously (fast — just URL/token calls), then returns
    ``(mimetype, generator)``. The generator yields the decrypted audio to the
    client **as it downloads it**, teeing every chunk to a temp file; on full
    completion it atomically publishes + tags the archive, so the very next play
    is served from disk (seekable, transcodable). This is what lets a clicked
    track start almost immediately instead of waiting for the whole FLAC.

    The first live play is not seekable (no Content-Length), exactly like the
    existing live Opus transcode. If the client disconnects before the download
    finishes, the partial is dropped and ``on_abort`` (if given) is called so the
    track can still be archived in the background.
    """
    url, fmt, info, used_id = provider.resolve(track.deezer_id)
    track.path = _fixed_ext_path(track.path, fmt)
    dest = Path(track.path)
    mimetype = _mime_for_path(dest)

    def generate():
        # Archived in the gap between resolve and first read? Serve from disk.
        if dest.is_file():
            with open(dest, "rb") as fh:
                yield from iter(lambda: fh.read(65536), b"")
            return

        # Unique temp name so a concurrent prefetch of the same track can't write
        # the same .part file; whoever finishes first publishes, the rest discard.
        tmp = dest.with_name(f"{dest.name}.{uuid4().hex}.part")
        complete = False
        try:
            tmp.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp, "wb") as fh:
                for chunk in provider.iter_decrypted(url, used_id):
                    fh.write(chunk)
                    yield chunk
            complete = True
        finally:
            try:
                if complete and not dest.is_file():
                    with provider.track_lock(track.deezer_id):
                        if dest.is_file():
                            _safe_unlink(tmp)
                        else:
                            os.replace(tmp, dest)
                            _finalize_archive(provider, track, fmt, info)
                else:
                    _safe_unlink(tmp)
                    # Client gave up mid-download — make sure it still gets cached.
                    if not complete and not dest.is_file() and on_abort is not None:
                        on_abort()
            except Exception:
                logger.warning(
                    "Live archive finalize failed for %s", track.deezer_id, exc_info=True
                )

    return mimetype, generate()


def _safe_unlink(path) -> None:
    try:
        Path(path).unlink()
    except OSError:
        pass


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
                    try:
                        ch = PodcastChannel[key]
                        data = (
                            provider.fetch_cover(ch.cover_art_md5)
                            if ch.cover_art_md5
                            else None
                        )
                    except PodcastChannel.DoesNotExist:
                        try:
                            ep = PodcastEpisode[key]
                            md5 = ep.image_md5 or ep.channel.cover_art_md5
                            data = provider.fetch_cover(md5) if md5 else None
                        except PodcastEpisode.DoesNotExist:
                            return None

    if not data:
        return None
    return cache.set(f"{eid}-deezer-cover", data)

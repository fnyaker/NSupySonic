# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2022 Alban 'spl0k' Féron
#               2018-2019 Carey 'pR0Ps' Metcalfe
#
# Distributed under terms of the GNU AGPLv3 license.

import hashlib
import json
import logging
import mediafile
import mimetypes
import os.path
import re
import shlex
import subprocess
import zlib

from flask import request, Response, send_file
from flask import current_app
from PIL import Image
from zipstream import ZipStream

from ..cache import CacheMiss
from ..db import Track, Album, Artist, Folder, PodcastEpisode, now
from ..covers import EXTENSIONS

from . import get_entity, get_entity_id, api_routing
from .exceptions import (
    GenericError,
    NotFound,
    ServerError,
    UnsupportedParameter,
)

logger = logging.getLogger(__name__)

# Cover art comes from files users upload, so it is attacker-controlled input to
# PIL. Cap the decompressed pixel count (a "decompression bomb" is a tiny file
# that expands to gigabytes) and the requested thumbnail size.
MAX_COVER_PIXELS = 64_000_000  # 8000x8000
MAX_COVER_SIZE = 2048
if Image.MAX_IMAGE_PIXELS is None or Image.MAX_IMAGE_PIXELS > MAX_COVER_PIXELS:
    Image.MAX_IMAGE_PIXELS = MAX_COVER_PIXELS


def _ensure_deezer_archived(res):
    """Lazily fetch+archive a Deezer-backed track's FLAC on first access.

    No-op (and no Deezer imports) when the proxy is disabled or the track is a
    regular local file already on disk.
    """
    provider = getattr(current_app, "deezer", None)
    if provider is None or not getattr(res, "deezer_id", None):
        return
    if os.path.isfile(res.path):
        return
    from ..deezer.archive import ensure_archived

    try:
        ensure_archived(provider, res)
    except Exception as e:
        logger.warning("Deezer archiving failed for track %s: %s", res.id, e)
        raise ServerError("Could not fetch track from Deezer")


def _ensure_episode_archived(episode):
    """Lazily fetch+archive a podcast episode's MP3 on first access."""
    provider = getattr(current_app, "deezer", None)
    if provider is None:
        raise ServerError("Deezer proxy is not enabled")
    if episode.path and os.path.isfile(episode.path):
        return
    from ..deezer.archive import ensure_episode_archived

    try:
        ensure_episode_archived(provider, episode)
    except Exception as e:
        logger.warning("Deezer archiving failed for episode %s: %s", episode.id, e)
        raise ServerError("Could not fetch episode from Deezer")


def _resolve_stream_entity():
    """Resolve a stream/download id to an archived Track or PodcastEpisode.

    Tracks are tried first (the common case); a Deezer-backed track or podcast
    episode is fetched+archived here so the rest of the pipeline serves a local
    file exactly as for any other media.
    """
    uid = get_entity_id(Track, request.values["id"])
    try:
        res = Track[uid]
        if not res.readable_by(request.user):
            # Another user's private upload: same answer as a nonexistent id, so
            # the endpoint can't be used to probe what others have uploaded.
            raise NotFound("Track")
        _ensure_deezer_archived(res)
        return res
    except Track.DoesNotExist:
        pass
    try:
        episode = PodcastEpisode[uid]
    except PodcastEpisode.DoesNotExist as e:
        raise NotFound("Track") from e
    _ensure_episode_archived(episode)
    return episode


def _prefetch_next(res):
    """Queue the next not-yet-archived Deezer tracks of the same album."""
    pf = getattr(current_app, "deezer_prefetch", None)
    if pf is None or not getattr(res, "deezer_id", None):
        return
    count = int(current_app.config["DEEZER"].get("preload_count") or 2)
    siblings = (
        Track.select()
        .where(
            Track.album == res.album,
            Track.deezer_id.is_null(False),
            (Track.disc > res.disc)
            | ((Track.disc == res.disc) & (Track.number > res.number)),
        )
        .order_by(Track.disc, Track.number)
        .limit(count)
    )
    pf.enqueue_many(siblings, count)


def prepare_transcoding_cmdline(
    base_cmdline, res, input_format, output_format, output_bitrate
):
    if not base_cmdline:
        return None
    ret = shlex.split(base_cmdline)
    ret = [
        part.replace("%srcpath", res.path)
        .replace("%srcfmt", input_format)
        .replace("%outfmt", output_format)
        .replace("%outrate", str(output_bitrate))
        .replace("%title", res.title)
        .replace("%album", res.album.name)
        .replace("%artist", res.artist.name)
        .replace("%tracknumber", str(res.number))
        .replace("%totaltracks", str(res.album.tracks.count()))
        .replace("%discnumber", str(res.disc))
        .replace("%genre", res.genre if res.genre else "")
        .replace("%year", str(res.year) if res.year else "")
        for part in ret
    ]
    return ret


@api_routing("/stream")
def stream_media():
    res = _resolve_stream_entity()

    if "timeOffset" in request.values:
        raise UnsupportedParameter("timeOffset")
    if "size" in request.values:
        raise UnsupportedParameter("size")

    maxBitRate, request_format, estimateContentLength = map(
        request.values.get, ("maxBitRate", "format", "estimateContentLength")
    )
    if request_format:
        request_format = request_format.lower()
        # The format becomes part of the transcode cache filename, so constrain
        # it to a safe charset (no path separators / dots) to prevent traversal.
        if not re.fullmatch(r"[a-z0-9]{1,8}", request_format):
            raise GenericError("Invalid format")

    src_suffix = res.suffix()
    dst_suffix = res.suffix()
    dst_bitrate = res.bitrate
    dst_mimetype = res.mimetype

    config = current_app.config["TRANSCODING"]
    prefs = request.client

    using_default_format = False
    if request_format:
        dst_suffix = src_suffix if request_format == "raw" else request_format
    elif prefs.format:
        dst_suffix = prefs.format
    else:
        using_default_format = True
        dst_suffix = src_suffix

    if prefs.bitrate and prefs.bitrate < dst_bitrate:
        dst_bitrate = prefs.bitrate

    if maxBitRate:
        maxBitRate = int(maxBitRate)

        if dst_bitrate > maxBitRate and maxBitRate != 0:
            dst_bitrate = maxBitRate
            if using_default_format:
                dst_suffix = config.get("default_transcode_target") or dst_suffix

    # Find new mimetype if we're changing formats
    if dst_suffix != src_suffix:
        dst_mimetype = (
            mimetypes.guess_type("dummyname." + dst_suffix, False)[0]
            or "application/octet-stream"
        )

    if dst_suffix != src_suffix or dst_bitrate != res.bitrate:
        # Requires transcoding
        cache = current_app.transcode_cache
        cache_key = f"{res.id}-{dst_bitrate}.{dst_suffix}"

        try:
            response = send_file(
                cache.get(cache_key), mimetype=dst_mimetype, conditional=True
            )
        except CacheMiss:
            transcoder = config.get(f"transcoder_{src_suffix}_{dst_suffix}")
            decoder = config.get("decoder_" + src_suffix) or config.get("decoder")
            encoder = config.get("encoder_" + dst_suffix) or config.get("encoder")
            if not transcoder and (not decoder or not encoder):
                transcoder = config.get("transcoder")
                if not transcoder:
                    message = "No way to transcode from {} to {}".format(
                        src_suffix, dst_suffix
                    )
                    logger.info(message)
                    raise GenericError(message)

            transcoder, decoder, encoder = (
                prepare_transcoding_cmdline(x, res, src_suffix, dst_suffix, dst_bitrate)
                for x in (transcoder, decoder, encoder)
            )
            try:
                # stderr is sent to /dev/null: an unread, inherited stderr can
                # fill its pipe buffer under a chatty transcoder and deadlock
                # the worker (it blocks writing stderr while we block reading
                # stdout) — a source of "random freezes" under load.
                if transcoder:
                    dec_proc = None
                    proc = subprocess.Popen(
                        transcoder, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
                    )
                else:
                    dec_proc = subprocess.Popen(
                        decoder, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
                    )
                    proc = subprocess.Popen(
                        encoder,
                        stdin=dec_proc.stdout,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                    )
            except OSError:
                raise ServerError("Error while running the transcoding process")

            if estimateContentLength == "true":
                estimate = dst_bitrate * 1000 * res.duration // 8
            else:
                estimate = None

            def transcode():
                while True:
                    data = proc.stdout.read(8192)
                    if not data:
                        break
                    yield data

            def kill_processes():
                if dec_proc is not None:
                    dec_proc.kill()
                proc.kill()

            def handle_transcoding():
                try:
                    sent = 0
                    for data in transcode():
                        sent += len(data)
                        yield data
                except (Exception, SystemExit, KeyboardInterrupt):
                    # Make sure child processes are always killed
                    kill_processes()
                    raise
                except GeneratorExit:
                    # Try to transcode/send more data if we're close to the end.
                    # The calling code have to support this as yielding more data
                    # after a GeneratorExit would normally raise a RuntimeError.
                    # Hopefully this generator is only used by the cache which
                    # handles this.
                    if estimate and sent >= estimate * 0.95:
                        yield from transcode()
                    else:
                        kill_processes()
                        raise
                finally:
                    if dec_proc is not None:
                        dec_proc.stdout.close()
                        dec_proc.wait()
                    proc.stdout.close()
                    proc.wait()

            resp_content = cache.set_generated(cache_key, handle_transcoding)

            logger.info(
                "Transcoding track {0.id} for user {1.id}. Source: {2} at {0.bitrate}kbps. Dest: {3} at {4}kbps".format(
                    res, request.user, src_suffix, dst_suffix, dst_bitrate
                )
            )
            response = Response(resp_content, mimetype=dst_mimetype)
            if estimate is not None:
                response.headers.add("Content-Length", estimate)
    else:
        response = send_file(res.path, mimetype=dst_mimetype, conditional=True)

    # Play bookkeeping + album prefetch only apply to real Tracks; podcast
    # episodes aren't part of the play-history / last_play FK model.
    if isinstance(res, Track):
        res.play_count = res.play_count + 1
        res.last_play = now()
        res.save()

        user = request.user
        user.last_play = res
        user.last_play_date = now()
        user.save()

        _prefetch_next(res)

    return response


@api_routing("/download")
def download_media():
    id = request.values["id"]

    try:
        uid = get_entity_id(Track, id)
    except GenericError:
        uid = None
    try:
        fid = get_entity_id(Folder, id)
    except GenericError:
        fid = None

    if uid is None and fid is None:
        raise GenericError("Invalid ID")

    if uid is not None:
        try:
            rv = Track[uid]
            if not rv.readable_by(request.user):
                raise NotFound("Track")
            _ensure_deezer_archived(rv)
            return send_file(rv.path, mimetype=rv.mimetype, conditional=True)
        except Track.DoesNotExist:
            try:  # Podcast episode -> single file
                episode = PodcastEpisode[uid]
                _ensure_episode_archived(episode)
                return send_file(
                    episode.path, mimetype=episode.mimetype, conditional=True
                )
            except PodcastEpisode.DoesNotExist:
                pass
            try:  # Album -> stream zipped tracks
                rv = Album[uid]
            except Album.DoesNotExist as e:
                raise NotFound("Track or Album") from e
    else:
        try:  # Folder -> stream zipped tracks, non recursive
            rv = Folder[fid]
        except Folder.DoesNotExist as e:
            raise NotFound("Folder") from e

    # Stream a zip of multiple files to the client
    z = ZipStream(sized=True)
    if isinstance(rv, Folder):
        # Zip the folder's *tracks*, not its directory tree. `add_path(recurse)`
        # shipped every file living under the folder — other users' private
        # uploads, stray .txt/.log/.conf files, anything an admin happened to
        # keep next to the music — to any logged-in account.
        prefix = rv.path.rstrip(os.sep) + os.sep
        tracks = Track.visible(
            Track.select().where(Track.path.startswith(prefix)), request.user
        )
        seen = set()
        for track in tracks:
            filename = os.path.basename(track.path)
            name, ext = os.path.splitext(filename)
            index = 0
            while filename in seen:
                index += 1
                filename = f"{name} ({index})"
                if ext:
                    filename += ext
            z.add_path(track.path, filename)
            seen.add(filename)

        cover_path = _cover_from_collection(rv, extract=False)
        if cover_path:
            z.add_path(cover_path)
    else:
        # Add tracks + cover art to the zip, preventing potential naming collisions
        seen = set()
        for track in Track.visible(rv.tracks, request.user):
            filename = os.path.basename(track.path)
            name, ext = os.path.splitext(filename)
            index = 0
            while filename in seen:
                index += 1
                filename = f"{name} ({index})"
                if ext:
                    filename += ext

            z.add_path(track.path, filename)
            seen.add(filename)

        cover_path = _cover_from_collection(rv, extract=False)
        if cover_path:
            z.add_path(cover_path)

    if not z:
        raise GenericError("Nothing to download")

    resp = Response(z, mimetype="application/zip")
    resp.headers["Content-Disposition"] = f"attachment; filename={rv.name}.zip"
    resp.headers["Content-Length"] = len(z)
    return resp


def _cover_from_track(obj):
    """Extract and return a path to a track's cover art

    Returns None if no cover art is available.
    """
    cache = current_app.cache
    cache_key = f"{obj.id}-cover"
    try:
        return cache.get(cache_key)
    except CacheMiss:
        try:
            return cache.set(cache_key, mediafile.MediaFile(obj.path).art)
        except mediafile.UnreadableFileError:
            return None


def _cover_from_collection(obj, extract=True):
    """Get a path to cover art from a collection (Album, Folder)

    If `extract` is True, will fall back to extracting cover art from tracks
    Returns None if no cover art is available.
    """
    cover_path = None

    if isinstance(obj, Folder) and obj.cover_art:
        cover_path = os.path.join(obj.path, obj.cover_art)

    elif isinstance(obj, Album):
        track_with_folder_cover = (
            obj.tracks.join(Folder, on=Track.folder)
            .where(Folder.cover_art.is_null(False))
            .first()
        )
        if track_with_folder_cover is not None:
            cover_path = _cover_from_collection(track_with_folder_cover.folder)

        if not cover_path and extract:
            track_with_embedded = obj.tracks.where(Track.has_art).first()
            if track_with_embedded is not None:
                cover_path = _cover_from_track(track_with_embedded)

    if not cover_path or not os.path.isfile(cover_path):
        return None
    return cover_path


def _get_cover_path(eid):
    try:
        fid = get_entity_id(Folder, eid)
    except GenericError:
        fid = None
    try:
        uid = get_entity_id(Track, eid)
    except GenericError:
        uid = None

    if not fid and not uid:
        raise GenericError("Invalid ID")

    if fid:
        try:
            return _cover_from_collection(Folder[fid])
        except Folder.DoesNotExist:
            pass
    elif uid:
        try:
            return _cover_from_track(Track[uid])
        except Track.DoesNotExist:
            pass

        try:
            return _cover_from_collection(Album[uid])
        except Album.DoesNotExist:
            pass

    raise NotFound("Entity")


@api_routing("/getCoverArt")
def cover_art():
    cache = current_app.cache

    eid = request.values["id"]
    try:
        cover_path = _get_cover_path(eid)
    except NotFound:
        cover_path = None

    if not cover_path:
        provider = getattr(current_app, "deezer", None)
        if provider is not None:
            from ..deezer.archive import deezer_cover_path

            cover_path = deezer_cover_path(provider, cache, eid)

    if not cover_path:
        raise NotFound("Cover art")

    size = request.values.get("size")
    if size:
        # Clamp: an unbounded size is a memory/CPU amplifier on the resize path
        # (and every real client asks for a thumbnail, not a 100k-pixel image).
        size = max(1, min(int(size), MAX_COVER_SIZE))
    else:
        # If the cover was extracted from a track it won't have an accurate
        # extension for Flask to derive the mimetype from - derive it from the
        # contents instead.
        mimetype = None
        if os.path.splitext(cover_path)[1].lower() not in EXTENSIONS:
            with Image.open(cover_path) as im:
                mimetype = f"image/{im.format.lower()}"
        return send_file(cover_path, mimetype=mimetype)

    with Image.open(cover_path) as im:
        mimetype = f"image/{im.format.lower()}"
        if size > im.width and size > im.height:
            return send_file(cover_path, mimetype=mimetype)

        cache_key = f"{eid}-cover-{size}"
        try:
            return send_file(cache.get(cache_key), mimetype=mimetype)
        except CacheMiss:
            im.thumbnail([size, size], Image.Resampling.LANCZOS)
            with cache.set_fileobj(cache_key) as fp:
                im.save(fp, im.format)
            return send_file(cache.get(cache_key), mimetype=mimetype)


def lyrics_response_for_track(track, lyrics):
    return request.formatter(
        "lyrics",
        {"artist": track.album.artist.name, "title": track.title, "value": lyrics},
    )


@api_routing("/getLyrics")
def lyrics():
    artist = request.values["artist"]
    title = request.values["title"]

    query = (
        Track.select()
        .join(Artist)
        .where(Track.title.contains(title), Artist.name.contains(artist))
    )
    for track in query:
        # Read from track metadata
        lyrics = mediafile.MediaFile(track.path).lyrics
        if lyrics is not None:
            lyrics = lyrics.replace("\x00", "").strip()
            if lyrics:
                logger.debug("Found lyrics in file metadata: " + track.path)
                return lyrics_response_for_track(track, lyrics)

        # Look for a text file with the same name of the track
        lyrics_path = os.path.splitext(track.path)[0] + ".txt"
        if os.path.exists(lyrics_path):
            logger.debug("Found lyrics file: " + lyrics_path)

            try:
                with open(lyrics_path) as f:
                    lyrics = f.read()
            except UnicodeError:
                # Lyrics file couldn't be decoded. Rather than displaying an error, try
                # with the potential next files or return no lyrics. Log it anyway.
                logger.warning("Unsupported encoding for lyrics file " + lyrics_path)
                continue

            return lyrics_response_for_track(track, lyrics)

    if not current_app.config["WEBAPP"]["online_lyrics"]:
        return request.formatter("lyrics", {})

    # Create a stable, unique, filesystem-compatible identifier for the artist+title
    unique = hashlib.md5(
        json.dumps([x.lower() for x in (artist, title)]).encode("utf-8")
    ).hexdigest()
    cache_key = f"lyrics-{unique}"

    lyrics = {}
    try:
        lyrics = json.loads(
            zlib.decompress(current_app.cache.get_value(cache_key)).decode("utf-8")
        )
    except (CacheMiss, zlib.error, TypeError, ValueError):
        # LRCLIB (https + JSON) instead of the old ChartLyrics endpoint, which
        # was fetched over plain http and parsed as XML — an on-path attacker
        # could answer with an entity-expansion bomb, and the result was then
        # CACHED, making the poisoning persistent. LRCLIB is the same source the
        # Deezer archiver already uses, so this drops a whole parser (and a
        # cleartext dependency) instead of trying to harden it.
        from ..deezer.lyrics import fetch_lrclib

        found = fetch_lrclib(title, artist)
        if found and found.get("text"):
            lyrics = {"artist": artist, "title": title, "value": found["text"]}
            current_app.cache.set(
                cache_key, zlib.compress(json.dumps(lyrics).encode("utf-8"), 9)
            )

    return request.formatter("lyrics", lyrics)

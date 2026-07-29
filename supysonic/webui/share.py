# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Sharing endpoints for the web player's share sheet.

Three pieces, all working on the *archived* file (archiving it on demand, the
same way streaming does):

- ``/share/waveform/<id>``  peaks for the zoomable timeline (cached JSON);
- ``/share/file/<id>``      the whole file as a named download (optionally
                            transcoded to a widely-compatible format);
- ``/share/clip/<id>``      an ffmpeg-cut excerpt (bounded length, cached).

Ids are universal track ids: a Deezer numeric id, a local track UUID or a
podcast episode UUID — exactly what ``/api/stream`` accepts.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import uuid

from flask import current_app, jsonify, request, send_file

from ..db import PodcastEpisode, Track
from . import _may_access_track, _need_provider, _valid_id, login_required, webapi

logger = logging.getLogger(__name__)

# Waveform resolution: ~2 buckets per second, bounded — enough detail to stay
# sharp at high zoom without shipping megabytes for a 3-hour episode.
_PEAKS_MIN = 400
_PEAKS_MAX = 4000

# A shared clip is an excerpt, not a redistribution channel: bound its length.
CLIP_MAX_SECONDS = 600

# fmt -> (ffmpeg codec args, extension, mimetype). MP3 320 is the "opens
# anywhere" choice for messaging apps; AAC/m4a is the Apple-native equivalent;
# FLAC is the exact archived audio.
#
# The m4a (MP4) muxer needs a seekable output to place its moov atom, but the
# clip generator writes to a pipe — ``frag_keyframe+empty_moov`` produces a
# fragmented MP4 that streams to a pipe instead of erroring. ``aac`` is
# ffmpeg's always-available native encoder (no libfdk build needed).
_FORMATS = {
    "mp3": (["-c:a", "libmp3lame", "-b:a", "320k", "-f", "mp3"], "mp3", "audio/mpeg"),
    "m4a": (
        [
            "-c:a", "aac", "-b:a", "256k",
            "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4",
        ],
        "m4a",
        "audio/mp4",
    ),
    "flac": (["-c:a", "flac", "-f", "flac"], "flac", "audio/flac"),
}

_FNAME_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _resolve_media(mid):
    """(track, episode) for a universal id — a Deezer numeric id or a UUID."""
    from ..deezer import archive

    if _valid_id(mid):
        return archive.find_local_track(mid), None
    try:
        key = uuid.UUID(str(mid))
    except ValueError:
        return None, None
    try:
        track = Track[key]
        # Another user's private upload reads as "not found" — the share sheet
        # (waveform / full file / clip) was a straight read of anyone's file.
        return (track if _may_access_track(track) else None), None
    except Track.DoesNotExist:
        pass
    try:
        return None, PodcastEpisode[key]
    except PodcastEpisode.DoesNotExist:
        return None, None


def _media_file(mid):
    """Resolve an id to a file on disk, archiving it on demand.

    Returns ``(path, meta, error)``; ``error`` is a ready (response, status)
    tuple when the media can't be produced. ``meta`` carries ``key`` (a stable
    cache id), ``title``, ``artist`` and ``duration``.
    """
    from ..deezer import archive

    track, episode = _resolve_media(mid)

    if episode is not None:
        if not (episode.path and os.path.isfile(episode.path)):
            provider, err = _need_provider()
            if err:
                return None, None, err
            try:
                archive.ensure_episode_archived(provider, episode)
            except Exception:
                logger.warning("share: episode fetch failed for %s", episode.id, exc_info=True)
                return None, None, (jsonify({"error": "episode unavailable"}), 502)
        meta = {
            "key": str(episode.id),
            "title": episode.title,
            "artist": episode.channel.title or "",
            "duration": episode.duration or 0,
        }
        return episode.path, meta, None

    if track is None and _valid_id(mid):
        provider, err = _need_provider()
        if err:
            return None, None, err
        try:
            track = archive.import_track(provider, str(mid))
        except Exception:
            logger.warning("share: metadata fetch failed for %s", mid, exc_info=True)
            return None, None, (jsonify({"error": "track unavailable"}), 502)
    if track is None:
        return None, None, (jsonify({"error": "not found"}), 404)
    if not os.path.isfile(track.path):
        provider, err = _need_provider()
        if err:
            return None, None, err
        try:
            archive.ensure_archived(provider, track)
        except Exception:
            logger.warning("share: archive failed for %s", mid, exc_info=True)
            return None, None, (jsonify({"error": "track unavailable"}), 502)
    meta = {
        "key": str(track.id),
        "title": track.title,
        "artist": track.artist.name,
        "duration": track.duration or 0,
    }
    return track.path, meta, None


def _nice_filename(meta, ext, tag=None):
    """A human filename for the download: ``Artist - Title (tag).ext``."""
    base = f"{meta['artist']} - {meta['title']}" if meta["artist"] else meta["title"]
    base = _FNAME_BAD.sub("_", base).strip() or "audio"
    if tag:
        base = f"{base} ({tag})"
    return base[:150] + "." + ext


def _ts_label(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h}h{m:02}m{s:02}s" if h else f"{m}m{s:02}s"


def _ffmpeg_available():
    return shutil.which("ffmpeg") is not None


def _audio_peaks(path, buckets):
    """Peak amplitude per bucket (0..1), via ffmpeg-decoded 8-bit mono PCM.

    8-bit is plenty of resolution for an on-screen waveform, and it lets the
    per-bucket min/max run at C speed over ``bytes`` — a 3-hour episode decodes
    and reduces in well under a second of Python time.
    """
    cmd = [
        "ffmpeg", "-v", "0", "-i", path,
        "-map", "0:a:0", "-ac", "1", "-ar", "4000", "-f", "u8", "pipe:1",
    ]
    raw = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True
    ).stdout
    if not raw:
        raise ValueError("no audio decoded")
    per = max(1, len(raw) // buckets)
    peaks = []
    for i in range(buckets):
        chunk = raw[i * per : (i + 1) * per]
        # 8-bit PCM is unsigned, silence at 128: the peak is the farthest
        # excursion on either side.
        peaks.append(max(max(chunk) - 128, 128 - min(chunk)) if chunk else 0)
    top = max(peaks) or 1
    return [round(p / top, 3) for p in peaks]


def _clip_generator(path, start, length, codec_args):
    """ffmpeg: cut [start, start+length) out of the archived file, re-encoded.

    ``-ss`` before ``-i`` is the fast (demuxer-level) seek; ``-t`` bounds the
    output duration unambiguously. Tags are carried over so the shared file
    still shows its title/artist.
    """
    cmd = [
        "ffmpeg", "-v", "0",
        "-ss", f"{start:.3f}", "-i", path, "-t", f"{length:.3f}",
        "-map", "0:a:0", "-map_metadata", "0", *codec_args, "pipe:1",
    ]
    # stderr -> /dev/null so an unread, full stderr pipe can't deadlock ffmpeg.
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while True:
            data = proc.stdout.read(8192)
            if not data:
                break
            yield data
    except GeneratorExit:
        proc.kill()
        raise
    finally:
        proc.stdout.close()
        proc.wait()


@webapi.route("/share/waveform/<mid>")
@login_required
def share_waveform(mid):
    """Amplitude peaks + duration for the share sheet's timeline."""
    path, meta, err = _media_file(mid)
    if err:
        return err
    try:
        mtime = int(os.path.getmtime(path))
    except OSError:
        return jsonify({"error": "not found"}), 404

    duration = meta["duration"]
    buckets = max(_PEAKS_MIN, min(int((duration or 240) * 2), _PEAKS_MAX))
    cache = current_app.cache
    key = f"waveform-{meta['key']}-{mtime}-{buckets}"
    if cache.has(key):
        return send_file(cache.get(key), mimetype="application/json")

    if not _ffmpeg_available():
        return jsonify({"error": "waveform unavailable"}), 503
    try:
        peaks = _audio_peaks(path, buckets)
    except Exception:
        logger.warning("share: waveform decode failed for %s", mid, exc_info=True)
        return jsonify({"error": "waveform unavailable"}), 502
    payload = json.dumps({"peaks": peaks, "duration": duration}).encode("utf-8")
    return send_file(cache.set(key, payload), mimetype="application/json")


@webapi.route("/share/file/<mid>")
@login_required
def share_file(mid):
    """The whole audio file as a named download (original, or transcoded)."""
    path, meta, err = _media_file(mid)
    if err:
        return err
    suffix = os.path.splitext(path)[1][1:].lower() or "bin"
    fmt = (request.args.get("fmt") or "").lower()
    if not fmt or fmt == suffix:
        mime = {"flac": "audio/flac", "mp3": "audio/mpeg"}.get(suffix)
        return send_file(
            path,
            mimetype=mime,
            as_attachment=True,
            download_name=_nice_filename(meta, suffix),
            conditional=True,
        )

    if fmt not in _FORMATS:
        return jsonify({"error": "unsupported format"}), 400
    codec_args, ext, mime = _FORMATS[fmt]
    cache = current_app.transcode_cache
    key = f"share-{meta['key']}-full.{ext}"
    if not cache.has(key):
        if not _ffmpeg_available():
            return jsonify({"error": "transcoder unavailable"}), 503
        # A share/download needs a COMPLETE file (the Web Share API hands the
        # whole blob to the target app), so generate to completion into the
        # cache rather than streaming a growing file.
        try:
            # +5s of slack over the metadata duration; a whole day when unknown.
            length = (meta["duration"] + 5) if meta["duration"] else 86400
            for _ in cache.set_generated(
                key, lambda: _clip_generator(path, 0, length, codec_args)
            ):
                pass
        except Exception:
            logger.warning("share: full transcode failed for %s", mid, exc_info=True)
            return jsonify({"error": "transcode failed"}), 502
    return send_file(
        cache.get(key),
        mimetype=mime,
        as_attachment=True,
        download_name=_nice_filename(meta, ext),
        conditional=True,
    )


@webapi.route("/share/clip/<mid>")
@login_required
def share_clip(mid):
    """An excerpt of the file, cut+encoded by ffmpeg, as a named download."""
    try:
        start = float(request.args.get("start"))
        end = float(request.args.get("end"))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid range"}), 400
    if not (0 <= start < end) or end - start > CLIP_MAX_SECONDS or end > 10**7:
        return jsonify({"error": "invalid range"}), 400
    fmt = (request.args.get("fmt") or "mp3").lower()
    if fmt not in _FORMATS:
        return jsonify({"error": "unsupported format"}), 400

    path, meta, err = _media_file(mid)
    if err:
        return err
    duration = meta["duration"]
    if duration:
        if start >= duration:
            return jsonify({"error": "invalid range"}), 400
        end = min(end, duration)  # tolerate a fractionally-long selection

    codec_args, ext, mime = _FORMATS[fmt]
    name = _nice_filename(meta, ext, tag=f"{_ts_label(start)}-{_ts_label(end)}")
    cache = current_app.transcode_cache
    key = f"clip-{meta['key']}-{int(start * 1000)}-{int(end * 1000)}.{ext}"
    if cache.has(key):
        return send_file(
            cache.get(key),
            mimetype=mime,
            as_attachment=True,
            download_name=name,
            conditional=True,
        )

    if not _ffmpeg_available():
        return jsonify({"error": "transcoder unavailable"}), 503
    # Same reasoning as share_file: the Web Share API needs the complete blob,
    # and a clip is small/fast (bounded length), so cut it to completion first.
    try:
        for _ in cache.set_generated(
            key, lambda: _clip_generator(path, start, end - start, codec_args)
        ):
            pass
    except Exception:
        logger.warning("share: clip failed for %s", mid, exc_info=True)
        return jsonify({"error": "clip failed"}), 502
    return send_file(
        cache.get(key),
        mimetype=mime,
        as_attachment=True,
        download_name=name,
        conditional=True,
    )

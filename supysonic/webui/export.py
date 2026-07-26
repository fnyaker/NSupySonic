# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Bulk export: download a whole playlist / album / your favorites as one ZIP.

Meant for getting music *off* the server and onto something else — a USB stick,
another player, a car radio. The client picks the audio format; every track is
archived on demand (exactly like streaming does), transcoded if needed, and
written into a ZIP that is **streamed** to the browser: nothing is staged on
disk or held in memory, so a 500-track FLAC playlist costs the server a 64 KB
buffer rather than 30 GB of scratch space.

The archive is ZIP_STORED (no compression). Audio is already compressed —
deflating it would burn CPU on every byte for well under 1% saved.

A track that can't be produced (removed from Deezer, transcode failure) is
skipped and listed in ``_erreurs.txt`` inside the ZIP rather than aborting a
download that may already be gigabytes in.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import threading
import uuid
import zipfile

from flask import current_app, jsonify, request, stream_with_context

from ..db import Album
from . import (
    _db_album_tracks,
    _db_playlist_track_rows,
    _db_track,
    _need_provider,
    _resolve_db_playlist,
    _tracks,
    _user_starred,
    _valid_id,
    login_required,
    webapi,
)
from .share import _FNAME_BAD, _ffmpeg_available, _media_file

logger = logging.getLogger(__name__)

# fmt -> (ffmpeg args or None for "copy the archived file", extension, label).
# ``None`` means no re-encode at all: the archived FLAC is the master, so
# exporting FLAC is a straight file copy into the ZIP.
_EXPORT_FORMATS = {
    "flac": (None, "flac", "FLAC"),
    "mp3_320": (["-c:a", "libmp3lame", "-b:a", "320k", "-f", "mp3"], "mp3", "MP3 320"),
    "mp3_192": (["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"], "mp3", "MP3 192"),
    "m4a_256": (
        ["-c:a", "aac", "-b:a", "256k", "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4"],
        "m4a",
        "AAC 256",
    ),
    "opus_320": (["-c:a", "libopus", "-b:a", "320k", "-f", "ogg"], "opus", "Opus 320"),
    "opus_192": (["-c:a", "libopus", "-b:a", "192k", "-f", "ogg"], "opus", "Opus 192"),
    "opus_128": (["-c:a", "libopus", "-b:a", "128k", "-f", "ogg"], "opus", "Opus 128"),
}
DEFAULT_FORMAT = "mp3_320"

_CHUNK = 64 * 1024


def _safe(name: str, fallback: str = "sans-titre") -> str:
    """A filename component that is safe on every filesystem a USB stick may see.

    Beyond the obviously illegal characters, strips leading dots (hidden files /
    ``..``) and trailing dots+spaces (which Windows silently drops, turning two
    distinct tracks into one colliding name).
    """
    name = _FNAME_BAD.sub("_", str(name or "")).strip()
    name = name.lstrip(".").rstrip(". ")
    return (name or fallback)[:120]


class _Sink:
    """An unseekable sink ``zipfile`` writes into, drained chunk by chunk.

    ``zipfile`` supports non-seekable output (it emits data descriptors instead
    of rewinding to patch sizes), which is what lets the ZIP be produced as a
    stream instead of a temp file.
    """

    def __init__(self):
        self._buf = bytearray()
        self._pos = 0

    def write(self, data):
        self._buf += data
        self._pos += len(data)
        return len(data)

    def tell(self):
        return self._pos

    def flush(self):
        pass

    def seekable(self):
        return False

    def pending(self):
        return len(self._buf)

    def drain(self):
        out = bytes(self._buf)
        del self._buf[:]
        return out


def _transcode(path, args):
    """ffmpeg: re-encode `path` to a pipe, carrying tags over."""
    cmd = [
        "ffmpeg", "-v", "0", "-i", path,
        "-map", "0:a:0", "-map_metadata", "0", *args, "pipe:1",
    ]
    # stderr to /dev/null: an unread, full stderr pipe would deadlock ffmpeg.
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    finished = False
    try:
        while True:
            data = proc.stdout.read(_CHUNK)
            if not data:
                break
            yield data
        finished = True
    except GeneratorExit:
        proc.kill()
        raise
    finally:
        proc.stdout.close()
        rc = proc.wait()
        # Only complain when we actually ran to completion. Raising here during
        # a GeneratorExit (the client closed the download) would surface as a
        # bogus "ffmpeg failed" on top of a perfectly normal disconnect.
        if finished and rc != 0:
            raise RuntimeError("ffmpeg failed")


# -- what to export ---------------------------------------------------------


def _playlist_tracks(ident):
    """(title, tracks) for a playlist id — a local UUID or a Deezer id."""
    pl = _resolve_db_playlist(ident)
    if pl is not None:
        return pl.name, [_db_track(t) for t in _db_playlist_track_rows(pl)]
    if not _valid_id(ident):
        return None, None
    provider, err = _need_provider()
    if err:
        return None, None
    try:
        page = provider.get_playlist_page(ident)
        title = ((page.get("DATA") or {}).get("TITLE")) or "playlist"
        try:
            songs = provider.get_playlist_tracks(ident)
        except Exception:
            songs = (page.get("SONGS") or {}).get("data", [])
        return title, _tracks(songs)
    except Exception:
        logger.warning("export: playlist %s unavailable", ident, exc_info=True)
        return None, None


def _album_tracks(ident):
    """(title, tracks) for an album id — a local UUID or a Deezer id."""
    from ..deezer import ids as dz_ids

    alb = None
    try:
        key = dz_ids.album_uuid(ident) if _valid_id(ident) else uuid.UUID(str(ident))
        alb = Album[key]
    except (ValueError, TypeError, Album.DoesNotExist):
        alb = None
    if alb is not None:
        return alb.name, _db_album_tracks(alb)
    if not _valid_id(ident):
        return None, None
    provider, err = _need_provider()
    if err:
        return None, None
    try:
        page = provider.get_album_page(ident)
        title = ((page.get("DATA") or {}).get("ALB_TITLE")) or "album"
        try:
            songs = provider.get_album_tracks(ident)
        except Exception:
            songs = (page.get("SONGS") or {}).get("data", [])
        return title, _tracks(songs)
    except Exception:
        logger.warning("export: album %s unavailable", ident, exc_info=True)
        return None, None


def _favorite_tracks():
    """(title, tracks) for the requesting user's own starred tracks."""
    return "Favoris", [_db_track(t) for t in _user_starred()]


# -- one export at a time, per user -----------------------------------------

_exports_lock = threading.Lock()
_exports_running = set()


def _claim_export(uid) -> bool:
    with _exports_lock:
        if uid in _exports_running:
            return False
        _exports_running.add(uid)
        return True


def _release_export(uid):
    with _exports_lock:
        _exports_running.discard(uid)


# -- the route --------------------------------------------------------------


@webapi.route("/export/formats")
@login_required
def export_formats():
    """The formats this server can actually produce (ffmpeg may be missing)."""
    have_ffmpeg = _ffmpeg_available()
    return jsonify(
        {
            "default": DEFAULT_FORMAT if have_ffmpeg else "flac",
            "formats": [
                {"id": fid, "label": label, "ext": ext}
                for fid, (args, ext, label) in _EXPORT_FORMATS.items()
                if args is None or have_ffmpeg
            ],
        }
    )


@webapi.route("/export/<kind>/<ident>")
@login_required
def export_zip(kind, ident):
    """Stream a playlist / album / favorites as a ZIP of audio files."""
    if kind not in ("playlist", "album", "favorites"):
        return jsonify({"error": "invalid kind"}), 400

    fmt = (request.args.get("fmt") or DEFAULT_FORMAT).lower()
    if fmt not in _EXPORT_FORMATS:
        return jsonify({"error": "invalid format"}), 400
    args, ext, label = _EXPORT_FORMATS[fmt]
    if args is not None and not _ffmpeg_available():
        return jsonify({"error": "ffmpeg unavailable"}), 503

    if kind == "favorites":
        title, tracks = _favorite_tracks()
    elif kind == "playlist":
        title, tracks = _playlist_tracks(ident)
    else:
        title, tracks = _album_tracks(ident)

    if tracks is None:
        return jsonify({"error": "not found"}), 404
    if not tracks:
        return jsonify({"error": "empty"}), 404

    # One export at a time per user. An export can archive and transcode
    # hundreds of tracks, so letting one account start ten of them in parallel
    # is a trivial way to pin every worker on the box. This grants no access
    # the per-track /api/stream and /api/share/file routes don't already give —
    # it only bounds how fast it can be spent.
    uid = str(getattr(request.webuser, "id", "") or "")
    if not _claim_export(uid):
        return jsonify({"error": "export already running"}), 429

    zip_name = _safe(title, kind) + ".zip"
    # Resolve ids + display names up front so the generator only does I/O.
    plan = []
    for i, t in enumerate(tracks, 1):
        tid = str(t.get("deezer_id") or "")
        if not tid:
            continue
        artist = (t.get("artist") or {}).get("name") or ""
        base = f"{artist} - {t.get('title') or ''}".strip(" -") or f"piste {i}"
        plan.append((i, tid, _safe(base, f"piste {i}")))

    def generate():
        sink = _Sink()
        errors = []
        m3u = ["#EXTM3U"]
        try:
            with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
                for i, tid, base in plan:
                    arc = f"{i:03d} - {base}.{ext}"
                    wrote = False
                    try:
                        # _media_file archives the track on demand (the same
                        # path streaming takes) and hands back a real file. It
                        # needs the request context and the DB connection, which
                        # stream_with_context keeps alive for the generator.
                        path, _meta, err = _media_file(tid)
                        if err or not path or not os.path.isfile(path):
                            raise RuntimeError("unavailable")
                        with zf.open(arc, "w") as dst:
                            if args is None:
                                with open(path, "rb") as src:
                                    while True:
                                        chunk = src.read(_CHUNK)
                                        if not chunk:
                                            break
                                        wrote = True
                                        dst.write(chunk)
                                        if sink.pending() >= _CHUNK:
                                            yield sink.drain()
                            else:
                                for chunk in _transcode(path, args):
                                    wrote = True
                                    dst.write(chunk)
                                    if sink.pending() >= _CHUNK:
                                        yield sink.drain()
                        m3u.append(arc)
                    except Exception:
                        logger.warning("export: track %s failed", tid, exc_info=True)
                        # An entry can't be withdrawn from a stream once bytes
                        # are out, so say so: a truncated file that plays for
                        # ten seconds and stops is worse than a named failure.
                        errors.append(
                            f"{i:03d} - {base}"
                            + (" (fichier incomplet dans l'archive)" if wrote else "")
                        )
                    yield sink.drain()

                zf.writestr(_safe(title, kind) + ".m3u", "\n".join(m3u) + "\n")
                if errors:
                    zf.writestr(
                        "_erreurs.txt",
                        "Ces titres n'ont pas pu être exportés :\n\n"
                        + "\n".join(errors)
                        + "\n",
                    )
            yield sink.drain()
        finally:
            # Also runs when the client disconnects mid-download (GeneratorExit),
            # so an abandoned export never wedges the slot.
            _release_export(uid)

    resp = current_app.response_class(
        stream_with_context(generate()), mimetype="application/zip"
    )
    # RFC 5987 so accented playlist names survive; the ASCII fallback is for
    # clients that don't understand filename*.
    ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", zip_name) or "export.zip"
    resp.headers["Content-Disposition"] = (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{_quote(zip_name)}"
    )
    # The length isn't known up front (tracks are transcoded as they stream), so
    # tell proxies not to buffer the whole thing before forwarding it.
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _quote(s):
    from urllib.parse import quote

    return quote(s, safe="")

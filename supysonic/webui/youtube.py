# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The web side of the YouTube fallback (see ``deezer/youtube.py``).

``/youtube/search`` is the search screen's opt-in box; a hit comes back shaped
like any track, with the UUID its row WILL have, so the player, the queue, the
favourites and the playlists take it unchanged. Nothing is created until one of
those touches it (``materialize``), and nothing is downloaded until it is
PLAYED (``stream_cold``).
"""

from __future__ import annotations

import logging
import os
import uuid

from flask import current_app, jsonify, request, send_file

from ..db import Album, Artist, Meta, Track
from ..deezer import youtube as yt
from . import admin_required, login_required, webapi

logger = logging.getLogger(__name__)

ENABLED_KEY = "yt.enabled"
NO_RETRY_HEADER = "X-NS-Error"
YOUTUBE_UNREACHABLE = "youtube-unreachable"
YOUTUBE_DISABLED = "youtube-disabled"

# A client asking for less than the file holds gets a transcode; asking for
# about what it holds (128 of a 131 kbit/s file) gets the file itself. Within
# this margin a re-encode costs quality and buys nothing.
TRANSCODE_MARGIN = 16


def enabled() -> bool:
    """Installed, and not switched off by the admin (on by default)."""
    if not yt.installed():
        return False
    row = Meta.get_or_none(Meta.key == ENABLED_KEY)
    return row is None or row.value != "0"


def _archive_dir():
    return (current_app.config.get("DEEZER") or {}).get("archive_dir")


def _store():
    return getattr(current_app, "cache", None)


def _refusal(code: str, message: str, status: int = 503):
    resp = jsonify({"error": message, "code": code})
    resp.status_code = status
    resp.headers[NO_RETRY_HEADER] = code
    held, left, _why = yt.held()
    if held:
        resp.headers["Retry-After"] = str(max(1, left))
    return resp


def _disabled():
    return _refusal(YOUTUBE_DISABLED, "YouTube est désactivé sur ce serveur")


def _unreachable():
    return _refusal(YOUTUBE_UNREACHABLE, "YouTube est injoignable")


# -- hits <-> tracks ---------------------------------------------------------------


def hit_track(hit: dict) -> dict:
    """A search hit in the API's track shape, under its future row id.

    Its artists and album carry no id: there is no page to open for them
    (the same answer ``_youtube_fields`` gives for a row)."""
    tid = str(yt.track_uuid(hit["video_id"]))
    artists = [
        {"deezer_id": "", "name": a["name"], "role": "Main"}
        for a in hit.get("artists") or []
    ] or [{"deezer_id": "", "name": "[unknown]", "role": "Main"}]
    return {
        "deezer_id": tid,
        "local": True,
        "source": "youtube",
        "youtube_id": hit["video_id"],
        "bitrate": 0,
        "title": hit["title"],
        "duration": hit.get("duration") or 0,
        "explicit": bool(hit.get("explicit")),
        "unavailable": False,
        "gain": None,
        "artist": {"deezer_id": artists[0]["deezer_id"], "name": artists[0]["name"]},
        "artists": artists,
        "display_artist": yt.display_artist(hit),
        "album": {
            "deezer_id": "",
            "title": hit.get("album") or hit["title"],
            "cover": "/api/cover/" + tid,
        },
    }


def hits_as_tracks(hits: list) -> list:
    """Hits, with a row's own answer wherever the row already exists (it may be
    archived — then it carries its real bitrate — or known to be dead)."""
    from . import _local_track

    if not hits:
        return []
    by_id = {
        str(t.id): t
        for t in Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .where(Track.id << [yt.track_uuid(h["video_id"]) for h in hits])
    }
    out = []
    for h in hits:
        row = by_id.get(str(yt.track_uuid(h["video_id"])))
        out.append(_local_track(row) if row is not None else hit_track(h))
    return out


def materialize(track_id) -> Track | None:
    """The row behind a YouTube hit's id, created from what the search said.

    No YouTube request: an id whose hit we no longer remember is simply
    unknown (searching again brings it back)."""
    try:
        tid = uuid.UUID(str(track_id))
    except (ValueError, AttributeError):
        return None
    row = Track.get_or_none(Track.id == tid)
    if row is not None:
        return row
    if not enabled():
        return None
    archive_dir = _archive_dir()
    if not archive_dir:
        return None
    hit = yt.recall(tid, _store())
    if hit is None:
        return None
    try:
        return yt.upsert_track(hit, archive_dir)
    except Exception:
        logger.warning("Could not create the row for YouTube %s", hit["video_id"], exc_info=True)
        return None


def search_tracks(query: str, limit: int = yt.SEARCH_LIMIT) -> list:
    """For other routes (replacement candidates): hits as tracks, [] on any
    failure — a fallback that fails must not take the rest of the answer down."""
    if not enabled():
        return []
    try:
        return hits_as_tracks(yt.search(query, limit, _store()))
    except yt.YoutubeError:
        logger.info("YouTube search failed for %r", query, exc_info=True)
        return []


# -- routes ----------------------------------------------------------------------------


@webapi.route("/youtube/status")
@login_required
def youtube_status():
    held, left, why = yt.held()
    row = Meta.get_or_none(Meta.key == ENABLED_KEY)
    return jsonify(
        {
            "installed": yt.installed(),
            "enabled": enabled(),
            "switched_off": row is not None and row.value == "0",
            "archive": bool(_archive_dir()),
            "held": held,
            "retry_in": left,
            "reason": why or None,
        }
    )


@webapi.route("/youtube/settings", methods=["PUT"])
@login_required
@admin_required
def youtube_settings():
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get("enabled"), bool):
        return jsonify({"error": "enabled must be a boolean"}), 400
    value = "1" if data["enabled"] else "0"
    row = Meta.get_or_none(Meta.key == ENABLED_KEY)
    if row is None:
        Meta.create(key=ENABLED_KEY, value=value)
    elif row.value != value:
        row.value = value
        row.save()
    return youtube_status()


@webapi.route("/youtube/search")
@login_required
def youtube_search():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify({"tracks": []})
    if not enabled():
        return _disabled()
    try:
        limit = max(1, min(int(request.args.get("limit", yt.SEARCH_LIMIT)), yt.SEARCH_LIMIT))
    except (TypeError, ValueError):
        limit = yt.SEARCH_LIMIT
    try:
        hits = yt.search(query, limit, _store())
    except yt.YoutubeError:
        logger.info("YouTube search failed for %r", query, exc_info=True)
        return _unreachable()
    return jsonify({"tracks": hits_as_tracks(hits)})


# -- the audio ---------------------------------------------------------------------


def stream_cold(track: Track):
    """The first play: fetch and archive, then let the caller serve the file.

    Returns None when the file is now on disk, or the response to send. A
    request nobody is listening to (a prefetch) never costs a YouTube call: it
    is told "not yet" and the real play fetches it.
    """
    if getattr(request, "ns_background", False):
        resp = jsonify({"error": "not archived yet", "queued": False})
        resp.status_code = 503
        resp.headers["Retry-After"] = "60"
        return resp
    if not enabled():
        return _disabled()
    archive_dir = _archive_dir()
    if not archive_dir:
        return jsonify({"error": "archive_dir not configured"}), 503
    try:
        yt.ensure_archived(track, archive_dir, yt.recall(track.id, _store()))
    except yt.YoutubeUnavailable:
        logger.info("YouTube video %s is gone; marked unavailable", track.youtube_id)
        return jsonify({"error": "track unavailable", "unavailable": True}), 410
    except yt.YoutubeError as exc:
        logger.warning("YouTube fetch of %s failed: %s", track.youtube_id, exc)
        return _refusal(YOUTUBE_UNREACHABLE, "YouTube est injoignable", 502)
    return None


def serve(track: Track, bitrate):
    """An archived YouTube file: as it is, unless the client asked for LESS."""
    from . import _opus_generator

    source = int(track.bitrate or 0)
    if bitrate and source and bitrate < source - TRANSCODE_MARGIN:
        cache = current_app.transcode_cache
        key = f"youtube-{track.id}-opus{bitrate}.ogg"
        if cache.has(key):
            return send_file(cache.get(key), mimetype="audio/ogg", conditional=True)
        return current_app.response_class(
            cache.set_generated(key, lambda: _opus_generator(track.path, bitrate)),
            mimetype="audio/ogg",
        )
    ext = os.path.splitext(track.path)[1].lower()
    mimetype = "audio/mp4" if ext in (".m4a", ".mp4") else "audio/ogg"
    resp = send_file(track.path, mimetype=mimetype, conditional=True)
    resp.headers["X-NS-Source-Bitrate"] = str(source)
    return resp


def cover(track: Track | None, tid):
    """Art for a YouTube track that has no file yet: the search's thumbnail,
    fetched once and kept. None when there is nothing to show."""
    hit = yt.recall(tid, _store())
    if hit is None and track is None:
        return None
    video_id = (hit or {}).get("video_id") or (track.youtube_id if track else None)
    if not yt.valid_video_id(video_id):
        return None
    cache = current_app.cache
    key = f"yt-cover-{video_id}"
    if cache.has(key):
        return send_file(cache.get(key), mimetype="image/jpeg", conditional=True)
    if not enabled():
        return None
    url = (hit or {}).get("thumb") or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    data = yt.fetch_thumbnail(url)
    if not data:
        return None
    return send_file(cache.set(key, data), mimetype="image/jpeg", conditional=True)


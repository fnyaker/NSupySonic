# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Unavailable tracks, and replacing them.

A Deezer track can stop being playable at any time — rights pulled, delisted,
geo-blocked — and there is nothing the server can do about it. What it *can* do
is (1) know it, definitively and quickly, so the player moves on instead of
retrying a corpse, and (2) let you put something else in its place everywhere it
appears, without hunting through every playlist by hand.

The verdict lives on ``Track.unavailable`` as a timestamp, not a flag: rights
come back, so an old verdict is re-tested rather than condemning the track for
good.
"""

from __future__ import annotations

import logging
import threading
import uuid as uuidlib
from datetime import timedelta

from flask import current_app, jsonify, request

from ..db import (
    Album,
    Artist,
    Playlist,
    PlaylistTrack,
    StarredTrack,
    Track,
    db,
    now,
)
from ..deezer.provider import DeezerError, TrackUnavailable
from . import (
    _CDN,
    _is_admin,
    _local_search_tracks,
    _local_track,
    _may_access_track,
    _need_provider,
    _provider,
    _track_api,
    _valid_id,
    _visible_tracks,
    login_required,
    webapi,
)

logger = logging.getLogger(__name__)

# How long an "unavailable" verdict stands before the next probe re-tests it.
# Long enough that a dead track stays out of the way, short enough that a track
# whose rights came back isn't stuck behind a stale verdict.
VERDICT_TTL = timedelta(days=7)


# The primitives live in the DB layer (deezer/library.py), because every path
# that discovers the answer records it — the live stream, the background
# archiver, the download queue, the CLI — and none of them may depend on the web
# layer. Re-exported here so the endpoints below read naturally.
from ..deezer.library import (  # noqa: E402  isort:skip
    clear_unavailable,
    mark_unavailable,
)


def is_stale(track) -> bool:
    """Whether a recorded verdict is old enough to be worth re-testing."""
    stamp = getattr(track, "unavailable", None)
    return stamp is not None and (now() - stamp) > VERDICT_TTL


def _resolve_local(track_id):
    """A Track row from a universal id (numeric Deezer id or a local UUID)."""
    from ..deezer import archive

    if _valid_id(track_id):
        return archive.find_local_track(track_id)
    try:
        return Track.get_or_none(Track.id == uuidlib.UUID(str(track_id)))
    except (ValueError, AttributeError):
        return None


@webapi.route("/track/<track_id>/probe")
@login_required
def probe_track(track_id):
    """Is this track actually playable, right now?

    The web player asks the moment playback errors out. The `<audio>` element
    only ever reports "it broke" — it cannot tell a dead track from a dropped
    packet — so this endpoint answers the question the element can't, and the
    player stops burning its retry budget on tracks that will never play.

    Cheap by design: a recorded verdict answers immediately, and only a stale (or
    absent) one costs a Deezer round-trip.
    """
    track = _resolve_local(track_id)
    if track is not None and not _may_access_track(track):
        return jsonify({"error": "not found"}), 404

    # A local file: available iff it is on disk. No Deezer involved.
    if track is not None and not track.deezer_id:
        import os.path

        ok = bool(track.path and os.path.isfile(track.path))
        if ok:
            clear_unavailable(track)
        else:
            mark_unavailable(track)
        return jsonify({"available": ok, "reason": None if ok else "missing file"})

    # Already archived means already playable, whatever Deezer thinks today.
    if track is not None and track.path:
        import os.path

        if os.path.isfile(track.path):
            clear_unavailable(track)
            return jsonify({"available": True, "reason": None})

    if track is not None and track.unavailable is not None and not is_stale(track):
        return jsonify({"available": False, "reason": "unavailable"})

    if not _valid_id(track_id):
        return jsonify({"available": False, "reason": "unknown track"})

    provider, err = _need_provider()
    if err:
        # No Deezer configured: we genuinely cannot tell. Saying "unavailable"
        # here would condemn every track on a proxy that is merely switched off.
        return jsonify({"available": True, "reason": "unknown"})
    try:
        provider.resolve(track_id)
    except TrackUnavailable:
        mark_unavailable(track)
        return jsonify({"available": False, "reason": "unavailable"})
    except (DeezerError, Exception):
        # Network, session, gateway: says nothing about the track. Treated as
        # available so the player keeps its normal retry behaviour.
        logger.debug("Probe of %s was inconclusive", track_id, exc_info=True)
        return jsonify({"available": True, "reason": "unknown"})
    clear_unavailable(track)
    return jsonify({"available": True, "reason": None})


@webapi.route("/unavailable")
@login_required
def unavailable_tracks():
    """Every track we know to be unplayable, newest verdict first.

    This is what the library's "Titres indisponibles" section lists, so each one
    can be replaced.
    """
    rows = (
        _visible_tracks(
            Track.select(Track, Album, Artist)
            .join(Album)
            .switch(Track)
            .join(Artist)
            .where(Track.unavailable.is_null(False))
        )
        .order_by(Track.unavailable.desc())
        .limit(500)
    )
    return jsonify({"tracks": [_unavailable_entry(t) for t in rows]})


def _unavailable_entry(t: Track) -> dict:
    """A track payload for the replacement UI, plus where it is still used."""
    out = _local_track(t) if not t.deezer_id else _archived_track_api(t)
    out["unavailable"] = True
    out["playlists"] = [
        {"id": str(p.id), "title": p.name}
        for p in (
            Playlist.select()
            .join(PlaylistTrack, on=(PlaylistTrack.playlist == Playlist.id))
            .where(PlaylistTrack.track == t.id)
            .distinct()
        )
    ]
    return out


def _archived_track_api(t: Track) -> dict:
    """Serialize a Deezer-backed Track ROW (not a live Deezer payload)."""
    cover = (
        _CDN.format(kind="cover", md5=t.album.cover_md5, w=500)
        if getattr(t.album, "cover_md5", None)
        else "/api/cover/" + str(t.deezer_id)
    )
    return {
        "deezer_id": str(t.deezer_id),
        "title": t.title,
        "duration": t.duration or 0,
        "explicit": False,
        "gain": t.gain,
        "artist": {"deezer_id": t.artist.deezer_id, "name": t.artist.name},
        "artists": [
            {
                "deezer_id": t.artist.deezer_id,
                "name": t.artist.name,
                "role": "Main",
            }
        ],
        "display_artist": t.artist.name,
        "album": {
            "deezer_id": t.album.deezer_id,
            "title": t.album.name,
            "cover": cover,
        },
    }


@webapi.route("/replace/candidates/<track_id>")
@login_required
def replacement_candidates(track_id):
    """Plausible stand-ins for a dead track: same title, same artist, first.

    Local files come first — they are on disk, so they can never go away again —
    then Deezer's own results for "<artist> <title>", with the dead track and
    anything else we already know to be unavailable filtered out.
    """
    track = _resolve_local(track_id)
    if track is None:
        return jsonify({"error": "not found"}), 404
    if not _may_access_track(track):
        return jsonify({"error": "not found"}), 404

    query = f"{track.artist.name} {track.title}".strip()
    out = []
    seen = {str(track_id)}

    for t in _local_search_tracks(query, 10):
        if t["deezer_id"] in seen:
            continue
        seen.add(t["deezer_id"])
        out.append(t)

    provider = _provider()
    if provider is not None:
        try:
            results = provider.dz.api.search(query, limit=25) or {}
            for raw in results.get("data", []) or []:
                item = _track_api(raw)
                if not item or item["deezer_id"] in seen:
                    continue
                seen.add(item["deezer_id"])
                out.append(item)
        except Exception:
            logger.info("Candidate search failed for %s", track_id, exc_info=True)

    # Drop the ones already known to be dead — offering a replacement that is
    # itself unplayable is worse than offering nothing.
    dead = {
        str(t.deezer_id)
        for t in Track.select(Track.deezer_id).where(
            Track.unavailable.is_null(False) & Track.deezer_id.is_null(False)
        )
    }
    out = [t for t in out if t["deezer_id"] not in dead]
    return jsonify({"query": query, "candidates": out[:30]})


# -- replacement ------------------------------------------------------------
# Swapping a track everywhere it appears touches playlists (position by
# position) and favorites, and — for the admin's Deezer-backed playlists — has
# to be mirrored to Deezer as well. The Deezer half is slow and flaky, so the
# whole thing runs in a worker thread and the UI polls the job.

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
# Keep the job table from growing without bound over a long uptime.
_JOBS_MAX = 40


def _new_job(kind: str) -> str:
    job_id = uuidlib.uuid4().hex
    with _jobs_lock:
        if len(_jobs) >= _JOBS_MAX:
            for stale in sorted(_jobs, key=lambda k: _jobs[k]["started"])[:10]:
                _jobs.pop(stale, None)
        _jobs[job_id] = {
            "kind": kind,
            "started": now().isoformat(),
            "running": True,
            "ok": None,
            "playlists": 0,
            "favorites": 0,
            "error": None,
        }
    return job_id


def _finish_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job.update(fields)
        job["running"] = False


@webapi.route("/replace/status/<job_id>")
@login_required
def replace_status(job_id):
    with _jobs_lock:
        job = _jobs.get(str(job_id))
    if job is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)


@webapi.route("/replace", methods=["POST"])
@login_required
def replace_track():
    """Replace every occurrence of one track by another.

    ``from`` and ``to`` are universal ids (a numeric Deezer id, or a UUID for a
    local file). The Deezer target is imported first — a replacement you cannot
    play would be no replacement at all.
    """
    data = request.get_json(silent=True) or {}
    src_id = str(data.get("from") or "")
    dst_id = str(data.get("to") or "")
    if not src_id or not dst_id or src_id == dst_id:
        return jsonify({"error": "invalid ids"}), 400

    source = _resolve_local(src_id)
    if source is None or not _may_access_track(source):
        return jsonify({"error": "unknown track"}), 404

    target = _resolve_local(dst_id)
    if target is None:
        # A Deezer track we've never imported: materialize the row now.
        if not _valid_id(dst_id):
            return jsonify({"error": "unknown replacement"}), 404
        provider, err = _need_provider()
        if err:
            return err
        from ..deezer import archive

        try:
            target = archive.import_track(provider, dst_id)
        except Exception:
            logger.warning("Import of replacement %s failed", dst_id, exc_info=True)
            return jsonify({"error": "replacement unavailable"}), 502
    if not _may_access_track(target):
        return jsonify({"error": "unknown replacement"}), 404
    if target.id == source.id:
        return jsonify({"error": "invalid ids"}), 400

    job_id = _new_job("replace")
    app = current_app._get_current_object()
    user_id = request.webuser.id
    admin = _is_admin()
    threading.Thread(
        target=_run_replace,
        args=(app, job_id, source.id, target.id, user_id, admin),
        name="track-replace",
        daemon=True,
    ).start()
    return jsonify({"ok": True, "job": job_id})


def _run_replace(app, job_id, source_id, target_id, user_id, admin):
    """Worker: rewrite playlists and favorites, then mirror to Deezer."""
    from ..db import close_connection, open_connection

    playlists = favorites = 0
    try:
        with app.app_context():
            open_connection(reuse=True)
            source = Track.get_or_none(Track.id == source_id)
            target = Track.get_or_none(Track.id == target_id)
            if source is None or target is None:
                _finish_job(job_id, ok=False, error="track vanished")
                return

            # Only playlists the caller may edit: their own, and (for an admin)
            # every one. A replacement must never rewrite someone else's list.
            rows = (
                PlaylistTrack.select(PlaylistTrack, Playlist)
                .join(Playlist, on=(PlaylistTrack.playlist == Playlist.id))
                .where(PlaylistTrack.track == source.id)
            )
            if not admin:
                rows = rows.where(Playlist.user == user_id)

            touched = set()
            with db.atomic():
                for row in rows:
                    # In place, at the same position: a replacement must not
                    # reshuffle the playlist it repairs.
                    PlaylistTrack.update(track=target.id).where(
                        (PlaylistTrack.playlist == row.playlist_id)
                        & (PlaylistTrack.track == source.id)
                    ).execute()
                    touched.add(row.playlist_id)
                playlists = len(touched)

                # Favorites: whoever starred the dead track gets the new one.
                starred = StarredTrack.select().where(StarredTrack.starred == source.id)
                if not admin:
                    starred = starred.where(StarredTrack.user == user_id)
                for star in starred:
                    exists = StarredTrack.get_or_none(
                        (StarredTrack.user == star.user_id)
                        & (StarredTrack.starred == target.id)
                    )
                    if exists is None:
                        StarredTrack.create(user=star.user_id, starred=target.id)
                    star.delete_instance()
                    favorites += 1

            _mirror_to_deezer(app, source, target, touched, admin)
            _finish_job(job_id, ok=True, playlists=playlists, favorites=favorites)
    except Exception as exc:
        logger.warning("Replacing %s failed", source_id, exc_info=True)
        _finish_job(job_id, ok=False, error=str(exc), playlists=playlists,
                    favorites=favorites)
    finally:
        try:
            close_connection()
        except Exception:
            pass


def _mirror_to_deezer(app, source, target, playlist_ids, admin):
    """Best effort: carry the swap over to the Deezer account too.

    Only the admin owns that account, only real Deezer playlists can be mirrored,
    and a Deezer failure must never undo the local swap that already succeeded.
    """
    if not admin or not app.config["DEEZER"].get("push_to_deezer"):
        return
    provider = getattr(app, "deezer", None)
    if provider is None or not target.deezer_id or not source.deezer_id:
        return
    for pid in playlist_ids:
        pl = Playlist.get_or_none(Playlist.id == pid)
        if pl is None or not pl.deezer_id:
            continue
        try:
            provider.remove_songs_from_playlist(pl.deezer_id, [source.deezer_id])
            provider.add_songs_to_playlist(pl.deezer_id, [target.deezer_id])
        except Exception:
            logger.info(
                "Deezer mirror of the replacement failed for playlist %s", pid,
                exc_info=True,
            )

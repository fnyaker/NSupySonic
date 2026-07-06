# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Custom Deezer-native JSON API for the bundled discovery web UI.

Session-cookie authenticated (so the SPA isn't tied to the Subsonic protocol's
limits). Discovery comes straight from the Deezer gateway via DeezerProvider;
playback reuses the import + archive + cache machinery. Album/artist artwork is
returned as Deezer CDN URLs the browser loads directly.
"""

from __future__ import annotations

import logging
import os.path
import threading
import time
import uuid
from functools import wraps

from flask import Blueprint, current_app, jsonify, request, send_file, session
from peewee import fn

from ..db import (
    Album,
    Artist,
    Playlist,
    PlaylistTrack,
    PodcastChannel,
    PodcastEpisode,
    StarredTrack,
    Track,
    User,
    db,
    now,
)
from ..managers.user import UserManager
from ..ratelimit import auth_limiter

logger = logging.getLogger(__name__)

webapi = Blueprint("webapi", __name__)

_CDN = "https://e-cdns-images.dzcdn.net/images/{kind}/{md5}/{w}x{w}-000000-80-0-0.jpg"


# -- helpers ----------------------------------------------------------------


def _image(kind, md5, size=500):
    return _CDN.format(kind=kind, md5=md5, w=size) if md5 else None


def _title(t):
    title = t.get("SNG_TITLE", "") or ""
    version = t.get("VERSION") or ""
    return f"{title} {version}".strip() if version and version not in title else title


def _track(t):
    if not t or not t.get("SNG_ID"):
        return None
    expl = str(t.get("EXPLICIT_LYRICS", ""))
    return {
        "deezer_id": str(t.get("SNG_ID")),
        "title": _title(t),
        "duration": int(t.get("DURATION") or 0),
        "added": int(t.get("DATE_ADD") or 0),
        "explicit": expl == "1",
        "artist": {"deezer_id": str(t.get("ART_ID")), "name": t.get("ART_NAME", "")},
        "album": {
            "deezer_id": str(t.get("ALB_ID")),
            "title": t.get("ALB_TITLE", ""),
            "cover": _image("cover", t.get("ALB_PICTURE")),
        },
    }


def _album(a):
    if not a:
        return None
    return {
        "deezer_id": str(a.get("ALB_ID")),
        "title": a.get("ALB_TITLE") or a.get("TITLE", ""),
        "cover": _image("cover", a.get("ALB_PICTURE")),
        "artist": {"deezer_id": str(a.get("ART_ID")), "name": a.get("ART_NAME", "")},
        "nb_tracks": a.get("NUMBER_TRACK"),
        "year": (str(a.get("PHYSICAL_RELEASE_DATE") or a.get("DIGITAL_RELEASE_DATE") or "")[:4]) or None,
    }


def _artist(ar):
    if not ar:
        return None
    return {
        "deezer_id": str(ar.get("ART_ID")),
        "name": ar.get("ART_NAME", ""),
        "picture": _image("artist", ar.get("ART_PICTURE")),
        "nb_fan": ar.get("NB_FAN"),
    }


def _tracks(items):
    return [x for x in (_track(t) for t in (items or [])) if x]


def _playlist(p):
    if not p:
        return None
    pid = p.get("PLAYLIST_ID")
    if not pid:
        return None
    kind = (p.get("PICTURE_TYPE") or "playlist").lower()
    return {
        "deezer_id": str(pid),
        "title": p.get("TITLE", ""),
        "description": p.get("DESCRIPTION") or "",
        "cover": _image(kind, p.get("PLAYLIST_PICTURE")),
        "nb_tracks": p.get("NB_SONG"),
        "duration": int(p.get("DURATION") or 0),
        "owner": p.get("PARENT_USERNAME") or p.get("PARENT_USER", ""),
        "is_favorite": bool(p.get("IS_FAVORITE")),
    }


def _lyrics(raw):
    """Normalize ``song.getLyrics`` output into plain + synced (LRC) lines."""
    if not raw:
        return None
    synced = []
    for line in raw.get("LYRICS_SYNC_JSON") or []:
        ms = line.get("milliseconds")
        text = line.get("line", "")
        if ms is None:
            continue
        synced.append({"time": int(ms), "text": text})
    return {
        "text": raw.get("LYRICS_TEXT") or "",
        "synced": synced,
        "copyright": raw.get("LYRICS_COPYRIGHTS") or "",
        "writers": raw.get("LYRICS_WRITERS") or "",
    }


# -- normalizers for the public REST API (api.deezer.com) -------------------
# The public API is more stable than the private gateway for search/charts and
# returns ready-to-use image URLs. Shapes differ (lowercase REST), so these map
# them to the SAME JSON the gateway normalizers above produce.


def _pic(d, *keys):
    for k in keys:
        if d.get(k):
            return d[k]
    return None


def _track_api(t):
    if not t or not t.get("id"):
        return None
    alb = t.get("album") or {}
    art = t.get("artist") or {}
    return {
        "deezer_id": str(t.get("id")),
        "title": t.get("title") or t.get("title_short") or "",
        "duration": int(t.get("duration") or 0),
        "explicit": bool(t.get("explicit_lyrics")),
        "artist": {"deezer_id": str(art.get("id")), "name": art.get("name", "")},
        "album": {
            "deezer_id": str(alb.get("id")),
            "title": alb.get("title", ""),
            "cover": _pic(alb, "cover_medium", "cover_big", "cover"),
        },
    }


def _album_api(a):
    if not a or not a.get("id"):
        return None
    art = a.get("artist") or {}
    return {
        "deezer_id": str(a.get("id")),
        "title": a.get("title", ""),
        "cover": _pic(a, "cover_medium", "cover_big", "cover"),
        "artist": {"deezer_id": str(art.get("id")), "name": art.get("name", "")},
        "nb_tracks": a.get("nb_tracks"),
        "year": (str(a.get("release_date") or "")[:4]) or None,
    }


def _artist_api(a):
    if not a or not a.get("id"):
        return None
    return {
        "deezer_id": str(a.get("id")),
        "name": a.get("name", ""),
        "picture": _pic(a, "picture_medium", "picture_big", "picture"),
        "nb_fan": a.get("nb_fan"),
    }


def _playlist_api(p):
    if not p or not p.get("id"):
        return None
    user = p.get("user") or {}
    return {
        "deezer_id": str(p.get("id")),
        "title": p.get("title", ""),
        "description": p.get("description") or "",
        "cover": _pic(p, "picture_medium", "picture_big", "picture"),
        "nb_tracks": p.get("nb_tracks"),
        "owner": user.get("name", ""),
        "is_favorite": False,
    }


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        uid = session.get("uid")
        if not uid:
            return jsonify({"error": "unauthorized"}), 401
        try:
            request.webuser = User[uid]
        except (User.DoesNotExist, ValueError):
            session.clear()
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)

    return wrapper


# The single Deezer account (the ARL) belongs to the admin / sync user. Only the
# admin sees that account's personal data — its playlists, favorites, Flow and
# recommendations — and only the admin's plays feed Deezer telemetry. Everyone
# else is a guest: Deezer is just a content catalogue (search / browse / play),
# their favorites are private and local-only, and the account is never mutated.
def _is_admin():
    u = getattr(request, "webuser", None)
    return bool(u and u.admin)


def admin_required(f):
    """Reject non-admins outright — for endpoints that would write to the
    shared Deezer account (favorites, playlist edits, Flow tuning)."""

    @wraps(f)
    def wrapper(*args, **kwargs):
        if not _is_admin():
            return jsonify({"error": "forbidden"}), 403
        return f(*args, **kwargs)

    return wrapper


def _provider():
    provider = getattr(current_app, "deezer", None)
    if provider is None:
        return None
    return provider


def _need_provider():
    provider = _provider()
    if provider is None:
        return None, (jsonify({"error": "Deezer proxy disabled"}), 503)
    return provider, None


def _valid_id(value):
    """A Deezer numeric id (track/album/artist/playlist). Rejects junk early."""
    value = str(value or "")
    return value.lstrip("-").isdigit()


# -- local (non-Deezer) tracks ----------------------------------------------
# Files imported from the archive directory have no Deezer id; their universal
# id (for streaming, etc.) is the Track UUID, and they carry `local: true` so
# the UI can show a "not on Deezer" badge.


def _local_track(t: Track) -> dict:
    return {
        "deezer_id": str(t.id),  # the universal id for local tracks is the UUID
        "local": True,
        "title": t.title,
        "duration": t.duration or 0,
        "explicit": False,
        "artist": {"deezer_id": str(t.artist.id), "name": t.artist.name},
        "album": {
            "deezer_id": str(t.album.id),
            "title": t.album.name,
            "cover": "/api/localcover/" + str(t.id),
        },
    }


def _local_search_tracks(query: str, limit: int) -> list:
    """Search the on-device library so downloaded music is findable even when
    Deezer is unreachable. Covers uploaded local files (deezer_id NULL, always on
    disk) *and* archived Deezer tracks (file present) — anything playable without
    a Deezer call. Imported-but-not-yet-archived rows are skipped: they'd need
    Deezer to stream, so they surface through the live Deezer search instead.
    """
    q = (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .where(
            Track.title.contains(query)
            | Album.name.contains(query)
            | Artist.name.contains(query)
        )
        .order_by(Track.title)
        # Over-fetch, then keep only offline-playable rows up to `limit` (an
        # archived-state filter can't be expressed cleanly in SQL here).
        .limit(min(limit * 5, 200))
    )
    out = []
    for t in q:
        if t.deezer_id is not None and not os.path.isfile(t.path):
            continue  # imported metadata only — not on disk, needs Deezer
        out.append(_db_track(t))
        if len(out) >= limit:
            break
    return out


def _local_starred() -> list:
    """The current user's locally-starred (non-Deezer) tracks."""
    return list(
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .switch(Track)
        .join(StarredTrack, on=(StarredTrack.starred == Track.id))
        .where(StarredTrack.user == request.webuser, Track.deezer_id.is_null(True))
    )


def _user_starred() -> list:
    """Every track the current user has starred (local *and* Deezer), newest
    first. Used for guests, whose favorites are private/local-only — there's no
    Deezer-account favorites list to read from."""
    return list(
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .switch(Track)
        .join(StarredTrack, on=(StarredTrack.starred == Track.id))
        .where(StarredTrack.user == request.webuser)
        .order_by(StarredTrack.date.desc())
    )


def _db_track(t: Track) -> dict:
    """Normalize a DB Track row to the API track shape. Local files go through
    ``_local_track``; Deezer-imported rows rebuild their cover from the stored
    ``cover_md5`` so no Deezer call is needed."""
    if t.deezer_id is None:
        return _local_track(t)
    return {
        "deezer_id": str(t.deezer_id),
        "title": t.title,
        "duration": t.duration or 0,
        "explicit": False,
        "artist": {"deezer_id": str(t.artist.deezer_id or ""), "name": t.artist.name},
        "album": {
            "deezer_id": str(t.album.deezer_id or ""),
            "title": t.album.name,
            "cover": _image("cover", t.album.cover_md5),
        },
    }


# -- DB fallbacks for browse pages (work when Deezer is unreachable) ---------
# Everything imported/archived is a normal DB row, so an album/artist/mix page
# can be rebuilt straight from the DB — no Deezer call — for offline browsing.


def _db_album_card(alb: Album) -> dict:
    """A compact album entry (grid card), matching ``_album_api``'s shape."""
    return {
        "deezer_id": str(alb.deezer_id or ""),
        "title": alb.name,
        "cover": _image("cover", alb.cover_md5),
        "artist": {"deezer_id": str(alb.artist.deezer_id or ""), "name": alb.artist.name},
        "nb_tracks": alb.tracks.count(),
        "year": alb.tracks.select(fn.min(Track.year)).scalar() or None,
    }


def _db_album_tracks(alb: Album) -> list:
    q = (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .where(Track.album == alb)
        .order_by(Track.disc, Track.number)
    )
    return [_db_track(t) for t in q]


def _db_album_response(alb: Album) -> dict:
    tracks = _db_album_tracks(alb)
    return {
        "album": {
            "deezer_id": str(alb.deezer_id or ""),
            "title": alb.name,
            "cover": _image("cover", alb.cover_md5),
            "artist": {
                "deezer_id": str(alb.artist.deezer_id or ""),
                "name": alb.artist.name,
            },
            "nb_tracks": len(tracks),
            "year": alb.tracks.select(fn.min(Track.year)).scalar() or None,
        },
        "tracks": tracks,
    }


def _db_artist_response(ar: Artist) -> dict:
    albums = (
        Album.select(Album, Artist)
        .join(Artist)
        .where(Album.artist == ar)
        .order_by(Album.name)
    )
    cards = [_db_album_card(a) for a in albums]
    # A few of the artist's tracks as a stand-in "top" shelf (DB order).
    top_q = (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .where(Track.artist == ar)
        .order_by(Track.play_count.desc())
        .limit(15)
    )
    return {
        "artist": {
            "deezer_id": str(ar.deezer_id or ""),
            "name": ar.name,
            "picture": None,  # not stored locally
            "nb_fan": None,
        },
        "bio": None,
        "top": [_db_track(t) for t in top_q],
        "albums": cards,
        "related": [],
    }


def _db_mix_for(sid: str):
    """The synced 'Deezer · <title>' DB playlist for a smart-tracklist id, or None."""
    from ..deezer import ids as dz_ids

    try:
        pl = Playlist[dz_ids.playlist_uuid("smart:" + str(sid))]
    except Playlist.DoesNotExist:
        return None
    return pl


def _deezer_starred() -> list:
    """The current user's starred *Deezer* tracks (from the DB), newest first."""
    return list(
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .switch(Track)
        .join(StarredTrack, on=(StarredTrack.starred == Track.id))
        .where(StarredTrack.user == request.webuser, Track.deezer_id.is_null(False))
        .order_by(StarredTrack.date.desc())
    )


# -- DB-backed playlists ----------------------------------------------------
# The web app's *user* playlists live in supysonic's own Playlist/PlaylistTrack
# tables (ordered by PlaylistTrack.index), exactly like the Subsonic side. This
# lets a playlist mix Deezer tracks and purely-local files (deezer_id NULL), and
# gives reliable reordering. Edits are mirrored back to the Deezer account
# fail-soft (deezer/push.py), but only the Deezer-track subset is pushed.


def _track_uid(t: Track) -> str:
    """The id the front-end addresses a track by: the Deezer id for Deezer
    tracks, the row UUID for local files (matches ``_local_track``)."""
    return str(t.deezer_id) if t.deezer_id else str(t.id)


def _resolve_db_playlist(pid):
    """Return the DB Playlist for a UUID *or* a mappable Deezer numeric id,
    else None (a non-imported recommendation/editorial playlist)."""
    from ..deezer import ids

    sid = str(pid)
    try:
        return Playlist[uuid.UUID(sid)]
    except (ValueError, Playlist.DoesNotExist):
        pass
    if _valid_id(sid):
        try:
            return Playlist[ids.playlist_uuid(sid)]
        except Playlist.DoesNotExist:
            pass
        return Playlist.select().where(Playlist.deezer_id == sid).first()
    return None


def _db_playlist_track_rows(pl):
    """The playlist's Track rows in order, with Album+Artist eager-loaded —
    ``pl.get_tracks()`` lazy-loads both per track (2 extra queries per row,
    thousands on a big playlist)."""
    return (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .switch(Track)
        .join(PlaylistTrack, on=(PlaylistTrack.track == Track.id))
        .where(PlaylistTrack.playlist == pl)
        .order_by(PlaylistTrack.index)
    )


def _db_playlist_cover(tracks: list) -> str | None:
    """Pick the first available album cover as the playlist's cover (Playlist
    rows don't store a Deezer picture md5)."""
    for t in tracks:
        cover = (t.get("album") or {}).get("cover")
        if cover:
            return cover
    return None


def _ensure_track_row(provider, deezer_id, root, cache):
    """Materialize (idempotently) the DB Track row for a Deezer track id, so a
    freshly-added Deezer track can be referenced by a PlaylistTrack. Reuses the
    same upsert path as the importer (deezer/library.upsert_track)."""
    from ..deezer import library

    data = provider.get_track_info(deezer_id)
    return library.upsert_track(data, root, provider.default_quality, cache=cache)


def _resolve_tracks(provider, raw_ids) -> list:
    """Map universal track ids to Track rows: a UUID is a local/DB track, a
    numeric id is a Deezer track whose row is created on demand."""
    from ..deezer import library

    from ..deezer import archive

    root = None
    cache = library.ImportCache()
    out = []
    for raw in raw_ids:
        sid = str(raw)
        try:
            out.append(Track[uuid.UUID(sid)])
            continue
        except (ValueError, Track.DoesNotExist):
            pass
        if _valid_id(sid):
            # Known Deezer track? Reuse the DB row (no network) so adding an
            # already-imported track to a playlist works even when Deezer is down.
            known = archive.find_local_track(sid)
            if known is not None:
                out.append(known)
                continue
            if root is None:
                root = library.get_root_folder(provider.archive_dir)
            try:
                out.append(_ensure_track_row(provider, sid, root, cache))
            except Exception:
                logger.warning("could not materialize Deezer track %s", sid, exc_info=True)
    return out


def _mirror_now(provider, pl):
    """Push the playlist's Deezer-track subset back to the Deezer account
    (fail-soft: a Deezer error must never break the local edit)."""
    from ..deezer import push

    try:
        push.reconcile_playlist(provider, pl)
    except Exception:
        logger.warning("playlist mirror failed for %s", pl.id, exc_info=True)


# The Deezer mirror is asynchronous and coalesced: playlist edits must respond
# at local-DB speed, never waiting on Deezer round-trips (which took seconds and
# made every add/remove/reorder feel laggy). Each edit stamps its playlist id
# here; a single worker thread reconciles a playlist once things settle
# (_MIRROR_DELAY), so a burst of rapid edits becomes ONE reconcile with the
# final state — reconcile_playlist is state-based, intermediate states are
# irrelevant. The worker exits when idle and is restarted on demand.
_MIRROR_DELAY = 1.5
_mirror_lock = threading.Lock()
_mirror_pending: dict = {}  # playlist uuid -> monotonic timestamp of last edit
_mirror_thread: threading.Thread | None = None


def _mirror_playlist(provider, pl):
    if current_app.testing:  # keep tests deterministic: reconcile inline
        _mirror_now(provider, pl)
        return
    app = current_app._get_current_object()
    global _mirror_thread
    with _mirror_lock:
        _mirror_pending[pl.id] = time.monotonic()
        if _mirror_thread is None or not _mirror_thread.is_alive():
            _mirror_thread = threading.Thread(
                target=_mirror_worker, args=(app,), name="playlist-mirror", daemon=True
            )
            _mirror_thread.start()


def _mirror_worker(app):
    from ..db import close_connection, open_connection

    global _mirror_thread
    while True:
        time.sleep(0.3)
        due = []
        with _mirror_lock:
            now_m = time.monotonic()
            for pid, ts in list(_mirror_pending.items()):
                if now_m - ts >= _MIRROR_DELAY:
                    due.append(pid)
                    del _mirror_pending[pid]
            if not due and not _mirror_pending:
                _mirror_thread = None  # idle: exit; next edit restarts us
                return
        provider = getattr(app, "deezer", None)
        if provider is None:
            continue
        for pid in due:
            try:
                open_connection(reuse=True)
                try:
                    pl = Playlist[pid]
                except Playlist.DoesNotExist:
                    continue  # deleted meanwhile
                _mirror_now(provider, pl)
            except Exception:
                logger.warning("playlist mirror worker failed for %s", pid, exc_info=True)
            finally:
                try:
                    close_connection()
                except Exception:
                    pass


def _push_async(label, fn, *args):
    """Run a single fail-soft Deezer push off the request thread (inline in
    tests). For calls that need no DB access — pass plain values, not rows."""

    def run():
        try:
            fn(*args)
        except Exception:
            logger.warning("Deezer %s failed", label, exc_info=True)

    if current_app.testing:
        run()
        return
    threading.Thread(target=run, name=f"deezer-{label}", daemon=True).start()


# -- auth -------------------------------------------------------------------


@webapi.route("/login", methods=["POST"])
def login():
    throttled = not current_app.testing
    if throttled and auth_limiter.is_blocked(request.remote_addr):
        return jsonify({"error": "too many attempts, try again later"}), 429
    data = request.get_json(silent=True) or request.form
    username = data.get("username")
    password = data.get("password")
    user = UserManager.try_auth(username, password) if username and password else None
    if user is None:
        logger.error(
            "Failed web login for user %s (IP: %s)", username, request.remote_addr
        )
        if throttled:
            auth_limiter.record_failure(request.remote_addr)
        return jsonify({"error": "invalid credentials"}), 401
    auth_limiter.reset(request.remote_addr)
    session["uid"] = str(user.id)
    session.permanent = True
    return jsonify({"user": {"name": user.name, "admin": user.admin}})


@webapi.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@webapi.route("/me")
@login_required
def me():
    u = request.webuser
    return jsonify({"user": {"name": u.name, "admin": u.admin}})


# -- discovery --------------------------------------------------------------


def _smart_cover(data):
    cover = data.get("COVER") or {}
    md5 = cover.get("MD5")
    kind = (cover.get("TYPE") or "misc").lower()
    if not md5:
        pics = data.get("PICTURES") or []
        if pics:
            md5 = pics[0].get("MD5")
            kind = (pics[0].get("TYPE") or kind).lower()
    return _image(kind, md5)


@webapi.route("/home")
@login_required
def home():
    """Card-based home: personalized mixes (smart tracklists), no track dump."""
    if not _is_admin():
        return jsonify({"mixes": []})  # guests get no personalized Deezer mixes
    provider = _provider()
    from ..deezer.importer import smart_ids_from_config

    mixes = []
    for sid in smart_ids_from_config(current_app.config["DEEZER"]):
        res = None
        if provider is not None:
            try:
                res = provider.get_smart_tracklist(sid)
            except Exception:
                res = None
        if res:
            data = (res or {}).get("DATA") or {}
            songs = ((res or {}).get("SONGS") or {}).get("data", [])
            if not songs:
                continue
            artists = []
            for s in songs[:4]:
                name = s.get("ART_NAME")
                if name and name not in artists:
                    artists.append(name)
            subtitle = data.get("DESCRIPTION") or (
                "Avec " + ", ".join(artists) if artists else ""
            )
            mixes.append(
                {
                    "id": sid,
                    "title": data.get("TITLE") or sid,
                    "subtitle": subtitle,
                    "cover": _smart_cover(data),
                }
            )
            continue
        # Deezer down/disabled: rebuild the mix card from its last synced DB copy.
        pl = _db_mix_for(sid)
        if pl is None:
            continue
        tracks = pl.get_tracks()
        if not tracks:
            continue
        title = pl.name[len("Deezer · "):] if pl.name.startswith("Deezer · ") else pl.name
        mixes.append(
            {
                "id": sid,
                "title": title,
                "subtitle": pl.comment or "",
                "cover": _db_playlist_cover([_db_track(tracks[0])]),
            }
        )
    return jsonify({"mixes": mixes})


@webapi.route("/smarttracklist/<sid>")
@login_required
def smarttracklist(sid):
    provider = _provider()
    if provider is not None:
        try:
            res = provider.get_smart_tracklist(sid)
            data = (res or {}).get("DATA") or {}
            songs = (res or {}).get("SONGS") or {}
            return jsonify(
                {
                    "playlist": {
                        "deezer_id": sid,
                        "title": data.get("TITLE") or sid,
                        "description": data.get("SUBTITLE") or data.get("DESCRIPTION") or "",
                        "cover": _smart_cover(data),
                        "nb_tracks": songs.get("total") or len(songs.get("data", [])),
                    },
                    "tracks": _tracks(songs.get("data", [])),
                }
            )
        except Exception:
            logger.warning("smart tracklist %s failed; trying local DB", sid, exc_info=True)
    # Deezer down/disabled: serve the last synced copy of this mix from the DB.
    pl = _db_mix_for(sid)
    if pl is not None:
        tracks = [_db_track(t) for t in pl.get_tracks()]
        title = pl.name[len("Deezer · "):] if pl.name.startswith("Deezer · ") else pl.name
        return jsonify(
            {
                "playlist": {
                    "deezer_id": sid,
                    "title": title,
                    "description": pl.comment or "",
                    "cover": _db_playlist_cover(tracks),
                    "nb_tracks": len(tracks),
                },
                "tracks": tracks,
            }
        )
    if provider is None:
        return jsonify({"error": "Deezer proxy disabled"}), 503
    return jsonify({"error": "not found"}), 404


def _data(fn):
    """Call a public-API method and return its ``data`` list, never raising."""
    try:
        return (fn() or {}).get("data", []) or []
    except Exception:
        logger.warning("Deezer public API call failed", exc_info=True)
        return []


def _podcast_card(p):
    """A public-API podcast (show) search result, shaped as a card."""
    if not p or not p.get("id"):
        return None
    return {
        "deezer_id": str(p.get("id")),
        "title": p.get("title", "") or "",
        "description": p.get("description", "") or "",
        "cover": p.get("picture_xl")
        or p.get("picture_big")
        or p.get("picture_medium")
        or p.get("picture"),
        "fans": int(p.get("nb_fan") or p.get("fans") or 0),
    }


@webapi.route("/search")
@login_required
def search():
    query = request.args.get("q", "").strip()
    empty = {"artists": [], "albums": [], "tracks": [], "playlists": [], "podcasts": []}
    if not query:
        return jsonify(empty)
    try:
        limit = int(request.args.get("limit", 25))
    except (TypeError, ValueError):
        limit = 25
    limit = max(1, min(limit, 50))

    # Local files first — always available, even when Deezer is unreachable.
    try:
        local_tracks = _local_search_tracks(query, limit)
    except Exception:
        logger.warning("Local search failed", exc_info=True)
        local_tracks = []

    provider = _provider()
    if provider is None:
        return jsonify({**empty, "tracks": local_tracks})

    # Public API (api.deezer.com): stable, typed, returns playlists + image URLs.
    dzapi = provider.dz.api
    tracks = [_track_api(t) for t in _data(lambda: dzapi.search(query, limit=limit))]
    albums = [_album_api(a) for a in _data(lambda: dzapi.search_album(query, limit=limit))]
    artists = [_artist_api(a) for a in _data(lambda: dzapi.search_artist(query, limit=limit))]
    playlists = [
        _playlist_api(p) for p in _data(lambda: dzapi.search_playlist(query, limit=limit))
    ]
    podcasts = [
        _podcast_card(p) for p in _data(lambda: dzapi.search_podcast(query, limit=limit))
    ]
    # Downloaded/local tracks lead (they play from disk); drop the live-search
    # duplicates of the same Deezer ids so a track isn't listed twice.
    have = {t["deezer_id"] for t in local_tracks}
    return jsonify(
        {
            "tracks": local_tracks + [x for x in tracks if x and x["deezer_id"] not in have],
            "albums": [x for x in albums if x],
            "artists": [x for x in artists if x],
            "playlists": [x for x in playlists if x],
            "podcasts": [x for x in podcasts if x],
        }
    )


@webapi.route("/search/podcasts")
@login_required
def search_podcasts():
    query = request.args.get("q", "").strip()
    provider = _provider()
    if not query or provider is None:
        return jsonify({"podcasts": []})
    try:
        limit = max(1, min(int(request.args.get("limit", 25)), 50))
    except (TypeError, ValueError):
        limit = 25
    res = [
        _podcast_card(p)
        for p in _data(lambda: provider.dz.api.search_podcast(query, limit=limit))
    ]
    return jsonify({"podcasts": [x for x in res if x]})


@webapi.route("/artist/<artist_id>")
@login_required
def artist(artist_id):
    """Artist page via the public API (the gateway pageArtist is legacy)."""
    provider = _provider()
    if provider is not None:
        dzapi = provider.dz.api
        try:
            info = dzapi.get_artist(artist_id)
        except Exception:
            logger.warning("artist %s lookup failed; trying local DB", artist_id, exc_info=True)
            info = None
        if info and info.get("id"):
            top = [_track_api(t) for t in _data(lambda: dzapi.get_artist_top(artist_id, limit=15))]
            albums = [_album_api(a) for a in _data(lambda: dzapi.get_artist_albums(artist_id, limit=50))]
            related = [_artist_api(a) for a in _data(lambda: dzapi.get_artist_related(artist_id, limit=20))]
            return jsonify(
                {
                    "artist": _artist_api(info),
                    "bio": None,
                    "top": [x for x in top if x],
                    "albums": [x for x in albums if x],
                    "related": [x for x in related if x],
                }
            )
    # Fall back to the imported/archived artist in the DB (offline browsing).
    ar = (
        Artist.select().where(Artist.deezer_id == str(artist_id)).first()
        if _valid_id(artist_id)
        else None
    )
    if ar is not None:
        return jsonify(_db_artist_response(ar))
    if provider is None:
        return jsonify({"error": "Deezer proxy disabled"}), 503
    return jsonify({"error": "not found"}), 404


def _db_album_by_id(album_id):
    """The DB Album for a Deezer numeric id, or None (no network)."""
    if not _valid_id(album_id):
        return None
    return Album.select().where(Album.deezer_id == str(album_id)).first()


@webapi.route("/album/<album_id>")
@login_required
def album(album_id):
    provider = _provider()
    if provider is not None:
        try:
            page = provider.dz.gw.get_album_page(album_id) or {}
            data = page.get("DATA") or {}
            if data.get("ALB_ID"):
                try:
                    songs = provider.get_album_tracks(album_id)
                except Exception:
                    songs = (page.get("SONGS") or {}).get("data", [])
                return jsonify({"album": _album(data), "tracks": _tracks(songs)})
        except Exception:
            logger.warning("album %s page failed; trying local DB", album_id, exc_info=True)
    # Deezer disabled/unreachable (or the album isn't on Deezer): serve the
    # imported/archived copy from the DB so downloaded albums browse offline.
    alb = _db_album_by_id(album_id)
    if alb is not None:
        return jsonify(_db_album_response(alb))
    if provider is None:
        return jsonify({"error": "Deezer proxy disabled"}), 503
    return jsonify({"error": "not found"}), 404


@webapi.route("/playlist/<playlist_id>")
@login_required
def playlist(playlist_id):
    # A user playlist lives in the DB (editable, may contain local files); a
    # recommendation/editorial playlist is read straight from Deezer (read-only).
    pl = _resolve_db_playlist(playlist_id)
    if pl is not None:
        tracks = [_db_track(t) for t in _db_playlist_track_rows(pl)]
        return jsonify(
            {
                "playlist": {
                    "id": str(pl.id),
                    "deezer_id": pl.deezer_id,
                    "title": pl.name,
                    "description": pl.comment or "",
                    "cover": _db_playlist_cover(tracks),
                    "nb_tracks": len(tracks),
                    "owner": pl.user.name,
                    "is_favorite": False,
                    "editable": _is_admin(),
                },
                "tracks": tracks,
            }
        )

    provider, err = _need_provider()
    if err:
        return err
    try:
        page = provider.get_playlist_page(playlist_id) or {}
    except Exception:
        logger.warning("playlist %s page failed", playlist_id, exc_info=True)
        return jsonify({"error": "not found"}), 404
    data = page.get("DATA") or {}
    if not data.get("PLAYLIST_ID"):
        return jsonify({"error": "not found"}), 404
    # pagePlaylist only returns the first page of songs; fetch them all.
    try:
        songs = provider.get_playlist_tracks(playlist_id)
    except Exception:
        songs = (page.get("SONGS") or {}).get("data", [])
    out = _playlist(data)
    out["editable"] = False
    return jsonify({"playlist": out, "tracks": _tracks(songs)})


@webapi.route("/artist/<artist_id>/discography")
@login_required
def discography(artist_id):
    provider = _provider()
    tabs = {}
    if provider is not None:
        try:
            tabs = provider.get_artist_discography(artist_id)
        except Exception:
            logger.warning("discography %s failed; trying local DB", artist_id, exc_info=True)
            tabs = {}
    # Deezer gave nothing (down/disabled): list the artist's archived albums.
    if not tabs and _valid_id(artist_id):
        ar = Artist.select().where(Artist.deezer_id == str(artist_id)).first()
        if ar is not None:
            albums = Album.select(Album, Artist).join(Artist).where(Album.artist == ar)
            cards = [_db_album_card(a) for a in albums]
            cards.sort(key=lambda x: str(x.get("year") or ""), reverse=True)
            # Keys the Artist page reads: `album` (grid) and `all` (latest shelf).
            return jsonify({"discography": {"album": cards, "all": cards} if cards else {}})
    out = {}
    for tab, releases in (tabs or {}).items():
        items = [
            {
                "deezer_id": str(r.get("id")),
                "title": r.get("title", ""),
                "cover": _image("cover", r.get("md5_image")),
                "release_date": (str(r.get("release_date") or "")[:10]) or None,
                "year": (str(r.get("release_date") or "")[:4]) or None,
                "record_type": r.get("record_type"),
                "nb_tracks": r.get("nb_song"),
            }
            for r in (releases or [])
        ]
        # Surface the most recent releases first so the client can show a
        # "latest releases" shelf without re-sorting (the gw order isn't reliable).
        items.sort(key=lambda x: x["release_date"] or "", reverse=True)
        out[tab] = items
    return jsonify({"discography": out})


@webapi.route("/lyrics/<track_id>")
@login_required
def lyrics(track_id):
    # Lyrics are a Deezer-only nicety (not stored locally): degrade to "no
    # lyrics" when Deezer is disabled or unreachable rather than erroring.
    provider = _provider()
    if provider is None:
        return jsonify({"lyrics": None})
    try:
        raw = provider.get_lyrics(track_id)
    except Exception:
        return jsonify({"lyrics": None})
    return jsonify({"lyrics": _lyrics(raw)})


# -- radio / flow / recommendations -----------------------------------------


@webapi.route("/flow")
@login_required
def flow():
    if not _is_admin():
        return jsonify({"tracks": []})  # Flow is the account owner's personal radio
    provider, err = _need_provider()
    if err:
        return err
    res = provider.get_flow()
    return jsonify({"tracks": _tracks((res or {}).get("data", []))})


def _gql_pic(pic):
    """A picture's `medium` field is a URL or a list of URLs."""
    m = (pic or {}).get("medium")
    if isinstance(m, list):
        return m[0] if m else None
    return m if isinstance(m, str) else None


@webapi.route("/flow/clusters")
@login_required
def flow_clusters():
    """The Flow's genre/style clusters and whether each is enabled."""
    if not _is_admin():
        return jsonify({"available": False, "clusters": []})
    provider, err = _need_provider()
    if err:
        return err
    try:
        nodes = provider.flow_clusters()
    except Exception:
        logger.warning("Flow clusters lookup failed", exc_info=True)
        return jsonify({"available": False, "clusters": []})
    clusters = []
    for n in nodes:
        cl = n.get("cluster") or {}
        artists = cl.get("artists") or []
        cover = None
        for a in artists:
            cover = _gql_pic(a.get("picture"))
            if cover:
                break
        clusters.append(
            {
                "id": cl.get("id"),
                "title": cl.get("title"),
                "enabled": bool(n.get("isEnabled")),
                "cover": cover,
                "artists": [a.get("name") for a in artists[:4] if a.get("name")],
            }
        )
    return jsonify({"available": True, "clusters": clusters})


@webapi.route("/flow/clusters", methods=["POST"])
@login_required
@admin_required
def set_flow_clusters():
    provider, err = _need_provider()
    if err:
        return err
    items = (request.get_json(silent=True) or {}).get("clusters") or []
    clusters = []
    for it in items:
        cid = it.get("id")
        if not cid:
            continue
        enabled = bool(it.get("enabled", True))
        # Every cluster the user touched here is an explicit choice, so flag it
        # as edited in BOTH directions. Marking only disabled ones as edited let
        # Deezer treat the enabled ones as "default" and drop them, so reopening
        # the tuner showed nothing checked.
        clusters.append(
            {"clusterId": cid, "isEnabled": enabled, "isEditedByUser": True}
        )
    if not clusters:
        return jsonify({"error": "no clusters"}), 400
    try:
        provider.set_flow_clusters(clusters)
    except Exception:
        logger.warning("Flow clusters update failed", exc_info=True)
        return jsonify({"error": "update failed"}), 502
    return jsonify({"ok": True})


@webapi.route("/radio/track/<track_id>")
@login_required
def track_radio(track_id):
    """An endless mix seeded from a single track."""
    provider, err = _need_provider()
    if err:
        return err
    res = provider.get_track_mix(track_id)
    return jsonify({"tracks": _tracks((res or {}).get("data", []))})


@webapi.route("/radio/artist/<artist_id>")
@login_required
def artist_radio(artist_id):
    """Artist radio via the public API (/artist/{id}/radio)."""
    provider, err = _need_provider()
    if err:
        return err
    tracks = [
        _track_api(t)
        for t in _data(lambda: provider.dz.api.get_artist_radio(artist_id, limit=40))
    ]
    return jsonify({"tracks": [x for x in tracks if x]})


@webapi.route("/recommendations")
@login_required
def recommendations():
    """Discovery rows for the home: new releases + charts (public API, stable)."""
    if not _is_admin():
        return jsonify({"albums": [], "artists": [], "playlists": []})
    provider, err = _need_provider()
    if err:
        return err
    dzapi = provider.dz.api
    albums = [_album_api(a) for a in _data(lambda: dzapi.get_editorial_releases(limit=25))]
    artists = [_artist_api(a) for a in _data(lambda: dzapi.get_chart_artists(limit=25))]
    playlists = [_playlist_api(p) for p in _data(lambda: dzapi.get_chart_playlists(limit=25))]
    return jsonify(
        {
            "albums": [x for x in albums if x],
            "artists": [x for x in artists if x],
            "playlists": [x for x in playlists if x],
        }
    )


# -- my library -------------------------------------------------------------


@webapi.route("/me/playlists")
@login_required
def my_playlists():
    # The playlists belong to the account owner (admin); guests don't see them.
    if not _is_admin():
        return jsonify({"playlists": []})
    out = []
    query = (
        Playlist.select()
        .where(
            (Playlist.user == request.webuser) | (Playlist.deezer_id.is_null(False))
        )
        .order_by(Playlist.created.desc())
    )
    for pl in query:
        # Count + first-track cover only — loading every track of every
        # playlist just for this made the list (refetched after each playlist
        # edit) scale with the whole library.
        nb = PlaylistTrack.select().where(PlaylistTrack.playlist == pl).count()
        first = _db_playlist_track_rows(pl).limit(1).first()
        out.append(
            {
                "id": str(pl.id),
                "deezer_id": pl.deezer_id,
                "title": pl.name,
                "cover": _db_playlist_cover([_db_track(first)]) if first else None,
                "nb_tracks": nb,
                "editable": True,
            }
        )
    return jsonify({"playlists": out})


@webapi.route("/me/favorite-ids")
@login_required
def my_favorite_ids():
    """Just the favorite track ids (cheap) — for accurate heart state in the UI."""
    # Guests: their own private stars only (Deezer id when known, else UUID).
    if not _is_admin():
        ids = [str(t.deezer_id) if t.deezer_id else str(t.id) for t in _user_starred()]
        return jsonify({"ids": ids})
    ids = [str(t.id) for t in _local_starred()]  # local stars (UUIDs)
    provider = _provider()
    live_ok = False
    if provider is not None:
        try:
            raw = provider.dz.gw.get_user_favorite_ids(limit=100000)
            ids += [str(x.get("SNG_ID")) for x in (raw.get("data") or []) if x.get("SNG_ID")]
            live_ok = True
        except Exception:
            pass
    if not live_ok:
        # Deezer unreachable: use the Deezer stars already mirrored in the DB so
        # heart state stays correct offline.
        ids += [str(t.deezer_id) for t in _deezer_starred() if t.deezer_id]
    return jsonify({"ids": ids})


@webapi.route("/me/local")
@login_required
def my_local():
    """All local (imported/uploaded) tracks — the home of your own files."""
    q = (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .switch(Track)
        .where(Track.deezer_id.is_null(True))
        .order_by(Artist.name, Album.name, Track.disc, Track.number)
        .limit(5000)
    )
    return jsonify({"tracks": [_local_track(t) for t in q]})


@webapi.route("/me/favorites")
@login_required
def my_favorites():
    # Guests: their own private stars only (no Deezer-account favorites).
    if not _is_admin():
        return jsonify({"tracks": [_db_track(t) for t in _user_starred()]})
    # Prefer the live Deezer favorites (they carry the "added" date and any
    # brand-new stars not yet synced), but never let a Deezer outage 500 the
    # route — fall back to the favorites already mirrored into the DB.
    provider = _provider()
    if provider is not None:
        try:
            tracks = [_local_track(t) for t in _local_starred()]
            # ``get_my_favorite_tracks`` returns public-API-shaped dicts, so reuse
            # ``_track_api``.
            for t in provider.get_my_favorite_tracks():
                tr = _track_api(t)
                if not tr:
                    continue
                tr["added"] = int(t.get("time_add") or t.get("DATE_ADD") or 0)
                tracks.append(tr)
            return jsonify({"tracks": tracks})
        except Exception:
            logger.warning("Deezer favorites fetch failed; serving from DB", exc_info=True)
    # Deezer disabled or unreachable: every star from the DB (local + synced).
    return jsonify({"tracks": [_db_track(t) for t in _user_starred()]})


# -- podcasts ---------------------------------------------------------------


def _podcast_owner():
    """Owner of imported podcast channels: the configured sync_user if any, else
    the requesting user."""
    sync_user = current_app.config["DEEZER"].get("sync_user")
    if sync_user:
        try:
            return User.get(name=sync_user)
        except User.DoesNotExist:
            pass
    return request.webuser


def _channel(c, with_episodes=False):
    info = {
        "id": str(c.id),
        "deezer_id": c.deezer_id,
        "title": c.title or "",
        "description": c.description or "",
        "cover": _image("talk", c.cover_art_md5),
        "episode_count": c.episodes.count(),
        "status": "error" if c.error_message else "ok",
    }
    if with_episodes:
        info["episodes"] = [
            _episode(e, c)
            for e in c.episodes.order_by(
                PodcastEpisode.publish_date.desc(), PodcastEpisode.created.desc()
            )
        ]
    return info


def _episode(e, channel=None):
    """A podcast episode shaped like a playable track for the web player.

    Its universal stream id (``deezer_id``) is the episode UUID — the same
    convention local tracks use — so the existing queue/player machinery plays
    it unchanged via ``/api/stream/<uuid>``.
    """
    channel = channel or e.channel
    cover = _image("talk", e.image_md5 or channel.cover_art_md5)
    return {
        "deezer_id": str(e.id),
        "podcast": True,
        "title": e.title,
        "description": e.description or "",
        "duration": e.duration or 0,
        "published": int(e.publish_date.timestamp()) if e.publish_date else 0,
        "status": e.status,
        "explicit": False,
        "channel_id": str(channel.id),
        "artist": {"deezer_id": str(channel.id), "name": channel.title or ""},
        "album": {
            "deezer_id": str(channel.id),
            "title": channel.title or "",
            "cover": cover,
        },
        "cover": cover,
    }


@webapi.route("/podcasts")
@login_required
def podcasts():
    channels = PodcastChannel.select().order_by(fn.lower(PodcastChannel.title))
    return jsonify({"podcasts": [_channel(c) for c in channels]})


@webapi.route("/podcast/<pid>")
@login_required
def podcast(pid):
    try:
        c = PodcastChannel[uuid.UUID(str(pid))]
    except (ValueError, PodcastChannel.DoesNotExist):
        return jsonify({"error": "not found"}), 404
    return jsonify(_channel(c, with_episodes=True))


@webapi.route("/podcasts", methods=["POST"])
@login_required
def subscribe_podcast():
    if not _is_admin():
        return jsonify({"error": "forbidden"}), 403
    provider, err = _need_provider()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "missing url"}), 400

    from ..deezer.archive import parse_deezer_ref, import_show

    try:
        kind, did = parse_deezer_ref(url)
    except ValueError:
        return jsonify({"error": "unsupported url"}), 400
    if kind not in ("show", "episode"):
        return jsonify({"error": "not a podcast url"}), 400

    show_id = did
    if kind == "episode":
        try:
            info = provider.dz.api.get_episode(did)
            show_id = (info.get("podcast") or {}).get("id") or info.get("podcast_id")
        except Exception:
            show_id = None
        if not show_id:
            return jsonify({"error": "could not resolve show"}), 400

    cfg = current_app.config["DEEZER"]
    if cfg.get("push_to_deezer", True):
        try:
            provider.add_favorite_show(show_id)
        except Exception:
            logger.debug("show.addFavorite failed for %s", show_id, exc_info=True)

    try:
        c = import_show(
            provider, _podcast_owner(), show_id,
            episode_limit=int(cfg.get("podcast_episodes") or 30),
        )
    except Exception:
        logger.warning("Podcast import failed for %s", show_id, exc_info=True)
        return jsonify({"error": "import failed"}), 502
    return jsonify(_channel(c, with_episodes=True))


@webapi.route("/podcast/<pid>", methods=["DELETE"])
@login_required
def unsubscribe_podcast(pid):
    if not _is_admin():
        return jsonify({"error": "forbidden"}), 403
    try:
        c = PodcastChannel[uuid.UUID(str(pid))]
    except (ValueError, PodcastChannel.DoesNotExist):
        return jsonify({"error": "not found"}), 404

    provider = _provider()
    cfg = current_app.config["DEEZER"]
    if provider is not None and c.deezer_id and cfg.get("push_to_deezer", True):
        try:
            provider.remove_favorite_show(c.deezer_id)
        except Exception:
            logger.debug("show.deleteFavorite failed for %s", c.deezer_id, exc_info=True)

    for e in c.episodes:
        if e.path and os.path.isfile(e.path):
            try:
                os.remove(e.path)
            except OSError:
                pass
    c.delete_instance(recursive=True)
    return ("", 204)


# -- favorites & playback ---------------------------------------------------


@webapi.route("/listen", methods=["POST"])
@login_required
def report_listen():
    """Tell Deezer a track was played (feeds recommendations/Flow).

    Opt-in: a no-op unless ``report_listens`` is enabled in the config. The web
    player calls this on every track change, so the disabled path stays cheap.
    Guests never feed telemetry — only the account owner's plays do.
    """
    if not _is_admin():
        return ("", 204)
    provider = _provider()
    if provider is None or not current_app.config["DEEZER"].get("report_listens"):
        return ("", 204)
    data = request.get_json(silent=True) or {}
    deezer_id = str(data.get("deezer_id") or "")
    if not _valid_id(deezer_id):
        return jsonify({"error": "invalid deezer_id"}), 400
    next_id = data.get("next_id")
    next_id = str(next_id) if _valid_id(next_id) else None
    ctx = data.get("context") or {}
    context = {"id": ctx.get("id", ""), "t": ctx.get("kind", "")}
    try:
        provider.report_listen(
            deezer_id,
            listened=int(data.get("listened") or 0),
            next_id=next_id,
            context=context,
            is_shuffle=bool(data.get("shuffle")),
        )
    except Exception:  # telemetry is best-effort; a Deezer outage must not 500
        logger.warning("report_listen failed", exc_info=True)
    return ("", 204)


def _set_star(track, on):
    """Star/unstar a track locally for the current web user."""
    if on:
        try:
            StarredTrack[request.webuser.id, track.id]
        except StarredTrack.DoesNotExist:
            StarredTrack.create(user=request.webuser, starred=track, date=now())
    else:
        StarredTrack.delete().where(
            StarredTrack.user == request.webuser, StarredTrack.starred == track.id
        ).execute()


@webapi.route("/favorite", methods=["POST"])
@login_required
def favorite():
    data = request.get_json(silent=True) or {}
    deezer_id = str(data.get("deezer_id") or "")
    on = bool(data.get("on", True))

    # Local track (UUID): star locally only, never touches Deezer.
    if not _valid_id(deezer_id):
        try:
            track = Track[uuid.UUID(deezer_id)]
        except (ValueError, Track.DoesNotExist):
            return jsonify({"error": "invalid deezer_id"}), 400
        _set_star(track, on)
        return jsonify({"ok": True, "favorite": on, "local": True})

    from ..deezer import archive

    provider = _provider()
    # A track we already know (imported/archived) is starred with no Deezer call,
    # so favoriting works offline. Only an unknown track needs Deezer to fetch its
    # metadata row.
    track = archive.find_local_track(deezer_id)
    if track is None:
        if provider is None:
            return jsonify({"error": "Deezer proxy disabled"}), 503
        try:
            track = archive.import_track(provider, deezer_id)
        except Exception:
            logger.warning("favorite: metadata fetch failed for %s", deezer_id, exc_info=True)
            return jsonify({"error": "track unavailable"}), 502
    # Guests keep favorites private/local — never mirror them to the Deezer account.
    if _is_admin() and provider is not None:
        try:
            if on:
                provider.dz.gw.add_song_to_favorites(deezer_id)
            else:
                provider.dz.gw.remove_song_from_favorites(deezer_id)
        except Exception as exc:
            logger.warning("Deezer favorite toggle failed: %s", exc)
        provider.invalidate_favorites_cache()  # next /me/favorites refetches
    _set_star(track, on)
    return jsonify({"ok": True, "favorite": on})


@webapi.route("/favorite/<kind>", methods=["POST"])
@login_required
@admin_required
def favorite_entity(kind):
    """Toggle a Deezer favorite for an album, artist or playlist."""
    provider, err = _need_provider()
    if err:
        return err
    handlers = {
        "album": (provider.add_favorite_album, provider.remove_favorite_album),
        "artist": (provider.add_favorite_artist, provider.remove_favorite_artist),
        "playlist": (provider.add_favorite_playlist, provider.remove_favorite_playlist),
    }
    if kind not in handlers:
        return jsonify({"error": "unknown favorite kind"}), 400
    data = request.get_json(silent=True) or {}
    deezer_id = str(data.get("deezer_id") or "")
    on = bool(data.get("on", True))
    if not _valid_id(deezer_id):
        return jsonify({"error": "invalid deezer_id"}), 400
    add, remove = handlers[kind]
    try:
        (add if on else remove)(deezer_id)
    except Exception as exc:
        logger.warning("Deezer %s favorite toggle failed: %s", kind, exc)
        return jsonify({"error": "deezer rejected the request"}), 502
    return jsonify({"ok": True, "favorite": on})


# -- playlist management -----------------------------------------------------
# All edits act on the DB Playlist (so local files are first-class) and then
# mirror the Deezer-track subset back to the account fail-soft. A playlist id is
# the Playlist UUID; a Deezer numeric id of an imported playlist also resolves.


@webapi.route("/playlists", methods=["POST"])
@login_required
@admin_required
def create_playlist():
    provider, err = _need_provider()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "missing title"}), 400
    description = data.get("description") or None
    track_rows = _resolve_tracks(provider, data.get("tracks") or [])
    deezer_ids = [t.deezer_id for t in track_rows if t.deezer_id]

    # Create the playlist on Deezer FIRST, then key the local row by the canonical
    # uuid5(deezer_id) — the very id the importer uses — so a client-created
    # playlist and its later re-import are ONE row, not a split-brain duplicate.
    # Only the Deezer-track subset is pushed; purely-local tracks are kept locally
    # but ignored on Deezer.
    from ..deezer import ids as dz_ids

    dz_id = None
    try:
        dz_id = str(provider.dz.gw.create_playlist(title, description=description, songs=deezer_ids))
    except Exception:
        logger.warning("Deezer create_playlist failed; creating local-only", exc_info=True)

    if dz_id:
        pid = dz_ids.playlist_uuid(dz_id)
        try:  # an importer run may already hold this canonical id — reuse it
            pl = Playlist[pid]
            pl.name, pl.comment, pl.deezer_id, pl.user = title, description, dz_id, request.webuser
            pl.clear()
            pl.save()
        except Playlist.DoesNotExist:
            pl = Playlist.create(
                id=pid, user=request.webuser, name=title, comment=description, deezer_id=dz_id
            )
    else:
        pl = Playlist.create(user=request.webuser, name=title, comment=description)

    for track in track_rows:
        pl.add(track)
    if not dz_id:
        _mirror_playlist(provider, pl)  # offline fallback: push when reachable
    return jsonify({"ok": True, "id": str(pl.id), "deezer_id": pl.deezer_id})


@webapi.route("/playlist/<playlist_id>", methods=["PATCH"])
@login_required
@admin_required
def edit_playlist(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    pl = _resolve_db_playlist(playlist_id)
    if pl is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(silent=True) or {}
    title = data.get("title")
    if title is not None and title.strip():
        pl.name = title.strip()
    if "description" in data:
        pl.comment = data.get("description") or None
    pl.save()
    if pl.deezer_id:
        # Deezer rename happens in the background — the local edit already
        # succeeded and must not wait on (or fail with) the network.
        _push_async(
            "edit_playlist", provider.edit_playlist, pl.deezer_id, pl.name, pl.comment
        )
    return jsonify({"ok": True})


@webapi.route("/playlist/<playlist_id>", methods=["DELETE"])
@login_required
@admin_required
def delete_playlist(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    pl = _resolve_db_playlist(playlist_id)
    if pl is None:
        return jsonify({"error": "not found"}), 404
    dz = pl.deezer_id
    pl.delete_instance(recursive=True)
    if dz:
        from ..deezer import push

        # Local delete already done; the Deezer-side delete is fail-soft and
        # runs in the background (never blocks or 500s the response).
        _push_async("delete_playlist", push.delete_playlist, provider, dz)
    return jsonify({"ok": True})


@webapi.route("/playlist/<playlist_id>/tracks", methods=["POST"])
@login_required
@admin_required
def add_playlist_tracks(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    pl = _resolve_db_playlist(playlist_id)
    if pl is None:
        return jsonify({"error": "not found"}), 404
    tracks = _resolve_tracks(provider, (request.get_json(silent=True) or {}).get("tracks") or [])
    if not tracks:
        return jsonify({"error": "no tracks"}), 400
    for track in tracks:
        pl.add(track)
    _mirror_playlist(provider, pl)
    return jsonify({"ok": True, "added": len(tracks)})


@webapi.route("/playlist/<playlist_id>/tracks", methods=["DELETE"])
@login_required
@admin_required
def remove_playlist_tracks(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    pl = _resolve_db_playlist(playlist_id)
    if pl is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(silent=True) or {}
    indexes = data.get("indexes")
    if indexes is None:
        wanted = {str(s) for s in (data.get("tracks") or [])}
        indexes = [
            i for i, t in enumerate(pl.get_tracks())
            if _track_uid(t) in wanted or str(t.id) in wanted
        ]
    indexes = [int(i) for i in indexes]
    if not indexes:
        return jsonify({"error": "no tracks"}), 400
    pl.remove_at_indexes(indexes)
    _mirror_playlist(provider, pl)
    return jsonify({"ok": True})


@webapi.route("/playlist/<playlist_id>/order", methods=["PUT"])
@login_required
@admin_required
def reorder_playlist(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    pl = _resolve_db_playlist(playlist_id)
    if pl is None:
        return jsonify({"error": "not found"}), 404
    order = [str(s) for s in ((request.get_json(silent=True) or {}).get("tracks") or [])]
    if not order:
        return jsonify({"error": "no order"}), 400
    current = pl.get_tracks()
    by_uid = {}
    for t in current:
        by_uid.setdefault(_track_uid(t), t)
        by_uid.setdefault(str(t.id), t)
    # A playlist may hold the same track several times; honour each occurrence
    # instead of collapsing them (the old set-based dedup silently DELETED
    # duplicates on every reorder).
    from collections import Counter

    avail = Counter(t.id for t in current)
    rows = []
    used = Counter()
    for uid in order:
        t = by_uid.get(uid)
        if t is None or used[t.id] >= avail[t.id]:
            continue
        rows.append((pl.id, t.id, len(rows)))
        used[t.id] += 1
    # Safety: keep any track the client omitted, appended at the end.
    for t in current:
        if used[t.id] < avail[t.id]:
            rows.append((pl.id, t.id, len(rows)))
            used[t.id] += 1
    fields = (PlaylistTrack.playlist, PlaylistTrack.track, PlaylistTrack.index)
    with db.atomic():
        PlaylistTrack.delete().where(PlaylistTrack.playlist == pl).execute()
        # Bulk insert in chunks: one statement instead of one INSERT per track
        # (a 500-track reorder was 500 round-trips on Postgres/MySQL).
        for i in range(0, len(rows), 300):
            PlaylistTrack.insert_many(rows[i : i + 300], fields=fields).execute()
    _mirror_playlist(provider, pl)
    return jsonify({"ok": True})


@webapi.route("/download", methods=["POST"])
@login_required
def download():
    """Pre-archive a set of tracks now (don't wait for playback)."""
    provider, err = _need_provider()
    if err:
        return err
    ids = [str(x) for x in ((request.get_json(silent=True) or {}).get("ids") or [])]
    ids = [x for x in ids if _valid_id(x)]
    if not ids:
        return jsonify({"error": "no ids"}), 400
    pf = getattr(current_app, "deezer_prefetch", None)
    if pf is None:
        return jsonify({"error": "downloader unavailable"}), 503
    queued = pf.download_ids(ids)
    return jsonify({"ok": True, "queued": queued})


@webapi.route("/download/status")
@login_required
def download_status():
    pf = getattr(current_app, "deezer_prefetch", None)
    return jsonify({"pending": pf.download_pending if pf else 0})


# A manual "refresh from Deezer" — the same job the auto-sync scheduler runs,
# triggered on demand. Admin-only (it touches the shared account) and run in a
# background thread so the request returns immediately; at most one at a time.
_sync_thread: threading.Thread | None = None
_sync_lock = threading.Lock()


@webapi.route("/sync", methods=["POST"])
@login_required
@admin_required
def trigger_sync():
    provider, err = _need_provider()
    if err:
        return err
    if not current_app.config["DEEZER"].get("sync_user"):
        return jsonify({"error": "no sync user configured"}), 503

    global _sync_thread
    with _sync_lock:
        if _sync_thread is not None and _sync_thread.is_alive():
            return jsonify({"ok": True, "running": True})
        from ..deezer.scheduler import _run_sync

        app = current_app._get_current_object()
        _sync_thread = threading.Thread(
            target=_run_sync, args=(app,), name="deezer-sync-manual", daemon=True
        )
        _sync_thread.start()
    return jsonify({"ok": True, "running": True})


@webapi.route("/sync/status")
@login_required
@admin_required
def sync_status():
    running = _sync_thread is not None and _sync_thread.is_alive()
    return jsonify({"running": running})


@webapi.route("/upload", methods=["POST"])
@login_required
def upload():
    """Upload audio files (any format) into the archive. They're imported on the
    spot as local library tracks — searchable, playlistable, streamable — so it's
    a one-click way to add your own music alongside Deezer."""
    archive_dir = current_app.config["DEEZER"].get("archive_dir")
    if not archive_dir:
        return jsonify({"error": "archive directory not configured"}), 503
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "no files"}), 400

    from werkzeug.utils import secure_filename

    from ..deezer import library, local

    root = library.get_root_folder(archive_dir)
    dest_dir = os.path.join(archive_dir, "Uploads")
    os.makedirs(dest_dir, exist_ok=True)

    imported, skipped = [], []
    for f in files:
        name = secure_filename(f.filename or "")
        ext = os.path.splitext(name)[1][1:].lower()
        if not name or ext not in local.AUDIO_EXTS:
            skipped.append(f.filename)
            continue
        base, e = os.path.splitext(os.path.join(dest_dir, name))
        dest, n = base + e, 0
        while os.path.exists(dest):
            n += 1
            dest = f"{base} ({n}){e}"
        f.save(dest)
        try:
            track = local.import_local_file(dest, root)
        except Exception:
            logger.warning("Upload import failed for %s", name, exc_info=True)
            track = None
        if track is not None:
            imported.append(_local_track(track))
        else:
            try:
                os.remove(dest)  # unreadable audio -> don't keep it around
            except OSError:
                pass
            skipped.append(f.filename)

    return jsonify({"imported": imported, "skipped": skipped, "count": len(imported)})


# Opus transcode bitrates (kbps) the web player may request: q=OPUS_320 etc.
_OPUS_BITRATES = {320, 256, 192, 128, 64}


def _opus_generator(flac_path, bitrate):
    """ffmpeg: decode the archived FLAC and (re)encode to Opus-in-Ogg."""
    import subprocess

    cmd = [
        "ffmpeg", "-v", "0", "-i", flac_path,
        "-map", "0:a:0", "-c:a", "libopus", "-b:a", f"{bitrate}k", "-vbr", "on",
        "-vn", "-f", "ogg", "pipe:1",
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
        # Client disconnected mid-stream: stop ffmpeg promptly instead of
        # letting it run to completion (wasted CPU under load).
        proc.kill()
        raise
    finally:
        proc.stdout.close()
        proc.wait()


def _stream_episode(episode, bitrate):
    """Stream a podcast episode: archived MP3 from disk, Opus-transcoded on
    request (cached), archiving from the podcast host on first play."""
    from ..deezer import archive

    if not (episode.path and os.path.isfile(episode.path)):
        provider, err = _need_provider()
        if err:
            return err
        try:
            archive.ensure_episode_archived(provider, episode)
        except Exception:
            logger.warning("Episode fetch failed for %s", episode.id, exc_info=True)
            return jsonify({"error": "episode unavailable"}), 502

    if bitrate:
        cache = current_app.transcode_cache
        key = f"episode-{episode.id}-opus{bitrate}.ogg"
        if cache.has(key):
            return send_file(cache.get(key), mimetype="audio/ogg", conditional=True)
        return current_app.response_class(
            cache.set_generated(key, lambda: _opus_generator(episode.path, bitrate)),
            mimetype="audio/ogg",
        )
    return send_file(episode.path, mimetype=episode.mimetype, conditional=True)


def _serve_embedded_cover(track):
    """Serve a track's archived cover: the image embedded in the audio file
    (tagged at archive time), else a cover file in its folder. Cached on disk."""
    cache = current_app.cache
    key = f"localcover-{track.id}"
    if cache.has(key):
        return send_file(cache.get(key), conditional=True)

    # Embedded artwork first.
    try:
        import mediafile

        mf = mediafile.MediaFile(track.path)
        if mf.images:
            img = mf.images[0]
            return send_file(
                cache.set(key, img.data),
                mimetype=getattr(img, "mime_type", None) or "image/jpeg",
                conditional=True,
            )
    except Exception:
        pass

    # Fall back to a cover file sitting in the track's folder.
    try:
        from ..covers import find_cover_in_folder

        found = find_cover_in_folder(os.path.dirname(track.path))
        if found:
            return send_file(found, conditional=True)
    except Exception:
        pass
    return jsonify({"error": "no cover"}), 404


@webapi.route("/localcover/<track_id>")
@login_required
def local_cover(track_id):
    """Cover art for a local (imported) track: embedded image, else folder art."""
    try:
        track = Track[uuid.UUID(str(track_id))]
    except (ValueError, Track.DoesNotExist):
        return jsonify({"error": "not found"}), 404
    return _serve_embedded_cover(track)


@webapi.route("/cover/<cid>")
@login_required
def cover(cid):
    """Cover art for ANY track — a Deezer numeric id or a local UUID — served
    same-origin. An archived track serves its embedded image; a not-yet-archived
    one proxies the art from Deezer (cached on disk). This gives the web player
    a reliable same-origin URL for the OS media-notification artwork and the
    offline cover cache, instead of depending on the client reaching the Deezer
    image CDN (flaky enough to regularly leave the notification artless)."""
    from ..deezer import archive

    if _valid_id(cid):
        track = archive.find_local_track(cid)
    else:
        try:
            track = Track[uuid.UUID(str(cid))]
        except (ValueError, Track.DoesNotExist):
            track = None
    if track is not None and os.path.isfile(track.path):
        return _serve_embedded_cover(track)

    provider = _provider()
    if provider is None:
        return jsonify({"error": "not found"}), 404
    cache = current_app.cache
    try:
        if not _valid_id(cid):
            # UUID without an archived Track: album/artist/playlist/podcast art.
            path = archive.deezer_cover_path(provider, cache, cid)
            if path:
                return send_file(path, mimetype="image/jpeg", conditional=True)
            return jsonify({"error": "not found"}), 404
        key = f"deezer-cover-{cid}"
        if cache.has(key):
            return send_file(cache.get(key), mimetype="image/jpeg", conditional=True)
        if track is not None and track.album is not None and track.album.cover_md5:
            md5 = track.album.cover_md5
        else:
            md5 = provider.get_track_info(cid).get("ALB_PICTURE")
        data = provider.fetch_cover(md5) if md5 else None
        if not data:
            return jsonify({"error": "not found"}), 404
        return send_file(cache.set(key, data), mimetype="image/jpeg", conditional=True)
    except Exception:
        logger.debug("Cover fallback failed for %s", cid, exc_info=True)
        return jsonify({"error": "not found"}), 404


@webapi.route("/stream/<deezer_id>")
@login_required
def stream(deezer_id):
    """Stream a track. Always FLAC-archived; lower qualities are Opus transcodes
    of that archived master, cached (so repeat plays are instant and seekable).

    A track that's already archived — or a local (imported) file — is served
    straight from disk with no Deezer call, so downloaded music keeps playing
    even if Deezer is unreachable. Local tracks are addressed by their UUID.
    """
    from ..deezer import archive

    # Resolve the requested quality up front: it decides whether a cold track can
    # take the stream-first (live FLAC) fast path or must be fully archived first.
    quality = (request.args.get("q") or "").upper()  # e.g. OPUS_128
    bitrate = None
    if quality.startswith("OPUS_"):
        try:
            b = int(quality.split("_", 1)[1])
            bitrate = b if b in _OPUS_BITRATES else 128
        except ValueError:
            bitrate = 128

    if _valid_id(deezer_id):
        track = archive.find_local_track(deezer_id)  # by Deezer id
    else:
        # A UUID -> a local/imported track, or a podcast episode. Both are served
        # from disk (episodes are archived from the podcast host on first play).
        try:
            key = uuid.UUID(deezer_id)
        except ValueError:
            return jsonify({"error": "invalid id"}), 400
        try:
            track = Track[key]
        except Track.DoesNotExist:
            try:
                episode = PodcastEpisode[key]
            except PodcastEpisode.DoesNotExist:
                return jsonify({"error": "invalid id"}), 400
            return _stream_episode(episode, bitrate)

    if track is None or not os.path.isfile(track.path):
        if not _valid_id(deezer_id):
            return jsonify({"error": "track unavailable"}), 404
        # Not archived yet — we need Deezer for the metadata and/or the audio.
        provider, err = _need_provider()
        if err:
            return err
        try:
            if track is None:
                # Metadata only (the DB row) — no audio download yet.
                track = archive.import_track(provider, deezer_id)
        except Exception:
            logger.warning("Stream metadata fetch failed for %s", deezer_id, exc_info=True)
            return jsonify({"error": "track unavailable"}), 502

        if not os.path.isfile(track.path):
            if not bitrate:
                # FLAC (the default web-player quality): stream the archive AS it
                # downloads so playback starts almost instantly; the archive is
                # finalized inside the generator. If the client disconnects early,
                # on_abort queues a normal background archive so it still caches.
                pf = getattr(current_app, "deezer_prefetch", None)
                on_abort = (lambda did=deezer_id: pf.download_ids([did])) if pf else None
                try:
                    mimetype, gen = archive.open_live_stream(provider, track, on_abort)
                except Exception:
                    logger.warning("Live stream failed for %s", deezer_id, exc_info=True)
                    return jsonify({"error": "track unavailable"}), 502
                return current_app.response_class(gen, mimetype=mimetype)

            # Opus on a cold track needs the full FLAC master first.
            try:
                archive.ensure_archived(provider, track)
            except Exception:
                logger.warning("Stream fetch failed for %s", deezer_id, exc_info=True)
                return jsonify({"error": "track unavailable"}), 502

    if bitrate:
        cache = current_app.transcode_cache
        key = f"deezer-{track.id}-opus{bitrate}.ogg"
        if cache.has(key):
            return send_file(cache.get(key), mimetype="audio/ogg", conditional=True)
        return current_app.response_class(
            cache.set_generated(key, lambda: _opus_generator(track.path, bitrate)),
            mimetype="audio/ogg",
        )

    # Lossless: serve the archived FLAC (range/seek via send_file).
    return send_file(track.path, mimetype=track.mimetype, conditional=True)

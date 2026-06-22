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
import uuid
from functools import wraps

from flask import Blueprint, current_app, jsonify, request, send_file, session

from ..db import Album, Artist, StarredTrack, Track, User, now
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
    q = (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .where(
            Track.deezer_id.is_null(True)
            & (
                Track.title.contains(query)
                | Album.name.contains(query)
                | Artist.name.contains(query)
            )
        )
        .order_by(Track.title)
        .limit(limit)
    )
    return [_local_track(t) for t in q]


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
    provider, err = _need_provider()
    if err:
        return err
    from ..deezer.importer import smart_ids_from_config

    mixes = []
    for sid in smart_ids_from_config(current_app.config["DEEZER"]):
        try:
            res = provider.get_smart_tracklist(sid)
        except Exception:
            continue
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
    return jsonify({"mixes": mixes})


@webapi.route("/smarttracklist/<sid>")
@login_required
def smarttracklist(sid):
    provider, err = _need_provider()
    if err:
        return err
    try:
        res = provider.get_smart_tracklist(sid)
    except Exception:
        logger.warning("smart tracklist %s failed", sid, exc_info=True)
        return jsonify({"error": "not found"}), 404
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


def _data(fn):
    """Call a public-API method and return its ``data`` list, never raising."""
    try:
        return (fn() or {}).get("data", []) or []
    except Exception:
        logger.warning("Deezer public API call failed", exc_info=True)
        return []


@webapi.route("/search")
@login_required
def search():
    query = request.args.get("q", "").strip()
    empty = {"artists": [], "albums": [], "tracks": [], "playlists": []}
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
    return jsonify(
        {
            "tracks": local_tracks + [x for x in tracks if x],
            "albums": [x for x in albums if x],
            "artists": [x for x in artists if x],
            "playlists": [x for x in playlists if x],
        }
    )


@webapi.route("/artist/<artist_id>")
@login_required
def artist(artist_id):
    """Artist page via the public API (the gateway pageArtist is legacy)."""
    provider, err = _need_provider()
    if err:
        return err
    dzapi = provider.dz.api
    try:
        info = dzapi.get_artist(artist_id)
    except Exception:
        logger.warning("artist %s lookup failed", artist_id, exc_info=True)
        info = None
    if not info or not info.get("id"):
        return jsonify({"error": "not found"}), 404
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


@webapi.route("/album/<album_id>")
@login_required
def album(album_id):
    provider, err = _need_provider()
    if err:
        return err
    try:
        page = provider.dz.gw.get_album_page(album_id) or {}
    except Exception:
        logger.warning("album %s page failed", album_id, exc_info=True)
        return jsonify({"error": "not found"}), 404
    data = page.get("DATA") or {}
    if not data.get("ALB_ID"):
        return jsonify({"error": "not found"}), 404
    # The page only carries the first batch of songs; fetch the whole tracklist.
    try:
        songs = provider.get_album_tracks(album_id)
    except Exception:
        songs = (page.get("SONGS") or {}).get("data", [])
    return jsonify({"album": _album(data), "tracks": _tracks(songs)})


@webapi.route("/playlist/<playlist_id>")
@login_required
def playlist(playlist_id):
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
    return jsonify({"playlist": _playlist(data), "tracks": _tracks(songs)})


@webapi.route("/artist/<artist_id>/discography")
@login_required
def discography(artist_id):
    provider, err = _need_provider()
    if err:
        return err
    try:
        tabs = provider.get_artist_discography(artist_id)
    except Exception:
        logger.warning("discography %s failed", artist_id, exc_info=True)
        tabs = {}
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
    provider, err = _need_provider()
    if err:
        return err
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
    if not _is_admin():
        return jsonify({"playlists": []})  # the Deezer playlists belong to the owner
    provider, err = _need_provider()
    if err:
        return err
    out = []
    for p in provider.get_user_playlists():
        out.append(
            {
                "deezer_id": str(p.get("id") or p.get("PLAYLIST_ID")),
                "title": p.get("title") or p.get("TITLE", ""),
                "cover": _image(
                    (p.get("picture_type") or "playlist"),
                    p.get("md5_image") or p.get("PLAYLIST_PICTURE"),
                ),
                "nb_tracks": p.get("nb_tracks") or p.get("NB_SONG"),
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
    if provider is not None:
        try:
            raw = provider.dz.gw.get_user_favorite_ids(limit=100000)
            ids += [str(x.get("SNG_ID")) for x in (raw.get("data") or []) if x.get("SNG_ID")]
        except Exception:
            pass
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
    # Locally-starred files first (always available), then Deezer favorites.
    tracks = [_local_track(t) for t in _local_starred()]
    provider = _provider()
    if provider is not None:
        # ``get_my_favorite_tracks`` returns public-API-shaped dicts, so reuse
        # ``_track_api``.
        for t in provider.get_my_favorite_tracks():
            tr = _track_api(t)
            if not tr:
                continue
            tr["added"] = int(t.get("time_add") or t.get("DATE_ADD") or 0)
            tracks.append(tr)
    return jsonify({"tracks": tracks})


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
    provider.report_listen(
        deezer_id,
        listened=int(data.get("listened") or 0),
        next_id=next_id,
        context=context,
        is_shuffle=bool(data.get("shuffle")),
    )
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

    provider, err = _need_provider()
    if err:
        return err
    from ..deezer import archive

    track = archive.import_track(provider, deezer_id)
    # Guests keep favorites private/local — never mirror them to the Deezer account.
    if _is_admin():
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


# -- playlist management (Subsonic side stays in sync via importer) ----------


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
    songs = [str(s) for s in (data.get("tracks") or [])]
    new_id = provider.create_playlist(
        title, description=data.get("description"), songs=songs
    )
    return jsonify({"ok": True, "deezer_id": str(new_id)})


@webapi.route("/playlist/<playlist_id>", methods=["PATCH"])
@login_required
@admin_required
def edit_playlist(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    provider.edit_playlist(
        playlist_id, title=data.get("title"), description=data.get("description")
    )
    return jsonify({"ok": True})


@webapi.route("/playlist/<playlist_id>", methods=["DELETE"])
@login_required
@admin_required
def delete_playlist(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    provider.delete_playlist(playlist_id)
    return jsonify({"ok": True})


@webapi.route("/playlist/<playlist_id>/tracks", methods=["POST"])
@login_required
@admin_required
def add_playlist_tracks(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    songs = [str(s) for s in (data.get("tracks") or [])]
    if not songs:
        return jsonify({"error": "no tracks"}), 400
    provider.add_songs_to_playlist(playlist_id, songs)
    return jsonify({"ok": True})


@webapi.route("/playlist/<playlist_id>/tracks", methods=["DELETE"])
@login_required
@admin_required
def remove_playlist_tracks(playlist_id):
    provider, err = _need_provider()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    songs = [str(s) for s in (data.get("tracks") or [])]
    if not songs:
        return jsonify({"error": "no tracks"}), 400
    provider.remove_songs_from_playlist(playlist_id, songs)
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


@webapi.route("/localcover/<track_id>")
@login_required
def local_cover(track_id):
    """Cover art for a local (imported) track: embedded image, else folder art."""
    try:
        track = Track[uuid.UUID(str(track_id))]
    except (ValueError, Track.DoesNotExist):
        return jsonify({"error": "not found"}), 404

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

    if _valid_id(deezer_id):
        track = archive.find_local_track(deezer_id)  # by Deezer id
    else:
        # A UUID -> a local (or already-imported) track, served from disk only.
        try:
            track = Track[uuid.UUID(deezer_id)]
        except (ValueError, Track.DoesNotExist):
            return jsonify({"error": "invalid id"}), 400

    if track is None or not os.path.isfile(track.path):
        if not _valid_id(deezer_id):
            return jsonify({"error": "track unavailable"}), 404
        # Not archived yet — we need Deezer for the metadata and/or the audio.
        provider, err = _need_provider()
        if err:
            return err
        try:
            track = archive.import_track(provider, deezer_id)
            if not os.path.isfile(track.path):
                archive.ensure_archived(provider, track)
        except Exception:
            logger.warning("Stream fetch failed for %s", deezer_id, exc_info=True)
            return jsonify({"error": "track unavailable"}), 502

    quality = (request.args.get("q") or "").upper()  # e.g. OPUS_128
    bitrate = None
    if quality.startswith("OPUS_"):
        try:
            b = int(quality.split("_", 1)[1])
            bitrate = b if b in _OPUS_BITRATES else 128
        except ValueError:
            bitrate = 128

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

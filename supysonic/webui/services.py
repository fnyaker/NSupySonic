# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Export a playlist to another streaming service, or as a list file.

The ZIP export (``export.py``) takes the AUDIO off the server; this takes the
LIST elsewhere — to the user's own Spotify, YouTube Music, or (admin) the
server's Deezer account — or hands it over as a CSV / XSPF / text file for
every service that has no door (Apple Music: see ``services/listfile.py``).

An export is a job on a worker thread: it can be thousands of searches, and a
request is never held for that. Every track is matched BEFORE anything is
created, so an export that finds nothing creates nothing, and one the service
refuses half-way (a network failure, a revoked token) stops there with the
reason instead of filing the rest as "not found". What could not be matched is
reported by name, so the person knows exactly which songs to add by hand.

Credentials are per user (``ServiceLink``), encrypted with the server secret,
and never lent: none of these endpoints is open to a remote-control session.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import time
import uuid

from flask import current_app, jsonify, redirect, request, session, url_for

from ..db import Album, Artist, Meta, ServiceLink, Track, now
from ..managers.user import decrypt_password, encrypt_password
from ..services import SERVICES, ServiceAuthError, ServiceError
from ..services import deezer as dz_service
from ..services import listfile, match, spotify, ytmusic
from . import (
    _db_playlist_track_rows,
    _is_admin,
    _provider,
    _resolve_db_playlist,
    _user_starred,
    _valid_id,
    login_required,
    webapi,
)

logger = logging.getLogger(__name__)

SPOTIFY_CLIENT_KEY = "sp.client_id"
SPOTIFY_REDIRECT_KEY = "sp.redirect"
_CLIENT_ID_RE = re.compile(r"\A[0-9a-fA-F]{32}\Z")
KINDS = ("playlist", "favorites", "album")
MAX_TRACKS = 10000
MISSING_SHOWN = 500  # names of unmatched tracks kept in a job's report
PKCE_TTL = 15 * 60
NAMES = {"spotify": "Spotify", "youtube": "YouTube Music", "deezer": "Deezer"}


# -- credentials -----------------------------------------------------------------


def _uid():
    return request.webuser.id


def _link(user_id, service) -> ServiceLink | None:
    return ServiceLink.get_or_none(
        (ServiceLink.user == user_id) & (ServiceLink.service == service)
    )


def _secret(link: ServiceLink):
    try:
        return decrypt_password(link.data)
    except Exception:
        # A rotated server secret: the stored credential is unreadable, which
        # is the same as having none.
        return None


def _store(user_id, service, data: str, account: str | None):
    blob = encrypt_password(data)
    row = _link(user_id, service)
    if row is None:
        ServiceLink.create(user=user_id, service=service, data=blob, account=account, updated=now())
    else:
        row.data, row.updated = blob, now()
        if account is not None:
            row.account = account
        row.save()


def _spotify_client_id() -> str | None:
    row = Meta.get_or_none(Meta.key == SPOTIFY_CLIENT_KEY)
    value = (row.value if row else "") or ""
    return value if _CLIENT_ID_RE.fullmatch(value) else None


def _redirect_here() -> str:
    # Only ever read from the ADMIN's request, when they save the app: that is
    # the address they register with Spotify, and it is frozen there.
    return url_for("webapi.services_spotify_callback", _external=True)  # nosemgrep: python.flask.security.audit.flask-url-for-external-true.flask-url-for-external-true


def _spotify_redirect() -> str | None:
    """The redirect URI the admin registered, as saved with the client id.

    Never rebuilt from the request in flight: its Host header is the client's
    to choose, and the same server is reached under several names (the LAN
    address, the public https one) while Spotify accepts exactly one."""
    row = Meta.get_or_none(Meta.key == SPOTIFY_REDIRECT_KEY)
    value = (row.value if row else "") or ""
    return value if value.startswith(("https://", "http://")) else None


def _client(service, user_id):
    """The service client for this user, or raises ServiceError in words."""
    if service == "deezer":
        provider = _provider()
        if provider is None:
            raise ServiceError("Le proxy Deezer est désactivé sur ce serveur.")
        return dz_service.Client(provider)
    row = _link(user_id, service)
    secret = _secret(row) if row else None
    if not secret:
        raise ServiceAuthError(f"Aucun compte {NAMES[service]} n'est relié.")
    if service == "spotify":
        client_id = _spotify_client_id()
        if not client_id:
            raise ServiceError("Spotify n'est pas configuré sur ce serveur.")
        try:
            creds = json.loads(secret)
        except ValueError as exc:
            raise ServiceAuthError("Reconnectez le compte Spotify.") from exc

        def persist(new):
            _store(user_id, "spotify", json.dumps(new), None)

        return spotify.Client(client_id, creds, on_update=persist)
    return ytmusic.Client(secret)


# -- status / linking ------------------------------------------------------------


@webapi.route("/services")
@login_required
def services_status():
    """Which services this user can export to, and what each one still needs."""
    admin = _is_admin()
    links = {
        row.service: row
        for row in ServiceLink.select().where(ServiceLink.user == _uid())
    }
    client_id = _spotify_client_id()
    out = [
        {
            "id": "spotify",
            "name": "Spotify",
            "ready": bool(client_id),
            "linked": "spotify" in links,
            "account": links["spotify"].account if "spotify" in links else None,
            **(
                {
                    "client_id": client_id or "",
                    "redirect_uri": _spotify_redirect() or _redirect_here(),
                    "redirect_here": _redirect_here(),
                }
                if admin
                else {}
            ),
        },
        {
            "id": "youtube",
            "name": "YouTube Music",
            "ready": ytmusic.installed(),
            "linked": "youtube" in links,
            "account": links["youtube"].account if "youtube" in links else None,
        },
    ]
    if admin:
        provider = _provider()
        out.append(
            {
                "id": "deezer",
                "name": "Deezer",
                "ready": provider is not None,
                "linked": provider is not None,
                "account": None,
            }
        )
    out.append({"id": "apple", "name": "Apple Music", "ready": False, "linked": False, "file": True})
    return jsonify({"services": out, "formats": [
        {"id": k, "label": v[2], "ext": v[1]} for k, v in listfile.FORMATS.items()
    ]})


@webapi.route("/services/spotify/app", methods=["PUT"])
@login_required
def services_spotify_app():
    """The operator's Spotify app (admin): its client id, or none."""
    if not _is_admin():
        return jsonify({"error": "forbidden"}), 403
    value = str((request.get_json(silent=True) or {}).get("client_id") or "").strip()
    if value and not _CLIENT_ID_RE.fullmatch(value):
        return jsonify({"error": "Un Client ID Spotify fait 32 caractères hexadécimaux."}), 400
    Meta.delete().where(Meta.key.in_([SPOTIFY_CLIENT_KEY, SPOTIFY_REDIRECT_KEY])).execute()
    redirect_uri = _redirect_here()
    if len(redirect_uri) > 256:
        return jsonify({"error": "L'adresse de ce serveur est trop longue pour Spotify."}), 400
    if value:
        Meta.create(key=SPOTIFY_CLIENT_KEY, value=value)
        Meta.create(key=SPOTIFY_REDIRECT_KEY, value=redirect_uri)
    return jsonify({"ok": True, "client_id": value, "redirect_uri": redirect_uri})


# An authorisation in flight, by its state: kept HERE rather than in the
# session cookie, because the browser Spotify sends back may not be the one that
# left — the Android app opens Spotify's page in the system browser, which has
# no session of ours. The state is 192 random bits, single use, short-lived.
_pending: dict = {}
_pending_lock = threading.Lock()
PENDING_MAX = 64


def _take_pending(state: str):
    with _pending_lock:
        cutoff = time.time() - PKCE_TTL
        for key in [k for k, v in _pending.items() if v["at"] < cutoff]:
            _pending.pop(key, None)
        return _pending.pop(state, None) if state else None


@webapi.route("/services/spotify/authorize")
@login_required
def services_spotify_authorize():
    client_id = _spotify_client_id()
    redirect_uri = _spotify_redirect()
    if not client_id or not redirect_uri:
        return jsonify({"error": "Spotify n'est pas configuré sur ce serveur."}), 409
    verifier, challenge = spotify.pkce_pair()
    state = secrets.token_urlsafe(24)
    with _pending_lock:
        if len(_pending) >= PENDING_MAX:
            for key in sorted(_pending, key=lambda k: _pending[k]["at"])[: PENDING_MAX // 4]:
                _pending.pop(key, None)
        _pending[state] = {
            "user": _uid(),
            "verifier": verifier,
            "redirect": redirect_uri,
            "at": time.time(),
        }
    return jsonify({"url": spotify.authorize_url(client_id, redirect_uri, state, challenge)})


_DONE_PAGE = """<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify</title>
<style>body{{font:16px system-ui,sans-serif;background:#111;color:#eee;display:grid;
place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}}</style>
</head><body><p>{message}</p></body></html>"""

_RESULTS = {
    "spotify-ok": "Compte Spotify relié. Vous pouvez revenir à l'application.",
    "spotify-denied": "Autorisation refusée sur Spotify.",
    "spotify-expired": "Ce lien d'autorisation a expiré : recommencez depuis l'application.",
    "spotify-error": "Spotify n'a pas pu être relié : recommencez depuis l'application.",
}


def _back_to_settings(result: str, user_id=None):
    """The app's settings when this browser is signed in as that user; a plain
    page saying how it went otherwise (the system browser on a phone)."""
    if user_id is not None and str(session.get("uid") or "") == str(user_id):
        root = request.script_root or ""
        return redirect(f"{root}/app/#/settings?svc={result}")
    body = _DONE_PAGE.format(message=_RESULTS[result])
    return current_app.response_class(body, mimetype="text/html")


@webapi.route("/services/spotify/callback")
def services_spotify_callback():
    """Where Spotify sends the browser back: a top-level navigation, so it
    answers with a redirect or a page, never JSON. Not login_required: the
    pending state IS the proof of who started it (see ``_pending``)."""
    pending = _take_pending(request.args.get("state") or "")
    if not pending:
        return _back_to_settings("spotify-expired")
    uid = pending["user"]
    if request.args.get("error") or not request.args.get("code"):
        return _back_to_settings("spotify-denied", uid)
    client_id = _spotify_client_id()
    if not client_id:
        return _back_to_settings("spotify-error", uid)
    try:
        creds = spotify.exchange_code(
            client_id, request.args["code"], pending["redirect"], pending["verifier"]
        )
        holder = {"creds": creds}

        def persist(new):
            holder["creds"] = new

        account = spotify.Client(client_id, creds, on_update=persist).account()
        _store(uid, "spotify", json.dumps(holder["creds"]), account)
    except ServiceError:
        logger.warning("Linking Spotify failed", exc_info=True)
        return _back_to_settings("spotify-error", uid)
    return _back_to_settings("spotify-ok", uid)


@webapi.route("/services/youtube/connect", methods=["POST"])
@login_required
def services_youtube_connect():
    raw = (request.get_json(silent=True) or {}).get("headers")
    try:
        headers_json = ytmusic.parse_headers(raw)
        account = ytmusic.Client(headers_json).account()
    except ServiceError as exc:
        return jsonify({"error": str(exc)}), 400
    _store(_uid(), "youtube", headers_json, account)
    # The same session is an account to import from (Réglages → Sources).
    from . import myaccounts
    from .. import libraryimport

    row, _created = myaccounts.link_youtube(_uid(), account)
    libraryimport.forget_client(row.id)
    libraryimport.start(current_app._get_current_object(), row.id)
    return jsonify({"ok": True, "account": account})


@webapi.route("/services/<service>", methods=["DELETE"])
@login_required
def services_disconnect(service):
    if service not in ("spotify", "youtube"):
        return jsonify({"error": "unknown service"}), 404
    ServiceLink.delete().where(
        (ServiceLink.user == _uid()) & (ServiceLink.service == service)
    ).execute()
    if service == "youtube":
        from . import myaccounts

        myaccounts.unlink_youtube(_uid())
    return jsonify({"ok": True})


# -- what to export --------------------------------------------------------------


def _album_rows(ident):
    from ..deezer import ids as dz_ids

    try:
        key = dz_ids.album_uuid(ident) if _valid_id(ident) else uuid.UUID(str(ident))
        alb = Album[key]
    except (ValueError, TypeError, Album.DoesNotExist):
        return None, None
    q = (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .where(Track.album == alb)
        .order_by(Track.disc, Track.number)
    )
    return alb.name, list(q)


def _source(kind, ident):
    """(name, tracks) for what the person wants to export, or (None, None).

    The library first (Track rows: the ISRC is on disk beside them); a Deezer
    page that is not in it — a recommendation, an editorial playlist, an album
    nobody played — is listed through the ZIP export's own readers (dicts).
    """
    from . import export

    if kind == "favorites":
        return "Favoris", _user_starred()
    if kind == "playlist":
        pl = _resolve_db_playlist(ident)
        if pl is not None:
            return pl.name, list(_db_playlist_track_rows(pl))
        return export._playlist_tracks(ident) if _valid_id(ident) else (None, None)
    if kind == "album":
        name, rows = _album_rows(ident)
        if rows is not None:
            return name, rows
        return export._album_tracks(ident) if _valid_id(ident) else (None, None)
    return None, None


NOT_FOUND = "Introuvable sur ce serveur."


def _ascii_name(name, ext):
    from urllib.parse import quote

    full = f"{name}.{ext}"
    ascii_name = re.sub(r"[^A-Za-z0-9._ -]", "_", full) or f"playlist.{ext}"
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(full, safe="")}'


@webapi.route("/services/list/<kind>/<ident>")
@login_required
def services_list_file(kind, ident):
    """The playlist as a CSV / XSPF / text file (no service asked)."""
    fmt = (request.args.get("fmt") or "csv").lower()
    if kind not in KINDS or fmt not in listfile.FORMATS:
        return jsonify({"error": "invalid request"}), 400
    name, rows = _source(kind, ident)
    if rows is None:
        return jsonify({"error": NOT_FOUND}), 404
    wants = [match.wanted(t) for t in rows[:MAX_TRACKS]]
    mime, ext, _label = listfile.FORMATS[fmt]
    body = listfile.render(fmt, name or "playlist", wants)
    resp = current_app.response_class(body, mimetype=mime.split(";")[0])
    resp.headers["Content-Type"] = mime
    from .export import _safe

    resp.headers["Content-Disposition"] = _ascii_name(_safe(name or "playlist"), ext)
    resp.headers["Cache-Control"] = "no-store"
    return resp


# -- the export job --------------------------------------------------------------

_jobs: dict = {}
_jobs_lock = threading.Lock()
_running: set = set()  # user ids with an export in flight
_JOBS_MAX = 40


def _job_update(job_id, **fields):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(fields)


@webapi.route("/services/<service>/export", methods=["POST"])
@login_required
def services_export(service):
    if service not in SERVICES:
        return jsonify({"error": "unknown service"}), 404
    if service == "deezer" and not _is_admin():
        return jsonify({"error": "forbidden"}), 403
    data = request.get_json(silent=True) or {}
    kind, ident = str(data.get("kind") or ""), str(data.get("id") or "")
    if kind not in KINDS:
        return jsonify({"error": "invalid kind"}), 400
    name, rows = _source(kind, ident)
    if rows is None:
        return jsonify({"error": NOT_FOUND}), 404
    if not rows:
        return jsonify({"error": "Rien à exporter : la liste est vide."}), 400
    title = " ".join(str(data.get("name") or name or "Playlist").split())[:100] or "Playlist"
    try:
        client = _client(service, _uid())
    except ServiceAuthError as exc:
        return jsonify({"error": str(exc), "relink": True}), 409
    except ServiceError as exc:
        return jsonify({"error": str(exc)}), 409

    uid = _uid()
    with _jobs_lock:
        if uid in _running:
            return jsonify({"error": "Un export est déjà en cours."}), 429
        _running.add(uid)
        if len(_jobs) >= _JOBS_MAX:
            for stale in sorted(_jobs, key=lambda k: _jobs[k]["started"])[:10]:
                if not _jobs[stale]["running"]:
                    _jobs.pop(stale, None)
        job_id = uuid.uuid4().hex
        _jobs[job_id] = {
            "user": str(uid),
            "service": service,
            "name": title,
            "started": time.time(),
            "running": True,
            "stage": "match",
            "total": min(len(rows), MAX_TRACKS),
            "done": 0,
            "matched": 0,
            "missing": [],
            "missing_count": 0,
            "url": None,
            "error": None,
            "relink": False,
        }
    threading.Thread(
        target=_run_export,
        args=(current_app._get_current_object(), job_id, uid, client, title, rows[:MAX_TRACKS],
              bool(data.get("public"))),
        name=f"export-{service}",
        daemon=True,
    ).start()
    return jsonify({"job": job_id}), 202


def _run_export(app, job_id, uid, client, title, rows, public):
    from ..db import close_connection, open_connection

    ids, seen = [], set()
    missing, missing_count = [], 0
    try:
        with app.app_context():
            open_connection(reuse=True)
            # Read here, not in the request: the ISRC comes off the disk (the
            # sidecar, the tags), a file per track.
            wants = [match.wanted(t) for t in rows]
            for i, want in enumerate(wants, 1):
                found = client.find(want)
                if found and found not in seen:
                    seen.add(found)
                    ids.append(found)
                elif not found:
                    missing_count += 1
                    if len(missing) < MISSING_SHOWN:
                        missing.append({"title": want["title"], "artist": want["artist"]})
                if i % 5 == 0 or i == len(wants):
                    _job_update(job_id, done=i, matched=len(ids), missing=list(missing),
                                missing_count=missing_count)
            if not ids:
                _job_update(job_id, running=False, stage="done",
                            error=f"Aucun titre trouvé sur {client.name}.")
                return
            _job_update(job_id, stage="create")
            url = client.create_playlist(
                title, "Exportée depuis NSupySonic", ids, public=public
            )
            _job_update(job_id, running=False, stage="done", url=url)
    except ServiceAuthError as exc:
        _job_update(job_id, running=False, stage="done", error=str(exc), relink=True)
    except ServiceError as exc:
        _job_update(job_id, running=False, stage="done", error=str(exc))
    except Exception as exc:  # pragma: no cover - reported, never silent
        logger.warning("Export %s failed", job_id, exc_info=True)
        _job_update(job_id, running=False, stage="done", error=f"Échec : {exc}")
    finally:
        with _jobs_lock:
            _running.discard(uid)
        try:
            close_connection()
        except Exception:
            pass


@webapi.route("/services/export/<job_id>")
@login_required
def services_export_status(job_id):
    with _jobs_lock:
        job = _jobs.get(str(job_id))
        if job is not None:
            job = {k: list(v) if isinstance(v, list) else v for k, v in job.items()}
    if job is None or job["user"] != str(_uid()):
        return jsonify({"error": "unknown job"}), 404
    job.pop("user", None)
    return jsonify(job)

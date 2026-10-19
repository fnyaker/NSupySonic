# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Spotify: the Web API, through the operator's own Spotify app.

Spotify has no way in without an app registered on developer.spotify.com, and
since February 2026 an app in development mode is tied to its owner's Premium
subscription and allows five users — exactly a household server's shape, and
the reason the client id is the OPERATOR's (Réglages → Services), never ours.

Auth is the Authorization Code flow with PKCE: no client secret exists on this
server, so there is none to leak; the refresh token Spotify hands back is what
is kept (encrypted, per user). Spotify rotates it on refresh, so every refresh
is written back (``on_update``).

The endpoints are the post-February-2026 ones: ``POST /me/playlists`` and
``POST /playlists/{id}/items`` (``/users/{id}/playlists`` and ``…/tracks`` are
gone), and a search answers at most 10 results.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
from urllib.parse import urlencode

import requests

from . import ServiceAuthError, ServiceError
from .match import pick

logger = logging.getLogger(__name__)

API = "https://api.spotify.com/v1"
ACCOUNTS = "https://accounts.spotify.com"
SCOPES = "playlist-modify-private playlist-modify-public"
TIMEOUT = (5, 20)  # connect, read: never a scalar (see deezerpy.DEFAULT_TIMEOUT)
SEARCH_LIMIT = 10  # Spotify's own cap since February 2026
ADD_BATCH = 100  # items per "add to playlist" call
MAX_WAIT = 30  # s: the longest Retry-After we sit through, per call
MAX_TRIES = 4


def new_session():
    """A plain HTTP session (a seam the tests replace)."""
    return requests.Session()


def pkce_pair() -> tuple[str, str]:
    """(verifier, S256 challenge) for one authorisation."""
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def authorize_url(client_id: str, redirect_uri: str, state: str, challenge: str) -> str:
    return ACCOUNTS + "/authorize?" + urlencode(
        {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
            "scope": SCOPES,
            "state": state,
        }
    )


def _token_request(session, data: dict) -> dict:
    try:
        r = session.post(ACCOUNTS + "/api/token", data=data, timeout=TIMEOUT)
    except requests.RequestException as exc:
        logger.warning("Spotify token request failed: %s", exc)
        raise ServiceError("Spotify injoignable.") from exc
    if r.status_code == 400:
        # invalid_grant: the code was used, or the refresh token was revoked.
        raise ServiceAuthError("Spotify a refusé l'autorisation : reconnectez le compte.")
    if r.status_code >= 400:
        raise ServiceError(f"Spotify a répondu {r.status_code} à la demande de jeton.")
    try:
        body = r.json()
    except ValueError as exc:
        raise ServiceError("Réponse de jeton illisible.") from exc
    if not body.get("access_token"):
        raise ServiceError("Spotify n'a pas renvoyé de jeton.")
    return body


def _creds(body: dict, previous: dict | None = None) -> dict:
    return {
        "access_token": body["access_token"],
        # A refresh may or may not rotate it; keep the old one when it doesn't.
        "refresh_token": body.get("refresh_token") or (previous or {}).get("refresh_token"),
        "expires_at": int(time.time()) + int(body.get("expires_in") or 3600) - 60,
    }


def exchange_code(client_id, code, redirect_uri, verifier, session=None) -> dict:
    """The authorisation code -> stored credentials."""
    session = session or new_session()
    body = _token_request(
        session,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )
    return _creds(body)


def _candidate(item: dict) -> dict | None:
    if not isinstance(item, dict) or not item.get("uri"):
        return None
    return {
        "id": item["uri"],
        "title": str(item.get("name") or ""),
        "artists": [
            {"name": str(a.get("name") or "")}
            for a in item.get("artists") or []
            if isinstance(a, dict)
        ],
        "duration": int((item.get("duration_ms") or 0) / 1000),
    }


def _field(text: str) -> str:
    """A value for a ``track:"…"`` filter: quotes would end it early."""
    return " ".join(str(text or "").replace('"', " ").split())[:100]


class Client:
    """One user's Spotify account."""

    name = "Spotify"

    def __init__(self, client_id: str, creds: dict, on_update=None, session=None):
        self.client_id = client_id
        self.creds = dict(creds or {})
        self.on_update = on_update
        self.session = session or new_session()
        self.sleep = time.sleep

    # -- transport --

    def _refresh(self):
        if not self.creds.get("refresh_token"):
            raise ServiceAuthError("Spotify n'est plus autorisé : reconnectez le compte.")
        body = _token_request(
            self.session,
            {
                "grant_type": "refresh_token",
                "refresh_token": self.creds["refresh_token"],
                "client_id": self.client_id,
            },
        )
        self.creds = _creds(body, self.creds)
        if self.on_update:
            self.on_update(self.creds)

    def call(self, method: str, path: str, **kw):
        if time.time() >= int(self.creds.get("expires_at") or 0):
            self._refresh()
        refreshed = False
        for _ in range(MAX_TRIES):
            headers = {"Authorization": "Bearer " + str(self.creds.get("access_token"))}
            try:
                r = self.session.request(
                    method, API + path, headers=headers, timeout=TIMEOUT, **kw
                )
            except requests.RequestException as exc:
                logger.warning("Spotify %s %s failed: %s", method, path, exc)
                raise ServiceError("Spotify injoignable.") from exc
            if r.status_code == 401 and not refreshed:
                refreshed = True
                self._refresh()
                continue
            if r.status_code == 429:
                try:
                    wait = float(r.headers.get("Retry-After") or 1)
                except ValueError:
                    wait = 1.0
                if wait > MAX_WAIT:
                    raise ServiceError("Spotify limite les requêtes : réessayez plus tard.")
                self.sleep(max(wait, 0.5))
                continue
            if r.status_code == 401:
                raise ServiceAuthError("Spotify n'est plus autorisé : reconnectez le compte.")
            if r.status_code == 403:
                raise ServiceError(
                    "Spotify refuse (403). En mode développement, l'application doit "
                    "appartenir à un compte Premium et ce compte Spotify doit figurer "
                    "dans ses utilisateurs (developer.spotify.com → User Management)."
                )
            if r.status_code >= 400:
                raise ServiceError(f"Spotify a répondu {r.status_code}.")
            if not r.content:
                return {}
            try:
                return r.json()
            except ValueError as exc:
                raise ServiceError("Réponse Spotify illisible.") from exc
        raise ServiceError("Spotify limite les requêtes : réessayez plus tard.")

    # -- the three questions --

    def account(self) -> str:
        me = self.call("GET", "/me")
        return str(me.get("display_name") or me.get("id") or "Spotify")[:128]

    def _search(self, q: str) -> list:
        body = self.call(
            "GET", "/search", params={"q": q, "type": "track", "limit": SEARCH_LIMIT}
        )
        items = ((body.get("tracks") or {}).get("items")) or []
        return [c for c in (_candidate(i) for i in items) if c]

    def find(self, want: dict) -> str | None:
        """The track's Spotify URI, or None when Spotify has no safe match."""
        if want.get("isrc"):
            hits = self._search("isrc:" + want["isrc"])
            # One ISRC is one recording; still judged, since a few labels
            # reuse ISRCs across a compilation's other tracks.
            found = pick(want, hits) or (hits[0] if len(hits) == 1 else None)
            if found:
                return found["id"]
        title, artist = _field(want.get("title")), _field(want.get("artist"))
        if not title:
            return None
        q = f'track:"{title}"' + (f' artist:"{artist}"' if artist else "")
        found = pick(want, self._search(q))
        if found is None and artist:
            # The field filters are strict about punctuation ("Beyoncé" vs
            # "Beyonce", "&" vs "and"); a plain query is the second chance.
            found = pick(want, self._search(f"{artist} {title}"))
        return found["id"] if found else None

    def create_playlist(self, name: str, description: str, ids: list, public=False) -> str:
        body = self.call(
            "POST",
            "/me/playlists",
            json={"name": name[:100], "description": description[:300], "public": bool(public)},
        )
        pid = body.get("id")
        if not pid:
            raise ServiceError("Spotify n'a pas créé la playlist.")
        for i in range(0, len(ids), ADD_BATCH):
            self.call("POST", f"/playlists/{pid}/items", json={"uris": ids[i : i + ADD_BATCH]})
        return ((body.get("external_urls") or {}).get("spotify")) or (
            f"https://open.spotify.com/playlist/{pid}"
        )

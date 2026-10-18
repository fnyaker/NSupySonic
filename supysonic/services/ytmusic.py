# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""YouTube Music: ytmusicapi, signed in with the user's own browser session.

The official route (the YouTube Data API) costs 100 quota units a search and 50
an inserted item against 10 000 a day: about sixty songs a day per Google
project. ytmusicapi talks to YouTube Music's own API instead, which is what the
fallback search already uses, and it signs in with the request headers of a
logged-in music.youtube.com tab (its "browser" auth; its OAuth mode needs the
operator to register a Google Cloud client and has broken repeatedly). The
headers are a session credential: they are kept encrypted, per user, like the
ARL — and they last as long as that browser session does (logging out of it
ends them).

Searching goes through ``deezer/youtube.search``: anonymous, cached a day, and
under the same holds after a refusal — so an export never asks YouTube about a
song the fallback search asked about today, and never insists when YouTube
said no.
"""

from __future__ import annotations

import json
import logging

from . import ServiceAuthError, ServiceError
from .match import pick, query_text

logger = logging.getLogger(__name__)

ADD_BATCH = 100
MAX_HEADERS = 64 * 1024  # a pasted header block is a few KB


def installed() -> bool:
    try:
        import ytmusicapi  # noqa: F401
    except ImportError:
        return False
    return True


def parse_headers(raw: str) -> str:
    """Pasted request headers -> the JSON ytmusicapi signs in with.

    Raises ServiceError in words: a pasted block without the cookie is the one
    mistake everybody makes once (copying a request that is not to /browse, or
    from a tab that is not signed in).
    """
    raw = str(raw or "").replace("\r\n", "\n").strip()
    if not raw:
        raise ServiceError("Collez les en-têtes de la requête.")
    if len(raw) > MAX_HEADERS:
        raise ServiceError("Ces en-têtes sont bien trop longs.")
    if not installed():
        raise ServiceError("ytmusicapi n'est pas installé sur ce serveur.")
    from ytmusicapi import setup

    try:
        return setup(filepath=None, headers_raw=raw)
    except Exception as exc:
        raise ServiceError(
            "En-têtes incomplets : il faut ceux d'une requête « browse » de "
            "music.youtube.com, connecté (cookie et x-goog-authuser)."
        ) from exc


def _is_auth_failure(exc: Exception) -> bool:
    text = str(exc).lower()
    return "401" in text or "403" in text or "sign in" in text or "logged in" in text


class Client:
    """One user's YouTube Music account."""

    name = "YouTube Music"

    def __init__(self, headers_json: str, ytm=None):
        self.headers_json = headers_json
        self._ytm = ytm

    @property
    def ytm(self):
        if self._ytm is None:
            from deezerpy import _Session
            from ytmusicapi import YTMusic

            try:
                auth = json.loads(self.headers_json)
            except ValueError as exc:
                raise ServiceAuthError("Session YouTube illisible : reconnectez le compte.") from exc
            self._ytm = YTMusic(auth=auth, requests_session=_Session())
        return self._ytm

    def account(self) -> str:
        try:
            info = self.ytm.get_account_info() or {}
        except Exception as exc:
            if _is_auth_failure(exc):
                raise ServiceAuthError(
                    "YouTube Music refuse cette session : reconnectez le compte."
                ) from exc
            raise ServiceError(f"YouTube Music injoignable : {exc}") from exc
        return str(info.get("accountName") or info.get("channelHandle") or "YouTube Music")[:128]

    def find(self, want: dict) -> str | None:
        if want.get("youtube_id"):
            return want["youtube_id"]  # it came from there
        from ..deezer import youtube

        q = query_text(want)
        if not q:
            return None
        try:
            hits = youtube.search(q)
        except youtube.YoutubeError as exc:
            raise ServiceError(f"Recherche YouTube impossible : {exc}") from exc
        cands = [{**h, "id": h["video_id"]} for h in hits]
        found = pick(want, cands)
        return found["id"] if found else None

    def create_playlist(self, name: str, description: str, ids: list, public=False) -> str:
        privacy = "PUBLIC" if public else "PRIVATE"
        try:
            pid = self.ytm.create_playlist(
                name[:150], description[:300], privacy_status=privacy,
                video_ids=ids[:ADD_BATCH],
            )
            if not isinstance(pid, str):
                raise ServiceError("YouTube Music n'a pas créé la playlist.")
            for i in range(ADD_BATCH, len(ids), ADD_BATCH):
                self.ytm.add_playlist_items(pid, ids[i : i + ADD_BATCH], duplicates=True)
        except ServiceError:
            raise
        except Exception as exc:
            if _is_auth_failure(exc):
                raise ServiceAuthError(
                    "YouTube Music refuse cette session : reconnectez le compte."
                ) from exc
            raise ServiceError(f"YouTube Music a refusé : {exc}") from exc
        return f"https://music.youtube.com/playlist?list={pid}"

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Deezer: the server's own linked account, as an explicit, one-shot export.

Not the old mirror (a playlist edited here was re-pushed on every change):
this writes ONE new playlist on the account behind the ARL, when the admin asks
for it, and never touches it again. It is the admin's only — that account is
theirs, every other user would be writing into somebody else's library.

A track that came from Deezer is already known by its id; any other (an
upload, a YouTube stand-in) is looked up by ISRC, then by an ``artist:"…"
track:"…"`` search judged like every other service's.
"""

from __future__ import annotations

import logging

from . import ServiceError
from .match import pick

logger = logging.getLogger(__name__)

ADD_BATCH = 500
SEARCH_LIMIT = 10


def _transport(exc) -> bool:
    try:
        from deezerpy.errors import is_transport_failure

        return is_transport_failure(exc)
    except Exception:  # pragma: no cover
        return True


def _candidate(item: dict) -> dict | None:
    if not isinstance(item, dict) or not item.get("id"):
        return None
    artist = item.get("artist") if isinstance(item.get("artist"), dict) else {}
    return {
        "id": str(item["id"]),
        "title": str(item.get("title") or ""),
        "artists": [{"name": str(artist.get("name") or "")}],
        "duration": int(item.get("duration") or 0),
    }


def _field(text) -> str:
    return " ".join(str(text or "").replace('"', " ").split())[:100]


class Client:
    """The account the server's ARL belongs to."""

    name = "Deezer"

    def __init__(self, provider):
        self.provider = provider

    def _api(self):
        try:
            return self.provider.dz.api
        except Exception as exc:
            raise ServiceError("Deezer est injoignable.") from exc

    def account(self) -> str:
        try:
            user = self.provider.dz.current_user or {}
        except Exception as exc:
            raise ServiceError("Deezer est injoignable.") from exc
        return str(user.get("name") or "Deezer")[:128]

    def _ask(self, fn, *args, **kw):
        try:
            return fn(*args, **kw)
        except Exception as exc:
            if _transport(exc):
                raise ServiceError("Deezer est injoignable.") from exc
            return None  # Deezer answered: not there

    def find(self, want: dict) -> str | None:
        if want.get("deezer_id"):
            return want["deezer_id"]
        api = self._api()
        if want.get("isrc"):
            item = self._ask(api.get_track_by_ISRC, want["isrc"])
            c = _candidate(item) if isinstance(item, dict) else None
            if c and (pick(want, [c]) or not want.get("title")):
                return c["id"]
        title, artist = _field(want.get("title")), _field(want.get("artist"))
        if not title:
            return None
        q = f'artist:"{artist}" track:"{title}"' if artist else title
        body = self._ask(api.search_track, q, limit=SEARCH_LIMIT) or {}
        cands = [c for c in (_candidate(i) for i in body.get("data") or []) if c]
        found = pick(want, cands)
        return found["id"] if found else None

    def create_playlist(self, name: str, description: str, ids: list, public=False) -> str:
        from deezerpy.gw import PlaylistStatus

        gw = self.provider.dz.gw
        status = PlaylistStatus.PUBLIC if public else PlaylistStatus.PRIVATE
        try:
            pid = gw.create_playlist(
                name[:100], status=status, description=description[:300],
                songs=ids[:ADD_BATCH],
            )
            for i in range(ADD_BATCH, len(ids), ADD_BATCH):
                gw.add_songs_to_playlist(pid, ids[i : i + ADD_BATCH])
        except Exception as exc:
            if _transport(exc):
                raise ServiceError("Deezer est injoignable.") from exc
            raise ServiceError(f"Deezer a refusé : {exc}") from exc
        return f"https://www.deezer.com/playlist/{pid}"

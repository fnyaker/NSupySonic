# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What we are looking for, and whether a service's answer is it.

``wanted`` turns one of our Track rows into a plain dict — title, main artist,
album, length, ISRC and the ids it already has on other services — read from
what the server holds (the row, the sidecar, the file's own tags), never from a
service. ``pick`` judges a service's search results against it with
``availability.match_score``: the same title once "(Remastered)" and friends are
set aside, the same main artist, no remix/live/edit word the track did not
have, a length within 15 s. A result that fails is not found — exporting a
cover in place of the song is worse than listing the song as missing.
"""

from __future__ import annotations

import logging
import re
from types import SimpleNamespace

logger = logging.getLogger(__name__)

_ISRC_RE = re.compile(r"\A[A-Z]{2}[A-Z0-9]{3}\d{7}\Z")
_DEEZER_ID_RE = re.compile(r"\A\d{1,20}\Z")


def clean_isrc(value) -> str | None:
    """An ISRC in its canonical form (CC-XXX-YY-NNNNN without dashes), or None."""
    s = re.sub(r"[\s-]", "", str(value or "")).upper()
    return s if _ISRC_RE.fullmatch(s) else None


def _isrc_of(track) -> str | None:
    """The recording's ISRC from what is on disk: the sidecar, then the tags."""
    try:
        from ..deezer.library import read_track_metadata

        meta = read_track_metadata(track) or {}
        isrc = clean_isrc(meta.get("ISRC") or meta.get("isrc"))
        if isrc:
            return isrc
    except Exception:  # pragma: no cover - a sidecar is a bonus
        pass
    path = getattr(track, "path", None)
    if not path:
        return None
    try:
        import mutagen

        audio = mutagen.File(path, easy=True)
        if audio is not None:
            for value in audio.get("isrc") or []:
                isrc = clean_isrc(value)
                if isrc:
                    return isrc
    except Exception:
        return None
    return None


def wanted(track) -> dict:
    """One Track row as the export reads it (no service is asked).

    Also takes a track as the web API shapes it (a dict): what a Deezer page
    that is not in the library lists — a recommendation, an editorial playlist.
    """
    if isinstance(track, dict):
        dz = str(track.get("deezer_id") or "")
        return {
            "id": dz,
            "title": str(track.get("title") or ""),
            "artist": str((track.get("artist") or {}).get("name") or ""),
            "album": str((track.get("album") or {}).get("title") or ""),
            "duration": int(track.get("duration") or 0),
            "isrc": clean_isrc(track.get("isrc")),
            "deezer_id": dz if _DEEZER_ID_RE.fullmatch(dz) else None,
            "youtube_id": None,
        }
    artist = track.artist.name if getattr(track, "artist", None) else ""
    album = track.album.name if getattr(track, "album", None) else ""
    dz = str(track.deezer_id or "")
    return {
        "id": str(track.id),
        "title": track.title or "",
        "artist": artist or "",
        "album": album or "",
        "duration": int(track.duration or 0),
        "isrc": _isrc_of(track),
        "deezer_id": dz if _DEEZER_ID_RE.fullmatch(dz) else None,
        "youtube_id": getattr(track, "youtube_id", None) or None,
    }


def _shim(want: dict):
    """``match_score`` reads a Track; the export holds a dict."""
    return SimpleNamespace(
        title=want.get("title") or "",
        artist=SimpleNamespace(name=want.get("artist") or ""),
        duration=want.get("duration") or 0,
    )


def pick(want: dict, candidates) -> dict | None:
    """The candidate that safely IS ``want``, best first; None when none is.

    A candidate is ``{"title", "artists": [{"name"}], "duration", ...}`` — the
    shape every service module normalises its answers to.
    """
    from ..webui.availability import match_score

    target = _shim(want)
    best, best_score = None, None
    for c in candidates or ():
        try:
            score = match_score(target, c)
        except Exception:  # pragma: no cover - a malformed answer is not a match
            logger.debug("match: unreadable candidate %r", c, exc_info=True)
            continue
        if score is not None and (best_score is None or score > best_score):
            best, best_score = c, score
    return best


def query_text(want: dict) -> str:
    """A free-text query for services without field filters: "artist title"."""
    return " ".join(f"{want.get('artist') or ''} {want.get('title') or ''}".split())[:200]

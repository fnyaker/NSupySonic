# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""MusicBrainz by title and artist, accepted only when it is certainly the same
recording: the length within 3 s, the core title and the main artist equal once
case, accents and brackets are set aside. A wrong song is worse than a hole."""

from . import musicbrainz as mb

DURATION_SLACK = 3.0


def _escape(text):
    return str(text).replace("\\", "\\\\").replace('"', '\\"')[:200]


def find(http, title, artist, duration):
    """``{"mbid", "date", "release"}`` or None."""
    from ..webui.availability import _core_title, _fold

    core = _fold(_core_title(title))
    who = _fold(artist)
    if not core or not who or not duration:
        return None
    data = http.get_json(
        f"{mb.BASE}/recording",
        {
            "query": f'recording:"{_escape(_core_title(title))}" AND artist:"{_escape(artist)}"',
            "fmt": "json",
            "limit": 5,
        },
    )
    best = None
    for rec in (data or {}).get("recordings") or []:
        if not isinstance(rec, dict) or not mb.valid_mbid(rec.get("id")):
            continue
        length = rec.get("length")
        if not isinstance(length, (int, float)):
            continue
        delta = abs(length / 1000.0 - duration)
        if delta > DURATION_SLACK:
            continue
        if _fold(_core_title(rec.get("title"))) != core:
            continue
        credit = rec.get("artist-credit") or []
        first = (credit[0].get("artist") or {}).get("name") if credit and isinstance(credit[0], dict) else None
        if _fold(first) != who:
            continue
        if best is None or delta < best[0]:
            best = (delta, rec)
    return mb.summarize(best[1]) if best else None

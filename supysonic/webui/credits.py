# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The full credits of a track: who wrote it, who composed it, who produced it.

The listing calls of the library only carry the performers (main and featured).
Everybody else lives in the gateway's ``SNG_CONTRIBUTORS`` (a role -> names map)
of ``song.getData``, next to the ISRC, the release date, the label and the
copyright. Where the answer comes from, best first:

1. the ``<track>.json`` sidecar of an archived track, which is the app's own
   copy of it and needs no Deezer at all;
2. Deezer, asked once and kept a day — and, when the track is archived, written
   into the sidecar, so it is the last time anyone asks: an archived track
   carries its whole identity on disk;
3. the database, which knows the performers and nothing else — so the panel
   still says who is on the record while Deezer is out.

A failure to reach Deezer is never an answer about the track: the credits it
could not read are simply missing from the reply.
"""

from __future__ import annotations

import logging
import threading
import time

from flask import jsonify

from ..deezer import library
from . import (
    _dz_live,
    _may_access_track,
    _valid_id,
    login_required,
    webapi,
)
from .availability import _resolve_local

logger = logging.getLogger(__name__)

# The roles Deezer names, in the order a sleeve lists them. Anything else it
# invents is shown under its own name, after these.
ROLES = (
    ("main_artist", "Artiste principal"),
    ("featuring", "Featuring"),
    ("performer", "Interprète"),
    ("vocals", "Chant"),
    ("author", "Auteur"),
    ("lyricist", "Parolier"),
    ("composer", "Compositeur"),
    ("arranger", "Arrangeur"),
    ("producer", "Producteur"),
    ("co_producer", "Coproducteur"),
    ("executive_producer", "Producteur exécutif"),
    ("engineer", "Ingénieur"),
    ("recording_engineer", "Ingénieur du son"),
    ("mixer", "Mixage"),
    ("mastering", "Mastering"),
    ("mastering_engineer", "Mastering"),
    ("remixer", "Remix"),
    ("conductor", "Chef d'orchestre"),
    ("publisher", "Éditeur"),
    ("label", "Label"),
)
_LABELS = dict(ROLES)
_ORDER = {key: i for i, (key, _) in enumerate(ROLES)}

MAX_PEOPLE = 40
MAX_TEXT = 160

_TTL = 24 * 3600
_MAX_CACHED = 500
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _text(v) -> str:
    return str(v).strip()[:MAX_TEXT] if isinstance(v, (str, int, float)) else ""


def _humanize(key: str) -> str:
    return _text(key).replace("_", " ").replace("-", " ").strip().capitalize() or "Autre"


def _names(v) -> list[str]:
    """Names out of whatever Deezer put under a role: a list, or one string."""
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, (list, tuple)):
        return []
    out, seen = [], set()
    for x in v:
        name = _text(x.get("ART_NAME") or x.get("name") if isinstance(x, dict) else x)
        if name and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
        if len(out) >= MAX_PEOPLE:
            break
    return out


def build(gw: dict | None, performers: list[dict]) -> dict:
    """The reply out of a gateway payload (or None) and the known performers.

    ``performers`` are ``{deezer_id, name, role}`` — what the database and the
    sidecar know — and are what lets a name link to its artist page.
    """
    gw = gw or {}
    ids = {p["name"].lower(): p["deezer_id"] for p in performers if p.get("deezer_id") and p.get("name")}
    groups: dict[str, list[str]] = {}

    contrib = gw.get("SNG_CONTRIBUTORS")
    if isinstance(contrib, dict):
        for key, value in contrib.items():
            key = _text(key).lower()
            names = _names(value)
            if key and names:
                groups.setdefault(key, [])
                groups[key] += [n for n in names if n not in groups[key]]

    # Deezer's performers, when it did not send them as contributors.
    main = [p["name"] for p in performers if p.get("role") == "Main"]
    feat = [p["name"] for p in performers if p.get("role") != "Main"]
    if main and "main_artist" not in groups:
        groups["main_artist"] = main
    if feat and "featuring" not in groups:
        groups["featuring"] = feat

    credits = []
    for key in sorted(groups, key=lambda k: (_ORDER.get(k, len(ROLES)), k)):
        credits.append(
            {
                "role": key,
                "label": _LABELS.get(key) or _humanize(key),
                "people": [
                    {"name": n, **({"deezer_id": ids[n.lower()]} if n.lower() in ids else {})}
                    for n in groups[key]
                ],
            }
        )

    date = _text(gw.get("PHYSICAL_RELEASE_DATE") or gw.get("DIGITAL_RELEASE_DATE"))
    info = {
        "isrc": _text(gw.get("ISRC")),
        "released": date if date and date != "0000-00-00" else "",
        "label": _text(gw.get("LABEL_NAME")),
        "copyright": _text(gw.get("COPYRIGHT")),
        "album": _text(gw.get("ALB_TITLE")),
    }
    return {"credits": credits, "info": {k: v for k, v in info.items() if v}}


def _performers(track, meta) -> list[dict]:
    """Who is on the record, from the sidecar or else the database."""
    if meta and isinstance(meta.get("credits"), list):
        out = [
            {"deezer_id": _text(c.get("deezer_id")), "name": _text(c.get("name")), "role": _text(c.get("role"))}
            for c in meta["credits"]
            if isinstance(c, dict)
        ]
        if out:
            return out
    if track is None:
        return []
    try:
        return [
            {"deezer_id": str(a.deezer_id or a.id), "name": a.name, "role": role}
            for a, role in track.credited_artists()
        ]
    except Exception:
        logger.debug("credits: no performers for %s", track.id, exc_info=True)
        return []


def _remembered(tid: str):
    with _lock:
        hit = _cache.get(tid)
        return hit[1] if hit and hit[0] > time.monotonic() else None


def _remember(tid: str, info: dict) -> None:
    with _lock:
        if len(_cache) >= _MAX_CACHED:
            _cache.clear()
        _cache[tid] = (time.monotonic() + _TTL, info)


def _live(tid: str) -> dict | None:
    """The gateway's own answer for a track, or None when it cannot be had."""
    info = _remembered(tid)
    if info is not None:
        return info
    provider = _dz_live()
    if provider is None:
        return None
    try:
        info = provider.get_track_info(tid)
    except Exception:
        # Deezer not answering says nothing about the track's credits.
        logger.debug("credits: Deezer did not answer for %s", tid, exc_info=True)
        return None
    if isinstance(info, dict) and info:
        _remember(tid, info)
        return info
    return None


@webapi.route("/track/<track_id>/credits")
@login_required
def track_credits(track_id):
    """Everyone credited on a track, and its release details."""
    numeric = _valid_id(track_id)
    track = _resolve_local(track_id)
    if track is not None and not _may_access_track(track):
        return jsonify({"error": "not found"}), 404
    if track is None and not numeric:
        return jsonify({"error": "not found"}), 404

    meta = library.read_track_metadata(track) if track is not None and track.path else None
    gw = (meta or {}).get("gw") if meta else None
    have = isinstance(gw, dict) and "SNG_CONTRIBUTORS" in gw

    # An upload has nothing but its tags: no Deezer to ask, nothing to add.
    if numeric and not have:
        live = _live(track_id)
        if live is not None:
            gw = {**(gw or {}), **live}
            # Archived: keep it, and it is never asked again.
            if track is not None and track.path and "SNG_CONTRIBUTORS" in live:
                try:
                    library.save_track_metadata(track, live)
                except Exception:
                    logger.debug("credits: could not update the sidecar of %s", track_id, exc_info=True)

    return jsonify(build(gw, _performers(track, meta)))

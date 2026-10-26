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
   copy of it and needs no Deezer at all — and ONLY that: a track on disk is
   never the reason for a call to Deezer, whatever its sidecar lacks;
2. the tags of an uploaded file (composer, lyricist, producer, label…), read
   from the file;
3. Deezer, asked once and kept a day, for a track that is not on disk;
4. the database, which knows the performers and nothing else — so the panel
   still says who is on the record while Deezer is out.

A failure to reach Deezer is never an answer about the track: the credits it
could not read are simply missing from the reply.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from flask import jsonify

from .. import trackcredits
from ..deezer import library
from . import (
    _dz_live,
    admin_required,
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

MAX_TEXT = trackcredits.MAX_TEXT
#: A name links to its own credits page once it is credited on this many
#: tracks of the library (one is the track on screen: nothing more to see).
PAGE_FROM = 2

_TTL = 24 * 3600
_MAX_CACHED = 500
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _text(v) -> str:
    return str(v).strip()[:MAX_TEXT] if isinstance(v, (str, int, float)) else ""


def _humanize(key: str) -> str:
    return _text(key).replace("_", " ").replace("-", " ").strip().capitalize() or "Autre"


def label_of(role: str) -> str:
    return _LABELS.get(role) or _humanize(role)


def role_order(role: str):
    return (_ORDER.get(role, len(ROLES)), role)


def build(gw: dict | None, performers: list[dict], contrib: dict | None = None,
          links: dict | None = None) -> dict:
    """The reply out of a gateway payload (or None) and the known performers.

    ``performers`` are ``{id, deezer_id, name, role}`` — what the database and the
    sidecar know — and are what lets a name link to its artist page.
    ``contrib`` is the role -> names map to show (``trackcredits.merge``);
    without it, the payload's own ``SNG_CONTRIBUTORS``. ``links`` adds, per
    folded name, what else a name opens (an artist page, a credits page).
    """
    gw = gw or {}
    known = {
        p["name"].casefold(): {k: p[k] for k in ("id", "deezer_id") if p.get(k)}
        for p in performers
        if p.get("name") and (p.get("deezer_id") or p.get("id"))
    }
    for key, extra in (links or {}).items():
        known[key] = {**extra, **known.get(key, {})}
    if contrib is None:
        contrib = trackcredits.clean(gw.get("SNG_CONTRIBUTORS"))
    groups: dict[str, list[str]] = {k: list(v) for k, v in contrib.items()}

    # Deezer's performers, when it did not send them as contributors.
    main = [p["name"] for p in performers if p.get("role") == "Main"]
    feat = [p["name"] for p in performers if p.get("role") != "Main"]
    if main and "main_artist" not in groups:
        groups["main_artist"] = main
    if feat and "featuring" not in groups:
        groups["featuring"] = feat

    credits = []
    for key in sorted(groups, key=role_order):
        credits.append(
            {
                "role": key,
                "label": label_of(key),
                "people": [
                    {"name": n, **known.get(n.casefold(), {})}
                    for n in groups[key]
                ],
            }
        )

    date = library.release_date_of(gw) or _text(
        gw.get("PHYSICAL_RELEASE_DATE") or gw.get("DIGITAL_RELEASE_DATE")
    )
    info = {
        "isrc": _text(gw.get("ISRC")),
        "released": date if date and date != "0000-00-00" else "",
        "label": _text(gw.get("LABEL_NAME")),
        "copyright": _text(gw.get("COPYRIGHT")),
        "album": _text(gw.get("ALB_TITLE")),
    }
    return {"credits": credits, "info": {k: v for k, v in info.items() if v}}


#: The people the tags of an uploaded file can name, and the role each is under.
_FILE_ROLES = (("composer", "composer"), ("lyricist", "lyricist"), ("producer", "producer"))


def from_file_tags(path: str) -> dict:
    """A gateway-shaped payload built from the tags of a file on disk.

    An upload has no Deezer to ask: the composer, lyricist, producer and label
    its owner wrote into the file are the whole story, and the credits panel
    reads the same shape as for a Deezer track.
    """
    from ..filetags import read_file_facts

    facts = read_file_facts(path)
    contributors = {
        role: trackcredits.split_names(facts[key]) for key, role in _FILE_ROLES if facts.get(key)
    }
    gw = {}
    if contributors:
        gw["SNG_CONTRIBUTORS"] = contributors
    if facts.get("isrc"):
        gw["ISRC"] = facts["isrc"]
    if facts.get("date"):
        gw["PHYSICAL_RELEASE_DATE"] = facts["date"]
    if facts.get("label"):
        gw["LABEL_NAME"] = facts["label"]
    return gw


def _archived(track) -> bool:
    return bool(track is not None and track.path and os.path.isfile(track.path))


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
            {"id": str(a.id), "deezer_id": str(a.deezer_id or a.id), "name": a.name, "role": role}
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


def _statements(track, gw: dict, meta: dict | None, tags_gw: dict | None) -> dict:
    """``{source: {role: [names]}}``: the database's, completed by what the
    files of the track say. What only the files said is stored on the way, so
    the next visit — and the person's credits page — reads the database."""
    by_source = trackcredits.stored(track.id) if track is not None else {}
    local = {}
    if tags_gw and "SNG_CONTRIBUTORS" in tags_gw:
        local["tags"] = trackcredits.clean(tags_gw["SNG_CONTRIBUTORS"])
    if "SNG_CONTRIBUTORS" in gw:
        local["deezer"] = trackcredits.clean(gw["SNG_CONTRIBUTORS"])
    mb = trackcredits.from_facts((meta or {}).get("facts") or {})
    if mb:
        local["musicbrainz"] = mb
    for source, roles in local.items():
        if source in by_source or not roles:
            continue
        by_source[source] = roles
        if track is not None:
            _keep(track, roles, source)
    return by_source


def _keep(track, roles, source):
    try:
        trackcredits.store(track.id, roles, source)
    except Exception:  # the panel answers anyway; the backfill will store it
        logger.debug("credits: could not store %s for %s", source, track.id, exc_info=True)


def _links(contrib: dict) -> dict:
    """What each credited name opens, by folded name: the artist page of an
    artist the library holds under that name, and the person's own credits
    page once they are credited on more than this track. Two statements."""
    from peewee import fn

    from ..db import Artist, TrackCredit
    from . import _raw, _uuid_text

    names = {n.casefold(): n for names in contrib.values() for n in names}
    keys = list(names)[:200]
    if not keys:
        return {}
    out: dict[str, dict] = {}
    for rid, did, name in (
        Artist.select(_raw(Artist.id), Artist.deezer_id, Artist.name)
        # An upload's artist is only a page for whoever may read its tracks:
        # the panel links the catalogue's artists only.
        .where((fn.LOWER(Artist.name) << keys) & Artist.deezer_id.is_null(False))
        .tuples()
    ):
        key = name.casefold()
        if key in names and key not in out:
            out[key] = {"id": _uuid_text(rid), "deezer_id": str(did)}
    counts = (
        trackcredits.credited_query_many(keys)
        .select(TrackCredit.name_key, fn.COUNT(TrackCredit.track.distinct()))
        .group_by(TrackCredit.name_key)
        .tuples()
    )
    for key, n in counts:
        if n >= PAGE_FROM:
            out.setdefault(key, {})["credited"] = n
    return out


@webapi.route("/track/<track_id>/credits")
@login_required
def track_credits(track_id):
    """Everyone credited on a track, and its release details."""
    from .refs import canonical

    track_id = canonical(track_id)
    numeric = _valid_id(track_id)
    track = _resolve_local(track_id)
    if track is not None and not _may_access_track(track):
        return jsonify({"error": "not found"}), 404
    if track is None and not numeric:
        return jsonify({"error": "not found"}), 404

    meta = library.read_track_metadata(track) if track is not None and track.path else None
    gw = dict((meta or {}).get("gw") or {}) if meta else {}
    have = "SNG_CONTRIBUTORS" in gw
    tags_gw = None

    if track is not None and track.deezer_id is None and _archived(track):
        # An upload (or a YouTube archive) has nothing but its tags: no Deezer
        # to ask, and what the file says is read from the file.
        if track.youtube_id is None:
            tags_gw = from_file_tags(track.path)
            gw = {**{k: v for k, v in tags_gw.items() if k != "SNG_CONTRIBUTORS"}, **gw}
    elif numeric and not have and not _archived(track):
        # Only a track that is not on disk is worth a question to Deezer. An
        # archive answers from its sidecar and the database alone, whatever
        # they hold (the background backfill completes them): asking Deezer
        # about a file we own is a network call for nothing.
        live = _live(track_id)
        if live is not None:
            gw = {**gw, **live}

    by_source = _statements(track, gw, meta, tags_gw)
    contrib = trackcredits.merge(by_source)
    performers = _performers(track, meta)
    try:
        links = _links(contrib)
    except Exception:  # a link is a nicety: the names are the answer
        logger.debug("credits: no links for %s", track_id, exc_info=True)
        links = {}
    return jsonify(build(gw, performers, contrib, links))


@webapi.route("/credits/person")
@login_required
def person_credits():
    """Every track of the library a person is credited on (not as its
    performer): what they wrote, composed, produced. ``?name=`` is the name as
    a credit lists it; an artist page asks by its own name."""
    from flask import request

    from ..db import Album, Artist, Track, TrackCredit
    from . import _db_tracks, _visible_tracks

    name = _text(request.args.get("name"))
    key = trackcredits.name_key(name)
    if not key:
        return jsonify({"error": "not found"}), 404
    roles_by_track: dict = {}
    shown: dict = {}
    for tid, role, display in (
        trackcredits.credited_query_many([key])
        .select(TrackCredit.track, TrackCredit.role, TrackCredit.name)
        .order_by(TrackCredit.track, TrackCredit.position)
        .limit(trackcredits.PERSON_MAX * 4)
        .tuples()
    ):
        have = roles_by_track.setdefault(tid, [])
        if role not in have:
            have.append(role)
        shown.setdefault(display, 0)
        shown[display] += 1
    ids = list(roles_by_track)[: trackcredits.PERSON_MAX]
    rows = (
        _visible_tracks(
            Track.select(Track, Album, Artist)
            .join(Album)
            .switch(Track)
            .join(Artist)
            .where(Track.id << ids)
        ).order_by(Track.year.desc(), Album.name, Track.disc, Track.number)
        if ids else []
    )
    tracks = _db_tracks(rows) if ids else []
    by_role: dict[str, int] = {}
    for t in tracks:
        try:
            from uuid import UUID

            tid = UUID(str(t.get("id")))
        except (TypeError, ValueError):
            continue
        t["credit_roles"] = sorted(roles_by_track.get(tid, []), key=role_order)
        for r in t["credit_roles"]:
            by_role[r] = by_role.get(r, 0) + 1
    display = max(shown, key=shown.get) if shown else name
    return jsonify(
        {
            "name": display,
            "roles": [
                {"role": r, "label": label_of(r), "count": n}
                for r, n in sorted(by_role.items(), key=lambda kv: role_order(kv[0]))
            ],
            "labels": {r: label_of(r) for r in by_role},
            "tracks": tracks,
        }
    )


@webapi.route("/credits/backfill", methods=["GET", "POST"])
@login_required
@admin_required
def credits_backfill():
    """The credits of the library filled from the disk, then from Deezer: its
    progress, and POST starts it (it also starts on its own after an upgrade)."""
    from flask import current_app, request

    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        force = str(data.get("force") or request.args.get("force") or "").lower() in ("1", "true", "yes", "on")
        trackcredits.start(current_app._get_current_object(), force=force)
    return jsonify(trackcredits.status())

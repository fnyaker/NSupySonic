# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Genre radios: pick a style, set how far to wander, get a queue.

Built from the library's own verdicts (``deezer/radio.py``), so it works offline
and for every user — a guest's radio is shaped by THEIR stars and is made only
of tracks already in the library. Nothing here calls Deezer.
"""

from __future__ import annotations

import logging
import random

from flask import jsonify, request

from ..db import Track, TrackAnalysis
from ..deezer import genregraph, radio
from . import _db_tracks, login_required, webapi

logger = logging.getLogger(__name__)

SEEDS_MAX = 8
COUNT_MAX = 100


def _num(value, default, lo, hi):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN
        return default
    return min(hi, max(lo, v))


def _seeds(raw):
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, (list, tuple)):
        return []
    out = []
    for item in raw[: SEEDS_MAX * 2]:
        lab = genregraph.label(item) if isinstance(item, str) else None
        if lab and lab not in out:
            out.append(lab)
    return out[:SEEDS_MAX]


def _library_counts():
    """``{label: tracks}`` from the analysis verdicts, branch totals included."""
    from peewee import fn

    own = {}
    q = (
        TrackAnalysis.select(TrackAnalysis.style, fn.COUNT(TrackAnalysis.track))
        .where(TrackAnalysis.style.is_null(False) & (TrackAnalysis.style_confidence >= 0.3))
        .group_by(TrackAnalysis.style)
        .tuples()
    )
    for style, n in q:
        lab = radio.style_label(style)
        if lab:
            own[lab] = own.get(lab, 0) + n
    total = dict(own)
    for lab, n in own.items():
        for anc in genregraph.lineage(lab)[1:]:
            total[anc] = total.get(anc, 0) + n
    return own, total


@webapi.route("/radio/genres")
@login_required
def radio_genres():
    """The tree a radio is picked from: every genre with how many tracks of the
    library carry it (`tracks` its own, `branch` with its sub-genres)."""
    own, branch = _library_counts()
    g = genregraph.graph()
    rows = []
    for k, label in g["names"].items():
        rows.append(
            {
                "name": label,
                "parent": genregraph.parent_of(label),
                "tracks": own.get(label, 0),
                "branch": branch.get(label, 0),
            }
        )
    return jsonify({"genres": rows})


@webapi.route("/radio/genre", methods=["GET", "POST"])
@login_required
def radio_genre():
    """A queue for a style.

    ``seeds``: genre names (any level of the tree; a branch means all of it).
    ``discovery`` 0..1: how far to wander from the style and how much to prefer
    what was not heard yet. ``randomness`` 0..1. ``count`` up to 100.
    ``bpm_min``/``bpm_max`` optionally narrow the tempo. ``seed`` makes a queue
    repeatable (tests, "play it again")."""
    data = request.get_json(silent=True) if request.method == "POST" else None
    data = data if isinstance(data, dict) else request.args
    get = data.get
    seeds = _seeds(data.get("seeds") if hasattr(data, "get") else None)
    if not seeds:
        return jsonify({"error": "choisissez au moins un style connu", "tracks": []}), 400
    discovery = _num(get("discovery"), 0.3, 0.0, 1.0)
    randomness = _num(get("randomness"), 0.5, 0.0, 1.0)
    count = int(_num(get("count"), 50, 1, COUNT_MAX))
    lo, hi = get("bpm_min"), get("bpm_max")
    window = None
    if lo is not None and hi is not None:
        window = (_num(lo, 0, 0, 400), _num(hi, 400, 0, 400))
        if window[0] > window[1]:
            window = (window[1], window[0])
    seed = get("seed")
    rng = random.Random(str(seed)) if seed is not None else None
    cands = radio.build(
        request.webuser, seeds, discovery=discovery, count=count,
        randomness=randomness, bpm_window=window, rng=rng,
    )
    ids = [c.id for c in cands]
    rows = {t.id: t for t in Track.select().where(Track.id.in_(ids))} if ids else {}
    ordered = [rows[i] for i in ids if i in rows]
    tracks = _db_tracks(ordered)
    # The explorer's finds (verified, NOT archived) take a share of the queue
    # that rises with the discovery dial. Playing one archives it, as any play does.
    found = 0
    if discovery > 0:
        try:
            from ..deezer import explorer, genregraph

            pool = explorer.pool_candidates(genregraph.expand(seeds, spread=discovery))
            want = int(round(count * discovery * radio.DISCOVERY_SHARE))
            extra = radio.pick_discoveries(pool, min(want, len(pool)), window=window, rng=rng)
            if extra:
                tracks = radio.mix_discoveries(tracks, extra, rng)
                found = len(extra)
        except Exception:
            logger.debug("Explorer pool unavailable for the radio", exc_info=True)
    return jsonify(
        {
            "seeds": seeds,
            "discovery": discovery,
            "tracks": tracks,
            "discovered": found,
            "why": [dict(c.why, genre_name=c.genre) for c in cands if c.id in rows],
        }
    )


# -- the explorer ----------------------------------------------------------------
from . import admin_required  # noqa: E402


@webapi.route("/radio/explorer", methods=["GET", "PUT"])
@login_required
@admin_required
def radio_explorer():
    """The background explorer's state and its two switches: on/off, and whether
    what it finds is archived at once (default no — found music is archived only
    when it is played or liked)."""
    from ..deezer import explorer

    if request.method == "PUT":
        explorer.save_settings(request.get_json(silent=True))
    return jsonify(explorer.status())


# -- recommendations built from the library -----------------------------------

FOR_YOU_TRACKS = 30


def _serialize(cands):
    ids = [c.id for c in cands]
    rows = {t.id: t for t in Track.select().where(Track.id.in_(ids))} if ids else {}
    return _db_tracks([rows[i] for i in ids if i in rows])


@webapi.route("/recommendations/library")
@login_required
def recommendations_library():
    """"Pour vous": mixes from the listener's own taste, different on every
    visit. Each is a genre they favour (one per family while possible) at a mild
    discovery level, plus one wide "Découvertes" mix on their favourite family.
    Genre, tempo and artist drive it; the dice keep two visits from repeating."""
    seed = request.args.get("seed")
    rng = random.Random(str(seed)) if seed is not None else random.Random()
    profile = radio.listener_profile(request.webuser)
    mixes = []
    for genre in radio.favourite_genres(profile, 3, rng):
        cands = radio.build(request.webuser, [genre], discovery=0.3, count=FOR_YOU_TRACKS,
                            randomness=0.7, rng=rng)
        if len(cands) >= 8:
            mixes.append({"id": "for-you-" + genregraph.key(genre), "title": genre,
                          "subtitle": "D'après vos écoutes", "genre": genre,
                          "tracks": _serialize(cands)})
    if profile:
        fam = genregraph.family_of(max(profile, key=profile.get))
        if fam:
            cands = radio.build(request.webuser, [fam], discovery=0.9, count=FOR_YOU_TRACKS,
                                randomness=0.8, rng=rng)
            if len(cands) >= 8:
                mixes.append({"id": "for-you-discovery", "title": "Découvertes",
                              "subtitle": f"Autour de {fam}", "genre": fam,
                              "tracks": _serialize(cands)})
    return jsonify({"mixes": mixes})


def blend_track_radio(user, seed_id, remote, count=40):
    """Deezer's mix for a track blended with the library's own similar tracks.

    Deezer's mix alone came out near-identical every time. The library part
    (same genre, ±8% tempo, other artists, damped by recent plays, sampled with
    noise) is mixed in at about 60%, and Deezer's tracks are dealt in at random
    places — so the radio differs from one start to the next, and is still a
    radio when Deezer cannot be reached (``remote`` empty)."""
    rng = random.Random()
    try:
        local = _serialize(radio.similar(user, seed_id, count=int(count * 0.6) + 2, rng=rng))
    except Exception:
        logger.debug("Library part of the track radio failed", exc_info=True)
        local = []
    if not local:
        return remote
    seen = {str(seed_id)} | {str(t.get("deezer_id")) for t in local}
    rest = [t for t in remote if str(t.get("deezer_id")) not in seen]
    rng.shuffle(rest)
    out = radio.mix_discoveries(local, rest[: max(0, count - len(local))], rng)
    return out[:count]

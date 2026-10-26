# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Recommendations, the Flow's discovery level and the "Nouveautés" shelf.

Every route here READS: the taste profile and the candidates come from the
database (``supysonic/discover.py``), the releases and the close artists from
what ``supysonic/releases.py``'s background job stored. Nothing asks a provider
on a click, so these screens answer at the speed of the disk whether Deezer is
up or not.
"""

import datetime
import random
import secrets
import threading
import time

from flask import current_app, jsonify, request

from .. import discover, dislikes, releases
from ..db import (
    Album, Artist, ArtistMute, ArtistRelease, Track, UserTaste, now,
)
from . import (
    _image, _tracks_in_order, admin_required, login_required, webapi,
)

#: Titles in a Flow answer, in each recommendation row.
FLOW_SIZE = 40
ROW = 12
#: A recommendation answer is kept this long per (person, level, seed).
RECO_TTL = 300
RELEASES_MAX = 120

_reco = {}
_reco_lock = threading.Lock()


def _level_arg():
    raw = request.args.get("d")
    if raw in (None, ""):
        return discover.level_of(request.webuser)
    return discover.clamp(raw)


def _seed_arg():
    seed = (request.args.get("seed") or "")[:32]
    return "".join(ch for ch in seed if ch.isalnum()) or None


def _catalog_track(c):
    """A provider's title the library does not hold, shaped like a public-API
    track (the player streams it by its Deezer id, as a search result)."""
    info = c.info or {}
    return {
        "deezer_id": str(c.ref),
        "title": info.get("title") or "",
        "duration": int(info.get("duration") or 0),
        "explicit": False,
        "gain": None,
        "artist": {"deezer_id": str(c.artist_ref or ""), "name": info.get("artist") or ""},
        "artists": [{"deezer_id": str(c.artist_ref or ""), "name": info.get("artist") or "", "role": "Main"}],
        "display_artist": info.get("artist") or "",
        "album": {
            "deezer_id": str(info.get("album_ref") or ""),
            "title": info.get("album") or "",
            "cover": info.get("cover"),
        },
        "why": c.why,
    }


def _serialise_tracks(cands):
    local = [c.track for c in cands if c.track is not None]
    by_id = {}
    if local:
        # A row's API key is its Deezer id, else its UUID (as _tracks_in_order).
        key = {
            tid: str(dz) if dz is not None else str(tid)
            for tid, dz in Track.select(Track.id, Track.deezer_id).where(Track.id.in_(local)).tuples()
        }
        shown = {r["deezer_id"]: r for r in _tracks_in_order(local)}
        by_id = {tid: shown.get(key.get(tid)) for tid in local}
    out = []
    for c in cands:
        if c.track is not None:
            row = by_id.get(c.track)
            if row is not None:
                out.append(dict(row, why=c.why))
        elif c.provider == "deezer":
            out.append(_catalog_track(c))
    return out


# -- the level ----------------------------------------------------------------------


@webapi.route("/discover/prefs")
@login_required
def discover_prefs():
    level = discover.level_of(request.webuser)
    return jsonify({
        "level": level,
        "step": discover.step_name(level),
        "steps": [{"name": n, "from": f} for n, f in discover.STEPS],
    })


@webapi.route("/discover/prefs", methods=["PUT"])
@login_required
def discover_prefs_set():
    data = request.get_json(silent=True) or {}
    try:
        level = discover.set_level(request.webuser, data.get("level"))
    except ValueError:
        return jsonify({"error": "invalid level"}), 400
    return jsonify({"level": level, "step": discover.step_name(level)})


# -- the Flow and the recommendations -------------------------------------------------


@webapi.route("/flow", methods=["GET", "POST"])
@login_required
def flow():
    """The endless radio, at the person's discovery level: a share of what they
    love, the rest at the distance the slider asks for. A refill POSTs what the
    queue holds (``exclude``) and what this session skipped (``skipped``), so
    nothing comes back twice and the session's skips steer the rest."""
    data = (request.get_json(silent=True) or {}) if request.method == "POST" else {}
    try:
        if request.method == "POST" and data.get("d") not in (None, ""):
            level = discover.clamp(data.get("d"))
        else:
            level = _level_arg()
    except ValueError:
        return jsonify({"error": "invalid level"}), 400
    seed = _seed_arg() or secrets.token_hex(4)
    exclude, skipped = (), ()
    if data:
        from . import _ref_list

        exclude = set(_ref_list(data, "exclude", 400))
        skipped = _ref_list(data, "skipped", 30)
        # A catalogue title in the queue is excluded by its provider key.
        raw = data.get("exclude") if isinstance(data.get("exclude"), list) else []
        exclude |= {f"deezer:{x}" for x in raw[-400:] if isinstance(x, str) and x.isdigit()}
    picked = discover.flow(request.webuser, level, FLOW_SIZE, seed=seed,
                           exclude=exclude, skipped=skipped)
    return jsonify({"tracks": _serialise_tracks(picked)})


def _album_cards(entries):
    local = [key[1] for _s, key, _why, _d in entries if key[0] == "local"]
    albums = {}
    if local:
        for a in Album.select(Album, Artist).join(Artist).where(Album.id.in_(local)):
            albums[a.id] = a
    remote = [key[1] for _s, key, _why, _d in entries if key[0] == "deezer"]
    rels = {}
    if remote:
        for r in ArtistRelease.select().where(
            (ArtistRelease.provider == "deezer") & ArtistRelease.ref.in_(remote)
        ):
            rels[r.ref] = r
    out, seen = [], set()
    for _s, key, why, _d in entries:
        if key in seen:
            continue
        seen.add(key)
        if key[0] == "local":
            a = albums.get(key[1])
            if a is None:
                continue
            if a.deezer_id and ("deezer", str(a.deezer_id)) in seen:
                continue
            seen.add(("deezer", str(a.deezer_id or "")))
            out.append({
                "id": str(a.id),
                "deezer_id": str(a.deezer_id or ""),
                "title": a.name,
                "cover": _image("cover", a.cover_md5),
                "artist": {"id": str(a.artist.id), "deezer_id": str(a.artist.deezer_id or ""),
                           "name": a.artist.name},
                "subtitle": why,
            })
        else:
            r = rels.get(key[1])
            if r is None:
                continue
            out.append(_release_card(r, subtitle=why))
        if len(out) >= ROW:
            break
    return out


def _release_card(r, subtitle=None, close_to=None, new=False):
    return {
        "deezer_id": r.ref,
        "title": r.title,
        "cover": r.cover,
        "artist": {"deezer_id": r.artist_ref, "name": r.artist_name},
        "year": (r.released or "")[:4] or None,
        "released": r.released,
        "kind": r.kind,
        "nb_tracks": r.nb_tracks,
        "subtitle": subtitle or r.artist_name,
        "close_to": close_to,
        "new": bool(new),
    }


def _artist_cards(ranked):
    out = []
    for (prov, ref), (_s, name, pic, why, _d, _n) in ranked:
        if prov == "deezer":
            out.append({"deezer_id": str(ref), "name": name, "picture": pic, "subtitle": why,
                        "provider": "deezer"})
        else:
            out.append({"id": str(ref), "deezer_id": "", "name": name, "picture": None,
                        "subtitle": why, "provider": "local"})
    return out


@webapi.route("/recommend")
@login_required
def recommend():
    """The home's "for you" rows: titles, albums and artists at the person's
    distance. Kept five minutes per (person, level, seed)."""
    try:
        level = _level_arg()
    except ValueError:
        return jsonify({"error": "invalid level"}), 400
    seed = _seed_arg() or now().date().isoformat()
    user = request.webuser
    key = (user.id, round(level, 2), seed)
    with _reco_lock:
        hit = _reco.get(key)
    if hit is not None and time.monotonic() - hit[0] < RECO_TTL:
        return jsonify(hit[1])
    taste = discover.profile(user)
    rng = random.Random(f"{user.id}:{seed}")  # nosec B311 - a seeded draw so a suggestion repeats, not a secret
    pool = discover.track_candidates(user, taste, rng)
    discover._dedupe_library(pool)
    tracks = discover.pick(pool, max(level, 0.08), 20, rng, known_share=0.0)
    rng_a = random.Random(f"{user.id}:{seed}:a")  # nosec B311 - a seeded draw so a suggestion repeats, not a secret
    rng_r = random.Random(f"{user.id}:{seed}:r")  # nosec B311 - a seeded draw so a suggestion repeats, not a secret
    albums = discover.album_candidates(user, taste, level, rng_a, pool=pool)
    artists = discover.artist_candidates(user, taste, level, rng_r, pool=pool)
    out = {
        "level": level,
        "step": discover.step_name(level),
        "tracks": _serialise_tracks(tracks),
        "albums": _album_cards(albums),
        "artists": _artist_cards(artists),
    }
    with _reco_lock:
        if len(_reco) > 256:
            _reco.clear()
        _reco[key] = (time.monotonic(), out)
    return jsonify(out)


@webapi.route("/discover/mute", methods=["POST", "DELETE"])
@login_required
def discover_mute():
    """Never recommend this artist again (POST), or again (DELETE)."""
    data = request.get_json(silent=True) or {}
    provider = str(data.get("provider") or "deezer")
    ref = str(data.get("id") or "").strip()
    if provider not in ("deezer", "local") or not ref or len(ref) > 128:
        return jsonify({"error": "invalid id"}), 400
    if provider == "deezer" and not ref.isdigit():
        return jsonify({"error": "invalid id"}), 400
    if provider == "local":
        try:
            import uuid

            ref = str(uuid.UUID(ref))
        except ValueError:
            return jsonify({"error": "invalid id"}), 400
    user = request.webuser
    if request.method == "DELETE":
        ArtistMute.delete().where(
            (ArtistMute.user == user) & (ArtistMute.provider == provider) & (ArtistMute.ref == ref)
        ).execute()
    else:
        ArtistMute.insert(user=user, provider=provider, ref=ref, created=now()).on_conflict_ignore().execute()
    _forget_reco(user)
    return jsonify({"ok": True})


# -- the titles a person does not like ---------------------------------------------


def _forget_reco(user):
    discover.invalidate(user)
    with _reco_lock:
        for k in [k for k in _reco if k[0] == user.id]:
            _reco.pop(k, None)


@webapi.route("/dislike", methods=["POST"])
@login_required
def dislike():
    """``{id, on}``: the title (a row UUID, a Deezer id or ``provider:ref``)
    leaves this person's Flow, radios and mixes, with what sounds almost the
    same (``on`` true), or comes back (false). Only the database: a catalogue
    title the library never imported cannot be disliked offline, and is
    imported first (its metadata), like a star."""
    from . import _deezer_disabled, _provider, _valid_id, refs

    data = request.get_json(silent=True) or {}
    raw = str(data.get("id") or "")[:64]
    on = bool(data.get("on", True))
    track = refs.resolve_track(raw, materialize=True)
    if track is None:
        if not _valid_id(raw):
            return jsonify({"error": "invalid id"}), 400
        if not on:
            return jsonify({"disliked": False})
        from ..deezer import archive

        provider = _provider()
        if provider is None:
            return _deezer_disabled()
        try:
            track = archive.import_track(provider, raw)
        except Exception:
            current_app.logger.warning("dislike: metadata fetch failed for %s", int(raw), exc_info=True)
            return jsonify({"error": "track unavailable"}), 502
    user = request.webuser
    out = dislikes.set_disliked(user, track, on)
    _forget_reco(user)
    out["id"] = str(track.id)
    return jsonify(out)


@webapi.route("/me/dislikes")
@login_required
def my_dislikes():
    """The titles this person said they do not like, newest first (Réglages)."""
    return jsonify({"tracks": _tracks_in_order(dislikes.ids(request.webuser))})


# -- the releases ---------------------------------------------------------------------


#: Titles in the releases' flat list (the home shows the first of each release).
RELEASE_TRACKS_MAX = 400


def _release_tracks(rows, new_refs):
    """The titles of ``rows`` (ArtistRelease, already ordered newest first),
    each release's in its own order, as track dicts the player streams by
    their Deezer id. A title the library already holds is served from its row
    (archived, its own gain, its own credits); the rest are catalogue titles."""
    out = []
    for r in rows:
        meta = {
            "deezer_id": r.ref, "title": r.title, "kind": r.kind, "released": r.released,
            "nb_tracks": r.nb_tracks, "cover": r.cover,
        }
        for t in releases.release_tracks(r):
            artists = [{"deezer_id": a[0], "name": a[1], "role": "Main" if i == 0 else "Featured"}
                       for i, a in enumerate(t.get("a") or []) if isinstance(a, list) and len(a) == 2]
            main = artists[0] if artists else {"deezer_id": r.artist_ref, "name": r.artist_name}
            out.append({
                "deezer_id": str(t["r"]),
                "title": str(t.get("t") or ""),
                "duration": int(t.get("d") or 0),
                "explicit": bool(t.get("e")),
                "gain": None,
                "artist": {"deezer_id": main["deezer_id"], "name": main["name"]},
                "artists": artists or [dict(main, role="Main")],
                "display_artist": ", ".join(a["name"] for a in artists) or main["name"],
                "album": {"deezer_id": r.ref, "title": r.title, "cover": r.cover},
                "release": meta,
                "new": r.ref in new_refs,
            })
            if len(out) >= RELEASE_TRACKS_MAX:
                break
        if len(out) >= RELEASE_TRACKS_MAX:
            break
    ids = [t["deezer_id"] for t in out]
    held = {}
    for i in range(0, len(ids), 500):
        held.update({
            str(dz): tid
            for tid, dz in Track.select(Track.id, Track.deezer_id)
            .where(Track.deezer_id.in_(ids[i : i + 500]))
            .tuples()
        })
    if held:
        rows_ = {r["deezer_id"]: r for r in _tracks_in_order(list(held.values()))}
        for k, t in enumerate(out):
            row = rows_.get(t["deezer_id"])
            if row is not None:
                out[k] = dict(row, release=t["release"], new=t["new"])
    return out


def _user_releases(user, limit=RELEASES_MAX, with_rows=False):
    conf = releases.settings()
    favs = releases.favourite_refs("deezer", users=[user.id])
    heard = {r: n for r, n in releases.listened_refs("deezer", users=[user.id]).items() if r not in favs}
    close = {r: v for r, v in releases.close_refs("deezer", favs, conf["close"]).items()
             if r not in heard}
    refs = list(favs) + list(heard) + [r for r in close if r not in favs]
    if not refs:
        return ([], 0, []) if with_rows else ([], 0)
    since = (now().date() - datetime.timedelta(days=conf["window"])).isoformat()
    row = UserTaste.get_or_none(UserTaste.user == user)
    seen = row.releases_seen if row is not None else None
    close_to = {}
    if close:
        names = {}
        from ..db import ArtistLink

        for a, o in (
            ArtistLink.select(ArtistLink.artist_ref, ArtistLink.other_ref)
            .where((ArtistLink.provider == "deezer") & ArtistLink.other_ref.in_(list(close))
                   & ArtistLink.artist_ref.in_(list(favs)))
            .order_by(ArtistLink.pos)
            .tuples()
        ):
            names.setdefault(o, favs.get(a))
        close_to = names
    out, unseen, shown = [], 0, []
    rows = []
    for i in range(0, len(refs), 500):
        rows += list(
            ArtistRelease.select()
            .where((ArtistRelease.provider == "deezer")
                   & ArtistRelease.artist_ref.in_(refs[i : i + 500])
                   & (ArtistRelease.released >= since))
        )
    # Newest first; on the same day, a favourite before an artist listened to,
    # before an artist close to a favourite.
    tier = {r: 0 for r in favs}
    tier.update({r: 1 for r in heard if r not in tier})
    rows.sort(key=lambda r: (r.released or "", -tier.get(r.artist_ref, 2), r.found), reverse=True)
    for r in releases.shown_releases(rows)[:limit]:
        shown.append(r)
        is_close = r.artist_ref not in favs and r.artist_ref not in heard
        new = seen is None or r.found > seen
        unseen += 1 if new else 0
        out.append(_release_card(
            r,
            subtitle=(f"Proche de {close_to.get(r.artist_ref)}" if is_close and close_to.get(r.artist_ref)
                      else r.artist_name),
            close_to=close_to.get(r.artist_ref) if is_close else None,
            new=new,
        ))
    return (out, unseen, shown) if with_rows else (out, unseen)


@webapi.route("/releases")
@login_required
def my_releases():
    """The releases as cards, and their TITLES as one list (newest release
    first): the home lists new titles, not albums to open first."""
    items, unseen, rows = _user_releases(request.webuser, with_rows=True)
    new_refs = {c["deezer_id"] for c in items if c["new"]}
    return jsonify({
        "releases": items,
        "unseen": unseen,
        "tracks": _release_tracks(rows, new_refs),
        "pending": sum(1 for r in rows if r.tracks is None),
    })


@webapi.route("/releases/seen", methods=["POST"])
@login_required
def releases_seen():
    user = request.webuser
    stamp = now()
    discover.save_taste(user, releases_seen=stamp)
    return jsonify({"ok": True})


@webapi.route("/releases/settings")
@login_required
@admin_required
def releases_settings():
    return jsonify(releases.status())


@webapi.route("/releases/settings", methods=["PUT"])
@login_required
@admin_required
def releases_settings_set():
    data = request.get_json(silent=True) or {}
    try:
        releases.save_settings(data)
    except ValueError:
        return jsonify({"error": "invalid settings"}), 400
    return jsonify(releases.status())


@webapi.route("/releases/check", methods=["POST"])
@login_required
@admin_required
def releases_check():
    started = releases.run_now(current_app._get_current_object(), force=True)
    return jsonify(dict(releases.status(), started=started))

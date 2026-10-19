# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A genre model as a FILE: what one server learnt, handed to another.

One file carries both halves of what the studio makes, because they are useful
in different situations (genre.py's head and labels):

- the HEAD, which serves at once — but only on a server whose vectors live in
  the same space (the same frozen extractor, a width it can read);
- the LABELS (genre name + what the track is: Deezer id, YouTube id, or artist
  and title for an upload), which outlive any extractor and ADD to the
  receiver's own tags: retrain, and the head is theirs.

The import is a preview then a choice (use the head, add the labels, or both).
Labels follow the studio's rule: one tag per track, and a track that already
wears one keeps it — a file never overwrites a choice made on this server.
A track the library does not have yet is made from Deezer's record, as a
reference import does; nothing is downloaded.

Nothing in the file identifies this server or its users: names of genres,
public catalogue ids, titles, and the head's own weights and scores.
"""

from __future__ import annotations

import json
import logging
import re
import threading

from flask import Response, current_app, jsonify, request
from peewee import fn

from ..db import Album, Artist, GenreModel, GenreTag, Track, TrackTag, now
from . import _valid_id, admin_required, login_required, webapi
from . import genre as studio

logger = logging.getLogger(__name__)

FORMAT = "nsupysonic-genre"
FORMAT_VERSION = 1
#: A file listing more labels than this is not one anybody tagged by hand.
TAGS_MAX = 50000
#: Consecutive Deezer failures that mean it is not answering (as the default sounds).
DEEZER_MAX_FAILS = 5
_COLOR = re.compile(r"^#[0-9a-fA-F]{3,8}$")
_IN_CHUNK = 400


def _text(v, n):
    return str(v)[:n] if isinstance(v, (str, int, float)) and str(v).strip() else None


# -- export ---------------------------------------------------------------------


def _head_json():
    row = (
        GenreModel.select()
        .where(GenreModel.active == True)  # noqa: E712
        .order_by(GenreModel.created.desc(), GenreModel.id.desc())
        .first()
    )
    if row is None:
        return None
    try:
        metrics = json.loads(row.metrics or "{}") or {}
    except Exception:
        metrics = {}
    return {
        "labels": json.loads(row.labels),
        "weights": row.weights,
        "dim": row.dim,
        "kind": row.kind or "linear",
        "hidden": row.hidden or 0,
        "metrics": metrics,
        "version": row.version,
    }


def build_export():
    from ..deezer import embedding

    tags = []
    used = set()
    query = (
        TrackTag.select(TrackTag, Track, GenreTag, Artist, Album)
        .join(Track)
        .join(Artist, on=(Track.artist == Artist.id))
        .switch(Track)
        .join(Album, on=(Track.album == Album.id))
        .switch(TrackTag)
        .join(GenreTag)
        .order_by(TrackTag.created)
    )
    for tt in query:
        t = tt.track
        entry = {
            "genre": tt.tag.name,
            "title": t.title,
            "artist": t.artist.name if t.artist_id else None,
            "album": t.album.name if t.album_id else None,
            "duration": t.duration,
        }
        if t.deezer_id:
            entry["deezer_id"] = str(t.deezer_id)
        if getattr(t, "youtube_id", None):
            entry["youtube_id"] = t.youtube_id
        tags.append(entry)
        used.add(tt.tag.name)
    head = _head_json()
    if head:
        used.update(str(x) for x in head["labels"])
    genres = [
        {"name": g.name, "color": g.color, "archetype": g.archetype}
        for g in GenreTag.select().order_by(GenreTag.name)
        if g.name in used
    ]
    return {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "exported": now().isoformat(),
        "embedding": {
            "extractor": embedding.MODEL_FILENAME.rsplit(".", 1)[0],
            "version": embedding.EMBED_VERSION,
            "dim": embedding.EMBED_DIM,
        },
        "genres": genres,
        "tags": tags,
        "head": head,
    }


@webapi.route("/genre/share/export")
@login_required
@admin_required
def genre_share_export():
    body = json.dumps(build_export(), ensure_ascii=False, separators=(",", ":"))
    stamp = now().strftime("%Y%m%d")
    return Response(
        body,
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="modele-genres-{stamp}.nsgenre.json"'},
    )


# -- reading a file ---------------------------------------------------------------


def parse(data):
    """The file, validated and normalised, or raises ValueError with what is
    wrong. Everything in it is somebody else's text: bounded, typed, and never
    used as a path or a query fragment."""
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        raise ValueError("ce fichier n'est pas un modèle de genres NSupySonic")
    try:
        version = int(data.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version < 1 or version > FORMAT_VERSION:
        raise ValueError("version de fichier inconnue (mettez le serveur à jour)")
    raw_tags = data.get("tags") or []
    if not isinstance(raw_tags, list):
        raise ValueError("liste d'étiquettes illisible")
    if len(raw_tags) > TAGS_MAX:
        raise ValueError("trop d'étiquettes dans ce fichier")

    genres = {}
    for g in data.get("genres") or []:
        if not isinstance(g, dict):
            continue
        name = (_text(g.get("name"), 48) or "").strip()
        if not name:
            continue
        color = g.get("color") if isinstance(g.get("color"), str) and _COLOR.match(g["color"]) else None
        arch = g.get("archetype") if g.get("archetype") in studio.ARCHETYPES else None
        genres[name] = {"name": name, "color": color, "archetype": arch}

    tags = []
    for e in raw_tags:
        if not isinstance(e, dict):
            continue
        genre = (_text(e.get("genre"), 48) or "").strip()
        if not genre:
            continue
        did = str(e.get("deezer_id") or "")
        yid = _text(e.get("youtube_id"), 32)
        if yid and not re.match(r"^[A-Za-z0-9_-]{6,32}$", yid):
            yid = None
        entry = {
            "genre": genre,
            "deezer_id": did if _valid_id(did) else None,
            "youtube_id": yid,
            "title": _text(e.get("title"), 256),
            "artist": _text(e.get("artist"), 256),
        }
        if not (entry["deezer_id"] or entry["youtube_id"] or (entry["title"] and entry["artist"])):
            continue
        tags.append(entry)
        genres.setdefault(genre, {"name": genre, "color": None, "archetype": None})

    head = data.get("head")
    if head is not None and not (isinstance(head, dict) and isinstance(head.get("labels"), list)):
        raise ValueError("modèle illisible")
    if head:
        for label in head["labels"]:
            name = (_text(label, 48) or "").strip()
            if name:
                genres.setdefault(name, {"name": name, "color": None, "archetype": None})
    emb = data.get("embedding") if isinstance(data.get("embedding"), dict) else {}
    return {"genres": list(genres.values()), "tags": tags, "head": head or None, "embedding": emb}


def _head_summary(head, emb):
    """What the head is and whether THIS server can read it. The weights are
    checked for real at import (genre.store_head stores, re-reads, refuses);
    this says beforehand what will decide it."""
    from ..deezer import embedding

    if not head:
        return None
    try:
        dim = int(head.get("dim") or 0)
    except (TypeError, ValueError):
        dim = 0
    inputs = (head.get("metrics") or {}).get("inputs") if isinstance(head.get("metrics"), dict) else None
    try:
        width = int(inputs.get("embed")) if isinstance(inputs, dict) else dim
    except (TypeError, ValueError):
        width = dim
    out = {
        "labels": [str(x)[:48] for x in head["labels"]],
        "kind": str(head.get("kind") or "linear"),
        "dim": dim,
        "examples": (head.get("metrics") or {}).get("examples") if isinstance(head.get("metrics"), dict) else None,
        "balanced": (head.get("metrics") or {}).get("balanced") if isinstance(head.get("metrics"), dict) else None,
        "compatible": True,
        "reason": None,
    }
    ours = embedding.MODEL_FILENAME.rsplit(".", 1)[0]
    theirs = emb.get("extractor")
    if theirs and theirs != ours:
        out.update(compatible=False, reason=f"entraîné sur un autre extracteur ({str(theirs)[:64]})")
    elif width not in (embedding.EMBED_DIM, embedding.V2_EMBED_DIM):
        out.update(compatible=False, reason="vecteurs d'une largeur que ce serveur ne lit pas")
    return out


def _find(entry, deezer_rows=None):
    """The library's row for one entry, or None. Never asks Deezer."""
    from ..deezer import ids as dz_ids

    if entry["deezer_id"]:
        if deezer_rows is not None:
            return deezer_rows.get(entry["deezer_id"])
        return Track.get_or_none(Track.id == dz_ids.track_uuid(entry["deezer_id"]))
    if entry["youtube_id"]:
        if deezer_rows is not None:
            return deezer_rows.get(("yt", entry["youtube_id"]))
        return Track.get_or_none(Track.youtube_id == entry["youtube_id"])
    if deezer_rows is not None:
        return deezer_rows.get(("up", entry["title"].lower(), entry["artist"].lower()))
    # An upload exists only on the server it was uploaded to: the best this one
    # can do is the same artist and the same title among its own files.
    return (
        Track.select()
        .join(Artist, on=(Track.artist == Artist.id))
        .where(
            Track.deezer_id.is_null(),
            fn.LOWER(Track.title) == entry["title"].lower(),
            fn.LOWER(Artist.name) == entry["artist"].lower(),
        )
        .first()
    )


def _deezer_rows(entries):
    """Every entry's row the library already has, in a few chunked lookups
    rather than one statement per entry: keyed by Deezer id, ``("yt", id)`` and
    ``("up", title, artist)`` (lowercased) — what ``_find`` reads."""
    from ..deezer import ids as dz_ids

    want = {dz_ids.track_uuid(e["deezer_id"]): e["deezer_id"] for e in entries if e["deezer_id"]}
    found = {}
    keys = list(want)
    for i in range(0, len(keys), _IN_CHUNK):
        for t in Track.select().where(Track.id.in_(keys[i : i + _IN_CHUNK])):
            found[want[t.id]] = t
    yt = list({e["youtube_id"] for e in entries if not e["deezer_id"] and e["youtube_id"]})
    for i in range(0, len(yt), _IN_CHUNK):
        for t in Track.select().where(Track.youtube_id.in_(yt[i : i + _IN_CHUNK])):
            found.setdefault(("yt", t.youtube_id), t)
    up = {
        (e["title"].lower(), e["artist"].lower())
        for e in entries
        if not e["deezer_id"] and not e["youtube_id"]
    }
    if up:
        # The uploads' own (title, artist) pairs, read once: a LOWER() match per
        # entry was a table scan per line of the file.
        titles = list({t for t, _a in up})
        for i in range(0, len(titles), _IN_CHUNK):
            q = (
                Track.select(Track, Artist)
                .join(Artist, on=(Track.artist == Artist.id))
                .where(Track.deezer_id.is_null(), fn.LOWER(Track.title).in_(titles[i : i + _IN_CHUNK]))
            )
            for t in q:
                k = (t.title.lower(), t.artist.name.lower())
                if k in up:
                    found.setdefault(("up",) + k, t)
    return found


@webapi.route("/genre/share/preview", methods=["POST"])
@login_required
@admin_required
def genre_share_preview():
    try:
        f = parse(request.get_json(silent=True))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    rows = _deezer_rows(f["tags"])
    counts = {"total": len(f["tags"]), "local": 0, "deezer": 0, "unknown": 0, "kept": 0, "already": 0}
    wanted = {}
    for e in f["tags"]:
        t = _find(e, rows)
        if t is not None:
            counts["local"] += 1
            wanted[t.id] = e["genre"]
        elif e["deezer_id"]:
            counts["deezer"] += 1
        else:
            counts["unknown"] += 1
    ids = list(wanted)
    for i in range(0, len(ids), _IN_CHUNK):
        for tt in TrackTag.select(TrackTag, GenreTag).join(GenreTag).where(TrackTag.track.in_(ids[i : i + _IN_CHUNK])):
            # Same genre: nothing to do. Another one: this server's choice stands.
            counts["already" if tt.tag.name.lower() == wanted[tt.track_id].lower() else "kept"] += 1
    have = {g.name.lower() for g in GenreTag.select(GenreTag.name)}
    return jsonify({
        "tags": counts,
        "genres": len(f["genres"]),
        "new_genres": [g["name"] for g in f["genres"] if g["name"].lower() not in have],
        "head": _head_summary(f["head"], f["embedding"]),
    })


# -- importing --------------------------------------------------------------------

_job_lock = threading.Lock()
_job = {
    "running": False, "finished": None, "stopped": False,
    "total": 0, "done": 0, "tagged": 0, "already": 0, "kept": 0, "not_found": 0, "failed": 0,
}


def _job_json():
    with _job_lock:
        return dict(_job)


def _ensure_genres(genres):
    """The file's genres as this server's tags (made where missing), by name.
    An existing tag keeps its own colour and look: the file only fills gaps."""
    # Matched without case: "hardstyle" in a file IS this server's "Hardstyle"
    # (a second tag would split one class in two, and MySQL's index refuses it).
    have = {g.name.lower(): g for g in GenreTag.select()}
    out = {}
    for g in genres:
        key = g["name"].lower()
        if key not in have:
            have[key] = GenreTag.create(name=g["name"], color=g["color"], archetype=g["archetype"])
        out[g["name"]] = have[key]
    return out


def _run_import(app, entries, genres, inline=False):
    from ..db import close_connection, open_connection
    from ..deezer import library
    from ..deezer.workload import renice
    from . import _dz_live, _ensure_track_row

    renice(12)
    tagged_ids = []
    with app.app_context():
        try:
            if not inline:
                open_connection(reuse=True)
            tags = _ensure_genres(genres)
            rows = _deezer_rows(entries)
            provider = None
            asked = False
            fails = 0
            cache = None
            for e in entries:
                outcome = None
                try:
                    t = _find(e, rows)
                    if t is None and e["deezer_id"] and fails < DEEZER_MAX_FAILS:
                        if not asked:
                            provider, asked = _dz_live(), True
                        if provider is None:
                            outcome = "failed"  # Deezer off or out of reach: not a verdict
                        else:
                            try:
                                if cache is None:
                                    cache = library.ImportCache()
                                root = library.get_root_folder(provider.archive_dir)
                                t = _ensure_track_row(provider, e["deezer_id"], root, cache)
                                rows[e["deezer_id"]] = t
                                fails = 0
                            except Exception:
                                logger.info("genre share: %s not imported", e["deezer_id"], exc_info=True)
                                fails += 1
                                outcome = "failed"
                    if t is None and e["deezer_id"] and fails >= DEEZER_MAX_FAILS:
                        outcome = outcome or "failed"  # Deezer stopped answering
                    elif t is None:
                        outcome = outcome or "not_found"
                    else:
                        current = TrackTag.get_or_none(TrackTag.track == t)
                        tag = tags[e["genre"]]
                        if current is None:
                            TrackTag.create(track=t, tag=tag)
                            tagged_ids.append(t.id)
                            outcome = "tagged"
                        else:
                            outcome = "already" if current.tag_id == tag.id else "kept"
                except Exception:
                    logger.warning("genre share: an entry failed", exc_info=True)
                    outcome = "failed"
                with _job_lock:
                    _job["done"] += 1
                    _job[outcome] += 1
                    if fails >= DEEZER_MAX_FAILS:
                        _job["stopped"] = True
        except Exception:
            logger.warning("genre share: the import crashed", exc_info=True)
        finally:
            if tagged_ids:
                studio._forget_centroids()
                studio.invalidate_predictions()
                if inline:
                    _redecide_inline(tagged_ids)
                else:
                    studio._run_redecide(app, tagged_ids)
            with _job_lock:
                _job["running"] = False
                _job["finished"] = now().isoformat()
            if not inline:
                try:
                    close_connection()
                except Exception:
                    pass


def _redecide_inline(ids):
    """studio._run_redecide without its own connection (it closes it)."""
    from ..db import TrackAnalysis
    from ..deezer import analysis as ana

    changed = 0
    for i in range(0, len(ids), _IN_CHUNK):
        for row in TrackAnalysis.select(TrackAnalysis, Track).join(Track).where(
            TrackAnalysis.track.in_(ids[i : i + _IN_CHUNK])
        ):
            changed += bool(ana.redecide(row, vec=None))
    if changed:
        ana.bump_verdict_generation()


@webapi.route("/genre/share/import", methods=["GET", "POST"])
@login_required
@admin_required
def genre_share_import():
    if request.method == "GET":
        return jsonify(_job_json())
    data = request.get_json(silent=True) or {}
    try:
        f = parse(data.get("file"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    use_head, add_tags = bool(data.get("head")), bool(data.get("tags"))
    if not (use_head or add_tags):
        return jsonify({"error": "rien à importer"}), 400
    out = {}
    if use_head:
        if not f["head"]:
            return jsonify({"error": "ce fichier ne contient pas de modèle"}), 400
        summary = _head_summary(f["head"], f["embedding"])
        if not summary["compatible"]:
            return jsonify({"error": summary["reason"]}), 400
        # The head's labels are this server's genres too, so the studio lists them.
        _ensure_genres([g for g in f["genres"] if g["name"] in set(summary["labels"])])
        try:
            result, status = studio.store_head(f["head"])
        except (TypeError, ValueError):
            result, status = {"error": "modèle illisible"}, 400
        if status != 200:
            return jsonify(result), status
        studio.start_relabel(current_app._get_current_object())
        out["head"] = result
    if add_tags and f["tags"]:
        with _job_lock:
            if _job["running"]:
                return jsonify({"error": "un import est déjà en cours", **out}), 409
            _job.update(running=True, finished=None, stopped=False, total=len(f["tags"]),
                        done=0, tagged=0, already=0, kept=0, not_found=0, failed=0)
        app = current_app._get_current_object()
        if app.testing:
            # Tests drive the job in the request thread: nothing starts behind them.
            _run_import(app, f["tags"], f["genres"], inline=True)
        else:
            threading.Thread(target=_run_import, args=(app, f["tags"], f["genres"]),
                             name="genre-share-import", daemon=True).start()
    elif add_tags:
        _ensure_genres(f["genres"])
    out["job"] = _job_json()
    return jsonify(out)

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The tagging studio's API: your genre vocabulary, your labels, your model.

The shape of the feature, because it is not the obvious one: the big audio model
is FROZEN and only ever turns a track into a vector (see
``supysonic/deezer/embedding.py``). What the studio trains — in the browser, in
milliseconds, with no framework — is a small head from those vectors to the
user's own genre names. This module hands the browser the vectors and the
labels, takes the trained head back, and serves it to the analysis.

Writes are admin-only, deliberately: there is ONE model trained from these
labels, so two users disagreeing about what counts as hardtekk would be training
it against itself.
"""

from __future__ import annotations

import json
import logging
import random as _random
import threading

from uuid import UUID

from flask import current_app, jsonify, request

from ..db import GenreModel, GenreTag, Track, TrackTag, now
from . import _is_admin, _valid_id, admin_required, login_required, webapi

logger = logging.getLogger(__name__)

EMBED_BATCH_MAX = 200
CANDIDATE_MAX = 100
# How many archived rows one candidates request will look at. Generous enough
# that a normal library fills the page on the first pass, small enough that a
# pathological one cannot turn the request into a table scan.
CANDIDATE_SCAN_MAX = 4000
# The window the uncertainty ranking looks at. Wider on purpose: the most
# INFORMATIVE examples are not the most PLAYED ones, so a ranking drawn from the
# top of the play-count order would only ever re-rank the music that least needs
# tagging. Still bounded — this is a scroll position, not a table walk.
CANDIDATE_SCAN_ACTIVE = 12000
# A head for a 1280-d extractor and fifty genres is ~130 KB of base64. A big
# two-layer MLP (2x512) is ~2.5 MB. Eight megabytes is far past anything
# legitimate and stops a bad request from being a memory problem.
MODEL_MAX_BYTES = 8 * 1024 * 1024
ARCHETYPES = ("sustain", "voice", "groove", "hard", "rock")

# -- the extractor's self-test job -------------------------------------------
# Verifying a freshly uploaded model means decoding several of the operator's
# own tracks and comparing halves — far too slow to hold a request thread, so it
# runs in a worker and the studio polls it, exactly like the archive sweep.
_extractor_lock = threading.Lock()
_extractor_job = {
    "running": False,
    "started": None,
    "ok": None,
    "result": None,
    "progress": [],
    "error": None,
}
EXTRACTOR_TEST_TRACKS = 6
EXTRACTOR_TEST_LOG_MAX = 12


def _extractor_status() -> dict:
    """What the studio needs to know about the extractor."""
    from ..deezer import embedding as emb

    usable = emb.available() and bool(emb.model_path())
    return {
        "available": usable,
        "reason": emb.why_unavailable(),
        "dim": emb.EMBED_DIM,
        "version": emb.EMBED_VERSION,
        "onnxruntime": emb.onnxruntime_available(),
        "model": emb.model_info(),
        "uploadable": emb.can_write_model(),
        # A model that is present but will not load (a wrong file, an input the
        # front-end cannot feed) is the one failure that otherwise shows up as
        # thousands of per-track failures. Loading is cached, so this costs one
        # model load on the first studio visit and nothing after.
        "session_error": emb.session_error() if usable else None,
        # Where to get the exact export the front-end needs, so the studio never
        # has to say "find the model file yourself".
        "model_url": emb.MODEL_URL,
    }


def _extractor_job_json() -> dict:
    with _extractor_lock:
        return dict(_extractor_job)


def _reset_extractor_job() -> None:
    """Forget a previous verdict when the model it judged is replaced or gone."""
    with _extractor_lock:
        if _extractor_job["running"]:
            return
        _extractor_job.update(
            started=None, ok=None, result=None, progress=[], error=None
        )


# -- the embedding backfill job ----------------------------------------------
# The slow one: every archived track without a vector is decoded and run through
# the model — minutes on a small library, hours on a large one. So it is a
# worker the studio polls, exactly like the extractor's self-test and the
# archive sweep, and for the same reason: a request must never be what starts a
# long decode, because the answer would arrive long after it mattered while
# holding a thread.
_embed_lock = threading.Lock()
_embed_job = {
    "running": False,
    "started": None,
    "finished": None,
    "force": False,
    "workers": 1,
    "total": 0,
    "scanned": 0,
    "done": 0,
    "skipped": 0,
    "failed": 0,
    "error": None,
}


def _embed_job_json() -> dict:
    with _embed_lock:
        return dict(_embed_job)


def _run_embed(app, force, workers=None):
    """Worker: measure every archived track that still lacks a vector."""
    from ..db import close_connection, open_connection
    from ..deezer.analysis import backfill_embeddings

    with app.app_context():
        try:
            open_connection(reuse=True)

            def on_stats(stats):
                with _embed_lock:
                    _embed_job.update(stats)

            stats = backfill_embeddings(force=force, workers=workers, on_stats=on_stats)
            with _embed_lock:
                _embed_job.update(stats)
        except Exception as exc:
            logger.warning("Embedding backfill crashed", exc_info=True)
            with _embed_lock:
                _embed_job["error"] = str(exc)
        finally:
            with _embed_lock:
                _embed_job["running"] = False
                _embed_job["finished"] = now().isoformat()
            try:
                close_connection()
            except Exception:
                pass


#: Let the server finish coming up before a library job takes the disk.
RESUME_DELAY = 60


def resume_if_interrupted(app):
    """Pick the embedding run back up after a restart that cut it short.

    Same reasoning as the analysis backfill: extracting a vector for a real
    library is hours of decoding, and an operator who pressed the button once
    should not have to discover that a container restart quietly ended it.
    """
    from ..deezer.analysis import EMBED_CURSOR_KEY, _checkpoint_read

    def start():
        import time

        time.sleep(RESUME_DELAY)
        with app.app_context():
            from ..db import close_connection, open_connection
            from ..deezer import embedding as emb

            try:
                open_connection(reuse=True)
                if emb.why_unavailable():
                    return  # nothing to resume WITH
                plain = _checkpoint_read(EMBED_CURSOR_KEY, force=False)
                forced = _checkpoint_read(EMBED_CURSOR_KEY, force=True)
                if plain is None and forced is None:
                    return
                force = plain is None
                total = Track.select().where(Track.last_modification > 0).count()
            except Exception:
                logger.debug("Could not read the embedding checkpoint", exc_info=True)
                return
            finally:
                try:
                    close_connection()
                except Exception:
                    pass
        with _embed_lock:
            if _embed_job["running"]:
                return
            _embed_job.update(
                running=True, started=now().isoformat(), finished=None, force=force,
                total=total, scanned=0, done=0, skipped=0, failed=0, error=None,
            )
        logger.info("Resuming the interrupted embedding backfill")
        _run_embed(app, force)

    threading.Thread(target=start, name="genre-embed-resume", daemon=True).start()


def _resolve(ident):
    """A Track from either a Deezer numeric id or a local UUID."""
    from ..deezer import ids as dz_ids

    if ident is None:
        return None
    ident = str(ident)
    try:
        if _valid_id(ident):
            return Track.get_or_none(Track.id == dz_ids.track_uuid(ident))
        return Track.get_or_none(Track.id == UUID(ident))
    except (ValueError, AttributeError, TypeError):
        # Not an id at all. Rejected before it reaches the database, because on
        # Postgres a malformed UUID in a WHERE is a DataError that poisons the
        # whole transaction — not a query that returns nothing.
        return None
    except Exception:
        logger.warning("genre: could not resolve %r", ident, exc_info=True)
        return None


def _tag_json(t):
    return {"id": t.id, "name": t.name, "color": t.color, "archetype": t.archetype}


def _track_json(t, prediction=None):
    out = {
        "id": str(t.id),
        "deezer_id": t.deezer_id,
        "title": t.title,
        "artist": t.artist.name if t.artist else "",
        "album": t.album.name if t.album else "",
        "duration": t.duration,
        "play_count": t.play_count,
    }
    if prediction:
        out["predicted"] = prediction[0]
        out["confidence"] = prediction[1]
        # top1 − top2: what tells "this is that genre" from "this is somewhere
        # between three". The studio can show it, and the analysis gates on it.
        out["margin"] = prediction[3] if len(prediction) > 3 else None
    return out


@webapi.route("/genre/status")
@login_required
def genre_status():
    """Everything the studio needs to know before it shows anything."""
    from ..deezer import genre as gen

    if _is_admin():
        # First admin visit: hand the studio the engine's own genres as tags, so
        # tagging starts by CONFIRMING a guess rather than typing a vocabulary.
        # One-time — see seed_default_tags.
        gen.seed_default_tags()

    head = gen.active_head()
    labelled = TrackTag.select().count()
    counts = {}
    for tag in GenreTag.select():
        counts[tag.name] = (
            TrackTag.select().where(TrackTag.tag == tag).count()
        )
    model = (
        GenreModel.select()
        .where(GenreModel.active == True)  # noqa: E712
        .order_by(GenreModel.created.desc())
        .first()
    )
    return jsonify(
        {
            "extractor": _extractor_status(),
            "tags": [_tag_json(t) for t in GenreTag.select().order_by(GenreTag.name)],
            "counts": counts,
            "labelled": labelled,
            "model": None
            if model is None
            else {
                "version": model.version,
                "created": model.created.isoformat(),
                "labels": json.loads(model.labels),
                "metrics": json.loads(model.metrics) if model.metrics else {},
                "usable": head is not None,
            },
            "archetypes": list(ARCHETYPES),
        }
    )


# -- the extractor itself ---------------------------------------------------
# The big frozen model is a third-party artefact with its own licence, so it is
# never vendored and never fetched for you. What the studio CAN do is take a
# copy the operator obtained themselves: upload it here and it lands in the
# cache's models directory, where both the server and `deezer embed` find it.


@webapi.route("/genre/extractor", methods=["POST"])
@login_required
@admin_required
def genre_extractor_upload():
    """Install an uploaded ONNX extractor (admin only, one file at a time)."""
    from ..deezer import embedding as emb

    files = request.files.getlist("files") or request.files.getlist("file")
    if not files:
        return jsonify({"error": "no file"}), 400
    onnx = [f for f in files if (f.filename or "").lower().endswith(".onnx")]
    if not onnx:
        return jsonify({"error": "the extractor must be a .onnx file"}), 400
    if len(onnx) > 1:
        return jsonify({"error": "upload one .onnx file at a time"}), 400
    path, err = emb.store_model(onnx[0].stream, onnx[0].filename)
    if err:
        return jsonify({"error": err}), 400
    _reset_extractor_job()
    logger.info("Extractor installed by %s: %s", request.webuser.name, path)
    return jsonify({"ok": True, "extractor": _extractor_status()})


@webapi.route("/genre/extractor", methods=["DELETE"])
@login_required
@admin_required
def genre_extractor_delete():
    from ..deezer import embedding as emb

    if not emb.delete_model():
        return jsonify({"error": "no uploaded extractor to remove"}), 404
    _reset_extractor_job()
    logger.info("Extractor removed by %s", request.webuser.name)
    return jsonify({"ok": True, "extractor": _extractor_status()})


@webapi.route("/genre/extractor/test", methods=["POST"])
@login_required
@admin_required
def genre_extractor_test():
    """Start the self-test on real tracks.

    An uploaded model that merely *loads* proves nothing: the whole failure mode
    this guards against is a front-end/model mismatch that produces healthy
    numbers which mean nothing. Two halves of the same track must embed closer
    together than two different tracks do."""
    from ..deezer import embedding as emb

    why = emb.why_unavailable()
    if why:
        return jsonify({"error": why}), 400
    with _extractor_lock:
        if _extractor_job["running"]:
            return jsonify({"ok": True, "running": True})
        _extractor_job.update(
            running=True,
            started=now().isoformat(),
            ok=None,
            result=None,
            progress=[],
            error=None,
        )
    app = current_app._get_current_object()
    threading.Thread(
        target=_run_extractor_test, args=(app,), name="extractor-self-test", daemon=True
    ).start()
    return jsonify({"ok": True, "running": True})


@webapi.route("/genre/extractor/test")
@login_required
@admin_required
def genre_extractor_test_status():
    return jsonify(_extractor_job_json())


def _run_extractor_test(app):
    """Worker: embed halves of a few real tracks and judge the margin."""
    from ..db import close_connection, open_connection

    with app.app_context():
        try:
            open_connection(reuse=True)
            from ..deezer import embedding as emb

            # Long enough to embed two spans, and the music this library actually
            # plays: the first six rows of a table are a poor sample (intros,
            # skits, a broken import) and would make the test fail for the wrong
            # reason.
            paths = [
                t.path
                for t in Track.select()
                .where((Track.last_modification > 0) & (Track.duration >= 90))
                .order_by(Track.play_count.desc())
                .limit(EXTRACTOR_TEST_TRACKS)
                if t.path
            ]

            def say(line):
                with _extractor_lock:
                    log = _extractor_job["progress"]
                    log.append(str(line))
                    del log[:-EXTRACTOR_TEST_LOG_MAX]

            result = emb.self_test(paths, progress=say)
            with _extractor_lock:
                _extractor_job["ok"] = bool(result.get("ok"))
                _extractor_job["result"] = result
        except Exception as exc:
            logger.warning("Extractor self-test crashed", exc_info=True)
            with _extractor_lock:
                _extractor_job["ok"] = False
                _extractor_job["error"] = str(exc)
        finally:
            with _extractor_lock:
                _extractor_job["running"] = False
            try:
                close_connection()
            except Exception:
                pass


@webapi.route("/genre/embed", methods=["POST"])
@login_required
@admin_required
def genre_embed_start():
    """Measure every archived track that has no embedding yet.

    Admin-only and idempotent: tracks that already have a vector are skipped, so
    pressing the button again only picks up what has been archived since. The
    work runs in a worker and the studio polls ``/genre/embed``."""
    from ..deezer import embedding as emb

    why = emb.why_unavailable()
    if why:
        return jsonify({"error": why}), 400
    from ..deezer.analysis import auto_workers

    data = request.get_json(silent=True) or {}
    force = bool(data.get("force") or request.args.get("force"))
    try:
        workers = int(data.get("workers") or 0)
    except (TypeError, ValueError):
        workers = 0
    workers = auto_workers(workers)
    with _embed_lock:
        if _embed_job["running"]:
            return jsonify({"ok": True, **_embed_job})
        _embed_job.update(
            running=True,
            started=now().isoformat(),
            finished=None,
            force=force,
            workers=workers,
            total=Track.select().where(Track.last_modification > 0).count(),
            scanned=0,
            done=0,
            skipped=0,
            failed=0,
            error=None,
        )
    app = current_app._get_current_object()
    threading.Thread(
        target=_run_embed, args=(app, force, workers), name="genre-embed", daemon=True
    ).start()
    return jsonify({"ok": True, **_embed_job_json()})


@webapi.route("/genre/embed")
@login_required
@admin_required
def genre_embed_status():
    return jsonify(_embed_job_json())


@webapi.route("/genre/tags/defaults", methods=["POST"])
@login_required
@admin_required
def genre_tags_defaults():
    """Fill in any engine genre the vocabulary is missing.

    The same set is seeded automatically on the first admin visit; this is the
    way back after deleting one (it only ADDS — it never edits or removes)."""
    from ..deezer import genre as gen

    created = gen.seed_default_tags(force=True)
    return jsonify({"created": created})


@webapi.route("/genre/tags", methods=["POST"])
@login_required
@admin_required
def genre_tag_create():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()[:48]
    if not name:
        return jsonify({"error": "name required"}), 400
    arch = data.get("archetype")
    if arch is not None and arch not in ARCHETYPES:
        return jsonify({"error": "unknown archetype"}), 400
    tag = GenreTag.get_or_none(GenreTag.name == name)
    if tag is None:
        tag = GenreTag.create(name=name, color=(data.get("color") or None), archetype=arch)
    return jsonify(_tag_json(tag))


@webapi.route("/genre/tags/<int:tag_id>", methods=["PATCH", "DELETE"])
@login_required
@admin_required
def genre_tag_edit(tag_id):
    tag = GenreTag.get_or_none(GenreTag.id == tag_id)
    if tag is None:
        return jsonify({"error": "not found"}), 404
    if request.method == "DELETE":
        # The labels go with it; the trained model does not, because it stays
        # valid for whatever it was trained on until a new one replaces it.
        TrackTag.delete().where(TrackTag.tag == tag).execute()
        tag.delete_instance()
        return jsonify({"deleted": True})
    data = request.get_json(silent=True) or {}
    if "name" in data:
        name = (data.get("name") or "").strip()[:48]
        if not name:
            return jsonify({"error": "name required"}), 400
        tag.name = name
    if "color" in data:
        tag.color = data.get("color") or None
    if "archetype" in data:
        arch = data.get("archetype")
        if arch is not None and arch not in ARCHETYPES:
            return jsonify({"error": "unknown archetype"}), 400
        tag.archetype = arch
    tag.save()
    return jsonify(_tag_json(tag))


@webapi.route("/genre/label", methods=["POST"])
@login_required
@admin_required
def genre_label():
    """Label one track, or clear its label. One tag per track, on purpose.

    A track that is "frenchcore AND uptempo" teaches the head that those two
    labels describe the same sound, which is the opposite of what tagging it was
    for. If a track genuinely sits between two genres, it is better left out.
    """
    data = request.get_json(silent=True) or {}
    track = _resolve(data.get("track"))
    if track is None:
        return jsonify({"error": "unknown track"}), 404
    TrackTag.delete().where(TrackTag.track == track).execute()
    raw = data.get("tag")
    if raw in (None, "", 0):
        # The prototype is a running average over the labelled set, so a label
        # removed has to leave it, not linger for the length of a TTL.
        _forget_centroids()
        return jsonify({"track": str(track.id), "tag": None})
    tag = GenreTag.get_or_none(GenreTag.id == raw) or GenreTag.get_or_none(
        GenreTag.name == str(raw)
    )
    if tag is None:
        return jsonify({"error": "unknown tag"}), 404
    TrackTag.create(track=track, tag=tag)
    # This one label just moved a genre's prototype, and the very next page the
    # admin sees is the candidate list — showing them a prediction that ignores
    # the label they just applied would be worse than showing none.
    _forget_centroids()
    return jsonify({"track": str(track.id), "tag": _tag_json(tag)})


def _forget_centroids():
    from ..deezer import genre as gen

    try:
        gen.invalidate_centroids()
    except Exception:
        logger.debug("genre: could not drop the prototype cache", exc_info=True)


@webapi.route("/genre/candidates")
@login_required
@admin_required
def genre_candidates():
    """Tracks worth tagging next, with what the model currently thinks.

    Ordered by play count by default: the labels that matter most are the ones on
    music this library actually listens to. Each row carries the model's current
    guess so tagging is mostly CONFIRMING — which is the difference between
    labelling two hundred tracks and giving up after twenty.

    ``?sort=active`` orders by UNCERTAINTY instead, which is the active-learning
    argument: an example the model is already sure about teaches it almost
    nothing, however often it has been played, so a labelling budget spent on the
    most-played tracks first is a budget spent on the easiest ones. The score is
    ``(1 - margin) * sqrt(1 + play_count)`` rather than margin alone — a pure
    uncertainty ranking would walk straight past the music that matters to this
    library, and the square root keeps familiarity in the ranking without letting
    one heavily-played weak case monopolise the top.

    Both orders keep a small RANDOM reserve at the end. Uncertainty sampling on
    its own interrogates the same borderline cluster for ever and never looks at
    a genre it has not seen; the reserve is the documented cold-start fix, and it
    is taken from the same bounded scan so it costs nothing extra.
    """
    from ..deezer import embedding as emb
    from ..deezer import genre as gen

    try:
        limit = max(1, min(CANDIDATE_MAX, int(request.args.get("limit", 40))))
    except (TypeError, ValueError):
        limit = 40
    by_uncertainty = str(request.args.get("sort") or "") in ("active", "uncertainty")
    # The scan window is the whole cost of this endpoint when a head exists: each
    # row is looked at, and a prediction is a dot product over 1280 floats. A
    # larger pool is what makes an uncertainty ranking mean anything — the best
    # fifty examples are not in the first four hundred by play count — so the
    # window is wider than the default path needs, and never unbounded.
    scan = CANDIDATE_SCAN_ACTIVE if by_uncertainty else CANDIDATE_SCAN_MAX
    labelled = {tt.track_id for tt in TrackTag.select(TrackTag.track)}
    rows = []
    scanned = 0
    query = (
        Track.select()
        .where(Track.last_modification > 0)
        .order_by(Track.play_count.desc(), Track.created.desc())
        # Bounded: whether a track HAS a vector is a file on disk, not a column,
        # so filling the list costs one stat per row looked at. Without a cap, a
        # library whose vectors are still being extracted — every library on its
        # first day — pays a full table walk on every request.
        .limit(scan)
    )
    for track in query:
        scanned += 1
        if track.id in labelled:
            continue
        vec = emb.load_embedding(track)
        if vec is None:
            continue
        guess = gen.predict(vec)
        row = _track_json(track, guess)
        # The head is only one of two opinions once labels exist. The prototype
        # needs no training, so it is the only one with something to say while a
        # genre is still one or two examples old — see deezer/genre.py.
        proto = gen.prototype_predict(vec)
        if proto:
            row["prototype"] = {"label": proto[0], "similarity": proto[1]}
        if guess:
            # top1 − top2 already says how decided the head is.
            margin = guess[3] if len(guess) > 3 else 1.0
            row["uncertainty"] = round(max(0.0, 1.0 - margin), 4)
        else:
            # No head: nothing is "decided", so everything is equally worth a
            # look and play count is free to break the tie.
            row["uncertainty"] = 1.0
        rows.append(row)

    truncated = len(rows) > limit
    if not by_uncertainty:
        rows = rows[:limit]
    else:
        import math as _math

        # A random reserve, drawn from the rows we already have, so the studio
        # keeps some coverage of genres the head is confident it has never seen.
        reserve = max(1, limit // 5)
        scored = sorted(
            rows,
            key=lambda r: (r.get("uncertainty") or 0.0)
            * _math.sqrt(1 + (r.get("play_count") or 0)),
            reverse=True,
        )
        head_rows = scored[: max(0, limit - reserve)]
        rest = scored[len(head_rows) :]
        # Fisher-Yates over the remainder, so the reserve is genuinely random
        # rather than "the least-played of the uncertain".
        for i in range(len(rest) - 1, 0, -1):
            j = int(_math.floor((i + 1) * _random.random()))
            rest[i], rest[j] = rest[j], rest[i]
        rows = head_rows + rest[:reserve]

    return jsonify(
        {
            "candidates": rows,
            "labelled": len(labelled),
            "sort": "active" if by_uncertainty else "plays",
            # True when the scan stopped on its own cap rather than on the list
            # being full: there may be more, we just did not look further.
            "truncated": scanned >= scan and truncated,
        }
    )


@webapi.route("/genre/labelled")
@login_required
@admin_required
def genre_labelled():
    """What has been tagged so far, newest first."""
    out = []
    for tt in (
        TrackTag.select(TrackTag, Track, GenreTag)
        .join(Track)
        .switch(TrackTag)
        .join(GenreTag)
        .order_by(TrackTag.created.desc())
        .limit(500)
    ):
        row = _track_json(tt.track)
        row["tag"] = _tag_json(tt.tag)
        out.append(row)
    return jsonify({"labelled": out})


@webapi.route("/genre/embeddings", methods=["POST"])
@login_required
@admin_required
def genre_embeddings():
    """The training set: one base64 float16 vector per requested track.

    Only tracks that already HAVE a vector: this endpoint never extracts. The
    studio asks for hundreds at once and an answer that had to decode hundreds
    of files would arrive tomorrow.

    Only vectors at the CURRENT width are served, and the rest are counted in
    ``stale``. A head is trained on one flat matrix: mixing v1 (mean-only) and
    v2 (mean+std) rows would misalign every column after the first 1280 and
    silently train on noise. A stale row is a row whose extractor has not been
    re-run since the aggregation changed, which the studio already offers as a
    button — so the honest answer is "not yet", not a padded vector.
    """
    from ..deezer import embedding as emb

    data = request.get_json(silent=True) or {}
    raw = data.get("ids") or []
    if not isinstance(raw, list):
        return jsonify({"error": "ids must be a list"}), 400
    out = {}
    stale = 0
    for ident in list(dict.fromkeys(str(x) for x in raw))[:EMBED_BATCH_MAX]:
        track = _resolve(ident)
        if track is None:
            continue
        vec = emb.load_embedding(track)
        if vec is None:
            continue
        if len(vec) != emb.EMBED_DIM:
            stale += 1
            continue
        out[ident] = emb.encode_embedding(vec)
    return jsonify({"embeddings": out, "dim": emb.EMBED_DIM, "stale": stale})


@webapi.route("/genre/model", methods=["GET", "PUT", "DELETE"])
@login_required
def genre_model():
    from ..deezer import genre as gen

    if request.method == "GET":
        head = gen.active_head()
        if head is None:
            return jsonify({"ready": False})
        return jsonify(
            {"ready": True, "labels": head["labels"], "dim": head["dim"],
             "kind": head["kind"], "hidden": head["hidden"],
             "version": head["version"]}
        )

    # GET is readable by anyone logged in (the player needs the label list);
    # changing the model is an admin act.
    if not _is_admin():
        return jsonify({"error": "forbidden"}), 403

    if request.method == "DELETE":
        GenreModel.update(active=False).where(GenreModel.active == True).execute()  # noqa: E712
        gen.invalidate()
        return jsonify({"deleted": True})

    data = request.get_json(silent=True) or {}
    labels = data.get("labels")
    weights = data.get("weights")
    dim = int(data.get("dim") or 0)
    if not isinstance(labels, list) or len(labels) < 2:
        return jsonify({"error": "at least two labels are needed"}), 400
    if not isinstance(weights, str) or not weights:
        return jsonify({"error": "weights required"}), 400
    if len(weights) > MODEL_MAX_BYTES:
        return jsonify({"error": "weights too large"}), 413
    if dim <= 0 or dim > 8192:
        return jsonify({"error": "bad dim"}), 400

    kind = str(data.get("kind") or "linear").lower()
    if kind not in ("linear", "mlp", "mlp2"):
        return jsonify({"error": "unknown kind"}), 400
    hidden = int(data.get("hidden") or 0)
    if kind in ("mlp", "mlp2") and not (1 <= hidden <= 2048):
        return jsonify({"error": "bad hidden size"}), 400

    row = GenreModel.create(
        version=(GenreModel.select().count() + 1),
        kind=kind,
        hidden=hidden,
        labels=json.dumps([str(x)[:48] for x in labels]),
        weights=weights,
        metrics=json.dumps(data.get("metrics") or {}),
        dim=dim,
        active=True,
    )
    GenreModel.update(active=False).where(GenreModel.id != row.id).execute()
    gen.invalidate()
    # Refuse to keep a head that cannot be read back: a model stored but
    # unusable would silently do nothing for ever.
    if gen.active_head() is None:
        row.delete_instance()
        gen.invalidate()
        return jsonify({"error": "weights do not match the labels and dim given"}), 400
    return jsonify({"stored": True, "version": row.version})

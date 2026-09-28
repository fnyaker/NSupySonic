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
import time

from uuid import UUID

from flask import current_app, jsonify, request
from peewee import JOIN

from ..db import (
    Album,
    Artist,
    GenreModel,
    GenreTag,
    Track,
    TrackAnalysis,
    TrackTag,
    now,
)
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
#: How long ONE candidates request may spend building its pool. A ranking over
#: the rows it could afford inside a second and a half is a good ranking; a page
#: that never arrives is not one at all.
CANDIDATE_BUDGET = 1.5
#: A track with no vector costs a disk read to discover that, so the miss is
#: remembered too — but only briefly, because the backfill is out there creating
#: exactly these files while the studio is open.
CANDIDATE_MISS_TTL = 120.0
_PRED_CACHE_MAX = 30000
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
    # A model that is present but will not load (a wrong file, an input the
    # front-end cannot feed) is the one failure that otherwise shows up as
    # thousands of per-track failures, so the studio says so up front. But it
    # asks WITHOUT waiting: loading a 40 MB ONNX graph is seconds, and doing it
    # on the thread serving this request is what made the studio's first visit
    # take most of a minute to paint. The probe reports what is known and loads
    # in the background; the page shows "vérification…" and asks again.
    probe = emb.session_probe() if usable else {"state": "ok", "error": None}
    return {
        "available": usable,
        "reason": emb.why_unavailable(),
        "dim": emb.EMBED_DIM,
        "version": emb.EMBED_VERSION,
        "onnxruntime": emb.onnxruntime_available(),
        "model": emb.model_info(),
        "uploadable": emb.can_write_model(),
        "session_state": probe["state"],
        "session_error": probe["error"],
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
    # Which tracks failed and why — see webui/analysis.py for why a counter on
    # its own is not a report anybody can act on.
    "failures": [],
    "failure_reasons": {},
}


def _embed_job_json() -> dict:
    from .analysis import _job_snapshot

    with _embed_lock:
        return _job_snapshot(_embed_job)


def _run_embed(app, force, workers=None):
    """Worker: measure every archived track that still lacks a vector."""
    from ..db import close_connection, open_connection
    from ..deezer.analysis import backfill_embeddings

    with app.app_context():
        try:
            open_connection(reuse=True)

            from .analysis import _job_snapshot

            def on_stats(stats):
                # Copied on the way in: the ledger belongs to the worker
                # threads, and a status poll must not iterate it live.
                snap = _job_snapshot(stats)
                with _embed_lock:
                    _embed_job.update(snap)

            stats = backfill_embeddings(force=force, workers=workers, on_stats=on_stats)
            snap = _job_snapshot(stats)
            with _embed_lock:
                _embed_job.update(snap)
        except Exception as exc:
            logger.warning("Embedding backfill crashed", exc_info=True)
            with _embed_lock:
                _embed_job["error"] = str(exc)
        finally:
            with _embed_lock:
                _embed_job["running"] = False
                _embed_job["finished"] = now().isoformat()
            # Vectors that did not exist when the studio last asked do now, and
            # the ones that did may have been re-extracted. Every opinion the
            # candidate list is holding was formed before that.
            invalidate_predictions()
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
                failures=[], failure_reasons={},
            )
        logger.info("Resuming the interrupted embedding backfill")
        _run_embed(app, force)

    threading.Thread(target=start, name="genre-embed-resume", daemon=True).start()


# -- re-applying the head to the whole library ---------------------------------
# A verdict was frozen at the moment a track was measured, so a head trained
# today reached only what was archived after it; everything else needed the full
# re-measure (hours of ffmpeg) for an answer that needs none of it. So storing a
# head — or disabling it — re-decides every stored verdict from what is stored
# (analysis.reapply_head): the measures, the vector, the tag. Seconds to minutes.
_relabel_lock = threading.Lock()
_relabel_job = {
    "running": False,
    "again": False,
    "started": None,
    "finished": None,
    "total": 0,
    "scanned": 0,
    "changed": 0,
    "model": 0,
    "family": 0,
    "tag": 0,
    "heuristic": 0,
    "error": None,
}


def _relabel_json() -> dict:
    with _relabel_lock:
        return {k: v for k, v in _relabel_job.items() if k != "again"}


def _spawn(fn, *args):
    """Where the re-application's thread is started (a seam: the tests drive the
    worker synchronously, like every other job here)."""
    threading.Thread(target=fn, args=args, name="genre-relabel", daemon=True).start()


def start_relabel(app) -> bool:
    """Re-decide the library under the head active now. A run already going is
    told to start over once it is through (a newer head just arrived), rather
    than two runs racing over the same rows."""
    with _relabel_lock:
        if _relabel_job["running"]:
            _relabel_job["again"] = True
            return False
        _relabel_job.update(
            running=True, again=False, started=now().isoformat(), finished=None,
            total=0, scanned=0, changed=0, model=0, family=0, tag=0, heuristic=0,
            error=None,
        )
    _spawn(_run_relabel, app)
    return True


def _run_relabel(app):
    from ..db import close_connection, open_connection
    from ..deezer import analysis as ana
    from ..deezer import genre as gen
    from ..deezer.workload import renice

    renice(12)
    with app.app_context():
        try:
            open_connection(reuse=True)
            while True:
                gen.invalidate()
                head = gen.active_head()
                head_id = head["id"] if head else "none"

                def on_stats(stats):
                    with _relabel_lock:
                        _relabel_job.update(stats)

                def should_stop():
                    with _relabel_lock:
                        return _relabel_job["again"]

                stats = ana.reapply_head(on_stats=on_stats, should_stop=should_stop)
                with _relabel_lock:
                    again = _relabel_job["again"]
                    _relabel_job["again"] = False
                    _relabel_job.update(stats)
                if again:
                    continue
                ana.mark_relabeled(head_id)
                if stats.get("changed"):
                    # Devices keep verdicts and never re-ask one they have:
                    # this is what tells them the library's answers moved.
                    ana.bump_verdict_generation()
                break
        except Exception as exc:
            logger.warning("Re-applying the genre head crashed", exc_info=True)
            with _relabel_lock:
                _relabel_job["error"] = str(exc)
        finally:
            with _relabel_lock:
                _relabel_job["running"] = False
                _relabel_job["finished"] = now().isoformat()
            invalidate_predictions()
            try:
                close_connection()
            except Exception:
                pass


def relabel_if_stale(app):
    """On boot: if the library was never re-decided under the head active now
    (a run cut short by a restart, or a head stored by an older version), do it."""

    def start():
        import time

        time.sleep(RESUME_DELAY)
        with app.app_context():
            from ..db import close_connection, open_connection
            from ..deezer import analysis as ana
            from ..deezer import genre as gen

            try:
                open_connection(reuse=True)
                head = gen.active_head()
                want = str(head["id"]) if head else "none"
                done = ana.relabeled_head()
                # Never re-decided and no head: nothing to change.
                stale = done != want and not (done is None and want == "none")
            except Exception:
                logger.debug("Could not read the relabel mark", exc_info=True)
                return
            finally:
                try:
                    close_connection()
                except Exception:
                    pass
        if stale:
            logger.info("Re-applying the genre head to the library")
            start_relabel(app)

    threading.Thread(target=start, name="genre-relabel-resume", daemon=True).start()


@webapi.route("/genre/relabel", methods=["GET", "POST"])
@login_required
@admin_required
def genre_relabel():
    """The re-application's progress; POST starts one (the studio's button,
    for after tags were changed in bulk)."""
    if request.method == "POST":
        start_relabel(current_app._get_current_object())
    return jsonify(_relabel_json())


# -- what the model thinks of a track, remembered ----------------------------
# Running a trained head over one embedding is a few million multiply-adds in
# plain Python, and the vector it runs on is a file on a disk. On a library of
# any size, doing both for every scanned row on every request is what turned the
# studio's candidate list into a minute of waiting. Neither answer changes until
# the model or the labels do, so neither is paid twice.
_pred_lock = threading.Lock()
_pred_state = {"key": None, "rows": {}}


def _prediction_cache(gen, label_count: int) -> dict:
    """The per-track opinion cache for the CURRENT model, cleared when it moves."""
    head = gen.active_head()
    key = (
        head.get("version") if head else None,
        head.get("kind") if head else None,
        len(head.get("labels") or ()) if head else 0,
        label_count,  # the prototypes move with every new label
    )
    with _pred_lock:
        if _pred_state["key"] != key:
            _pred_state["key"] = key
            _pred_state["rows"] = {}
        return _pred_state["rows"]


def invalidate_predictions() -> None:
    """Forget every cached opinion (a fresh extraction changed the vectors)."""
    with _pred_lock:
        _pred_state["key"] = None
        _pred_state["rows"] = {}


def _candidate_row(track, emb, gen, cache):
    """One candidate row, or None when the track has no vector to judge it by."""
    hit = cache.get(track.id)
    if isinstance(hit, float):  # a remembered miss
        if time.monotonic() - hit < CANDIDATE_MISS_TTL:
            return None
        hit = None
    if hit is None:
        vec = emb.load_embedding(track)
        if vec is None:
            if len(cache) < _PRED_CACHE_MAX:
                cache[track.id] = time.monotonic()
            return None
        # The head is only one of two opinions once labels exist. The prototype
        # needs no training, so it is the only one with something to say while a
        # genre is still one or two examples old — see deezer/genre.py.
        extra = _extras(track, _served_bpm(track)) if gen.reads_extras() else None
        hit = (gen.predict(vec, extra), gen.prototype_predict(vec))
        if len(cache) < _PRED_CACHE_MAX:
            cache[track.id] = hit
    guess, proto = hit
    row = _track_json(track, guess)
    if proto:
        row["prototype"] = {"label": proto[0], "similarity": proto[1]}
    # top1 − top2 already says how decided the head is. With no head nothing is
    # "decided", so everything is equally worth a look and the play count is
    # free to break the tie.
    margin = (guess[3] if len(guess) > 3 else 1.0) if guess else 0.0
    row["uncertainty"] = round(max(0.0, 1.0 - margin), 4)
    return row


def _served_bpm(track):
    """The served tempo the candidate scan JOINED onto the row (``served``),
    None when the track has no verdict yet."""
    served = getattr(track, "served", None)
    return served.bpm if served is not None else None


def _extras(track, bpm):
    """The track's served tempo and construction summary, as the head reads
    them next to the embedding (deezer/construction.py)."""
    from ..deezer import construction as cx

    return cx.raw_extras(bpm, cx.load(track))


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

    from peewee import fn

    head = gen.active_head()
    labelled = TrackTag.select().count()
    # ONE grouped query, not one per tag. The studio seeds fifty-odd genres on
    # its first visit, so the old loop opened fifty round trips before the page
    # could paint anything — and it grew every time somebody added a genre.
    counts = {t.name: 0 for t in GenreTag.select(GenreTag.name)}
    grouped = (
        TrackTag.select(GenreTag.name, fn.COUNT(TrackTag.track).alias("n"))
        .join(GenreTag)
        .group_by(GenreTag.name)
    )
    for row in grouped:
        counts[row.tag.name] = row.n
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
            # Snapshot, not a spread of the live dict: the ledger inside
            # it is a container the worker threads keep appending to.
            from .analysis import _job_snapshot

            return jsonify({"ok": True, **_job_snapshot(_embed_job)})
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
            failures=[],
            failure_reasons={},
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
        _redecide(track)
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
    _redecide(track)
    return jsonify({"track": str(track.id), "tag": _tag_json(tag)})


def _redecide(track):
    """The track's stored verdict, decided again now its tag changed. A tag
    REMOVED used to leave the row naming the tag's genre with the source "tag"
    — served as a choice somebody made, by nobody, for ever."""
    from ..db import TrackAnalysis
    from ..deezer import analysis as ana

    try:
        row = TrackAnalysis.get_or_none(TrackAnalysis.track == track)
        if row is not None:
            ana.redecide(row)
    except Exception:
        logger.debug("genre: could not re-decide %s", track.id, exc_info=True)


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
    deadline = time.monotonic() + CANDIDATE_BUDGET
    out_of_time = False
    cache = _prediction_cache(gen, len(labelled))
    query = (
        # Artist and album are JOINED, not walked. Reading `track.artist.name`
        # off a bare Track row is a second SELECT, and `track.album.name` a
        # third, so a four-thousand-row scan opened eight thousand round trips
        # before it had looked at a single vector.
        Track.select(Track, Artist, Album, TrackAnalysis.bpm)
        .join(Artist, on=(Track.artist == Artist.id))
        .switch(Track)
        .join(Album, on=(Track.album == Album.id))
        # The served tempo, for a head that reads it next to the vector.
        .switch(Track)
        .join(
            TrackAnalysis,
            JOIN.LEFT_OUTER,
            on=(TrackAnalysis.track == Track.id),
            attr="served",
        )
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
        row = _candidate_row(track, emb, gen, cache)
        if row is None:
            continue
        rows.append(row)
        # In play-count order the answer IS the first `limit` rows, so there is
        # nothing to gain from looking at the other three thousand — and a great
        # deal to lose: reading a sidecar off a spinning disk and running the
        # head over it in plain Python is milliseconds each, which is how this
        # endpoint came to take a minute.
        if not by_uncertainty and len(rows) >= limit:
            break
        # The uncertainty order genuinely needs a pool, so it gets a CLOCK
        # instead of a row count. A ranking over the two thousand rows we could
        # afford is a good ranking; a page that never arrives is not.
        if time.monotonic() > deadline:
            out_of_time = True
            break

    truncated = len(rows) > limit or out_of_time
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
    """Everything tagged so far, newest first: the studio's training set.

    ALL of it. This was capped at the 500 most recent tags, so a studio past
    that trained on a silently truncated set — the older tags, often the ones
    that took the most care, simply stopped counting. And every row lazily read
    its artist and its album back (two statements a row); they are joined now,
    so the whole set is one statement whatever its size.

    ``artist_id`` is what the trainer's artist folds group by: two tracks off
    one album must be held out together, or the held-out score measures
    recognising the album.
    """
    out = []
    query = (
        TrackTag.select(TrackTag, Track, GenreTag, Artist, Album)
        .join(Track)
        .join(Artist, on=(Track.artist == Artist.id))
        .switch(Track)
        .join(Album, on=(Track.album == Album.id))
        .switch(TrackTag)
        .join(GenreTag)
        .order_by(TrackTag.created.desc())
    )
    for tt in query:
        row = _track_json(tt.track)
        row["artist_id"] = str(tt.track.artist_id) if tt.track.artist_id else None
        row["tag"] = _tag_json(tt.tag)
        out.append(row)
    return jsonify({"labelled": out})


# -- a whole album, playlist or artist at once --------------------------------------
#
# Tagging one track at a time is right for the tracks that need a decision and
# tedious for the ones that do not: a Frenchcore album is Frenchcore from its
# first track to its last, nearly always. "Nearly" is the part that matters —
# the intro, the collab with a hardstyle producer, the ballad at the end of a
# metal record — and a bulk tag that silently labels those too teaches the head
# exactly the confusion it is meant to learn out of. So a bulk tag is two
# steps: a PREVIEW that says, for every track in scope, what it already wears
# and what the model thinks, with the disagreements unticked; then the tag is
# applied to the tracks the admin kept.

#: How many tracks one bulk request may name (an artist's whole library, a
#: long playlist). Beyond that it is not a review anybody will read.
BULK_MAX = 1000
#: The model's opinion is a vector read and a head evaluation per track; past
#: this much time the rest of the preview goes out without one.
BULK_PREVIEW_BUDGET = 3.0
_IN_CHUNK = 400


def _bulk_tracks(data):
    """The Track rows a bulk request names, in its order, and how many of the
    ids it named are not in the library. ``tracks``: ids as the SPA holds them
    (a Deezer numeric id or a local UUID); ``artist``: every library row whose
    main artist that is (a Deezer id or the local UUID)."""
    from ..deezer import ids as dz_ids

    if data.get("artist") not in (None, ""):
        ident = str(data["artist"])
        if _valid_id(ident):
            cond = Artist.deezer_id == ident
        else:
            try:
                cond = Artist.id == UUID(ident)
            except (ValueError, AttributeError, TypeError):
                return [], 0
        rows = list(
            Track.select(Track, Artist, Album)
            .join(Artist, on=(Track.artist == Artist.id))
            .switch(Track)
            .join(Album, on=(Track.album == Album.id))
            .where(cond)
            .order_by(Album.name, Track.disc, Track.number)
            .limit(BULK_MAX)
        )
        return rows, 0
    raw = data.get("tracks")
    if not isinstance(raw, list):
        raise ValueError("tracks must be a list")
    wanted = []
    for x in list(dict.fromkeys(str(v) for v in raw))[:BULK_MAX]:
        try:
            wanted.append(dz_ids.track_uuid(x) if _valid_id(x) else UUID(x))
        except (ValueError, AttributeError, TypeError):
            continue
    found = {}
    for i in range(0, len(wanted), _IN_CHUNK):
        part = wanted[i : i + _IN_CHUNK]
        for t in (
            Track.select(Track, Artist, Album)
            .join(Artist, on=(Track.artist == Artist.id))
            .switch(Track)
            .join(Album, on=(Track.album == Album.id))
            .where(Track.id.in_(part))
        ):
            found[t.id] = t
    rows = [found[u] for u in wanted if u in found]
    missing = len(dict.fromkeys(str(v) for v in raw)) - len(rows)
    return rows, max(0, missing)


def _bulk_tag(data):
    raw = data.get("tag")
    if raw in (None, ""):
        return None
    try:
        tag = GenreTag.get_or_none(GenreTag.id == int(raw))
    except (TypeError, ValueError):
        tag = None
    return tag or GenreTag.get_or_none(GenreTag.name == str(raw))


def _current_tags(rows):
    out = {}
    ids = [t.id for t in rows]
    for i in range(0, len(ids), _IN_CHUNK):
        for tt in (
            TrackTag.select(TrackTag, GenreTag)
            .join(GenreTag)
            .where(TrackTag.track.in_(ids[i : i + _IN_CHUNK]))
        ):
            out[tt.track_id] = tt.tag
    return out


def _served_bpms(rows):
    out = {}
    ids = [t.id for t in rows]
    for i in range(0, len(ids), _IN_CHUNK):
        for row in TrackAnalysis.select(TrackAnalysis.track, TrackAnalysis.bpm).where(
            TrackAnalysis.track.in_(ids[i : i + _IN_CHUNK])
        ):
            out[row.track_id] = row.bpm
    return out


@webapi.route("/genre/bulk/preview", methods=["POST"])
@login_required
@admin_required
def genre_bulk_preview():
    """What tagging these tracks would do, track by track, before it does it.

    Each row says whether the track already wears a tag (another one is a
    disagreement: applying would overwrite a decision somebody made) and what
    the head thinks. The head's opinion is a DISAGREEMENT only when it is past
    the gate the analysis acts on and the head knows the tag being applied —
    a head that never learnt Hardtekk is confidently something else on every
    Hardtekk track, and flagging all of them would bury the ones that matter.
    Where the head and the tag are siblings (rawstyle / rawphase) and the head
    is sure only of the family, the family is compared.
    """
    from ..deezer import analysis as ana
    from ..deezer import embedding as emb
    from ..deezer import genre as gen

    data = request.get_json(silent=True) or {}
    tag = _bulk_tag(data)
    if tag is None:
        return jsonify({"error": "unknown tag"}), 404
    try:
        rows, missing = _bulk_tracks(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    current = _current_tags(rows)
    head = gen.active_head()
    knows = bool(head) and tag.name in head["labels"]
    family = (head or {}).get("families", {}).get(tag.name) if head else None
    bpms = _served_bpms(rows) if head and head.get("inputs") else {}
    deadline = time.monotonic() + BULK_PREVIEW_BUDGET
    out = []
    counts = {"tracks": len(rows), "missing": missing, "same": 0, "other_tag": 0,
              "model": 0, "no_vector": 0, "unjudged": 0}
    for t in rows:
        row = _track_json(t)
        have = current.get(t.id)
        row["current"] = have.name if have else None
        reason = None
        if have is not None and have.id == tag.id:
            counts["same"] += 1
            row["same"] = True
        elif have is not None:
            reason = "tag"
        opinion = None
        if head is not None:
            if time.monotonic() > deadline:
                counts["unjudged"] += 1
            else:
                vec = emb.load_embedding(t)
                if vec is None:
                    counts["no_vector"] += 1
                else:
                    extra = _extras(t, bpms.get(t.id)) if head.get("inputs") else None
                    opinion = gen.decide(vec, ana.MODEL_MIN_CONFIDENCE, ana.MODEL_MIN_MARGIN, extra)
        if opinion:
            row["model"] = {"label": opinion["style"], "conf": opinion["conf"],
                            "level": opinion.get("level") or "label"}
            if knows and reason is None:
                if row["model"]["level"] == "family":
                    differs = not family or opinion["style"] != family
                else:
                    differs = opinion["style"] != tag.name
                if differs:
                    reason = "model"
        if reason:
            counts["other_tag" if reason == "tag" else "model"] += 1
        row["disagree"] = reason
        out.append(row)
    return jsonify({"tag": _tag_json(tag), "tracks": out, "counts": counts,
                    "model": {"active": bool(head), "knows": knows}})


@webapi.route("/genre/bulk", methods=["POST"])
@login_required
@admin_required
def genre_bulk():
    """Tag the tracks the admin kept after the preview. One tag per track, as
    everywhere: a track wearing another tag is re-tagged only when it is listed
    (the preview leaves those unticked). The verdicts are re-decided on a
    worker — hundreds of rows through the head is not a request's work — and
    the devices told once it is done."""
    from ..db import db

    data = request.get_json(silent=True) or {}
    tag = _bulk_tag(data)
    if tag is None:
        return jsonify({"error": "unknown tag"}), 404
    if data.get("artist") not in (None, ""):
        # Applying is always to an explicit list: what was reviewed is what is
        # tagged, never "whatever the artist's rows are by now".
        return jsonify({"error": "tracks must be listed"}), 400
    try:
        rows, missing = _bulk_tracks(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    ids = [t.id for t in rows]
    with db.atomic():
        for i in range(0, len(ids), _IN_CHUNK):
            TrackTag.delete().where(TrackTag.track.in_(ids[i : i + _IN_CHUNK])).execute()
        if ids:
            TrackTag.insert_many(
                [{"track": i, "tag": tag.id, "created": now()} for i in ids]
            ).execute()
    _forget_centroids()
    invalidate_predictions()
    if ids:
        _spawn(_run_redecide, current_app._get_current_object(), ids)
    return jsonify({"tag": _tag_json(tag), "applied": len(ids), "missing": missing})


def _run_redecide(app, ids):
    """Re-decide the verdicts of tracks whose tag just changed, then tell the
    devices (the generation) if any moved."""
    from ..db import close_connection, open_connection
    from ..deezer import analysis as ana

    with app.app_context():
        try:
            open_connection(reuse=True)
            changed = 0
            for i in range(0, len(ids), _IN_CHUNK):
                for row in TrackAnalysis.select(TrackAnalysis, Track).join(Track).where(
                    TrackAnalysis.track.in_(ids[i : i + _IN_CHUNK])
                ):
                    # A tag decides the verdict by itself: no vector to read.
                    changed += bool(ana.redecide(row, vec=None))
            if changed:
                ana.bump_verdict_generation()
        except Exception:
            logger.warning("genre: re-deciding a bulk tag failed", exc_info=True)
        finally:
            try:
                close_connection()
            except Exception:
                pass


# -- well-known recordings per genre (deezer/references.py) ------------------------

#: A genre's lookups, kept a day: the catalogue does not move faster than that,
#: and the list is a handful of searches per genre.
REFERENCE_TTL = 24 * 3600.0
_ref_cache: dict = {}
_ref_lock = threading.Lock()


def _reference_lookup(dzapi, genre):
    """[(artist, title, hit or None)], [artist hits], complete?"""
    from ..deezer import references as refs

    complete = True
    tracks = []
    for artist, title in refs.REFERENCES.get(genre, ()):
        try:
            found = (dzapi.advanced_search(artist=refs.first_artist(artist), track=title, limit=10) or {}).get("data") or []
            hit = refs.match(artist, title, found)
        except Exception:
            logger.info("genre: reference lookup failed for %s - %s", artist, title, exc_info=True)
            hit, complete = None, False
        tracks.append((artist, title, hit))
    artists = []
    for name in refs.SCENE_ARTISTS.get(genre, ()):
        try:
            found = (dzapi.search_artist(name, limit=5) or {}).get("data") or []
        except Exception:
            found, complete = [], False
        # The name itself, not the nearest one: "Sefa" must not become "Sefano".
        same = [a for a in found if isinstance(a, dict) and refs.fold(a.get("name")) == refs.fold(name)]
        artists.append((name, same[0] if same else None))
    return tracks, artists, complete


@webapi.route("/genre/references")
@login_required
@admin_required
def genre_references():
    """A genre's well-known recordings, each looked up on Deezer now — or,
    without ``genre``, which genres have a list at all.

    A reference is offered only when Deezer's own catalogue has THAT artist and
    THAT title (references.match); one it does not carry is listed as not found
    rather than swapped for whatever the search returned. With Deezer out of
    reach the list still comes back, unchecked (``offline``), and is not cached.
    """
    from ..deezer import references as refs
    from . import _artist_api, _dz_api, _track_api

    genre = str(request.args.get("genre") or "")
    if not genre:
        return jsonify({"genres": refs.genres_with_references()})
    if genre not in refs.REFERENCES and genre not in refs.SCENE_ARTISTS:
        return jsonify({"genre": genre, "tracks": [], "artists": [], "listed": False})
    now_t = time.monotonic()
    with _ref_lock:
        hit = _ref_cache.get(genre)
    if hit and now_t - hit[0] < REFERENCE_TTL:
        tracks, artists, complete = hit[1]
    else:
        dzapi = _dz_api()
        if dzapi is None:
            tracks = [(a, t, None) for a, t in refs.REFERENCES.get(genre, ())]
            artists = [(n, None) for n in refs.SCENE_ARTISTS.get(genre, ())]
            complete = False
        else:
            tracks, artists, complete = _reference_lookup(dzapi, genre)
            if complete:
                with _ref_lock:
                    _ref_cache[genre] = (now_t, (tracks, artists, complete))
    # Which of them this library already has, and what they wear.
    ids = [str(h["id"]) for _a, _t, h in tracks if h]
    have = {}
    if ids:
        from ..deezer import ids as dz_ids

        uuids = [dz_ids.track_uuid(i) for i in ids]
        rows = list(Track.select(Track.id, Track.deezer_id).where(Track.id.in_(uuids)))
        tags = _current_tags(rows)
        for t in rows:
            tag = tags.get(t.id)
            have[str(t.deezer_id)] = tag.name if tag else ""
    out = []
    for artist, title, h in tracks:
        row = {"artist": artist, "title": title, "match": _track_api(h) if h else None}
        if h and str(h["id"]) in have:
            row["in_library"] = True
            row["tag"] = have[str(h["id"])] or None
        out.append(row)
    return jsonify({
        "genre": genre,
        "listed": True,
        "offline": not complete,
        "tracks": out,
        "artists": [{"name": n, "match": _artist_api(a) if a else None} for n, a in artists],
    })


@webapi.route("/genre/references/import", methods=["POST"])
@login_required
@admin_required
def genre_reference_import():
    """Bring one reference into the library and tag it: the Track row is made
    from Deezer's own record, the tag applied, and the audio queued for the
    archive — where it gets the vector that makes it a training example."""
    from ..deezer import library
    from ..deezer.workload import Priority
    from . import _dz_live, _ensure_track_row

    data = request.get_json(silent=True) or {}
    did = str(data.get("deezer_id") or "")
    if not _valid_id(did):
        return jsonify({"error": "a Deezer track id is required"}), 400
    tag = _bulk_tag(data)
    if tag is None:
        return jsonify({"error": "unknown tag"}), 404
    track = _resolve(did)
    if track is None:
        provider = _dz_live()
        if provider is None:
            return jsonify({"error": "Deezer is out of reach"}), 503
        try:
            root = library.get_root_folder(provider.archive_dir)
            track = _ensure_track_row(provider, did, root, library.ImportCache())
        except Exception:
            logger.warning("genre: could not import reference %s", did, exc_info=True)
            return jsonify({"error": "the track could not be imported"}), 502
    TrackTag.delete().where(TrackTag.track == track).execute()
    TrackTag.create(track=track, tag=tag)
    _forget_centroids()
    _redecide(track)
    queued = False
    pf = getattr(current_app, "deezer_prefetch", None)
    if pf is not None and not track.last_modification:
        queued = bool(pf.download_ids([did], priority=Priority.USER))
    return jsonify({"track": _track_json(track), "tag": _tag_json(tag), "queued": queued})


@webapi.route("/genre/construction")
@login_required
@admin_required
def genre_construction():
    """Which tagged tracks carry a construction summary (deezer/construction.py),
    and which do not — with their served tempo, which the studio's measurer
    seeds the analyser with, as the player does."""
    import os

    from ..deezer import construction as cx

    # One statement: the tags, their tracks and the served tempo, joined.
    tagged = list(
        TrackTag.select(TrackTag, Track, TrackAnalysis.bpm)
        .join(Track)
        .join(
            TrackAnalysis,
            JOIN.LEFT_OUTER,
            on=(TrackAnalysis.track == Track.id),
            attr="served",
        )
    )
    measured = 0
    missing = []
    for tt in tagged:
        t = tt.track
        if not t.path or not os.path.isfile(t.path):
            continue
        p = cx.sidecar_path(t)
        if p and os.path.isfile(p):
            measured += 1
        else:
            missing.append({"id": t.deezer_id or str(t.id), "bpm": _served_bpm(t)})
    return jsonify({"labelled": len(tagged), "measured": measured, "missing": missing})


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
    from ..deezer import construction as cx
    from ..deezer import embedding as emb

    data = request.get_json(silent=True) or {}
    raw = data.get("ids") or []
    if not isinstance(raw, list):
        return jsonify({"error": "ids must be a list"}), 400
    out = {}
    tracks = {}
    stale = 0
    for ident in list(dict.fromkeys(str(x) for x in raw))[:EMBED_BATCH_MAX]:
        track = _resolve(ident)
        if track is None:
            continue
        vec = emb.load_embedding(track)
        if vec is None:
            continue
        # v3 and v2 are both served, each at its own width: the studio trains
        # on one width (a v3 row's prefix IS its v2 vector). A v1 row lives in
        # another space and is counted, not served.
        if len(vec) not in emb.HEAD_DIMS:
            stale += 1
            continue
        out[ident] = emb.encode_embedding(vec)
        tracks[ident] = track
    # What the head can read next to each vector: the served tempo (one query
    # for the batch) and the construction summary the player measured.
    bpms = {}
    if tracks:
        for row in TrackAnalysis.select(TrackAnalysis.track, TrackAnalysis.bpm).where(
            TrackAnalysis.track.in_([t.id for t in tracks.values()])
        ):
            bpms[row.track_id] = row.bpm
    extras = {}
    for ident, track in tracks.items():
        summary = cx.load(track)
        extras[ident] = {
            "bpm": bpms.get(track.id),
            "live": summary["features"] if summary else None,
        }
    return jsonify({"embeddings": out, "dim": emb.EMBED_DIM, "stale": stale, "extras": extras})


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
        # Every verdict the head gave goes back to the rules, now.
        start_relabel(current_app._get_current_object())
        return jsonify({"deleted": True, "relabel": _relabel_json()})

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
    gen.invalidate()
    # Refuse to keep a head that cannot be read back: a model stored but
    # unusable would silently do nothing for ever. Checked BEFORE the previous
    # head is retired — the other order left a refused upload with no model at
    # all, the working one switched off on the way to finding out.
    head = gen.active_head()
    problem = None
    if head is None or head["id"] != row.id:
        problem = "weights do not match the labels and dim given"
    elif isinstance(data.get("metrics"), dict) and "inputs" in data["metrics"] and not head["inputs"]:
        # A head over the embedding AND extras whose description does not add up
        # would be read as a head over a wider embedding nobody has: never used.
        problem = "the inputs described do not add up to the head's width"
    if problem:
        row.delete_instance()
        gen.invalidate()
        return jsonify({"error": problem}), 400
    GenreModel.update(active=False).where(GenreModel.id != row.id).execute()
    gen.invalidate()
    # The new head reaches the whole library from what is already measured.
    start_relabel(current_app._get_current_object())
    return jsonify({"stored": True, "version": row.version, "relabel": _relabel_json()})

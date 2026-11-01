# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The background explorer: finds music for genres the library lacks.

A radio can only play what the server has, so a radio set to "adventure" runs out
of new ground. The explorer widens the ground, quietly:

1. it picks a genre THE ENGINE KNOWS (``analysis.known_genres()`` — one it could
   not later recognise would be a track nobody can verify), weighted towards the
   neighbours of what the listener plays and towards genres the library has little of;
2. it looks that name up on Deezer (playlists named after it first, then a plain
   search) and samples a few tracks at random;
3. for each it fetches the 30-second preview, runs the SAME analysis the library
   gets (``analysis.analyze_file``) and keeps the track only if the engine
   hears the genre it was looking for (tree distance to the target ≤ ``ACCEPT_DIST``
   and a confident verdict). Everything else is recorded as rejected so it is
   never fetched twice;
4. the keepers become ``Discovery`` rows. NOTHING IS ARCHIVED: a discovered track
   joins the library through the ordinary path — played, liked, added to a
   playlist — unless the operator ticked "archive everything found".

It runs behind the same gate as the library maintenance (``workload.Throttle``):
never while anybody is listening or the box is loaded, one preview at a time,
a pause between Deezer calls. Deezer being unreachable is a reason to stop, never
a verdict about the data.
"""

from __future__ import annotations

import json
import logging
import math
import os
import random
import tempfile
import threading
import time
from urllib.parse import urlsplit

from .. import genretree

logger = logging.getLogger(__name__)

SETTINGS_KEY = "explorer"
DEFAULTS = {"enabled": True, "archive": False, "pool": 60}
POOL_MAX = 400

#: The engine must hear the target genre, or one next to it in the tree.
ACCEPT_DIST = 0.1  # tree distance: the same genre, or its direct parent / child
#: …with at least this much confidence.
ACCEPT_CONF = 0.4
#: A batch: this many genres, this many previews from each.
TARGETS_PER_BATCH = 2
PREVIEWS_PER_TARGET = 3
#: Seconds between two Deezer calls inside a batch.
CALL_PAUSE = 1.5
#: How often the loop wakes, and the quiet it needs first.
LOOP_EVERY = 600
QUIET_FOR = 300.0

_busy = threading.Lock()
_thread = None
_state = {"running": False, "last": None, "last_error": None, "found": 0, "rejected": 0,
          "paused": None}


# -- settings ---------------------------------------------------------------


def settings() -> dict:
    from ..db import Meta

    out = dict(DEFAULTS)
    row = Meta.get_or_none(Meta.key == SETTINGS_KEY)
    if row is not None:
        try:
            saved = json.loads(row.value)
            if isinstance(saved, dict):
                out.update({k: saved[k] for k in DEFAULTS if k in saved})
        except (TypeError, ValueError):
            pass
    return out


def clean_settings(data) -> dict:
    data = data if isinstance(data, dict) else {}
    try:
        pool = max(10, min(POOL_MAX, int(data.get("pool", DEFAULTS["pool"]))))
    except (TypeError, ValueError):
        pool = DEFAULTS["pool"]
    return {"enabled": bool(data.get("enabled", True)),
            "archive": bool(data.get("archive", False)), "pool": pool}


def save_settings(data) -> dict:
    from ..db import Meta

    clean = clean_settings(data)
    row = Meta.get_or_none(Meta.key == SETTINGS_KEY)
    if row is None:
        Meta.create(key=SETTINGS_KEY, value=json.dumps(clean))
    else:
        row.value = json.dumps(clean)
        row.save()
    return clean


def status() -> dict:
    from ..db import Discovery

    return {
        **settings(),
        **{k: _state[k] for k in ("running", "last", "last_error", "paused")},
        "pool_now": Discovery.select().where(Discovery.state == "new").count(),
        "rejected_total": Discovery.select().where(Discovery.state == "rejected").count(),
    }


# -- choosing what to look for ----------------------------------------------


def _node(style):
    """The tree node a stored style stands for (a family id, a label, a tag), or None."""
    from .analysis import FAMILY_LABEL

    tree = genretree.get()
    return tree.node(style) or tree.node(FAMILY_LABEL.get(style, style))


def _library_profile():
    """``(taste, have)``: per tree node, how much the library is played in it
    and how many tracks it holds."""
    from peewee import fn

    from ..db import Track, TrackAnalysis

    taste, have = {}, {}
    q = (
        TrackAnalysis.select(
            TrackAnalysis.style, fn.COUNT(TrackAnalysis.track), fn.SUM(Track.play_count)
        )
        .join(Track, on=(TrackAnalysis.track == Track.id))
        .where(TrackAnalysis.style.is_null(False) & (TrackAnalysis.style_confidence >= 0.3))
        .group_by(TrackAnalysis.style)
        .tuples()
    )
    for style, n, plays in q:
        node = _node(style)
        if node:
            have[node] = have.get(node, 0) + n
            taste[node] = taste.get(node, 0.0) + n + 2.0 * (plays or 0)
    return taste, have


def target_weights(taste, have, vocabulary):
    """Weight of each engine genre as a place to explore.

    High for genres CLOSE to what the listener plays (a graph neighbour of a
    loved genre is a genre they may love) and for ones the library barely has;
    near zero for the far and for the well stocked. An empty library has no
    taste to follow, so every genre is equally worth a look."""
    total = sum(taste.values())
    tree = genretree.get()
    out = {}
    for g in vocabulary:
        node = tree.node(g)
        if node is None:
            continue
        if total <= 0:
            near = 1.0
        else:
            near = max(
                (taste[t] / total) * (1.0 - genretree.distance(t, node)) for t in taste
            )
            near = max(near, 0.0) ** 0.5  # a flat profile should still reach past its top genre
        out[node] = near / (1.0 + 0.35 * have.get(node, 0))
    return out


def pick_targets(n, rng, weights=None):
    if weights is None:
        from . import analysis as ana

        taste, have = _library_profile()
        weights = target_weights(taste, have, [l for l, _a in ana.known_genres()])
    pool = [(g, w) for g, w in weights.items() if w > 0]
    out = []
    while pool and len(out) < n:
        total = sum(w for _g, w in pool)
        r, acc = rng.random() * total, 0.0
        for i, (g, w) in enumerate(pool):
            acc += w
            if r <= acc:
                out.append(g)
                pool.pop(i)
                break
    return out


# -- looking on Deezer ------------------------------------------------------


def _known_ids(ids):
    from ..db import Discovery, Track

    ids = [str(i) for i in ids]
    have = set()
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        have.update(str(r[0]) for r in Track.select(Track.deezer_id)
                    .where(Track.deezer_id.in_(chunk)).tuples())
        have.update(r[0] for r in Discovery.select(Discovery.deezer_id)
                    .where(Discovery.deezer_id.in_(chunk)).tuples())
    return have


def find_tracks(api, label, rng, want, pause=time.sleep):
    """Up to ``want`` unseen public-API track dicts that carry a preview, found
    by looking the genre's name up: playlists called that first (curated, so far
    less noisy than a text search), then the plain search."""
    found, seen = [], set()

    def take(tracks):
        fresh = [t for t in tracks if isinstance(t, dict) and t.get("id") and t.get("preview")
                 and str(t["id"]) not in seen]
        for t in fresh:
            seen.add(str(t["id"]))
        known = _known_ids(t["id"] for t in fresh)
        fresh = [t for t in fresh if str(t["id"]) not in known]
        rng.shuffle(fresh)
        found.extend(fresh[: max(0, want - len(found))])

    try:
        res = api.search_playlist(label, limit=12)
        lists = [p for p in (res or {}).get("data", []) if p.get("id") and (p.get("nb_tracks") or 0) >= 10]
        rng.shuffle(lists)
        for p in lists[:2]:
            pause(CALL_PAUSE)
            tr = api.get_playlist_tracks(p["id"], limit=100)
            take((tr or {}).get("data", []))
            if len(found) >= want:
                return found
        if len(found) < want:
            pause(CALL_PAUSE)
            res = api.search(label, limit=50, index=rng.choice((0, 0, 50)))
            take((res or {}).get("data", []))
    except Exception:
        logger.debug("explorer: Deezer lookup failed for %s", label, exc_info=True)
        raise
    return found[:want]


def fetch_preview(provider, url, dest) -> bool:
    """A Deezer preview (https on Deezer's CDN only, size-capped: automatch's
    own fetch) to ``dest``; False when it could not be had — never a verdict."""
    from . import automatch

    try:
        automatch.fetch_preview(provider, url, dest)
        return os.path.getsize(dest) > 10_000
    except Exception:
        logger.debug("explorer: preview fetch failed", exc_info=True)
        return False


def verify(target, result):
    """``(accepted, node, confidence)`` for an ``analyze_file`` result."""
    v = result["verdict"]
    node = _node(v.get("style"))
    conf = float(v.get("conf") or 0.0)
    if not node:
        return False, None, conf
    ok = conf >= ACCEPT_CONF and genretree.distance(node, target) <= ACCEPT_DIST
    return ok, node, conf


# -- one batch --------------------------------------------------------------


def _record(track, target, state, style, conf, bpm, payload):
    from ..db import Discovery, now

    try:
        Discovery.create(
            deezer_id=str(track["id"])[:20], state=state, target=target[:48],
            style=(style or None) and style[:48], confidence=conf or 0.0, bpm=bpm,
            found=now(), payload=json.dumps(payload) if payload else None,
        )
    except Exception:  # a duplicate from a racing batch is not a failure
        logger.debug("explorer: could not record %s", track.get("id"), exc_info=True)
    _forget_pool()


def info_of(t):
    """What the Flow needs to offer a public-API track (the shape of a catalogue
    candidate: ``webui.discover._catalog_track``)."""
    alb = t.get("album") or {}
    art = t.get("artist") or {}
    return {
        "title": str(t.get("title") or t.get("title_short") or "")[:200],
        "artist": str(art.get("name") or "")[:200],
        "artist_ref": str(art.get("id") or ""),
        "album_ref": str(alb.get("id") or ""),
        "album": str(alb.get("title") or "")[:200],
        "cover": alb.get("cover_medium") or alb.get("cover_big") or alb.get("cover"),
        "duration": int(t.get("duration") or 0),
    }


def explore_once(provider, throttle, *, rng=None, targets=TARGETS_PER_BATCH,
                 per_target=PREVIEWS_PER_TARGET, to_payload=info_of, archive=None,
                 analyze=None, fetch=None, pause=time.sleep):
    """One batch; returns ``{"found", "rejected", "targets"}``. ``throttle`` is a
    ``workload.Throttle`` (``wait()`` False ends the batch). The callables are
    seams for the tests."""
    from . import analysis as ana

    rng = rng or random.Random()
    api = provider.dz.api
    analyze = analyze or ana.analyze_file
    fetch = fetch or (lambda url, dest: fetch_preview(provider, url, dest))
    stats = {"found": 0, "rejected": 0, "targets": []}
    for target in pick_targets(targets, rng):
        if not throttle.wait():
            break
        stats["targets"].append(target)
        tracks = find_tracks(api, target, rng, per_target, pause=pause)
        for t in tracks:
            if not throttle.wait():
                return stats
            t0 = time.monotonic()
            fd, tmp = tempfile.mkstemp(suffix=".mp3", prefix="ns-preview-")
            os.close(fd)
            try:
                if not fetch(t.get("preview"), tmp):
                    continue  # unreachable is not a verdict: try again another day
                try:
                    res = analyze(tmp)
                except Exception:
                    logger.debug("explorer: analysis failed for %s", t.get("id"), exc_info=True)
                    continue
                ok, lab, conf = verify(target, res)
                payload = to_payload(t) if (ok and to_payload) else None
                _record(t, target, "new" if ok else "rejected", lab, conf, res.get("bpm"), payload)
                stats["found" if ok else "rejected"] += 1
                if ok and archive:
                    archive(str(t["id"]))
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            throttle.spent(time.monotonic() - t0)
            pause(CALL_PAUSE)
    return stats


# -- consuming the pool -----------------------------------------------------


_pool_cache = (0.0, [])
POOL_TTL = 60.0


def pool_rows(limit=300):
    """``[(deezer_id, style, info dict)]`` of the verified finds nobody has taken
    into the library yet, newest first: what the Flow may offer. Kept a minute:
    the Flow asks on every pick and the pool moves a few titles an hour."""
    global _pool_cache
    at, kept = _pool_cache
    if time.monotonic() - at < POOL_TTL:
        return kept
    rows = _pool_rows(limit)
    _pool_cache = (time.monotonic(), rows)
    return rows


def _forget_pool():
    global _pool_cache
    _pool_cache = (0.0, [])


def _pool_rows(limit):
    from ..db import Discovery, Track

    rows = (
        Discovery.select()
        .where((Discovery.state == "new") & Discovery.style.is_null(False))
        .order_by(Discovery.id.desc())
        .limit(limit)
    )
    out = []
    for r in rows:
        try:
            info = json.loads(r.payload) if r.payload else None
        except ValueError:
            info = None
        if isinstance(info, dict) and info.get("title"):
            out.append((r.deezer_id, r.style, info))
    if not out:
        return []
    ids = [o[0] for o in out]
    owned = {str(x[0]) for x in Track.select(Track.deezer_id).where(Track.deezer_id.in_(ids)).tuples()}
    return [o for o in out if o[0] not in owned]


def prune(keep_rejected=5000, keep_new=POOL_MAX * 2):
    """Forget the oldest rows beyond the bounds, and the discoveries that have
    since joined the library (their Track row is the record now)."""
    from ..db import Discovery, Track

    owned = [r[0] for r in Discovery.select(Discovery.deezer_id)
             .join(Track, on=(Discovery.deezer_id == Track.deezer_id)).tuples()]
    for start in range(0, len(owned), 400):
        Discovery.delete().where(Discovery.deezer_id.in_(owned[start:start + 400])).execute()
    for state, cap in (("rejected", keep_rejected), ("new", keep_new)):
        extra = Discovery.select(Discovery.id).where(Discovery.state == state) \
            .order_by(Discovery.id.desc()).offset(cap).tuples()
        ids = [r[0] for r in extra]
        for start in range(0, len(ids), 400):
            Discovery.delete().where(Discovery.id.in_(ids[start:start + 400])).execute()


# -- the loop ---------------------------------------------------------------


def run_batch(app, stop=lambda: False):
    """One gated batch under the app context; never raises. False when it did
    not run (already running, nothing to do, or a reason to stand down)."""
    from ..db import Discovery, close_connection, open_connection
    from . import workload

    if not _busy.acquire(blocking=False):
        return False
    _state["running"] = True
    try:
        with app.app_context():
            open_connection(reuse=True)
            try:
                cfg = settings()
                provider = getattr(app, "deezer", None)
                if not cfg["enabled"] or provider is None:
                    return False
                if Discovery.select().where(Discovery.state == "new").count() >= cfg["pool"]:
                    return False
                probe = getattr(provider, "available", None)
                if probe is not None and not probe():
                    return False
                throttle = workload.Throttle(
                    duty=0.5, listen_quiet=QUIET_FOR, max_load=0.5, stop=stop
                )
                workload.renice(15)
                archive = None
                if cfg["archive"] and getattr(app, "deezer_prefetch", None):
                    archive = lambda i: app.deezer_prefetch.download_ids(  # noqa: E731
                        [i], priority=workload.Priority.BULK)
                st = explore_once(provider, throttle, archive=archive)
                _state["found"] += st["found"]
                _state["rejected"] += st["rejected"]
                _state["last"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                _state["last_error"] = None
                _state["paused"] = throttle.reason
                prune()
                return True
            finally:
                close_connection()
    except Exception as exc:
        _state["last_error"] = str(exc)[:200]
        logger.info("explorer: batch stopped: %s", exc)
        return False
    finally:
        _state["running"] = False
        _busy.release()


def start(app):
    """Wake every ``LOOP_EVERY`` seconds; run a batch if the pool is short and
    nobody has listened for ``QUIET_FOR`` seconds. Once per process, never
    under test."""
    global _thread
    if app.testing or _thread is not None:
        return None
    from . import workload

    def go():
        time.sleep(120)
        while True:
            try:
                if workload.listening_for() >= QUIET_FOR and not workload.foreground_busy() \
                        and workload.load_per_core() <= 0.5:
                    run_batch(app)
            except Exception:
                logger.debug("explorer loop error", exc_info=True)
            time.sleep(LOOP_EVERY)

    _thread = threading.Thread(target=go, name="deezer-explorer", daemon=True)
    _thread.start()
    return _thread

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The tracks that sound closest to each other, kept so a radio is one read.

Every archived track carries a vector (``deezer/embedding.py``). Comparing a
track with the whole library takes a few milliseconds of arithmetic, which is
nothing to a background worker and far too much for a click, so the answer is
computed when a vector arrives (or all at once by ``rebuild_all``) and kept in
``track_neighbor``: the 50 closest titles of each, best first, indexed on
``(track, rank)``. A radio, the flow and the "similar" shelf only read that.

The similarity is the cosine of the two vectors' shared part, adjusted by what
the server measured about each track:

* x1 when the served tempos agree to 6 % (or to an octave), x0.8 when they
  do not (no tempo known on either side: x1, there is nothing to hold against);
* x1.1 when both carry the same served genre.

A track with no vector has no neighbours stored; ``fallback_ids`` answers for
it from what the database knows (the same artist, then the same genre, by play
count), so the radio never starts from nothing.

Nothing here calls the network, and nothing here is required for the app to
run: no numpy means a slower pure-Python comparison on the first half of the
vector, and no vectors at all means the fallback.
"""

import logging
import queue
import threading
import time
import uuid as _uuid

from .db import (
    Meta, Track, TrackAnalysis, TrackNeighbor, close_connection, db, now,
    open_connection,
)

logger = logging.getLogger(__name__)

#: Neighbours kept per track.
KEEP = 50
#: Cursor of the full rebuild in ``Meta`` (32 characters at most).
CURSOR_KEY = "similar_cursor"
#: Served tempos within this share of each other (or of an octave) agree.
TEMPO_TOLERANCE = 0.06
TEMPO_MISMATCH = 0.8
GENRE_BONUS = 1.1
#: A track played less long ago than this is not offered by a radio again.
RECENT_PLAY = 20 * 60
#: How long the in-memory vectors are worth keeping once nobody asked.
INDEX_TTL = 120
#: The pure-Python comparison reads this many numbers of a vector.
PREFIX = 1280

try:  # numpy comes with the extractor and is not required
    import numpy as np
except Exception:  # pragma: no cover - exercised by the fallback tests
    np = None


def _archived():
    """Peewee expression: the row is on disk and playable."""
    return (Track.last_modification > 0) & Track.unavailable.is_null(True)


# -- the vectors in memory ------------------------------------------------------


def tempo_weight(a, b):
    """x1 when ``a`` and ``b`` (beats a minute) agree to 6 % or to an octave,
    x0.8 when both are known and do not, x1 when either is unknown."""
    if not a or not b or a <= 0 or b <= 0:
        return 1.0
    ratio = a / b
    for octave in (1.0, 2.0, 0.5):
        if abs(ratio / octave - 1.0) <= TEMPO_TOLERANCE:
            return 1.0
    return TEMPO_MISMATCH


def pair_weight(bpm_a, style_a, bpm_b, style_b):
    w = tempo_weight(bpm_a, bpm_b)
    if style_a and style_a == style_b:
        w *= GENRE_BONUS
    return w


class _Index:
    """Every archived track's normalised vector, plus its served tempo and
    genre. Built in one pass; rows are appended as vectors arrive."""

    def __init__(self):
        self.ids = []  # UUIDs, row order
        self.pos = {}
        self.bpm = []
        self.style = []
        self._rows = []  # normalised vectors, not yet in ``mat``
        self.mat = None  # numpy (N, D) float32 once built
        self.built_at = time.monotonic()
        self.used_at = self.built_at

    def __len__(self):
        return len(self.ids)

    def _norm(self, vec):
        from .deezer import embedding as emb

        common = emb.common_part(vec)
        if common is None:
            return None
        if np is not None:
            v = np.asarray(common, dtype=np.float32)
            n = float(np.linalg.norm(v))
            return v / n if n > 0 else None
        v = common[:PREFIX]
        n = sum(x * x for x in v) ** 0.5
        return [x / n for x in v] if n > 0 else None

    def add(self, track_id, vec, bpm, style):
        v = self._norm(vec)
        if v is None:
            return False
        if track_id in self.pos:
            i = self.pos[track_id]
            self.bpm[i], self.style[i] = bpm, style
            self._set(i, v)
            return True
        self.pos[track_id] = len(self.ids)
        self.ids.append(track_id)
        self.bpm.append(bpm)
        self.style.append(style)
        self._rows.append(v)
        return True

    def _set(self, i, v):
        self._flush()
        if np is not None:
            self.mat[i] = v
        else:
            self._rows[i] = v

    def _flush(self):
        """Fold the rows added since the last call into the matrix."""
        if np is None or not self._rows:
            return
        block = np.vstack(self._rows)
        self.mat = block if self.mat is None else np.vstack([self.mat, block])
        self._rows = []

    def scores(self, vec):
        """The cosine of every stored vector against ``vec`` (as the extractor
        makes it), in row order, the vector's own row included."""
        q = self._norm(vec)
        if q is None or not self.ids:
            return []
        self.used_at = time.monotonic()
        if np is not None:
            self._flush()
            sims = self.mat @ q
            return sims
        return [sum(a * b for a, b in zip(r, q)) for r in self._rows]


_index = None
_index_lock = threading.RLock()


def _build_index():
    from .deezer import embedding as emb

    index = _Index()
    served = {
        str(r[0]): (r[1], r[2])
        for r in TrackAnalysis.select(
            TrackAnalysis.track, TrackAnalysis.bpm, TrackAnalysis.style
        ).tuples()
    }
    after = None
    while True:
        q = Track.select().where(_archived() & Track.path.is_null(False))
        if after is not None:
            q = q.where(Track.id > after)
        rows = list(q.order_by(Track.id).limit(500))
        if not rows:
            break
        for t in rows:
            vec = emb.load_embedding(t)
            if vec is None:
                continue
            bpm, style = served.get(str(t.id), (None, None))
            index.add(t.id, vec, bpm, style)
        after = rows[-1].id
    index._flush()
    return index


def get_index():
    """The shared index, built on first use and dropped when it sits idle."""
    global _index
    with _index_lock:
        if _index is not None and time.monotonic() - _index.used_at > INDEX_TTL:
            _index = None
        if _index is None:
            _index = _build_index()
        _index.used_at = time.monotonic()
        return _index


def drop_index():
    global _index
    with _index_lock:
        _index = None


def _top(index, row, vec_scores, keep=KEEP):
    """The ``keep`` best ``(row, score)`` for the vector stored at ``row``,
    weighted, the vector itself left out."""
    me_bpm, me_style = index.bpm[row], index.style[row]
    if np is not None:
        sims = np.asarray(vec_scores, dtype=np.float32).copy()
        sims[row] = -2.0
        # Weight first (tempo and genre are per-pair), then take the best.
        w = np.ones(len(sims), dtype=np.float32)
        if me_bpm and me_bpm > 0:
            bpms = np.asarray(
                [b if b and b > 0 else 0.0 for b in index.bpm], dtype=np.float32
            )
            known = bpms > 0
            ratio = np.where(known, bpms / me_bpm, 1.0)
            ok = ~known
            for octave in (1.0, 2.0, 0.5):
                ok |= np.abs(ratio / octave - 1.0) <= TEMPO_TOLERANCE
            w = np.where(ok, w, np.float32(TEMPO_MISMATCH))
        if me_style:
            same = np.asarray([s == me_style for s in index.style])
            w = np.where(same, w * np.float32(GENRE_BONUS), w)
        sims = np.where(sims > 0, sims * w, sims)
        n = min(keep, len(sims) - 1)
        if n <= 0:
            return []
        idx = np.argpartition(-sims, n - 1)[:n]
        idx = idx[np.argsort(-sims[idx])]
        return [(int(i), float(sims[i])) for i in idx if sims[i] > 0]
    out = []
    for i, s in enumerate(vec_scores):
        if i == row or s <= 0:
            continue
        out.append((i, s * pair_weight(me_bpm, me_style, index.bpm[i], index.style[i])))
    out.sort(key=lambda p: -p[1])
    return out[:keep]


# -- writing the neighbours -----------------------------------------------------


def _put(track_id, pairs):
    """Replace ``track_id``'s neighbour list with ``pairs`` (``[(id, score)]``,
    best first)."""
    rows = [
        {"track": track_id, "neighbor": n, "score": s, "rank": r}
        for r, (n, s) in enumerate(pairs)
    ]
    with db.atomic():
        TrackNeighbor.delete().where(TrackNeighbor.track == track_id).execute()
        for i in range(0, len(rows), 100):
            TrackNeighbor.insert_many(rows[i : i + 100]).execute()


def _offer(neighbor_id, track_id, score):
    """Let ``track_id`` into ``neighbor_id``'s list if it earns a place."""
    current = [
        (r[0], r[1])
        for r in TrackNeighbor.select(TrackNeighbor.neighbor, TrackNeighbor.score)
        .where(TrackNeighbor.track == neighbor_id)
        .order_by(TrackNeighbor.rank)
        .tuples()
    ]
    if any(n == track_id for n, _ in current):
        merged = [(n, s) for n, s in current if n != track_id]
    else:
        merged = current
    if len(merged) >= KEEP and score <= merged[-1][1]:
        return
    merged.append((track_id, score))
    merged.sort(key=lambda p: -p[1])
    _put(neighbor_id, merged[:KEEP])


def rebuild_for(track, *, symmetric=True, index=None):
    """Compute and store ``track``'s neighbours. With ``symmetric`` the tracks
    it landed next to are offered a place in their own lists too, which is what
    makes a track that arrives late appear in its neighbours' radios. Returns
    the number of neighbours stored (0 for a track with no vector)."""
    from .deezer import embedding as emb

    index = index or get_index()
    vec = emb.load_embedding(track)
    if vec is None:
        return 0
    row = index.pos.get(track.id)
    if row is None:
        if not index.add(track.id, vec, *_served(track.id)):
            return 0
        row = index.pos[track.id]
    scores = index.scores(vec)
    top = _top(index, row, scores)
    pairs = [(index.ids[i], s) for i, s in top]
    _put(track.id, pairs)
    if symmetric:
        for n, s in pairs:
            _offer(n, track.id, s)
    return len(pairs)


def _served(track_id):
    r = (
        TrackAnalysis.select(TrackAnalysis.bpm, TrackAnalysis.style)
        .where(TrackAnalysis.track == track_id)
        .tuples()
        .first()
    )
    return (r[0], r[1]) if r else (None, None)


# -- a vector arrives: recompute that track, behind everything else ---------------

_queue = queue.Queue(maxsize=512)
_worker = None
_worker_lock = threading.Lock()


def _under_test():
    try:
        from flask import current_app, has_app_context

        return bool(has_app_context() and current_app.testing)
    except Exception:
        return False


def queue_track(track_id):
    """Recompute ``track_id``'s neighbours on a bulk worker. Never blocks and
    never raises; a full queue drops the request (the full rebuild is the
    safety net)."""
    if _under_test():
        return False
    try:
        _queue.put_nowait(track_id)
    except queue.Full:
        return False
    _ensure_worker()
    return True


def _ensure_worker():
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_drain, name="similar", daemon=True)
        _worker.start()


def _drain():
    from .deezer.workload import quiet_wait, renice

    renice(12)
    while True:
        try:
            tid = _queue.get(timeout=30)
        except queue.Empty:
            drop_index()
            return
        try:
            open_connection(reuse=True)
            quiet_wait(1.0)
            track = Track.get_or_none(Track.id == tid)
            if track is not None:
                rebuild_for(track)
        except Exception:
            logger.warning("similar: could not recompute %s", tid, exc_info=True)
        finally:
            try:
                close_connection()
            except Exception:
                pass


# -- the whole library --------------------------------------------------------------


def rebuild_job(force=False):
    """A ``libjob.LibraryJob`` that recomputes every archived track's neighbours
    from one index built when it starts. Resumable like the other library jobs."""
    from .libjob import LibraryJob

    state = {"index": None}

    def work(track):
        if state["index"] is None:
            state["index"] = get_index()
        # A track with no vector simply has no neighbours: not a failure.
        rebuild_for(track, symmetric=False, index=state["index"])
        return None

    job = LibraryJob(
        "similar", Track.select().where(_archived()), work,
        cursor_key=CURSOR_KEY, force=force,
    )
    return job


def run_rebuild(app, job):
    with app.app_context():
        try:
            open_connection(reuse=True)
            drop_index()
            job.run()
        finally:
            drop_index()
            try:
                close_connection()
            except Exception:
                pass
    Meta.delete().where(Meta.key == "similar_at").execute()
    Meta.create(key="similar_at", value=now().isoformat())


# -- reading ------------------------------------------------------------------


def _recent_cutoff():
    import datetime

    return now() - datetime.timedelta(seconds=RECENT_PLAY)


def playable(query, exclude=()):
    """``query`` (a Track select) narrowed to what a radio may offer: on disk,
    not recently played, not excluded, and visible to the caller."""
    from .webui import _visible_tracks

    q = query.where(
        _archived() & (Track.last_play.is_null(True) | (Track.last_play < _recent_cutoff()))
    )
    if exclude:
        q = q.where(Track.id.not_in(list(exclude)))
    return _visible_tracks(q)


def neighbor_query(track_id, exclude=(), base=None):
    """Tracks next to ``track_id`` as ONE query, best first (``base`` is the
    Track query to start from: the caller selects the columns it needs)."""
    base = base if base is not None else Track.select()
    q = base.join(TrackNeighbor, on=(TrackNeighbor.neighbor == Track.id)).where(
        TrackNeighbor.track == track_id
    )
    return playable(q, exclude).order_by(TrackNeighbor.rank)


def neighbors(track_id, limit=40, exclude=()):
    """The ids of the tracks that sound closest to ``track_id``, best first."""
    q = neighbor_query(track_id, exclude, Track.select(Track.id)).limit(limit)
    return [r[0] for r in q.tuples()]


def fallback_ids(track, limit=40, exclude=()):
    """What the database knows when there are no neighbours: the same artist,
    then the same served genre, most played first."""
    taken = set(exclude) | {track.id}
    out = []
    q = playable(
        Track.select(Track.id).where(Track.artist == track.artist_id), taken
    ).order_by(Track.play_count.desc(), Track.id).limit(limit)
    out += [r[0] for r in q.tuples()]
    if len(out) < limit:
        style = _served(track.id)[1]
        if style:
            more = playable(
                Track.select(Track.id)
                .join(TrackAnalysis, on=(TrackAnalysis.track == Track.id))
                .where(TrackAnalysis.style == style),
                taken | set(out),
            ).order_by(Track.play_count.desc(), Track.id).limit(limit - len(out))
            out += [r[0] for r in more.tuples()]
    return out


def radio(seed_ids, limit=40, exclude=()):
    """A queue of track ids from one or several seeds: the neighbours of each,
    the closer to the seeds' consensus the earlier. Without seeds (or without
    anything stored for them) the library's most played titles stand in."""
    seeds = [s for s in seed_ids]
    taken = set(exclude) | set(seeds)
    scored = {}
    if seeds:
        for nid, score in (
            TrackNeighbor.select(TrackNeighbor.neighbor, TrackNeighbor.score)
            .where(TrackNeighbor.track.in_(seeds))
            .tuples()
        ):
            if nid in taken:
                continue
            scored[nid] = scored.get(nid, 0.0) + score
    ranked = [n for n, _ in sorted(scored.items(), key=lambda p: -p[1])]
    out = []
    if ranked:
        # Over-ask, then keep what the caller may play (on disk, visible, unplayed lately).
        ok = {
            r[0]
            for r in playable(
                Track.select(Track.id).where(Track.id.in_(ranked[: limit * 3])), ()
            ).tuples()
        }
        out = [n for n in ranked[: limit * 3] if n in ok][:limit]
    if len(out) < limit and seeds:
        seed = Track.get_or_none(Track.id == seeds[0])
        if seed is not None:
            out += [
                i for i in fallback_ids(seed, limit - len(out), taken | set(out))
            ]
    if len(out) < limit:
        more = playable(Track.select(Track.id), taken | set(out)).order_by(
            Track.play_count.desc(), Track.id
        ).limit(limit - len(out))
        out += [r[0] for r in more.tuples()]
    return out[:limit]


def artist_neighbors(artist_id, limit=10):
    """``[(artist id, score)]`` of the artists whose tracks sit closest to this
    artist's own, best first."""
    T = Track
    mine = [
        r[0]
        for r in T.select(T.id)
        .where(T.artist == artist_id)
        .order_by(T.play_count.desc())
        .limit(20)
        .tuples()
    ]
    if not mine:
        return []
    scores = {}
    q = (
        TrackNeighbor.select(T.artist, TrackNeighbor.score)
        .join(T, on=(TrackNeighbor.neighbor == T.id))
        .where(TrackNeighbor.track.in_(mine) & (T.artist != artist_id))
        .tuples()
    )
    for aid, s in q:
        scores[aid] = scores.get(aid, 0.0) + s
    return sorted(scores.items(), key=lambda p: -p[1])[:limit]


def status():
    """Counts for the studio: how many tracks have neighbours stored."""
    stored = TrackNeighbor.select(TrackNeighbor.track).distinct().count()
    at = Meta.get_or_none(Meta.key == "similar_at")
    return {"tracks": stored, "at": at.value if at else None}

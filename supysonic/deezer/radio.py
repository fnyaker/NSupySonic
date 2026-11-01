# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Radios built from what the library KNOWS about each track: its genre, its
tempo, its artist — and what the listener does with them.

The caller names a style (one genre or several, any level of the tree) and a
discovery level. The style is expanded through ``genregraph`` into weights over
genres; the listener's own history (stars, plays, recency) decides WHICH tracks
of those genres come up; the discovery level decides how far from the style the
queue is allowed to wander and how much it prefers music not yet heard. A
dose of seeded randomness keeps two radios on the same style from being the same
queue — the old ones were near-identical because everything was a sort.

Pure scoring is separated from the database read so it can be tested without one.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field

from . import genregraph

#: Tracks of the same artist are kept at least this far apart in a queue.
ARTIST_GAP = 4
#: A track played within this many seconds is strongly damped.
RECENT_SECONDS = 2 * 24 * 3600
#: Share of the queue that is drawn from OUTSIDE the style's core at discovery 1.
MAX_REACH_SHARE = 0.6
#: How many rows the scorer will consider (the pool is sampled down, never sorted whole).
POOL_MAX = 6000


@dataclass
class Cand:
    id: object
    artist: object
    genre: str  # a graph label
    plays: int = 0
    last_play: float | None = None  # epoch seconds
    starred: bool = False
    bpm: float | None = None
    weight: float = 0.0  # genre weight from the expansion
    score: float = 0.0
    why: dict = field(default_factory=dict)


def style_label(raw) -> str | None:
    """A stored style (a family id like "frenchcore", a label, or a tag name) as
    the graph's label for it, or None."""
    if not raw:
        return None
    lab = genregraph.label(raw)
    if lab:
        return lab
    from . import analysis as ana

    for fid, label, _arch, _fn in ana.FAMILIES:
        if fid == raw:
            return genregraph.label(label)
    return None


def raw_spellings(labels):
    """Every string a stored ``TrackAnalysis.style`` may hold for these labels:
    the label itself and the family id when it has one."""
    from . import analysis as ana

    want = set(labels)
    out = set(want)
    for fid, label, _arch, _fn in ana.FAMILIES:
        if genregraph.label(label) in want:
            out.add(fid)
    return out


def bpm_fit(bpm, lo, hi):
    """1.0 inside [lo, hi], falling off over a third of the window each side.
    Unknown tempo is not penalised (a track nobody measured is not a bad fit)."""
    if bpm is None or lo is None or hi is None:
        return 1.0
    if lo <= bpm <= hi:
        return 1.0
    span = max(8.0, (hi - lo) / 3.0)
    d = (lo - bpm) if bpm < lo else (bpm - hi)
    return max(0.05, math.exp(-(d / span) ** 2))


def taste(c: Cand, artist_affinity: float, discovery: float, now: float) -> float:
    """What the listener's history says about one candidate, >= 0.

    The history's pull shrinks as the discovery dial rises (a high dial is "stop
    giving me my usual"), unheard tracks gain from it, and anything played in
    the last two days is damped whatever the dial says — a radio that opens on
    the song you just heard is broken at any setting."""
    pull = 1.0 + 0.6 * math.log1p(c.plays) + 2.0 * c.starred + 0.8 * min(1.5, artist_affinity)
    pull = pull ** (1.0 - 0.7 * discovery)
    if c.plays == 0:
        pull *= 1.0 + 1.5 * discovery
    if c.last_play is not None and now - c.last_play < RECENT_SECONDS:
        pull *= 0.2
    return pull


def score(cands, *, discovery, bpm_window=None, artist_affinity=None, now=None):
    """Fill in ``score`` (and ``why``) on every candidate."""
    now = time.time() if now is None else now
    lo, hi = bpm_window if bpm_window else (None, None)
    artist_affinity = artist_affinity or {}
    for c in cands:
        t = taste(c, artist_affinity.get(c.artist, 0.0), discovery, now)
        f = bpm_fit(c.bpm, lo, hi)
        c.score = (c.weight ** 1.5) * t * f
        c.why = {"genre": round(c.weight, 2), "taste": round(t, 2), "bpm": round(f, 2)}
    return cands


def _keys(cands, randomness, rng):
    """Efraimidis-Spirakis style keys: log(score) + randomness * Gumbel noise.
    randomness 0 is a plain ranking; the larger it is, the more any track with
    a decent score can come up. Sampling WITHOUT replacement, top-k by key."""
    out = []
    for c in cands:
        if c.score <= 0:
            continue
        g = -math.log(-math.log(max(1e-12, rng.random())))
        out.append((math.log(c.score) + randomness * g, c))
    out.sort(key=lambda kc: kc[0], reverse=True)
    return [c for _k, c in out]


def _spaced(ordered, count, gap):
    """Take ``count`` from ``ordered`` keeping an artist out of the last ``gap``
    picks; what had to be deferred comes back in once nothing else fits."""
    picked, deferred, recent = [], [], []
    for c in ordered:
        if len(picked) >= count:
            break
        if c.artist in recent[-gap:]:
            deferred.append(c)
            continue
        picked.append(c)
        recent.append(c.artist)
    for c in deferred:
        if len(picked) >= count:
            break
        picked.append(c)
    return picked


def pick(cands, count, *, discovery, randomness=0.5, rng=None, gap=ARTIST_GAP):
    """The queue: ``count`` tracks, a core of the style and, rising with the
    discovery dial, a share from its neighbouring genres."""
    rng = rng or random.Random()
    discovery = min(1.0, max(0.0, discovery))
    core = [c for c in cands if c.weight >= 0.9]
    reach = [c for c in cands if c.weight < 0.9]
    n_reach = min(len(reach), int(round(count * discovery * MAX_REACH_SHARE)))
    n_core = min(len(core), count - n_reach)
    n_reach = min(len(reach), count - n_core)  # a thin core hands its slots over
    a = _spaced(_keys(core, randomness, rng), n_core, gap)
    b = _spaced(_keys(reach, randomness, rng), n_reach, gap)
    # Interleave: reach tracks land at random positions, never first.
    out = list(a)
    for c in b:
        out.insert(rng.randint(1 if out else 0, len(out)), c)
    return _spaced(out, len(out), gap)


def build(user, seeds, *, discovery=0.3, count=50, randomness=0.5, bpm_window=None,
          rng=None, exclude=()):
    """Queue for ``user``: a list of ``Cand`` (ids are ``Track.id``)."""
    from peewee import JOIN

    from ..db import GenreTag, StarredTrack, Track, TrackAnalysis, TrackTag

    weights = genregraph.expand(seeds, spread=discovery)
    if not weights:
        return []
    labels = list(weights)
    spell = raw_spellings(labels)
    now = time.time()

    rows = (
        Track.select(
            Track.id, Track.artist, Track.play_count, Track.last_play,
            TrackAnalysis.style, TrackAnalysis.style_confidence, TrackAnalysis.bpm,
        )
        .join(TrackAnalysis, on=(TrackAnalysis.track == Track.id))
        .where(Track.unavailable.is_null() & Track.last_modification.__gt__(0)
               & TrackAnalysis.style.in_(list(spell)) & (TrackAnalysis.style_confidence >= 0.3))
        .order_by(Track.id)
        .limit(POOL_MAX * 2)
        .tuples()
    )
    by_id = {}
    for tid, artist, plays, last, style, _conf, bpm in rows:
        lab = style_label(style)
        if lab in weights:
            by_id[tid] = Cand(tid, artist, lab, plays or 0,
                              last.timestamp() if last else None, False, bpm, weights[lab])
    # A hand tag outranks any measurement.
    tagged = (
        TrackTag.select(TrackTag.track, GenreTag.name, Track.artist, Track.play_count,
                        Track.last_play, TrackAnalysis.bpm)
        .join(GenreTag).switch(TrackTag).join(Track)
        .join(TrackAnalysis, join_type=JOIN.LEFT_OUTER, on=(TrackAnalysis.track == Track.id))
        .where(Track.unavailable.is_null() & GenreTag.name.in_(labels))
        .tuples()
    )
    for tid, name, artist, plays, last, bpm in tagged:
        lab = style_label(name)
        if lab in weights:
            by_id[tid] = Cand(tid, artist, lab, plays or 0,
                              last.timestamp() if last else None, False, bpm, weights[lab])
    if exclude:
        for e in exclude:
            by_id.pop(e, None)
    cands = list(by_id.values())
    if not cands:
        return []
    ids = [c.id for c in cands]
    starred = set()
    for i in range(0, len(ids), 500):
        starred.update(
            r[0] for r in StarredTrack.select(StarredTrack.starred)
            .where((StarredTrack.user == user.id) & StarredTrack.starred.in_(ids[i:i + 500])).tuples()
        )
    affinity = {}
    for c in cands:
        c.starred = c.id in starred
        if c.starred:
            affinity[c.artist] = affinity.get(c.artist, 0.0) + 0.5
    score(cands, discovery=discovery, bpm_window=bpm_window, artist_affinity=affinity, now=now)
    return pick(cands, count, discovery=discovery, randomness=randomness, rng=rng)


#: Share of a queue the explorer's finds may take at discovery 1.
DISCOVERY_SHARE = 0.35


def pick_discoveries(items, count, *, window=None, rng=None):
    """``count`` of the explorer's finds, ``items`` being what
    ``explorer.pool_candidates`` returns: ``(track dict, style, weight, bpm)``.
    Weighted like the library's candidates, one per artist."""
    rng = rng or random.Random()
    lo, hi = window if window else (None, None)
    keyed = []
    for payload, _style, weight, bpm in items:
        s = (weight ** 1.5) * bpm_fit(bpm, lo, hi)
        if s > 0:
            g = -math.log(-math.log(max(1e-12, rng.random())))
            keyed.append((math.log(s) + 0.5 * g, payload))
    keyed.sort(key=lambda kp: kp[0], reverse=True)
    out, artists = [], set()
    for _k, p in keyed:
        a = (p.get("artist") or {}).get("deezer_id")
        if a in artists:
            continue
        artists.add(a)
        out.append(dict(p, discovery=True))
        if len(out) >= count:
            break
    return out


def mix_discoveries(tracks, extra, rng=None):
    """Spread ``extra`` through ``tracks`` at random places, never first and not
    back to back while there is room to avoid it."""
    rng = rng or random.Random()
    out = list(tracks)
    taken = set()
    for item in extra:
        spots = [i for i in range(1, len(out) + 1) if i not in taken and (i - 1) not in taken]
        if not spots:
            spots = list(range(1, len(out) + 1)) or [0]
        i = rng.choice(spots)
        out.insert(i, item)
        taken = {t + 1 if t >= i else t for t in taken}
        taken.add(i)
    return out


# -- who the listener is, and "more like this" -------------------------------


def listener_profile(user, limit=400):
    """``{label: weight}`` of the genres this listener favours: their stars
    (3 each) and the library's play counts on the tracks they starred or that
    carry a hand tag they would have chosen. Cheap: one grouped query."""
    from peewee import JOIN, fn

    from ..db import StarredTrack, Track, TrackAnalysis

    out = {}
    q = (
        TrackAnalysis.select(TrackAnalysis.style, fn.COUNT(StarredTrack.starred),
                             fn.SUM(Track.play_count))
        .join(Track, on=(TrackAnalysis.track == Track.id))
        .join(StarredTrack, on=((StarredTrack.starred == Track.id) & (StarredTrack.user == user.id)),
              join_type=JOIN.LEFT_OUTER)
        .where(TrackAnalysis.style.is_null(False) & (TrackAnalysis.style_confidence >= 0.3))
        .group_by(TrackAnalysis.style)
        .tuples()
    )
    for style, stars, plays in q:
        lab = style_label(style)
        if lab:
            out[lab] = out.get(lab, 0.0) + 3.0 * (stars or 0) + math.log1p(plays or 0)
    top = sorted(out.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    return {k: v for k, v in top if v > 0}


def favourite_genres(profile, n=3, rng=None):
    """Up to ``n`` genres to build mixes on: weighted draws from the profile (so
    each visit differs), at most one per top-level family while there is
    another family to take."""
    rng = rng or random.Random()
    pool = dict(profile)
    chosen, families = [], set()
    while pool and len(chosen) < n:
        total = sum(pool.values())
        r, acc, pick = rng.random() * total, 0.0, None
        for g, w in pool.items():
            acc += w
            if r <= acc:
                pick = g
                break
        pick = pick or next(iter(pool))
        fam = genregraph.family_of(pick)
        pool.pop(pick)
        if fam in families and any(genregraph.family_of(g) not in families for g in pool):
            continue
        families.add(fam)
        chosen.append(pick)
    return chosen


def track_genre(deezer_id):
    """``(label, bpm, track_id)`` of a library track by Deezer id, or None."""
    from ..db import GenreTag, Track, TrackAnalysis, TrackTag

    t = Track.get_or_none(Track.deezer_id == str(deezer_id))
    if t is None:
        return None
    tag = (TrackTag.select(GenreTag.name).join(GenreTag).where(TrackTag.track == t.id).tuples().first())
    row = TrackAnalysis.get_or_none(TrackAnalysis.track == t.id)
    lab = style_label(tag[0]) if tag else (
        style_label(row.style) if row and (row.style_confidence or 0) >= 0.3 else None
    )
    if not lab:
        return None
    return lab, (row.bpm if row else None), t.id


def similar(user, deezer_id, count=30, rng=None, discovery=0.35):
    """Library tracks like one track: its genre, within ±8% of its tempo, other
    artists favoured by the spacing rule. [] when the track is not analysed."""
    info = track_genre(deezer_id)
    if not info:
        return []
    lab, bpm, tid = info
    window = (bpm * 0.92, bpm * 1.08) if bpm else None
    return build(user, [lab], discovery=discovery, count=count, randomness=0.6,
                 bpm_window=window, rng=rng, exclude=(tid,))

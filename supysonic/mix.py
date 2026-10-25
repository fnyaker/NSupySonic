# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Turning scored candidates into a SEQUENCE worth listening to.

The radios and the Flow used to sort their candidates and keep the top: the
same seed gave the same forty titles in the same order, and a prolific artist
took half of them. One assembler now serves them all, in three steps, each
taken from a published method (sources: docs in /mnt/project-files/algos/):

1. **Which titles: a draw proportional to the score** (Gumbel-top-k, Kool et
   al., ICML 2019): adding Gumbel noise to ``log(score) / temperature`` and
   keeping the largest is sampling without replacement with probability
   proportional to ``score ^ (1/temperature)``. Two radios from one seed
   differ, and a title twice as relevant stays twice as likely.
2. **In what order: maximal marginal relevance over a window** (Carbonell &
   Goldstein, SIGIR 1998), in its multiplicative form: each position takes
   ``argmax relevance * (1 - (1-lambda) * max similarity to the last WINDOW
   titles)``. A radio is heard as a sequence, so it is the neighbourhood of
   each title that must not repeat itself ("consecutive songs too similar" is
   the most common complaint about content-based playlists, Schedl et al.
   2018). Multiplied rather than subtracted, a title with no relevance left
   can never win on being different.
3. **Artist rules**: at most ``cap`` titles of one artist per list (3, as
   ListenBrainz's LB Radio blend) and never two within ``gap`` positions (LB
   Radio does not prevent that; artist diversity is the second criterion
   listeners rank a playlist on, Kamehkhosh et al. via Schedl et al.). Relaxed
   only when the library has nothing else to offer.
"""

import math

from .db import TrackNeighbor

LAMBDA = 0.5
WINDOW = 5
SAME_ALBUM = 0.8
SAME_STYLE = 0.3
#: A title k places back weighs FADE ** k in the similarity to the window.
FADE = 0.75


class Item:
    """A candidate: ``score`` > 0, ``artist`` / ``album`` / ``style`` for the
    rules (None when unknown), ``track`` the library id when it is one."""

    __slots__ = ("key", "score", "artist", "album", "style", "track", "payload", "_g")

    def __init__(self, key, score, artist=None, album=None, style=None, track=None, payload=None):
        self.key = key
        self.score = score
        self.artist = artist
        self.album = album
        self.style = style
        self.track = track
        self.payload = payload
        self._g = 0.0


def gumbel_order(items, rng, temperature=1.0):
    """``items`` in the order of a draw without replacement proportional to
    ``score ^ (1/temperature)``."""
    t = max(1e-3, float(temperature))
    for it in items:
        u = rng.random()
        u = min(max(u, 1e-12), 1.0 - 1e-12)
        it._g = math.log(max(it.score, 1e-12)) / t - math.log(-math.log(u))
    return sorted(items, key=lambda it: -it._g)


def neighbour_pairs(track_ids):
    """``{(a, b): score}`` of the stored sound neighbours among ``track_ids``
    (both directions), one statement."""
    ids = [t for t in track_ids if t is not None]
    if len(ids) < 2:
        return {}
    out = {}
    for a, b, s in (
        TrackNeighbor.select(TrackNeighbor.track, TrackNeighbor.neighbor, TrackNeighbor.score)
        .where(TrackNeighbor.track.in_(ids) & TrackNeighbor.neighbor.in_(ids))
        .tuples()
    ):
        s = max(0.0, min(1.0, float(s)))
        if s > out.get((a, b), 0.0):
            out[(a, b)] = out[(b, a)] = s
    return out


def similarity(a, b, pairs):
    s = 0.0
    if a.track is not None and b.track is not None:
        s = pairs.get((a.track, b.track), 0.0)
    if a.album is not None and a.album == b.album:
        s = max(s, SAME_ALBUM)
    if a.style is not None and a.style == b.style:
        s = max(s, SAME_STYLE)
    return s


def assemble(items, n, rng, temperature=0.8, cap=3, gap=3, lam=LAMBDA,
             window=WINDOW, pairs=None, fixed=(), caps=None, relax=True):
    """``n`` items as a sequence (see the module). ``fixed`` are items already
    placed before this list (the queue's tail): the rules count them. ``caps``
    gives some artists their own cap (an artist radio's own artist).
    ``relax`` False stops at twice the cap rather than lifting it.

    The draw decides WHICH titles (proportional to the score, under the artist
    cap); the order is then built so that each title repeats as little as
    possible of the last ones heard (MMR) and no artist comes back within
    ``gap`` — the best matches still early, ties broken by the draw."""
    if n <= 0 or not items:
        return []
    caps = caps or {}
    fixed = list(fixed)
    drawn = gumbel_order(list(items), rng, temperature)

    # 1. who: the draw, under the artist caps (relaxed only when short)
    counts = {}
    for it in fixed:
        if it.artist is not None:
            counts[it.artist] = counts.get(it.artist, 0) + 1
    chosen, taken = [], set()
    limits = [cap, cap * 2] + ([None] if relax else [])
    for limit in limits:
        for it in drawn:
            if len(chosen) >= n:
                break
            if id(it) in taken:
                continue
            a = it.artist
            if a is not None and limit is not None and counts.get(a, 0) >= max(limit, caps.get(a, 0)):
                continue
            taken.add(id(it))
            chosen.append(it)
            if a is not None:
                counts[a] = counts.get(a, 0) + 1
        if len(chosen) >= n:
            break

    # 2. in what order: relevance x (1 - (1-lambda) x similarity to the window)
    if pairs is None:
        pairs = neighbour_pairs([it.track for it in chosen] + [it.track for it in fixed[-window:]])
    top = max((it.score for it in chosen), default=1.0) or 1.0
    rank = {id(it): i for i, it in enumerate(chosen)}
    placed = fixed[-window:]
    recent = [it.artist for it in fixed[-gap:]] if gap > 0 else []
    left = list(chosen)
    out = []
    remaining = {}
    for it in left:
        if it.artist is not None:
            remaining[it.artist] = remaining.get(it.artist, 0) + 1
    while left:
        # An artist with r titles left needs (r-1)*(gap+1)+1 places to keep
        # them apart: when that is every place left, it goes now (the greedy
        # that spaces repeats when spacing them is still possible).
        critical = {a for a, r in remaining.items() if r > 1 and (r - 1) * (gap + 1) + 1 >= len(left)}
        best = None
        for g in range(gap, -1, -1):
            best_v = None
            for it in left:
                if g > 0 and it.artist is not None and it.artist in recent[-g:]:
                    continue
                if critical and g == gap and it.artist not in critical:
                    continue
                # the title just before counts most, each step back less
                sim = max(
                    (similarity(it, p, pairs) * FADE ** k for k, p in enumerate(reversed(placed))),
                    default=0.0,
                )
                v = (it.score / top) * (1.0 - (1.0 - lam) * sim)
                if best_v is None or v > best_v + 1e-12 or (
                    abs(v - best_v) <= 1e-12 and rank[id(it)] < rank[id(best)]
                ):
                    best_v, best = v, it
            if best is not None:
                break
        left.remove(best)
        if best.artist is not None:
            remaining[best.artist] -= 1
        out.append(best)
        placed = (placed + [best])[-window:]
        recent = (recent + [best.artist])[-max(gap, 1):]
    return out

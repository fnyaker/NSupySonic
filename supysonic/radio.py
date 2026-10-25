# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Track and artist radios that stay on their seed and still vary.

The radio used to be refilled from the LAST title of the queue: every refill
started from a neighbour of a neighbour, a random walk that drifted away from
what the person started from, and each answer was the same forty nearest
titles in the same order. Now (design and sources:
/mnt/project-files/algos/refonte-decouverte.md):

* **Anchored.** Every refill is asked with the ORIGINAL seed, plus the session
  (Pereira et al., RecSys 2019: similarity to the session's first title AND to
  its latest): the titles heard through are positive anchors whose total weight
  is held to ``SESSION_SHARE`` of the seed's, so the seed always outweighs the
  session; the skipped ones are NEGATIVE anchors, steering away from what made
  them rank (their skip is also what predicts the next one, Brost et al. 2019).
* **A wider pool.** The seed's stored neighbours, the neighbours of its best
  neighbours (two hops, damped), the same artist and the same genre, so there
  is something to vary between.
* **Personal, lightly.** The person's own affinity lifts an artist a little,
  their skips push a title or an artist down, a title they skipped twice and
  never heard through is not offered at all.
* **Assembled** by ``mix.assemble``: a draw proportional to the score, MMR over
  the last titles, at most three of one artist, never two within three.

Every read is the database; nothing calls the network.
"""

import datetime
import math
import random

from . import listening, mix
from .db import Track, TrackAnalysis, TrackNeighbor, now

#: The session's positive anchors weigh this share of the seed, together.
SESSION_SHARE = 0.6
#: How much each session title fades per step back.
SESSION_FADE = 0.8
#: Each skipped title of the session, and all of them at most.
SKIP_WEIGHT = -0.5
SKIP_TOTAL = -1.2
#: Two-hop neighbours: from this many best neighbours, damped by this.
HOP_FROM = 8
HOP_DAMP = 0.6
#: Scores of the database's own fallbacks (no stored neighbours).
SAME_ARTIST = 0.35
SAME_STYLE = 0.22
#: Candidates kept before the assembly reads their rows.
POOL = 500
#: A title heard less long ago than this is not offered again.
RECENT = 20 * 60
#: The draw is a softmax over the similarity at this temperature: titles
#: 0.04 apart in similarity are e (2.7) times apart in probability. Stored
#: similarities sit in a narrow band (0.6-0.95), which a draw proportional to
#: the raw score would flatten into a coin toss between the seed's sound and a
#: bridge into another one.
TEMPERATURE = 0.04


def _visible(query, user):
    if user is None or getattr(user, "admin", False):
        return query
    return query.where(Track.owner.is_null(True) | (Track.owner == user.id))


def _playable(query, user):
    cutoff = now() - datetime.timedelta(seconds=RECENT)
    return _visible(
        query.where(
            (Track.last_modification > 0)
            & Track.unavailable.is_null(True)
            & (Track.last_play.is_null(True) | (Track.last_play < cutoff))
        ),
        user,
    )


def anchors(seeds, recent=(), skipped=()):
    """``{track id: weight}``: the seeds share 1, the session at most
    ``SESSION_SHARE`` (newest first, fading), the skips are negative."""
    out = {}
    seeds = [s for s in seeds if s is not None]
    for s in seeds:
        out[s] = out.get(s, 0.0) + 1.0 / len(seeds)
    rec = [r for r in reversed(list(recent)) if r is not None and r not in out]
    if rec:
        raw = [SESSION_FADE ** i for i in range(len(rec))]
        total = sum(raw)
        for r, w in zip(rec, raw):
            out[r] = out.get(r, 0.0) + SESSION_SHARE * w / total
    skipped = [s for s in skipped if s is not None]
    if skipped:
        each = max(SKIP_WEIGHT, SKIP_TOTAL / len(skipped))
        for s in skipped:
            out[s] = out.get(s, 0.0) + each
    return out


def candidate_scores(weights, seeds):
    """``{track id: score}`` from the stored neighbours of every anchor (one
    statement) and the neighbours of the seeds' best neighbours (one more)."""
    scores = {}
    if not weights:
        return scores
    best_of_seed = []
    for a, nid, s, rank in (
        TrackNeighbor.select(TrackNeighbor.track, TrackNeighbor.neighbor,
                             TrackNeighbor.score, TrackNeighbor.rank)
        .where(TrackNeighbor.track.in_(list(weights)))
        .tuples()
    ):
        w = weights.get(a, 0.0)
        scores[nid] = scores.get(nid, 0.0) + w * float(s)
        if a in seeds and rank < HOP_FROM:
            best_of_seed.append((nid, float(s), weights[a]))
    if best_of_seed:
        via = {}
        for nid, s, w in best_of_seed:
            via[nid] = max(via.get(nid, 0.0), s * w)
        for a, nid, s in (
            TrackNeighbor.select(TrackNeighbor.track, TrackNeighbor.neighbor, TrackNeighbor.score)
            .where(TrackNeighbor.track.in_(list(via)))
            .tuples()
        ):
            hop = HOP_DAMP * via[a] * float(s)
            # Two hops only add what one hop did not find better, and never
            # undo a skip's push away.
            have = scores.get(nid)
            if have is None or 0.0 <= have < hop:
                scores[nid] = hop
    return scores


def _fallback(scores, seeds, user, rng):
    """The same artists and the same genres as the seeds, sampled, when the
    stored neighbours are thin (a track with no vector, a young library)."""
    seed_rows = list(
        Track.select(Track.id, Track.artist, TrackAnalysis.style)
        .join(TrackAnalysis, mix_left(), on=(TrackAnalysis.track == Track.id))
        .where(Track.id.in_(list(seeds)))
        .tuples()
    )
    artists = {a for _t, a, _s in seed_rows}
    styles = {s for _t, _a, s in seed_rows if s}
    if artists:
        rows = list(_playable(Track.select(Track.id).where(Track.artist.in_(list(artists))), user)
                    .limit(400).tuples())
        for (tid,) in rows:
            scores[tid] = max(scores.get(tid, 0.0), SAME_ARTIST * (0.8 + 0.4 * rng.random()))
    if styles:
        rows = list(
            _playable(
                Track.select(Track.id)
                .join(TrackAnalysis, on=(TrackAnalysis.track == Track.id))
                .where(TrackAnalysis.style.in_(list(styles))),
                user,
            ).order_by(random_order()).limit(400).tuples()
        )
        for (tid,) in rows:
            scores[tid] = max(scores.get(tid, 0.0), SAME_STYLE * (0.8 + 0.4 * rng.random()))


def mix_left():
    from peewee import JOIN

    return JOIN.LEFT_OUTER


def random_order():
    from .db import random as db_random

    return db_random()


def build(user, seeds, n=40, recent=(), skipped=(), exclude=(), rng=None,
          seed_artist=None, seed_artist_cap=8, own=(), block_seeds=True):
    """``n`` track ids for a radio of ``seeds`` (library ids), given what the
    session heard (``recent``), skipped and already queued (``exclude``).
    ``seed_artist`` (an artist radio) may fill up to ``seed_artist_cap``."""
    rng = rng or random.Random()  # nosec B311 - a draw for variety, not a secret
    seeds = [s for s in seeds if s is not None]
    skipped = [s for s in skipped if s is not None]
    weights = anchors(seeds, recent, skipped)
    scores = candidate_scores(weights, set(seeds))
    if own:  # an artist radio: the artist's own titles are in the pool, high
        level = max((v for v in scores.values()), default=SAME_ARTIST)
        for t in own:
            scores[t] = max(scores.get(t, 0.0), level - 0.02 - 0.04 * rng.random())
    if sum(1 for v in scores.values() if v > 0) < n * 2 and seeds:
        _fallback(scores, seeds, user, rng)
    hist = listening.history(user) if user is not None else listening.History()
    blocked = set(exclude) | set(skipped) | set(recent) | (set(seeds) if block_seeds else set())
    ranked = [
        (t, s) for t, s in sorted(scores.items(), key=lambda p: -p[1])
        if s > 0 and t not in blocked and not hist.rejected(t)
    ][:POOL]
    if not ranked:
        return []
    by_score = dict(ranked)
    rows = list(
        _playable(
            Track.select(Track.id, Track.artist, Track.album, TrackAnalysis.style)
            .join(TrackAnalysis, mix_left(), on=(TrackAnalysis.track == Track.id))
            .where(Track.id.in_(list(by_score))),
            user,
        ).tuples()
    )
    session_skipped_artists = set()
    if skipped:
        session_skipped_artists = {
            a for (a,) in Track.select(Track.artist).where(Track.id.in_(skipped)).tuples()
        }
    top_artist = max(hist.artist.values(), default=0.0) or 1.0
    best = max(by_score.values())
    items = []
    for tid, aid, alid, style in rows:
        # The weight is exp(similarity / T) relative to the best (a softmax),
        # then the person's affinity and skips as factors.
        w = math.exp((by_score[tid] - best) / TEMPERATURE)
        w *= 1.0 + 0.3 * min(1.0, hist.artist.get(aid, 0.0) / top_artist)
        w *= 1.0 - 0.8 * hist.skip_ratio(tid)
        w *= 1.0 - 0.5 * hist.artist_skip_ratio(aid)
        if aid in session_skipped_artists and aid != seed_artist:
            w *= 0.5
        items.append(mix.Item(tid, max(w, 1e-300), artist=aid, album=alid, style=style, track=tid))
    caps = {seed_artist: seed_artist_cap} if seed_artist is not None else None
    picked = mix.assemble(items, n, rng, temperature=1.0, caps=caps)
    return [it.track for it in picked]


def artist_seeds(user, artist_id, k=5):
    """An artist radio's seeds: the artist's titles this person hears most,
    then the most played."""
    own = list(
        _visible(
            Track.select(Track.id, Track.play_count)
            .where((Track.artist == artist_id) & (Track.last_modification > 0)
                   & Track.unavailable.is_null(True)),
            user,
        ).tuples()
    )
    if not own:
        return [], []
    hist = listening.history(user) if user is not None else listening.History()
    own.sort(key=lambda r: (-(hist.track.get(r[0], 0.0)), -(r[1] or 0), str(r[0])))
    return [r[0] for r in own[:k]], [r[0] for r in own]

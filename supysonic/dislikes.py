# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The titles a person does not want to hear, and what that says about the
titles that sound like them.

"Je n'aime pas" is a statement about RECOMMENDATIONS, as Deezer's "Ne pas
recommander ce titre" and Spotify's "Exclure de votre profil de goût" are
(support.deezer.com, "How to Customize Your Music Recommendations"; Tom's
Guide, 2025): the title leaves the Flow, the radios and the mixes, and is still
there when the person searches for it, opens its album or plays a playlist.

What it does to the other titles follows Rocchio's relevance feedback (the
query moves away from the centroid of what was judged not relevant, with a
weight below the positive one: alpha 1, beta 0.75, gamma 0.15 in the textbook
setting, Manning et al. ch. 9) and Pandora's thumbs down ("narrows the DNA" of
the station rather than banning a style):

* **excluded**: the title itself, every other row of the same recording (a
  single and its album take, ``matching.match_key``) and the titles that sound
  ALMOST THE SAME — a stored sound neighbour (``track_neighbor``) at
  ``VERY_CLOSE`` or more AND among the very first of either list;
* **pushed down**: the rest of its first ``PUSH_RANK`` neighbours, the nearest
  to ``FLOOR`` of its score, the farther less. Pushed, not removed: a radio
  seeded right next to them still reaches them, which is "only when the
  context really asks for it";
* nothing else: an artist is muted on its own (``ArtistMute``), offered by the
  app once several of its titles were disliked (Deezer does the same).

Every read is the database, three statements at most; the answer is kept per
person for ``TTL`` seconds and dropped when the person changes their list.
"""

import threading
import time

from .db import Artist, ArtistMute, Track, TrackDislike, TrackNeighbor, now

#: A neighbour at least this similar and among the first ``VERY_CLOSE_RANK``
#: of either title's list is the same thing to the ear: excluded with it.
VERY_CLOSE = 0.9
VERY_CLOSE_RANK = 3
#: The disliked title's first ``PUSH_RANK`` neighbours at ``NEAR`` or more
#: are pushed down; the nearest keeps ``FLOOR`` of its score.
NEAR = 0.75
PUSH_RANK = 20
FLOOR = 0.3
#: The dislikes read for one person at most (the newest).
MAX = 2000
#: How long a person's list is kept in memory.
TTL = 120
#: Disliking this many titles of one artist offers to mute the artist.
ARTIST_HINT = 3

_cache = {}
_lock = threading.Lock()


class Dislikes:
    """``tracks`` disliked, ``excluded`` (them, their other rows and their
    nearly identical neighbours), ``factor`` for the pushed-down neighbours,
    ``deezer`` the Deezer ids of all excluded rows (catalogue candidates)."""

    def __init__(self):
        self.tracks = set()
        self.excluded = set()
        self.factors = {}
        self.deezer = set()

    def __bool__(self):
        return bool(self.tracks)

    def factor(self, tid) -> float:
        """0 for an excluded title, else what its score is multiplied by."""
        if tid in self.excluded:
            return 0.0
        return self.factors.get(tid, 1.0)


def rank_factor(rank) -> float:
    """``FLOOR`` for the disliked title's nearest kept neighbour, rising
    linearly to 1 at ``PUSH_RANK``. By rank, not by score: how similar the
    stored scores are depends on the genre (a dense one sits at 0.9
    throughout), the order does not."""
    if rank >= PUSH_RANK:
        return 1.0
    return FLOOR + (1.0 - FLOOR) * max(0, rank) / PUSH_RANK


def load(user, fresh=False) -> Dislikes:
    key = getattr(user, "id", None)
    if key is None:
        return Dislikes()
    if not fresh:
        with _lock:
            hit = _cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < TTL:
            return hit[1]
    d = _build(user)
    with _lock:
        if len(_cache) > 512:
            _cache.clear()
        _cache[key] = (time.monotonic(), d)
    return d


def invalidate(user):
    with _lock:
        _cache.pop(getattr(user, "id", user), None)


def _build(user) -> Dislikes:
    from .matching import match_key

    d = Dislikes()
    rows = list(
        Track.select(Track.id, Track.artist, Track.title, Track.deezer_id, Artist.name)
        .join(TrackDislike, on=(TrackDislike.track == Track.id))
        .switch(Track)
        .join(Artist, on=(Track.artist == Artist.id))
        .where(TrackDislike.user == user)
        .order_by(TrackDislike.created.desc())
        .limit(MAX)
        .tuples()
    )
    if not rows:
        return d
    keys = set()
    artists = set()
    for tid, aid, title, dz, aname in rows:
        d.tracks.add(tid)
        d.excluded.add(tid)
        if dz:
            d.deezer.add(str(dz))
        artists.add(aid)
        keys.add(match_key({"title": title, "artist": aname}))
    # The other rows of the same recordings: same artist, same key.
    for tid, title, dz, aname in (
        Track.select(Track.id, Track.title, Track.deezer_id, Artist.name)
        .join(Artist, on=(Track.artist == Artist.id))
        .where(Track.artist.in_(list(artists)) & Track.id.not_in(list(d.tracks)))
        .tuples()
    ):
        if match_key({"title": title, "artist": aname}) in keys:
            d.excluded.add(tid)
            if dz:
                d.deezer.add(str(dz))
    # The sound neighbours, in one statement: the disliked title's own list
    # (pushed down by rank), and the lists that hold it (only to find the
    # titles whose very nearest it is).
    ids = list(d.tracks)
    for a, b, score, rank in (
        TrackNeighbor.select(TrackNeighbor.track, TrackNeighbor.neighbor,
                             TrackNeighbor.score, TrackNeighbor.rank)
        .where(TrackNeighbor.score >= NEAR)
        .where((TrackNeighbor.track.in_(ids) & (TrackNeighbor.rank < PUSH_RANK))
               | (TrackNeighbor.neighbor.in_(ids) & (TrackNeighbor.rank < VERY_CLOSE_RANK)))
        .tuples()
    ):
        own = a in d.tracks
        other = b if own else a
        if other in d.tracks:
            continue
        if float(score) >= VERY_CLOSE and rank < VERY_CLOSE_RANK:
            d.excluded.add(other)
            continue
        if own:
            f = rank_factor(rank)
            if f < d.factors.get(other, 1.0):
                d.factors[other] = f
    for tid in d.excluded:
        d.factors.pop(tid, None)
    if len(d.excluded) > len(d.tracks):
        for tid, dz in (
            Track.select(Track.id, Track.deezer_id)
            .where(Track.id.in_(list(d.excluded - d.tracks)) & Track.deezer_id.is_null(False))
            .tuples()
        ):
            d.deezer.add(str(dz))
    return d


def ids(user):
    """The disliked titles of ``user``, newest first."""
    return [
        tid for (tid,) in TrackDislike.select(TrackDislike.track)
        .where(TrackDislike.user == user)
        .order_by(TrackDislike.created.desc())
        .tuples()
    ]


def set_disliked(user, track, on) -> dict:
    """Add (``on``) or remove a dislike. Returns ``{"disliked": on}`` and, when
    the person now dislikes ``ARTIST_HINT`` titles of this artist, the artist
    to offer muting."""
    if on:
        TrackDislike.insert(user=user, track=track, created=now()).on_conflict_ignore().execute()
    else:
        TrackDislike.delete().where(
            (TrackDislike.user == user) & (TrackDislike.track == track)
        ).execute()
    invalidate(user)
    out = {"disliked": bool(on)}
    if on and track.artist_id is not None:
        n = (
            TrackDislike.select()
            .join(Track, on=(TrackDislike.track == Track.id))
            .where((TrackDislike.user == user) & (Track.artist == track.artist_id))
            .count()
        )
        if n >= ARTIST_HINT:
            ar = Artist.get_or_none(Artist.id == track.artist_id)
            if ar is not None:
                provider, ref = ("deezer", str(ar.deezer_id)) if ar.deezer_id else ("local", str(ar.id))
                muted = ArtistMute.select().where(
                    (ArtistMute.user == user) & (ArtistMute.provider == provider) & (ArtistMute.ref == ref)
                ).exists()
                if not muted:
                    out["artist_hint"] = {"provider": provider, "id": ref, "name": ar.name, "count": n}
    return out

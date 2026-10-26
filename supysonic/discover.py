# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What to play next and what to recommend, from what a person listens to and
loves, at the distance from it they asked for.

**The taste profile** (``profile``) is read from the database in a handful of
grouped statements: every play counts (``log1p`` of the play count, faded by
how long ago the track was last heard — a track played daily a year ago is not
today's taste), every star counts more (a starred artist most of all), and the
genres follow from the served verdicts, carried up the genre tree so that a
person who plays frenchcore also leans, less, toward hardcore.

**Candidates** each carry an estimated DISTANCE from that taste, 0 (what the
person already plays) to 1 (as far from it as the library goes):

=========================================  ===========
where it comes from                        distance
=========================================  ===========
a favourite or much played title (known)   0
an unplayed title of a loved artist        0.12
a neighbour by sound (``track_neighbor``)  0.08 - 0.45
an artist the provider lists as close      0.30 - 0.60
its most played titles, not in the library 0.45 - 0.70
the library's unplayed titles, by genre    0.45 - 0.95 (tree distance)
the library's unplayed titles, no genre    0.75
=========================================  ===========

**The discovery level** ``d`` (0 to 1, one per person, the Flow's slider) picks
from them: a candidate weighs ``exp(-((distance - d) / 0.18)²)`` times how much
the taste backs it, times a seeded jitter (``seed``: "Rafraîchir" changes the
draw, the hour does not). The Flow keeps a share of KNOWN titles that falls
from 80 % at 0 to 20 % at 1. Never more than two titles of one artist in a
list, nothing twice (``matching.match_key``), nothing played in the last 20
minutes, no artist the person muted.

Everything is a read of what is already stored — the providers are asked by
``releases.py``'s background job, never here — so a screen costs a few indexed
statements whatever Deezer is doing, and with no embeddings, no provider and no
genre at all the library's own plays still answer.
"""

import datetime
import math
import random
import threading
import time

from . import dislikes, genretree, listening, mix
from .db import (
    Album, Artist, ArtistLink, ArtistMute, ArtistRelease, ArtistTop, StarredAlbum,
    StarredArtist, StarredTrack, Track, TrackAnalysis, TrackNeighbor, UserTaste,
    now,
)

#: The discovery level a person who never moved the slider gets.
DEFAULT_LEVEL = 0.35
#: The four named steps of the slider (the value itself is continuous).
STEPS = (("Proche", 0.0), ("Voisin", 0.25), ("Exploration", 0.5), ("Aventure", 0.75))
#: How wide a band around the level a candidate is still considered.
BAND = 0.18
#: Known share of the Flow at level 0 and at level 1.
KNOWN_AT_0, KNOWN_AT_1 = 0.8, 0.2
#: Titles of one artist per list.
PER_ARTIST = 2
#: A play this long ago weighs a third of today's.
PLAY_FADE_DAYS = 45.0
SEEDS = 30
#: A track heard less long ago than this is not offered again.
RECENT = 20 * 60
#: The profile of a person is kept this long (seconds).
PROFILE_TTL = 120
#: The library rows sampled for the genre candidates (unplayed titles): this
#: many random starting points in the index, this many rows from each.
GENRE_STARTS = 4
GENRE_RUN = 400
#: Below this many events of their own, a person's profile is completed by
#: the shared play counters (a server upgraded from before the log).
LEGACY_UNTIL = 200
#: A known title heard less long ago than this weighs ``FATIGUE`` as much.
FATIGUE_HOURS = 3
FATIGUE = 0.25
#: Known titles: the best by affinity drawn from this many.
KNOWN_POOL = 600
#: The Flow's draw inside the band: low enough that the band decides, high
#: enough that two refreshes differ.
BAND_TEMPERATURE = 0.4

_cache = {}
_cache_lock = threading.Lock()


# -- the person's level ----------------------------------------------------------


def level_of(user) -> float:
    row = UserTaste.get_or_none(UserTaste.user == user)
    return float(row.discovery) if row is not None and row.discovery is not None else DEFAULT_LEVEL


def set_level(user, value) -> float:
    value = clamp(value)
    save_taste(user, discovery=value)
    return value


def save_taste(user, **fields):
    """Write a person's ``user_taste`` row, creating it the first time (an
    update first, then an insert: the same on every engine)."""
    from .db import db

    fields["updated"] = now()
    if UserTaste.update(**fields).where(UserTaste.user == user).execute():
        return
    try:
        with db.atomic():
            UserTaste.create(user=user, **fields)
    except Exception:  # created meanwhile by another request
        UserTaste.update(**fields).where(UserTaste.user == user).execute()


def clamp(value) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ValueError("the discovery level is a number from 0 to 1") from None
    if math.isnan(value):
        raise ValueError("the discovery level is a number from 0 to 1")
    return min(1.0, max(0.0, value))


def step_name(level) -> str:
    name = STEPS[0][0]
    for label, start in STEPS:
        if level >= start:
            name = label
    return name


# -- the taste profile ------------------------------------------------------------


class Taste:
    def __init__(self):
        self.tracks = {}  # track id -> weight
        self.artists = {}  # artist id -> weight
        self.albums = {}  # album id -> weight
        self.genres = {}  # served style -> weight (with the tree's ancestors)
        self.played = set()  # every track ever played
        self.starred_tracks = set()
        self.starred_artists = set()
        self.starred_albums = set()
        self.artist_names = {}  # artist id -> name
        self.artist_refs = {}  # artist id -> Deezer id (the provider refs)
        self.muted = set()  # (provider, ref)
        self.history = listening.History()  # skips, last heard
        self.dislikes = dislikes.Dislikes()

    def top_artists(self, n):
        return [a for a, _ in sorted(self.artists.items(), key=lambda p: -p[1])[:n]]

    def top_genres(self, n):
        return sorted(self.genres.items(), key=lambda p: -p[1])[:n]


def _fade(when, today):
    if when is None:
        return 1.0 / 3.0
    age = max(0.0, (today - when).total_seconds() / 86400.0)
    return 1.0 / 3.0 + 2.0 / 3.0 * math.exp(-age / PLAY_FADE_DAYS)


def _visible(query, user):
    if user is None or user.admin:
        return query
    return query.where(Track.owner.is_null(True) | (Track.owner == user.id))


def _normalise(weights):
    top = max(weights.values(), default=0.0)
    if top > 0:
        for k in weights:
            weights[k] /= top


def profile(user, fresh=False) -> Taste:
    key = getattr(user, "id", None)
    if not fresh:
        with _cache_lock:
            hit = _cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < PROFILE_TTL:
            return hit[1]
    taste = _build(user)
    with _cache_lock:
        _cache[key] = (time.monotonic(), taste)
    return taste


def invalidate(user=None):
    with _cache_lock:
        if user is None:
            _cache.clear()
        else:
            _cache.pop(getattr(user, "id", user), None)


def _build(user) -> Taste:
    t = Taste()
    today = now()
    # The person's OWN listening (supysonic/listening.py): ACT-R activation of
    # each title, skips kept apart.
    hist = listening.history(user, today) if user is not None else listening.History()
    t.history = hist
    t.dislikes = dislikes.load(user) if user is not None else dislikes.Dislikes()
    for tid, a in hist.track.items():
        t.played.add(tid)
        t.tracks[tid] = t.tracks.get(tid, 0.0) + a
    for aid, a in hist.artist.items():
        t.artists[aid] = t.artists.get(aid, 0.0) + a
    for alid, a in hist.album.items():
        t.albums[alid] = t.albums.get(alid, 0.0) + a
    _normalise(t.tracks)
    _normalise(t.artists)
    _normalise(t.albums)
    # A server upgraded from before the log has only the shared counters: they
    # complete the profile until the person's own history is long enough.
    legacy = max(0.0, 1.0 - hist.events / LEGACY_UNTIL)
    if legacy > 0:
        lt, la, lal = {}, {}, {}
        for tid, aid, alid, plays, last in _visible(
            Track.select(Track.id, Track.artist, Track.album, Track.play_count, Track.last_play)
            .where((Track.play_count > 0) | Track.last_play.is_null(False)),
            user,
        ).tuples():
            w = math.log1p(max(1, plays or 0)) * _fade(last, today)
            t.played.add(tid)
            lt[tid] = lt.get(tid, 0.0) + w
            la[aid] = la.get(aid, 0.0) + w
            lal[alid] = lal.get(alid, 0.0) + w
        for mine, old in ((t.tracks, lt), (t.artists, la), (t.albums, lal)):
            _normalise(old)
            for k, w in old.items():
                mine[k] = mine.get(k, 0.0) + legacy * w
    if user is not None:
        for tid, aid, alid, date in (
            Track.select(Track.id, Track.artist, Track.album, StarredTrack.date)
            .join(StarredTrack, on=(StarredTrack.starred == Track.id))
            .where(StarredTrack.user == user)
            .tuples()
        ):
            w = 2.5 * _fade(date, today)
            t.starred_tracks.add(tid)
            t.tracks[tid] = t.tracks.get(tid, 0.0) + w
            t.artists[aid] = t.artists.get(aid, 0.0) + w
            t.albums[alid] = t.albums.get(alid, 0.0) + w
        for alid, aid in (
            Album.select(Album.id, Album.artist)
            .join(StarredAlbum, on=(StarredAlbum.starred == Album.id))
            .where(StarredAlbum.user == user)
            .tuples()
        ):
            t.starred_albums.add(alid)
            t.albums[alid] = t.albums.get(alid, 0.0) + 3.0
            t.artists[aid] = t.artists.get(aid, 0.0) + 2.0
        for aid, in (
            StarredArtist.select(StarredArtist.starred).where(StarredArtist.user == user).tuples()
        ):
            t.starred_artists.add(aid)
            t.artists[aid] = t.artists.get(aid, 0.0) + 5.0
        t.muted = {
            (p, r)
            for p, r in ArtistMute.select(ArtistMute.provider, ArtistMute.ref)
            .where(ArtistMute.user == user)
            .tuples()
        }
    # A title the person said they do not like is not part of their taste,
    # however often it played.
    for tid in t.dislikes.tracks:
        t.tracks.pop(tid, None)
    # The genres of what is loved, in ONE statement: the analysis joined to the
    # tracks that carry a weight (played, or starred by this person).
    if t.tracks:
        q = TrackAnalysis.select(TrackAnalysis.track, TrackAnalysis.style).where(
            TrackAnalysis.style.is_null(False)
        )
        tree = genretree.get()
        weighted = list(t.tracks)
        rows = []
        for i in range(0, len(weighted), 500):
            rows += list(q.where(TrackAnalysis.track.in_(weighted[i : i + 500])).tuples())
        for tid, style in rows:
            w = t.tracks.get(tid)
            if not w:
                continue
            t.genres[style] = t.genres.get(style, 0.0) + w
        # A person who plays frenchcore also leans, less, toward hardcore.
        lifted = dict(t.genres)
        for style, w in t.genres.items():
            node = tree.node(style)
            if node is None:
                continue
            for up, hops, firm in tree.up(node):
                if hops > 3:
                    break
                lifted[up] = lifted.get(up, 0.0) + w * firm * (0.5 ** hops)
        t.genres = lifted
    if t.artists:
        top = t.top_artists(400)
        for aid, name, dz in Artist.select(Artist.id, Artist.name, Artist.deezer_id).where(
            Artist.id.in_(top)
        ).tuples():
            t.artist_names[aid] = name
            if dz:
                t.artist_refs[aid] = str(dz)
    for weights in (t.tracks, t.artists, t.albums, t.genres):
        _normalise(weights)
    return t


# -- candidates ----------------------------------------------------------------------


class Cand:
    __slots__ = ("key", "track", "provider", "ref", "artist", "artist_ref", "dist",
                 "rel", "why", "info", "mult", "energy")

    def __init__(self, key, dist, rel, why, track=None, provider=None, ref=None,
                 artist=None, artist_ref=None, info=None):
        self.key = key
        self.track = track
        self.provider = provider
        self.ref = ref
        self.artist = artist  # local artist id, or the provider's ref
        self.artist_ref = artist_ref
        self.dist = dist
        self.rel = rel
        self.why = why
        self.info = info
        self.mult = 1.0  # what the person's dislikes leave of its score
        self.energy = None  # 0 calm .. 1 intense, when the Flow told it


def _recent_cutoff():
    return now() - datetime.timedelta(seconds=RECENT)


def _offer(pool, cand):
    """Keep the closest reading of a candidate several sources propose."""
    have = pool.get(cand.key)
    if have is None or cand.dist < have.dist or (cand.dist == have.dist and cand.rel > have.rel):
        pool[cand.key] = cand


def _links(taste, provider="deezer"):
    """``[(other ref, name, picture, score, pos, source artist id)]`` of the
    provider's close artists to the loved artists, one statement."""
    refs = {}
    for aid in taste.top_artists(60):
        ref = taste.artist_refs.get(aid)
        if ref:
            refs[ref] = aid
    if not refs:
        return []
    return [
        (o, name, pic, score, pos, refs[a])
        for a, o, name, pic, score, pos in ArtistLink.select(
            ArtistLink.artist_ref, ArtistLink.other_ref, ArtistLink.other_name,
            ArtistLink.other_picture, ArtistLink.score, ArtistLink.pos,
        )
        .where((ArtistLink.provider == provider) & ArtistLink.artist_ref.in_(list(refs)))
        .tuples()
    ]


def track_candidates(user, taste, rng, with_catalog=True):
    """Every candidate title for this person, each with its distance."""
    pool = {}
    cutoff = _recent_cutoff()
    names = taste.artist_names

    def fresh(q):
        return _visible(
            q.where(
                (Track.last_modification > 0)
                & Track.unavailable.is_null(True)
                & (Track.last_play.is_null(True) | (Track.last_play < cutoff))
            ),
            user,
        )

    hist = taste.history
    fatigue_since = now() - datetime.timedelta(hours=FATIGUE_HOURS)

    def liked(tid, w):
        """A known title's weight: its affinity, less what the person skips,
        a quarter while it was heard in the last few hours."""
        w *= 1.0 - 0.8 * hist.skip_ratio(tid)
        last = hist.last.get(tid)
        if last is not None and last >= fatigue_since:
            w *= FATIGUE
        return w

    # Known: the titles the taste rests on.
    disliked = taste.dislikes
    top = [p for p in sorted(taste.tracks.items(), key=lambda p: -p[1])
           if p[0] not in disliked.excluded][:KNOWN_POOL]
    if top:
        wanted = [k for k, _ in top if not hist.rejected(k)]
        for i in range(0, len(wanted), 500):
            for tid, aid in fresh(Track.select(Track.id, Track.artist).where(
                Track.id.in_(wanted[i : i + 500])
            )).tuples():
                _offer(pool, Cand(tid, 0.0, liked(tid, taste.tracks.get(tid, 0.0)), "Vous l'aimez",
                                  track=tid, artist=aid))
        top = top[:300]

    # Neighbours by sound of the seeds.
    seeds = [k for k, _ in top[:SEEDS]]
    if seeds:
        near = {}
        for seed, nid, score, aid in (
            TrackNeighbor.select(TrackNeighbor.track, TrackNeighbor.neighbor,
                                 TrackNeighbor.score, Track.artist)
            .join(Track, on=(TrackNeighbor.neighbor == Track.id))
            .where(TrackNeighbor.track.in_(seeds))
            .tuples()
        ):
            if nid in taste.played:
                continue
            w = taste.tracks.get(seed, 0.0) * score
            got = near.get(nid)
            if got is None or score > got[0]:
                near[nid] = (score, aid, seed, (got[3] if got else 0.0) + w)
            else:
                near[nid] = (got[0], got[1], got[2], got[3] + w)
        if near:
            ok = {r[0] for r in fresh(Track.select(Track.id).where(Track.id.in_(list(near)))).tuples()}
            for nid, (score, aid, seed, w) in near.items():
                if nid not in ok:
                    continue
                dist = min(0.45, 0.08 + 1.1 * max(0.0, 1.0 - score))
                if taste.artists.get(aid, 0.0) == 0.0:
                    dist = min(0.5, dist + 0.12)
                _offer(pool, Cand(nid, dist, min(1.0, w), "Proche par le son", track=nid, artist=aid))

    # Unplayed titles of the loved artists.
    loved = taste.top_artists(25)
    if loved:
        for tid, aid in _sampled(fresh(
            Track.select(Track.id, Track.artist).where(Track.artist.in_(loved))
        ), rng, 400, taste.played):
            name = names.get(aid)
            _offer(pool, Cand(tid, 0.12, taste.artists.get(aid, 0.0),
                              f"De {name}" if name else "Un artiste que vous aimez",
                              track=tid, artist=aid))

    # The provider's close artists: their titles in the library, and their most
    # played ones that are not.
    links = _links(taste)
    if links:
        by_ref = {}
        for o, name, pic, score, pos, src in links:
            if ("deezer", o) in taste.muted:
                continue
            w = score * taste.artists.get(src, 0.0)
            dist = 0.30 + 0.30 * min(1.0, pos / 19.0)
            got = by_ref.get(o)
            if got is None or dist < got[0]:
                by_ref[o] = (dist, max(w, got[1] if got else 0.0), name, src)
        local = {
            str(dz): aid
            for aid, dz in Artist.select(Artist.id, Artist.deezer_id)
            .where(Artist.deezer_id.in_(list(by_ref)))
            .tuples()
        }
        if local:
            back = {aid: ref for ref, aid in local.items()}
            for tid, aid in _sampled(fresh(
                Track.select(Track.id, Track.artist).where(Track.artist.in_(list(back)))
            ), rng, 600, taste.played):
                dist, w, _name, src = by_ref[back[aid]]
                _offer(pool, Cand(tid, dist, w, f"Proche de {names.get(src, '')}".strip(),
                                  track=tid, artist=aid))
        if with_catalog:
            for prov, ref, aref, aname, title, alref, altitle, cover, dur, pos in (
                ArtistTop.select(
                    ArtistTop.provider, ArtistTop.ref, ArtistTop.artist_ref, ArtistTop.artist_name,
                    ArtistTop.title, ArtistTop.album_ref, ArtistTop.album_title, ArtistTop.cover,
                    ArtistTop.duration, ArtistTop.pos,
                )
                .where((ArtistTop.provider == "deezer") & ArtistTop.artist_ref.in_(list(by_ref)))
                .tuples()
            ):
                if aref in local:
                    continue  # the library holds this artist: its own rows answer
                dist, w, _name, src = by_ref[aref]
                _offer(pool, Cand(
                    f"{prov}:{ref}", min(0.75, dist + 0.15 + 0.02 * pos), w,
                    f"Proche de {names.get(src, '')}".strip(),
                    provider=prov, ref=ref, artist=aref, artist_ref=aref,
                    info={"title": title, "artist": aname, "album_ref": alref,
                          "album": altitle, "cover": cover, "duration": dur},
                ))

    # The library's unplayed titles, by how far their genre is from the taste.
    genres = taste.top_genres(6)
    styles = {}
    rows = _sample_unplayed(fresh, taste, rng)
    for tid, aid, style in rows:
        if tid in pool or hist.rejected(tid):
            continue
        if style is None:
            _offer(pool, Cand(tid, 0.75, 0.2, "Au hasard de votre bibliothèque", track=tid, artist=aid))
            continue
        g = styles.get(style)
        if g is None:
            if genres:
                g = min(genretree.distance(style, s) + 0.4 * (1.0 - w) for s, w in genres)
                g = min(1.0, g)
            else:
                g = 0.6
            styles[style] = g
        _offer(pool, Cand(tid, 0.45 + 0.5 * g, max(0.1, 1.0 - g), f"Un peu de {style}",
                          track=tid, artist=aid))
    if disliked:
        apply_dislikes(pool, disliked)
    return pool


def apply_dislikes(pool, disliked):
    """Out of ``pool``: what the person dislikes and what sounds almost the
    same; the farther neighbours keep a share of their score (dislikes.py)."""
    for key, c in list(pool.items()):
        if c.track is not None:
            f = disliked.factor(c.track)
        else:
            f = 0.0 if c.provider == "deezer" and str(c.ref) in disliked.deezer else 1.0
        if f <= 0.0:
            pool.pop(key, None)
        else:
            c.mult = f


def _sample_unplayed(fresh, taste, rng):
    """A random sample of the library's unheard titles, with their genre:
    ``GENRE_STARTS`` random points in the primary-key index, ``GENRE_RUN``
    rows from each — O(log n) per point on every engine, and a new sample on
    every draw (a bare LIMIT read the same rows every time)."""
    import uuid

    seen = set()
    rows = []
    for _ in range(GENRE_STARTS):
        start = uuid.UUID(int=rng.getrandbits(128), version=4)
        got = list(
            fresh(
                Track.select(Track.id, Track.artist, TrackAnalysis.style)
                .join(TrackAnalysis, peewee_left(), on=(TrackAnalysis.track == Track.id))
                .where(Track.id >= start)
            ).order_by(Track.id).limit(GENRE_RUN).tuples()
        )
        if len(got) < GENRE_RUN:  # wrapped past the end: the start of the index
            got += list(
                fresh(
                    Track.select(Track.id, Track.artist, TrackAnalysis.style)
                    .join(TrackAnalysis, peewee_left(), on=(TrackAnalysis.track == Track.id))
                    .where(Track.id < start)
                ).order_by(Track.id).limit(GENRE_RUN - len(got)).tuples()
            )
        for r in got:
            if r[0] not in seen and r[0] not in taste.played:
                seen.add(r[0])
                rows.append(r)
    rng.shuffle(rows)
    return rows


def _sampled(query, rng, k, skip):
    """At most ``k`` rows of ``query`` (two columns, the id first) the person
    has not heard, drawn with ``rng`` so a seed repeats the draw."""
    rows = [r for r in query.order_by(Track.id).limit(4000).tuples() if r[0] not in skip]
    return rows if len(rows) <= k else rng.sample(rows, k)


def peewee_left():
    from peewee import JOIN

    return JOIN.LEFT_OUTER


def _fit(cand, level):
    x = (cand.dist - level) / BAND
    return math.exp(-x * x)


def _artist_key(c):
    return c.artist if c.artist is not None else c.key


def pick(pool, level, n, rng, known_share=0.0, exclude=()):
    """``n`` candidates: ``known_share`` of them known (distance 0), the rest
    drawn by how close their distance is to ``level``, then assembled
    (``mix.assemble``: a draw proportional to the score, MMR over the last
    titles, ``PER_ARTIST`` titles of an artist, never two within three).

    A small library may hold too little at the asked distance: a candidate far
    from the level keeps a tiny score, so the band is filled first, then the
    nearest distances, and only then more known titles."""
    exclude = set(exclude)
    known = [c for c in pool.values() if c.dist == 0.0 and c.key not in exclude]
    other = [c for c in pool.values() if c.dist > 0.0 and c.key not in exclude]
    n_known = min(len(known), int(round(n * known_share)))

    def item(c, score):
        return mix.Item(c.key, score * c.mult, artist=_artist_key(c), track=c.track, payload=c)

    def near(c):
        return math.exp(-8.0 * abs(c.dist - level))

    deduped = _one_per_title(other)
    # The band first (its caps relaxed to twice before anything else), then
    # the nearest distances, then — a thin library — anything at all.
    in_band = [c for c in deduped if _fit(c, level) * (0.35 + 0.65 * c.rel) > 1e-3]
    rest = [c for c in deduped if c not in set(in_band)]
    want = n - n_known
    others = mix.assemble(
        [item(c, _fit(c, level) * (0.35 + 0.65 * c.rel)) for c in in_band],
        want, rng, temperature=BAND_TEMPERATURE, cap=PER_ARTIST, gap=3, relax=False,
    )
    if len(others) < want and rest:
        others += mix.assemble(
            [item(c, near(c) * (0.35 + 0.65 * c.rel)) for c in rest],
            want - len(others), rng, temperature=BAND_TEMPERATURE, cap=PER_ARTIST, gap=3,
            fixed=others, relax=False,
        )
    if len(others) < want:
        left = [c for c in deduped if c.key not in {it.key for it in others}]
        others += mix.assemble([item(c, near(c) + 1e-9) for c in left], want - len(others),
                               rng, cap=PER_ARTIST, fixed=others)
    chosen_other = [it.payload for it in others]
    taken_artists = {}
    for c in chosen_other:
        taken_artists[_artist_key(c)] = taken_artists.get(_artist_key(c), 0) + 1
    want_known = n - len(chosen_other) if len(chosen_other) < n - n_known else n_known
    kn = mix.assemble(
        [item(c, 0.05 + c.rel) for c in known], want_known, rng,
        temperature=0.8, cap=PER_ARTIST + 1, gap=2,
    )
    chosen_known = [it.payload for it in kn]
    # Known titles spread evenly through the list.
    out = []
    k = len(chosen_known)
    total = k + len(chosen_other)
    ki = oi = 0
    for i in range(total):
        due = (i + 1) * k // total > i * k // total if total else False
        if ki < k and (due or oi >= len(chosen_other)):
            out.append(chosen_known[ki])
            ki += 1
        else:
            out.append(chosen_other[oi])
            oi += 1
    return out


def _one_per_title(cands):
    """A catalogue title listed under two close artists is one candidate."""
    seen = {}
    for c in cands:
        k = _title_key(c) or c.key
        have = seen.get(k)
        if have is None or c.dist < have.dist:
            seen[k] = c
    return list(seen.values())


def _title_key(c):
    return c.info and ("t:" + (c.info.get("artist") or "").lower() + "|" + (c.info.get("title") or "").lower())


def known_share(level) -> float:
    return KNOWN_AT_0 + (KNOWN_AT_1 - KNOWN_AT_0) * level


def flow(user, level, n=40, seed=None, exclude=(), skipped=()):
    """The Flow: ``exclude`` is what the queue already holds, ``skipped`` what
    this session skipped (their artists weigh half for the rest of it)."""
    taste = profile(user)
    rng = random.Random(f"{getattr(user, 'id', '')}:{seed}")  # nosec B311 - a seeded draw so a suggestion repeats, not a secret
    pool = track_candidates(user, taste, rng)
    _dedupe_library(pool)
    if skipped:
        gone = set(skipped)
        artists = {
            a for (a,) in Track.select(Track.artist).where(Track.id.in_(list(gone))).tuples()
        }
        for c in list(pool.values()):
            if c.key in gone:
                pool.pop(c.key, None)
            elif c.artist in artists:
                c.rel *= 0.5
    return pick(pool, level, n, rng, known_share(level), exclude)


def _dedupe_library(pool):
    """Two library rows of one recording (an album take and a single) are one
    candidate: the closer reading stays."""
    from .matching import match_key

    ids = [c.track for c in pool.values() if c.track is not None]
    if not ids:
        return
    keys = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        for tid, title, aname in (
            Track.select(Track.id, Track.title, Artist.name)
            .join(Artist, on=(Track.artist == Artist.id))
            .where(Track.id.in_(chunk))
            .tuples()
        ):
            keys[tid] = match_key({"title": title, "artist": aname})
    best = {}
    for c in list(pool.values()):
        if c.track is None:
            continue
        k = keys.get(c.track)
        if k is None:
            continue
        have = best.get(k)
        if have is None:
            best[k] = c
            continue
        keep, drop = (have, c) if have.dist <= c.dist else (c, have)
        best[k] = keep
        pool.pop(drop.key, None)


# -- the Flow, one title at a time ---------------------------------------------------
#
# The Flow used to hand the player forty titles at once; whatever the person
# then said or did only reached the NEXT forty. Now the player asks for ONE
# title, about twenty seconds before the end of the one playing, and sends
# everything the session has said so far (design and sources:
# /mnt/project-files/algos/flow-personnalise.md):
#
# * what was heard and for how long: a listen (listening.outcome: half the
#   track or 4 min) is a positive anchor, a skip (< 30 s) a negative one —
#   implicit, so weaker than a button (Hanna 2017; Brost et al. 2019);
# * "plus comme ça" / "moins comme ça": explicit anchors, the positive
#   stronger than the negative (Rocchio: beta 0.75 > gamma 0.15; Pandora's
#   thumbs up "more songs similar to this", thumbs down "narrows the DNA");
# * the energy aimed at (energy.py), a notch the person chose and moves.
#
# Each anchor fades the further back it is (``SESSION_FADE``), so the Flow
# turns little by little and a single skip does not swing it. A candidate's
# score is multiplied by ``exp(GAIN * sum(weight * similarity))`` over the
# anchors, similarity from the stored sound neighbours (or the same artist).
# The candidate pool is the Flow's own (``track_candidates``), kept per
# session for ``SESSION_TTL`` so a pick costs a handful of statements.

#: Anchor weights: listened through, skipped, "plus comme ça", "moins comme ça".
HEARD_W, SKIP_W, MORE_W, LESS_W = 0.4, -0.35, 1.0, -0.75
#: Each implicit anchor fades by this per title back; each explicit one by
#: ``EXPLICIT_FADE`` per press back (a button is meant for longer).
SESSION_FADE = 0.85
EXPLICIT_FADE = 0.9
GAIN = 1.5
MULT_MIN, MULT_MAX = 0.05, 20.0
#: An anchor's artist counts as this similar when no neighbour is stored.
SAME_ARTIST_SIM = 0.5
#: Drawn before the order is taken (the first is played, the second kept).
PICK_DRAW = 8
SESSION_TTL = 15 * 60
SESSION_MAX = 64
#: With no notch chosen, this many titles heard through set a soft aim at
#: their mean energy, this much wider than a notch's.
IMPLICIT_AFTER = 3
IMPLICIT_WIDEN = 1.6
#: The discovery band is this much wider while an energy notch is asked.
AIMED_BAND_WIDEN = 2.0
#: Skips IN A ROW are a session going wrong, not titles disliked one by one
#: (Spotify's sequential skip challenge, WSDM Cup 2019; Meggetto et al.,
#: "On skipping behaviour types in music streaming sessions", CIKM 2021): from
#: the second, each widens the distance band by this much, up to STREAK_MAX,
#: and weighs the streak's skips as much more, so the Flow looks further away
#: instead of circling the same corner. One title heard through ends it.
STREAK_WIDEN = 0.5
STREAK_MAX = 3.0

_sessions = {}
_sessions_lock = threading.Lock()


class Session:
    """What one Flow session said: ``heard`` [(track id, outcome)] oldest
    first, ``more`` / ``less`` [track id] oldest first, ``energy`` the aim
    (None: any)."""

    def __init__(self, heard=(), more=(), less=(), energy=None):
        self.heard = list(heard)
        self.more = list(more)
        self.less = list(less)
        self.energy = energy

    def skip_streak(self):
        """Skips in a row at the end of what was heard."""
        n = 0
        for _tid, outcome in reversed(self.heard):
            if outcome >= 0:
                break
            n += 1
        return n

    def anchors(self):
        """``{track id: weight}``."""
        out = {}
        streak = self.skip_streak()
        louder = min(STREAK_MAX, 1.0 + STREAK_WIDEN * max(0, streak - 1))
        for i, (tid, outcome) in enumerate(reversed(self.heard)):
            w = HEARD_W if outcome > 0 else SKIP_W if outcome < 0 else 0.0
            if i < streak:
                w *= louder
            if w:
                out[tid] = out.get(tid, 0.0) + w * SESSION_FADE ** i
        for ids, base in ((self.more, MORE_W), (self.less, LESS_W)):
            for j, tid in enumerate(reversed(ids)):
                out[tid] = out.get(tid, 0.0) + base * EXPLICIT_FADE ** j
        return out


def _session_pool(user, level, sid, rng):
    key = (getattr(user, "id", None), sid, round(level, 2))
    with _sessions_lock:
        hit = _sessions.get(key)
    if hit is not None and time.monotonic() - hit[0] < SESSION_TTL:
        return hit[1]
    taste = profile(user)
    pool = track_candidates(user, taste, rng)
    _dedupe_library(pool)
    with _sessions_lock:
        if len(_sessions) >= SESSION_MAX:
            for k, _v in sorted(_sessions.items(), key=lambda p: p[1][0])[: SESSION_MAX // 4]:
                _sessions.pop(k, None)
        _sessions[key] = (time.monotonic(), pool)
    return pool


def forget_sessions(user=None):
    with _sessions_lock:
        if user is None:
            _sessions.clear()
        else:
            for k in [k for k in _sessions if k[0] == getattr(user, "id", user)]:
                _sessions.pop(k, None)


def session_affinity(anchors, cand_ids):
    """``({(candidate, anchor): similarity}, {anchor: artist})``: the stored
    neighbours in both directions (one statement) and the anchors' artists
    (one more), for what has no neighbour stored."""
    if not anchors or not cand_ids:
        return {}, {}
    ids = list(anchors)
    sims = {}
    for a, b, score in (
        TrackNeighbor.select(TrackNeighbor.track, TrackNeighbor.neighbor, TrackNeighbor.score)
        .where(TrackNeighbor.track.in_(ids) | TrackNeighbor.neighbor.in_(ids))
        .tuples()
    ):
        anchor, other = (a, b) if a in anchors else (b, a)
        if other not in cand_ids:
            continue
        k = (other, anchor)
        if float(score) > sims.get(k, 0.0):
            sims[k] = float(score)
    artist_of = dict(Track.select(Track.id, Track.artist).where(Track.id.in_(ids)).tuples())
    return sims, artist_of


def _energy_aim(session, energies):
    """The aim and the band it is held to: the notch, else — once enough was
    heard through — a softer aim at what was."""
    from . import energy as en

    if session.energy is not None:
        return session.energy, en.BAND
    liked = [energies.get(t) for t, o in session.heard if o > 0]
    liked = [e for e in liked if e is not None]
    if len(liked) >= IMPLICIT_AFTER:
        recent = liked[-8:]
        return sum(recent) / len(recent), en.BAND * IMPLICIT_WIDEN
    return None, en.BAND


def flow_next(user, level, session, n=1, exclude=(), recent=(), sid=None, rng=None):
    """The next ``n`` titles of a Flow session (Cand objects, each with
    ``energy`` set): the first to queue, the rest held in reserve."""
    from . import energy as en

    rng = rng or random.Random()  # nosec B311 - a draw for variety, not a secret
    pool = _session_pool(user, level, sid or "-", rng)
    taste = profile(user)
    exclude = set(exclude)
    for tid, _o in session.heard:
        exclude.add(tid)
    exclude |= set(session.less)
    # "Plus comme ça": its own neighbours join the pool, at their distance.
    if session.more:
        for a, nid, score, aid in (
            TrackNeighbor.select(TrackNeighbor.track, TrackNeighbor.neighbor,
                                 TrackNeighbor.score, Track.artist)
            .join(Track, on=(TrackNeighbor.neighbor == Track.id))
            .where(TrackNeighbor.track.in_(session.more[-8:]) & (TrackNeighbor.rank < 25)
                   & Track.unavailable.is_null(True) & (Track.last_modification > 0))
            .tuples()
        ):
            if nid in exclude:
                continue
            dist = min(0.45, 0.08 + 1.1 * max(0.0, 1.0 - float(score)))
            got = pool.get(nid)
            if got is not None and got.dist <= dist:
                continue
            # kept in the session's pool, at the distance the person just
            # asked for: it stays a candidate for what follows
            pool[nid] = Cand(nid, dist, max(0.6, got.rel if got else 0.0),
                             "Comme ce que vous avez aimé", track=nid, artist=aid)
    cands = {k: c for k, c in pool.items() if k not in exclude and c.track not in exclude}
    disliked = taste.dislikes
    if disliked:
        apply_dislikes(cands, disliked)
    if not cands:
        return []
    anchors = session.anchors()
    mult = {}
    if anchors:
        track_ids = {c.track for c in cands.values() if c.track is not None}
        sims, artist_of = session_affinity(anchors, track_ids)
        anchor_artists = {}
        for a, w in anchors.items():
            ar = artist_of.get(a)
            if ar is not None:
                anchor_artists[ar] = anchor_artists.get(ar, 0.0) + w
        for c in cands.values():
            aff = 0.0
            if c.track is not None:
                for a, w in anchors.items():
                    s = sims.get((c.track, a))
                    if s:
                        aff += w * s
            w_art = anchor_artists.get(c.artist)
            if w_art:
                aff += w_art * SAME_ARTIST_SIM
            if aff:
                mult[c.key] = min(MULT_MAX, max(MULT_MIN, math.exp(GAIN * aff)))
    energies = en.energies()
    aim, band = _energy_aim(session, energies)

    def e_fit(c):
        e = energies.get(c.track) if c.track is not None else None
        if aim is None:
            return 1.0
        if e is None:
            return en.UNKNOWN
        x = (e - aim) / band
        # No floor worth the name: the notch is what the person asked for, it
        # outweighs the distance (Flow Moods only plays above the mood's
        # threshold); a library with nothing at that energy still answers.
        return max(1e-12, math.exp(-x * x))

    # A notch asked for this session outweighs the standing discovery level:
    # with an energy aimed at, the distance band is twice as wide (Flow
    # Moods plays only what passes the mood, from the Flow's candidates).
    widen = AIMED_BAND_WIDEN if aim is not None else 1.0
    widen *= min(STREAK_MAX, 1.0 + STREAK_WIDEN * max(0, session.skip_streak() - 1))

    def base(c):
        if c.dist == 0.0:
            return 0.05 + c.rel
        x = (c.dist - level) / (BAND * widen)
        return math.exp(-x * x) * (0.35 + 0.65 * c.rel)

    def score(c):
        return max(1e-300, base(c) * c.mult * mult.get(c.key, 1.0) * e_fit(c))

    # Known titles keep their share of the Flow (known_share), times how much
    # of each group the session and the notch leave standing: with "Intense"
    # asked of a person who plays calm records, their own titles mostly drop
    # out instead of taking half the picks.
    share = known_share(level)
    known = [c for c in cands.values() if c.dist == 0.0]
    other = _one_per_title([c for c in cands.values() if c.dist > 0.0])

    def kept(group):
        b = sum(base(c) for c in group)
        return sum(score(c) for c in group) / b if b > 0 else 0.0

    wk = share * kept(known) if known else 0.0
    wo = (1.0 - share) * kept(other) if other else 0.0
    group = known if wk + wo > 0 and rng.random() * (wk + wo) < wk else (other or known)

    items = [mix.Item(c.key, score(c), artist=_artist_key(c), track=c.track, payload=c)
             for c in group]
    fixed = []
    if recent:
        rows = dict(Track.select(Track.id, Track.artist).where(Track.id.in_(list(recent)[-6:])).tuples())
        fixed = [mix.Item(t, 1.0, artist=rows.get(t), track=t) for t in list(recent)[-6:] if t in rows]
    picked = mix.assemble(items, max(n, min(PICK_DRAW, len(items))), rng,
                          temperature=BAND_TEMPERATURE, cap=PER_ARTIST, gap=3, fixed=fixed)
    out = [it.payload for it in picked[:n]]
    for c in out:
        c.energy = energies.get(c.track) if c.track is not None else None
    return out


# -- albums and artists ------------------------------------------------------------


def album_candidates(user, taste, level, rng, n=12, pool=None):
    """Albums at the person's distance: library albums they have not played,
    ranked by the titles of theirs the track candidates found, then the recent
    releases of artists close to what they love."""
    if pool is None:
        pool = track_candidates(user, taste, rng, with_catalog=False)
    by_album = {}
    track_ids = [c.track for c in pool.values() if c.track is not None and c.dist > 0]
    album_of = {}
    for i in range(0, len(track_ids), 500):
        for tid, alid in Track.select(Track.id, Track.album).where(
            Track.id.in_(track_ids[i : i + 500])
        ).tuples():
            album_of[tid] = alid
    for c in pool.values():
        alid = album_of.get(c.track)
        if alid is None or alid in taste.albums or alid in taste.starred_albums:
            continue
        s = _fit(c, level) * (0.35 + 0.65 * c.rel)
        got = by_album.get(alid)
        by_album[alid] = (s + (got[0] if got else 0.0), c.why, c.dist)
    out = []
    for alid, (s, why, dist) in by_album.items():
        out.append((s * (0.7 + 0.6 * rng.random()), ("local", alid), why, dist))
    # Releases of the provider's close artists (never a favourite's: those are
    # the "Nouveautés" shelf), not in the library.
    links = _links(taste)
    if links:
        by_ref = {}
        for o, name, pic, score, pos, src in links:
            if ("deezer", o) in taste.muted:
                continue
            dist = 0.35 + 0.30 * min(1.0, pos / 19.0)
            if o not in by_ref or dist < by_ref[o][0]:
                by_ref[o] = (dist, score * taste.artists.get(src, 0.0), taste.artist_names.get(src, ""))
        fav_refs = {taste.artist_refs.get(a) for a in taste.starred_artists}
        for prov, ref, aref, title, cover, released, kind in (
            ArtistRelease.select(
                ArtistRelease.provider, ArtistRelease.ref, ArtistRelease.artist_ref,
                ArtistRelease.title, ArtistRelease.cover, ArtistRelease.released, ArtistRelease.kind,
            )
            .where((ArtistRelease.provider == "deezer") & ArtistRelease.artist_ref.in_(list(by_ref)))
            .tuples()
        ):
            if aref in fav_refs:
                continue
            dist, w, src = by_ref[aref]
            fake = Cand("", dist, w, "")
            s = _fit(fake, level) * (0.35 + 0.65 * w) * 1.2
            out.append((s * (0.7 + 0.6 * rng.random()), (prov, ref), f"Proche de {src}".strip(), dist))
    out.sort(key=lambda p: -p[0])
    return out[: n * 2]


def artist_candidates(user, taste, level, rng, n=12, pool=None):
    """Artists to discover: the provider's close artists the person neither
    starred nor plays, and library artists they never played whose titles sit
    at their distance."""
    out = {}
    played_refs = {taste.artist_refs.get(a) for a in taste.artists}
    for o, name, pic, score, pos, src in _links(taste):
        if o in played_refs or ("deezer", o) in taste.muted:
            continue
        dist = 0.30 + 0.35 * min(1.0, pos / 19.0)
        w = score * taste.artists.get(src, 0.0)
        s = _fit(Cand("", dist, w, ""), level) * (0.35 + 0.65 * w)
        got = out.get(("deezer", o))
        srcname = taste.artist_names.get(src, "")
        if got is None:
            out[("deezer", o)] = [s, name, pic, f"Proche de {srcname}".strip(), dist, 1]
        else:
            got[0] += s * 0.5  # close to several loved artists: a stronger lead
            got[5] += 1
            if got[5] == 2:
                got[3] = f"{got[3]} et {srcname}" if srcname else got[3]
    if pool is None:
        pool = track_candidates(user, taste, rng, with_catalog=False)
    local = {}
    for c in pool.values():
        if c.track is None or c.dist == 0 or c.artist in taste.artists:
            continue
        s = _fit(c, level) * (0.35 + 0.65 * c.rel)
        got = local.get(c.artist)
        local[c.artist] = (s + (got[0] if got else 0.0), c.why if got is None else got[1], c.dist)
    if local:
        rows = {
            aid: (name, dz)
            for aid, name, dz in Artist.select(Artist.id, Artist.name, Artist.deezer_id)
            .where(Artist.id.in_(list(local)))
            .tuples()
        }
        for aid, (s, why, dist) in local.items():
            if aid not in rows:
                continue
            name, dz = rows[aid]
            if dz and (("deezer", str(dz)) in out or str(dz) in played_refs or ("deezer", str(dz)) in taste.muted):
                continue
            if ("local", str(aid)) in taste.muted:
                continue
            out[("local", aid)] = [s, name, None, why, dist, 1]
    ranked = sorted(out.items(), key=lambda p: -p[1][0] * (0.75 + 0.5 * rng.random()))
    return ranked[:n]

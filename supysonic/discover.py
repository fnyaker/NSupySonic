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

from . import genretree
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
#: The library rows read for the genre candidates (unplayed titles).
GENRE_POOL = 6000

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
    for tid, aid, alid, plays, last in _visible(
        Track.select(Track.id, Track.artist, Track.album, Track.play_count, Track.last_play)
        .where((Track.play_count > 0) | Track.last_play.is_null(False)),
        user,
    ).tuples():
        w = math.log1p(max(1, plays or 0)) * _fade(last, today)
        t.played.add(tid)
        t.tracks[tid] = t.tracks.get(tid, 0.0) + w
        t.artists[aid] = t.artists.get(aid, 0.0) + w
        t.albums[alid] = t.albums.get(alid, 0.0) + w
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
    # The genres of what is loved, in ONE statement: the analysis joined to the
    # tracks that carry a weight (played, or starred by this person).
    if t.tracks:
        q = TrackAnalysis.select(TrackAnalysis.track, TrackAnalysis.style).where(
            TrackAnalysis.style.is_null(False)
        )
        starred = StarredTrack.select(StarredTrack.starred).where(StarredTrack.user == user) if user else None
        cond = TrackAnalysis.track.in_(
            Track.select(Track.id).where((Track.play_count > 0) | Track.last_play.is_null(False))
        )
        if starred is not None:
            cond = cond | TrackAnalysis.track.in_(starred)
        tree = genretree.get()
        for tid, style in q.where(cond).tuples():
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
                 "rel", "why", "info")

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

    # Known: the titles the taste rests on.
    top = sorted(taste.tracks.items(), key=lambda p: -p[1])[:300]
    if top:
        for tid, aid in fresh(Track.select(Track.id, Track.artist).where(
            Track.id.in_([k for k, _ in top])
        )).tuples():
            _offer(pool, Cand(tid, 0.0, taste.tracks.get(tid, 0.0), "Vous l'aimez",
                              track=tid, artist=aid))

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
        for tid, aid in fresh(
            Track.select(Track.id, Track.artist).where(
                Track.artist.in_(loved) & (Track.play_count == 0)
            )
        ).limit(400).tuples():
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
            for tid, aid in fresh(
                Track.select(Track.id, Track.artist).where(
                    Track.artist.in_(list(back)) & (Track.play_count == 0)
                )
            ).order_by(Track.play_count.desc()).limit(600).tuples():
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
    rows = list(
        fresh(
            Track.select(Track.id, Track.artist, TrackAnalysis.style)
            .join(TrackAnalysis, peewee_left(), on=(TrackAnalysis.track == Track.id))
            .where(Track.play_count == 0)
        ).limit(GENRE_POOL).tuples()
    )
    rng.shuffle(rows)
    for tid, aid, style in rows[:1500]:
        if tid in pool:
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
    return pool


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
    weighed by how close their distance is to ``level``.

    A small library may hold too little at the asked distance. The list is then
    completed in this order, never the other way round: the same band with a
    looser cap per artist, then the nearest distances to the level whatever
    they are, and only then more known titles."""
    exclude = set(exclude)
    known = [c for c in pool.values() if c.dist == 0.0 and c.key not in exclude]
    other = [c for c in pool.values() if c.dist > 0.0 and c.key not in exclude]

    def jitter():
        return 0.6 + 0.8 * rng.random()

    ranked_known = sorted(known, key=lambda c: -(0.35 + 0.65 * c.rel) * jitter())
    scored = [(_fit(c, level) * (0.35 + 0.65 * c.rel) * jitter(), c) for c in other]
    in_band = [c for s, c in sorted(scored, key=lambda p: -p[0]) if s > 1e-3]
    by_nearness = sorted(other, key=lambda c: (abs(c.dist - level), -c.rel * jitter()))
    per_artist = {}
    seen_titles = set()
    taken = set()
    chosen_known, chosen_other = [], []

    def take(src, dst, want, cap):
        for c in src:
            if len(dst) >= want:
                return
            if c.key in taken:
                continue
            a = _artist_key(c)
            if per_artist.get(a, 0) >= cap:
                continue
            title_key = _title_key(c)
            if title_key and title_key in seen_titles:
                continue
            per_artist[a] = per_artist.get(a, 0) + 1
            if title_key:
                seen_titles.add(title_key)
            taken.add(c.key)
            dst.append(c)

    n_known = min(len(known), int(round(n * known_share)))
    for cap in (PER_ARTIST + 1, 2 * PER_ARTIST + 1, n):
        take(ranked_known, chosen_known, n_known, cap)
    want = n - len(chosen_known)
    take(in_band, chosen_other, want, PER_ARTIST)
    take(in_band, chosen_other, want, 2 * PER_ARTIST)
    take(by_nearness, chosen_other, want, 2 * PER_ARTIST)
    take(by_nearness, chosen_other, want, n)
    if len(chosen_known) + len(chosen_other) < n:  # a thin library: what is left is known
        take(ranked_known, chosen_known, n - len(chosen_other), n)
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


def _title_key(c):
    return c.info and ("t:" + (c.info.get("artist") or "").lower() + "|" + (c.info.get("title") or "").lower())


def known_share(level) -> float:
    return KNOWN_AT_0 + (KNOWN_AT_1 - KNOWN_AT_0) * level


def flow(user, level, n=40, seed=None, exclude=()):
    taste = profile(user)
    rng = random.Random(f"{getattr(user, 'id', '')}:{seed}")  # nosec B311 - a seeded draw so a suggestion repeats, not a secret
    pool = track_candidates(user, taste, rng)
    _dedupe_library(pool)
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

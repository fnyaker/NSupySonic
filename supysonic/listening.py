# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A person's own listening history, and what it says about their taste.

The player reports every track change with how long the track played. That
was thrown away under 20 seconds and otherwise folded into
``Track.play_count`` — a counter shared by everybody on the server, so on a
family server each person's "taste" was the whole house's. It is now kept,
per person, in ``listen_event``, and judged by two published rules:

* a **listen** (+1) is the Last.fm scrobble rule: half the track or four
  minutes (https://www.last.fm/api/scrobbling);
* a **skip** (-1) is under 30 seconds; anything between says neither (not
  skipping is not a reliable positive signal: Schedl et al. 2018, §2.1).

How much a person likes a track is the base-level activation of ACT-R's
declarative memory, ``B = sum((t_now - t_i) ^ -d)`` over the times it was
heard, d = 0.5 (Reiter-Haas et al., RecSys 2021: the best single predictor
of relistening, frequency and recency in one number). The time unit does
not matter: scaling it scales every activation by the same factor.

Everything here is a read or one insert; nothing calls the network.
"""

import datetime
import logging
import random

from .db import ListenEvent, Track, now

logger = logging.getLogger(__name__)

#: Under this many seconds a track was skipped.
SKIP_UNDER = 30
#: A listen: this share of the track, or this many seconds (Last.fm).
LISTEN_SHARE = 0.5
LISTEN_SECONDS = 240
#: ACT-R's default decay.
DECAY = 0.5
#: A neutral play counts this much of a listen in the activation.
NEUTRAL_WEIGHT = 0.5
#: How far back the profile reads, and how long rows are kept.
HISTORY_DAYS = 365
KEEP_DAYS = 548
#: Skips are judged over this window.
SKIP_DAYS = 180
#: One insert in this many also prunes the rows past ``KEEP_DAYS``.
PRUNE_EVERY = 500
#: Rows read for one profile at most (the newest).
MAX_ROWS = 20000


def outcome(listened, duration) -> int:
    """+1 a listen, -1 a skip, 0 neither."""
    listened = max(0, int(listened or 0))
    duration = max(0, int(duration or 0))
    if 0 < duration <= SKIP_UNDER:  # Last.fm scrobbles nothing this short
        return 0 if listened >= duration * LISTEN_SHARE else -1
    if listened < SKIP_UNDER and (duration == 0 or listened < duration * 0.9):
        return -1
    if listened >= LISTEN_SECONDS or (duration > 0 and listened >= duration * LISTEN_SHARE):
        return 1
    return 0


def record(user, track, listened, source=None) -> int:
    """Keep one track change of ``user``'s; returns its outcome. Never raises:
    a statistics write must not break playback."""
    if user is None or track is None:
        return 0
    result = outcome(listened, getattr(track, "duration", 0))
    try:
        ListenEvent.create(
            user=user, track=track, at=now(), listened=max(0, min(int(listened or 0), 86400)),
            outcome=result, source=(str(source)[:16] if source else None),
        )
        if random.randrange(PRUNE_EVERY) == 0:  # nosec B311 - spreading a cleanup, not a secret
            prune()
    except Exception:
        logger.debug("Could not record a listen for %s", getattr(track, "id", None), exc_info=True)
    return result


def prune():
    cutoff = now() - datetime.timedelta(days=KEEP_DAYS)
    ListenEvent.delete().where(ListenEvent.at < cutoff).execute()


def activation(times, today, decay=DECAY) -> float:
    """ACT-R base-level activation of ``[(datetime, weight)]`` at ``today``,
    in hours (+1 so a play this second is finite)."""
    total = 0.0
    for when, weight in times:
        hours = max(0.0, (today - when).total_seconds() / 3600.0)
        total += weight * (hours + 1.0) ** -decay
    return total


class History:
    """What one person's log says: per track, the activation of its listens
    and its skip record; per artist and album, their tracks' sums."""

    def __init__(self):
        self.track = {}  # track id -> activation
        self.artist = {}
        self.album = {}
        self.plays = {}  # track id -> listens (+ neutrals) in the window
        self.skips = {}  # track id -> skips in the skip window
        self.artist_plays = {}
        self.artist_skips = {}
        self.last = {}  # track id -> last time heard (not a skip)
        self.events = 0

    def skip_ratio(self, tid) -> float:
        s = self.skips.get(tid, 0)
        if s < 2:
            return 0.0
        return s / (s + self.plays.get(tid, 0))

    def artist_skip_ratio(self, aid) -> float:
        s = self.artist_skips.get(aid, 0)
        if s < 4:
            return 0.0
        return s / (s + self.artist_plays.get(aid, 0))

    def rejected(self, tid) -> bool:
        """Skipped twice or more and never listened to."""
        return self.skips.get(tid, 0) >= 2 and self.plays.get(tid, 0) == 0


def history(user, today=None) -> History:
    """Read ``user``'s log (the newest ``MAX_ROWS`` rows of the last year) in
    one statement."""
    h = History()
    if user is None:
        return h
    today = today or now()
    since = today - datetime.timedelta(days=HISTORY_DAYS)
    skip_since = today - datetime.timedelta(days=SKIP_DAYS)
    rows = (
        ListenEvent.select(ListenEvent.track, ListenEvent.at, ListenEvent.outcome,
                           Track.artist, Track.album)
        .join(Track, on=(ListenEvent.track == Track.id))
        .where((ListenEvent.user == user) & (ListenEvent.at >= since))
        .order_by(ListenEvent.at.desc())
        .limit(MAX_ROWS)
        .tuples()
    )
    times = {}
    owner = {}
    for tid, at, out, aid, alid in rows:
        h.events += 1
        owner[tid] = (aid, alid)
        if out < 0:
            if at >= skip_since:
                h.skips[tid] = h.skips.get(tid, 0) + 1
                h.artist_skips[aid] = h.artist_skips.get(aid, 0) + 1
            continue
        w = 1.0 if out > 0 else NEUTRAL_WEIGHT
        times.setdefault(tid, []).append((at, w))
        h.plays[tid] = h.plays.get(tid, 0) + 1
        h.artist_plays[aid] = h.artist_plays.get(aid, 0) + 1
        if tid not in h.last or at > h.last[tid]:
            h.last[tid] = at
    for tid, ts in times.items():
        a = activation(ts, today)
        h.track[tid] = a
        aid, alid = owner[tid]
        h.artist[aid] = h.artist.get(aid, 0.0) + a
        h.album[alid] = h.album.get(alid, 0.0) + a
    return h


def top_artists(user, n, today=None):
    """``[artist id]`` of the artists ``user`` listens to most (activation)."""
    h = history(user, today)
    return [a for a, _ in sorted(h.artist.items(), key=lambda p: -p[1])[:n]]

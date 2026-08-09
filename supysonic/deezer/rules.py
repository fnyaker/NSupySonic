# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What gets archived, and — if the disk fills — what may go.

Every knob here is admin-editable at runtime from Réglages, because the right
answer depends on the disk: someone with 8 TB wants every artist's whole
discography, someone on a 256 GB VPS wants the five latest releases and a
cleanup rule. The defaults reproduce the behaviour that shipped before this
module existed, so an untouched server keeps working exactly as it did.

Values live one-per-row in the ``Meta`` key/value table (prefix ``dz.``) and
OVERRIDE the config file, same as the ARL: a setting you have to restart a
container to change isn't really a setting. Reads are cached for a second —
these are consulted on hot paths (every star, every play) and the table is tiny
but not free.

Nothing here decides *how* to archive; it only answers "should we?" and "which
of these may I delete first?". The doing is in ``backfill`` and ``cleanup``.
"""

from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger(__name__)

PREFIX = "dz."  # Meta.key is CharField(32): keep prefix + name under that

# -- what archiving reacts to ----------------------------------------------
# One switch per event, so "archive what I star but not the albums I favourite"
# is a configuration rather than a code change.
#
# There is deliberately NO "archive on play" switch. Playing a Deezer track
# writes the FLAC to the archive because that is how playback works here: the
# Opus transcode reads the archived master, and seeking reads the file. A switch
# that claimed to turn that off would be a lie. What IS optional is how far the
# play reaches — see `on_play_context`.
EVENTS = (
    "on_play_context",
    "on_fav_track",
    "on_fav_album",
    "on_fav_playlist",
    "on_fav_artist",
    "on_playlist_add",
    "on_podcast",
)

# How much of a favourited artist to take.
#   all      — the whole discography (the default; what a favourite means)
#   releases — the `artist_limit` most RECENT releases
#   top      — the artist's `artist_limit` most-played tracks
ARTIST_SCOPES = ("all", "releases", "top")

# Which candidate goes first when the cleanup has to free space.
#   oldest_play   — least recently played (a plain LRU; the safe default)
#   least_played  — fewest plays, ever
#   largest       — biggest files first (frees the most, fastest)
#   oldest        — archived longest ago
CLEANUP_ORDERS = ("oldest_play", "least_played", "largest", "oldest")

DEFAULTS = {
    # events. `on_play_context` is the aggressive one — playing one track pulls
    # the whole album or playlist it came from — so it is opt-in; the rest
    # reproduce the behaviour that shipped before this module existed.
    "on_play_context": False,
    "on_fav_track": True,
    "on_fav_album": True,
    "on_fav_playlist": True,
    "on_fav_artist": True,
    "on_playlist_add": True,
    "on_podcast": True,
    # artists
    "artist_scope": "all",
    "artist_limit": 5,
    # cleanup — OFF by default. This is the only thing in the whole app that
    # deletes archived audio, so it never starts working on its own.
    "clean_on": False,
    "clean_min_free_gb": 0.0,  # run only below this much free space (0 = never)
    "clean_stale_days": 180,  # and only for tracks untouched for this long
    "clean_keep_fav": True,
    "clean_keep_playlist": True,
    "clean_keep_podcast": True,
    "clean_order": "oldest_play",
}

_BOOLS = {k for k, v in DEFAULTS.items() if isinstance(v, bool)}
_INTS = {"artist_limit", "clean_stale_days"}
_FLOATS = {"clean_min_free_gb"}
_CHOICES = {"artist_scope": ARTIST_SCOPES, "clean_order": CLEANUP_ORDERS}

# Bounds. A limit of 0 releases would archive nothing while looking enabled, and
# an unbounded stale window lets a typo ("2 days") wipe a library.
_LIMITS = {
    "artist_limit": (1, 1000),
    "clean_stale_days": (7, 3650),
    "clean_min_free_gb": (0.0, 100000.0),
}

_cache = {"at": 0.0, "values": None}
_lock = threading.Lock()
CACHE_TTL = 1.0


def _coerce(key, raw):
    """One stored string back into its typed value, or None if it's junk."""
    if key in _BOOLS:
        return str(raw).strip().lower() in ("1", "true", "yes", "on")
    if key in _INTS:
        try:
            return int(float(raw))
        except (TypeError, ValueError):
            return None
    if key in _FLOATS:
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None
    if key in _CHOICES:
        value = str(raw).strip()
        return value if value in _CHOICES[key] else None
    return None


def clamp(key, value):
    """Keep a value inside the range that makes sense for it."""
    lo, hi = _LIMITS.get(key, (None, None))
    if lo is None:
        return value
    return max(lo, min(hi, value))


def _from_config(app) -> dict:
    """Config-file values, used where the database has nothing stored."""
    out = dict(DEFAULTS)
    try:
        cfg = app.config["DEEZER"]
    except Exception:
        return out
    for key in DEFAULTS:
        if key in cfg and cfg[key] is not None:
            value = _coerce(key, cfg[key])
            if value is not None:
                out[key] = clamp(key, value)
    return out


def invalidate() -> None:
    with _lock:
        _cache["at"] = 0.0
        _cache["values"] = None


def load(app) -> dict:
    """The effective settings: defaults < config file < database."""
    now = time.monotonic()
    with _lock:
        if _cache["values"] is not None and now - _cache["at"] < CACHE_TTL:
            return dict(_cache["values"])

    values = _from_config(app)
    try:
        from ..db import Meta

        for row in Meta.select().where(Meta.key.startswith(PREFIX)):
            key = row.key[len(PREFIX) :]
            if key not in DEFAULTS:
                continue
            parsed = _coerce(key, row.value)
            if parsed is not None:
                values[key] = clamp(key, parsed)
    except Exception:  # DB not ready, or mid-migration: config values stand
        logger.debug("Could not read the archive rules", exc_info=True)
        return values

    with _lock:
        _cache["values"] = dict(values)
        _cache["at"] = now
    return values


def save(updates: dict) -> dict:
    """Persist the recognised keys. Returns what was actually written.

    Unknown keys and unparseable values are ignored rather than rejected: this
    is fed by a form, and one stale field from an older client must not throw
    away the rest of the submission.
    """
    from ..db import Meta

    written = {}
    for key, raw in (updates or {}).items():
        if key not in DEFAULTS:
            continue
        value = _coerce(key, raw)
        if value is None:
            continue
        value = clamp(key, value)
        stored = "yes" if value is True else "no" if value is False else str(value)
        row = Meta.get_or_none(Meta.key == PREFIX + key)
        if row is None:
            Meta.create(key=PREFIX + key, value=stored)
        else:
            row.value = stored
            row.save()
        written[key] = value
    invalidate()
    return written


def enabled(app, event: str) -> bool:
    """Whether archiving should react to ``event``.

    ``archive_library`` stays the master switch: off means off, whatever the
    individual events say.
    """
    try:
        if not app.config["DEEZER"].get("archive_library", True):
            return False
    except Exception:
        pass
    return bool(load(app).get(event, True))

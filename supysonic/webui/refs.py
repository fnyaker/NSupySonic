# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Turning whatever id a client holds for a track into the track's row.

A client may address a track by its row UUID (the one id that every kind of
track has) or, as the web app has until now, by a Deezer id. Both resolve here,
from the database and nothing else: no call to Deezer, so a click that names a
track never waits on a network.

``resolve_tracks`` answers a whole list with at most two statements (the UUIDs
and the ids Deezer would have given them in one ``IN``, then the rows that
carry a Deezer id of their own), however long the list.
"""

import uuid

from ..db import Track
from ..deezer import ids

# Deezer's ids are far shorter than this; the bound only keeps a hostile string
# of digits from being hashed and queried.
_MAX_DEEZER_ID = 20


def _classify(raw):
    """``(uuid or None, deezer id or None)`` for a client-supplied id."""
    if raw is None:
        return None, None
    text = str(raw).strip()
    if not text or len(text) > 64:
        return None, None
    if text.isascii() and text.isdigit():
        if len(text) > _MAX_DEEZER_ID:
            return None, None
        return None, text
    try:
        return uuid.UUID(text), None
    except ValueError:
        return None, None


def track_key(track) -> str:
    """The id the clients address a track by from now on: its row UUID."""
    return str(track.id)


def _may_access(track):
    from . import _may_access_track

    return _may_access_track(track)


def resolve_tracks(raws):
    """The rows behind ``raws``, in order; ``None`` where an id is unknown,
    malformed or names a track the caller may not read."""
    raws = list(raws)
    parsed = [_classify(r) for r in raws]
    wanted = set()
    for u, d in parsed:
        if u is not None:
            wanted.add(u)
        elif d is not None:
            wanted.add(ids.track_uuid(d))
    by_id = {}
    if wanted:
        by_id = {t.id: t for t in Track.select().where(Track.id.in_(list(wanted)))}
    # An id Deezer gave a row that does not carry the derived UUID.
    missing = {d for (u, d) in parsed if d is not None and ids.track_uuid(d) not in by_id}
    by_deezer = {}
    if missing:
        by_deezer = {
            str(t.deezer_id): t
            for t in Track.select().where(Track.deezer_id.in_(list(missing)))
        }
    out = []
    for u, d in parsed:
        if u is not None:
            row = by_id.get(u)
        elif d is not None:
            row = by_id.get(ids.track_uuid(d)) or by_deezer.get(d)
        else:
            row = None
        out.append(row if row is not None and _may_access(row) else None)
    return out


def resolve_track(raw, *, materialize=False):
    """The row behind one id, or ``None``. With ``materialize`` an id that names
    a remembered YouTube hit gets its row made from what the search said (no
    request to YouTube)."""
    row = resolve_tracks([raw])[0]
    if row is not None or not materialize:
        return row
    u, _ = _classify(raw)
    if u is None:
        return None
    from .youtube import materialize as make

    row = make(u)
    return row if row is not None and _may_access(row) else None

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

import re
import uuid

from peewee import JOIN

from ..db import EntityRef, Track, TrackSource
from ..deezer import ids
from ..providers.base import ID_RE, REF_MAX

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


_REF_RE = re.compile(r"^[\w.\-~=+/@%%]{1,%d}$" % REF_MAX)


def _prefixed(raw):
    """``(provider, ref)`` for a client-supplied ``<provider>:<ref>``, else
    ``None``. Syntax only: the database answers whether it is known."""
    if raw is None:
        return None
    text = str(raw).strip()
    provider, sep, ref = text.partition(":")
    if not sep or not ID_RE.match(provider) or not _REF_RE.match(ref):
        return None
    return provider, ref


def track_key(track) -> str:
    """The id the clients address a track by from now on: its row UUID."""
    return str(track.id)


def _may_access(track):
    from . import _may_access_track

    return _may_access_track(track)


def resolve_tracks(raws):
    """The rows behind ``raws``, in order; ``None`` where an id is unknown,
    malformed or names a track the caller may not read. An id is a row UUID, a
    Deezer id or ``<provider>:<ref>``."""
    raws = list(raws)
    parsed = []
    for r in raws:
        pref = _prefixed(r)
        if pref is not None and pref[0] == "deezer":
            # "deezer:123" is the Deezer id 123, whatever else it might be.
            u, d = _classify(pref[1])
            parsed.append((None, d, None) if d else (None, None, None))
        elif pref is not None:
            parsed.append((None, None, pref))
        else:
            parsed.append(_classify(r) + (None,))
    wanted = set()
    for u, d, pref in parsed:
        if u is not None:
            wanted.add(u)
        elif d is not None:
            wanted.add(ids.track_uuid(d))
        elif pref is not None:
            wanted.add(ids.entity_uuid(pref[0], "track", pref[1]))
    by_id = {}
    if wanted:
        by_id = {t.id: t for t in Track.select().where(Track.id.in_(list(wanted)))}
    # What the derived UUID did not find: an id Deezer gave a row that does not
    # carry the derived UUID, or a provider's record attached to another title.
    missing = {d for (u, d, p) in parsed if d is not None and ids.track_uuid(d) not in by_id}
    pairs = {}
    for u, d, pref in parsed:
        if pref is not None and ids.entity_uuid(pref[0], "track", pref[1]) not in by_id:
            pairs.setdefault(pref[0], set()).add(pref[1])
    by_deezer = {}
    by_pair = {}
    if missing or pairs:
        cond = None
        if missing:
            cond = Track.deezer_id.in_(list(missing))
        for provider, refs in pairs.items():
            part = (TrackSource.provider == provider) & TrackSource.ref.in_(list(refs))
            cond = part if cond is None else (cond | part)
        # ONE statement for both: the rows by their legacy column, and by the
        # source that names them.
        query = (
            Track.select(Track, TrackSource.provider.alias("_p"), TrackSource.ref.alias("_r"))
            .join(TrackSource, JOIN.LEFT_OUTER, on=(TrackSource.track == Track.id))
            .where(cond)
            .objects()
        )
        for t in query:
            if t.deezer_id is not None and str(t.deezer_id) in missing:
                by_deezer[str(t.deezer_id)] = t
            if getattr(t, "_p", None) is not None:
                by_pair[(t._p, t._r)] = t
    out = []
    for u, d, pref in parsed:
        if u is not None:
            row = by_id.get(u)
        elif d is not None:
            row = by_id.get(ids.track_uuid(d)) or by_deezer.get(d)
        elif pref is not None:
            row = by_id.get(ids.entity_uuid(pref[0], "track", pref[1])) or by_pair.get(pref)
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


def resolve_ref(provider, kind, ref):
    """The UUID of the row ``provider``'s ``ref`` is (or will be). What the
    database knows wins (a record found again under another provider is the
    title already owned, plan §4); otherwise the deterministic UUID, so a search
    result plays before it has a row."""
    ref = str(ref)
    if kind == "track":
        row = TrackSource.select(TrackSource.track).where(
            (TrackSource.provider == provider) & (TrackSource.ref == ref)
        ).first()
        if row is not None:
            return row.track_id
    else:
        row = EntityRef.select(EntityRef.entity).where(
            (EntityRef.kind == kind) & (EntityRef.provider == provider) & (EntityRef.ref == ref)
        ).first()
        if row is not None:
            return row.entity
    return ids.entity_uuid(provider, kind, ref)


def drop_entity(kind, entity):
    """A row was deleted: forget the provider refs that named it."""
    from ..sources import drop_entity as drop

    return drop(kind, entity)


def cover_url_for(album_id) -> str:
    """The same-origin cover route of an album row: ``/api/cover/<album uuid>``.

    Built from the id the list query already selected (a UUID or its 32 hex
    characters), so no row costs a statement of its own. ``cover_response``
    decides what to serve."""
    text = str(album_id)
    if len(text) == 32 and "-" not in text:
        text = f"{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}"
    return "/api/cover/" + text


def canonical(raw):
    """The id a route that works on Deezer ids should use for `raw`.

    A row UUID whose track carries a Deezer id becomes that id (one primary-key
    read, no network), so a client holding the UUID is answered exactly as one
    holding the Deezer id; everything else (a Deezer id, a local upload, a
    YouTube row, anything malformed) comes back untouched."""
    u, _ = _classify(raw)
    if u is None:
        return raw
    row = Track.select(Track.deezer_id, Track.owner).where(Track.id == u).first()
    if row is None or row.deezer_id is None or not _may_access(row):
        return raw
    return str(row.deezer_id)

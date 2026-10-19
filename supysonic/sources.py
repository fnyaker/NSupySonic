# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The sources of a title: which providers can deliver it, under which ref.

``attach`` is the ONE point that writes a source. It also writes the legacy
``deezer_id`` / ``youtube_id`` column (never removed, still read everywhere), in
the same transaction. Lists never read ``track_source``: it is for the search,
a track's sheet and the choice of what to play, asked by id and never per row.
"""

import logging

from peewee import IntegrityError

from .db import EntityRef, Track, TrackSource, db, now

logger = logging.getLogger(__name__)

# The legacy column each of the two historical providers also fills.
LEGACY_COLUMNS = {"deezer": "deezer_id", "youtube": "youtube_id"}

# Under SQLite's old 999-variable limit, and a whole queue (200) in one query.
_CHUNK = 500


def _track_id(track):
    return getattr(track, "id", track)


def attach(track, provider, ref, offer=None):
    """Record that ``provider`` delivers ``track`` as ``ref``. Idempotent: the
    same call twice is one row, and an ``offer`` refreshes what is known of the
    quality. A ref already owned by ANOTHER track is left alone (a provider's
    record belongs to one title) and that row is returned.
    """
    ref = str(ref)
    tid = _track_id(track)
    fields = {}
    for key in ("quality", "fmt", "bitrate"):
        if offer and offer.get(key) is not None:
            fields[key] = offer[key]
    with db.atomic():
        row = TrackSource.get_or_none(
            (TrackSource.provider == provider) & (TrackSource.ref == ref)
        )
        if row is None:
            try:
                with db.atomic():
                    row = TrackSource.create(
                        track=tid, provider=provider, ref=ref, added=now(), **fields
                    )
            except IntegrityError:
                row = TrackSource.get_or_none(
                    (TrackSource.provider == provider) & (TrackSource.ref == ref)
                )
                if row is None:
                    raise
        elif row.track_id == tid:
            changed = {k: v for k, v in fields.items() if getattr(row, k) != v}
            if changed:
                TrackSource.update(**changed).where(
                    (TrackSource.provider == provider) & (TrackSource.ref == ref)
                ).execute()
                for k, v in changed.items():
                    setattr(row, k, v)
        else:
            logger.warning(
                "source %s:%s belongs to another track, not attached", provider, ref
            )
            return row
        column = LEGACY_COLUMNS.get(provider)
        if column is not None and row.track_id == tid:
            # Only fills a column that is empty: a title keeps the first id it
            # was given there, the second one lives in track_source alone.
            if getattr(track, column, None) is None:
                Track.update(**{column: ref}).where(
                    (Track.id == tid) & (getattr(Track, column).is_null())
                ).execute()
                if isinstance(track, Track):
                    setattr(track, column, ref)
    return row


def _as_dict(row):
    return {
        "provider": row.provider,
        "ref": row.ref,
        "quality": row.quality,
        "fmt": row.fmt,
        "bitrate": row.bitrate,
        "added": row.added,
        "seen": row.seen,
        "unavailable": row.unavailable,
    }


def for_track(track):
    """The sources of one track, oldest first (a list of dicts)."""
    query = (
        TrackSource.select()
        .where(TrackSource.track == _track_id(track))
        .order_by(TrackSource.added, TrackSource.provider)
    )
    return [_as_dict(r) for r in query]


def for_tracks(track_ids):
    """``{track id: [source, ...]}`` for many tracks in ONE statement (per 500
    ids). A track without a source is absent from the answer."""
    ids = list({_track_id(t) for t in track_ids})
    out = {}
    for i in range(0, len(ids), _CHUNK):
        query = (
            TrackSource.select()
            .where(TrackSource.track.in_(ids[i : i + _CHUNK]))
            .order_by(TrackSource.added, TrackSource.provider)
        )
        for row in query:
            out.setdefault(row.track_id, []).append(_as_dict(row))
    return out


def mark_gone(track, provider):
    """``provider`` ANSWERED that its record is gone: that source is unavailable
    from now on. Never called on a failure to reach it. Returns the rows marked."""
    return (
        TrackSource.update(unavailable=now())
        .where((TrackSource.track == _track_id(track)) & (TrackSource.provider == provider))
        .execute()
    )


def clear_gone(track, provider=None):
    """Forget the verdict (the file arrived, or the provider has it again)."""
    cond = (TrackSource.track == _track_id(track)) & (TrackSource.unavailable.is_null(False))
    if provider is not None:
        cond &= TrackSource.provider == provider
    return TrackSource.update(unavailable=None).where(cond).execute()


def attach_new(track, provider, ref):
    """``attach`` for a row that was JUST created from this very ``ref`` (the
    importers): one ``INSERT ... ignoring a conflict``, nothing read first, so
    a first import costs one statement more per track, not five. The legacy
    column is already written by whoever created the row."""
    TrackSource.insert(
        track=_track_id(track), provider=provider, ref=str(ref), added=now()
    ).on_conflict_ignore().execute()


def attach_entity(kind, provider, ref, entity):
    """Remember that ``provider``'s ``ref`` is the album / artist / playlist /
    show ``entity``. Idempotent, one statement; the first mapping of a ref wins."""
    EntityRef.insert(
        kind=kind, provider=provider, ref=str(ref), entity=entity
    ).on_conflict_ignore().execute()


def drop_entity(kind, entity):
    """A row was deleted: forget the refs that pointed at it."""
    return EntityRef.delete().where(
        (EntityRef.kind == kind) & (EntityRef.entity == entity)
    ).execute()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The library-wide catch-up: every archived track not yet tried (or whose try
is old enough to be worth another), through the same decision as the queue."""

import logging
import threading

from peewee import fn

from ..db import Track, TrackEnrichment
from ..libjob import LibraryJob, resume_if_interrupted as _resume
from . import queue as _queue

logger = logging.getLogger(__name__)

CURSOR_KEY = "enrich_cursor"


def _archived():
    return (Track.last_modification > 0) & Track.unavailable.is_null(True)


def make_job(force=False):
    def work(track):
        status, method, reason = _queue.enrich_track(track, force=force)
        # A track MusicBrainz does not know is an answer, not a failure; only a
        # failed ask is, and it is named by its cause.
        return reason if status == "error" else None

    return LibraryJob(
        "enrich", Track.select().where(_archived()), work,
        cursor_key=CURSOR_KEY, force=force,
    )


def run(app, job):
    from ..db import close_connection, open_connection

    with app.app_context():
        try:
            open_connection(reuse=True)
            job.run()
        finally:
            try:
                close_connection()
            except Exception:
                logger.debug("enrich: closing the connection failed", exc_info=True)


def resume_if_interrupted(app):
    return _resume(app, {CURSOR_KEY: make_job})


def total():
    return Track.select().where(_archived()).count()


def coverage():
    """How the archived library stands: counts by status, and by method for
    what was found, plus the tracks never tried."""
    q = (
        TrackEnrichment.select(
            TrackEnrichment.status, TrackEnrichment.method, fn.COUNT(TrackEnrichment.track)
        )
        .group_by(TrackEnrichment.status, TrackEnrichment.method)
        .tuples()
    )
    status, found = {}, {}
    for st, method, n in q:
        status[st] = status.get(st, 0) + n
        if st == "done":
            found[method] = found.get(method, 0) + n
    tried = sum(status.values())
    return {
        "status": status, "found": found, "tried": tried,
        "untried": max(0, total() - tried),
    }


def start(app, job):
    threading.Thread(
        target=run, args=(app, job), name="enrich-backfill", daemon=True
    ).start()

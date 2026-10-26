# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The enrichment worker: a bounded queue, one thread niced behind everything.

A track is queued when it becomes ours (archived, uploaded). ``queue_track``
never waits and never raises; a full queue drops the request (the library
catch-up, ``backfill.py``, is the safety net). What was tried, and how it ended,
is a ``TrackEnrichment`` row, so nothing is asked twice for nothing.
"""

import datetime
import logging
import queue
import threading

from .. import trackcredits
from ..db import Track, TrackEnrichment, close_connection, now, open_connection
from . import acoustid, cover, musicbrainz as mb, search, settings as _settings
from .http import HttpError, Unavailable

logger = logging.getLogger(__name__)

#: A track MusicBrainz does not know is asked about again after this long.
NOMATCH_RETRY = datetime.timedelta(days=30)
#: A transport failure is retried after this long (the catch-up retries it too).
ERROR_RETRY = datetime.timedelta(days=1)

_queue = queue.Queue(maxsize=512)
_worker = None
_worker_lock = threading.Lock()
_http = None
_options = _settings()


def configure(config):
    """Remember the ``[enrich]`` options (the worker has no app context)."""
    global _options, _http
    _options = _settings(config)
    _http = None


def options():
    return _options


def get_http():
    global _http
    if _http is None:
        from .http import Http

        _http = Http(_options.get("contact"))
    return _http


def _under_test():
    try:
        from flask import current_app, has_app_context

        return bool(has_app_context() and current_app.testing)
    except Exception:
        return False


def queue_track(track_id):
    """Queue a track for enrichment. Never blocks, never raises."""
    try:
        if _under_test() or not _options.get("enabled"):
            return False
        _queue.put_nowait(track_id)
    except queue.Full:
        return False
    except Exception:
        return False
    _ensure_worker()
    return True


def _ensure_worker():
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_drain, name="enrich", daemon=True)
        _worker.start()


def _drain():
    from ..deezer.workload import quiet_wait, renice

    renice(12)
    while True:
        try:
            tid = _queue.get(timeout=30)
        except queue.Empty:
            return
        try:
            open_connection(reuse=True)
            quiet_wait(1.0)
            track = Track.get_or_none(Track.id == tid)
            if track is not None:
                enrich_track(track)
        except Exception:
            logger.warning("enrich: could not enrich %s", tid, exc_info=True)
        finally:
            try:
                close_connection()
            except Exception:
                logger.debug("enrich: closing the connection failed", exc_info=True)


# -- one track ----------------------------------------------------------------------


def _fresh(prior):
    if prior is None:
        return False
    age = now() - prior.tried
    if prior.status == "error":
        return age < ERROR_RETRY
    return age < NOMATCH_RETRY if prior.status == "nomatch" else True


def _record(track, status, method, mbid=None, error=None):
    fields = {
        "status": status, "method": method, "mbid": mbid, "tried": now(),
        "error": (str(error)[:255] if error else None),
    }
    if TrackEnrichment.update(**fields).where(TrackEnrichment.track == track).execute():
        return
    try:
        TrackEnrichment.create(track=track, **fields)
    except Exception:  # lost a race with the other writer: its row is as good
        logger.debug("enrich: row for %s already there", track.id)


def _known_isrc(track):
    from ..deezer import library
    from ..filetags import read_file_facts

    value = (library.read_track_facts(track).get("isrc") or {}).get("value")
    return mb.clean_isrc(value) or mb.clean_isrc(read_file_facts(track.path).get("isrc"))


def enrich_track(track, *, http=None, force=False):
    """Try ISRC, then AcoustID, then a strict search, and write what was found
    into the sidecar's ``facts``. Returns ``(status, method, reason)``;
    ``status`` is ``done``, ``nomatch``, ``error`` or ``skipped``. Never raises
    for the network: ``Unavailable`` is an ``error`` row, retried later."""
    import os

    from ..deezer import library

    opts = _options
    if not opts.get("enabled") or not track.path or not os.path.isfile(track.path):
        return "skipped", "none", "not on disk"
    prior = TrackEnrichment.get_or_none(TrackEnrichment.track == track)
    if not force and _fresh(prior):
        return "skipped", prior.method, "already tried"
    http = http or get_http()
    duration = track.duration or None
    key = opts.get("acoustid_key")
    method = "none"
    try:
        found = None
        isrc = _known_isrc(track)
        if isrc:
            method = "isrc"
            found = mb.lookup_isrc(http, isrc, duration)
        if found is None and acoustid.available(key):
            method = "acoustid"
            fp = acoustid.fingerprint(track.path)
            mbid = acoustid.lookup(http, key, *fp) if fp else None
            found = _by_mbid(http, mbid) if mbid else None
        if found is None and track.artist is not None:
            method = "search"
            found = search.find(http, track.title, track.artist.name, duration)
        if found is None:
            _record(track, "nomatch", method)
            return "nomatch", method, None
        extra = mb.credits(http, found["mbid"])
        # What the fingerprint says is weaker than what an ISRC says.
        source = "acoustid" if method == "acoustid" else "musicbrainz"
        library.update_track_facts(track, mb.facts_of(found, extra), source)
        trackcredits.store(track.id, trackcredits.from_musicbrainz(extra), "musicbrainz")
        _cover(track, found, http)
        _record(track, "done", method, found["mbid"])
        return "done", method, None
    except Unavailable as exc:
        _record(track, "error", method, error=exc)
        return "error", method, str(exc)
    except HttpError as exc:
        _record(track, "error", method, error=exc)
        return "error", method, str(exc)


def _by_mbid(http, mbid):
    """A summary for a recording AcoustID named (the id is all it gave)."""
    data = http.get_json(f"{mb.BASE}/recording/{mbid}", {"inc": "releases", "fmt": "json"})
    return mb.summarize(data) if data else None


def _cover(track, found, http):
    """An upload with no picture gets the release's front cover, best effort."""
    from ..deezer import library

    try:
        if not found.get("release") or not cover.wanted(track):
            return
        data = cover.front(http, found["release"])
        if data and library.save_album_cover(track.folder, data):
            track.has_art = True
            track.save()
    except Exception:  # a missing picture never turns a found track into a failure
        logger.debug("enrich: cover failed for %s", track.id, exc_info=True)

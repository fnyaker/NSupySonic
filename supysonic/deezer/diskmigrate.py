# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Bring the archives already on disk to the format the detachment writes.

Since the detachment an archive no longer carries Deezer's loudness (the gain is
measured from the file), its ReplayGain tag, its rank or its provider ids, and
its sidecar has a ``facts`` block (``library.update_track_facts``). The files
archived before that still have the old shape. This job rewrites them, once:

* the sidecar loses the excluded fields and gains its facts (the oldest release
  date, the ISRC, the label, Deezer's published tempo when it is known);
* the file loses its ``REPLAYGAIN_TRACK_GAIN`` and takes the oldest release date
  when it carried a later one — rewritten **outside the published file**, then
  ``os.replace``d over it, exactly like ``archive._tag_archive`` (a track being
  played is never read half-written, and an open handle keeps the old inode);
* a track Deezer was never asked the tempo of is asked, one public request at a
  time, at the pace of a bulk job and behind any foreground archive.

It is idempotent (a second run finds nothing to do and writes nothing), fail-soft
per track, resumable (``libjob.LibraryJob``'s checkpoint) and never needs Deezer:
an unreachable Deezer only leaves the tempo to be learnt later, by the analysis.
"""

import logging
import os
import shutil
import threading
import time

from ..db import Track, close_connection, open_connection
from ..libjob import LibraryJob
from . import library
from .workload import quiet_wait

logger = logging.getLogger(__name__)

CURSOR_KEY = "disk_migrate"
#: Fields of the sidecar's ``gw`` block the detachment no longer keeps.
DROPPED_GW = ("GAIN", "RANK_SNG", "PROVIDER_ID", "LYRICS_ID")
#: Between two public requests for a tempo (the API is shared with search).
BPM_PAUSE = 0.25
#: Tag names of the ReplayGain that used to be written from Deezer's GAIN.
_RG_VORBIS = ("replaygain_track_gain",)
_RG_ID3_DESC = "REPLAYGAIN_TRACK_GAIN"

_lock = threading.Lock()
_job = None
_counts = {"sidecar": 0, "tags": 0, "bpm": 0, "bpm_unreachable": 0, "unchanged": 0}


def _new_counts():
    return {"sidecar": 0, "tags": 0, "bpm": 0, "bpm_unreachable": 0, "unchanged": 0}


# -- the sidecar ------------------------------------------------------------


def cleaned_sidecar(data: dict) -> dict:
    """``data`` in the current format: no gain, no dropped ``gw`` fields."""
    new = {k: v for k, v in data.items() if k != "gain"}
    gw = new.get("gw")
    if isinstance(gw, dict):
        new["gw"] = {k: v for k, v in gw.items() if k not in DROPPED_GW}
    return new


def _migrate_sidecar(track) -> bool:
    """Rewrite the sidecar in the new format. True when the file changed."""
    data = library.read_track_metadata(track)
    if data is None:
        # An archive made without one: describe it from the row.
        return library.save_track_metadata(track, {}) is not None
    new = cleaned_sidecar(data)
    changed = False
    if new != data:
        if not library._write_sidecar(library.metadata_path(track), new):
            raise OSError("cannot write the sidecar")
        changed = True
    gw = new.get("gw") if isinstance(new.get("gw"), dict) else {}
    if library.update_track_facts(track, library.deezer_facts(track, gw), "deezer"):
        changed = True
    return changed


# -- the tags ---------------------------------------------------------------


def _release_date(track):
    data = library.read_track_metadata(track) or {}
    gw = data.get("gw") if isinstance(data.get("gw"), dict) else {}
    return library.release_date_of(gw)


def _older(candidate, current) -> bool:
    return bool(candidate) and (not current or candidate < str(current)[:10])


def _edit_tags(path: str, release_date, *, write: bool, suffix: str = None) -> bool:
    """Drop Deezer's ReplayGain tag and take the oldest date, on ``path``.

    With ``write`` False only says whether there is anything to change. The
    format is read from ``suffix`` when the file is staged under another name."""
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3
    from mutagen.id3 import error as ID3Error

    suffix = (suffix or os.path.splitext(path)[1]).lower()
    if suffix == ".flac":
        audio = FLAC(path)
        changed = False
        for key in _RG_VORBIS:
            if key in audio:
                changed = True
                if write:
                    del audio[key]
        current = (audio.get("date") or [None])[0]
        if _older(release_date, current):
            changed = True
            if write:
                audio["date"] = release_date
        if changed and write:
            audio.save()
        return changed
    if suffix == ".mp3":
        try:
            tags = ID3(path)
        except ID3Error:
            return False
        frame = f"TXXX:{_RG_ID3_DESC}"
        changed = frame in tags
        if write and changed:
            tags.delall(frame)
        if changed and write:
            tags.save(path)
        return changed
    # Another container (a YouTube row is never here): not ours to rewrite.
    return False


def _migrate_tags(track) -> bool:
    path = track.path
    release_date = _release_date(track)
    if not _edit_tags(path, release_date, write=False):
        return False
    dirname, base = os.path.split(path)
    staged = os.path.join(dirname, f".{base}.migrating")
    try:
        shutil.copy2(path, staged)
        _edit_tags(staged, release_date, write=True, suffix=os.path.splitext(path)[1])
        os.replace(staged, path)
    finally:
        try:
            os.remove(staged)
        except OSError:
            pass
    return True


# -- Deezer's tempo ---------------------------------------------------------


def _migrate_bpm(track, provider) -> str:
    """"" (nothing to do), "got" or "unreachable"."""
    from . import analysis

    if provider is None or track.deezer_bpm is not None:
        return ""
    quiet_wait(2.0)
    bpm, answered = analysis.deezer_bpm_for(provider, track)
    if not answered:
        return "unreachable"
    if BPM_PAUSE:
        time.sleep(BPM_PAUSE)
    return "got"


# -- the job ----------------------------------------------------------------


def migrate_track(track, provider=None):
    """Bring one archive to the current format. Returns a failure reason or None."""
    if not track.path or not os.path.isfile(track.path):
        return None  # nothing on disk, nothing to migrate
    did = False
    if _migrate_sidecar(track):
        _counts["sidecar"] += 1
        did = True
    try:
        if _migrate_tags(track):
            _counts["tags"] += 1
            did = True
    except Exception as exc:  # a file we cannot tag stays as it was
        return f"tags: {type(exc).__name__}: {exc}"
    bpm = _migrate_bpm(track, provider)
    if bpm == "got":
        _counts["bpm"] += 1
        did = True
    elif bpm == "unreachable":
        _counts["bpm_unreachable"] += 1
    if not did:
        _counts["unchanged"] += 1
    return None


def make_job(provider=None, force=False):
    query = Track.select().where(Track.deezer_id.is_null(False), Track.last_modification > 0)
    return LibraryJob(
        "disk-migrate",
        query,
        lambda track: migrate_track(track, provider),
        cursor_key=CURSOR_KEY,
        force=force,
    )


def status() -> dict:
    with _lock:
        job = _job
        counts = dict(_counts)
    snap = job.snapshot() if job is not None else {
        "name": "disk-migrate", "running": False, "done": 0, "failed": 0,
        "failures": [], "failure_reasons": {}, "error": None,
    }
    return {**snap, "counts": counts}


def running() -> bool:
    return bool(_job is not None and _job.snapshot()["running"])


def _run(app, job):
    with app.app_context():
        try:
            open_connection(reuse=True)
            job.run()
        except Exception:
            logger.warning("Disk migration crashed", exc_info=True)
        finally:
            try:
                close_connection()
            except Exception:
                pass


def start(app, force=False, *, wait=False):
    """Start the migration on a daemon thread; a no-op while one is running."""
    global _job, _counts
    with _lock:
        if _job is not None and _job.snapshot()["running"]:
            return False
        provider = getattr(app, "deezer", None)
        _job = make_job(provider, force)
        _counts = _new_counts()
        job = _job
        # Marked running now, so a poll right after the POST already says so.
        job._stats["running"] = True
    t = threading.Thread(target=_run, args=(app, job), name="disk-migrate", daemon=True)
    t.start()
    if wait:
        t.join()
    return True


#: Let the server finish coming up before a library job takes the disk.
RESUME_DELAY = 45


def resume_if_interrupted(app):
    """Pick the migration back up after a restart that cut it short."""

    def go():
        time.sleep(RESUME_DELAY)
        with app.app_context():
            try:
                open_connection(reuse=True)
                fresh = make_job()._checkpoint_read() is not None
                forced = make_job(force=True)._checkpoint_read() is not None
            except Exception:
                logger.debug("Could not read the migration checkpoint", exc_info=True)
                return
            finally:
                try:
                    close_connection()
                except Exception:
                    pass
        if fresh or forced:
            logger.info("Resuming the interrupted archive migration")
            start(app, force=forced and not fresh)

    threading.Thread(target=go, name="disk-migrate-resume", daemon=True).start()

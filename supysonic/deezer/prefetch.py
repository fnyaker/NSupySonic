# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Background pre-fetching of upcoming Deezer tracks.

When a client opens an album/playlist or plays a track, the next few not-yet
archived Deezer tracks are queued and fetched ahead of time by a small pool of
worker threads, so playback of the following track starts instantly. Fetching
reuses ``ensure_archived`` (idempotent and locked per track id), so a prefetch
in flight and a live play never download the same track twice.
"""

from __future__ import annotations

import logging
import os.path
import queue
import threading

logger = logging.getLogger(__name__)


class DeezerPrefetcher:
    def __init__(self, provider, workers: int = 2, max_queue: int = 256):
        self.provider = provider
        self._queue: queue.Queue = queue.Queue(maxsize=max_queue)
        self._seen: set = set()
        self._lock = threading.Lock()
        self._workers = []
        for _ in range(max(1, workers)):
            t = threading.Thread(target=self._worker, name="deezer-prefetch", daemon=True)
            t.start()
            self._workers.append(t)

        # Separate, unbounded queue for explicit "download this playlist now"
        # requests (archive the whole thing ahead of any playback).
        self._dl_queue: queue.Queue = queue.Queue()
        dl = threading.Thread(target=self._dl_worker, name="deezer-download", daemon=True)
        dl.start()
        self._workers.append(dl)

    def enqueue(self, track) -> None:
        """Queue a single Track for background archiving (best-effort)."""
        if track is None or not getattr(track, "deezer_id", None):
            return
        try:
            if os.path.isfile(track.path):
                return
        except (TypeError, ValueError):
            return
        tid = track.id
        with self._lock:
            if tid in self._seen:
                return
            self._seen.add(tid)
        try:
            self._queue.put_nowait(tid)
        except queue.Full:
            with self._lock:
                self._seen.discard(tid)

    def enqueue_many(self, tracks, limit: int) -> None:
        n = 0
        for t in tracks:
            if n >= limit:
                break
            self.enqueue(t)
            n += 1

    def download_ids(self, deezer_ids) -> int:
        """Queue Deezer track ids for full background archiving. Returns count."""
        n = 0
        for did in deezer_ids:
            did = str(did)
            if not did:
                continue
            self._dl_queue.put(did)
            n += 1
        return n

    @property
    def download_pending(self) -> int:
        return self._dl_queue.qsize()

    def _dl_worker(self) -> None:
        from ..db import db
        from .archive import ensure_archived, import_track

        try:
            db.connect(reuse_if_open=True)
        except Exception:  # pragma: no cover - connection setup best-effort
            pass

        while True:
            did = self._dl_queue.get()
            try:
                if did is None:
                    return
                track = import_track(self.provider, did)
                ensure_archived(self.provider, track)
            except Exception as exc:
                logger.info("Download failed for Deezer track %s: %s", did, exc)
            finally:
                self._dl_queue.task_done()

    def _worker(self) -> None:
        from ..db import Track, db
        from .archive import ensure_archived

        try:
            db.connect(reuse_if_open=True)
        except Exception:  # pragma: no cover - connection setup best-effort
            pass

        while True:
            tid = self._queue.get()
            try:
                if tid is None:
                    return
                track = Track[tid]
                ensure_archived(self.provider, track)
            except Exception as exc:
                logger.info("Prefetch failed for track %s: %s", tid, exc)
            finally:
                with self._lock:
                    self._seen.discard(tid)
                self._queue.task_done()

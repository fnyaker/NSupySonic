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
    def __init__(
        self,
        provider,
        workers: int = 2,
        max_queue: int = 256,
        dl_workers: int = 4,
        max_download_queue: int = 5000,
    ):
        self.provider = provider
        self._queue: queue.Queue = queue.Queue(maxsize=max_queue)
        self._seen: set = set()
        self._lock = threading.Lock()
        self._workers = []
        for _ in range(max(1, workers)):
            t = threading.Thread(target=self._worker, name="deezer-prefetch", daemon=True)
            t.start()
            self._workers.append(t)

        # Separate queue for explicit "download this playlist now" requests
        # (archive the whole thing ahead of any playback). Served by a small
        # POOL of workers so a full album/playlist downloads several tracks at
        # once instead of trickling through a single thread — each track is
        # still serialized per id by ``ensure_archived``'s per-track lock, so
        # parallel workers never fetch the same track twice.
        #
        # BOUNDED: it used to have no maxsize, and every entry means a full FLAC
        # (20-60 MB) landing on disk, so any logged-in account could loop
        # POST /api/download and fill the volume — taking the database and the
        # transcode cache down with it. Past the cap, extra ids are refused and
        # reported back to the caller instead of being queued.
        self._dl_queue: queue.Queue = queue.Queue(maxsize=max_download_queue)
        for _ in range(max(1, dl_workers)):
            dl = threading.Thread(
                target=self._dl_worker, name="deezer-download", daemon=True
            )
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

    def _offer(self, item) -> bool:
        """Queue one download, or refuse it when the queue is full."""
        try:
            self._dl_queue.put_nowait(item)
            return True
        except queue.Full:
            logger.info("Download queue full, dropping %s", item)
            return False

    def download_ids(self, deezer_ids) -> int:
        """Queue Deezer track ids for full background archiving.

        Returns how many were actually accepted — the caller reports that back,
        so a client that overruns the queue sees it instead of silently
        believing everything is downloading.
        """
        n = 0
        for did in deezer_ids:
            did = str(did)
            if not did:
                continue
            if not self._offer(did):
                break
            n += 1
        return n

    def download_episode_ids(self, episode_ids) -> int:
        """Queue podcast episode UUIDs for background archiving. Returns count.

        Shares the download queue with tracks; the worker tells the two apart by
        shape (a bare string is a Deezer track id, a tuple is tagged).
        """
        n = 0
        for eid in episode_ids:
            eid = str(eid)
            if not eid:
                continue
            if not self._offer(("episode", eid)):
                break
            n += 1
        return n

    @property
    def download_pending(self) -> int:
        return self._dl_queue.qsize()

    def _dl_worker(self) -> None:
        from ..db import PodcastEpisode, db
        from .archive import (
            ensure_archived,
            ensure_episode_archived,
            find_local_track,
            import_track,
        )

        try:
            db.connect(reuse_if_open=True)
        except Exception:  # pragma: no cover - connection setup best-effort
            pass

        while True:
            item = self._dl_queue.get()
            try:
                if item is None:
                    return
                if isinstance(item, tuple):  # ("episode", uuid)
                    _, eid = item
                    ensure_episode_archived(self.provider, PodcastEpisode[eid])
                    continue
                # Cheap DB lookup first (no network): if we already imported this
                # track, reuse the row and let ensure_archived skip the audio when
                # the file is on disk — so an already-archived track costs nothing.
                # Only hit Deezer for metadata when the track is genuinely new.
                track = find_local_track(item) or import_track(self.provider, item)
                ensure_archived(self.provider, track)
            except Exception as exc:
                logger.info("Background download failed for %s: %s", item, exc)
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

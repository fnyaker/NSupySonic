# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A resumable job over a whole table, for the library-wide background work.

Same shape as the analysis walk (``deezer/analysis.py#_walk_library``): keyset
pagination by primary key, a cursor checkpointed in ``Meta`` after every page,
a bounded ledger of failures that names their causes, and a ``snapshot()`` a
status route can copy while the worker thread is still appending to it.
``analysis.py`` is deliberately not migrated onto this.
"""

import copy
import json
import logging
import os
import threading
import time

from .db import Meta

logger = logging.getLogger(__name__)

PAGE_SIZE = 200
#: How long a checkpoint is worth resuming from; past this, start over.
RESUME_MAX_AGE = 7 * 24 * 3600
#: Failures remembered one by one; the tally of causes is complete.
FAILURE_SAMPLE_MAX = 40


class LibraryJob:
    """``work_fn(row)`` returns None on success or a reason string for a failure
    (raising is a failure too, with the exception as the reason).

    ``select_query`` is a peewee query on one model; rows are walked in primary
    key order. ``cursor_key`` is the ``Meta`` key (32 characters at most).
    """

    def __init__(self, name, select_query, work_fn, *, cursor_key, force=False,
                 page_size=PAGE_SIZE):
        if len(cursor_key) > 32:
            raise ValueError("cursor_key must fit Meta.key (32 characters)")
        self.name = name
        self.query = select_query
        self.work = work_fn
        self.cursor_key = cursor_key
        self.force = bool(force)
        self.page_size = page_size
        self._lock = threading.Lock()
        self._stats = {
            "name": name, "running": False, "done": 0, "failed": 0,
            "failures": [], "failure_reasons": {}, "error": None,
        }
        self._stop = False

    # -- state ----------------------------------------------------------

    def snapshot(self):
        """A copy safe to serialise while the job is running."""
        with self._lock:
            return copy.deepcopy(self._stats)

    def stop(self):
        self._stop = True

    def _record_failure(self, row, reason):
        reason = str(reason or "failed")
        path = getattr(row, "path", None)
        name = os.path.basename(path) if path else str(getattr(row, "id", "?"))
        with self._lock:
            st = self._stats
            st["failed"] += 1
            tally = st["failure_reasons"]
            tally[reason] = tally.get(reason, 0) + 1
            if len(st["failures"]) < FAILURE_SAMPLE_MAX:
                st["failures"].append({
                    "id": str(getattr(row, "id", "")), "track": name, "reason": reason,
                })
            top, count = max(tally.items(), key=lambda kv: kv[1])
            st["error"] = (
                f"{name}: {reason}" if st["failed"] <= 1
                else f"{st['failed']} failed, {count}x: {top}"
            )

    # -- checkpoint -----------------------------------------------------

    def _pk(self):
        return self.query.model._meta.primary_key

    def _checkpoint_read(self):
        row = Meta.get_or_none(Meta.key == self.cursor_key)
        if row is None:
            return None
        try:
            state = json.loads(row.value)
            if bool(state.get("force")) != self.force:
                return None
            if time.time() - float(state.get("at") or 0) > RESUME_MAX_AGE:
                return None
            return self._pk().python_value(state["after"])
        except (ValueError, TypeError, KeyError, AttributeError):
            return None

    def _checkpoint_write(self, after):
        payload = json.dumps(
            {"after": str(after), "force": self.force, "at": time.time()}
        )
        row = Meta.get_or_none(Meta.key == self.cursor_key)
        if row is None:
            Meta.create(key=self.cursor_key, value=payload)
        else:
            row.value = payload
            row.save()

    def _checkpoint_clear(self):
        Meta.delete().where(Meta.key == self.cursor_key).execute()

    # -- run ------------------------------------------------------------

    def run(self, limit=None):
        """Walk the table. Returns the final snapshot. A ``limit`` or ``stop()``
        ends the run early and keeps the cursor so the next run resumes."""
        from .deezer.workload import quiet_wait, renice

        renice(12)  # for the life of this thread: a job thread, never a request
        pk = self._pk()
        after = self._checkpoint_read()
        if after is not None:
            logger.info("%s: resuming after %s", self.name, after)
        with self._lock:
            self._stats["running"] = True
        try:
            while True:
                query = self.query
                if after is not None:
                    query = query.where(pk > after)
                rows = list(query.order_by(pk).limit(self.page_size))
                if not rows:
                    self._checkpoint_clear()
                    return self.snapshot()
                for row in rows:
                    try:
                        reason = self.work(row)
                    except Exception as exc:  # one bad row never ends the job
                        logger.debug("%s: %s failed", self.name, row, exc_info=True)
                        reason = f"{type(exc).__name__}: {exc}"
                    if reason:
                        self._record_failure(row, reason)
                    else:
                        with self._lock:
                            self._stats["done"] += 1
                after = getattr(rows[-1], pk.name)
                self._checkpoint_write(after)
                if self._stop or (limit is not None and self._stats["done"] >= limit):
                    return self.snapshot()
                quiet_wait(1.0)  # yield to a foreground archive between pages
        finally:
            with self._lock:
                self._stats["running"] = False


def resume_if_interrupted(app, jobs):
    """Start, on a daemon thread, every job of ``jobs`` (``{cursor_key: factory}``)
    whose checkpoint is still fresh. ``factory()`` returns a ``LibraryJob``."""
    started = []
    for key, factory in jobs.items():
        job = factory()
        if job._checkpoint_read() is None:
            continue

        def target(job=job):
            with app.app_context():
                job.run()

        t = threading.Thread(target=target, name=f"job-{job.name}", daemon=True)
        t.start()
        started.append(job)
    return started

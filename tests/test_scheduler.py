# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The auto-sync scheduler (supysonic/deezer/scheduler.py).

What it must guarantee, from the resilience rules in CLAUDE.md: a sync is
POSTPONED while Deezer is unreachable instead of failing on every entity, the
local scan still runs (it has nothing to do with Deezer), the postponement is
bounded, two syncs never run at once, and a sync that blows up never takes the
thread — or the lock — down with it. Nothing here sleeps: every wait goes
through a recorded fake.
"""

import threading
import unittest
from datetime import datetime
from unittest import mock

from supysonic.deezer import scheduler

from .testbase import TestBase


class _Provider:
    def __init__(self, ok=True, raises=False):
        self.ok = ok
        self.raises = raises
        self.checks = 0

    def check_login(self, force=False):
        self.checks += 1
        if self.raises:
            raise RuntimeError("boom")
        return {"ok": self.ok, "reason": None if self.ok else "network"}


class _App:
    def __init__(self, provider=None, **deezer):
        self.deezer = provider
        cfg = {"sync_user": "alice", "archive_dir": "/nowhere", "scan_local": True}
        cfg.update(deezer)
        self.config = {"DEEZER": cfg}


class ParsingTestCase(unittest.TestCase):
    def test_sync_at(self):
        self.assertEqual(scheduler._parse_at("04:00"), (4, 0))
        self.assertEqual(scheduler._parse_at("23:59"), (23, 59))
        self.assertEqual(scheduler._parse_at("7:05"), (7, 5))
        with self.assertLogs(scheduler.logger, "WARNING"):
            self.assertEqual(scheduler._parse_at("24:00"), (4, 0))
        with self.assertLogs(scheduler.logger, "WARNING"):
            self.assertEqual(scheduler._parse_at("12:60"), (4, 0))
        with self.assertLogs(scheduler.logger, "WARNING"):
            self.assertEqual(scheduler._parse_at("noon"), (4, 0))
        # Unset is not a mistake worth a warning.
        with self.assertNoLogs(scheduler.logger, "WARNING"):
            self.assertEqual(scheduler._parse_at(None), (4, 0))
            self.assertEqual(scheduler._parse_at(""), (4, 0))

    def _until(self, now, hour, minute):
        class Fixed(datetime):
            @classmethod
            def now(cls, tz=None):
                return now

        with mock.patch.object(scheduler, "datetime", Fixed):
            return scheduler._seconds_until(hour, minute)

    def test_seconds_until_the_next_run(self):
        at = datetime(2026, 3, 1, 3, 0, 0)
        self.assertEqual(self._until(at, 4, 0), 3600)
        # Already past today: tomorrow, never "now" and never negative.
        self.assertEqual(self._until(datetime(2026, 3, 1, 5, 0), 4, 0), 23 * 3600)
        # On the trigger minute itself: the NEXT one (the loop steps past it).
        self.assertEqual(self._until(datetime(2026, 3, 1, 4, 0), 4, 0), 24 * 3600)
        # Across a month end.
        self.assertEqual(self._until(datetime(2026, 2, 28, 23, 30), 0, 30), 3600)


class StartTestCase(unittest.TestCase):
    def _start(self, app):
        seen = []
        started = threading.Event()

        def loop(app_, schedule, on_start):
            seen.append((schedule, on_start))
            started.set()

        with mock.patch.object(scheduler, "_loop", loop):
            thread = scheduler.maybe_start(app)
            if thread is not None:
                self.assertTrue(started.wait(5))
                thread.join(5)
                self.assertTrue(thread.daemon)  # never holds up a shutdown
        return thread, seen

    def test_needs_deezer_and_a_sync_user(self):
        self.assertIsNone(self._start(_App(None))[0])
        self.assertIsNone(self._start(_App(_Provider(), sync_user=None))[0])

    def test_daily_by_default(self):
        _t, seen = self._start(_App(_Provider()))
        self.assertEqual(seen, [(("daily", (4, 0)), True)])
        _t, seen = self._start(_App(_Provider(), sync_at="21:15", sync_on_start=False))
        self.assertEqual(seen, [(("daily", (21, 15)), False)])

    def test_an_interval_wins_over_a_time(self):
        _t, seen = self._start(_App(_Provider(), sync_interval="30", sync_at="21:15"))
        self.assertEqual(seen[0][0], ("interval", 30))
        # Garbage and non-positive intervals fall back to the daily run.
        for bad in ("abc", "0", "-5"):
            _t, seen = self._start(_App(_Provider(), sync_interval=bad))
            self.assertEqual(seen[0][0], ("daily", (4, 0)), bad)


class RunSyncTestCase(TestBase):
    def setUp(self):
        super().setUp()
        self.scans = []
        self.syncs = []
        self.sweeps = []

        test = self

        class Importer:
            def __init__(self, provider, user):
                self.user = user

            def sync(self, cfg):
                test.syncs.append(self.user)
                if getattr(test, "sync_raises", False):
                    raise RuntimeError("deezer exploded")
                return {"tracks": 1}

        patches = [
            mock.patch("supysonic.deezer.importer.DeezerImporter", Importer),
            mock.patch(
                "supysonic.deezer.local.scan_local",
                lambda d: self.scans.append(d) or {"added": 0, "removed": 0},
            ),
            mock.patch(
                "supysonic.deezer.backfill.sweep_for",
                lambda provider, user, **kw: self.sweeps.append(user.name) or {},
            ),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.assertFalse(scheduler.is_syncing(), "the sync lock was left held")
        super().tearDown()

    def test_unreachable_postpones_but_still_scans(self):
        app = _App(_Provider(ok=False))
        self.assertFalse(scheduler._run_sync(app))
        self.assertEqual(self.scans, ["/nowhere"])
        self.assertEqual(self.syncs, [])
        self.assertEqual(self.sweeps, [])

    def test_a_health_check_that_raises_reads_as_unreachable(self):
        self.assertFalse(scheduler._run_sync(_App(_Provider(raises=True))))
        self.assertEqual(self.syncs, [])

    def test_reachable_syncs_then_sweeps_the_archive(self):
        self.assertTrue(scheduler._run_sync(_App(_Provider())))
        self.assertEqual(self.scans, ["/nowhere"])
        self.assertEqual(self.syncs, ["alice"])
        self.assertEqual(self.sweeps, ["alice"])

    def test_the_sweep_obeys_the_master_switch(self):
        scheduler._run_sync(_App(_Provider(), archive_library=False))
        self.assertEqual(self.syncs, ["alice"])
        self.assertEqual(self.sweeps, [])

    def test_the_local_scan_can_be_skipped(self):
        scheduler._run_sync(_App(_Provider()), scan_local=False)
        scheduler._run_sync(_App(_Provider(), scan_local=False))
        self.assertEqual(self.scans, [])
        self.assertEqual(len(self.syncs), 2)

    def test_a_failing_sync_is_contained(self):
        self.sync_raises = True
        with self.assertLogs(scheduler.logger, "WARNING"):
            # Not postponed: Deezer answered, the sync itself failed.
            self.assertTrue(scheduler._run_sync(_App(_Provider())))
        self.assertEqual(self.sweeps, [])

    def test_never_two_at_once(self):
        self.assertTrue(scheduler._sync_lock.acquire(blocking=False))
        try:
            self.assertTrue(scheduler.is_syncing())
            # Reported as done (nothing to retry) and does nothing at all.
            self.assertTrue(scheduler._run_sync(_App(_Provider())))
        finally:
            scheduler._sync_lock.release()
        self.assertEqual((self.scans, self.syncs), ([], []))


class OutageRetryTestCase(unittest.TestCase):
    def _run(self, answers):
        calls, slept = [], []
        answers = iter(answers)

        def run_sync(app, scan_local=True):
            calls.append(scan_local)
            return next(answers)

        with mock.patch.object(scheduler, "_run_sync", run_sync), mock.patch.object(
            scheduler.time, "sleep", slept.append
        ):
            scheduler._run_when_reachable(object())
        return calls, slept

    def test_retries_until_deezer_is_back(self):
        calls, slept = self._run([False, False, True])
        # The local scan ran on the first attempt only.
        self.assertEqual(calls, [True, False, False])
        self.assertEqual(slept, [scheduler._OUTAGE_RETRY] * 2)

    def test_the_postponement_is_bounded(self):
        calls, slept = self._run([False] * 1000)
        retries = scheduler._OUTAGE_MAX_WAIT // scheduler._OUTAGE_RETRY
        self.assertEqual(len(calls), 1 + retries)
        self.assertEqual(sum(slept), scheduler._OUTAGE_MAX_WAIT)

    def test_no_retry_when_it_ran(self):
        self.assertEqual(self._run([True]), ([True], []))


if __name__ == "__main__":
    unittest.main()

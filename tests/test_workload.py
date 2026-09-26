# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A person waiting in front of the app outranks every background job.

supysonic/deezer/workload.py and the download queue in prefetch.py are how
that rule is kept, and until now only the request admission (503 +
Retry-After) was tested. The rest — the priority order of the queue, bulk work
standing down while a foreground download runs, the outage wait, the queue's
bound — ran in no test at all. These drive the real DeezerPrefetcher with the
archiving functions replaced by recorders, so what is asserted is the order
and timing the queue really produces.
"""

import os
import threading
import time
import unittest
from unittest import mock

from deezerpy.errors import DeezerUnavailable

from supysonic.deezer import prefetch, workload
from supysonic.deezer.workload import Priority

# How long a test waits for a worker before calling it stuck. Never reached by
# a passing test; generous so a loaded CI machine costs nothing.
WAIT = 10.0


class PriorityNamesTestCase(unittest.TestCase):
    def test_the_client_names_a_reason_never_a_number(self):
        self.assertEqual(workload.priority_from_name("user"), Priority.USER)
        self.assertEqual(workload.priority_from_name(" Prefetch "), Priority.PREFETCH)
        self.assertEqual(workload.priority_from_name("BULK"), Priority.BULK)
        # Unknown, empty, or an attempt to claim the front by number: bulk.
        for claim in ("urgent", "", None, "0", 0, "-1"):
            self.assertEqual(workload.priority_from_name(claim), Priority.BULK, claim)
        self.assertLess(Priority.USER, Priority.PREFETCH)
        self.assertLess(Priority.PREFETCH, Priority.BULK)


class SizingTestCase(unittest.TestCase):
    def _cores(self, n):
        return mock.patch.object(workload.os, "sched_getaffinity", lambda pid: set(range(n)))

    def test_a_batch_job_takes_half_the_box_and_never_the_last_core(self):
        # cores -> workers
        for cores, want in ((1, 1), (2, 1), (3, 1), (4, 2), (8, 4), (16, 8), (64, 8)):
            with self._cores(cores):
                self.assertEqual(workload.cpu_workers(), want, cores)
        # Asked for the whole box, it still leaves one core to the server.
        for cores, want in ((1, 1), (2, 1), (4, 3), (8, 7)):
            with self._cores(cores):
                self.assertEqual(workload.cpu_workers(share=1.0), want, cores)

    def test_background_requests_get_a_quarter_of_the_pool(self):
        for threads, want in (("16", 4), ("8", 2), ("4", 1), ("2", 1), ("64", 4)):
            with mock.patch.dict(os.environ, {"GUNICORN_THREADS": threads}, clear=False):
                os.environ.pop("NS_BACKGROUND_SLOTS", None)
                self.assertEqual(workload._default_background_slots(), want, threads)
        # The operator can say otherwise; garbage is ignored, not obeyed.
        with mock.patch.dict(os.environ, {"GUNICORN_THREADS": "16", "NS_BACKGROUND_SLOTS": "7"}):
            self.assertEqual(workload._default_background_slots(), 7)
        with mock.patch.dict(os.environ, {"GUNICORN_THREADS": "junk", "NS_BACKGROUND_SLOTS": "-3"}):
            self.assertEqual(workload._default_background_slots(), 4)  # 16 // 4


class QuietWaitTestCase(unittest.TestCase):
    def test_no_foreground_work_means_no_wait(self):
        self.assertFalse(workload.foreground_busy())
        t0 = time.monotonic()
        workload.quiet_wait(5.0)
        self.assertLess(time.monotonic() - t0, 0.1)

    def test_it_waits_for_the_foreground_to_finish_not_for_the_timeout(self):
        release = threading.Event()
        entered = threading.Event()

        def person_waiting():
            with workload.foreground():
                entered.set()
                release.wait(WAIT)

        t = threading.Thread(target=person_waiting)
        t.start()
        self.assertTrue(entered.wait(WAIT))
        self.assertTrue(workload.foreground_busy())
        threading.Timer(0.15, release.set).start()
        t0 = time.monotonic()
        workload.quiet_wait(5.0)
        waited = time.monotonic() - t0
        t.join(WAIT)
        self.assertGreater(waited, 0.1)  # it did wait...
        self.assertLess(waited, 2.0)  # ...for the foreground, not the 5 s cap
        self.assertFalse(workload.foreground_busy())

    def test_a_wedged_foreground_only_slows_the_bulk_queue_down(self):
        with workload.foreground():
            t0 = time.monotonic()
            workload.quiet_wait(0.3)
            self.assertLess(abs((time.monotonic() - t0) - 0.3), 0.25)

    def test_an_exception_in_the_foreground_still_releases_it(self):
        with self.assertRaises(ZeroDivisionError):
            with workload.foreground():
                1 / 0
        self.assertFalse(workload.foreground_busy())


class DownloadQueueTestCase(unittest.TestCase):
    """The real queue and worker, with the archiving itself recorded."""

    def setUp(self):
        self.done = []
        self.calls = []
        self.errors = {}  # deezer id -> exceptions to raise, in order
        self.cond = threading.Condition()
        self.gate = threading.Event()
        self.gate.set()

        test = self

        class Track:
            def __init__(self, did):
                self.deezer_id = did

        def import_track(provider, did):
            return Track(did)

        def ensure_archived(provider, track):
            did = track.deezer_id
            with test.cond:
                test.calls.append(did)
            if did == "gate":
                test.gate.wait(WAIT)
            errors = test.errors.get(did)
            if errors:
                raise errors.pop(0)
            with test.cond:
                test.done.append(did)
                test.cond.notify_all()

        # The worker imports these when its thread starts, so they are patched
        # before the prefetcher exists.
        for name, fake in (
            ("import_track", import_track),
            ("ensure_archived", ensure_archived),
            ("find_local_track", lambda did: None),
        ):
            p = mock.patch(f"supysonic.deezer.archive.{name}", fake)
            p.start()
            self.addCleanup(p.stop)
        # prefetch's OWN clock: patching time.sleep itself would also turn the
        # waits in these tests into no-ops (it is one module object).
        self.slept = []
        fake_time = mock.Mock(wraps=time)
        fake_time.sleep = self.slept.append
        p = mock.patch.object(prefetch, "time", fake_time)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(prefetch, "renice", lambda delta=10: None)
        p.start()
        self.addCleanup(p.stop)

    def _prefetcher(self, **kw):
        kw.setdefault("workers", 1)
        kw.setdefault("dl_workers", 1)
        pf = prefetch.DeezerPrefetcher(provider=object(), **kw)
        self.addCleanup(self._stop, pf)
        return pf

    def _stop(self, pf):
        self.gate.set()
        for _ in pf._workers:
            pf._dl_queue.put((99, 10**9, None))  # the worker's own stop marker

    def _until(self, predicate, what, within=WAIT):
        deadline = time.monotonic() + within
        with self.cond:
            while not predicate():
                left = deadline - time.monotonic()
                if left <= 0:
                    self.fail(f"timed out waiting for {what}: done={self.done}")
                self.cond.wait(min(left, 0.05))

    def test_a_person_goes_ahead_of_a_discography(self):
        """Pressing play during an artist archive used to wait behind it."""
        pf = self._prefetcher()
        self.gate.clear()
        pf.download_ids(["gate"], Priority.BULK)  # occupies the only worker
        self._until(lambda: self.calls == ["gate"], "the first item to start")
        pf.download_ids(["b1", "b2", "b3"], Priority.BULK)
        pf.download_ids(["p1"], Priority.PREFETCH)
        pf.download_ids(["u1"], Priority.USER)
        pf.download_ids(["b4"], Priority.BULK)
        self.gate.set()
        self._until(lambda: len(self.done) == 7, "the queue to drain")
        # Most urgent first; arrival order within one priority.
        self.assertEqual(self.done, ["gate", "u1", "p1", "b1", "b2", "b3", "b4"])

    def test_bulk_work_stands_down_while_somebody_waits(self):
        pf = self._prefetcher(dl_workers=2)
        with workload.foreground():
            pf.download_ids(["bulk"], Priority.BULK)
            pf.download_ids(["user"], Priority.USER)
            pf.download_ids(["next"], Priority.PREFETCH)
            # Neither the user's own download nor the next track is held back —
            # "within 2 s" is well under quiet_wait's 5 s cap, so a download
            # that waited it out does not pass by being merely slow...
            self._until(lambda: {"user", "next"} <= set(self.done), "the urgent ones", within=2.0)
            time.sleep(0.3)
            # ...while the bulk one waits for as long as the foreground lasts.
            self.assertNotIn("bulk", self.done)
        self._until(lambda: "bulk" in self.done, "the bulk download once it is quiet", within=2.0)

    def test_an_outage_is_waited_out_not_counted_as_a_failure(self):
        pf = self._prefetcher()
        self.errors["t1"] = [DeezerUnavailable("down"), DeezerUnavailable("down")]
        waits = iter([12.0, 90.0])
        with mock.patch.object(prefetch, "_outage_wait", lambda: next(waits)):
            pf.download_ids(["t1"])
            self._until(lambda: "t1" in self.done, "the retried download")
        self.assertEqual(self.calls, ["t1", "t1", "t1"])
        # The breaker's own cooldown, capped at _MAX_OUTAGE_WAIT.
        self.assertEqual(self.slept, [12.0, prefetch._MAX_OUTAGE_WAIT])

    def test_a_real_failure_is_not_retried(self):
        pf = self._prefetcher()
        self.errors["bad"] = [ValueError("no such track")]
        with mock.patch.object(prefetch, "_outage_wait", lambda: 30.0):
            pf.download_ids(["bad", "next"])
            self._until(lambda: "next" in self.done, "the item after the failure")
        self.assertEqual(self.calls, ["bad", "next"])
        self.assertEqual(self.slept, [])

    def test_a_transport_failure_without_an_open_circuit_is_not_retried(self):
        # e.g. a podcast host that will not resolve: nothing says a retry in a
        # second would land differently.
        pf = self._prefetcher()
        self.errors["host"] = [DeezerUnavailable("no route")]
        with mock.patch.object(prefetch, "_outage_wait", lambda: 0.0):
            pf.download_ids(["host", "next"])
            self._until(lambda: "next" in self.done, "the next item")
        self.assertEqual(self.calls, ["host", "next"])
        self.assertEqual(self.slept, [])

    def test_the_retries_are_bounded(self):
        pf = self._prefetcher()
        self.errors["t"] = [DeezerUnavailable("down")] * 50
        with mock.patch.object(prefetch, "_outage_wait", lambda: 1.0):
            pf.download_ids(["t", "after"])
            self._until(lambda: "after" in self.done, "the item after an outage")
        # A literal, not _MAX_OUTAGE_RETRIES + 1: the first attempt and three
        # retries, then the nightly sweep's job.
        self.assertEqual(self.calls.count("t"), 4)

    def test_a_full_queue_refuses_and_says_how_many_it_took(self):
        """Every entry is a FLAC on disk; an unbounded queue was a way to fill it."""
        pf = self._prefetcher(max_download_queue=3)
        self.gate.clear()
        pf.download_ids(["gate"])
        self._until(lambda: self.calls == ["gate"], "the worker to be busy")
        self.assertEqual(pf.download_ids(["a", "b", "c", "d", "e"]), 3)
        self.assertEqual(pf.download_pending, 3)
        self.assertEqual(pf.download_episode_ids(["x"]), 0)


if __name__ == "__main__":
    unittest.main()

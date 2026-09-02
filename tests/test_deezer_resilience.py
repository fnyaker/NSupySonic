# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Deezer is a third party: the app must survive it being unreachable.

Everything here is about the *transport*, never about the data. The rule these
tests pin down is that a failure to REACH Deezer may only ever cost latency and
a missing row — never a wrong verdict (a track declared unavailable, a show
declared gone) and never the app itself.
"""

import json
import socket
import tempfile
import threading
import time
import unittest

import requests

from deezerpy import DEFAULT_TIMEOUT, Deezer
from deezerpy._circuit import CircuitBreaker, breaker
from deezerpy.errors import DeezerUnavailable, GWAPIError, is_transport_failure
from supysonic.deezer.provider import (
    DeezerError,
    DeezerProvider,
    ShowUnavailable,
    TrackUnavailable,
)


class FakeAdapter(requests.adapters.HTTPAdapter):
    """Counts requests and answers with whatever the test asked for."""

    def __init__(self, body=None, status=200, raises=None, text=None):
        super().__init__()
        self.calls = 0
        self.body = body
        self.status = status
        self.raises = raises
        self.text = text

    def send(self, request, **kwargs):
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        resp = requests.Response()
        resp.status_code = self.status
        resp.url = request.url
        resp.request = request
        payload = self.text if self.text is not None else json.dumps(self.body or {})
        resp._content = payload.encode()
        resp.headers["Content-Type"] = "application/json"
        return resp


def wire(dz, adapter):
    """Route every request of ``dz`` through ``adapter``."""
    dz.session.mount("https://", adapter)
    dz.session.mount("http://", adapter)
    return adapter


def no_backoff(case):
    """Skip the between-retry sleeps so a test isn't paced by real seconds."""
    import deezerpy.api as api_mod
    import deezerpy.gw as gw_mod

    for mod in (api_mod, gw_mod):
        original = mod.sleep
        mod.sleep = lambda _s: None
        case.addCleanup(lambda m=mod, o=original: setattr(m, "sleep", o))


class CircuitBreakerTestCase(unittest.TestCase):
    def setUp(self):
        self.cb = CircuitBreaker(threshold=3, base_cooldown=30.0)

    def fail(self, host, n=1):
        for _ in range(n):
            self.cb.before_request(host)
            self.cb.on_failure(host, OSError("boom"))

    def test_a_blip_does_not_open_it(self):
        self.fail("a.example", 2)
        self.assertFalse(self.cb.is_open("a.example"))
        self.assertFalse(self.cb.before_request("a.example"))

    def test_it_opens_once_the_failures_add_up(self):
        self.fail("a.example", 3)
        self.assertTrue(self.cb.is_open("a.example"))
        with self.assertRaises(DeezerUnavailable):
            self.cb.before_request("a.example")
        self.assertGreater(self.cb.retry_after("a.example"), 0)

    def test_a_success_forgets_the_failures(self):
        self.fail("a.example", 2)
        self.cb.on_success("a.example")
        self.fail("a.example", 2)
        self.assertFalse(self.cb.is_open("a.example"))

    def test_hosts_are_independent(self):
        # A rate-limited public API must never stop playback from the CDN.
        self.fail("api.deezer.com", 3)
        self.assertTrue(self.cb.is_open("api.deezer.com"))
        self.assertFalse(self.cb.is_open("cdn.dzcdn.net"))
        self.assertFalse(self.cb.before_request("cdn.dzcdn.net"))

    def test_one_probe_gets_through_after_the_cooldown_and_closes_it(self):
        cb = CircuitBreaker(threshold=1, base_cooldown=0.0)
        cb.before_request("a.example")
        cb.on_failure("a.example", OSError("boom"))
        probe = cb.before_request("a.example")
        self.assertTrue(probe)
        # While that probe is in flight, everyone else still fails fast.
        with self.assertRaises(DeezerUnavailable):
            cb.before_request("a.example")
        cb.on_success("a.example", probe)
        self.assertFalse(cb.is_open("a.example"))
        self.assertFalse(cb.before_request("a.example"))

    def test_a_failed_probe_backs_off_further(self):
        cb = CircuitBreaker(threshold=1, base_cooldown=10.0, max_cooldown=100.0)
        cb.before_request("a.example")
        cb.on_failure("a.example", OSError("boom"))
        first = cb.retry_after("a.example")
        cb._hosts["a.example"].open_until = 0.0  # pretend the cooldown elapsed
        probe = cb.before_request("a.example")
        cb.on_failure("a.example", OSError("still down"), probe)
        self.assertGreater(cb.retry_after("a.example"), first)

    def test_reset_makes_it_try_again_now(self):
        self.fail("a.example", 3)
        self.cb.reset("a.example")
        self.assertFalse(self.cb.is_open("a.example"))


class SessionTestCase(unittest.TestCase):
    """The session is where every Deezer request is made safe."""

    def setUp(self):
        breaker.reset()
        self.addCleanup(breaker.reset)

    def test_every_request_carries_a_bounded_timeout(self):
        seen = {}

        class Recorder(requests.adapters.HTTPAdapter):
            def send(self, request, **kwargs):
                seen["timeout"] = kwargs.get("timeout")
                raise requests.ConnectionError("no network in tests")

        dz = Deezer()
        wire(dz, Recorder())
        with self.assertRaises(requests.ConnectionError):
            dz.session.get("https://timeout.invalid/x")
        connect, read = seen["timeout"]
        self.assertEqual((connect, read), DEFAULT_TIMEOUT)
        # The connect half is what an outage burns, once per parked thread.
        self.assertLessEqual(connect, 10)

    def test_a_known_dead_host_costs_no_socket_at_all(self):
        dz = Deezer()
        adapter = wire(dz, FakeAdapter(raises=requests.ConnectTimeout("nope")))
        for _ in range(3):
            with self.assertRaises(requests.ConnectionError):
                dz.session.get("https://dead.invalid/x")
        self.assertEqual(adapter.calls, 3)

        # Everything after that is refused instantly, without touching the network.
        for _ in range(20):
            with self.assertRaises(DeezerUnavailable):
                dz.session.get("https://dead.invalid/x")
        self.assertEqual(adapter.calls, 3)

    def test_the_verdict_is_per_host(self):
        dz = Deezer()
        dead = FakeAdapter(raises=requests.ConnectTimeout("nope"))
        alive = FakeAdapter(body={"ok": True})
        dz.session.mount("https://dead.invalid", dead)
        dz.session.mount("https://alive.invalid", alive)
        for _ in range(3):
            with self.assertRaises(requests.ConnectionError):
                dz.session.get("https://dead.invalid/x")
        self.assertEqual(dz.session.get("https://alive.invalid/x").status_code, 200)

    def test_an_http_error_is_deezer_answering_not_an_outage(self):
        dz = Deezer()
        wire(dz, FakeAdapter(body={"error": "nope"}, status=500))
        for _ in range(5):
            self.assertEqual(dz.session.get("https://answering.invalid/x").status_code, 500)
        self.assertFalse(breaker.is_open("answering.invalid"))


class RetryBudgetTestCase(unittest.TestCase):
    """Retries must be bounded in TIME, not just in count."""

    def setUp(self):
        breaker.reset()
        self.addCleanup(breaker.reset)

    def test_the_public_api_gives_up_instead_of_retrying_for_minutes(self):
        import deezerpy.api as api_mod

        slept = []
        original, api_mod.sleep = api_mod.sleep, slept.append
        self.addCleanup(lambda: setattr(api_mod, "sleep", original))

        dz = Deezer()
        adapter = wire(dz, FakeAdapter(raises=requests.ConnectTimeout("nope")))
        with self.assertRaises(requests.ConnectionError):
            dz.api.get_chart_artists(limit=25)
        # One attempt plus a bounded number of retries — never an open-ended loop.
        self.assertLessEqual(adapter.calls, 3)
        self.assertLessEqual(sum(slept), api_mod.NET_BUDGET)

    def test_a_short_circuited_call_is_not_retried_at_all(self):
        import deezerpy.api as api_mod

        original, api_mod.sleep = api_mod.sleep, lambda _s: None
        self.addCleanup(lambda: setattr(api_mod, "sleep", original))

        dz = Deezer()
        adapter = wire(dz, FakeAdapter(raises=requests.ConnectTimeout("nope")))
        with self.assertRaises(requests.ConnectionError):
            dz.api.get_chart_artists(limit=25)
        before = adapter.calls
        with self.assertRaises(DeezerUnavailable):
            dz.api.get_chart_artists(limit=25)
        self.assertEqual(adapter.calls, before)  # no waiting, no socket

    def test_a_non_json_body_is_unreachable_not_data(self):
        dz = Deezer()
        wire(dz, FakeAdapter(text="<html>502 Bad Gateway</html>"))
        with self.assertRaises(DeezerUnavailable):
            dz.api.get_chart_artists(limit=25)
        wire(dz, FakeAdapter(text="<html>nope</html>"))
        with self.assertRaises(DeezerUnavailable):
            dz.gw.get_track(1)

    def test_a_gateway_stuck_on_an_invalid_token_terminates(self):
        # Refreshing the token IS a gateway call, so this used to recurse
        # forever; it must end in a plain error instead.
        dz = Deezer()
        wire(dz, FakeAdapter(body={"error": {"GATEWAY_ERROR": "invalid api token"}}))
        with self.assertRaises(GWAPIError):
            dz.gw.get_track(1)


class RecoveryTestCase(unittest.TestCase):
    def setUp(self):
        breaker.reset()
        self.addCleanup(breaker.reset)

    def test_the_circuit_closes_again_when_the_host_answers(self):
        dz = Deezer()
        dead = FakeAdapter(raises=requests.ConnectTimeout("nope"))
        wire(dz, dead)
        for _ in range(3):
            with self.assertRaises(requests.ConnectionError):
                dz.session.get("https://flaky.invalid/x")
        with self.assertRaises(DeezerUnavailable):
            dz.session.get("https://flaky.invalid/x")

        # The host is back and the cooldown has elapsed: one probe gets through,
        # succeeds, and normal service resumes — no restart involved.
        alive = wire(dz, FakeAdapter(body={"ok": True}))
        breaker._hosts["flaky.invalid"].open_until = 0.0
        self.assertEqual(dz.session.get("https://flaky.invalid/x").status_code, 200)
        self.assertFalse(breaker.is_open("flaky.invalid"))
        for _ in range(5):
            self.assertEqual(dz.session.get("https://flaky.invalid/x").status_code, 200)
        self.assertEqual(alive.calls, 6)


class TransportDetectionTestCase(unittest.TestCase):
    def test_it_walks_the_cause_chain(self):
        try:
            try:
                raise requests.ConnectTimeout("connect timed out")
            except requests.ConnectTimeout as exc:
                raise DeezerError("cannot reach Deezer") from exc
        except DeezerError as wrapped:
            self.assertTrue(is_transport_failure(wrapped))

    def test_an_answer_is_not_a_transport_failure(self):
        self.assertFalse(is_transport_failure(TrackUnavailable("no source")))
        self.assertFalse(is_transport_failure(GWAPIError("{}")))
        self.assertFalse(is_transport_failure(None))


class VerdictTestCase(unittest.TestCase):
    """A verdict about the DATA may only come from Deezer answering."""

    def setUp(self):
        breaker.reset()
        self.addCleanup(breaker.reset)
        no_backoff(self)
        self.archive_dir = tempfile.mkdtemp()
        self.provider = DeezerProvider("dummy-arl", self.archive_dir, "FLAC")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.archive_dir, ignore_errors=True)

    def _dz(self, adapter):
        dz = Deezer()
        dz.current_user = {
            "id": 42,
            "name": "tester",
            "license_token": "lt",
            "can_stream_lossless": True,
            "can_stream_hq": True,
            "country": "FR",
        }
        wire(dz, adapter)
        self.provider._dz = dz
        return dz

    def test_an_unreachable_deezer_never_condemns_a_track(self):
        # This is the one that matters: a condemned track is offered to the user
        # for replacement or deletion, so an outage must not produce one.
        self._dz(FakeAdapter(raises=requests.ConnectTimeout("nope")))
        with self.assertRaises(DeezerError) as ctx:
            self.provider.resolve("123")
        self.assertNotIsInstance(ctx.exception, TrackUnavailable)

    def test_a_dead_media_host_never_condemns_a_track(self):
        # The gateway answers with the track, but media.deezer.com is unwell:
        # every quality resolves to "no URL", which looks exactly like a track
        # with no source. It is not one.
        class Split(requests.adapters.HTTPAdapter):
            def send(self, request, **kwargs):
                if "media.deezer.com" in request.url:
                    resp = requests.Response()
                    resp.status_code = 503
                    resp.url = request.url
                    resp.request = request
                    resp._content = b"upstream unavailable"
                    return resp
                resp = requests.Response()
                resp.status_code = 200
                resp.url = request.url
                resp.request = request
                resp._content = json.dumps(
                    {
                        "error": [],
                        "results": {
                            "checkForm": "csrf",
                            "SNG_ID": "123",
                            "TRACK_TOKEN": "tok",
                        },
                    }
                ).encode()
                return resp

        self._dz(Split())
        with self.assertRaises(DeezerError) as ctx:
            self.provider.resolve("123")
        self.assertNotIsInstance(ctx.exception, TrackUnavailable)

    def test_deezer_answering_no_source_still_condemns_the_track(self):
        # The other half of the contract: a real verdict must still get through,
        # or a track that has genuinely gone would never be replaceable.
        self.provider._dz = object()  # never touched: resolve is stubbed below
        calls = []

        def resolve_once(sng_id, quality):
            calls.append(sng_id)
            raise TrackUnavailable(f"no playable source for track {sng_id}")

        self.provider._resolve_once = resolve_once
        self.provider.relogin = lambda: None
        with self.assertRaises(TrackUnavailable):
            self.provider.resolve("123")
        self.assertEqual(len(calls), 2)  # confirmed by a second, fresh attempt

    def test_an_unreachable_deezer_never_retires_a_show(self):
        # ShowUnavailable turns a subscription into a local podcast and stops
        # the sync asking about it — far too consequential for a timeout.
        self._dz(FakeAdapter(raises=requests.ConnectTimeout("nope")))
        with self.assertRaises(Exception) as ctx:
            self.provider.get_show_page("42")
        self.assertNotIsInstance(ctx.exception, ShowUnavailable)
        self.assertTrue(is_transport_failure(ctx.exception))

    def test_art_is_decoration_not_a_failure(self):
        self._dz(FakeAdapter(raises=requests.ConnectTimeout("nope")))
        self.assertIsNone(self.provider.fetch_cover("somemd5"))
        self.assertIsNone(self.provider.fetch_image("artist", "27"))


class PodcastDnsTestCase(unittest.TestCase):
    """``check_public_url`` resolves a name before requests is involved.

    ``socket.getaddrinfo`` has no timeout of its own, so this is the one DNS
    lookup in the app that isn't already covered by a connect timeout — and it
    runs once per redirect hop, on a hostname a third-party feed chose.
    """

    def setUp(self):
        from supysonic.deezer import provider as provider_mod

        self.mod = provider_mod
        provider_mod._resolve_cache.clear()
        self.addCleanup(provider_mod._resolve_cache.clear)
        # A fifth of a second proves the deadline exists as well as five would.
        original = provider_mod.RESOLVE_TIMEOUT
        provider_mod.RESOLVE_TIMEOUT = 0.2
        self.addCleanup(setattr, provider_mod, "RESOLVE_TIMEOUT", original)
        self.gate = threading.Event()
        self.addCleanup(self.gate.set)  # never leave a worker blocked
        self.lookups = []

    def stall(self, forever=True):
        """Make every lookup block until the test lets it through."""

        def getaddrinfo(host, port, *a, **kw):
            self.lookups.append(host)
            self.gate.wait(10 if forever else 0)
            return [(2, 1, 6, "", ("93.184.216.34", port))]

        original = socket.getaddrinfo
        socket.getaddrinfo = getaddrinfo
        self.addCleanup(setattr, socket, "getaddrinfo", original)

    def test_a_stalled_resolver_does_not_park_the_caller(self):
        self.stall()
        started = time.monotonic()
        with self.assertRaises(DeezerError):
            self.mod.check_public_url("https://stalled.example/ep.mp3")
        # Bounded by RESOLVE_TIMEOUT, not by the system resolver's 20s+.
        self.assertLess(time.monotonic() - started, 2.0)

    def test_the_next_caller_does_not_pay_the_same_timeout_again(self):
        self.stall()
        with self.assertRaises(DeezerError):
            self.mod.check_public_url("https://stalled.example/ep.mp3")
        started = time.monotonic()
        for _ in range(5):
            with self.assertRaises(DeezerError):
                self.mod.check_public_url("https://stalled.example/other.mp3")
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(len(self.lookups), 1)  # remembered, not re-asked

    def test_a_redirect_chain_resolves_each_host_once(self):
        self.gate.set()  # answer immediately
        self.stall()
        for _ in range(6):  # MAX_EPISODE_REDIRECTS + 1 hops on the same host
            self.mod.check_public_url("https://cdn.example/ep.mp3")
        self.assertEqual(self.lookups, ["cdn.example"])

    def test_a_timeout_reads_as_a_transport_failure_not_a_verdict(self):
        self.stall()
        try:
            self.mod.check_public_url("https://stalled.example/ep.mp3")
        except DeezerError as exc:
            self.assertTrue(is_transport_failure(exc))
        else:
            self.fail("expected a DeezerError")

    def test_stuck_lookups_free_their_slots_when_they_end(self):
        # Fill every resolver slot with a lookup that never answers...
        self.stall()
        workers = [
            threading.Thread(
                target=lambda i=i: self._swallow(f"stuck{i}.example"), daemon=True
            )
            for i in range(self.mod._RESOLVE_WORKERS)
        ]
        for w in workers:
            w.start()
        for w in workers:
            w.join(5)

        # ...and a further caller is refused rather than joining the pile-up.
        started = time.monotonic()
        with self.assertRaises(DeezerError):
            self.mod.resolve_addresses("waiting.example", 443)
        self.assertLess(time.monotonic() - started, 2.0)

        # Once the stuck lookups finally end, their slots come back: no leak.
        self.gate.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                self.assertEqual(
                    self.mod.resolve_addresses("free.example", 443), ["93.184.216.34"]
                )
                return
            except DeezerError:
                time.sleep(0.05)
                self.mod._resolve_cache.clear()
        self.fail("resolver slots were never released")

    def _swallow(self, host):
        try:
            self.mod.resolve_addresses(host, 443)
        except DeezerError:
            pass

    def test_a_private_address_is_still_refused(self):
        # The deadline is a speed fix; it must not have loosened the SSRF guard.
        self.gate.set()

        def getaddrinfo(host, port, *a, **kw):
            return [(2, 1, 6, "", ("127.0.0.1", port))]

        original = socket.getaddrinfo
        socket.getaddrinfo = getaddrinfo
        self.addCleanup(setattr, socket, "getaddrinfo", original)
        with self.assertRaises(DeezerError):
            self.mod.check_public_url("https://sneaky.example/ep.mp3")


class AvailabilityTestCase(unittest.TestCase):
    def setUp(self):
        breaker.reset()
        self.addCleanup(breaker.reset)
        self.archive_dir = tempfile.mkdtemp()
        self.provider = DeezerProvider("dummy-arl", self.archive_dir, "FLAC")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.archive_dir, ignore_errors=True)

    def test_a_fresh_provider_is_willing_to_try(self):
        self.assertTrue(self.provider.available())
        self.assertIsNone(self.provider.outage())

    def test_a_failed_login_is_not_retried_on_every_request(self):
        attempts = []

        def boom(self_, arl, child=0):
            attempts.append(arl)
            raise OSError("connection reset")

        original, Deezer.login_via_arl = Deezer.login_via_arl, boom
        self.addCleanup(lambda: setattr(Deezer, "login_via_arl", original))

        for _ in range(10):
            with self.assertRaises(DeezerError):
                _ = self.provider.dz
        self.assertEqual(len(attempts), 1)
        self.assertFalse(self.provider.available())
        self.assertGreater(self.provider.outage()["retry_in"], 0)

    def test_the_status_check_answers_instantly_during_an_outage(self):
        def boom(self_, arl, child=0):
            raise OSError("connection reset")

        original, Deezer.login_via_arl = Deezer.login_via_arl, boom
        self.addCleanup(lambda: setattr(Deezer, "login_via_arl", original))

        first = self.provider.check_login(force=True)
        self.assertFalse(first["ok"])
        self.assertEqual(first["reason"], "network")

        # A second poll must not attempt a second login.
        calls = []
        Deezer.login_via_arl = lambda self_, arl, child=0: calls.append(arl) or False
        again = self.provider.check_login()
        self.assertFalse(again["ok"])
        self.assertEqual(again["reason"], "network")
        self.assertEqual(calls, [])

    def test_an_open_circuit_is_never_reported_as_a_dead_credential(self):
        breaker.reset()
        for _ in range(5):
            try:
                breaker.before_request("www.deezer.com")
            except DeezerUnavailable:
                break
            breaker.on_failure("www.deezer.com", requests.ConnectTimeout("nope"))
        self.provider._login_error = ("arl", "stale verdict from an hour ago")
        status = self.provider.check_login()
        self.assertFalse(status["ok"])
        self.assertEqual(status["reason"], "network")

    def test_it_recovers_on_its_own_once_deezer_comes_back(self):
        """No restart, no admin action: the app must come back by itself."""
        no_backoff(self)
        attempts = []
        healthy = {"now": False}

        def login(self_, arl, child=0):
            attempts.append(arl)
            if not healthy["now"]:
                raise OSError("connection reset")
            self_.current_user = {"id": 42, "name": "tester"}
            return True

        original, Deezer.login_via_arl = Deezer.login_via_arl, login
        self.addCleanup(lambda: setattr(Deezer, "login_via_arl", original))

        for _ in range(5):
            with self.assertRaises(DeezerError):
                _ = self.provider.dz
        self.assertEqual(len(attempts), 1)  # the backoff held the other four
        self.assertFalse(self.provider.available())

        # Deezer is back, and so is the moment we said we would look again.
        healthy["now"] = True
        self.provider._login_retry_at = 0.0
        self.assertTrue(self.provider.available())
        self.assertEqual(self.provider.dz.current_user["name"], "tester")
        self.assertEqual(len(attempts), 2)
        self.assertTrue(self.provider.check_login()["ok"])

    def test_a_new_arl_gets_a_real_attempt(self):
        self.provider._login_error = ("arl", "rejected")
        self.provider._login_retry_at = float("inf")
        self.provider.set_arl(" fresh ")
        self.assertEqual(self.provider.arl, "fresh")
        self.assertTrue(self.provider.available())


if __name__ == "__main__":
    unittest.main()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot H of the Deezer detachment: MusicBrainz in the background, similar artists
on the artist page — including on a server that already had data.

The third party is a real HTTP server on loopback answering MusicBrainz-shaped
JSON, so the client, the pacing and the decisions run for real."""

import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from unittest import mock

import requests

from supysonic import db as dbmod
from supysonic.config import DefaultConfig
from supysonic.db import (
    Artist,
    Track,
    TrackEnrichment,
    TrackNeighbor,
    release_database,
    init_database,
)
from supysonic.deezer import library
from supysonic.enrich import backfill, cover, musicbrainz as mb, search
from supysonic.enrich import queue as eq
from supysonic.enrich.http import Http, HttpError, Unavailable
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from . import test_detach_a as _ta
from . import test_webui as _tw

ISRC = "FR1234567890"
MBID = "11111111-2222-3333-4444-555555555555"
RELEASE = "99999999-8888-7777-6666-555555555555"
RECORDING = {
    "id": MBID,
    "title": "Une Chanson",
    "length": 200000,
    "first-release-date": "1999-05-12",
    "artist-credit": [{"artist": {"name": "Artist 1"}}],
    "releases": [{"id": RELEASE}],
}
CREDITS = {
    "id": MBID,
    "relations": [
        {"type": "producer", "artist": {"name": "Prod Ucer"}},
        {
            "type": "performance",
            "work": {
                "relations": [
                    {"type": "composer", "artist": {"name": "Com Poser"}},
                    {"type": "lyricist", "artist": {"name": "Lyr Icist"}},
                ]
            },
        },
    ],
}


class FakeMB(ThreadingHTTPServer):
    """MusicBrainz-shaped answers; ``mode`` can be turned to a 503."""

    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), self._handler())
        self.hits = []
        self.mode = "ok"
        self.search_results = [RECORDING]
        self.isrc_results = [RECORDING]
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.server_address[1]}/ws/2"

    def close(self):
        self.shutdown()
        self.server_close()

    @staticmethod
    def _handler():
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                srv = self.server
                srv.hits.append((self.path, self.headers.get("User-Agent")))
                if srv.mode == "503":
                    self.send_response(503)
                    self.send_header("Retry-After", "7")
                    self.end_headers()
                    return
                path = self.path.split("?")[0]
                if path.startswith("/ws/2/isrc/"):
                    body = {"recordings": srv.isrc_results} if srv.isrc_results else None
                elif path == "/ws/2/recording":
                    body = {"recordings": srv.search_results}
                elif path.startswith("/ws/2/recording/"):
                    body = CREDITS
                else:
                    body = None
                if body is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)

        return H


class FakeClock:
    def __init__(self):
        self.t = 100.0
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


class FakeSession:
    def __init__(self, status=200, headers=None, body=None):
        self.calls = []
        self.status, self.headers, self.body = status, headers or {}, body or {}

    def request(self, method, url, headers=None, timeout=None, **kw):
        self.calls.append((method, url, headers, timeout))
        resp = mock.Mock()
        resp.status_code = self.status
        resp.headers = self.headers
        resp.json.return_value = self.body
        return resp


class HttpTest(unittest.TestCase):
    def make(self, **kw):
        self.clock = FakeClock()
        self.session = FakeSession(**kw)
        return Http("me@example.org", session=self.session, clock=self.clock.now,
                    sleep=self.clock.sleep)

    def test_it_names_itself_and_uses_a_split_timeout(self):
        http = self.make()
        http.get_json("https://musicbrainz.org/ws/2/x")
        _, _, headers, timeout = self.session.calls[0]
        self.assertRegex(headers["User-Agent"], r"^NSupySonic/\S+ \( me@example\.org \)$")
        self.assertIsInstance(timeout, tuple)

    def test_musicbrainz_is_asked_once_a_second(self):
        http = self.make()
        for _ in range(3):
            http.get_json("https://musicbrainz.org/ws/2/x")
        self.assertEqual(self.clock.slept, [1.0, 1.0])

    def test_hosts_are_paced_on_their_own(self):
        http = self.make()
        http.get_json("https://musicbrainz.org/ws/2/x")
        http.get_json("https://coverartarchive.org/x")
        self.assertEqual(self.clock.slept, [])

    def test_acoustid_allows_three_a_second(self):
        http = self.make()
        for _ in range(2):
            http.get_json("https://api.acoustid.org/v2/lookup")
        self.assertAlmostEqual(self.clock.slept[0], 1 / 3)

    def test_a_503_holds_the_host_off_for_what_it_asked(self):
        http = self.make(status=503, headers={"Retry-After": "7"})
        with self.assertRaises(Unavailable) as cm:
            http.get_json("https://musicbrainz.org/ws/2/x")
        self.assertEqual(cm.exception.retry_after, 7.0)
        self.session.status = 200
        http.get_json("https://musicbrainz.org/ws/2/x")
        # the next call waited the 7 s out, inside the worker
        self.assertAlmostEqual(self.clock.slept[0], 7.0)

    def test_a_long_hold_is_an_error_not_a_sleep(self):
        http = self.make(status=429, headers={"Retry-After": "600"})
        with self.assertRaises(Unavailable):
            http.get_json("https://musicbrainz.org/ws/2/x")
        with self.assertRaises(Unavailable):
            http.get_json("https://musicbrainz.org/ws/2/x")
        self.assertEqual(self.clock.slept, [])
        self.assertEqual(len(self.session.calls), 1)

    def test_a_404_is_an_answer_and_an_error_status_is_named(self):
        http = self.make(status=404)
        self.assertIsNone(http.get_json("https://musicbrainz.org/ws/2/x"))
        self.session.status = 500
        with self.assertRaises(HttpError):
            http.get_json("https://musicbrainz.org/ws/2/y")

    def test_a_network_failure_is_unavailable(self):
        http = self.make()
        self.session.request = mock.Mock(side_effect=requests.ConnectionError("down"))
        with self.assertRaises(Unavailable):
            http.get_json("https://musicbrainz.org/ws/2/x")

    def test_images_come_only_from_the_archive_over_https(self):
        http = self.make()
        self.assertIsNone(http.get_image("http://coverartarchive.org/x"))
        self.assertIsNone(http.get_image("https://evil.example/x.jpg"))
        self.assertEqual(self.session.calls, [])


class SourcesTest(unittest.TestCase):
    def setUp(self):
        self.srv = FakeMB()
        self.addCleanup(self.srv.close)
        patcher = mock.patch.object(mb, "BASE", self.srv.base)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.http = Http(rates={"127.0.0.1": 0})

    def test_isrc_gives_the_recording_its_date_and_release(self):
        got = mb.lookup_isrc(self.http, ISRC, 200)
        self.assertEqual(got, {"mbid": MBID, "date": "1999-05-12", "release": RELEASE})

    def test_a_malformed_isrc_never_leaves_the_machine(self):
        self.assertIsNone(mb.lookup_isrc(self.http, "x/../y", 200))
        self.assertEqual(self.srv.hits, [])

    def test_an_isrc_on_a_recording_of_another_length_is_refused(self):
        self.assertIsNone(mb.lookup_isrc(self.http, ISRC, 400))

    def test_credits_come_from_the_recording_and_its_work(self):
        self.assertEqual(
            mb.credits(self.http, MBID),
            {"producer": "Prod Ucer", "composer": "Com Poser", "lyricist": "Lyr Icist"},
        )

    def test_a_month_alone_is_only_its_year(self):
        self.assertEqual(mb.summarize({"id": MBID, "first-release-date": "1999-05"})["date"], "1999")
        self.assertIsNone(mb.summarize({"id": MBID, "first-release-date": "soon"})["date"])

    def test_a_search_is_accepted_when_title_artist_and_length_agree(self):
        got = search.find(self.http, "Une chanson (Remastered 2011)", "Artist 1", 201.5)
        self.assertEqual(got["mbid"], MBID)

    def test_a_search_with_the_wrong_artist_title_or_length_finds_nothing(self):
        self.assertIsNone(search.find(self.http, "Une Chanson", "Someone Else", 200))
        self.assertIsNone(search.find(self.http, "Autre Chose", "Artist 1", 200))
        self.assertIsNone(search.find(self.http, "Une Chanson", "Artist 1", 190))
        self.assertIsNone(search.find(self.http, "Une Chanson", "Artist 1", None))

    def test_a_quote_in_the_title_stays_inside_the_query(self):
        search.find(self.http, 'Say "hi" \\ now', "Artist 1", 200)
        path = self.srv.hits[-1][0]
        self.assertIn("%5C%22hi%5C%22", path)


class Base(unittest.TestCase):
    _login = _tw.WebUITestCase._login

    def setUp(self):
        _tw.WebUITestCase.setUp(self)
        self.srv = FakeMB()
        p = mock.patch.object(mb, "BASE", self.srv.base)
        p.start()
        self.addCleanup(p.stop)
        self.http = Http(rates={"127.0.0.1": 0})
        eq.configure({"enabled": True, "acoustid_key": None})

    def tearDown(self):
        self.srv.close()
        eq.configure(None)
        _tw.WebUITestCase.tearDown(self)

    def track(self, title="Une Chanson", n=1, isrc=None, source="deezer"):
        root = library.get_root_folder(self.archive)
        t = library.upsert_track(
            {
                "SNG_ID": str(8000 + n), "SNG_TITLE": title, "ART_NAME": "Artist 1",
                "ART_ID": "1", "ALB_TITLE": "Album 1", "ALB_ID": "10", "DURATION": "200",
                "TRACK_NUMBER": str(n), "DISK_NUMBER": "1",
            },
            root,
        )
        os.makedirs(os.path.dirname(t.path), exist_ok=True)
        with open(t.path, "wb") as fh:
            fh.write(b"flacdata")
        t.last_modification = 1700000000
        t.save()
        if isrc:
            library.update_track_facts(t, {"isrc": isrc}, source)
        return t


class EnrichTest(Base):
    def facts(self, t):
        return library.read_track_facts(t)

    def test_an_isrc_fills_the_facts_and_the_row(self):
        t = self.track(isrc=ISRC)
        self.assertEqual(eq.enrich_track(t, http=self.http), ("done", "isrc", None))
        facts = self.facts(t)
        self.assertEqual(facts["release_date"], {"value": "1999-05-12", "source": "musicbrainz"})
        self.assertEqual(facts["composer"]["value"], "Com Poser")
        self.assertEqual(facts["mbid"]["value"], MBID)
        row = TrackEnrichment[t.id]
        self.assertEqual((row.status, row.method, row.mbid), ("done", "isrc", MBID))

    def test_what_deezer_states_is_never_overwritten(self):
        t = self.track(isrc=ISRC)
        library.update_track_facts(t, {"release_date": "2001-01-01"}, "deezer")
        eq.enrich_track(t, http=self.http)
        self.assertEqual(self.facts(t)["release_date"], {"value": "2001-01-01", "source": "deezer"})
        self.assertEqual(self.facts(t)["producer"]["source"], "musicbrainz")

    def test_without_an_isrc_the_strict_search_is_tried(self):
        t = self.track()
        self.assertEqual(eq.enrich_track(t, http=self.http)[:2], ("done", "search"))

    def test_a_wrong_match_is_refused_and_remembered_as_nomatch(self):
        self.srv.search_results = [dict(RECORDING, title="Another Song")]
        t = self.track()
        self.assertEqual(eq.enrich_track(t, http=self.http)[:2], ("nomatch", "search"))
        self.assertEqual(self.facts(t).get("composer"), None)
        self.assertEqual(TrackEnrichment[t.id].status, "nomatch")

    def test_a_tried_track_is_not_asked_again_until_forced(self):
        t = self.track(isrc=ISRC)
        eq.enrich_track(t, http=self.http)
        hits = len(self.srv.hits)
        self.assertEqual(eq.enrich_track(t, http=self.http)[0], "skipped")
        self.assertEqual(len(self.srv.hits), hits)
        self.assertEqual(eq.enrich_track(t, http=self.http, force=True)[0], "done")
        self.assertGreater(len(self.srv.hits), hits)

    def test_a_503_is_an_error_row_retried_after_a_day(self):
        self.srv.mode = "503"
        t = self.track(isrc=ISRC)
        status, method, reason = eq.enrich_track(t, http=self.http)
        self.assertEqual((status, method), ("error", "isrc"))
        self.assertIn("503", reason)
        self.assertEqual(TrackEnrichment[t.id].status, "error")
        self.assertEqual(eq.enrich_track(t, http=self.http)[0], "skipped")
        TrackEnrichment.update(tried=dbmod.now() - eq.ERROR_RETRY * 2).execute()
        self.srv.mode = "ok"
        self.http = Http(rates={"127.0.0.1": 0})
        self.assertEqual(eq.enrich_track(t, http=self.http)[0], "done")

    def test_the_user_agent_goes_out_on_every_request(self):
        eq.enrich_track(self.track(isrc=ISRC), http=self.http)
        self.assertTrue(self.srv.hits)
        self.assertTrue(all(ua.startswith("NSupySonic/") for _, ua in self.srv.hits))

    def test_a_track_not_on_disk_is_left_alone(self):
        t = self.track(isrc=ISRC)
        os.remove(t.path)
        self.assertEqual(eq.enrich_track(t, http=self.http)[0], "skipped")
        self.assertEqual(self.srv.hits, [])

    def test_switched_off_asks_nobody(self):
        eq.configure({"enabled": False})
        self.assertEqual(eq.enrich_track(self.track(isrc=ISRC), http=self.http)[0], "skipped")
        self.assertEqual(self.srv.hits, [])

    def test_an_upload_without_a_picture_gets_the_front_cover(self):
        t = self.track(isrc=ISRC)
        Track.update(deezer_id=None).where(Track.id == t.id).execute()
        t = Track[t.id]
        self.assertTrue(cover.wanted(t))
        asked = []

        class Img(Http):
            def get_image(self, url, **kw):
                asked.append(url)
                return b"\xff\xd8\xff" + b"jpeg"

        self.http = Img(rates={"127.0.0.1": 0})
        eq.enrich_track(t, http=self.http)
        self.assertEqual(asked, [f"https://coverartarchive.org/release/{RELEASE}/front-500"])
        self.assertTrue(os.path.isfile(os.path.join(t.folder.path, "cover.jpg")))
        self.assertTrue(Track[t.id].has_art)

    def test_a_deezer_track_never_fetches_a_cover(self):
        self.assertFalse(cover.wanted(self.track()))


class NeverOnTheClickTest(Base):
    def test_queueing_does_not_wait_and_never_touches_the_network(self):
        release = threading.Event()
        started = threading.Event()
        calls = []

        def slow(track, **kw):
            started.set()
            release.wait(10)
            return "done", "isrc", None

        main = threading.get_ident()
        real = requests.Session.request

        def spy(self, *a, **kw):
            calls.append(threading.get_ident())
            return real(self, *a, **kw)

        t = self.track(isrc=ISRC)
        with mock.patch.object(eq, "_under_test", lambda: False), \
                mock.patch.object(eq, "enrich_track", slow), \
                mock.patch.object(requests.Session, "request", spy):
            t0 = time.monotonic()
            self.assertTrue(eq.queue_track(t.id))
            self.assertTrue(started.wait(5))
            # the worker is parked on the (slow) third party; the caller is not
            for _ in range(50):
                eq.queue_track(t.id)
            elapsed = time.monotonic() - t0
            while not eq._queue.empty():  # the worker must not outlive the test's database
                eq._queue.get_nowait()
            release.set()
        self.assertLess(elapsed, 5)  # far below the 10 s the worker was held for
        self.assertNotIn(main, calls)

    def test_a_full_queue_drops_instead_of_blocking(self):
        with mock.patch.object(eq, "_under_test", lambda: False), \
                mock.patch.object(eq, "_ensure_worker", lambda: None):
            while True:
                try:
                    eq._queue.put_nowait("x")
                except Exception:
                    break
            self.assertFalse(eq.queue_track("one-more"))
            while not eq._queue.empty():
                eq._queue.get_nowait()

    def test_nothing_starts_under_test(self):
        with mock.patch.object(eq, "_ensure_worker") as w:
            with self.app.app_context():
                self.assertFalse(eq.queue_track("whatever"))
            w.assert_not_called()

    def test_an_upload_queues_the_track(self):
        from supysonic.deezer import local

        class FakeTag:
            artist, albumartist, album, genre = "Up Artist", None, "Up Album", "Pop"
            title, disc, track, year = "Uploaded Song", 1, 1, None
            length, bitrate, images = 200.0, 256000, []

        queued = []
        self._login()
        with mock.patch.object(local, "_load_tag", lambda p: FakeTag()), \
                mock.patch.object(eq, "queue_track", lambda tid: queued.append(tid)):
            rv = self.client.post(
                "/api/upload",
                data={"files": (BytesIO(b"audiobytes"), "song.mp3")},
                content_type="multipart/form-data",
            )
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(len(queued), 1)
        self.assertEqual(str(Track.get(Track.title == "Uploaded Song").id), str(queued[0]))


class BackfillRouteTest(Base):
    def test_admin_only(self):
        UserManager.add("bob", "B0b")
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        self.assertEqual(self.client.post("/api/enrich/backfill").status_code, 403)
        self.assertEqual(self.client.get("/api/enrich/backfill").status_code, 403)

    def test_the_button_catches_the_library_up_and_reports_coverage(self):
        a = self.track("Une Chanson", 1, isrc=ISRC)
        self.track("Introuvable", 2)
        self.srv.search_results = []
        self._login()
        done = []
        real = backfill.run
        with mock.patch.object(eq, "get_http", lambda: self.http), \
                mock.patch.object(backfill, "run", lambda app, job: (real(app, job), done.append(1))):
            body = self.client.post("/api/enrich/backfill").get_json()
            self.assertTrue(body["ok"])
            for _ in range(200):
                if done:
                    break
                time.sleep(0.05)
        self.assertTrue(done)
        status = self.client.get("/api/enrich/backfill").get_json()
        self.assertFalse(status["running"])
        self.assertEqual(status["done"], 2)
        cov = status["coverage"]
        self.assertEqual(cov["status"], {"done": 1, "nomatch": 1})
        self.assertEqual(cov["found"], {"isrc": 1})
        self.assertEqual(cov["untried"], 0)
        self.assertEqual(library.read_track_facts(a)["mbid"]["value"], MBID)

    def test_a_failing_service_is_named_by_its_cause(self):
        self.srv.mode = "503"
        self.track("One", 1, isrc=ISRC)
        job = backfill.make_job()
        with mock.patch.object(eq, "get_http", lambda: self.http), self.app.app_context():
            snap = job.run()
        self.assertEqual(snap["failed"], 1)
        self.assertTrue(any("503" in r for r in snap["failure_reasons"]))


class RelatedArtistsTest(Base):
    def artist_of(self, name, did, n):
        root = library.get_root_folder(self.archive)
        t = library.upsert_track(
            {
                "SNG_ID": str(8500 + n), "SNG_TITLE": f"T{n}", "ART_NAME": name, "ART_ID": did,
                "ALB_TITLE": f"Al{n}", "ALB_ID": str(600 + n), "DURATION": "200",
                "TRACK_NUMBER": "1", "DISK_NUMBER": "1",
            },
            root,
        )
        return t

    def test_the_page_lists_the_stored_neighbours_as_cards(self):
        me = self.artist_of("Me", "71", 1)
        near = self.artist_of("Near", "72", 2)
        far = self.artist_of("Far", "73", 3)
        TrackNeighbor.create(track=me, neighbor=near, score=0.9, rank=0)
        TrackNeighbor.create(track=me, neighbor=far, score=0.4, rank=1)
        self._login()
        body = self.client.get(f"/api/artist/{me.artist.id}").get_json()
        self.assertEqual([a["name"] for a in body["related"]], ["Near", "Far"])
        card = body["related"][0]
        self.assertEqual(card["id"], str(near.artist.id))
        self.assertEqual(card["deezer_id"], "72")
        self.assertEqual(card["picture"], f"/api/cover/{near.artist.id}")
        # and the card's id opens that artist's page
        self.assertEqual(self.client.get(f"/api/artist/{card['id']}").status_code, 200)

    def test_nobody_is_related_to_an_unmeasured_artist(self):
        me = self.artist_of("Me", "71", 1)
        self._login()
        self.assertEqual(self.client.get(f"/api/artist/{me.artist.id}").get_json()["related"], [])

    def test_it_is_a_handful_of_reads_and_no_deezer(self):
        from .test_deezer import count_statements

        me = self.artist_of("Me", "71", 1)
        for i in range(2, 8):
            n = self.artist_of(f"A{i}", str(70 + i), i)
            TrackNeighbor.create(track=me, neighbor=n, score=1 - i / 10, rank=i)
        self._login()
        with mock.patch.object(type(self.app.deezer), "available", side_effect=AssertionError):
            with count_statements() as c:
                self.client.get(f"/api/artist/{me.artist.id}")
        before = sum(c.values())
        # six neighbours cost the same statements as one: nothing is per row
        TrackNeighbor.delete().where(TrackNeighbor.neighbor != Track.get(Track.title == "T2").id).execute()
        with count_statements() as c2:
            self.client.get(f"/api/artist/{me.artist.id}")
        self.assertEqual(before, sum(c2.values()))

    def test_a_private_upload_is_not_a_neighbour_for_anyone_else(self):
        me = self.artist_of("Me", "71", 1)
        secret = self.artist_of("Secret", "72", 2)
        owner = dbmod.User.get(dbmod.User.name == "alice")
        Track.update(owner=owner).where(Track.id == secret.id).execute()
        TrackNeighbor.create(track=me, neighbor=secret, score=0.9, rank=0)
        # its owner sees it…
        self._login()
        body = self.client.get(f"/api/artist/{me.artist.id}").get_json()
        self.assertEqual([a["name"] for a in body["related"]], ["Secret"])
        # …another member does not
        UserManager.add("bob", "B0b")
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        body = self.client.get(f"/api/artist/{me.artist.id}").get_json()
        self.assertEqual(body["related"], [])


class UpgradeTest(unittest.TestCase):
    """A server that predates this lot: the 20261012 database with its archived
    tracks, the old config (Deezer options, no [enrich] section). It boots, the
    new tables exist, the catch-up fills facts from the (fake) MusicBrainz,
    nothing is asked twice, and booting again changes nothing."""

    make_old_database = _ta.UpgradeTestCase.make_old_database

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "old.db")
        self.srv = FakeMB()

    def tearDown(self):
        self.srv.close()
        eq.configure(None)
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)

    def test_an_existing_server(self):
        self.make_old_database()
        init_database("sqlite:///" + self.path)
        root = library.get_root_folder(self.archive)
        rows = []
        for i in range(3):
            t = library.upsert_track(
                {
                    "SNG_ID": str(900 + i), "SNG_TITLE": "Une Chanson" if i == 0 else f"Old{i}",
                    "ART_NAME": "Artist 1", "ART_ID": "1", "ALB_TITLE": "Old Album",
                    "ALB_ID": "50", "DURATION": "200", "TRACK_NUMBER": str(i + 1),
                    "DISK_NUMBER": "1",
                },
                root,
            )
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"flacdata")
            t.last_modification = 1700000000
            t.save()
            # an archive from before: a sidecar with an ISRC, no musicbrainz facts
            if i == 0:
                library.update_track_facts(t, {"isrc": ISRC}, "deezer")
            rows.append(t)
        release_database()

        path, cache = self.path, self.dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(self.DEEZER, push_to_deezer=True, report_listens=True)
                # no ENRICH override at all: the old file knows nothing of it

        app = create_application(Config())
        self.assertEqual(dbmod.Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
        self.assertEqual(app.config["ENRICH"]["enabled"], True)
        self.assertEqual(TrackEnrichment.select().count(), 0)
        UserManager.add("alice", "Alic3", admin=True)
        client = app.test_client()
        client.post("/api/login", json={"username": "alice", "password": "Alic3"})
        # the page answers at once, before anything was enriched
        self.assertEqual(client.get(f"/api/artist/{rows[0].artist.id}").get_json()["related"], [])
        self.assertEqual(client.get("/api/enrich/backfill").get_json()["coverage"]["untried"], 3)

        http = Http(rates={"127.0.0.1": 0})
        with mock.patch.object(mb, "BASE", self.srv.base), \
                mock.patch.object(eq, "get_http", lambda: http), app.app_context():
            snap = backfill.make_job().run()
        self.assertEqual(snap["failed"], 0)
        self.assertEqual(library.read_track_facts(rows[0])["composer"]["value"], "Com Poser")
        # the two tracks of other titles asked and were refused: three tried
        cov = backfill.coverage()
        self.assertEqual(cov["tried"], 3)
        self.assertEqual(cov["found"], {"isrc": 1})
        # a second run asks nobody
        hits = len(self.srv.hits)
        with mock.patch.object(mb, "BASE", self.srv.base), \
                mock.patch.object(eq, "get_http", lambda: http), app.app_context():
            backfill.make_job().run()
        self.assertEqual(len(self.srv.hits), hits)
        release_database()
        init_database("sqlite:///" + self.path)
        self.assertEqual(TrackEnrichment.select().count(), 3)

    def test_an_ini_file_can_set_the_options(self):
        p = os.path.join(self.dir, "s.conf")
        with open(p, "w") as fh:
            fh.write("[base]\ndatabase_uri = sqlite:///x.db\n[enrich]\nenabled = no\nacoustid_key = k\n")
        from supysonic.config import IniConfig

        cfg = IniConfig(p)
        self.assertEqual(cfg.ENRICH["acoustid_key"], "k")
        self.assertFalse(cfg.ENRICH["enabled"])
        self.assertIsNone(cfg.ENRICH["contact"])


if __name__ == "__main__":
    unittest.main()

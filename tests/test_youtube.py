# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The YouTube fallback, offline.

What it promises is mostly about what it does NOT do — ask YouTube — so most of
these count the requests: a search is one request and is not repeated, a hit
costs nothing until it is played, a prefetch never fetches, and a played track
is fetched once and then served from disk. The audio the fake download hands
over is a real Ogg Opus file written by ffmpeg, so the remux-and-serve path,
the tagging and the transcode run on the real thing.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from supysonic.config import DefaultConfig
from supysonic.db import StarredTrack, Track, release_database
from supysonic.deezer import youtube as yt
from supysonic.managers.user import UserManager
from supysonic.web import create_application

HAS_FFMPEG = shutil.which("ffmpeg") is not None

RAW = [
    {
        "videoId": "fa5IWHDbftI",
        "title": "One More Time",
        "artists": [{"name": "Daft Punk", "id": "UCRr1xG_2WIDs18a6cIiCxeA"}],
        "album": {"name": "Discovery", "id": "MPREb_7ltM34kr0mH"},
        "duration_seconds": 321,
        "isExplicit": False,
        "thumbnails": [
            {"url": "https://lh3.googleusercontent.com/x=w60-h60-l90-rj", "width": 60},
            {"url": "https://lh3.googleusercontent.com/x=w120-h120-l90-rj", "width": 120},
        ],
    },
    {
        "videoId": "AIKwmk4mnNw",
        "title": "One More Time (feat. Alida)",
        "artists": [{"name": "Robin Schulz", "id": "UCI"}, {"name": "Felix Jaehn", "id": "UCJ"}],
        "album": None,
        "duration_seconds": 200,
        "thumbnails": [],
    },
    # Not a usable hit: an id that would not survive into a URL.
    {"videoId": "../etc/passwd", "title": "evil"},
]


class FakeYTMusic:
    def __init__(self, answer=RAW, error=None):
        self.calls = []
        self.answer = answer
        self.error = error

    def search(self, query, filter=None, limit=None):
        self.calls.append((query, filter))
        if self.error:
            raise self.error
        return self.answer


def _opus(path, seconds=3, kbps=128):
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi",
            "-i", f"sine=frequency=440:duration={seconds}",
            "-ac", "2", "-c:a", "libopus", "-b:a", f"{kbps}k", "-f", "ogg", "-y", path,
        ],
        check=True,
    )


class YoutubeTestCase(unittest.TestCase):
    def setUp(self):
        yt.reset()
        self.fd, self.db_path = tempfile.mkstemp()
        self.cache = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path, cache, archive = self.db_path, self.cache, self.archive

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(getattr(self, "DEEZER", {}), archive_dir=archive, enabled=False)

        self.app = create_application(Config())
        self.app.deezer = None
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bb", admin=False)
        self.client = self.app.test_client()

        self.fake = FakeYTMusic()
        p = mock.patch.object(yt, "_client", lambda: self.fake)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(yt, "installed", lambda: True)
        p.start()
        self.addCleanup(p.stop)
        # The art is Google's CDN: never reached from a test.
        self.thumbs = []
        p = mock.patch.object(yt, "fetch_thumbnail", lambda url: self.thumbs.append(url) or None)
        p.start()
        self.addCleanup(p.stop)
        # The whole-track analysis a new archive queues runs on a thread of its
        # own, past the end of the test; it has its own tests.
        p = mock.patch("supysonic.deezer.analysis.queue_analysis", lambda *a, **k: None)
        p.start()
        self.addCleanup(p.stop)
        self.downloads = []

    def tearDown(self):
        release_database()
        yt.reset()
        shutil.rmtree(self.cache, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.fd)
        os.remove(self.db_path)

    def _login(self, who="alice", pw="Alic3"):
        rv = self.client.post("/api/login", json={"username": who, "password": pw})
        self.assertEqual(rv.status_code, 200)

    def _fake_download(self, kbps=128, error=None):
        def download(video_id, workdir):
            self.downloads.append(video_id)
            if error is not None:
                raise error
            out = os.path.join(workdir, f"{video_id}.opus")
            _opus(out, kbps=kbps)
            return out

        p = mock.patch.object(yt, "_download", download)
        p.start()
        self.addCleanup(p.stop)

    def _search(self, q="daft punk one more time"):
        rv = self.client.get("/api/youtube/search", query_string={"q": q})
        self.assertEqual(rv.status_code, 200, rv.get_data(as_text=True))
        return rv.get_json()["tracks"]

    # -- searching ------------------------------------------------------------

    def test_a_search_is_one_request_and_is_not_repeated(self):
        self._login()
        first = self._search()
        self.assertEqual(self.fake.calls, [("daft punk one more time", "songs")])
        # The same words, spaced and cased differently: the cached answer.
        again = self._search("  Daft PUNK one more   time ")
        self.assertEqual(len(self.fake.calls), 1)
        self.assertEqual(first, again)
        # The unusable id never made it into an answer.
        self.assertEqual([t["youtube_id"] for t in first], ["fa5IWHDbftI", "AIKwmk4mnNw"])

    def test_an_empty_answer_is_remembered_too(self):
        self._login()
        self.fake.answer = []
        self.assertEqual(self._search("nothing at all"), [])
        self.assertEqual(self._search("nothing at all"), [])
        self.assertEqual(len(self.fake.calls), 1)

    def test_a_hit_is_shaped_like_a_track_under_its_future_id(self):
        self._login()
        hit = self._search()[0]
        tid = str(yt.track_uuid("fa5IWHDbftI"))
        self.assertEqual(hit["deezer_id"], tid)
        self.assertEqual(hit["source"], "youtube")
        self.assertEqual(hit["bitrate"], 0)
        self.assertEqual(hit["duration"], 321)
        self.assertEqual(hit["album"]["title"], "Discovery")
        self.assertEqual(hit["album"]["cover"], "/api/cover/" + tid)
        # No page to open behind these names: no ids for the SPA to link.
        self.assertEqual(hit["album"]["deezer_id"], "")
        self.assertEqual({a["deezer_id"] for a in hit["artists"]}, {""})
        two = self._search()[1]
        self.assertEqual(two["display_artist"], "Robin Schulz, Felix Jaehn")
        # No album: its own title stands in.
        self.assertEqual(two["album"]["title"], "One More Time (feat. Alida)")
        # Nothing was created by searching.
        with self.app.app_context():
            self.assertEqual(Track.select().count(), 0)

    def test_the_art_is_asked_for_square_and_large(self):
        self.assertEqual(
            yt.normalize_hit(RAW[0])["thumb"], "https://lh3.googleusercontent.com/x=w544-h544-l90-rj"
        )

    def test_a_refusal_leaves_youtube_alone(self):
        self._login()
        self.fake.error = RuntimeError("HTTP Error 429: Too Many Requests")
        rv = self.client.get("/api/youtube/search", query_string={"q": "a"})
        self.assertEqual(rv.status_code, 503)
        self.assertEqual(rv.headers["X-NS-Error"], "youtube-unreachable")
        # The next search does not even ask.
        rv = self.client.get("/api/youtube/search", query_string={"q": "b"})
        self.assertEqual(rv.status_code, 503)
        self.assertEqual(len(self.fake.calls), 1)
        held, left, _ = yt.held()
        self.assertTrue(held)
        self.assertGreater(left, 600)
        self.assertGreater(int(rv.headers["Retry-After"]), 600)

    def test_the_admin_switch_turns_it_off_for_everyone(self):
        self._login()
        rv = self.client.put("/api/youtube/settings", json={"enabled": False})
        self.assertEqual(rv.get_json()["enabled"], False)
        self.client.post("/api/logout")
        self._login("bob", "B0bb")
        rv = self.client.get("/api/youtube/search", query_string={"q": "a"})
        self.assertEqual(rv.status_code, 503)
        self.assertEqual(rv.headers["X-NS-Error"], "youtube-disabled")
        self.assertEqual(self.fake.calls, [])
        # A guest cannot switch it back.
        self.assertEqual(
            self.client.put("/api/youtube/settings", json={"enabled": True}).status_code, 403
        )

    # -- playing --------------------------------------------------------------

    @unittest.skipUnless(HAS_FFMPEG, "needs ffmpeg")
    def test_a_first_play_fetches_once_then_plays_from_disk(self):
        self._fake_download(kbps=128)
        self._login()
        tid = self._search()[0]["deezer_id"]
        rv = self.client.get(f"/api/stream/{tid}")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.mimetype, "audio/ogg")
        self.assertEqual(rv.get_data()[:4], b"OggS")
        rv.close()
        self.assertEqual(self.downloads, ["fa5IWHDbftI"])
        with self.app.app_context():
            row = Track.get_by_id(tid)
            self.assertEqual(row.youtube_id, "fa5IWHDbftI")
            self.assertIsNone(row.deezer_id)
            self.assertTrue(os.path.isfile(row.path))
            self.assertIn(os.sep + "YouTube" + os.sep, row.path)
            self.assertTrue(row.path.endswith("One More Time [fa5IWHDbftI].opus"))
            self.assertGreater(row.last_modification, 0)
            # The file's real rate, not the asked-for one (a 3 s sine at 128k
            # comes out somewhat under it: Opus VBR on a pure tone).
            self.assertTrue(40 <= row.bitrate <= 200, row.bitrate)
            sidecar = os.path.splitext(row.path)[0] + ".json"
            with open(sidecar) as fh:
                self.assertIn('"video_id": "fa5IWHDbftI"', fh.read())
            from mutagen.oggopus import OggOpus

            tags = OggOpus(row.path)
            self.assertEqual(tags["title"], ["One More Time"])
            self.assertEqual(tags["album"], ["Discovery"])
        # Again: from disk, no second fetch.
        rv = self.client.get(f"/api/stream/{tid}")
        self.assertEqual(rv.status_code, 200)
        rv.close()
        self.assertEqual(self.downloads, ["fa5IWHDbftI"])

    @unittest.skipUnless(HAS_FFMPEG, "needs ffmpeg")
    def test_the_file_is_served_as_is_unless_less_is_asked(self):
        self._fake_download(kbps=128)
        self._login()
        tid = self._search()[0]["deezer_id"]
        self.client.get(f"/api/stream/{tid}").close()
        with self.app.app_context():
            row = Track.get_by_id(tid)
            size, source = os.path.getsize(row.path), row.bitrate
        # About what it holds, or more: the file itself, byte for byte.
        for q in ("OPUS_320", "OPUS_128", ""):
            rv = self.client.get(f"/api/stream/{tid}", query_string={"q": q} if q else {})
            body = rv.get_data()
            rv.close()
            self.assertEqual(len(body), size, q)
            self.assertEqual(rv.headers["X-NS-Source-Bitrate"], str(source))
        # Less: a transcode, smaller than the file.
        rv = self.client.get(f"/api/stream/{tid}", query_string={"q": "OPUS_64"})
        body = rv.get_data()
        rv.close()
        self.assertGreater(source, 64 + 16)  # or the case below is not a transcode
        self.assertNotIn("X-NS-Source-Bitrate", rv.headers)
        self.assertLess(len(body), size)
        self.assertEqual(body[:4], b"OggS")

    def test_a_prefetch_never_asks_youtube(self):
        self._fake_download()
        self._login()
        tid = self._search()[0]["deezer_id"]
        rv = self.client.get(f"/api/stream/{tid}", headers={"X-NS-Background": "1"})
        self.assertEqual(rv.status_code, 503)
        self.assertEqual(self.downloads, [])

    def test_youtube_saying_gone_is_a_verdict(self):
        self._fake_download(error=RuntimeError("ERROR: [youtube] x: Video unavailable"))
        self._login()
        tid = self._search()[0]["deezer_id"]
        rv = self.client.get(f"/api/stream/{tid}")
        self.assertEqual(rv.status_code, 410)
        with self.app.app_context():
            self.assertIsNotNone(Track.get_by_id(tid).unavailable)

    def test_not_reaching_youtube_is_not_a_verdict(self):
        self._fake_download(error=RuntimeError("Unable to download webpage: timed out"))
        self._login()
        tid = self._search()[0]["deezer_id"]
        rv = self.client.get(f"/api/stream/{tid}")
        self.assertEqual(rv.status_code, 502)
        with self.app.app_context():
            self.assertIsNone(Track.get_by_id(tid).unavailable)
        # ...and the next play does not hammer it.
        rv = self.client.get(f"/api/stream/{tid}")
        self.assertEqual(rv.status_code, 502)
        self.assertEqual(len(self.downloads), 1)
        # The probe says "unknown", never "dead", and asks nobody.
        rv = self.client.get(f"/api/track/{tid}/probe")
        self.assertEqual(rv.get_json(), {"available": True, "reason": "unknown"})
        self.assertEqual(len(self.downloads), 1)

    def test_an_id_nobody_searched_for_is_unknown(self):
        self._login()
        rv = self.client.get(f"/api/stream/{yt.track_uuid('zzzzzzzzzzz')}")
        self.assertEqual(rv.status_code, 400)
        with self.app.app_context():
            self.assertEqual(Track.select().count(), 0)

    def test_a_restart_still_knows_what_was_on_screen(self):
        self._login()
        tid = self._search()[0]["deezer_id"]
        with yt._lock:
            yt._hits.clear()  # the process's memory, gone
        rv = self.client.post("/api/favorite", json={"deezer_id": tid, "on": True})
        self.assertEqual(rv.status_code, 200)
        with self.app.app_context():
            self.assertEqual(Track.get_by_id(tid).title, "One More Time")

    # -- the rest of the app --------------------------------------------------

    def test_starring_or_adding_a_hit_makes_the_row_and_downloads_nothing(self):
        self._fake_download()
        self._login()
        tid, tid2 = [t["deezer_id"] for t in self._search()]
        rv = self.client.post("/api/favorite", json={"deezer_id": tid, "on": True})
        self.assertEqual(rv.status_code, 200)
        # What every playlist edit resolves its track ids through.
        from supysonic import webui

        with self.app.test_request_context():
            from flask import request

            request.webuser = None
            rows = webui._resolve_tracks(None, [tid2])
        self.assertEqual([str(r.id) for r in rows], [tid2])
        with self.app.app_context():
            self.assertEqual(StarredTrack.select().count(), 1)
            self.assertEqual(Track.get_by_id(tid2).youtube_id, "AIKwmk4mnNw")
        self.assertEqual(self.downloads, [])
        favs = self.client.get("/api/me/favorites").get_json()["tracks"]
        self.assertEqual([(f["deezer_id"], f["source"]) for f in favs], [(tid, "youtube")])

    def test_the_two_serializers_agree_on_a_youtube_row(self):
        from supysonic import webui

        self._login()
        tid = self._search()[0]["deezer_id"]
        self.client.post("/api/favorite", json={"deezer_id": tid, "on": True})
        with self.app.test_request_context():
            from supysonic.db import Album, Artist

            q = (
                Track.select(Track, Album, Artist).join(Album).switch(Track).join(Artist)
                .where(Track.id == tid)
            )
            fast, slow = webui._db_tracks(q), webui._db_tracks(list(q))
        self.assertEqual(fast, slow)
        self.assertEqual(fast[0]["source"], "youtube")
        self.assertEqual(fast[0]["album"]["cover"], "/api/cover/" + tid)

    def test_an_unarchived_row_is_not_a_local_search_result_or_an_upload(self):
        self._login()
        tid = self._search()[0]["deezer_id"]
        self.client.post("/api/favorite", json={"deezer_id": tid, "on": True})
        rv = self.client.get("/api/search", query_string={"q": "One More"})
        self.assertEqual(rv.get_json()["tracks"], [])
        self.assertEqual(self.client.get("/api/me/local").get_json()["tracks"], [])

    def test_the_local_scan_keeps_unarchived_rows_and_skips_the_staging(self):
        from supysonic.deezer import local

        self._login()
        tid = self._search()[0]["deezer_id"]
        self.client.post("/api/favorite", json={"deezer_id": tid, "on": True})
        staging = os.path.join(self.archive, yt.STAGING_DIR, "x")
        os.makedirs(staging)
        with open(os.path.join(staging, "half.opus"), "wb") as fh:
            fh.write(b"OggS" + b"\0" * 64)
        with self.app.app_context():
            result = local.scan_local(self.archive)
            self.assertEqual(result, {"added": 0, "removed": 0})
            self.assertIsNotNone(Track.get_or_none(Track.id == tid))

    def test_replacement_candidates_ask_youtube_only_when_told(self):
        self._login()
        tid = self._search()[0]["deezer_id"]
        self.client.post("/api/favorite", json={"deezer_id": tid, "on": True})
        self.fake.calls.clear()
        yt.reset()
        rv = self.client.get(f"/api/replace/candidates/{tid}")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(self.fake.calls, [])
        rv = self.client.get(f"/api/replace/candidates/{tid}", query_string={"youtube": "1"})
        ids = [c["deezer_id"] for c in rv.get_json()["candidates"]]
        self.assertEqual(len(self.fake.calls), 1)
        self.assertNotIn(tid, ids)  # the track itself is no replacement
        self.assertIn(str(yt.track_uuid("AIKwmk4mnNw")), ids)

    def test_the_cover_of_a_hit_comes_from_its_thumbnail_once(self):
        self._login()
        tid = self._search()[0]["deezer_id"]
        rv = self.client.get(f"/api/cover/{tid}")
        self.assertEqual(rv.status_code, 404)  # the fake CDN has nothing
        self.assertEqual(self.thumbs, ["https://lh3.googleusercontent.com/x=w544-h544-l90-rj"])


if __name__ == "__main__":
    unittest.main()

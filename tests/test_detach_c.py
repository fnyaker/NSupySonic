# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot C of the Deezer detachment: sidecar facts, the library job, file tags,
the measured gain, LRCLIB-only lyrics — and that a server that already has data
(old sidecars, Deezer gains, plain .lrc files, a cursor) upgrades cleanly."""

import json
import os
import time
import unittest
import uuid
from unittest import mock

import mutagen
from mutagen.flac import FLAC
from mutagen.id3 import ID3, TBPM, TCOM, TDRC, TPUB, TSRC
from mutagen.mp3 import MP3
from mutagen.oggvorbis import OggVorbis

from supysonic import filetags, libjob
from supysonic.db import Meta, Track
from supysonic.deezer import analysis, library, lyrics

from . import test_deezer_lyrics as _tl
from . import test_webui as _tw
from .test_deezer import count_statements

SYNCED_LRC, FakeResp, FakeSession = _tl.SYNCED_LRC, _tl.FakeResp, _tl.FakeSession
raw_track = _tw.raw_track


# The fixtures of the two suites, borrowed without inheriting (and so re-running)
# their tests.
class LyricsTestCase(_tl.TestBase):
    _archived_track = _tl.LyricsTestCase._archived_track

    def setUp(self):
        import tempfile

        super().setUp()
        self.archive_dir = tempfile.mkdtemp()
        self.root = library.get_root_folder(self.archive_dir)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.archive_dir, ignore_errors=True)
        super().tearDown()


class WebUITestCase(unittest.TestCase):
    setUp = _tw.WebUITestCase.setUp
    tearDown = _tw.WebUITestCase.tearDown
    _login = _tw.WebUITestCase._login


class FactsTest(LyricsTestCase):
    def test_merge_priority_and_values(self):
        t = self._archived_track()
        self.assertTrue(library.update_track_facts(t, {"isrc": "A", "x": ""}, "deezer"))
        # A weaker source never overwrites; a stronger one does; same refreshes.
        self.assertFalse(library.update_track_facts(t, {"isrc": "B"}, "musicbrainz"))
        self.assertTrue(library.update_track_facts(t, {"isrc": "C"}, "tags"))
        self.assertFalse(library.update_track_facts(t, {"isrc": "D"}, "deezer"))
        self.assertTrue(library.update_track_facts(t, {"isrc": "D"}, "deezer", override=True))
        facts = library.read_track_facts(t)
        self.assertEqual(facts["isrc"], {"value": "D", "source": "deezer"})
        self.assertNotIn("x", facts)

    def test_rewrite_keeps_facts(self):
        t = self._archived_track()
        library.update_track_facts(t, {"label": "L"}, "tags")
        library.save_track_metadata(t, {"SNG_ID": "1"})
        self.assertEqual(library.read_track_facts(t)["label"]["value"], "L")

    def test_atomic_write(self):
        t = self._archived_track()
        library.update_track_facts(t, {"label": "L"}, "tags")
        path = library.metadata_path(t)
        before = open(path).read()
        with mock.patch("json.dump", side_effect=OSError("disk")):
            self.assertFalse(library.update_track_facts(t, {"label": "M"}, "tags", override=True))
        self.assertEqual(open(path).read(), before)
        self.assertFalse(os.path.exists(path + ".part"))

    def test_old_sidecar_without_facts_upgrades(self):
        t = self._archived_track()
        library.save_track_metadata(t, {"SNG_ID": "1"})
        data = json.load(open(library.metadata_path(t)))
        self.assertNotIn("facts", data)  # what an existing server has on disk
        self.assertEqual(library.read_track_facts(t), {})
        library.update_track_facts(t, {"bpm": 150}, "tags")
        data = json.load(open(library.metadata_path(t)))
        self.assertEqual(data["deezer_id"], t.deezer_id)  # nothing else lost
        self.assertEqual(data["facts"]["bpm"]["value"], 150)


class LibJobTest(unittest.TestCase):
    def setUp(self):
        from supysonic.config import DefaultConfig
        from supysonic.web import create_application
        import tempfile, shutil

        self.dir = tempfile.mkdtemp()
        db = os.path.join(self.dir, "db")

        class Cfg(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=self.dir_)

        Cfg.dir_ = self.dir
        self.app = create_application(Cfg())
        self.ctx = self.app.app_context()
        self.ctx.push()
        from supysonic.db import Folder, Artist, Album

        root = Folder.create(name="r", path=self.dir, root=True)
        artist = Artist.create(name="a")
        album = Album.create(name="b", artist=artist)
        from supysonic.db import db as pdb

        with pdb.atomic():
            for i in range(2500):
                Track.create(
                    title=f"t{i}", number=1, disc=1, artist=artist, album=album,
                    folder=root, root_folder=root, path=f"{self.dir}/{i}.mp3", duration=1,
                    bitrate=1, last_modification=1,
                )
        self.shutil = shutil

    def tearDown(self):
        from supysonic.db import release_database

        self.ctx.pop()
        release_database()
        self.shutil.rmtree(self.dir, ignore_errors=True)

    def job(self, work, **kw):
        return libjob.LibraryJob("t", Track.select(), work, cursor_key="test_cursor", **kw)

    def test_full_run_counts_causes(self):
        seen = []

        def work(t):
            seen.append(t.id)
            if t.title.endswith("7"):
                return "bad seven"
            if t.title.endswith("3"):
                raise ValueError("three")

        snap = self.job(work).run()
        self.assertEqual(len(seen), 2500)
        self.assertEqual(snap["done"] + snap["failed"], 2500)
        self.assertEqual(snap["failure_reasons"]["bad seven"], 250)
        self.assertEqual(snap["failure_reasons"]["ValueError: three"], 250)
        self.assertLessEqual(len(snap["failures"]), libjob.FAILURE_SAMPLE_MAX)
        self.assertIsNone(Meta.get_or_none(Meta.key == "test_cursor"))

    def test_resume_at_cursor_after_interruption(self):
        seen = []
        self.job(lambda t: seen.append(t.id)).run(limit=600)
        first = len(seen)
        self.assertGreaterEqual(first, 600)
        self.assertIsNotNone(Meta.get_or_none(Meta.key == "test_cursor"))
        self.job(lambda t: seen.append(t.id)).run()
        self.assertEqual(len(seen), 2500)  # nothing twice, nothing missed
        self.assertEqual(len(set(seen)), 2500)

    def test_stale_cursor_and_other_force_ignored(self):
        seen = []
        self.job(lambda t: seen.append(1)).run(limit=1)
        row = Meta.get(Meta.key == "test_cursor")
        state = json.loads(row.value)
        state["at"] = time.time() - libjob.RESUME_MAX_AGE - 10
        row.value = json.dumps(state)
        row.save()
        seen.clear()
        self.job(lambda t: seen.append(1)).run()
        self.assertEqual(len(seen), 2500)
        # A cursor left by a different `force` is not this run's.
        self.job(lambda t: None).run(limit=1)
        seen.clear()
        self.job(lambda t: seen.append(1), force=True).run()
        self.assertEqual(len(seen), 2500)

    def test_snapshot_copyable_while_running(self):
        job = self.job(lambda t: "x")
        snaps = []

        def work(t):
            snaps.append(json.dumps(job.snapshot()))
            return "x"

        job.work = work
        job.run(limit=300)
        self.assertGreater(len(snaps), 100)
        self.assertEqual(json.loads(snaps[-1])["running"], True)
        self.assertFalse(job.snapshot()["running"])

    def test_cursor_key_must_fit(self):
        with self.assertRaises(ValueError):
            libjob.LibraryJob("x", Track.select(), lambda t: None, cursor_key="k" * 33)


class FileTagsTest(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def test_flac(self):
        import shutil, subprocess

        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg")
        p = os.path.join(self.dir, "a.flac")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=d=1", p], check=True)
        f = FLAC(p)
        f["isrc"] = "FR-Z03-14-00123"
        f["date"] = "2014-05-06"
        f["composer"] = "C"
        f["label"] = "Lab"
        f["bpm"] = "174"
        f["genre"] = "Frenchcore"
        f.save()
        facts = filetags.read_file_facts(p)
        self.assertEqual(facts["isrc"], "FRZ031400123")
        self.assertEqual(facts["date"], "2014-05-06")
        self.assertEqual(facts["composer"], "C")
        self.assertEqual(facts["label"], "Lab")
        self.assertEqual(facts["bpm"], 174.0)
        self.assertEqual(facts["genre"], "Frenchcore")
        f = FLAC(p)
        f["date"] = "2014"
        f["bpm"] = "9999"
        f.save()
        facts = filetags.read_file_facts(p)
        self.assertEqual(facts["date"], "2014")
        self.assertNotIn("bpm", facts)

    def test_ogg(self):
        import shutil, subprocess

        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg")
        p = os.path.join(self.dir, "a.ogg")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=d=1",
                        "-c:a", "libvorbis", p], check=True)
        f = OggVorbis(p)
        f["date"] = "2020-01-02"
        f["publisher"] = "Pub"
        f.save()
        facts = filetags.read_file_facts(p)
        self.assertEqual(facts["date"], "2020-01-02")
        self.assertEqual(facts["label"], "Pub")

    def test_mp3(self):
        import shutil, subprocess

        if not shutil.which("ffmpeg"):
            self.skipTest("ffmpeg")
        p = os.path.join(self.dir, "a.mp3")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=d=1", p], check=True)
        t = ID3()
        t.add(TSRC(encoding=3, text="GBDUW0000059"))
        t.add(TDRC(encoding=3, text="2007-11-19"))
        t.add(TCOM(encoding=3, text="Composer"))
        t.add(TPUB(encoding=3, text="Label"))
        t.add(TBPM(encoding=3, text="128"))
        t.save(p)
        facts = filetags.read_file_facts(p)
        self.assertEqual(facts["isrc"], "GBDUW0000059")
        self.assertEqual(facts["date"], "2007-11-19")
        self.assertEqual(facts["composer"], "Composer")
        self.assertEqual(facts["label"], "Label")
        self.assertEqual(facts["bpm"], 128.0)

    def test_never_raises(self):
        p = os.path.join(self.dir, "junk.flac")
        open(p, "wb").write(b"not audio")
        self.assertEqual(filetags.read_file_facts(p), {})
        self.assertEqual(filetags.read_file_facts(os.path.join(self.dir, "none")), {})


class GainTest(WebUITestCase):
    def _upload_row(self, owner=None):
        from supysonic.deezer import library

        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            row = library.upsert_track(raw_track(77, "Up"), root, "FLAC")
            row.deezer_id = None
            row.gain = None
            row.save()
            return str(row.id), row

    def test_gain_formula(self):
        self.assertAlmostEqual(analysis.gain_from_lufs(-9.6), -10.0)
        self.assertIsNone(analysis.gain_from_lufs(None))
        self.assertIsNone(analysis.gain_from_lufs(float("-inf")))

    def test_apply_measured_gain_and_regain_pass(self):
        self._login()
        with self.app.app_context():
            from supysonic.db import TrackAnalysis, now

            _, row = self._upload_row()
            TrackAnalysis.create(
                track=row, version=1, analyzed=now(), bpm=0, bpm_confidence=0,
                bpm_source="x", style="x", style_confidence=0, archetype="x",
                data=json.dumps({"lufs": -8.4}),
            )
            self.assertEqual(analysis.regain_from_analyses(), 1)
            self.assertAlmostEqual(Track[row.id].gain, -8.8)
            self.assertEqual(analysis.regain_from_analyses(), 0)  # idempotent

    def test_routes_take_uuid_and_deezer_ids_without_network(self):
        from supysonic.deezer import ids

        self._login()
        uid, row = self._upload_row()
        with self.app.app_context():
            Track.update(gain=-5.5).where(Track.id == row.id).execute()
        self.assertAlmostEqual(self.client.get(f"/api/gain/{uid}").get_json()["gain"], -5.5)
        # A Deezer row, asked by its numeric id.
        with self.app.app_context():
            from supysonic.deezer import library

            r = library.upsert_track(raw_track(5, "D"), library.get_root_folder(self.archive), "FLAC")
            r.gain = -7.0
            r.save()
        gw = self.app.deezer.dz.gw
        gw.gain_batches = []
        ids_ = ["5", uid] + [str(uuid.uuid4()) for _ in range(98)]
        with count_statements() as c:
            data = self.client.post("/api/gains", json={"ids": ids_}).get_json()
        self.assertAlmostEqual(data["gains"]["5"], -7.0)
        self.assertAlmostEqual(data["gains"][uid], -5.5)
        self.assertEqual(len(data["gains"]), 100)
        self.assertEqual(gw.gain_batches, [])
        # One query for the hundred ids (plus the session's own lookups).
        self.assertLessEqual(c["SELECT"], 3, dict(c))


class LyricsRoutesTest(WebUITestCase):
    def _archived(self, sid=9):
        from supysonic.deezer import library

        with self.app.app_context():
            t = library.upsert_track(
                dict(raw_track(sid, "Song"), DURATION=200),
                library.get_root_folder(self.archive), "FLAC",
            )
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            open(t.path, "wb").write(b"\x00")
            return t

    def test_archived_never_touches_the_network_in_the_request(self):
        self._login()
        t = self._archived()
        lyrics.write_sidecar(t, {"synced": [{"time": 1, "text": "x"}], "text": "x"})

        class Boom:
            def get(self, *a, **k):
                raise AssertionError("network")

        with mock.patch("requests.get", Boom().get), mock.patch.object(
            lyrics.requests, "Session", Boom
        ):
            data = self.client.get(f"/api/lyrics/{t.id}").get_json()
        self.assertEqual(data["lyrics"]["synced"][0]["text"], "x")

    def test_unsearched_archive_answers_null_and_searches_after(self):
        self._login()
        t = self._archived()
        started = []
        with mock.patch("supysonic.webui._lyrics_in_background", started.append):
            data = self.client.get(f"/api/lyrics/{t.id}").get_json()
        self.assertIsNone(data["lyrics"])
        self.assertEqual(started, [t.id])
        # Once tried, it is not searched again.
        with self.app.app_context():
            library.update_track_facts(t, {"lyrics_tried": 1}, "local")
        started.clear()
        with mock.patch("supysonic.webui._lyrics_in_background", started.append):
            self.client.get(f"/api/lyrics/{t.id}")
        self.assertEqual(started, [])

    def test_cold_track_one_short_lrclib_request(self):
        self._login()
        from supysonic.deezer import library

        with self.app.app_context():
            t = library.upsert_track(
                dict(raw_track(31, "Cold"), DURATION=200),
                library.get_root_folder(self.archive), "FLAC",
            )
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC, "duration": 201})})
        with mock.patch.object(lyrics, "requests", sess):
            sess.RequestException = Exception
            data = self.client.get(f"/api/lyrics/{t.id}").get_json()
        self.assertEqual(len(sess.calls), 1)
        self.assertEqual(len(data["lyrics"]["synced"]), 3)

    def test_cold_answer_is_asked_once_and_kept_by_the_archive(self):
        # A first play's view gets LRCLIB's answer in the request; a second
        # view (another device, the panel reopened) used to ask again, and so
        # did the archive's next view in the background. Measured: 2 then 3
        # LRCLIB requests for one track; now 1.
        self._login()
        with self.app.app_context():
            t = library.upsert_track(
                dict(raw_track(32, "Cold"), DURATION=200),
                library.get_root_folder(self.archive), "FLAC",
            )
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC, "duration": 201})})
        with mock.patch.object(lyrics, "requests", sess):
            sess.RequestException = Exception
            self.client.get(f"/api/lyrics/{t.id}")
            again = self.client.get(f"/api/lyrics/{t.id}").get_json()
            self.assertEqual(len(sess.calls), 1)
            self.assertEqual(len(again["lyrics"]["synced"]), 3)
            # The play finishes and archives it: the finalize step (which never
            # asks LRCLIB itself) writes the answer the view already had.
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            open(t.path, "wb").write(b"\x00")
            with self.app.app_context():
                kept = lyrics.ensure_lyrics(None, Track[t.id], allow_lrclib=False, embed=False)
            self.assertEqual(len(kept["synced"]), 3)
            self.assertEqual(len(lyrics.read_sidecar(t)["synced"]), 3)
            with self.app.app_context():
                self.assertTrue(lyrics.lyrics_tried(Track[t.id]))
            started = []
            with mock.patch("supysonic.webui._lyrics_in_background", started.append):
                self.client.get(f"/api/lyrics/{t.id}")
            self.assertEqual(started, [])
            self.assertEqual(len(sess.calls), 1)

    def test_cold_transport_failure_is_not_kept(self):
        self._login()
        with self.app.app_context():
            t = library.upsert_track(
                dict(raw_track(33, "Cold"), DURATION=200),
                library.get_root_folder(self.archive), "FLAC",
            )
        sess = FakeSession({"get": FakeResp(500, {})})
        with mock.patch.object(lyrics, "requests", sess):
            sess.RequestException = Exception
            self.client.get(f"/api/lyrics/{t.id}")
            self.client.get(f"/api/lyrics/{t.id}")
        # LRCLIB did not answer: nothing to remember, the next view asks again.
        self.assertEqual(len(sess.calls), 2)
        self.assertEqual(lyrics.recall_cold(t.id), (False, None))


class LrclibRulesTest(LyricsTestCase):
    def test_duration_off_by_20s_refused(self):
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC, "duration": 220})})
        self.assertIsNone(lyrics.fetch_lrclib("T", "A", None, 200, session=sess))
        ok = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC, "duration": 202})})
        self.assertIsNotNone(lyrics.fetch_lrclib("T", "A", None, 200, session=ok))

    def test_plain_replaced_by_synced_never_reverse(self):
        t = self._archived_track()
        lyrics.write_sidecar(t, {"synced": [], "text": "plain", "source": "x"})
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC})})
        res = lyrics.ensure_lyrics(None, t, session=sess, embed=False)
        self.assertTrue(res["synced"])
        self.assertTrue(lyrics.read_sidecar(t)["synced"])
        self.assertTrue(lyrics.lyrics_tried(t))
        # Synced stays, whatever LRCLIB would say now.
        sess2 = FakeSession({"get": FakeResp(200, {"plainLyrics": "p"})})
        res = lyrics.ensure_lyrics(None, t, session=sess2, embed=False, overwrite=True)
        self.assertTrue(lyrics.read_sidecar(t)["synced"] or not res["synced"])
        self.assertEqual(sess2.calls[0][0], "get")

    def test_tried_plain_is_not_searched_again(self):
        t = self._archived_track()
        lyrics.write_sidecar(t, {"synced": [], "text": "plain", "source": "x"})
        sess = FakeSession({"get": FakeResp(404, {}), "search": FakeResp(200, [])})
        lyrics.ensure_lyrics(None, t, session=sess, embed=False)
        n = len(sess.calls)
        lyrics.ensure_lyrics(None, t, session=sess, embed=False)
        self.assertEqual(len(sess.calls), n)


if __name__ == "__main__":
    unittest.main()

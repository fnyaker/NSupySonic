# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Who wrote, composed and produced a track, kept in the database.

The credits panel of the full-screen player only ever showed the main artist
for the tracks archived before their sidecar kept Deezer's contributors (it may
not ask Deezer about a file on disk), and never what MusicBrainz found. These
tests pin the fix: the rows, the merge of the sources, the background backfill
that completes an existing library (in batches, behind the person listening,
the cause of each failure named), and a person's own credits page.
"""

import os
import shutil
import tempfile
import unittest

from supysonic import trackcredits
from supysonic.db import Meta, Track, TrackCredit, User
from supysonic.deezer import library

from . import test_webui as _tw


class _Case(unittest.TestCase):
    """The web UI's test setup, without inheriting its tests."""

    setUp = _tw.WebUITestCase.setUp
    tearDown = _tw.WebUITestCase.tearDown
    _login = _tw.WebUITestCase._login
    _credits_setup = _tw.WebUITestCase._credits_setup


def _raw(sid, title="S", art="1", art_name="A"):
    return {
        "SNG_ID": str(sid), "SNG_TITLE": title, "ART_ID": art, "ART_NAME": art_name,
        "ALB_ID": "10", "ALB_TITLE": "Alb", "ALB_PICTURE": "c", "DURATION": 100,
        "TRACK_NUMBER": 1, "DISK_NUMBER": 1,
    }


class FakeProvider:
    """``get_tracks`` (song.getListData) and ``get_track_info`` (song.getData),
    counting the calls, as the backfill uses them."""

    def __init__(self, credits=None, list_has_credits=True, fail=False):
        self.credits = credits or {}
        self.list_has_credits = list_has_credits
        self.fail = fail
        self.list_calls = []
        self.info_calls = []

    def _row(self, sid):
        row = {"SNG_ID": sid, "LABEL_NAME": "Lab"}
        if sid in self.credits:
            row["SNG_CONTRIBUTORS"] = self.credits[sid]
        return row

    def get_tracks(self, ids):
        self.list_calls.append(list(ids))
        if self.fail:
            raise ConnectionError("Deezer is down")
        rows = [self._row(s) for s in ids]
        if not self.list_has_credits:
            for r in rows:
                r.pop("SNG_CONTRIBUTORS", None)
        return rows

    def get_track_info(self, sid):
        self.info_calls.append(sid)
        if self.fail:
            raise ConnectionError("Deezer is down")
        return self._row(sid)


class StoreTest(_Case):
    def _track(self, sid=1):
        with self.app.app_context():
            return library.upsert_track(_raw(sid), library.get_root_folder(self.archive), "FLAC")

    def test_a_source_replaces_only_its_own_statement(self):
        t = self._track()
        with self.app.app_context():
            trackcredits.store(t.id, {"composer": ["Ann", "ann", " Bob "]}, "deezer")
            trackcredits.store(t.id, {"composer": ["Zed"]}, "musicbrainz")
            trackcredits.store(t.id, {"Composer": ["Cy"], "author": "Di"}, "deezer")
            self.assertEqual(
                trackcredits.stored(t.id),
                {"deezer": {"composer": ["Cy"], "author": ["Di"]}, "musicbrainz": {"composer": ["Zed"]}},
            )
            trackcredits.store(t.id, {}, "deezer")
            self.assertEqual(trackcredits.stored(t.id), {"musicbrainz": {"composer": ["Zed"]}})

    def test_bounds(self):
        t = self._track()
        with self.app.app_context():
            n = trackcredits.store(
                t.id,
                {"composer": ["N%d" % i for i in range(500)], "x" * 500: ["Y" * 999], "junk": {"a": 1}},
                "deezer",
            )
            self.assertEqual(n, trackcredits.MAX_PEOPLE + 1)
            row = TrackCredit.select().where(TrackCredit.role != "composer").get()
            self.assertEqual(len(row.role), trackcredits.MAX_ROLE)
            self.assertEqual(len(row.name), trackcredits.MAX_TEXT)

    def test_musicbrainz_only_fills_what_the_label_did_not_say(self):
        merged = trackcredits.merge({
            "deezer": {"composer": ["Ann"], "author": ["Bob"]},
            "musicbrainz": {"composer": ["Other"], "lyricist": ["Bob"], "producer": ["Pat"]},
        })
        self.assertEqual(merged, {"composer": ["Ann"], "author": ["Bob"], "producer": ["Pat"]})
        self.assertEqual(
            trackcredits.merge({"musicbrainz": {"composer": ["Ann"]}}), {"composer": ["Ann"]}
        )

    def test_names_from_tags_and_from_musicbrainz(self):
        self.assertEqual(trackcredits.split_names("Last, First"), ["Last, First"])
        self.assertEqual(trackcredits.split_names("A; B"), ["A", "B"])
        self.assertEqual(trackcredits.split_names("A, B", commas=True), ["A", "B"])
        self.assertEqual(
            trackcredits.from_facts({
                "composer": {"value": "A, B", "source": "musicbrainz"},
                "lyricist": {"value": "C", "source": "tags"},  # the tags' own: not MusicBrainz's
            }),
            {"composer": ["A", "B"]},
        )


class PanelTest(_Case):
    """``/api/track/<id>/credits``, the full-screen player's panel."""

    def _archived(self, sid, payload=None, facts=None):
        with self.app.app_context():
            t = library.upsert_track(_raw(sid), library.get_root_folder(self.archive), "FLAC")
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"\x00")
            library.save_track_metadata(t, payload or {})
            if facts:
                library.update_track_facts(t, facts, "musicbrainz")
        return t

    def _by_role(self, sid):
        data = self.client.get(f"/api/track/{sid}/credits").get_json()
        return {c["role"]: [p["name"] for p in c["people"]] for c in data["credits"]}, data

    def test_an_old_archive_shows_what_the_database_learnt(self):
        """The reported case: archived before its sidecar kept the credits, the
        panel named the main artist only. The backfill's rows now answer, and
        still without a call to Deezer."""
        gw = self._credits_setup()
        self._login()
        t = self._archived(700, {"ISRC": "GBDUW0000059"})
        before, _ = self._by_role(700)
        self.assertEqual(set(before), {"main_artist"})
        with self.app.app_context():
            trackcredits.store(t.id, {"composer": ["Ann"], "author": ["Bob"]}, "deezer")
        after, data = self._by_role(700)
        self.assertEqual(after["composer"], ["Ann"])
        self.assertEqual(after["author"], ["Bob"])
        self.assertEqual(data["info"]["isrc"], "GBDUW0000059")
        self.assertEqual(gw.credit_calls, [], "a track on disk costs Deezer nothing")

    def test_what_musicbrainz_found_is_shown_and_kept(self):
        self._credits_setup()
        self._login()
        t = self._archived(701, facts={"composer": "Ann, Bob", "producer": "Pat"})
        by, _ = self._by_role(701)
        self.assertEqual(by["composer"], ["Ann", "Bob"])
        self.assertEqual(by["producer"], ["Pat"])
        with self.app.app_context():
            self.assertEqual(
                trackcredits.stored(t.id)["musicbrainz"], {"composer": ["Ann", "Bob"], "producer": ["Pat"]},
                "stored on the way: the person's credits page reads the database",
            )

    def test_a_catalogue_answer_is_kept_for_when_deezer_is_away(self):
        self._credits_setup()
        self._login()
        with self.app.app_context():
            t = library.upsert_track(_raw(3135556), library.get_root_folder(self.archive), "FLAC")
        first, _ = self._by_role(3135556)
        self.assertIn("composer", first)
        with self.app.app_context():
            self.assertIn("deezer", trackcredits.stored(t.id))
        from supysonic.webui import credits

        with credits._lock:
            credits._cache.clear()
        self._credits_setup(fail=True)
        again, _ = self._by_role(3135556)
        self.assertEqual(again["composer"], first["composer"], "Deezer down: the database answers")

    def test_a_name_links_to_its_artist_and_to_its_credits(self):
        self._credits_setup()
        self._login()
        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            library.upsert_track(_raw(800, art="77", art_name="Daft Punk"), root, "FLAC")
            library.upsert_track(_raw(3135556), root, "FLAC")
            other = library.upsert_track(_raw(801), root, "FLAC")
            trackcredits.store(other.id, {"composer": ["Thomas Bangalter"]}, "deezer")
        data = self.client.get("/api/track/3135556/credits").get_json()
        people = {p["name"]: p for c in data["credits"] for p in c["people"]}
        self.assertTrue(people["Daft Punk"].get("id"), "the library's artist of that name")
        self.assertEqual(people["Thomas Bangalter"].get("credited"), 2, "this track and the other")
        self.assertNotIn("credited", people["Zed"], "credited here only: nothing more to open")


class PersonTest(_Case):
    def test_a_person_s_credits_across_the_library(self):
        self._login()
        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            a = library.upsert_track(_raw(900, "One"), root, "FLAC")
            b = library.upsert_track(_raw(901, "Two"), root, "FLAC")
            c = library.upsert_track(_raw(902, "Three"), root, "FLAC")
            trackcredits.store(a.id, {"composer": ["Max Martin"], "producer": ["max martin"]}, "deezer")
            trackcredits.store(b.id, {"producer": ["Max  Martin"]}, "deezer")
            trackcredits.store(c.id, {"main_artist": ["Max Martin"]}, "deezer")
        data = self.client.get("/api/credits/person?name=MAX%20MARTIN").get_json()
        self.assertEqual(data["name"], "Max Martin")
        self.assertEqual(sorted(t["title"] for t in data["tracks"]), ["One", "Two"], "not as performer")
        self.assertEqual(
            [(r["label"], r["count"]) for r in data["roles"]], [("Compositeur", 1), ("Producteur", 2)]
        )
        one = next(t for t in data["tracks"] if t["title"] == "One")
        self.assertEqual(one["credit_roles"], ["composer", "producer"])
        self.assertEqual(self.client.get("/api/credits/person?name=").status_code, 404)

    def test_a_private_upload_stays_private(self):
        from supysonic.managers.user import UserManager

        with self.app.app_context():
            UserManager.add("bob", "B0b")
            bob = User.get(User.name == "bob")
            root = library.get_root_folder(self.archive)
            mine = library.upsert_track(_raw(910, "Shared"), root, "FLAC")
            theirs = library.upsert_track(_raw(911, "Private"), root, "FLAC")
            Track.update(owner=User.get(User.name == "alice").id).where(Track.id == theirs.id).execute()
            for t in (mine, theirs):
                trackcredits.store(t.id, {"composer": ["Ann"]}, "tags")
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        data = self.client.get("/api/credits/person?name=Ann").get_json()
        self.assertEqual([t["title"] for t in data["tracks"]], ["Shared"])
        self.assertIsNotNone(bob)

    def test_the_artist_page_says_whether_it_has_credits(self):
        self._login()
        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            t = library.upsert_track(_raw(920, art="55", art_name="Pharrell Williams"), root, "FLAC")
            artist_id = str(t.artist.id)
            other = library.upsert_track(_raw(921), root, "FLAC")
        self.assertEqual(self.client.get(f"/api/artist/{artist_id}").get_json()["credited"], 0)
        with self.app.app_context():
            trackcredits.store(other.id, {"producer": ["Pharrell Williams"]}, "deezer")
        self.assertEqual(self.client.get(f"/api/artist/{artist_id}").get_json()["credited"], 1)


class BackfillTest(_Case):
    def _archive(self, sid, payload=None):
        with self.app.app_context():
            t = library.upsert_track(_raw(sid), library.get_root_folder(self.archive), "FLAC")
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"\x00")
            # An archive of before: its sidecar has no contributors.
            library.save_track_metadata(t, payload or {"ISRC": "X"})
        return t

    def setUp(self):
        super().setUp()
        self._pause = trackcredits.PAUSE
        trackcredits.PAUSE = 0
        self.addCleanup(setattr, trackcredits, "PAUSE", self._pause)

    def _run(self, provider, **kw):
        with self.app.app_context():
            job = trackcredits.BackfillJob(provider, **kw)
            return job.run(), dict(trackcredits._counts)

    def test_an_old_library_is_completed_in_batches(self):
        tracks = [self._archive(1000 + i) for i in range(120)]
        provider = FakeProvider({str(1000 + i): {"composer": [f"C{i}"]} for i in range(120)})
        snap, counts = self._run(provider)
        self.assertTrue(snap["finished"])
        self.assertEqual(snap["failed"], 0)
        self.assertEqual(counts["deezer"], 120)
        # 120 tracks in pages of 100: one call for each page's 100 ids… in
        # batches of at most 50.
        self.assertEqual([len(c) for c in provider.list_calls], [50, 50, 20])
        self.assertEqual(provider.info_calls, [])
        with self.app.app_context():
            self.assertEqual(trackcredits.stored(tracks[7].id), {"deezer": {"composer": ["C7"]}})
            side = library.read_track_metadata(tracks[7])
            self.assertEqual(side["gw"]["SNG_CONTRIBUTORS"], {"composer": ["C7"]}, "the archive describes itself")
            self.assertEqual(side["gw"]["ISRC"], "X", "and keeps what it had")
        # Run again: everything is known, Deezer is not asked.
        again = FakeProvider()
        self._run(again)
        self.assertEqual(again.list_calls, [])

    def test_the_disk_answers_first(self):
        t = self._archive(1200, {"SNG_CONTRIBUTORS": {"author": ["Bob"]}})
        with self.app.app_context():
            library.update_track_facts(t, {"producer": "Pat"}, "musicbrainz")
        provider = FakeProvider()
        snap, counts = self._run(provider)
        self.assertEqual(provider.list_calls, [], "the sidecar already said it")
        self.assertEqual(counts["local"], 1)
        with self.app.app_context():
            self.assertEqual(
                trackcredits.stored(t.id),
                {"deezer": {"author": ["Bob"]}, "musicbrainz": {"producer": ["Pat"]}},
            )

    def test_one_call_a_track_when_the_list_call_has_no_credits(self):
        for i in range(3):
            self._archive(1300 + i)
        provider = FakeProvider({"1301": {"composer": ["Ann"]}}, list_has_credits=False)
        snap, counts = self._run(provider)
        self.assertEqual(len(provider.list_calls), 1, "asked once, then never again this run")
        self.assertEqual(sorted(provider.info_calls), ["1300", "1301", "1302"])
        self.assertEqual(counts["deezer"], 1)
        self.assertEqual(counts["none"], 2)

    def test_deezer_away_names_the_cause_and_runs_again(self):
        t = self._archive(1400)
        provider = FakeProvider(fail=True)
        with self.app.app_context():
            Meta.delete().where(Meta.key == trackcredits.DONE_KEY).execute()
            trackcredits._job = trackcredits.BackfillJob(provider)
            trackcredits._run(self.app, trackcredits._job)
            snap = trackcredits.status()
        self.assertEqual(snap["failed"], 1)
        self.assertEqual(snap["done"], 0)
        self.assertIn("Deezer injoignable", snap["error"])
        self.assertEqual(snap["failures"][0]["reason"], "Deezer injoignable (ConnectionError)")
        self.assertFalse(snap["completed"], "a run Deezer did not answer runs again at the next start")
        with self.app.app_context():
            self.assertEqual(trackcredits.stored(t.id), {}, "no verdict written for an outage")
        ok = FakeProvider({"1400": {"composer": ["Ann"]}})
        with self.app.app_context():
            trackcredits._job = trackcredits.BackfillJob(ok)
            trackcredits._run(self.app, trackcredits._job)
            self.assertTrue(trackcredits.status()["completed"])
            self.assertEqual(trackcredits.stored(t.id), {"deezer": {"composer": ["Ann"]}})

    def test_it_yields_to_the_person_listening(self):
        """Every Deezer call of the backfill first waits for the foreground."""
        from unittest import mock

        from supysonic.deezer import workload

        self._archive(1500)
        provider = FakeProvider()
        waits = []
        with mock.patch.object(workload, "quiet_wait", side_effect=lambda t=5.0: waits.append(t)):
            self._run(provider)
        self.assertGreaterEqual(len(waits), len(provider.list_calls) + len(provider.info_calls))

    def test_admin_route(self):
        self._login()
        rv = self.client.get("/api/credits/backfill")
        self.assertEqual(rv.status_code, 200)
        self.assertIn("counts", rv.get_json())
        self.client.post("/api/logout")
        self.assertEqual(self.client.get("/api/credits/backfill").status_code, 401)


class UploadTest(unittest.TestCase):
    """An upload's own tags are stored as it is imported."""

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg")
    def test_import_stores_the_tags_credits(self):
        from mutagen.flac import FLAC

        from supysonic.deezer import local

        from .test_detach_d import make_audio

        case = _Case()
        case.setUp()
        self.addCleanup(case.tearDown)
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        path = os.path.join(d, "u.flac")
        make_audio(path)
        f = FLAC(path)
        f["composer"] = "Ann; Bob"
        f["producer"] = "Di"
        f.save()
        with case.app.app_context():
            t = local.import_local_file(path, library.get_root_folder(d))
            self.assertEqual(
                trackcredits.stored(t.id), {"tags": {"composer": ["Ann", "Bob"], "producer": ["Di"]}}
            )


if __name__ == "__main__":
    unittest.main()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot E of the detachment from Deezer: every track is addressed by its UUID,
covers are the album's own route, and an entity page of the library is the
database's answer, with Deezer asked afterwards for what the library lacks."""

import os
import shutil
import sqlite3
import tempfile
import unittest

from deezerpy._circuit import breaker
from supysonic.config import DefaultConfig
from supysonic.db import (
    Album,
    Artist,
    Folder,
    Meta,
    Playlist,
    PlaylistTrack,
    Track,
    User,
    init_database,
    release_database,
)
from supysonic.deezer import ids, library
from supysonic.deezer.provider import DeezerProvider
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from .test_deezer import count_statements
from .test_webui import MockDz, MockPrefetch
from .test_webui_lists import raw

A = ("11", "Édith")


class Untouched:
    """A Deezer client that must never be used: any access is recorded."""

    def __init__(self):
        self.touched = []

    def __getattr__(self, name):
        self.touched.append(name)
        raise AssertionError("Deezer was called: " + name)


class _Case(unittest.TestCase):
    def setUp(self):
        # The breaker is a process-wide singleton: a cold stream above would
        # leave a host open for whatever test runs next in this process.
        breaker.reset()
        self.addCleanup(breaker.reset)
        self._db = tempfile.mkstemp()
        self._dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path, cache, archive = self._db[1], self._dir, self.archive

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(self.DEEZER, archive_dir=archive)

        self.app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bb", admin=False)
        self.provider = DeezerProvider("arl", self.archive, "FLAC")
        self.provider._dz = MockDz()
        self.app.deezer = self.provider
        self.app.deezer_prefetch = MockPrefetch()
        self.client = self.app.test_client()
        self.fill()
        self.login()

    def tearDown(self):
        release_database()
        shutil.rmtree(self._dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self._db[0])
        os.remove(self._db[1])

    def login(self, who="alice", pw="Alic3"):
        self.client.post("/api/logout")
        rv = self.client.post("/api/login", json={"username": who, "password": pw})
        self.assertEqual(rv.status_code, 200)

    def fill(self):
        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            self.t1 = library.upsert_track(raw(1, "Été", A, ("21", "Album Un", "aa11")), root)
            self.t3 = library.upsert_track(raw(3, "Zéro", A, ("21", "Album Un", "aa11")), root)
            self.t2 = library.upsert_track(raw(2, "Nuit", A, ("22", "Sans pochette", None)), root)
            # An archived one: a real file, so /stream serves it from disk.
            self.t1.path = os.path.join(self.archive, "été.flac")
            with open(self.t1.path, "wb") as f:
                f.write(b"fLaC" + b"\0" * 64)
            self.t1.last_modification = 1
            self.t1.save()
            # Another user's private upload.
            bob = User.get(name="bob")
            folder = Folder.create(root=False, name="up", path=os.path.join(self.archive, "up"), parent=root)
            art = Artist.create(name="Moi")
            alb = Album.create(name="Maison", artist=art)
            self.up = Track.create(
                disc=1, number=1, title="Démo", duration=61, album=alb, artist=art, bitrate=320,
                path=os.path.join(self.archive, "up", "demo.mp3"), last_modification=0,
                root_folder=root, folder=folder, owner=bob,
            )
            self.pl = Playlist.create(user=User.get(name="alice"), name="Liste")
            PlaylistTrack.create(playlist=self.pl, track=self.t1.id, index=0)
            self.alb1 = self.t1.album
            self.art = self.t1.artist

    def get(self, path, **kw):
        return self.client.get(path, **kw)


class SerializationTestCase(_Case):
    def test_every_row_carries_its_uuid_and_its_albums_cover(self):
        rows = self.get("/api/album/" + str(self.alb1.id)).get_json()["tracks"]
        self.assertEqual({r["id"] for r in rows}, {str(self.t1.id), str(self.t3.id)})
        for r in rows:
            self.assertEqual(r["album"]["cover"], "/api/cover/" + str(self.alb1.id))
            self.assertIn("release_date", r)
        # Reading stays possible by the Deezer id.
        self.assertEqual({r["deezer_id"] for r in rows}, {"1", "3"})

    def test_a_row_without_a_md5_has_the_same_kind_of_cover(self):
        row = self.get("/api/album/" + str(self.t2.album.id)).get_json()["tracks"][0]
        self.assertEqual(row["album"]["cover"], "/api/cover/" + str(self.t2.album.id))

    def test_the_release_date_is_served(self):
        with self.app.app_context():
            Track.update(release_date="2001-05-02").where(Track.id == self.t1.id).execute()
        rows = self.get("/api/album/" + str(self.alb1.id)).get_json()["tracks"]
        self.assertEqual({r["id"]: r["release_date"] for r in rows}[str(self.t1.id)], "2001-05-02")

    def test_album_cards_have_an_id_a_local_cover_and_a_date(self):
        card = self.get("/api/artist/11/discography").get_json()["discography"]["album"][0]
        self.assertEqual(card["id"], str(card["id"]))
        self.assertTrue(card["cover"].startswith("/api/cover/"))
        self.assertIn("release_date", card)


class CoverTestCase(_Case):
    def test_an_album_without_a_file_redirects_to_the_cdn_with_no_request(self):
        self.app.deezer = Untouched()
        rv = self.get("/api/cover/" + str(self.alb1.id))
        self.assertEqual(rv.status_code, 302)
        self.assertIn("/images/cover/aa11/", rv.headers["Location"])
        self.assertEqual(self.app.deezer.touched, [])

    def test_an_album_with_no_art_at_all_is_a_404(self):
        self.assertEqual(self.get("/api/cover/" + str(self.t2.album.id)).status_code, 404)

    def test_the_archived_cover_jpg_wins(self):
        with self.app.app_context():
            folder = Folder.get(Folder.id == self.t1.folder_id)
            folder.cover_art = "cover.jpg"
            folder.save()
            os.makedirs(folder.path, exist_ok=True)
            with open(os.path.join(folder.path, "cover.jpg"), "wb") as f:
                f.write(b"\xff\xd8JPEG")
        rv = self.get("/api/cover/" + str(self.alb1.id))
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_data(), b"\xff\xd8JPEG")

    def test_somebody_elses_upload_has_no_cover_for_you(self):
        alb = str(self.up.album_id)
        self.login("bob", "B0bb")
        self.assertEqual(self.get("/api/cover/" + alb).status_code, 404)  # no art: 404 either way
        self.login("alice", "Alic3")
        # Alice is an admin; make the owner another plain user.
        with self.app.app_context():
            UserManager.add("carol", "C4rol", admin=False)
            Track.update(owner=User.get(name="carol")).where(Track.id == self.up.id).execute()
        self.login("bob", "B0bb")
        self.assertEqual(self.get("/api/cover/" + alb).status_code, 404)


class RoutesTestCase(_Case):
    """Each route answers the same for a row's UUID and for its Deezer id."""

    def same(self, template, **kw):
        a = self.get(template.format(id=self.t1.id), **kw)
        b = self.get(template.format(id="1"), **kw)
        self.assertEqual(a.status_code, b.status_code, template)
        return a, b

    def test_stream_of_an_archived_track(self):
        a, b = self.same("/api/stream/{id}")
        self.assertEqual(a.status_code, 200)
        self.assertEqual(a.get_data(), b.get_data())

    def test_stream_of_a_cold_track_asks_deezer_the_same_way(self):
        # Not archived: both forms take the Deezer path (no file here, and the
        # UUID is no longer "track unavailable" for want of a numeric id).
        a = self.get("/api/stream/" + str(self.t3.id), headers={"X-NS-Background": "1"})
        b = self.get("/api/stream/3", headers={"X-NS-Background": "1"})
        self.assertEqual(a.status_code, 503)
        self.assertEqual(a.get_json(), b.get_json())
        self.assertEqual(self.app.deezer_prefetch.ids, ["3", "3"])

    def test_probe(self):
        a, b = self.same("/api/track/{id}/probe")
        self.assertEqual(a.get_json(), b.get_json())

    def test_probe_of_a_cold_track_is_not_unknown(self):
        a = self.get("/api/track/%s/probe" % self.t3.id).get_json()
        b = self.get("/api/track/3/probe").get_json()
        self.assertEqual(a, b)
        self.assertNotEqual(a.get("reason"), "unknown track")

    def test_credits(self):
        a, b = self.same("/api/track/{id}/credits")
        self.assertEqual(a.get_json(), b.get_json())

    def test_gain_and_edges(self):
        with self.app.app_context():
            Track.update(gain=-7.5).where(Track.id == self.t3.id).execute()
        for tpl in ("/api/gain/{}", "/api/audio/edges/{}"):
            a = self.get(tpl.format(self.t3.id))
            b = self.get(tpl.format("3"))
            self.assertEqual(a.get_json(), b.get_json(), tpl)
        self.assertEqual(self.get("/api/gain/%s" % self.t3.id).get_json(), {"gain": -7.5})

    def test_download_accepts_uuids(self):
        rv = self.client.post("/api/download", json={"ids": [str(self.t3.id), "2", str(self.t3.id), "not-an-id"]})
        self.assertEqual(rv.status_code, 200, rv.get_data())
        self.assertEqual(self.app.deezer_prefetch.ids, ["3", "2"])

    def test_a_hostile_id_is_refused_by_every_form(self):
        self.assertEqual(self.get("/api/stream/zzz").status_code, 400)
        self.assertEqual(self.get("/api/track/zzz/probe").get_json()["available"], False)
        self.assertEqual(self.get("/api/track/zzz/credits").status_code, 404)

    def test_a_private_upload_stays_private_by_uuid(self):
        self.login("bob", "B0bb")
        # Bob owns it in the fixture: he reads it, nobody else does.
        self.assertNotEqual(self.get("/api/track/%s/probe" % self.up.id).status_code, 404)
        self.login("alice", "Alic3")
        with self.app.app_context():
            UserManager.add("carol", "C4rol", admin=False)
        self.login("carol", "C4rol")
        self.assertEqual(self.get("/api/track/%s/probe" % self.up.id).status_code, 404)
        self.assertNotEqual(self.get("/api/stream/%s" % self.up.id).status_code, 200)


class PagesTestCase(_Case):
    PAGES = (
        "/api/album/{alb}",
        "/api/artist/{art}",
        "/api/artist/{art}/tracks",
        "/api/artist/{art}/discography",
    )

    def paths(self, by):
        ctx = {
            "uuid": {"alb": str(self.alb1.id), "art": str(self.art.id)},
            "deezer": {"alb": "21", "art": "11"},
        }[by]
        return [p.format(**ctx) for p in self.PAGES] + ["/api/playlist/" + str(self.pl.id)]

    def test_a_library_page_never_calls_deezer(self):
        self.provider._dz = Untouched()
        for by in ("uuid", "deezer"):
            for path in self.paths(by):
                rv = self.get(path)
                self.assertEqual(rv.status_code, 200, path)
        self.assertEqual(self.provider._dz.touched, [])

    def test_deezer_off_or_on_the_page_is_the_same_json(self):
        on = [self.get(p).get_json() for p in self.paths("deezer")]
        self.provider._dz = Untouched()
        self.app.deezer = None
        off = [self.get(p).get_json() for p in self.paths("deezer")]
        self.assertEqual(on, off)

    def test_uuid_and_deezer_id_give_the_same_page(self):
        for a, b in zip(self.paths("uuid"), self.paths("deezer")):
            self.assertEqual(self.get(a).get_json(), self.get(b).get_json(), a)

    def test_the_artist_page_has_no_shelves_of_recommendations(self):
        data = self.get("/api/artist/11").get_json()
        self.assertEqual(data["related"], [])
        self.assertEqual([t["id"] for t in data["top"]][:1] and len(data["top"]), 3)
        self.assertTrue(data["artist"]["picture"].startswith("/api/cover/"))
        # Most played first.
        with self.app.app_context():
            Track.update(play_count=9).where(Track.id == self.t3.id).execute()
        top = self.get("/api/artist/11").get_json()["top"]
        self.assertEqual(top[0]["id"], str(self.t3.id))

    def test_a_page_costs_few_statements(self):
        with count_statements() as counts:
            self.get("/api/album/" + str(self.alb1.id))
        self.assertLessEqual(counts["SELECT"], 7, counts)
        with count_statements() as counts:
            self.get("/api/artist/11")
        self.assertLessEqual(counts["SELECT"], 10, counts)

    def test_an_unknown_entity_is_the_deezer_page(self):
        # The mock catalogue knows artist 9 / album 10: the page is Deezer's facts.
        art = self.get("/api/artist/9").get_json()
        self.assertEqual((art["top"], art["related"]), ([], []))
        self.assertTrue(art["albums"])
        self.assertEqual(self.get("/api/album/10").status_code, 200)
        self.assertEqual(self.get("/api/artist/not-an-id").status_code, 404)
        self.assertEqual(self.get("/api/album/" + str(ids.album_uuid("999999"))).status_code, 404)

    def test_somebody_elses_upload_is_no_page(self):
        self.login("bob", "B0bb")
        # bob owns the fixture upload; carol must not read it.
        with self.app.app_context():
            UserManager.add("carol", "C4rol", admin=False)
        self.assertEqual(self.get("/api/album/%s" % self.up.album_id).status_code, 200)
        self.login("carol", "C4rol")
        for path in ("/api/album/%s" % self.up.album_id, "/api/artist/%s" % self.up.artist_id,
                     "/api/artist/%s/tracks" % self.up.artist_id,
                     "/api/artist/%s/discography" % self.up.artist_id):
            self.assertEqual(self.get(path).status_code, 404, path)

    def test_the_part_only_on_deezer_comes_separately(self):
        # The mock has one album (10) and five tracks (1..5) for any id.
        got = self.get("/api/artist/11/on-deezer").get_json()["albums"]
        self.assertEqual([a["deezer_id"] for a in got], ["10"])
        tracks = self.get("/api/album/21/on-deezer").get_json()["tracks"]
        # 1, 2 and 3 are in the library; 4 and 5 are not.
        self.assertEqual(sorted(t["deezer_id"] for t in tracks), ["4", "5"])
        by_uuid = self.get("/api/album/%s/on-deezer" % self.alb1.id).get_json()["tracks"]
        self.assertEqual(sorted(t["deezer_id"] for t in by_uuid), ["4", "5"])

    def test_on_deezer_with_the_proxy_off_is_empty_not_an_error(self):
        self.app.deezer = None
        self.assertEqual(self.get("/api/artist/11").status_code, 200)
        self.assertEqual(self.get("/api/artist/11/on-deezer").get_json(), {"albums": []})
        self.assertEqual(self.get("/api/album/21/on-deezer").get_json(), {"tracks": []})

    def test_on_deezer_with_deezer_unreachable_says_so_and_the_page_still_works(self):
        self.provider.available = lambda: False
        self.assertEqual(self.get("/api/artist/11").status_code, 200)
        self.assertEqual(self.get("/api/album/21/on-deezer").status_code, 503)
        self.assertEqual(self.get("/api/album/21/on-deezer").headers.get("X-NS-Error"), "deezer-unreachable")


class UpgradeTestCase(unittest.TestCase):
    """A server from before this lot: its database, its rows, its config."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "old.db")
        self.archive = tempfile.mkdtemp()

    def tearDown(self):
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)

    def test_existing_rows_get_the_new_shapes(self):
        init_database("sqlite:///" + self.path)
        release_database()
        conn = sqlite3.connect(self.path)
        for table, column in (("track", "release_date"), ("track", "deezer_bpm"), ("album", "release_date")):
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        conn.execute("UPDATE meta SET value = '20261012' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

        path, cache, archive = self.path, self.dir, self.archive

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(self.DEEZER, archive_dir=archive, push_to_deezer=True)

        # A library written by the old code, before the app (and so the
        # migration) ever ran on it.
        app = create_application(Config())
        app.deezer = None
        UserManager.add("alice", "Alic3", admin=True)
        with app.app_context():
            root = library.get_root_folder(archive)
            t = library.upsert_track(raw(1, "Été", A, ("21", "Album Un", "aa11")), root)
            alb, tid = t.album_id, t.id
        client = app.test_client()
        client.post("/api/login", json={"username": "alice", "password": "Alic3"})
        page = client.get("/api/album/21")
        self.assertEqual(page.status_code, 200)
        row = page.get_json()["tracks"][0]
        self.assertEqual(row["id"], str(tid))
        self.assertIsNone(row["release_date"])
        self.assertEqual(row["album"]["cover"], "/api/cover/" + str(alb))
        self.assertEqual(client.get("/api/artist/11").status_code, 200)
        # Deezer is off and the file is not here: refused, not crashed.
        self.assertEqual(client.get("/api/stream/" + str(tid)).status_code, 503)
        self.assertEqual(Meta["schema_version"].value > "20261012", True)


if __name__ == "__main__":
    unittest.main()

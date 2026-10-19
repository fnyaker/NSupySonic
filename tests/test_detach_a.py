# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot A of the detachment from Deezer: nothing is written to the account, stars
are local, ids resolve from the database, and an existing server upgrades."""

import os
import shutil
import sqlite3
import tempfile
import unittest
import uuid

from supysonic import db as dbmod
from supysonic.config import DefaultConfig
from supysonic.db import (
    Album,
    Meta,
    Playlist,
    StarredAlbum,
    StarredPlaylist,
    Track,
    User,
    init_database,
    release_database,
)
from supysonic.deezer import ids
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from .detach_helpers import assert_no_deezer_writes, record_deezer_writes
from .test_deezer import count_statements
from .test_webui import MockApi, MockDz, MockPrefetch


class _AppCase(unittest.TestCase):
    config = {}

    def setUp(self):
        self._db = tempfile.mkstemp()
        self._dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path, cache = self._db[1], self._dir
        extra = self.config

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(self.DEEZER, **extra)

        self.Config = Config
        self.boot()

    def boot(self):
        from supysonic.deezer.provider import DeezerProvider

        self.app = create_application(self.Config())
        if not User.select().where(User.name == "alice").exists():
            UserManager.add("alice", "Alic3", admin=True)
        provider = DeezerProvider("arl", self.archive, "FLAC")
        provider._dz = MockDz()
        self.app.deezer = provider
        self.app.deezer_prefetch = MockPrefetch()
        self.app.config["DEEZER"]["archive_dir"] = self.archive
        self.client = self.app.test_client()
        self.client.post("/api/login", json={"username": "alice", "password": "Alic3"})
        self.writes = record_deezer_writes(provider)

    def tearDown(self):
        release_database()
        shutil.rmtree(self._dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self._db[0])
        os.remove(self._db[1])

    def make_track(self, sng_id="1", title="Song"):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive)
        return library.upsert_track(
            {
                "SNG_ID": sng_id, "SNG_TITLE": title, "ART_NAME": "Artist",
                "ART_ID": "500", "ALB_TITLE": "Album", "ALB_ID": "600",
                "DURATION": "200", "TRACK_NUMBER": "1", "DISK_NUMBER": "1",
            },
            root,
        )


class LocalCycleTestCase(_AppCase):
    # The options of an existing install: the old switches stay ON.
    config = {"push_to_deezer": True, "report_listens": True}

    def test_a_playlist_cycle_writes_nothing_to_deezer(self):
        a, b = self.make_track("1"), self.make_track("2", "Two")
        c = self.client
        pid = c.post("/api/playlists", json={"title": "P", "tracks": ["1", str(b.id)]}).get_json()["id"]
        self.assertEqual(c.post(f"/api/playlist/{pid}/tracks", json={"tracks": [str(a.id)]}).status_code, 200)
        self.assertEqual(c.put(f"/api/playlist/{pid}/order", json={"tracks": [str(b.id), "1"]}).status_code, 200)
        self.assertEqual(c.delete(f"/api/playlist/{pid}/tracks", json={"tracks": ["1"]}).status_code, 200)
        self.assertEqual(c.patch(f"/api/playlist/{pid}", json={"title": "Q"}).status_code, 200)
        pl = Playlist[uuid.UUID(pid)]
        self.assertEqual(pl.name, "Q")
        self.assertEqual([t.id for t in pl.get_tracks()], [b.id])
        self.assertEqual(c.delete(f"/api/playlist/{pid}").status_code, 200)
        self.assertEqual(Playlist.select().count(), 0)
        assert_no_deezer_writes(self, self.writes)

    def test_a_playlist_of_a_dead_deezer_needs_no_deezer(self):
        self.make_track("1")
        self.app.deezer = None
        rv = self.client.post("/api/playlists", json={"title": "P", "tracks": ["1", "999"]})
        self.assertEqual(rv.status_code, 200)
        pl = Playlist[uuid.UUID(rv.get_json()["id"])]
        self.assertEqual(len(pl.get_tracks()), 1)  # the unknown Deezer id is left out

    def test_the_subsonic_cycle_writes_nothing_to_deezer(self):
        a = self.make_track("1")
        auth = {"u": "alice", "p": "Alic3", "c": "t", "v": "1.12.0", "f": "json"}
        c = self.client
        rv = c.get("/rest/createPlaylist", query_string=dict(auth, name="S", songId=str(a.id)))
        self.assertEqual(rv.get_json()["subsonic-response"]["status"], "ok")
        pl = Playlist.get(Playlist.name == "S")
        rv = c.get("/rest/updatePlaylist", query_string=dict(auth, playlistId=str(pl.id), songIndexToRemove=0))
        self.assertEqual(rv.get_json()["subsonic-response"]["status"], "ok")
        rv = c.get("/rest/deletePlaylist", query_string=dict(auth, id=str(pl.id)))
        self.assertEqual(rv.get_json()["subsonic-response"]["status"], "ok")
        rv = c.get("/rest/star", query_string=dict(auth, id=str(a.id)))
        self.assertEqual(rv.get_json()["subsonic-response"]["status"], "ok")
        assert_no_deezer_writes(self, self.writes)

    def test_stars_survive_a_restart_with_deezer_cut(self):
        self.make_track("1")
        c = self.client
        c.post("/api/favorite", json={"deezer_id": "1", "on": True})
        c.post("/api/favorite/album", json={"deezer_id": "600", "on": True})
        c.post("/api/favorite/artist", json={"deezer_id": "500", "on": True, "title": "Artist"})
        c.post("/api/favorite/album", json={"deezer_id": "77", "on": True, "title": "Stub", "artist": "Nobody"})
        self.assertEqual(c.post("/api/favorite/album", json={"deezer_id": "78", "on": True}).status_code, 400)
        release_database()
        self.boot()
        self.app.deezer = None  # Deezer cut
        data = self.client.get("/api/me/favorite-ids").get_json()
        self.assertEqual(data["ids"], ["1"])
        self.assertEqual(sorted(data["albums"]), ["600", "77"])
        self.assertEqual(data["artists"], ["500"])
        self.assertTrue(self.client.get("/api/album/600").get_json()["album"]["is_favorite"])
        self.assertEqual(self.writes.calls, [])

    def test_a_playlist_star_and_an_unknown_one(self):
        pl = Playlist.create(user=User.get(name="alice"), name="Mine")
        self.client.post("/api/favorite/playlist", json={"id": str(pl.id), "on": True})
        self.assertEqual(StarredPlaylist.select().count(), 1)
        self.assertEqual(self.client.get("/api/me/favorite-ids").get_json()["playlists"], [str(pl.id)])
        # A Deezer playlist never imported: imported, then starred.
        self.client.post("/api/favorite/playlist", json={"deezer_id": "7", "on": True})
        self.assertEqual(StarredPlaylist.select().count(), 2)
        self.assertTrue(Playlist.select().where(Playlist.deezer_id == "7").exists())
        self.client.post("/api/favorite/playlist", json={"deezer_id": "7", "on": False})
        self.assertEqual(StarredPlaylist.select().count(), 1)
        assert_no_deezer_writes(self, self.writes)

    def test_favorite_ids_is_a_handful_of_statements(self):
        for i in range(30):
            t = self.make_track(str(100 + i))
            self.client.post("/api/favorite", json={"id": str(t.id), "on": True})
        with count_statements() as n:
            self.client.get("/api/me/favorite-ids")
        self.assertLessEqual(sum(n.values()), 8, n)  # auth + 4 reads, not one per star

    def test_listen_is_counted_and_not_reported(self):
        t = self.make_track("1")
        rv = self.client.post("/api/listen", json={"deezer_id": str(t.id), "listened": 60})
        self.assertEqual(rv.status_code, 204)
        self.assertEqual(Track[t.id].play_count, 1)
        self.assertEqual(self.client.post("/api/listen", json={"deezer_id": "x!", "listened": 60}).status_code, 400)
        assert_no_deezer_writes(self, self.writes)

    def test_podcast_subscription_and_position_write_nothing(self):
        # The old switch is on; the routes must not read it.
        self.assertEqual(self.client.post("/api/flow/clusters", json={"clusters": []}).status_code, 405)
        assert_no_deezer_writes(self, self.writes)


class RefsTestCase(_AppCase):
    def resolve(self, *raws, **kw):
        from supysonic.webui import refs

        with self.app.test_request_context():
            from flask import request

            request.webuser = User.get(name="alice")
            return refs.resolve_tracks(raws) if not kw else refs.resolve_track(raws[0], **kw)

    def test_uuid_deezer_id_unknown_and_junk(self):
        t = self.make_track("1")
        got = self.resolve(str(t.id), "1", "424242", "junk", "", None)
        self.assertEqual([r.id if r else None for r in got], [t.id, t.id, None, None, None, None])

    def test_a_row_with_its_own_id_is_found_by_its_deezer_id(self):
        t = self.make_track("1")
        Track.update(id=uuid.uuid4()).where(Track.id == t.id).execute()
        row = Track.get(Track.deezer_id == "1")
        self.assertNotEqual(row.id, ids.track_uuid("1"))
        self.assertEqual(self.resolve("1")[0].id, row.id)

    def test_another_users_upload_is_hidden(self):
        from supysonic.webui import refs

        t = self.make_track("1")
        UserManager.add("bob", "B0b")
        Track.update(owner=User.get(name="bob").id).where(Track.id == t.id).execute()
        UserManager.add("eve", "Ev3")
        with self.app.test_request_context():
            from flask import request

            request.webuser = User.get(name="eve")
            self.assertIsNone(refs.resolve_track(str(t.id)))
            request.webuser = User.get(name="bob")
            self.assertEqual(refs.resolve_track(str(t.id)).id, t.id)

    def test_200_ids_are_two_statements_at_most(self):
        for i in range(5):
            self.make_track(str(i + 1))
        raws = [str(i + 1) for i in range(5)] + [str(uuid.uuid4()) for _ in range(95)] + [str(9000 + i) for i in range(100)]
        with self.app.test_request_context():
            from flask import request
            from supysonic.webui import refs

            request.webuser = User.get(name="alice")
            with count_statements() as n:
                out = refs.resolve_tracks(raws)
        self.assertEqual(len(out), 200)
        self.assertLessEqual(sum(n.values()), 2, n)

    def test_a_remembered_youtube_hit_is_materialized_on_request(self):
        from supysonic.webui import refs, youtube

        tid = uuid.uuid4()
        row = self.make_track("1")
        original = youtube.materialize
        youtube.materialize = lambda raw: row if str(raw) == str(tid) else None
        try:
            with self.app.test_request_context():
                from flask import request

                request.webuser = User.get(name="alice")
                self.assertIsNone(refs.resolve_track(str(tid)))
                self.assertEqual(refs.resolve_track(str(tid), materialize=True).id, row.id)
        finally:
            youtube.materialize = original


class UpgradeTestCase(unittest.TestCase):
    """An existing server (schema 20261012, data in it, the old config) boots on
    this code and keeps everything it had."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "old.db")

    def tearDown(self):
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)

    def make_old_database(self):
        """The 20261012 shape: today's base script minus what this lot adds."""
        init_database("sqlite:///" + self.path)
        release_database()
        conn = sqlite3.connect(self.path)
        for table in ("starred_playlist", "track_neighbor", "track_enrichment"):
            conn.execute(f"DROP TABLE {table}")
        for table, column in (("track", "release_date"), ("track", "deezer_bpm"), ("album", "release_date")):
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        conn.execute("UPDATE meta SET value = '20261012' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

    def test_the_old_database_is_migrated_and_keeps_its_rows(self):
        self.make_old_database()
        conn = sqlite3.connect(self.path)
        conn.execute("INSERT INTO artist (id, name, deezer_id) VALUES ('a'||hex(randomblob(1)), 'Old', '5')")
        conn.commit()
        conn.close()

        init_database("sqlite:///" + self.path)
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
        self.assertEqual(dbmod.Artist.select().where(dbmod.Artist.deezer_id == "5").count(), 1)
        # The new columns and tables work.
        self.assertIsNone(Album.select().first())
        Album.select(Album.release_date).count()
        Track.select(Track.release_date, Track.deezer_bpm).count()
        self.assertEqual(StarredPlaylist.select().count(), 0)
        self.assertEqual(dbmod.TrackNeighbor.select().count(), 0)
        self.assertEqual(dbmod.TrackEnrichment.select().count(), 0)
        # …and booting again is a no-op.
        release_database()
        init_database("sqlite:///" + self.path)
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)

    def test_the_app_boots_on_the_old_database_with_the_old_config(self):
        self.make_old_database()
        path = self.path
        cache = self.dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                # Switches that existed before and that nothing reads any more.
                self.DEEZER = dict(self.DEEZER, push_to_deezer=True, report_listens=True)

        app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)
        client = app.test_client()
        client.post("/api/login", json={"username": "alice", "password": "Alic3"})
        self.assertEqual(client.get("/api/me/favorite-ids").status_code, 200)
        self.assertEqual(client.post("/api/playlists", json={"title": "P"}).status_code, 200)

    def test_a_database_copied_between_engines_includes_the_new_tables(self):
        order = {m._meta.table_name for m in dbmod._migration_order()}
        self.assertLessEqual({"starred_playlist", "track_neighbor", "track_enrichment"}, order)


if __name__ == "__main__":
    unittest.main()

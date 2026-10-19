# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot D: an album, an artist, a playlist and a show carry one ``id`` everywhere.

The ``id`` is the row's UUID — or, for a catalogue card with no row yet, the UUID
its row WILL have (``ids.*_uuid`` is a uuid5 of the provider's id), so a card has
the same key before and after it enters the library. The pages answer to both
forms (the provider's id, which an older SPA and every bookmark still use, and the
UUID), and none of it costs a statement.
"""

import os
import shutil
import tempfile
import unittest
import uuid

from supysonic.config import DefaultConfig
from supysonic.db import Playlist, PodcastChannel, User, release_database
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from .test_webui_lists import count_statements, raw


class EntityIdTestCase(unittest.TestCase):
    def setUp(self):
        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path, cache, archive = self.__db[1], self.__dir, self.archive

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(getattr(self, "DEEZER", {}), archive_dir=archive, enabled=False)

        self.app = create_application(Config())
        self.app.deezer = None  # every answer below is the database's own
        UserManager.add("alice", "Alic3", admin=True)
        self.client = self.app.test_client()
        from supysonic.deezer import library

        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            self.track = library.upsert_track(
                raw(1, "Été", ("11", "Édith"), ("21", "Album Un", "aa11")), root
            )
            self.user = User.get(name="alice")
            from supysonic.deezer import ids

            self.playlist = Playlist.create(
                id=ids.playlist_uuid("900"), user=self.user, name="Imported", deezer_id="900"
            )
            self.channel = PodcastChannel.create(
                id=ids.show_uuid("700"), user=self.user, deezer_id="700", url="https://x/f", title="Show"
            )
        rv = self.client.post("/api/login", json={"username": "alice", "password": "Alic3"})
        self.assertEqual(rv.status_code, 200)

    def tearDown(self):
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    def get(self, path):
        rv = self.client.get("/api" + path)
        self.assertEqual(rv.status_code, 200, path)
        return rv.get_json()

    # -- the id a catalogue card gets is the id its row will have --------------

    def test_a_catalogue_card_carries_the_uuid_its_row_will_have(self):
        from supysonic import webui
        from supysonic.deezer import ids

        cases = [
            (webui._album_api({"id": 21, "title": "A", "artist": {}}), ids.album_uuid("21")),
            (webui._artist_api({"id": 11, "name": "A"}), ids.artist_uuid("11")),
            (webui._playlist_api({"id": 900, "title": "P"}), ids.playlist_uuid("900")),
            (webui._podcast_card({"id": 700, "title": "S"}), ids.show_uuid("700")),
            (webui._album({"ALB_ID": "21", "ALB_TITLE": "A"}), ids.album_uuid("21")),
            (webui._artist({"ART_ID": "11", "ART_NAME": "A"}), ids.artist_uuid("11")),
            (webui._playlist({"PLAYLIST_ID": "900", "TITLE": "P"}), ids.playlist_uuid("900")),
        ]
        for card, expected in cases:
            self.assertEqual(card["id"], str(expected))
            self.assertIn("deezer_id", card)  # an older SPA still reads it

    def test_the_catalogue_card_and_the_library_row_agree(self):
        from supysonic import webui

        with self.app.app_context():
            alb = self.track.album
            card = webui._db_album_card(alb)
            self.assertEqual(card["id"], webui._album_api({"id": 21, "title": "x", "artist": {}})["id"])
            self.assertEqual(card["id"], str(alb.id))

    def test_a_bad_id_gets_no_id_rather_than_a_hash_of_junk(self):
        from supysonic import webui

        self.assertIsNone(webui._entity_uuid("album", "../x"))
        self.assertIsNone(webui._entity_uuid("album", None))
        self.assertIsNone(webui._entity_uuid("album", ""))

    # -- the pages take both forms -------------------------------------------

    def test_album_page_by_either_id(self):
        by_dz = self.get("/album/21")
        by_uuid = self.get("/album/" + by_dz["album"]["id"])
        self.assertEqual(by_dz, by_uuid)
        self.assertEqual(by_dz["album"]["id"], str(self.track.album_id))
        self.assertEqual(by_dz["album"]["deezer_id"], "21")

    def test_artist_page_by_either_id(self):
        by_dz = self.get("/artist/11")
        self.assertEqual(by_dz["artist"]["id"], str(self.track.artist_id))
        by_uuid = self.get("/artist/" + by_dz["artist"]["id"])
        self.assertEqual(by_dz, by_uuid)
        self.assertEqual(by_dz["artist"]["deezer_id"], "11")
        self.assertTrue(all(a["id"] for a in by_dz["albums"]))

    def test_playlist_page_by_either_id(self):
        by_dz = self.get("/playlist/900")
        by_uuid = self.get("/playlist/" + str(self.playlist.id))
        self.assertEqual(by_dz, by_uuid)
        self.assertEqual(by_dz["playlist"]["id"], str(self.playlist.id))

    def test_podcast_page_by_either_id(self):
        by_uuid = self.get("/podcast/" + str(self.channel.id))
        by_dz = self.get("/podcast/700")
        self.assertEqual(by_dz, by_uuid)
        self.assertEqual(by_dz["id"], str(self.channel.id))

    def test_podcast_page_refuses_what_is_no_id(self):
        for bad in ("999", "not-a-uuid", "7;drop", str(uuid.uuid4())):
            self.assertEqual(self.client.get("/api/podcast/" + bad).status_code, 404, bad)

    def test_lists_carry_the_id(self):
        home = self.get("/home")
        for shelf in ("recent", "popular", "forgotten"):
            for card in home.get(shelf, []):
                self.assertEqual(card["id"], str(self.track.album_id))
        for p in self.get("/me/playlists")["playlists"]:
            self.assertEqual(p["id"], str(self.playlist.id))
        for c in self.get("/podcasts")["podcasts"]:
            self.assertEqual(c["id"], str(self.channel.id))

    # -- an id costs no statement --------------------------------------------

    def test_the_pages_cost_what_they_cost(self):
        # Measured on master before the change (tools/perf_api.py counts the same).
        for path, budget in (
            ("/artist/11", 9),
            ("/album/21", 7),
            ("/playlist/900", 6),
            ("/me/playlists", 4),
        ):
            self.get(path)  # warm anything cached
            with count_statements() as n:
                self.get(path)
            self.assertEqual(sum(n.values()), budget, (path, dict(n)))

    # -- an existing server ---------------------------------------------------

    def test_the_js_table_is_the_python_one(self):
        # webapp/test/multi-d.test.mjs holds lib/entity.js to these same literals.
        from supysonic.deezer import ids

        table = {
            ("album_uuid", "3361"): "0e98c954-4182-557a-8e56-846307201e91",
            ("album_uuid", "302127"): "f9da9aa5-2c85-501c-b96d-02961d0c3c8e",
            ("artist_uuid", "27"): "3edfce92-d4c7-5601-b907-5399645439a3",
            ("artist_uuid", "1"): "7d7a6d14-5ff4-5b42-b321-c6e03cdbb47a",
            ("playlist_uuid", "908622995"): "61f2274f-2bb5-5f9b-950f-c6618dab76af",
            ("playlist_uuid", "1"): "fdffb472-c5e9-522b-963f-e89aeb26999a",
            ("show_uuid", "12345"): "01f551b4-6c46-5311-bbb8-a6d8a6c89f0a",
        }
        for (fn, dz), expected in table.items():
            self.assertEqual(str(getattr(ids, fn)(dz)), expected, (fn, dz))

    def test_rows_made_before_keep_their_ids_and_the_old_addressing_still_opens_them(self):
        # Nothing here touches the schema or a stored id: the rows an existing server
        # holds are the ones the pages name, the Subsonic API still takes their UUID,
        # and a bookmark or an older SPA that asks by the Deezer id gets the same page.
        from supysonic.deezer import ids

        self.assertEqual(self.track.album_id, ids.album_uuid("21"))
        self.assertEqual(self.track.artist_id, ids.artist_uuid("11"))
        rv = self.client.get(
            "/rest/getAlbum.view",
            query_string={"u": "alice", "p": "Alic3", "c": "t", "v": "1.16.1", "f": "json", "id": str(self.track.album_id)},
        )
        body = rv.get_json()["subsonic-response"]
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["album"]["id"], str(self.track.album_id))
        self.assertEqual(self.get("/album/21")["album"]["id"], body["album"]["id"])

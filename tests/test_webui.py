# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

import os
import shutil
import tempfile
import unittest

from supysonic.config import DefaultConfig
from supysonic.db import Playlist, StarredTrack, Track, User, release_database
from supysonic.managers.user import UserManager
from supysonic.web import create_application


def raw_track(sid, title="T", art=("1", "Artist"), alb=("10", "Album"), pic="md5c"):
    return {
        "SNG_ID": str(sid),
        "SNG_TITLE": title,
        "ART_ID": art[0],
        "ART_NAME": art[1],
        "ALB_ID": alb[0],
        "ALB_TITLE": alb[1],
        "ALB_PICTURE": pic,
        "DURATION": 200,
        "TRACK_NUMBER": 1,
        "DISK_NUMBER": 1,
        "EXPLICIT_LYRICS": "0",
        "GAIN": "-7.0",
    }


class MockGW:
    def __init__(self):
        self.fav_added = []
        self.fav_removed = []
        self.album_fav = []
        self.artist_fav = []
        self.playlist_fav = []
        self.created = []
        self.deleted = []
        self.songs_added = []
        self.songs_removed = []
        self.listens = []
        self.fav_calls = 0
        self.fav_checksum = "cs1"

    def log_listen(self, sng_id, **kw):
        self.listens.append((str(sng_id), kw))

    def get_smart_tracklist(self, stl_id):
        return {
            "DATA": {"TITLE": "Nouveautés"},
            "SONGS": {"data": [raw_track(1, "A"), raw_track(2, "B")]},
        }

    # -- flow / mix / reco ----------------------------------------------

    def get_user_radio(self, user_id=None):
        return {"data": [raw_track(3, "Flow1"), raw_track(4, "Flow2")]}

    def get_track_mix(self, sng_id, start_with_input_track=True):
        return {"data": [raw_track(sng_id, "Seed"), raw_track(5, "Mix")]}

    def get_recommended_tracks(self, limit=50):
        return {"data": [raw_track(6, "Reco")]}

    def get_recommended_albums(self, limit=50):
        return {"data": [{"ALB_ID": "10", "ALB_TITLE": "Bar", "ALB_PICTURE": "cp"}]}

    def get_recommended_artists(self, limit=50):
        return {"data": [{"ART_ID": "9", "ART_NAME": "Foo", "ART_PICTURE": "ap"}]}

    def get_recommended_playlists(self, limit=50):
        return {"data": [{"PLAYLIST_ID": "77", "TITLE": "P", "PLAYLIST_PICTURE": "pp"}]}

    # -- lyrics / discography / playlist page ----------------------------

    def get_track_lyrics(self, sng_id):
        return {
            "LYRICS_TEXT": "line one\nline two",
            "LYRICS_SYNC_JSON": [
                {"milliseconds": "0", "line": "line one"},
                {"milliseconds": "2500", "line": "line two"},
            ],
            "LYRICS_COPYRIGHTS": "(c) test",
        }

    def get_artist_discography_tabs(self, art_id, limit=100):
        return {
            "all": [
                {"id": "10", "title": "Bar", "md5_image": "cp",
                 "release_date": "2020-01-01", "record_type": "album", "nb_song": 12}
            ],
            "album": [
                {"id": "10", "title": "Bar", "md5_image": "cp",
                 "release_date": "2020-01-01", "record_type": "album", "nb_song": 12}
            ],
        }

    def get_playlist_page(self, playlist_id):
        return {
            "DATA": {
                "PLAYLIST_ID": str(playlist_id),
                "TITLE": "My PL",
                "DESCRIPTION": "desc",
                "PLAYLIST_PICTURE": "pp",
                "PICTURE_TYPE": "playlist",
                "NB_SONG": 2,
                "DURATION": 400,
                "PARENT_USERNAME": "tester",
            },
            "SONGS": {"data": [raw_track(1, "A"), raw_track(2, "B")]},
        }

    # -- my library ------------------------------------------------------

    def get_user_playlists(self, user_id, limit=25):
        return [
            {"id": "77", "title": "P", "md5_image": "pp",
             "picture_type": "playlist", "nb_tracks": 3}
        ]

    def get_user_favorite_ids(self, checksum=None, limit=10000, start=0):
        return {"data": [{"SNG_ID": "1"}, {"SNG_ID": "2"}], "checksum": self.fav_checksum}

    def get_my_favorite_tracks(self, limit=25):
        # Mirrors deezerpy.utils.map_user_track: artist/album are objects and
        # covers are full URLs.
        self.fav_calls += 1
        return [
            {"id": "1", "title": "A", "duration": 200, "time_add": 1700000000,
             "artist": {"id": "1", "name": "Artist"},
             "album": {"id": "10", "title": "Album",
                       "cover_medium": "https://e-cdns-images.dzcdn.net/images/cover/md5c/250x250-000000-80-0-0.jpg"}}
        ]

    # -- entity favorites / playlist CRUD --------------------------------

    def add_album_to_favorites(self, alb_id):
        self.album_fav.append(("add", str(alb_id)))

    def remove_album_from_favorites(self, alb_id):
        self.album_fav.append(("remove", str(alb_id)))

    def add_artist_to_favorites(self, art_id):
        self.artist_fav.append(("add", str(art_id)))

    def remove_artist_from_favorites(self, art_id):
        self.artist_fav.append(("remove", str(art_id)))

    def add_playlist_to_favorites(self, playlist_id):
        self.playlist_fav.append(("add", str(playlist_id)))

    def remove_playlist_from_favorites(self, playlist_id):
        self.playlist_fav.append(("remove", str(playlist_id)))

    def create_playlist(self, title, status=0, description=None, songs=None):
        self.created.append((title, description, list(songs or [])))
        return 9999

    def edit_playlist(self, playlist_id, title, status=None, description=None, songs=None):
        self.created.append(("edit", str(playlist_id), title, description))
        return True

    def delete_playlist(self, playlist_id):
        self.deleted.append(str(playlist_id))
        return True

    def add_songs_to_playlist(self, playlist_id, songs, offset=-1):
        self.songs_added.append((str(playlist_id), list(songs)))
        return True

    def remove_songs_from_playlist(self, playlist_id, songs):
        self.songs_removed.append((str(playlist_id), list(songs)))
        return True

    def search(self, query, index=0, limit=10, **kw):
        return {
            "ARTIST": {"data": [{"ART_ID": "9", "ART_NAME": "Foo", "ART_PICTURE": "ap"}]},
            "ALBUM": {"data": [{"ALB_ID": "10", "ALB_TITLE": "Bar", "ALB_PICTURE": "cp"}]},
            "TRACK": {"data": [raw_track(1, "A")]},
        }

    def get_artist_page(self, art_id):
        return {
            "DATA": {"ART_ID": str(art_id), "ART_NAME": "Foo", "ART_PICTURE": "ap"},
            "TOP": {"data": [raw_track(1, "A")]},
            "ALBUMS": {"data": [{"ALB_ID": "10", "ALB_TITLE": "Bar", "ALB_PICTURE": "cp"}]},
            "RELATED_ARTISTS": {"data": [{"ART_ID": "8", "ART_NAME": "Rel"}]},
        }

    def get_album_page(self, alb_id):
        return {
            "DATA": {"ALB_ID": str(alb_id), "ALB_TITLE": "Bar", "ALB_PICTURE": "cp"},
            "SONGS": {"data": [raw_track(1, "A")]},  # page = first batch only
        }

    def get_album_tracks(self, alb_id):
        # full tracklist (more than the page batch)
        return [raw_track(i, f"T{i}") for i in range(1, 6)]

    def get_playlist_tracks(self, playlist_id):
        return [raw_track(i, f"T{i}") for i in range(1, 6)]

    def get_track(self, sng_id):
        return raw_track(sng_id, "A")

    def add_song_to_favorites(self, sng_id):
        self.fav_added.append(str(sng_id))

    def remove_song_from_favorites(self, sng_id):
        self.fav_removed.append(str(sng_id))


def api_track(i=1):
    return {
        "id": i,
        "title": "A",
        "duration": 200,
        "explicit_lyrics": False,
        "artist": {"id": 1, "name": "Artist", "picture_medium": "p"},
        "album": {"id": 10, "title": "Album", "cover_medium": "https://img/c.jpg"},
    }


class MockApi:
    """Stub of the public api.deezer.com client (search + charts)."""

    def search(self, query, limit=25, **kw):
        return {"data": [api_track(1)]}

    def search_album(self, query, limit=25, **kw):
        return {"data": [{"id": 10, "title": "Bar", "cover_medium": "https://img/a.jpg",
                          "artist": {"id": 1, "name": "Artist"}, "nb_tracks": 12}]}

    def search_artist(self, query, limit=25, **kw):
        return {"data": [{"id": 9, "name": "Foo", "picture_medium": "https://img/ar.jpg",
                          "nb_fan": 1000}]}

    def search_playlist(self, query, limit=25, **kw):
        return {"data": [{"id": 77, "title": "P", "picture_medium": "https://img/p.jpg",
                          "nb_tracks": 3, "user": {"id": 5, "name": "owner"}}]}

    def get_editorial_releases(self, limit=25, **kw):
        return self.search_album("", limit)

    def get_chart_artists(self, limit=25, **kw):
        return self.search_artist("", limit)

    def get_chart_playlists(self, limit=25, **kw):
        return self.search_playlist("", limit)

    def get_artist(self, artist_id):
        return {"id": int(artist_id) if str(artist_id).isdigit() else artist_id,
                "name": "Foo", "picture_medium": "https://img/ar.jpg", "nb_fan": 1000}

    def get_artist_top(self, artist_id, limit=15, **kw):
        return {"data": [api_track(1)]}

    def get_artist_albums(self, artist_id, limit=50, **kw):
        return {"data": [{"id": 10, "title": "Bar", "cover_medium": "https://img/a.jpg",
                          "nb_tracks": 12, "artist": {"id": 9, "name": "Foo"}}]}

    def get_artist_related(self, artist_id, limit=20, **kw):
        return {"data": [{"id": 8, "name": "Rel", "picture_medium": "https://img/r.jpg"}]}

    def get_artist_radio(self, artist_id, limit=40, **kw):
        return {"data": [api_track(1), api_track(2)]}


class MockGQL:
    def get_flow_clusters(self, flow_config_id="default"):
        return [
            {
                "isEnabled": True,
                "cluster": {
                    "id": "default-techno",
                    "title": "Techno",
                    "artists": [{"name": "A", "picture": {"medium": "https://img/x.jpg"}}],
                },
            },
            {
                "isEnabled": False,
                "cluster": {"id": "default-rap", "title": "Rap", "artists": []},
            },
        ]

    def update_flow_clusters(self, clusters, flow_config_id="default"):
        self.updated = clusters
        return {"updateFlowConfigClusters": {"__typename": "ok"}}


class MockPrefetch:
    download_pending = 0

    def __init__(self):
        self.ids = []

    def download_ids(self, ids):
        ids = list(ids)
        self.ids += ids
        return len(ids)

    def enqueue(self, track):
        pass


class MockDz:
    def __init__(self):
        self.gw = MockGW()
        self.api = MockApi()
        self.gql = MockGQL()
        self.current_user = {"id": 42, "name": "tester"}


class WebUITestCase(unittest.TestCase):
    def setUp(self):
        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()

        db_path = self.__db[1]
        cache = self.__dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)

        self.app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)

        from supysonic.deezer.provider import DeezerProvider

        provider = DeezerProvider("arl", self.archive, "FLAC")
        provider._dz = MockDz()
        self.app.deezer = provider
        self.app.deezer_prefetch = MockPrefetch()
        self.app.config["DEEZER"]["archive_dir"] = self.archive

        self.client = self.app.test_client()

    def tearDown(self):
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    def _login(self):
        return self.client.post(
            "/api/login", json={"username": "alice", "password": "Alic3"}
        )

    # -- auth ------------------------------------------------------------

    def test_me_requires_login(self):
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_login_logout(self):
        rv = self._login()
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["user"]["name"], "alice")

        self.assertEqual(self.client.get("/api/me").status_code, 200)

        self.client.post("/api/logout")
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_login_bad_credentials(self):
        rv = self.client.post(
            "/api/login", json={"username": "alice", "password": "wrong"}
        )
        self.assertEqual(rv.status_code, 401)

    def test_sync_requires_login(self):
        self.assertEqual(self.client.post("/api/sync").status_code, 401)
        self.assertEqual(self.client.get("/api/sync/status").status_code, 401)

    def test_sync_admin_not_forbidden(self):
        # admin_required must see the logged-in admin (it reads request.webuser,
        # which only login_required sets) — never a blanket 403.
        self._login()
        rv = self.client.get("/api/sync/status")
        self.assertEqual(rv.status_code, 200)
        self.assertIn("running", rv.get_json())
        # No sync_user configured in tests: auth passes, the config check 503s.
        rv = self.client.post("/api/sync")
        self.assertEqual(rv.status_code, 503)
        self.assertEqual(rv.get_json()["error"], "no sync user configured")

    # -- discovery -------------------------------------------------------

    def test_home(self):
        self._login()
        data = self.client.get("/api/home").get_json()
        self.assertTrue(data["mixes"])
        mix = data["mixes"][0]
        self.assertEqual(mix["title"], "Nouveautés")
        self.assertTrue(mix["subtitle"].startswith("Avec"))

    def test_smarttracklist(self):
        self._login()
        data = self.client.get("/api/smarttracklist/new-releases").get_json()
        self.assertEqual(data["playlist"]["title"], "Nouveautés")
        self.assertEqual(len(data["tracks"]), 2)
        self.assertEqual(data["tracks"][0]["title"], "A")

    def test_search(self):
        self._login()
        data = self.client.get("/api/search?q=foo").get_json()
        self.assertEqual(data["artists"][0]["name"], "Foo")
        self.assertEqual(data["albums"][0]["title"], "Bar")
        self.assertEqual(data["tracks"][0]["deezer_id"], "1")
        self.assertEqual(data["playlists"][0]["title"], "P")
        # public API returns ready-to-use image URLs
        self.assertTrue(data["albums"][0]["cover"].startswith("https://"))

    def test_artist_page(self):
        self._login()
        data = self.client.get("/api/artist/9").get_json()
        self.assertEqual(data["artist"]["name"], "Foo")
        self.assertTrue(data["top"])
        self.assertTrue(data["albums"])
        self.assertEqual(data["related"][0]["name"], "Rel")

    def test_favorite_toggle(self):
        self._login()
        rv = self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self.assertEqual(rv.status_code, 200)
        self.assertIn("1", self.app.deezer.dz.gw.fav_added)

        alice = User.get(name="alice")
        self.assertEqual(
            StarredTrack.select().where(StarredTrack.user == alice).count(), 1
        )

        self.client.post("/api/favorite", json={"deezer_id": "1", "on": False})
        self.assertIn("1", self.app.deezer.dz.gw.fav_removed)
        self.assertEqual(
            StarredTrack.select().where(StarredTrack.user == alice).count(), 0
        )

    # -- flow / radio / reco --------------------------------------------

    def test_flow(self):
        self._login()
        data = self.client.get("/api/flow").get_json()
        self.assertEqual(data["tracks"][0]["title"], "Flow1")

    def test_track_radio(self):
        self._login()
        data = self.client.get("/api/radio/track/3135556").get_json()
        self.assertTrue(data["tracks"])
        self.assertEqual(data["tracks"][1]["title"], "Mix")

    def test_flow_deezer_error_no_500(self):
        # A Deezer outage on Flow must degrade to an empty list, not a 500 —
        # the player polls this for autoplay continuation.
        self._login()
        prov = self.app.deezer
        orig = prov.get_flow
        prov.get_flow = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            rv = self.client.get("/api/flow")
        finally:
            prov.get_flow = orig
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["tracks"], [])

    def test_track_radio_deezer_error_no_500(self):
        self._login()
        prov = self.app.deezer
        orig = prov.get_track_mix
        prov.get_track_mix = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            rv = self.client.get("/api/radio/track/3135556")
        finally:
            prov.get_track_mix = orig
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["tracks"], [])

    def test_recommendations(self):
        self._login()
        data = self.client.get("/api/recommendations").get_json()
        self.assertEqual(data["albums"][0]["title"], "Bar")
        self.assertEqual(data["artists"][0]["name"], "Foo")
        self.assertEqual(data["playlists"][0]["title"], "P")

    # -- lyrics / playlist / discography --------------------------------

    def test_lyrics(self):
        self._login()
        data = self.client.get("/api/lyrics/3256388531").get_json()
        self.assertEqual(len(data["lyrics"]["synced"]), 2)
        self.assertEqual(data["lyrics"]["synced"][1]["time"], 2500)
        self.assertIn("line one", data["lyrics"]["text"])

    def test_track_gain(self):
        # ReplayGain endpoint (volume normalization): a numeric Deezer id with no
        # DB row falls back to a live fetch; a non-numeric/local id is null.
        self._login()
        data = self.client.get("/api/gain/5").get_json()
        self.assertAlmostEqual(data["gain"], -7.0)
        self.assertIsNone(self.client.get("/api/gain/not-a-number").get_json()["gain"])

    def test_browse_tracks_carry_gain(self):
        # The gain travels in the track objects the player queues, so normalization
        # has it without an extra request.
        self._login()
        tracks = self.client.get("/api/album/302127").get_json()["tracks"]
        self.assertTrue(all(t["gain"] == -7.0 for t in tracks))

    def test_playlist_page(self):
        self._login()
        data = self.client.get("/api/playlist/7371445944").get_json()
        self.assertEqual(data["playlist"]["title"], "My PL")
        # full tracklist (via playlist.getSongs), not just the page's first batch
        self.assertEqual(len(data["tracks"]), 5)

    def test_album_page(self):
        self._login()
        data = self.client.get("/api/album/302127").get_json()
        self.assertEqual(data["album"]["title"], "Bar")
        self.assertEqual(len(data["tracks"]), 5)
        # No favorite flag on the gw page -> not a favorite (never null/undefined).
        self.assertFalse(data["album"]["is_favorite"])

    def test_album_is_favorite(self):
        # When the gw album page reports the account already favorited it, the
        # detail response surfaces is_favorite so the UI shows the right heart.
        self._login()
        gw = self.app.deezer.dz.gw
        orig = gw.get_album_page

        def fav_page(alb_id):
            page = orig(alb_id)
            page["DATA"]["FAVORITE_STATUS"] = True
            return page

        gw.get_album_page = fav_page
        try:
            data = self.client.get("/api/album/302127").get_json()
        finally:
            gw.get_album_page = orig
        self.assertTrue(data["album"]["is_favorite"])

    def test_discography(self):
        self._login()
        data = self.client.get("/api/artist/9/discography").get_json()
        self.assertIn("album", data["discography"])
        self.assertEqual(data["discography"]["album"][0]["title"], "Bar")

    def test_artist_tracks(self):
        self._login()
        data = self.client.get("/api/artist/9/tracks").get_json()
        self.assertTrue(data["tracks"])
        self.assertEqual(data["tracks"][0]["deezer_id"], "1")

    # -- my library -----------------------------------------------------

    def test_my_playlists(self):
        self._login()
        self.client.post("/api/playlists", json={"title": "Mine"})
        data = self.client.get("/api/me/playlists").get_json()
        titles = [p["title"] for p in data["playlists"]]
        self.assertIn("Mine", titles)
        self.assertTrue(all("id" in p for p in data["playlists"]))

    def test_my_favorites(self):
        self._login()
        data = self.client.get("/api/me/favorites").get_json()
        t = data["tracks"][0]
        self.assertEqual(t["deezer_id"], "1")
        self.assertEqual(t["artist"]["name"], "Artist")
        self.assertEqual(t["album"]["title"], "Album")
        self.assertTrue(t["album"]["cover"].startswith("https://"))
        self.assertEqual(t["added"], 1700000000)

    def test_favorite_ids(self):
        self._login()
        data = self.client.get("/api/me/favorite-ids").get_json()
        self.assertEqual(set(data["ids"]), {"1", "2"})

    def test_favorite_ids_merges_unpushed_db_star(self):
        # A star recorded in the DB but NOT in the live favorites list (push
        # disabled / failed) must still show up, so its heart isn't empty.
        self._login()
        self.client.post("/api/favorite", json={"deezer_id": "3", "on": True})
        ids = set(self.client.get("/api/me/favorite-ids").get_json()["ids"])
        self.assertIn("3", ids)  # DB Deezer star merged in
        self.assertLessEqual({"1", "2"}, ids)  # live favorites still present

    def test_favorite_respects_push_to_deezer_off(self):
        # With push_to_deezer off the admin's star stays local (never mirrored),
        # yet is still recorded so the heart state is correct.
        self._login()
        self.app.config["DEEZER"]["push_to_deezer"] = False
        try:
            rv = self.client.post("/api/favorite", json={"deezer_id": "3", "on": True})
        finally:
            self.app.config["DEEZER"]["push_to_deezer"] = True
        self.assertEqual(rv.status_code, 200)
        self.assertNotIn("3", self.app.deezer.dz.gw.fav_added)  # not mirrored
        ids = set(self.client.get("/api/me/favorite-ids").get_json()["ids"])
        self.assertIn("3", ids)  # but still a local star

    # -- local (non-Deezer) tracks --------------------------------------------

    def _make_local_track(self, title="My Local Song"):
        from supysonic.deezer import library, local

        root = library.get_root_folder(self.archive)
        d = os.path.join(self.archive, "Local Band", "Demo")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, title.replace(" ", "_") + ".mp3")
        with open(path, "wb") as fh:
            fh.write(b"localaudio")

        class FakeTag:
            artist = "Local Band"
            albumartist = None
            album = "Demo"
            genre = "Indie"
            title = None
            disc = 1
            track = 1
            year = None
            length = 180.0
            bitrate = 320000
            images = []

        FakeTag.title = title
        orig = local._load_tag
        local._load_tag = lambda p: FakeTag() if p == path else None
        try:
            return local.import_local_file(path, root)
        finally:
            local._load_tag = orig

    def test_search_includes_local_tracks(self):
        self._login()
        t = self._make_local_track("My Local Song")
        data = self.client.get("/api/search?q=Local").get_json()
        match = [x for x in data["tracks"] if x["title"] == "My Local Song"]
        self.assertEqual(len(match), 1)
        self.assertTrue(match[0]["local"])
        self.assertEqual(match[0]["deezer_id"], str(t.id))
        self.assertEqual(match[0]["artist"]["name"], "Local Band")

    def _make_deezer_track(self, sng_id="1", title="Archived Song", archived=True):
        """Create a DB row for a Deezer track (deezer_id set). When `archived`,
        also drop a file at its archive path so it's playable without Deezer."""
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive)
        t = library.upsert_track(
            {
                "SNG_ID": sng_id,
                "SNG_TITLE": title,
                "ART_NAME": "Archived Artist",
                "ART_ID": "500",
                "ALB_TITLE": "Archived Album",
                "ALB_ID": "600",
                "DURATION": "200",
                "TRACK_NUMBER": "1",
                "DISK_NUMBER": "1",
            },
            root,
        )
        if archived:
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"flacdata")
        return t

    def test_search_includes_archived_deezer_tracks(self):
        # A downloaded (archived) Deezer track must be findable locally — even
        # if Deezer vanishes — and must not be listed twice alongside the live
        # Deezer search hit for the same id.
        self._login()
        self._make_deezer_track(sng_id="1", title="Archived Song", archived=True)
        data = self.client.get("/api/search?q=Archived").get_json()
        match = [x for x in data["tracks"] if x["deezer_id"] == "1"]
        self.assertEqual(len(match), 1)  # deduped against MockApi.search (id 1)
        self.assertEqual(match[0]["title"], "Archived Song")
        self.assertFalse(match[0].get("local"))  # a Deezer track, not an upload

    def test_search_excludes_unarchived_deezer_tracks(self):
        # An imported-but-not-yet-archived row has no file on disk, so it can't
        # play without Deezer — keep it out of the local (offline) results.
        self._login()
        self._make_deezer_track(sng_id="42", title="Ghost Only", archived=False)
        data = self.client.get("/api/search?q=Ghost").get_json()
        self.assertFalse(any(x["deezer_id"] == "42" for x in data["tracks"]))

    def _deezer_down(self):
        """Simulate a Deezer outage: the provider stays set but every call fails,
        so routes must fall back to the local DB (the 'Deezer disappeared' case)."""

        class Boom:
            def __getattr__(self, _name):
                def f(*a, **k):
                    raise RuntimeError("deezer unreachable")

                return f

        self.app.deezer._dz = Boom()

    def test_album_offline_from_db(self):
        self._login()
        self._make_deezer_track(sng_id="1", title="Archived Song", archived=True)
        self._deezer_down()
        rv = self.client.get("/api/album/600")  # ALB_ID from _make_deezer_track
        self.assertEqual(rv.status_code, 200)
        data = rv.get_json()
        self.assertEqual(data["album"]["title"], "Archived Album")
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["1"])

    def test_artist_offline_from_db(self):
        self._login()
        self._make_deezer_track(sng_id="1", title="Archived Song", archived=True)
        self._deezer_down()
        rv = self.client.get("/api/artist/500")  # ART_ID from _make_deezer_track
        self.assertEqual(rv.status_code, 200)
        data = rv.get_json()
        self.assertEqual(data["artist"]["name"], "Archived Artist")
        self.assertIn("600", [a["deezer_id"] for a in data["albums"]])

    def test_mix_offline_from_db(self):
        from supysonic.deezer import ids as dz_ids

        self._login()
        self._make_deezer_track(sng_id="1", title="Archived Song", archived=True)
        pl = Playlist.create(
            id=dz_ids.playlist_uuid("smart:new-releases"),
            user=User.get(name="alice"),
            name="Deezer · Nouveautés",
        )
        pl.add(Track.get(Track.deezer_id == "1"))
        self._deezer_down()
        rv = self.client.get("/api/smarttracklist/new-releases")
        self.assertEqual(rv.status_code, 200)
        data = rv.get_json()
        self.assertEqual(data["playlist"]["title"], "Nouveautés")
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["1"])

    def test_favorites_offline_from_db(self):
        self._login()
        self._make_deezer_track(sng_id="1", title="Archived Song", archived=True)
        # Star it while "online" (goes through the DB either way).
        self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self._deezer_down()
        rv = self.client.get("/api/me/favorites")
        self.assertEqual(rv.status_code, 200)  # must not 500 on a Deezer outage
        self.assertIn("1", [t["deezer_id"] for t in rv.get_json()["tracks"]])
        ids = self.client.get("/api/me/favorite-ids").get_json()["ids"]
        self.assertIn("1", ids)

    def test_favorite_known_track_offline(self):
        self._login()
        self._make_deezer_track(sng_id="1", title="Archived Song", archived=True)
        self._deezer_down()
        rv = self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.get_json()["favorite"])

    def test_cover_by_deezer_id_from_archive(self):
        # /api/cover/<deezer_id> resolves the archived track and serves its cover
        # same-origin (so the web player can cache it offline). Pre-seed the cover
        # cache to exercise routing + serving without a real embedded image.
        self._login()
        t = self._make_deezer_track(sng_id="1", archived=True)
        with self.app.app_context():
            self.app.cache.set(f"localcover-{t.id}", b"JPEGDATA")
        rv = self.client.get("/api/cover/1")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_data(), b"JPEGDATA")

    def test_cover_cdn_fallback_when_not_archived(self):
        # A track that isn't archived yet: /api/cover proxies the art from
        # Deezer (cached on disk) instead of 404ing, so the player always has
        # a same-origin artwork URL for the OS media notification.
        self._login()
        fetches = []

        def fake_fetch_cover(md5, size=1000):
            fetches.append(md5)
            return b"CDNJPEG"

        self.app.deezer.fetch_cover = fake_fetch_cover
        rv = self.client.get("/api/cover/1")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_data(), b"CDNJPEG")
        self.assertEqual(fetches, ["md5c"])  # ALB_PICTURE from the track info

        # Second hit is served from the cache — no new CDN fetch.
        rv = self.client.get("/api/cover/1")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_data(), b"CDNJPEG")
        self.assertEqual(fetches, ["md5c"])

    def test_cover_unknown_id_404(self):
        self._login()
        # The CDN fallback finds no art for it either.
        self.app.deezer.fetch_cover = lambda md5, size=1000: None
        self.assertEqual(self.client.get("/api/cover/999999").status_code, 404)

    def test_stream_local_track_by_uuid(self):
        self._login()
        t = self._make_local_track()
        rv = self.client.get("/api/stream/" + str(t.id))
        self.assertEqual(rv.status_code, 200)

    def test_upload_imports_audio(self):
        from io import BytesIO

        from supysonic.deezer import local

        self._login()

        class FakeTag:
            artist = "Up Artist"
            albumartist = None
            album = "Up Album"
            genre = "Pop"
            title = "Uploaded Song"
            disc = 1
            track = 1
            year = None
            length = 200.0
            bitrate = 256000
            images = []

        orig = local._load_tag
        local._load_tag = lambda p: FakeTag()
        try:
            rv = self.client.post(
                "/api/upload",
                data={"files": (BytesIO(b"audiobytes"), "song.mp3")},
                content_type="multipart/form-data",
            )
        finally:
            local._load_tag = orig
        self.assertEqual(rv.status_code, 200)
        j = rv.get_json()
        self.assertEqual(j["count"], 1)
        self.assertTrue(j["imported"][0]["local"])
        self.assertEqual(j["imported"][0]["title"], "Uploaded Song")
        # it lands in /me/local
        locals_ = self.client.get("/api/me/local").get_json()["tracks"]
        self.assertTrue(any(t["title"] == "Uploaded Song" for t in locals_))

    def test_upload_rejects_non_audio(self):
        from io import BytesIO

        self._login()
        rv = self.client.post(
            "/api/upload",
            data={"files": (BytesIO(b"hello"), "notes.txt")},
            content_type="multipart/form-data",
        )
        self.assertEqual(rv.status_code, 200)
        j = rv.get_json()
        self.assertEqual(j["count"], 0)
        self.assertEqual(j["skipped"], ["notes.txt"])

    # -- upload quota (non-admin cap) ------------------------------------

    def _login_guest(self):
        UserManager.add("bob", "B0bpass", admin=False)
        return self.client.post(
            "/api/login", json={"username": "bob", "password": "B0bpass"}
        )

    def _upload_bytes(self, blobs):
        """POST N files whose import always succeeds (patched tag reader)."""
        from io import BytesIO

        from supysonic.deezer import local

        class FakeTag:
            artist = "Up"
            albumartist = None
            album = "Al"
            genre = None
            title = "Song"
            disc = 1
            track = 1
            year = None
            length = 10.0
            bitrate = 128000
            images = []

        orig = local._load_tag
        local._load_tag = lambda p: FakeTag()
        try:
            data = {
                "files": [(BytesIO(b), f"song{i}.mp3") for i, b in enumerate(blobs)]
            }
            return self.client.post(
                "/api/upload", data=data, content_type="multipart/form-data"
            )
        finally:
            local._load_tag = orig

    def test_settings_quota_admin_only(self):
        # A guest can neither read nor change the server settings.
        self._login_guest()
        self.assertEqual(self.client.get("/api/settings").status_code, 403)
        self.assertEqual(
            self.client.post("/api/settings", json={"upload_quota_gb": 1}).status_code,
            403,
        )
        self.client.post("/api/logout")
        # The admin can read the default and set a new value that round-trips.
        self._login()
        self.assertEqual(self.client.get("/api/settings").status_code, 200)
        rv = self.client.post("/api/settings", json={"upload_quota_gb": 3})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["upload_quota_gb"], 3)
        self.assertEqual(
            self.client.get("/api/settings").get_json()["upload_quota_gb"], 3
        )
        # Garbage is rejected.
        self.assertEqual(
            self.client.post("/api/settings", json={"upload_quota_gb": -1}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/api/settings", json={"upload_quota_gb": "nope"}
            ).status_code,
            400,
        )

    def test_upload_quota_blocks_guest(self):
        # ~250 byte budget for non-admins.
        self._login()
        self.client.post(
            "/api/settings", json={"upload_quota_gb": 250 / 1024**3}
        )
        self.client.post("/api/logout")

        self._login_guest()
        rv = self._upload_bytes([b"x" * 100, b"x" * 100, b"x" * 100])
        self.assertEqual(rv.status_code, 200)
        j = rv.get_json()
        # Two fit under the cap, the third is refused (not saved).
        self.assertEqual(j["count"], 2)
        self.assertTrue(j["quota_exceeded"])
        self.assertEqual(len(j["skipped"]), 1)
        self.assertLessEqual(j["used"], j["quota"])

        # Usage endpoint reflects the two accepted files for this guest.
        usage = self.client.get("/api/upload/usage").get_json()
        self.assertFalse(usage["unlimited"])
        self.assertEqual(usage["used"], 200)
        self.assertEqual(usage["quota"], j["quota"])

        # A further upload that would exceed the remaining room is blocked too.
        rv = self._upload_bytes([b"x" * 100])
        self.assertEqual(rv.get_json()["count"], 0)
        self.assertTrue(rv.get_json()["quota_exceeded"])

    def test_upload_quota_admin_unlimited(self):
        # Even with a tiny cap set, the admin uploads without limit.
        self._login()
        self.client.post("/api/settings", json={"upload_quota_gb": 250 / 1024**3})
        rv = self._upload_bytes([b"x" * 100, b"x" * 100, b"x" * 100])
        j = rv.get_json()
        self.assertEqual(j["count"], 3)
        self.assertNotIn("quota_exceeded", j)  # unlimited: no quota bookkeeping
        usage = self.client.get("/api/upload/usage").get_json()
        self.assertTrue(usage["unlimited"])

    def test_favorite_local_track_stars_locally(self):
        from supysonic.db import StarredTrack

        self._login()
        t = self._make_local_track()
        rv = self.client.post("/api/favorite", json={"deezer_id": str(t.id), "on": True})
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.get_json()["local"])
        self.assertEqual(
            StarredTrack.select().where(StarredTrack.starred == t.id).count(), 1
        )
        # The local star shows up in the favorites endpoints too.
        ids = self.client.get("/api/me/favorite-ids").get_json()["ids"]
        self.assertIn(str(t.id), ids)
        favs = self.client.get("/api/me/favorites").get_json()["tracks"]
        self.assertTrue(any(x.get("local") and x["deezer_id"] == str(t.id) for x in favs))

    def test_listen_disabled_is_noop(self):
        self._login()
        self.app.config["DEEZER"]["report_listens"] = False
        rv = self.client.post("/api/listen", json={"deezer_id": "1", "listened": 30})
        self.assertEqual(rv.status_code, 204)
        self.assertEqual(self.app.deezer._dz.gw.listens, [])

    def test_listen_enabled_reports(self):
        self._login()
        self.app.config["DEEZER"]["report_listens"] = True
        rv = self.client.post(
            "/api/listen",
            json={"deezer_id": "1", "listened": 42, "next_id": "2",
                  "context": {"kind": "flow"}, "shuffle": True},
        )
        self.assertEqual(rv.status_code, 204)
        listens = self.app.deezer._dz.gw.listens
        self.assertEqual(len(listens), 1)
        self.assertEqual(listens[0][0], "1")
        self.assertEqual(listens[0][1]["listened"], 42)
        self.assertEqual(listens[0][1]["next_id"], "2")

    def test_listen_invalid_id(self):
        self._login()
        self.app.config["DEEZER"]["report_listens"] = True
        rv = self.client.post("/api/listen", json={"deezer_id": "abc"})
        self.assertEqual(rv.status_code, 400)

    def test_favorites_checksum_cache(self):
        gw = self.app.deezer._dz.gw
        # Same checksum -> heavy fetch happens once, then served from cache.
        self.app.deezer.get_my_favorite_tracks()
        self.app.deezer.get_my_favorite_tracks()
        self.assertEqual(gw.fav_calls, 1)
        # Invalidation (a star/unstar) forces a refetch.
        self.app.deezer.invalidate_favorites_cache()
        self.app.deezer.get_my_favorite_tracks()
        self.assertEqual(gw.fav_calls, 2)
        # A changed checksum also refetches.
        gw.fav_checksum = "cs2"
        self.app.deezer.get_my_favorite_tracks()
        self.assertEqual(gw.fav_calls, 3)

    def test_search_playlists(self):
        self._login()
        data = self.client.get("/api/search?q=foo").get_json()
        self.assertIn("playlists", data)

    # -- entity favorites -----------------------------------------------

    def test_favorite_album(self):
        self._login()
        rv = self.client.post("/api/favorite/album", json={"deezer_id": "10", "on": True})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(self.app.deezer.dz.gw.album_fav, [("add", "10")])

    def test_favorite_artist_toggle_off(self):
        self._login()
        self.client.post("/api/favorite/artist", json={"deezer_id": "9", "on": False})
        self.assertEqual(self.app.deezer.dz.gw.artist_fav, [("remove", "9")])

    def test_favorite_unknown_kind(self):
        self._login()
        rv = self.client.post("/api/favorite/wat", json={"deezer_id": "1"})
        self.assertEqual(rv.status_code, 400)

    # -- playlist CRUD (DB-backed, Deezer-mirrored) ---------------------

    def _create_playlist(self, title="New", tracks=None):
        return self.client.post(
            "/api/playlists", json={"title": title, "tracks": tracks or []}
        ).get_json()

    @staticmethod
    def _pushed_song_ids(gw):
        out = []
        for _p, songs in gw.songs_added:
            out += songs
        for _p, songs in gw.songs_removed:
            out += songs
        for entry in gw.created:
            if len(entry) == 3:  # (title, description, songs)
                out += entry[2]
        return out

    def test_create_playlist(self):
        self._login()
        body = self._create_playlist("New", ["1", "2"])
        self.assertIn("id", body)  # the Playlist UUID
        self.assertEqual(body["deezer_id"], "9999")  # mirrored to the account
        self.assertEqual(self.app.deezer.dz.gw.created[0][0], "New")
        # the two Deezer tracks were materialized and pushed in order
        self.assertEqual(self.app.deezer.dz.gw.created[0][2], ["1", "2"])

    def test_create_playlist_requires_title(self):
        self._login()
        rv = self.client.post("/api/playlists", json={"title": "  "})
        self.assertEqual(rv.status_code, 400)

    def test_add_remove_playlist_tracks(self):
        self._login()
        pid = self._create_playlist("PL")["id"]
        self.client.post(f"/api/playlist/{pid}/tracks", json={"tracks": ["1", "2"]})
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["1", "2"])
        self.assertTrue(data["playlist"]["editable"])
        # remove one by its id
        self.client.delete(f"/api/playlist/{pid}/tracks", json={"tracks": ["1"]})
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["2"])

    def test_remove_playlist_track_by_index(self):
        self._login()
        pid = self._create_playlist("PL")["id"]
        self.client.post(f"/api/playlist/{pid}/tracks", json={"tracks": ["1", "2", "3"]})
        self.client.delete(f"/api/playlist/{pid}/tracks", json={"indexes": [1]})
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["1", "3"])

    def test_remove_playlist_bad_indexes_400(self):
        # A non-numeric index must 400, not 500 (int() ValueError).
        self._login()
        pid = self._create_playlist("PL")["id"]
        self.client.post(f"/api/playlist/{pid}/tracks", json={"tracks": ["1"]})
        rv = self.client.delete(f"/api/playlist/{pid}/tracks", json={"indexes": ["x"]})
        self.assertEqual(rv.status_code, 400)

    def test_edit_playlist_non_string_title_ignored(self):
        # A non-string title must be ignored, not 500 (.strip() AttributeError).
        self._login()
        pid = self._create_playlist("Keep")["id"]
        rv = self.client.patch(f"/api/playlist/{pid}", json={"title": 123})
        self.assertEqual(rv.status_code, 200)
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual(data["playlist"]["title"], "Keep")  # unchanged

    def test_playlist_mixes_local_and_deezer(self):
        self._login()
        loc = self._make_local_track("Mixtape")
        pid = self._create_playlist("Mix")["id"]
        self.client.post(
            f"/api/playlist/{pid}/tracks", json={"tracks": [str(loc.id), "1"]}
        )
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        uids = [t["deezer_id"] for t in data["tracks"]]
        self.assertIn(str(loc.id), uids)  # local file present (uid == UUID)
        self.assertIn("1", uids)  # Deezer track present
        self.assertTrue(any(t.get("local") for t in data["tracks"]))
        # the local file is never pushed to the Deezer account
        self.assertNotIn(str(loc.id), self._pushed_song_ids(self.app.deezer.dz.gw))

    def test_reorder_playlist(self):
        self._login()
        pid = self._create_playlist("PL")["id"]
        self.client.post(
            f"/api/playlist/{pid}/tracks", json={"tracks": ["1", "2", "3"]}
        )
        rv = self.client.put(
            f"/api/playlist/{pid}/order", json={"tracks": ["3", "1", "2"]}
        )
        self.assertEqual(rv.status_code, 200)
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["3", "1", "2"])

    def test_reorder_playlist_keeps_duplicates(self):
        # A playlist may hold the same track twice; a reorder must keep BOTH
        # occurrences (they used to be collapsed into one).
        self._login()
        pid = self._create_playlist("PL")["id"]
        self.client.post(
            f"/api/playlist/{pid}/tracks", json={"tracks": ["1", "2", "1"]}
        )
        rv = self.client.put(
            f"/api/playlist/{pid}/order", json={"tracks": ["1", "1", "2"]}
        )
        self.assertEqual(rv.status_code, 200)
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["1", "1", "2"])

    def test_reorder_playlist_keeps_omitted_tracks(self):
        # Tracks the client forgot to list survive, appended at the end.
        self._login()
        pid = self._create_playlist("PL")["id"]
        self.client.post(
            f"/api/playlist/{pid}/tracks", json={"tracks": ["1", "2", "3"]}
        )
        rv = self.client.put(f"/api/playlist/{pid}/order", json={"tracks": ["2"]})
        self.assertEqual(rv.status_code, 200)
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual([t["deezer_id"] for t in data["tracks"]], ["2", "1", "3"])

    def test_rename_playlist(self):
        self._login()
        pid = self._create_playlist("Old")["id"]
        rv = self.client.patch(
            f"/api/playlist/{pid}", json={"title": "Renamed", "description": "hey"}
        )
        self.assertEqual(rv.status_code, 200)
        data = self.client.get(f"/api/playlist/{pid}").get_json()
        self.assertEqual(data["playlist"]["title"], "Renamed")
        self.assertEqual(data["playlist"]["description"], "hey")

    def test_delete_playlist(self):
        self._login()
        body = self._create_playlist("PL", ["1"])
        rv = self.client.delete(f"/api/playlist/{body['id']}")
        self.assertEqual(rv.status_code, 200)
        self.assertIn(body["deezer_id"], self.app.deezer.dz.gw.deleted)

    # -- Flow customization ---------------------------------------------

    def test_flow_clusters(self):
        self._login()
        data = self.client.get("/api/flow/clusters").get_json()
        self.assertTrue(data["available"])
        self.assertEqual(data["clusters"][0]["title"], "Techno")
        self.assertTrue(data["clusters"][0]["enabled"])
        self.assertTrue(data["clusters"][0]["cover"].startswith("https://"))

    def test_set_flow_clusters(self):
        self._login()
        rv = self.client.post(
            "/api/flow/clusters",
            json={"clusters": [{"id": "default-rap", "enabled": False}]},
        )
        self.assertEqual(rv.status_code, 200)
        sent = self.app.deezer.dz.gql.updated
        self.assertEqual(sent[0]["clusterId"], "default-rap")
        self.assertFalse(sent[0]["isEnabled"])
        self.assertTrue(sent[0]["isEditedByUser"])

    def test_set_flow_clusters_marks_enabled_as_edited(self):
        # Enabled clusters must also be flagged edited, otherwise Deezer treats
        # them as "default" and drops them -> the tuner reopens with nothing on.
        self._login()
        rv = self.client.post(
            "/api/flow/clusters",
            json={"clusters": [{"id": "default-rap", "enabled": True}]},
        )
        self.assertEqual(rv.status_code, 200)
        sent = self.app.deezer.dz.gql.updated
        self.assertTrue(sent[0]["isEnabled"])
        self.assertTrue(sent[0]["isEditedByUser"])

    # -- download (pre-archive) -----------------------------------------

    def test_download(self):
        self._login()
        rv = self.client.post("/api/download", json={"ids": ["1", "2", "bad"]})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["queued"], 2)  # "bad" rejected
        self.assertEqual(self.app.deezer_prefetch.ids, ["1", "2"])

    # -- SPA serving ----------------------------------------------------

    def test_spa_served(self):
        # No build present in the test env -> friendly 503 notice, not a 404.
        rv = self.client.get("/app/")
        self.assertEqual(rv.status_code, 503)
        self.assertIn(b"not built", rv.data)


class WebUIGuestTestCase(unittest.TestCase):
    """Non-admin users are guests: Deezer is just a content source. No owner
    playlists / favorites / recommendations / Flow, no telemetry, and no writes
    to the shared Deezer account. Their own favorites are private + local."""

    def setUp(self):
        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path = self.__db[1]
        cache = self.__dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(
                    self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True
                )

        self.app = create_application(Config())
        UserManager.add("bob", "B0bbb", admin=False)

        from supysonic.deezer.provider import DeezerProvider

        provider = DeezerProvider("arl", self.archive, "FLAC")
        provider._dz = MockDz()
        self.app.deezer = provider
        self.app.deezer_prefetch = MockPrefetch()
        self.app.config["DEEZER"]["archive_dir"] = self.archive
        # Telemetry enabled, to prove guests still never feed it.
        self.app.config["DEEZER"]["report_listens"] = True

        self.client = self.app.test_client()

    def tearDown(self):
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    def _login(self):
        return self.client.post(
            "/api/login", json={"username": "bob", "password": "B0bbb"}
        )

    def test_login_marks_non_admin(self):
        self.assertFalse(self._login().get_json()["user"]["admin"])

    def test_no_personalized_discovery(self):
        self._login()
        self.assertEqual(self.client.get("/api/home").get_json(), {"mixes": []})
        self.assertEqual(self.client.get("/api/flow").get_json(), {"tracks": []})
        self.assertEqual(
            self.client.get("/api/recommendations").get_json(),
            {"albums": [], "artists": [], "playlists": []},
        )
        self.assertFalse(self.client.get("/api/flow/clusters").get_json()["available"])

    def test_no_owner_playlists(self):
        self._login()
        self.assertEqual(
            self.client.get("/api/me/playlists").get_json(), {"playlists": []}
        )

    def test_telemetry_suppressed(self):
        self._login()
        rv = self.client.post("/api/listen", json={"deezer_id": "1", "listened": 30})
        self.assertEqual(rv.status_code, 204)
        self.assertEqual(self.app.deezer.dz.gw.listens, [])

    def test_favorite_is_local_only(self):
        self._login()
        rv = self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(self.app.deezer.dz.gw.fav_added, [])  # not mirrored to Deezer

        bob = User.get(name="bob")
        self.assertEqual(
            StarredTrack.select().where(StarredTrack.user == bob).count(), 1
        )
        # ...but it shows in the guest's own (local) favorites + heart-state ids.
        favs = self.client.get("/api/me/favorites").get_json()["tracks"]
        self.assertEqual(favs[0]["deezer_id"], "1")
        self.assertIn("1", self.client.get("/api/me/favorite-ids").get_json()["ids"])

    def test_account_writes_forbidden(self):
        self._login()
        self.assertEqual(
            self.client.post(
                "/api/favorite/album", json={"deezer_id": "10", "on": True}
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post("/api/playlists", json={"title": "X"}).status_code, 403
        )
        self.assertEqual(
            self.client.post(
                "/api/flow/clusters",
                json={"clusters": [{"id": "x", "enabled": True}]},
            ).status_code,
            403,
        )
        # nothing reached the Deezer account
        self.assertEqual(self.app.deezer.dz.gw.album_fav, [])
        self.assertEqual(self.app.deezer.dz.gw.created, [])

    def test_browsing_still_works(self):
        self._login()
        self.assertEqual(self.client.get("/api/album/302127").status_code, 200)
        self.assertEqual(self.client.get("/api/radio/track/3").status_code, 200)
        self.assertEqual(self.client.get("/api/search?q=foo").status_code, 200)

    def test_sync_forbidden_for_guests(self):
        self._login()
        self.assertEqual(self.client.post("/api/sync").status_code, 403)
        self.assertEqual(self.client.get("/api/sync/status").status_code, 403)


if __name__ == "__main__":
    unittest.main()

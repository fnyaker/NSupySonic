# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

import os
import shutil
import tempfile
import time
import unittest

from supysonic import webui as _webui
from supysonic.config import DefaultConfig
from supysonic.db import Playlist, StarredTrack, Track, User, now, release_database
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
        # Which albums the archiver actually walked — how the artist-scope
        # tests tell "one release" from "the whole discography".
        self.taken_albums = []
        self.fav_checksum = "cs1"

    def log_listen(self, sng_id, **kw):
        self.listens.append((str(sng_id), kw))

    def set_episode_bookmark(self, episode_id, offset, duration, is_heard=False):
        self.episode_bookmarks = getattr(self, "episode_bookmarks", [])
        self.episode_bookmarks.append((str(episode_id), offset, duration, is_heard))

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
            # "10" appears twice: gw does that (album + deluxe entry), and the
            # archiver must not walk it twice.
            "all": [
                {"id": "10", "title": "Bar", "md5_image": "cp",
                 "release_date": "2020-01-01", "record_type": "album", "nb_song": 12},
                {"id": "11", "title": "Baz", "md5_image": "cp",
                 "release_date": "2021-01-01", "record_type": "single", "nb_song": 2},
                {"id": "10", "title": "Bar", "md5_image": "cp",
                 "release_date": "2020-01-01", "record_type": "album", "nb_song": 12},
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
        self.taken_albums.append(str(alb_id))
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
        "contributors": [
            {"id": 1, "name": "Artist", "role": "Main"},
            {"id": 2, "name": "Guest", "role": "Featured"},
        ],
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
        return {"data": [api_track(i) for i in range(1, min(limit, 15) + 1)]}

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
        self.episode_ids = []

    def download_ids(self, ids):
        ids = list(ids)
        self.ids += ids
        return len(ids)

    def download_episode_ids(self, ids):
        ids = list(ids)
        self.episode_ids += ids
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

    def test_lyrics_archived_sidecar(self):
        # An archived track with a .lrc sidecar is served from disk (source
        # "archive"), not re-fetched live from Deezer.
        from supysonic.deezer import library, lyrics as dz_lyrics

        self._login()
        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            t = library.upsert_track(
                {"SNG_ID": "555", "SNG_TITLE": "Song", "ART_ID": "1", "ART_NAME": "A",
                 "ALB_ID": "10", "ALB_TITLE": "Alb", "ALB_PICTURE": "c", "DURATION": 100,
                 "TRACK_NUMBER": 1, "DISK_NUMBER": 1}, root, "FLAC")
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"\x00")
            dz_lyrics.write_sidecar(
                t, {"synced": [{"time": 7000, "text": "archived line"}], "text": "archived line"}
            )
        data = self.client.get("/api/lyrics/555").get_json()
        self.assertEqual(data["lyrics"]["source"], "archive")
        self.assertEqual(data["lyrics"]["synced"][0]["text"], "archived line")

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

    # -- archive completeness & storage ----------------------------------

    def test_backfill_archives_what_playback_never_touched(self):
        """Favorites and playlist tracks must not stay hostage to Deezer until
        someone happens to press play on them."""
        from supysonic.deezer import backfill

        fav = self._make_deezer_track(sng_id="70", title="Fav", archived=False)
        inpl = self._make_deezer_track(sng_id="71", title="In playlist", archived=False)
        already = self._make_deezer_track(sng_id="72", title="Done", archived=True)
        user = User.get(User.name == "alice")
        StarredTrack.create(user=user, starred=fav)
        StarredTrack.create(user=user, starred=already)
        pl = Playlist.create(user=user, name="Mix")
        from supysonic.db import PlaylistTrack

        PlaylistTrack.create(playlist=pl, track=inpl, index=0)

        tracks, episodes = backfill.collect(user.id, True, "all")
        ids = {t.deezer_id for t in tracks}
        self.assertIn("70", ids)
        self.assertIn("71", ids)
        # Already on disk: never re-fetched.
        self.assertNotIn("72", ids)

        archived = []
        from supysonic.deezer import archive as archive_mod

        orig = archive_mod.ensure_archived
        archive_mod.ensure_archived = lambda prov, t: archived.append(t.deezer_id)
        try:
            stats = backfill.run(self.app.deezer, tracks, episodes)
        finally:
            archive_mod.ensure_archived = orig
        self.assertEqual(set(archived), ids)
        self.assertEqual(stats["archived"], len(tracks))

    def test_backfill_counts_dead_tracks_apart_from_failures(self):
        from supysonic.deezer import archive as archive_mod
        from supysonic.deezer import backfill
        from supysonic.deezer.provider import TrackUnavailable

        gone = self._make_deezer_track(sng_id="73", title="Gone", archived=False)
        orig = archive_mod.ensure_archived

        def boom(prov, t):
            raise TrackUnavailable("no source")

        archive_mod.ensure_archived = boom
        try:
            stats = backfill.run(self.app.deezer, [gone], [])
        finally:
            archive_mod.ensure_archived = orig
        self.assertEqual(stats["unavailable"], 1)
        self.assertEqual(stats["failed"], 0)

    def test_only_one_sweep_runs_at_a_time(self):
        """The nightly sync and the button share one lock. Two sweeps would
        fetch the same missing tracks twice and fight over one Deezer session."""
        from supysonic.deezer import backfill

        user = User.get(User.name == "alice")
        self.assertFalse(backfill.is_sweeping())
        self.assertTrue(backfill._sweep_lock.acquire(blocking=False))
        try:
            self.assertTrue(backfill.is_sweeping())
            self.assertTrue(backfill.sweep_for(self.app.deezer, user).get("skipped"))
            # And the endpoint says so instead of starting a doomed thread.
            self._login()
            body = self.client.post(
                "/api/archive/backfill", json={"scope": "all"}
            ).get_json()
            self.assertTrue(body.get("busy"))
        finally:
            backfill._sweep_lock.release()
        self.assertFalse(backfill.is_sweeping())

    def test_backfill_is_admin_only(self):
        self._login()
        self.assertEqual(
            self.client.post("/api/archive/backfill", json={"scope": "nope"}).status_code,
            400,
        )
        rv = self.client.post("/api/archive/backfill", json={"scope": "favorites"})
        self.assertIn(rv.status_code, (200, 503))

    def test_storage_reports_disk_and_caches(self):
        self._login()
        body = self.client.get("/api/storage").get_json()
        self.assertEqual(body["archive_dir"], self.archive)
        self.assertGreater(body["disk_total"], 0)
        self.assertIn("cache_bytes", body)
        self.assertIn("transcode_bytes", body)

    def test_flushing_the_cache_never_touches_the_archive(self):
        """The one guarantee that matters here: derived files go, archived audio
        stays. Anything else would silently destroy the library."""
        track = self._make_deezer_track(sng_id="80", title="Precious", archived=True)
        self.app.cache.set("some-cover", b"x" * 128)
        self.assertTrue(self.app.cache.has("some-cover"))

        self._login()
        rv = self.client.post("/api/cache/flush")
        self.assertEqual(rv.status_code, 200)
        self.assertFalse(self.app.cache.has("some-cover"))
        self.assertTrue(os.path.isfile(track.path))

    # -- unavailable tracks & replacement --------------------------------

    def test_probe_says_available_for_an_archived_track(self):
        """The whole point of archiving: once the audio is on disk, the track is
        ours. Deezer can delist it and it still plays — so the probe must never
        even ask, and must clear any earlier verdict."""
        from supysonic.db import Track

        t = self._make_deezer_track(sng_id="42", title="Kept", archived=True)
        Track.update(unavailable=now()).where(Track.id == t.id).execute()

        self._login()
        body = self.client.get("/api/track/42/probe").get_json()
        self.assertTrue(body["available"])
        self.assertIsNone(Track.get(Track.id == t.id).unavailable)

    def test_probe_marks_a_dead_track_and_lists_it(self):
        from supysonic.db import Track
        from supysonic.deezer.provider import TrackUnavailable

        t = self._make_deezer_track(sng_id="43", title="Gone", archived=False)
        provider = self.app.deezer
        orig = provider.resolve
        provider.resolve = lambda *a, **k: (_ for _ in ()).throw(
            TrackUnavailable("no playable source")
        )
        try:
            self._login()
            body = self.client.get("/api/track/43/probe").get_json()
        finally:
            provider.resolve = orig
        self.assertFalse(body["available"])
        self.assertEqual(body["reason"], "unavailable")
        self.assertIsNotNone(Track.get(Track.id == t.id).unavailable)

        # …and it shows up in the list the library's "indisponibles" tab reads.
        listing = self.client.get("/api/unavailable").get_json()["tracks"]
        self.assertIn("Gone", [x["title"] for x in listing])
        self.assertTrue(listing[0]["unavailable"])

    def test_probe_stays_neutral_when_deezer_is_merely_unreachable(self):
        """A network failure says nothing about the track. Reporting it as dead
        would condemn a whole library during one bad minute."""
        from supysonic.db import Track
        from supysonic.deezer.provider import DeezerError

        t = self._make_deezer_track(sng_id="44", title="Fine", archived=False)
        provider = self.app.deezer
        orig = provider.resolve
        provider.resolve = lambda *a, **k: (_ for _ in ()).throw(
            DeezerError("Deezer unreachable")
        )
        try:
            self._login()
            body = self.client.get("/api/track/44/probe").get_json()
        finally:
            provider.resolve = orig
        self.assertTrue(body["available"])
        self.assertIsNone(Track.get(Track.id == t.id).unavailable)

    def test_track_lists_carry_the_unavailable_flag(self):
        from supysonic.db import Track

        t = self._make_deezer_track(sng_id="45", title="Dead", archived=False)
        Track.update(unavailable=now()).where(Track.id == t.id).execute()

        self._login()
        # A gateway-sourced list (favorites) gets the flag from a batched lookup.
        flagged = _webui.flag_unavailable(
            [{"deezer_id": "45", "title": "Dead"}, {"deezer_id": "999", "title": "Ok"}]
        )
        self.assertTrue(flagged[0].get("unavailable"))
        self.assertIsNone(flagged[1].get("unavailable"))

    def test_replace_rewrites_playlists_and_favorites(self):
        from supysonic.db import Playlist, PlaylistTrack, StarredTrack, Track

        dead = self._make_deezer_track(sng_id="50", title="Dead One", archived=False)
        alive = self._make_deezer_track(sng_id="51", title="Live One", archived=True)
        user = User.get(User.name == "alice")
        pl = Playlist.create(user=user, name="Mix")
        PlaylistTrack.create(playlist=pl, track=dead, index=0)
        StarredTrack.create(user=user, starred=dead)

        self._login()
        rv = self.client.post("/api/replace", json={"from": "50", "to": "51"})
        self.assertEqual(rv.status_code, 200)
        job = rv.get_json()["job"]

        # The worker is a thread: wait for it, then check what it did.
        deadline = time.time() + 5
        status = None
        while time.time() < deadline:
            status = self.client.get("/api/replace/status/" + job).get_json()
            if not status["running"]:
                break
            time.sleep(0.05)
        self.assertIsNotNone(status)
        self.assertFalse(status["running"])
        self.assertTrue(status["ok"], status)

        rows = list(PlaylistTrack.select().where(PlaylistTrack.playlist == pl.id))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].track_id, alive.id)
        self.assertEqual(rows[0].index, 0)  # same position, not appended
        self.assertIsNone(StarredTrack.get_or_none(StarredTrack.starred == dead.id))
        self.assertIsNotNone(StarredTrack.get_or_none(StarredTrack.starred == alive.id))

    # -- deleting an unavailable track ------------------------------------
    # "Unavailable" means neither Deezer nor the disk has it. Every one of these
    # is about the server REFUSING to delete something that still exists
    # somewhere — the feature is only safe because of what it won't do.

    def _await_job(self, job):
        deadline = time.time() + 5
        status = None
        while time.time() < deadline:
            status = self.client.get("/api/replace/status/" + job).get_json()
            if not status["running"]:
                return status
            time.sleep(0.05)
        return status

    def _dead(self, provider):
        from supysonic.deezer.provider import TrackUnavailable

        return lambda *a, **k: (_ for _ in ()).throw(TrackUnavailable("no source"))

    def test_deleting_a_truly_gone_track_removes_it_everywhere(self):
        from supysonic.db import Playlist, PlaylistTrack, StarredTrack, Track

        dead = self._make_deezer_track(sng_id="60", title="Gone", archived=False)
        keep = self._make_deezer_track(sng_id="61", title="Kept", archived=True)
        user = User.get(User.name == "alice")
        pl = Playlist.create(user=user, name="Mix")
        PlaylistTrack.create(playlist=pl, track=dead, index=0)
        PlaylistTrack.create(playlist=pl, track=keep, index=1)
        StarredTrack.create(user=user, starred=dead, date=now())

        provider = self.app.deezer
        orig = provider.resolve
        provider.resolve = self._dead(provider)
        try:
            self._login()
            rv = self.client.delete("/api/track/60")
            self.assertEqual(rv.status_code, 200, rv.get_json())
            status = self._await_job(rv.get_json()["job"])
        finally:
            provider.resolve = orig

        self.assertTrue(status["ok"], status)
        self.assertIsNone(Track.get_or_none(Track.id == dead.id))
        self.assertIsNone(StarredTrack.get_or_none(StarredTrack.starred == dead.id))
        # The rest of the playlist survives, and closes its gap.
        rows = list(PlaylistTrack.select().where(PlaylistTrack.playlist == pl.id))
        self.assertEqual([(r.track_id, r.index) for r in rows], [(keep.id, 0)])

    def test_an_archived_track_is_never_deletable(self):
        """The whole promise of archiving: it plays forever, whatever Deezer
        does. Deezer saying "gone" must not be enough to erase it."""
        from supysonic.db import Track

        track = self._make_deezer_track(sng_id="62", title="Safe", archived=True)
        Track.update(unavailable=now()).where(Track.id == track.id).execute()

        provider = self.app.deezer
        orig = provider.resolve
        provider.resolve = self._dead(provider)
        try:
            self._login()
            rv = self.client.delete("/api/track/62")
        finally:
            provider.resolve = orig

        self.assertEqual(rv.status_code, 409)
        self.assertEqual(rv.get_json()["reason"], "archived")
        self.assertIsNotNone(Track.get_or_none(Track.id == track.id))
        # …and the stale verdict is cleared on the way out.
        self.assertIsNone(Track.get(Track.id == track.id).unavailable)

    def test_a_playable_track_is_never_deletable(self):
        from supysonic.db import Track

        track = self._make_deezer_track(sng_id="63", title="Alive", archived=False)
        Track.update(unavailable=now()).where(Track.id == track.id).execute()

        provider = self.app.deezer
        orig = provider.resolve
        provider.resolve = lambda *a, **k: {"url": "https://example/audio"}
        try:
            self._login()
            rv = self.client.delete("/api/track/63")
        finally:
            provider.resolve = orig

        self.assertEqual(rv.status_code, 409)
        self.assertEqual(rv.get_json()["reason"], "playable")
        self.assertIsNotNone(Track.get_or_none(Track.id == track.id))
        # A stale verdict on a track that plays is cleared, not left to rot.
        self.assertIsNone(Track.get(Track.id == track.id).unavailable)

    def test_an_inconclusive_answer_never_authorises_a_deletion(self):
        """A network blip is not a verdict. Deleting on one would turn a bad
        minute into permanent data loss."""
        from supysonic.db import Track
        from supysonic.deezer.provider import DeezerError

        track = self._make_deezer_track(sng_id="64", title="Maybe", archived=False)
        provider = self.app.deezer
        orig = provider.resolve
        provider.resolve = lambda *a, **k: (_ for _ in ()).throw(DeezerError("down"))
        try:
            self._login()
            rv = self.client.delete("/api/track/64")
        finally:
            provider.resolve = orig
        self.assertEqual(rv.status_code, 409)
        self.assertEqual(rv.get_json()["reason"], "inconclusive")
        self.assertIsNotNone(Track.get_or_none(Track.id == track.id))

    def test_a_local_upload_with_no_file_left_is_deletable(self):
        """Nothing else in the world has a copy, and there is no file: it is
        genuinely gone, and no Deezer call can say otherwise."""
        from supysonic.db import Track

        track = self._make_deezer_track(sng_id="65", title="Lost", archived=False)
        Track.update(deezer_id=None).where(Track.id == track.id).execute()

        self._login()
        rv = self.client.delete("/api/track/" + str(track.id))
        self.assertEqual(rv.status_code, 200, rv.get_json())
        self.assertTrue(self._await_job(rv.get_json()["job"])["ok"])
        self.assertIsNone(Track.get_or_none(Track.id == track.id))

    def test_deleting_an_unknown_track_is_a_404(self):
        self._login()
        self.assertEqual(self.client.delete("/api/track/999999").status_code, 404)

    def test_replace_rejects_nonsense(self):
        self._login()
        self.assertEqual(
            self.client.post("/api/replace", json={"from": "1", "to": "1"}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post("/api/replace", json={"from": "", "to": "2"}).status_code,
            400,
        )
        # A source we've never heard of isn't replaceable.
        self.assertEqual(
            self.client.post(
                "/api/replace", json={"from": "987654321", "to": "2"}
            ).status_code,
            404,
        )

    def test_replacement_candidates_exclude_the_dead_ones(self):
        from supysonic.db import Track

        dead = self._make_deezer_track(sng_id="60", title="Song", archived=False)
        other = self._make_deezer_track(sng_id="61", title="Song", archived=True)
        Track.update(unavailable=now()).where(Track.id == dead.id).execute()

        self._login()
        body = self.client.get("/api/replace/candidates/60").get_json()
        ids = [c["deezer_id"] for c in body["candidates"]]
        self.assertNotIn("60", ids)  # never itself
        self.assertIn("Archived Artist Song", body["query"])

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

    def _make_feat_track(self, sng_id="7", title="Feat Song"):
        """An archived DB track credited to a main artist plus a guest."""
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive)
        t = library.upsert_track(
            {
                "SNG_ID": sng_id,
                "SNG_TITLE": title,
                "ART_NAME": "Main Act",
                "ART_ID": "500",
                "ALB_TITLE": "Archived Album",
                "ALB_ID": "600",
                "DURATION": "200",
                "TRACK_NUMBER": "1",
                "DISK_NUMBER": "1",
                "ARTISTS": [
                    {"ART_ID": "500", "ART_NAME": "Main Act", "ROLE_ID": "0",
                     "ARTISTS_SONGS_ORDER": "0"},
                    {"ART_ID": "501", "ART_NAME": "Guest Act", "ROLE_ID": "5",
                     "ARTISTS_SONGS_ORDER": "1"},
                ],
            },
            root,
        )
        os.makedirs(os.path.dirname(t.path), exist_ok=True)
        with open(t.path, "wb") as fh:
            fh.write(b"flacdata")
        return t

    def test_db_track_exposes_credits(self):
        self._login()
        self._make_feat_track(sng_id="7", title="Feat Song")
        data = self.client.get("/api/search?q=Feat Song").get_json()
        hit = [x for x in data["tracks"] if x["deezer_id"] == "7"][0]
        # The classic field still names the primary — archive paths, Subsonic
        # clients and the old UI all read it.
        self.assertEqual(hit["artist"]["name"], "Main Act")
        self.assertEqual([a["name"] for a in hit["artists"]], ["Main Act", "Guest Act"])
        self.assertEqual(hit["display_artist"], "Main Act feat. Guest Act")

    def test_db_track_without_credits_falls_back_to_primary(self):
        # Rows imported before credits existed have no TrackArtist rows at all;
        # they must still serialize a usable one-entry list.
        self._login()
        self._make_deezer_track(sng_id="8", title="Plain Song", archived=True)
        data = self.client.get("/api/search?q=Plain Song").get_json()
        hit = [x for x in data["tracks"] if x["deezer_id"] == "8"][0]
        self.assertEqual(hit["artists"],
                         [{"deezer_id": "500", "name": "Archived Artist", "role": "Main"}])
        self.assertEqual(hit["display_artist"], "Archived Artist")

    def test_credits_are_not_an_n_plus_one(self):
        # Serializing a LIST must resolve every credit in one batched query.
        # A per-row lookup is what turns a 4000-track favourites page into a
        # multi-second wait, so guard it with a test rather than a comment.
        from supysonic import webui

        self._login()
        for i in range(6):
            self._make_feat_track(sng_id=str(100 + i), title=f"Batch Song {i}")

        calls = []
        original = webui._db_credits
        webui._db_credits = lambda t: (calls.append(t.id), original(t))[1]
        try:
            data = self.client.get("/api/search?q=Batch Song").get_json()
        finally:
            webui._db_credits = original

        hits = [x for x in data["tracks"] if x["title"].startswith("Batch Song")]
        self.assertEqual(len(hits), 6)
        self.assertTrue(all(h["display_artist"] == "Main Act feat. Guest Act" for h in hits))
        self.assertEqual(calls, [])  # batched, never per-row

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

    def test_upload_accepts_a_cyrillic_filename(self):
        """End to end: a name with no Latin characters at all used to come back
        from secure_filename as just "mp3", losing the extension, so the file was
        rejected as an unsupported format — non-Latin libraries couldn't upload."""
        import os
        from io import BytesIO

        from supysonic.deezer import local

        self._login()

        class FakeTag:
            artist = "Артист"
            albumartist = None
            album = "Альбом"
            genre = "Pop"
            title = "Песня"
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
                data={"files": (BytesIO(b"audiobytes"), "Песня.mp3")},
                content_type="multipart/form-data",
            )
        finally:
            local._load_tag = orig
        self.assertEqual(rv.status_code, 200)
        j = rv.get_json()
        self.assertEqual(j["skipped"], [])
        self.assertEqual(j["count"], 1)
        self.assertEqual(j["imported"][0]["title"], "Песня")
        # the file really landed on disk, under the user's upload folder, with
        # its own name intact
        found = [
            os.path.join(d, f)
            for d, _s, fs in os.walk(os.path.join(self.archive, "Uploads"))
            for f in fs
        ]
        self.assertEqual([os.path.basename(x) for x in found], ["Песня.mp3"])

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

    # -- Deezer credential (ARL) -----------------------------------------

    def test_settings_never_leaks_the_arl(self):
        self._login()
        dz = self.client.get("/api/settings").get_json()["deezer"]
        self.assertTrue(dz["arl_set"])
        self.assertEqual(dz["arl_hint"], "…")  # short test ARL, still masked
        self.assertNotIn("arl", dz)
        self.assertNotIn("arl", str(dz).replace("arl_set", "").replace("arl_hint", "")
                         .replace("arl_source", ""))

    def test_set_arl_rejects_malformed(self):
        from supysonic.db import Meta

        self._login()
        for bad in ["short", "x" * 40 + "\nCookie: evil", "with space " * 5]:
            rv = self.client.post("/api/settings", json={"deezer_arl": bad})
            self.assertEqual(rv.status_code, 400, bad)
        self.assertIsNone(Meta.get_or_none(Meta.key == "deezer_arl"))

    def test_set_arl_rejects_one_deezer_refuses(self):
        """A dead credential must never be stored: it would take the proxy out."""
        import supysonic.deezer as dzmod
        from supysonic.db import Meta

        class Refusing(dzmod.DeezerProvider):
            def check_login(self, force=False):
                return {"ok": False, "reason": "arl", "detail": "nope", "account": None}

        orig = dzmod.DeezerProvider
        dzmod.DeezerProvider = Refusing
        try:
            self._login()
            rv = self.client.post("/api/settings", json={"deezer_arl": "a" * 64})
            self.assertEqual(rv.status_code, 400)
            self.assertEqual(rv.get_json()["reason"], "arl")
        finally:
            dzmod.DeezerProvider = orig
        self.assertIsNone(Meta.get_or_none(Meta.key == "deezer_arl"))

    def test_set_arl_stores_and_overrides_the_config(self):
        import supysonic.deezer as dzmod
        from supysonic.db import Meta

        class Accepting(dzmod.DeezerProvider):
            def check_login(self, force=False):
                return {"ok": True, "reason": None, "detail": None, "account": "tester"}

        orig = dzmod.DeezerProvider
        dzmod.DeezerProvider = Accepting
        try:
            self._login()
            rv = self.client.post("/api/settings", json={"deezer_arl": "b" * 64})
            self.assertEqual(rv.status_code, 200)
            dz = rv.get_json()["deezer"]
            self.assertEqual(dz["arl_source"], "database")
            self.assertEqual(dz["arl_hint"], "…bbbb")
            self.assertEqual(Meta.get(Meta.key == "deezer_arl").value, "b" * 64)
            # The stored one wins when a provider is rebuilt.
            self.assertEqual(dzmod.stored_arl(), "b" * 64)
            self.app.config["DEEZER"]["enabled"] = True
            self.assertEqual(dzmod.get_provider(self.app.config).arl, "b" * 64)
            # …and clearing it falls back to the configured credential.
            rv = self.client.post("/api/settings", json={"deezer_arl": ""})
            self.assertEqual(rv.status_code, 200)
            self.assertIsNone(dzmod.stored_arl())
        finally:
            dzmod.DeezerProvider = orig

    def test_deezer_status_reports_a_dead_arl(self):
        self._login()
        rv = self.client.get("/api/deezer/status")
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.get_json()["ok"])

        provider = self.app.deezer
        orig = provider.check_login
        provider.check_login = lambda force=False: {
            "ok": False, "reason": "arl", "detail": "expired", "account": None
        }
        try:
            body = self.client.get("/api/deezer/status").get_json()
            self.assertFalse(body["ok"])
            self.assertEqual(body["reason"], "arl")
            self.assertTrue(body["admin"])
            self.assertIn("Réglages", body["message"])
            # A network failure is NOT reported as a broken credential.
            provider.check_login = lambda force=False: {
                "ok": False, "reason": "network", "detail": "boom", "account": None
            }
            body = self.client.get("/api/deezer/status").get_json()
            self.assertEqual(body["reason"], "network")
            self.assertNotIn("Réglages", body["message"])
        finally:
            provider.check_login = orig

    def test_version_endpoint(self):
        rv = self.client.get("/api/version")  # no login required
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.headers["Cache-Control"], "no-store")
        body = rv.get_json()
        self.assertIn("build", body)
        self.assertIn("android", body)
        # Nothing is claimed about the Android app unless the server declares it.
        self.assertIsNone(body["android"]["version"])
        self.assertTrue(body["android"]["url"].startswith("https://"))

        self.app.config["WEBAPP"]["android_version"] = "1.4.0"
        self.app.config["WEBAPP"]["android_url"] = "javascript:alert(1)"
        body = self.client.get("/api/version").get_json()
        self.assertEqual(body["android"]["version"], "1.4.0")
        # A non-http(s) link never reaches the client (it lands in an <a>).
        self.assertTrue(body["android"]["url"].startswith("https://"))

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

    # -- archiving is event-driven ---------------------------------------
    # "Something became mine" is the trigger; there is deliberately no timer
    # anywhere. These pin the events down one by one, because a silently
    # unhooked one only shows up the day Deezer removes the track.

    def test_starring_a_track_archives_it(self):
        self._login()
        self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self.assertEqual(self.app.deezer_prefetch.ids, ["1"])

    def test_unstarring_archives_nothing(self):
        self._login()
        self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self.app.deezer_prefetch.ids.clear()
        self.client.post("/api/favorite", json={"deezer_id": "1", "on": False})
        self.assertEqual(self.app.deezer_prefetch.ids, [])

    def test_an_already_archived_track_is_not_queued_again(self):
        """Otherwise every star would cost a pointless trip through the download
        queue, and re-starring a 4000-track library would flood it."""
        self._login()
        self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        track = Track.get(Track.deezer_id == "1")
        os.makedirs(os.path.dirname(track.path), exist_ok=True)
        with open(track.path, "wb") as fh:
            fh.write(b"flac")

        self.app.deezer_prefetch.ids.clear()
        self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self.assertEqual(self.app.deezer_prefetch.ids, [])

    def test_creating_a_playlist_archives_its_tracks(self):
        self._login()
        self._create_playlist("PL", ["1", "2"])
        self.assertEqual(sorted(self.app.deezer_prefetch.ids), ["1", "2"])

    def test_adding_tracks_to_a_playlist_archives_them(self):
        self._login()
        pid = self._create_playlist("PL")["id"]
        self.app.deezer_prefetch.ids.clear()
        self.client.post(f"/api/playlist/{pid}/tracks", json={"tracks": ["1", "2"]})
        self.assertEqual(sorted(self.app.deezer_prefetch.ids), ["1", "2"])

    def test_removing_tracks_from_a_playlist_archives_nothing(self):
        self._login()
        pid = self._create_playlist("PL", ["1", "2"])["id"]
        self.app.deezer_prefetch.ids.clear()
        self.client.delete(f"/api/playlist/{pid}/tracks", json={"indexes": [0]})
        self.assertEqual(self.app.deezer_prefetch.ids, [])

    def test_favoriting_an_album_archives_the_whole_album(self):
        from supysonic.deezer import backfill

        thread = backfill.archive_entity(self.app, self.app.deezer, "album", "10")
        thread.join(timeout=5)
        # MockGW's full tracklist, not the 1-track album *page*.
        self.assertEqual(
            self.app.deezer_prefetch.ids, ["1", "2", "3", "4", "5"]
        )

    def test_favoriting_a_playlist_archives_the_whole_playlist(self):
        from supysonic.deezer import backfill

        thread = backfill.archive_entity(self.app, self.app.deezer, "playlist", "77")
        thread.join(timeout=5)
        self.assertEqual(self.app.deezer_prefetch.ids, ["1", "2", "3", "4", "5"])

    def test_favoriting_an_artist_archives_the_whole_discography(self):
        """Every track of every official release — and each one only once, even
        though gw lists the same record under several tabs/editions."""
        from supysonic.deezer import backfill

        thread = backfill.archive_entity(self.app, self.app.deezer, "artist", "9")
        thread.join(timeout=5)
        # Albums 10 and 11 (10 listed twice), 5 tracks each, same ids: one pass.
        self.assertEqual(self.app.deezer_prefetch.ids, ["1", "2", "3", "4", "5"])

    def test_an_unreadable_release_does_not_abort_the_discography(self):
        from supysonic.deezer import backfill

        real = self.app.deezer.get_album_tracks

        def flaky(alb_id):
            if str(alb_id) == "10":
                raise RuntimeError("gw hiccup")
            return real(alb_id)

        self.app.deezer.get_album_tracks = flaky
        thread = backfill.archive_entity(self.app, self.app.deezer, "artist", "9")
        thread.join(timeout=5)
        # Album 11 still got archived.
        self.assertEqual(self.app.deezer_prefetch.ids, ["1", "2", "3", "4", "5"])

    def test_a_full_queue_is_waited_out_not_dropped(self):
        """The queue holds a few thousand entries and a discography can be
        larger. The overflow must wait for room, never vanish."""
        from supysonic.deezer import backfill

        accepted = []
        room = [2]  # the queue takes 2 ids, then 2 more, …

        def picky(ids):
            ids = list(ids)[: room[0]]
            accepted.extend(ids)
            return len(ids)

        self.app.deezer_prefetch.download_ids = picky
        original_delay = backfill.QUEUE_RETRY_DELAY
        backfill.QUEUE_RETRY_DELAY = 0
        try:
            n = backfill._queue_all(self.app, ["1", "2", "3", "4", "5"], "test")
        finally:
            backfill.QUEUE_RETRY_DELAY = original_delay
        self.assertEqual(n, 5)
        self.assertEqual(accepted, ["1", "2", "3", "4", "5"])

    def test_a_full_queue_stops_waiting_when_archiving_is_turned_off(self):
        """Otherwise the feeder thread would spin forever on a switch its owner
        has already flipped."""
        from supysonic.deezer import backfill

        self.app.deezer_prefetch.download_ids = lambda ids: 0
        self.app.config["DEEZER"]["archive_library"] = False
        try:
            self.assertEqual(backfill._queue_all(self.app, ["1", "2"], "test"), 0)
        finally:
            self.app.config["DEEZER"]["archive_library"] = True

    def test_the_favorite_endpoint_triggers_the_entity_archive(self):
        from supysonic.deezer import backfill

        calls = []
        original = backfill.archive_entity
        backfill.archive_entity = lambda app, prov, kind, did: calls.append((kind, did))
        try:
            self._login()
            self.client.post("/api/favorite/album", json={"deezer_id": "10", "on": True})
            self.client.post("/api/favorite/playlist", json={"deezer_id": "7", "on": True})
            self.client.post("/api/favorite/artist", json={"deezer_id": "9", "on": True})
            # …and unfavoriting must not queue a download.
            self.client.post("/api/favorite/album", json={"deezer_id": "10", "on": False})
        finally:
            backfill.archive_entity = original
        self.assertEqual(
            calls, [("album", "10"), ("playlist", "7"), ("artist", "9")]
        )

    def test_archiving_can_be_turned_off_entirely(self):
        """`archive_library = no` must silence the events too, not just the
        nightly sweep — otherwise the setting is a lie."""
        self._login()
        self.app.config["DEEZER"]["archive_library"] = False
        try:
            self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
            self._create_playlist("PL", ["2"])
        finally:
            self.app.config["DEEZER"]["archive_library"] = True
        self.assertEqual(self.app.deezer_prefetch.ids, [])

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

    # -- podcast progress & markers --------------------------------------

    def _make_episode(self, duration=1800, with_file=False, deezer_id="555"):
        from supysonic.db import PodcastChannel, PodcastEpisode

        alice = User.get(name="alice")
        channel = PodcastChannel.create(
            user=alice, url="https://feed.example/x", title="Mon Show", deezer_id="99"
        )
        path = None
        if with_file:
            d = os.path.join(self.archive, "Podcasts", "Mon Show")
            os.makedirs(d, exist_ok=True)
            path = os.path.join(d, "ep.mp3")
            with open(path, "wb") as fh:
                fh.write(b"episodeaudio")
        episode = PodcastEpisode.create(
            channel=channel,
            title="Episode 1",
            duration=duration,
            deezer_id=deezer_id,
            path=path,
            status="completed" if with_file else "new",
        )
        return channel, episode

    def test_podcast_progress_roundtrip(self):
        from supysonic.db import PodcastEpisode

        self._login()
        _, ep = self._make_episode()
        rv = self.client.post(
            "/api/podcast/progress",
            json={"episode_id": str(ep.id), "position": 300, "duration": 1800},
        )
        self.assertEqual(rv.status_code, 200)
        self.assertFalse(rv.get_json()["finished"])

        data = self.client.get("/api/podcast/progress").get_json()["progress"]
        self.assertEqual(data[str(ep.id)]["position"], 300)
        self.assertEqual(data[str(ep.id)]["duration"], 1800)
        self.assertFalse(data[str(ep.id)]["finished"])
        # Admin position mirrors into the legacy offset + the Deezer bookmark.
        self.assertEqual(PodcastEpisode[ep.id].play_offset, 300)
        gw = self.app.deezer.dz.gw
        self.assertEqual(gw.episode_bookmarks, [("555", 300, 1800, False)])

        # A later save overwrites (upsert, no duplicate rows).
        self.client.post(
            "/api/podcast/progress",
            json={"episode_id": str(ep.id), "position": 400, "duration": 1800},
        )
        data = self.client.get("/api/podcast/progress").get_json()["progress"]
        self.assertEqual(data[str(ep.id)]["position"], 400)

    def test_podcast_progress_finish_near_end(self):
        from supysonic.db import PodcastEpisode

        self._login()
        _, ep = self._make_episode(duration=1000)
        rv = self.client.post(
            "/api/podcast/progress",
            json={"episode_id": str(ep.id), "position": 995, "duration": 1000},
        )
        self.assertTrue(rv.get_json()["finished"])
        data = self.client.get("/api/podcast/progress").get_json()["progress"]
        self.assertTrue(data[str(ep.id)]["finished"])
        # A finished episode clears the legacy resume offset.
        self.assertEqual(PodcastEpisode[ep.id].play_offset, 0)

    def test_podcast_progress_invalid(self):
        self._login()
        rv = self.client.post(
            "/api/podcast/progress", json={"episode_id": "junk", "position": 10}
        )
        self.assertEqual(rv.status_code, 404)
        _, ep = self._make_episode()
        rv = self.client.post(
            "/api/podcast/progress",
            json={"episode_id": str(ep.id), "position": "NaN"},
        )
        self.assertEqual(rv.status_code, 400)
        rv = self.client.post(
            "/api/podcast/progress",
            json={"episode_id": str(ep.id), "position": -5},
        )
        self.assertEqual(rv.status_code, 400)

    def test_podcast_markers_crud(self):
        self._login()
        channel, ep = self._make_episode()
        rv = self.client.post(
            "/api/podcast/episode/" + str(ep.id) + "/markers",
            json={"position": 125, "label": "Passage intéressant"},
        )
        self.assertEqual(rv.status_code, 200)
        marker = rv.get_json()["marker"]
        self.assertEqual(marker["position"], 125)
        self.assertEqual(marker["label"], "Passage intéressant")

        # Unlabelled marker; list comes back ordered by position.
        self.client.post(
            "/api/podcast/episode/" + str(ep.id) + "/markers", json={"position": 42}
        )
        lst = self.client.get(
            "/api/podcast/episode/" + str(ep.id) + "/markers"
        ).get_json()["markers"]
        self.assertEqual([m["position"] for m in lst], [42, 125])

        # The whole-show endpoint groups them by episode.
        grouped = self.client.get(
            "/api/podcast/" + str(channel.id) + "/markers"
        ).get_json()["markers"]
        self.assertEqual(len(grouped[str(ep.id)]), 2)

        rv = self.client.delete("/api/podcast/marker/" + marker["id"])
        self.assertEqual(rv.status_code, 204)
        lst = self.client.get(
            "/api/podcast/episode/" + str(ep.id) + "/markers"
        ).get_json()["markers"]
        self.assertEqual([m["position"] for m in lst], [42])

    def test_podcast_markers_are_private(self):
        self._login()
        _, ep = self._make_episode()
        rv = self.client.post(
            "/api/podcast/episode/" + str(ep.id) + "/markers", json={"position": 60}
        )
        mid = rv.get_json()["marker"]["id"]

        UserManager.add("carol", "C4rol", admin=False)
        self.client.post("/api/logout")
        self.client.post("/api/login", json={"username": "carol", "password": "C4rol"})
        # Another user sees no markers on the same episode…
        lst = self.client.get(
            "/api/podcast/episode/" + str(ep.id) + "/markers"
        ).get_json()["markers"]
        self.assertEqual(lst, [])
        # …and cannot delete someone else's marker.
        self.assertEqual(
            self.client.delete("/api/podcast/marker/" + mid).status_code, 404
        )

    def test_podcast_marker_invalid(self):
        self._login()
        _, ep = self._make_episode()
        rv = self.client.post(
            "/api/podcast/episode/" + str(ep.id) + "/markers", json={"position": -1}
        )
        self.assertEqual(rv.status_code, 400)
        rv = self.client.post(
            "/api/podcast/episode/deadbeef/markers", json={"position": 3}
        )
        self.assertEqual(rv.status_code, 404)

    # -- sharing ----------------------------------------------------------

    def test_share_requires_login(self):
        self.assertEqual(self.client.get("/api/share/file/1").status_code, 401)
        self.assertEqual(self.client.get("/api/share/waveform/1").status_code, 401)

    def test_share_file_local_track(self):
        self._login()
        t = self._make_local_track("Shared Song")
        rv = self.client.get("/api/share/file/" + str(t.id))
        self.assertEqual(rv.status_code, 200)
        disp = rv.headers.get("Content-Disposition", "")
        self.assertIn("attachment", disp)
        self.assertIn("Local Band - Shared Song.mp3", disp)
        self.assertEqual(rv.data, b"localaudio")

    def test_share_file_unknown_404(self):
        self._login()
        rv = self.client.get("/api/share/file/00000000-0000-0000-0000-000000000000")
        self.assertEqual(rv.status_code, 404)

    def test_share_waveform(self):
        from supysonic.webui import share

        self._login()
        t = self._make_local_track("Wave Song")
        calls = []
        orig_avail, orig_peaks = share._ffmpeg_available, share._audio_peaks

        def fake_peaks(path, buckets):
            calls.append((path, buckets))
            return [0.5] * buckets

        share._ffmpeg_available = lambda: True
        share._audio_peaks = fake_peaks
        try:
            rv = self.client.get("/api/share/waveform/" + str(t.id))
            self.assertEqual(rv.status_code, 200)
            data = rv.get_json()
            self.assertEqual(data["duration"], 180)
            self.assertEqual(len(data["peaks"]), 400)  # 180s * 2 < min bucket floor
            # Second call is served from the cache — no re-decode.
            rv = self.client.get("/api/share/waveform/" + str(t.id))
            self.assertEqual(rv.status_code, 200)
            self.assertEqual(len(calls), 1)
        finally:
            share._ffmpeg_available = orig_avail
            share._audio_peaks = orig_peaks

    def test_share_clip_validation(self):
        self._login()
        t = self._make_local_track("Clip Song")
        base = "/api/share/clip/" + str(t.id)
        self.assertEqual(self.client.get(base).status_code, 400)  # no range
        self.assertEqual(self.client.get(base + "?start=20&end=10").status_code, 400)
        self.assertEqual(self.client.get(base + "?start=-3&end=10").status_code, 400)
        self.assertEqual(self.client.get(base + "?start=0&end=9000").status_code, 400)
        self.assertEqual(
            self.client.get(base + "?start=0&end=10&fmt=wav").status_code, 400
        )
        # Start past the end of the track.
        self.assertEqual(self.client.get(base + "?start=500&end=520").status_code, 400)

    def test_share_clip(self):
        from supysonic.webui import share

        self._login()
        t = self._make_local_track("Clip Song")
        calls = []
        orig_avail, orig_gen = share._ffmpeg_available, share._clip_generator

        def fake_gen(path, start, length, codec_args):
            calls.append((start, length))
            yield b"clipdata"

        share._ffmpeg_available = lambda: True
        share._clip_generator = fake_gen
        try:
            rv = self.client.get(
                "/api/share/clip/" + str(t.id) + "?start=10&end=25&fmt=mp3"
            )
            self.assertEqual(rv.status_code, 200)
            self.assertEqual(rv.data, b"clipdata")
            disp = rv.headers.get("Content-Disposition", "")
            self.assertIn("attachment", disp)
            self.assertIn("0m10s-0m25s", disp)
            self.assertEqual(calls, [(10.0, 15.0)])
            # Cached: the same selection doesn't re-run ffmpeg.
            rv = self.client.get(
                "/api/share/clip/" + str(t.id) + "?start=10&end=25&fmt=mp3"
            )
            self.assertEqual(rv.status_code, 200)
            self.assertEqual(rv.data, b"clipdata")
            self.assertEqual(len(calls), 1)

            # AAC/m4a is offered too: distinct cache key, .m4a download name.
            rv = self.client.get(
                "/api/share/clip/" + str(t.id) + "?start=10&end=25&fmt=m4a"
            )
            self.assertEqual(rv.status_code, 200)
            self.assertEqual(rv.headers.get("Content-Type"), "audio/mp4")
            self.assertIn(".m4a", rv.headers.get("Content-Disposition", ""))
            self.assertEqual(len(calls), 2)  # a different format re-ran ffmpeg
        finally:
            share._ffmpeg_available = orig_avail
            share._clip_generator = orig_gen

    # -- SPA serving ----------------------------------------------------

    def test_spa_served(self):
        # Without a build -> friendly 503 notice, not a 404. With one (a
        # developer who ran `npm run build`, or the Docker image) -> the shell,
        # uncached so a redeploy is picked up.
        from supysonic.webui import spa

        rv = self.client.get("/app/")
        if spa._has_build():
            self.assertEqual(rv.status_code, 200)
            self.assertEqual(rv.headers["Cache-Control"], "no-cache")
        else:
            self.assertEqual(rv.status_code, 503)
            self.assertIn(b"not built", rv.data)

    # -- hardening -------------------------------------------------------

    def test_upload_name_keeps_non_latin_scripts(self):
        """secure_filename ASCII-folds, which erased a whole non-Latin name and
        took the extension with it — the file was then rejected as an
        unsupported format. Names must survive; paths must still be safe."""
        from supysonic.webui import _safe_upload_name

        self.assertEqual(_safe_upload_name("Песня.mp3"), ("Песня.mp3", "mp3"))
        self.assertEqual(_safe_upload_name("曲.flac"), ("曲.flac", "flac"))
        self.assertEqual(
            _safe_upload_name("Chanson française.mp3"), ("Chanson française.mp3", "mp3")
        )
        # …while still being a single, safe path component
        self.assertEqual(_safe_upload_name("../../etc/passwd.mp3"), ("passwd.mp3", "mp3"))
        self.assertEqual(_safe_upload_name("..\\..\\x.mp3"), ("x.mp3", "mp3"))
        self.assertEqual(_safe_upload_name(".hidden.flac"), ("hidden.flac", "flac"))
        self.assertEqual(_safe_upload_name("a\x00b.mp3"), ("a_b.mp3", "mp3"))
        self.assertEqual(_safe_upload_name("noext"), ("", ""))
        name, _ = _safe_upload_name("a" * 400 + ".opus")
        self.assertLessEqual(len(name.encode("utf-8")), 190)

    def test_archive_path_sanitizer_is_filesystem_safe(self):
        """Path components come from Deezer metadata and from uploaded files'
        own tags, so they must survive a NUL and an over-long name."""
        from supysonic.deezer.library import sanitize

        self.assertEqual(sanitize("a\x00b"), "ab")  # NUL would raise on every fs call
        self.assertEqual(sanitize(".."), "untitled")
        self.assertEqual(sanitize("../../etc"), "_.._etc")
        self.assertEqual(sanitize("a/b"), "a_b")
        self.assertEqual(sanitize("nul."), "nul")  # Windows drops trailing dots
        # 255 CJK characters is ~765 bytes: over every filesystem's limit.
        long_cjk = sanitize("曲" * 300)
        self.assertLessEqual(len(long_cjk.encode("utf-8")), 200)
        self.assertTrue(long_cjk.startswith("曲"))
        # and the cut never splits a multi-byte character
        long_cjk.encode("utf-8").decode("utf-8")

    def test_download_batch_is_capped_and_deduped(self):
        from supysonic.webui import _DOWNLOAD_BATCH_MAX

        self._login()
        queued = []
        self.app.deezer_prefetch.download_ids = lambda ids: queued.extend(ids) or len(ids)

        # duplicates collapse
        rv = self.client.post("/api/download", json={"ids": ["1", "1", "2"]})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(queued, ["1", "2"])

        # an oversized batch is capped rather than queueing a full FLAC download
        # per entry (the queue behind this is unbounded)
        queued.clear()
        huge = [str(i) for i in range(_DOWNLOAD_BATCH_MAX + 500)]
        rv = self.client.post("/api/download", json={"ids": huge})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(len(queued), _DOWNLOAD_BATCH_MAX)

        # junk is still rejected
        queued.clear()
        self.assertEqual(
            self.client.post("/api/download", json={"ids": ["abc", "../x"]}).status_code,
            400,
        )
        self.assertEqual(
            self.client.post("/api/download", json={"ids": "not-a-list"}).status_code, 400
        )

    # -- bulk ZIP export -------------------------------------------------

    def _playlist_with_local_track(self, title="Export Me"):
        from supysonic.db import Playlist

        t = self._make_local_track(title)
        from supysonic.db import User

        pl = Playlist.create(user=User.get(name="alice"), name="Ma sélection")
        pl.add(t)
        pl.save()
        return pl, t

    def test_export_requires_login(self):
        self.assertEqual(self.client.get("/api/export/favorites/me").status_code, 401)
        self.assertEqual(self.client.get("/api/export/formats").status_code, 401)

    def test_export_formats_lists_flac_without_ffmpeg(self):
        from supysonic.webui import export

        self._login()
        orig = export._ffmpeg_available
        export._ffmpeg_available = lambda: False
        try:
            body = self.client.get("/api/export/formats").get_json()
        finally:
            export._ffmpeg_available = orig
        ids = [f["id"] for f in body["formats"]]
        self.assertEqual(ids, ["flac"])  # only the no-re-encode format survives
        self.assertEqual(body["default"], "flac")

    def test_export_playlist_zip(self):
        import io
        import zipfile

        self._login()
        pl, _t = self._playlist_with_local_track("Export Me")
        rv = self.client.get("/api/export/playlist/%s?fmt=flac" % pl.id)
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.mimetype, "application/zip")
        self.assertIn("attachment", rv.headers["Content-Disposition"])

        z = zipfile.ZipFile(io.BytesIO(rv.data))
        self.assertIsNone(z.testzip())  # a valid, complete archive
        names = z.namelist()
        # `fmt=flac` means "copy the original, don't transcode", so the entry
        # keeps the SOURCE file's extension — this fixture's track is an mp3.
        # Naming every copied file .flac produced archives players refused to
        # open (and podcasts, which are mp3, made that obvious).
        self.assertIn("001 - Local Band - Export Me.mp3", names)
        self.assertIn("Ma sélection.m3u", names)
        self.assertEqual(z.read("001 - Local Band - Export Me.mp3"), b"localaudio")
        self.assertNotIn("_erreurs.txt", names)

    def test_export_rejects_bad_kind_and_format(self):
        self._login()
        self.assertEqual(self.client.get("/api/export/bogus/1").status_code, 400)
        self.assertEqual(
            self.client.get("/api/export/favorites/me?fmt=wav").status_code, 400
        )

    def test_export_unknown_playlist_404(self):
        self._login()
        rv = self.client.get(
            "/api/export/playlist/00000000-0000-0000-0000-000000000000?fmt=flac"
        )
        self.assertEqual(rv.status_code, 404)

    def test_export_empty_favorites_404(self):
        self._login()
        self.assertEqual(
            self.client.get("/api/export/favorites/me?fmt=flac").status_code, 404
        )

    def test_export_filename_is_sanitised(self):
        from supysonic.webui.export import _safe

        # path separators, traversal, and the trailing dot Windows drops
        self.assertEqual(_safe("../../etc/passwd"), "_.._etc_passwd")
        self.assertEqual(_safe(".."), "sans-titre")  # nothing left -> fallback
        self.assertEqual(_safe("nul."), "nul")
        self.assertEqual(_safe(""), "sans-titre")
        self.assertEqual(_safe("a" * 400), "a" * 120)

    def test_export_skips_a_failing_track_instead_of_aborting(self):
        import io
        import zipfile

        from supysonic.webui import export

        self._login()
        pl, _t = self._playlist_with_local_track("Export Me")
        orig = export._media_file
        export._media_file = lambda mid: (None, None, ("boom", 502))
        try:
            rv = self.client.get("/api/export/playlist/%s?fmt=flac" % pl.id)
            self.assertEqual(rv.status_code, 200)
            z = zipfile.ZipFile(io.BytesIO(rv.data))
            self.assertIsNone(z.testzip())
            self.assertIn("_erreurs.txt", z.namelist())
        finally:
            export._media_file = orig

    def test_export_slot_is_released_after_the_download(self):
        self._login()
        pl, _t = self._playlist_with_local_track("Export Me")
        url = "/api/export/playlist/%s?fmt=flac" % pl.id
        self.assertEqual(self.client.get(url).status_code, 200)
        # A second export must not be refused because the first held the slot.
        self.assertEqual(self.client.get(url).status_code, 200)




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


class MultiArtistTestCase(unittest.TestCase):
    """Multi-artist ("feat.") credits, from the three serializers to the wire."""

    def test_credit_list_from_gateway(self):
        from supysonic.webui import _credit_list

        # No ARTISTS (the trimmed favourites payload): the primary artist alone.
        # A serializer must ALWAYS hand the UI something to render, which is why
        # this falls back where library._credits deliberately doesn't.
        self.assertEqual(
            _credit_list(raw_track(1)),
            [{"deezer_id": "1", "name": "Artist", "role": "Main"}],
        )
        # A full list: label order (ARTISTS_SONGS_ORDER), ROLE_ID 0/5 mapped.
        raw = raw_track(1)
        raw["ARTISTS"] = [
            {"ART_ID": "3", "ART_NAME": "C", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "2"},
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        self.assertEqual([c["name"] for c in _credit_list(raw)], ["A", "B", "C"])
        self.assertEqual([c["role"] for c in _credit_list(raw)], ["Main", "Featured", "Featured"])
        # Hostile shapes never crash and never invent an id.
        self.assertEqual(_credit_list({}), [])
        self.assertEqual(_credit_list({"ARTISTS": [None, 5, {"ART_NAME": "no id"}]}), [])

    def test_display_artist_line(self):
        from supysonic.webui import _display_artist

        main = {"deezer_id": "1", "name": "A", "role": "Main"}
        feat = {"deezer_id": "2", "name": "B", "role": "Featured"}
        feat2 = {"deezer_id": "3", "name": "C", "role": "Featured"}
        self.assertEqual(_display_artist([main]), "A")
        self.assertEqual(_display_artist([main, feat]), "A feat. B")
        self.assertEqual(_display_artist([main, feat, feat2]), "A feat. B, C")
        self.assertEqual(_display_artist([main, dict(main, deezer_id="9", name="A2")]), "A, A2")
        # No Main at all (an unmapped ROLE_ID): list everyone rather than
        # promoting the first name and then repeating it after a "feat.".
        self.assertEqual(_display_artist([feat, feat2]), "B, C")
        self.assertEqual(_display_artist([], "Fallback"), "Fallback")

    def test_gateway_track_carries_credits(self):
        from supysonic.webui import _track

        raw = raw_track(1)
        raw["ARTISTS"] = [
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        out = _track(raw)
        # The classic single-artist field is untouched — every existing caller
        # (and every old cached client payload) keeps working.
        self.assertEqual(out["artist"], {"deezer_id": "1", "name": "Artist"})
        self.assertEqual([a["name"] for a in out["artists"]], ["A", "B"])
        self.assertEqual(out["display_artist"], "A feat. B")

    def test_public_api_track_maps_contributors(self):
        from supysonic.webui import _track_api

        out = _track_api(api_track(1))
        self.assertEqual([a["name"] for a in out["artists"]], ["Artist", "Guest"])
        self.assertEqual(out["display_artist"], "Artist feat. Guest")
        # A track with no contributors still exposes its single artist.
        bare = api_track(2)
        bare.pop("contributors")
        self.assertEqual(_track_api(bare)["artists"],
                         [{"deezer_id": "1", "name": "Artist", "role": "Main"}])
        self.assertEqual(_track_api(bare)["display_artist"], "Artist")


if __name__ == "__main__":
    unittest.main()

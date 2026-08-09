# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Offline tests for the Deezer-backed podcast support.

Covers the library upsert helpers, episode archiving, the podcast sync, and the
Subsonic ``/rest`` podcast endpoints (getPodcasts / getNewestPodcasts /
createPodcastChannel / delete* / downloadPodcastEpisode + episode streaming),
all with a mock Deezer provider — no network.
"""

import os
from datetime import timedelta
import shutil
import tempfile
import threading
import types
import unittest
from pathlib import Path

from supysonic.config import DefaultConfig
from supysonic.db import PodcastChannel, PodcastEpisode, User, release_database
from supysonic.deezer import archive, ids, library
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from .testbase import TestBase
from .api.apitestbase import ApiTestBase


def show_data(show_id="1002156761", name="Test Podcast"):
    return {
        "SHOW_ID": show_id,
        "SHOW_NAME": name,
        "SHOW_DESCRIPTION": "A test podcast description.",
        "SHOW_ART_MD5": "showmd5",
        "SHOW_IS_DIRECT_STREAM": "1",
    }


def episode_obj(eid, title="Episode", ts=1782660730, url="https://host.example/ep.mp3"):
    return {
        "EPISODE_ID": str(eid),
        "EPISODE_TITLE": title,
        "EPISODE_DESCRIPTION": "Episode description.",
        "DURATION": 120,
        "EPISODE_DIRECT_STREAM_URL": url,
        "EPISODE_IMAGE_MD5": "epmd5",
        "EPISODE_PUBLISHED_TS": ts,
        "AVAILABLE": True,
        "SHOW_ID": "1002156761",
        "SHOW_NAME": "Test Podcast",
        "SHOW_ART_MD5": "showmd5",
    }


class MockPublicApi:
    def __init__(self, episode_to_show, search_results=None):
        self._episode_to_show = episode_to_show
        self._search_results = search_results or []

    def get_episode(self, episode_id):
        return {"podcast": {"id": self._episode_to_show.get(str(episode_id))}}

    def search_podcast(self, query, limit=25):
        return {"data": self._search_results[:limit]}

    # The combined /api/search also probes these; the mock only cares about
    # podcasts, so the rest come back empty.
    def search(self, query, limit=25):
        return {"data": []}

    def search_album(self, query, limit=25):
        return {"data": []}

    def search_artist(self, query, limit=25):
        return {"data": []}

    def search_playlist(self, query, limit=25):
        return {"data": []}


class MockProvider:
    """Enough of DeezerProvider for the podcast code paths, fully offline."""

    def __init__(self, archive_dir, shows, favorite_show_ids=None, search_results=None):
        self.archive_dir = archive_dir
        self.default_quality = "MP3_128"
        # shows: {show_id: (data_dict, [episode_objs])}
        self.shows = {str(k): v for k, v in shows.items()}
        self.favorite_show_ids = [str(s) for s in (favorite_show_ids or [])]
        self.fav_added = []
        self.fav_removed = []
        self.downloaded = []
        self.streamed = []
        self._locks = {}
        episode_to_show = {
            e["EPISODE_ID"]: sid
            for sid, (_d, eps) in self.shows.items()
            for e in eps
        }
        self.dz = types.SimpleNamespace(
            api=MockPublicApi(episode_to_show, search_results)
        )

    def get_user_shows(self):
        return [
            {"SHOW_ID": sid, "SHOW_NAME": self.shows[sid][0]["SHOW_NAME"]}
            for sid in self.favorite_show_ids
            if sid in self.shows
        ]

    def search_podcasts(self, query, limit=25):
        return self.dz.api.search_podcast(query, limit=limit)["data"]

    def get_show_page(self, show_id, nb=40, start=0):
        data, eps = self.shows[str(show_id)]
        return {
            "DATA": data,
            "FAVORITE_STATUS": True,
            "EPISODES": {
                "data": eps[start : start + nb],
                "total": len(eps),
                "count": len(eps),
            },
        }

    def get_show_episodes(self, show_id):
        return list(self.shows[str(show_id)][1])

    def add_favorite_show(self, show_id):
        self.fav_added.append(str(show_id))

    def remove_favorite_show(self, show_id):
        self.fav_removed.append(str(show_id))

    def track_lock(self, key):
        return self._locks.setdefault(key, threading.Lock())

    def resolve_episode(self, episode):
        if not episode.stream_url:
            raise RuntimeError("no stream url")
        return episode.stream_url

    def iter_episode(self, url):
        self.streamed.append(url)
        yield b"ID3"
        yield b"fakeaudio" * 200

    def download_episode_to(self, url, dest):
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as fh:
            for chunk in self.iter_episode(url):
                fh.write(chunk)
        self.downloaded.append((url, str(dest)))


# -- library / archive / importer (no Flask) -----------------------------


class PodcastLibraryTestCase(TestBase):
    def setUp(self):
        super().setUp()
        self.archive_dir = tempfile.mkdtemp()
        self.user = User.get(name="alice")

    def tearDown(self):
        shutil.rmtree(self.archive_dir, ignore_errors=True)
        super().tearDown()

    def test_ids_deterministic_and_distinct(self):
        self.assertEqual(ids.show_uuid("5"), ids.show_uuid("5"))
        self.assertNotEqual(ids.show_uuid("5"), ids.episode_uuid("5"))
        self.assertNotEqual(ids.show_uuid("5"), ids.show_uuid("6"))

    def test_upsert_channel_and_episode(self):
        channel = library.upsert_channel(self.user, library.normalize_show(show_data()))
        self.assertEqual(channel.id, ids.show_uuid("1002156761"))
        self.assertEqual(channel.deezer_id, "1002156761")
        self.assertEqual(channel.title, "Test Podcast")
        self.assertEqual(channel.cover_art_md5, "showmd5")
        self.assertTrue(channel.url.endswith("/show/1002156761"))

        ep = library.upsert_episode(
            channel, library.normalize_episode(episode_obj("897955951"))
        )
        self.assertEqual(ep.id, ids.episode_uuid("897955951"))
        self.assertEqual(ep.deezer_id, "897955951")
        self.assertEqual(ep.status, "new")
        self.assertIsNone(ep.path)
        self.assertEqual(ep.stream_url, "https://host.example/ep.mp3")
        self.assertIsNotNone(ep.publish_date)

        # Idempotent: re-upsert refreshes metadata, no duplicate row.
        ep2 = library.upsert_episode(
            channel,
            library.normalize_episode(episode_obj("897955951", title="Renamed")),
        )
        self.assertEqual(ep2.id, ep.id)
        self.assertEqual(ep2.title, "Renamed")
        self.assertEqual(PodcastEpisode.select().count(), 1)

    def test_import_show_paginates_episodes(self):
        eps = [episode_obj(i, f"Ep {i}") for i in range(1, 6)]
        provider = MockProvider(self.archive_dir, {"1002156761": (show_data(), eps)})
        channel = archive.import_show(provider, self.user, "1002156761")
        self.assertEqual(channel.episodes.count(), 5)

    def test_ensure_episode_archived(self):
        provider = MockProvider(
            self.archive_dir,
            {"1002156761": (show_data(), [episode_obj("897955951")])},
        )
        archive.import_show(provider, self.user, "1002156761")
        episode = PodcastEpisode[ids.episode_uuid("897955951")]

        archive.ensure_episode_archived(provider, episode)
        episode = PodcastEpisode[episode.id]
        self.assertEqual(episode.status, "completed")
        self.assertTrue(episode.path.endswith(".mp3"))
        self.assertTrue(os.path.isfile(episode.path))
        self.assertIn("Podcasts", episode.path)
        self.assertGreater(episode.bitrate, 0)
        self.assertEqual(len(provider.downloaded), 1)

        # Idempotent: already on disk, no second download.
        archive.ensure_episode_archived(provider, episode)
        self.assertEqual(len(provider.downloaded), 1)

    def test_ensure_episode_archived_marks_error(self):
        provider = MockProvider(
            self.archive_dir,
            {"1002156761": (show_data(), [episode_obj("897955951", url=None)])},
        )
        # url=None -> resolve_episode raises; stream_url stored as None.
        archive.import_show(provider, self.user, "1002156761")
        episode = PodcastEpisode[ids.episode_uuid("897955951")]
        with self.assertRaises(Exception):
            archive.ensure_episode_archived(provider, episode)
        episode = PodcastEpisode[episode.id]
        self.assertEqual(episode.status, "error")

    def test_sync_podcasts_refreshes_known_channels(self):
        from supysonic.deezer.importer import DeezerImporter

        # Pre-existing subscription (channel row), no episodes yet.
        library.upsert_channel(self.user, library.normalize_show(show_data()))
        eps = [episode_obj(i, f"Ep {i}") for i in range(1, 4)]
        provider = MockProvider(self.archive_dir, {"1002156761": (show_data(), eps)})

        importer = DeezerImporter(provider, "alice")
        n = importer.sync_podcasts(episode_limit=30)
        self.assertEqual(n, 1)
        self.assertEqual(
            PodcastChannel[ids.show_uuid("1002156761")].episodes.count(), 3
        )

    def test_sync_podcasts_imports_deezer_favorites(self):
        # A show favorited on Deezer (no local row yet) is imported by sync,
        # closing the "list my favorite shows" gap.
        from supysonic.deezer.importer import DeezerImporter

        eps = [episode_obj(i, f"Ep {i}") for i in range(1, 3)]
        provider = MockProvider(
            self.archive_dir,
            {"1002156761": (show_data(), eps)},
            favorite_show_ids=["1002156761"],
        )
        self.assertEqual(PodcastChannel.select().count(), 0)
        importer = DeezerImporter(provider, "alice")
        n = importer.sync_podcasts(episode_limit=30)
        self.assertEqual(n, 1)
        self.assertEqual(PodcastChannel.select().count(), 1)
        self.assertEqual(PodcastEpisode.select().count(), 2)

    def test_parse_deezer_ref_show_and_episode(self):
        self.assertEqual(
            archive.parse_deezer_ref("https://www.deezer.com/en/show/123"),
            ("show", "123"),
        )
        self.assertEqual(
            archive.parse_deezer_ref("episode 456"), ("episode", "456")
        )


# -- Subsonic /rest endpoints --------------------------------------------


class PodcastApiTestCase(ApiTestBase):
    def setUp(self):
        # Validate against the 1.16.0 schema which defines the podcast types.
        super().setUp(apiVersion="1.16.0")
        self.archive_dir = tempfile.mkdtemp()
        eps = [episode_obj(i, f"Ep {i}", ts=1782660730 + i) for i in range(1, 4)]
        self.provider = MockProvider(
            self.archive_dir, {"1002156761": (show_data(), eps)}
        )
        app = self.client.application
        app.deezer = self.provider
        app.config["DEEZER"] = dict(app.config["DEEZER"])
        app.config["DEEZER"].update(
            {"sync_user": "alice", "push_to_deezer": True, "podcast_episodes": 30}
        )

    def tearDown(self):
        shutil.rmtree(self.archive_dir, ignore_errors=True)
        super().tearDown()

    def _create_channel(self):
        self._make_request(
            "createPodcastChannel",
            {"url": "https://www.deezer.com/show/1002156761"},
        )

    def test_create_and_get_podcasts(self):
        self._create_channel()
        self.assertIn("1002156761", self.provider.fav_added)

        _, child = self._make_request("getPodcasts", tag="podcasts")
        channels = self._xpath(child, "./channel")
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0].get("title"), "Test Podcast")
        self.assertEqual(channels[0].get("status"), "completed")
        episodes = self._xpath(channels[0], "./episode")
        self.assertEqual(len(episodes), 3)
        self.assertEqual(episodes[0].get("status"), "new")
        self.assertEqual(episodes[0].get("channelId"), str(ids.show_uuid("1002156761")))

    def test_get_podcasts_without_episodes(self):
        self._create_channel()
        _, child = self._make_request(
            "getPodcasts", {"includeEpisodes": "false"}, tag="podcasts"
        )
        channel = self._xpath(child, "./channel")[0]
        self.assertEqual(len(self._xpath(channel, "./episode")), 0)

    def test_get_newest_podcasts(self):
        self._create_channel()
        _, child = self._make_request(
            "getNewestPodcasts", {"count": "2"}, tag="newestPodcasts"
        )
        episodes = self._xpath(child, "./episode")
        self.assertEqual(len(episodes), 2)
        # Newest first (highest publish ts = Ep 3).
        self.assertEqual(episodes[0].get("title"), "Ep 3")

    def test_create_requires_admin(self):
        self._make_request(
            "createPodcastChannel",
            {"u": "bob", "p": "B0b", "url": "https://www.deezer.com/show/1002156761"},
            error=50,
        )

    def test_download_and_stream_episode(self):
        self._create_channel()
        eid = str(ids.episode_uuid("1"))

        # Trigger the server-side archive.
        self._make_request("downloadPodcastEpisode", {"id": eid})
        episode = PodcastEpisode[ids.episode_uuid("1")]
        self.assertEqual(episode.status, "completed")
        self.assertTrue(os.path.isfile(episode.path))

        # Stream returns the archived bytes.
        rv = self.client.get(
            "/rest/stream.view",
            query_string={
                "u": "alice",
                "p": "Alic3",
                "c": "tests",
                "v": self.apiVersion,
                "id": eid,
            },
        )
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.data.startswith(b"ID3"))

    def test_stream_archives_on_first_play(self):
        self._create_channel()
        eid = str(ids.episode_uuid("2"))
        episode = PodcastEpisode[ids.episode_uuid("2")]
        self.assertIsNone(episode.path)

        rv = self.client.get(
            "/rest/stream.view",
            query_string={
                "u": "alice",
                "p": "Alic3",
                "c": "tests",
                "v": self.apiVersion,
                "id": eid,
            },
        )
        self.assertEqual(rv.status_code, 200)
        episode = PodcastEpisode[ids.episode_uuid("2")]
        self.assertEqual(episode.status, "completed")

    def test_deleting_never_destroys_an_archived_episode(self):
        """An archived episode is the copy that survives the show leaving
        Deezer, so neither endpoint may delete it. `deletePodcastEpisode`
        reports success without touching the file, and unsubscribing keeps the
        channel — flagged unsubscribed — with all its audio."""
        self._create_channel()
        eid = str(ids.episode_uuid("1"))
        self._make_request("downloadPodcastEpisode", {"id": eid})
        path = PodcastEpisode[ids.episode_uuid("1")].path
        self.assertTrue(os.path.isfile(path))

        self._make_request("deletePodcastEpisode", {"id": eid})
        episode = PodcastEpisode[ids.episode_uuid("1")]
        self.assertEqual(episode.path, path)
        self.assertTrue(os.path.isfile(path))

        cid = str(ids.show_uuid("1002156761"))
        self._make_request("deletePodcastChannel", {"id": cid}, skip_post=True)
        # The Deezer subscription is dropped…
        self.assertIn("1002156761", self.provider.fav_removed)
        # …but nothing of ours is.
        channel = PodcastChannel[ids.show_uuid("1002156761")]
        self.assertFalse(channel.subscribed)
        self.assertEqual(PodcastEpisode.select().count(), 3)
        self.assertTrue(os.path.isfile(path))

    def test_a_show_that_leaves_deezer_becomes_a_local_podcast(self):
        """The whole show delisted — not one episode. Everything archived must
        stay listed, playable and complete, served from disk, and the sync must
        stop pestering Deezer about it."""
        from supysonic.deezer.importer import DeezerImporter
        from supysonic.deezer.provider import ShowUnavailable

        self._create_channel()
        eid = str(ids.episode_uuid("1"))
        self._make_request("downloadPodcastEpisode", {"id": eid})
        path = PodcastEpisode[ids.episode_uuid("1")].path
        self.assertTrue(os.path.isfile(path))

        # Deezer now answers "no such show" for everything about it.
        def gone(show_id, nb=40, start=0):
            raise ShowUnavailable("no such show")

        self.provider.get_show_page = gone
        self.provider.get_show_episodes = gone
        self.provider.favorite_show_ids = []

        importer = DeezerImporter(self.provider, "alice")
        importer.sync_podcasts(episode_limit=30)

        channel = PodcastChannel[ids.show_uuid("1002156761")]
        self.assertIsNotNone(channel.gone)
        # Nothing was destroyed: the episodes and the audio are all still there.
        self.assertEqual(PodcastEpisode.select().count(), 3)
        self.assertTrue(os.path.isfile(path))

        # A second sync leaves it alone rather than asking Deezer again.
        asked = []
        self.provider.get_show_page = lambda *a, **k: asked.append(a) or gone(*a, **k)
        importer.sync_podcasts(episode_limit=30)
        self.assertEqual(asked, [])

        # And it still plays, straight from the archive.
        rv = self.client.get(
            "/rest/stream.view",
            query_string={
                "u": "alice", "p": "Alic3", "c": "tests",
                "v": self.apiVersion, "id": eid,
            },
        )
        self.assertEqual(rv.status_code, 200)

    def test_a_show_that_comes_back_is_no_longer_local(self):
        from supysonic.deezer.importer import DeezerImporter
        from supysonic.db import now

        self._create_channel()
        channel = PodcastChannel[ids.show_uuid("1002156761")]
        channel.gone = now()
        channel.save()

        # The verdict is stale, so the sync re-tests it — and Deezer answers.
        channel.gone = now() - timedelta(days=30)
        channel.save()
        DeezerImporter(self.provider, "alice").sync_podcasts(episode_limit=30)
        self.assertIsNone(PodcastChannel[ids.show_uuid("1002156761")].gone)

    def test_unsubscribing_removes_a_show_with_nothing_archived(self):
        """Nothing on disk means nothing to protect: the row goes, as before."""
        self._create_channel()
        cid = str(ids.show_uuid("1002156761"))
        self._make_request("deletePodcastChannel", {"id": cid}, skip_post=True)
        self.assertEqual(PodcastChannel.select().count(), 0)
        self.assertEqual(PodcastEpisode.select().count(), 0)

    def test_refresh_podcasts(self):
        self._create_channel()
        # Drop episodes so a refresh visibly re-imports them.
        PodcastEpisode.delete().execute()
        self.assertEqual(PodcastEpisode.select().count(), 0)
        self._make_request("refreshPodcasts")
        self.assertEqual(PodcastEpisode.select().count(), 3)


# -- web UI /api endpoints ------------------------------------------------


class PodcastWebUITestCase(unittest.TestCase):
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
        UserManager.add("alice", "Alic3", admin=True)

        eps = [episode_obj(i, f"Ep {i}", ts=1782660730 + i) for i in range(1, 4)]
        self.provider = MockProvider(self.archive, {"1002156761": (show_data(), eps)})
        self.app.deezer = self.provider
        self.app.config["DEEZER"] = dict(self.app.config["DEEZER"])
        self.app.config["DEEZER"].update(
            {"sync_user": "alice", "push_to_deezer": True, "podcast_episodes": 30}
        )
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

    def _subscribe(self):
        return self.client.post(
            "/api/podcasts", json={"url": "https://www.deezer.com/show/1002156761"}
        )

    def test_requires_login(self):
        self.assertEqual(self.client.get("/api/podcasts").status_code, 401)

    def test_subscribe_list_and_get(self):
        self._login()
        rv = self._subscribe()
        self.assertEqual(rv.status_code, 200)
        self.assertIn("1002156761", self.provider.fav_added)
        body = rv.get_json()
        self.assertEqual(body["title"], "Test Podcast")
        self.assertEqual(len(body["episodes"]), 3)

        lst = self.client.get("/api/podcasts").get_json()["podcasts"]
        self.assertEqual(len(lst), 1)
        self.assertEqual(lst[0]["episode_count"], 3)

        cid = str(ids.show_uuid("1002156761"))
        detail = self.client.get("/api/podcast/" + cid).get_json()
        self.assertEqual(len(detail["episodes"]), 3)
        # Episodes are playable "tracks": their stream id is the episode UUID.
        ep = detail["episodes"][0]
        self.assertTrue(ep["podcast"])
        self.assertEqual(ep["deezer_id"], str(ids.episode_uuid("3")))

    def test_stream_archives_episode(self):
        self._login()
        self._subscribe()
        eid = str(ids.episode_uuid("1"))
        rv = self.client.get("/api/stream/" + eid)
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.data.startswith(b"ID3"))
        self.assertEqual(PodcastEpisode[ids.episode_uuid("1")].status, "completed")

    def test_stream_starts_before_the_episode_is_archived(self):
        # The whole point of the live path: a long episode must start playing
        # without waiting for the full download. Assert on the ORDER — the
        # response is handed back, and the archive is only published once the
        # body has been consumed.
        self._login()
        self._subscribe()
        eid = str(ids.episode_uuid("1"))
        episode = PodcastEpisode[ids.episode_uuid("1")]
        self.assertIsNone(episode.path)

        rv = self.client.get("/api/stream/" + eid)
        self.assertEqual(rv.status_code, 200)
        # Nothing has been read yet, so nothing can have been archived.
        self.assertIsNone(PodcastEpisode[ids.episode_uuid("1")].path)

        body = rv.get_data()
        self.assertTrue(body.startswith(b"ID3"))
        fresh = PodcastEpisode[ids.episode_uuid("1")]
        self.assertEqual(fresh.status, "completed")
        self.assertTrue(os.path.isfile(fresh.path))
        # And the bytes that were streamed are the bytes that got archived.
        with open(fresh.path, "rb") as fh:
            self.assertEqual(fh.read(), body)

    def test_second_play_is_served_from_the_archive(self):
        self._login()
        self._subscribe()
        eid = str(ids.episode_uuid("1"))
        self.client.get("/api/stream/" + eid).get_data()
        before = len(self.provider.streamed)

        rv = self.client.get("/api/stream/" + eid)
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(rv.get_data().startswith(b"ID3"))
        # Served from disk — the podcast host is not hit again.
        self.assertEqual(len(self.provider.streamed), before)
        # And it is seekable now, unlike the first live play.
        self.assertEqual(rv.headers.get("Accept-Ranges"), "bytes")

    def test_export_show_as_zip(self):
        # Same bulk export a playlist gets, for a show: every episode archived
        # on demand and streamed into one ZIP.
        import io
        import zipfile

        self._login()
        self._subscribe()
        cid = str(ids.show_uuid("1002156761"))
        rv = self.client.get("/api/export/podcast/" + cid + "?fmt=flac")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.mimetype, "application/zip")

        zf = zipfile.ZipFile(io.BytesIO(rv.get_data()))
        names = zf.namelist()
        # One entry per episode, plus the playlist file the exporter writes.
        self.assertEqual(len([n for n in names if n.endswith(".mp3")]), 3)
        self.assertTrue(any(n.endswith(".m3u") for n in names))
        self.assertNotIn("_erreurs.txt", names)
        first = [n for n in names if n.endswith(".mp3")][0]
        self.assertTrue(zf.read(first).startswith(b"ID3"))

    def test_export_rejects_an_unknown_kind(self):
        self._login()
        self._subscribe()
        rv = self.client.get("/api/export/nope/" + str(ids.show_uuid("1002156761")))
        self.assertEqual(rv.status_code, 400)

    def test_export_unknown_show_is_404(self):
        self._login()
        self._subscribe()
        rv = self.client.get("/api/export/podcast/" + str(ids.show_uuid("999")) + "?fmt=flac")
        self.assertEqual(rv.status_code, 404)

    def test_unsubscribe(self):
        self._login()
        self._subscribe()
        cid = str(ids.show_uuid("1002156761"))
        rv = self.client.delete("/api/podcast/" + cid)
        self.assertEqual(rv.status_code, 204)
        self.assertIn("1002156761", self.provider.fav_removed)
        self.assertEqual(PodcastChannel.select().count(), 0)

    def test_subscribe_requires_admin(self):
        UserManager.add("bob", "B0b")
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        rv = self._subscribe()
        self.assertEqual(rv.status_code, 403)

    def test_search_podcasts(self):
        self._login()
        self.provider.dz.api._search_results = [
            {
                "id": 42,
                "title": "Found Cast",
                "description": "d",
                "picture_xl": "http://img/xl.jpg",
                "nb_fan": 10,
            }
        ]
        r = self.client.get("/api/search/podcasts?q=found").get_json()
        self.assertEqual(len(r["podcasts"]), 1)
        self.assertEqual(r["podcasts"][0]["deezer_id"], "42")
        self.assertEqual(r["podcasts"][0]["cover"], "http://img/xl.jpg")

        # Also surfaced in the combined search (other sections just come back
        # empty since the mock only implements podcast search).
        r2 = self.client.get("/api/search?q=found").get_json()
        self.assertTrue(any(p["deezer_id"] == "42" for p in r2["podcasts"]))

    def test_search_podcasts_empty_query(self):
        self._login()
        r = self.client.get("/api/search/podcasts?q=").get_json()
        self.assertEqual(r["podcasts"], [])

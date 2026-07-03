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
import shutil
import tempfile
import threading
import types
from pathlib import Path

from supysonic.db import PodcastChannel, PodcastEpisode, User
from supysonic.deezer import archive, ids, library

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
    def __init__(self, episode_to_show):
        self._episode_to_show = episode_to_show

    def get_episode(self, episode_id):
        return {"podcast": {"id": self._episode_to_show.get(str(episode_id))}}


class MockProvider:
    """Enough of DeezerProvider for the podcast code paths, fully offline."""

    def __init__(self, archive_dir, shows):
        self.archive_dir = archive_dir
        self.default_quality = "MP3_128"
        # shows: {show_id: (data_dict, [episode_objs])}
        self.shows = {str(k): v for k, v in shows.items()}
        self.fav_added = []
        self.fav_removed = []
        self.downloaded = []
        self._locks = {}
        episode_to_show = {
            e["EPISODE_ID"]: sid
            for sid, (_d, eps) in self.shows.items()
            for e in eps
        }
        self.dz = types.SimpleNamespace(api=MockPublicApi(episode_to_show))

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

    def download_episode_to(self, url, dest):
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"ID3" + b"fakeaudio" * 200)
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

    def test_delete_episode_then_channel(self):
        self._create_channel()
        eid = str(ids.episode_uuid("1"))
        self._make_request("downloadPodcastEpisode", {"id": eid})
        path = PodcastEpisode[ids.episode_uuid("1")].path

        self._make_request("deletePodcastEpisode", {"id": eid})
        episode = PodcastEpisode[ids.episode_uuid("1")]
        self.assertEqual(episode.status, "deleted")
        self.assertIsNone(episode.path)
        self.assertFalse(os.path.isfile(path))

        cid = str(ids.show_uuid("1002156761"))
        # GET deletes the row; a follow-up POST would 404, so skip it.
        self._make_request("deletePodcastChannel", {"id": cid}, skip_post=True)
        self.assertIn("1002156761", self.provider.fav_removed)
        self.assertEqual(PodcastChannel.select().count(), 0)
        self.assertEqual(PodcastEpisode.select().count(), 0)

    def test_refresh_podcasts(self):
        self._create_channel()
        # Drop episodes so a refresh visibly re-imports them.
        PodcastEpisode.delete().execute()
        self.assertEqual(PodcastEpisode.select().count(), 0)
        self._make_request("refreshPodcasts")
        self.assertEqual(PodcastEpisode.select().count(), 3)

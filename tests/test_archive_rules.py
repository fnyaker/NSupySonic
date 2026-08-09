# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Archive rules, and the cleanup they authorise.

The cleanup is the only code in the project that deletes archived audio, so
most of what follows is about what it must REFUSE to touch. A bug here doesn't
show up as a failure — it shows up as a library that quietly got smaller.
"""

import os
import os.path
import shutil
import tempfile
import unittest
from datetime import timedelta

from supysonic.config import DefaultConfig
from supysonic.db import (
    Playlist,
    PlaylistTrack,
    StarredTrack,
    Track,
    User,
    now,
    release_database,
)
from supysonic.deezer import cleanup, rules
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from .test_webui import MockDz, MockPrefetch


class RulesTestBase(unittest.TestCase):
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

        from supysonic.deezer.provider import DeezerProvider

        provider = DeezerProvider("arl", self.archive, "FLAC")
        provider._dz = MockDz()
        self.app.deezer = provider
        self.app.deezer_prefetch = MockPrefetch()
        self.app.config["DEEZER"]["archive_dir"] = self.archive
        self.client = self.app.test_client()
        rules.invalidate()
        rules.CACHE_TTL = 0  # settings change constantly in here

    def tearDown(self):
        rules.CACHE_TTL = 1.0
        rules.invalidate()
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    def _login(self):
        return self.client.post(
            "/api/login", json={"username": "alice", "password": "Alic3"}
        )

    def _track(self, deezer_id="1", *, archived=True, size=1024, played=None, plays=0):
        """A Deezer track row, optionally with a real file behind it."""
        from supysonic.deezer import archive as archive_mod

        track = archive_mod.import_track(self.app.deezer, deezer_id)
        if archived:
            os.makedirs(os.path.dirname(track.path), exist_ok=True)
            with open(track.path, "wb") as fh:
                fh.write(b"\0" * size)
            track.last_modification = 1
        track.last_play = played
        track.play_count = plays
        track.save()
        return track


class RulesStorageTestCase(RulesTestBase):
    def test_defaults_apply_when_nothing_is_stored(self):
        loaded = rules.load(self.app)
        for key, value in rules.DEFAULTS.items():
            self.assertEqual(loaded[key], value, key)

    def test_a_saved_rule_survives_a_reload(self):
        rules.save({"on_fav_album": False, "artist_limit": 12})
        rules.invalidate()
        loaded = rules.load(self.app)
        self.assertFalse(loaded["on_fav_album"])
        self.assertEqual(loaded["artist_limit"], 12)

    def test_junk_is_ignored_rather_than_stored(self):
        """A form post with one stale field must not throw away the rest."""
        written = rules.save(
            {"artist_scope": "nonsense", "on_fav_track": False, "not_a_rule": 1}
        )
        self.assertEqual(written, {"on_fav_track": False})
        self.assertEqual(rules.load(self.app)["artist_scope"], "all")

    def test_values_are_clamped(self):
        """A typo in the staleness window is how you wipe a library."""
        rules.save({"clean_stale_days": 1, "artist_limit": 99999})
        loaded = rules.load(self.app)
        self.assertEqual(loaded["clean_stale_days"], 7)
        self.assertEqual(loaded["artist_limit"], 1000)

    def test_the_config_file_is_the_fallback_and_the_db_wins(self):
        self.app.config["DEEZER"]["artist_limit"] = 3
        rules.invalidate()
        self.assertEqual(rules.load(self.app)["artist_limit"], 3)
        rules.save({"artist_limit": 7})
        self.assertEqual(rules.load(self.app)["artist_limit"], 7)

    def test_the_master_switch_overrides_every_event(self):
        self.app.config["DEEZER"]["archive_library"] = False
        try:
            self.assertFalse(rules.enabled(self.app, "on_fav_track"))
        finally:
            self.app.config["DEEZER"]["archive_library"] = True
        self.assertTrue(rules.enabled(self.app, "on_fav_track"))

    def test_endpoints_are_admin_only(self):
        UserManager.add("bob", "B0b")
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        for path in (
            "/api/archive/rules",
            "/api/archive/cleanup/preview",
        ):
            self.assertEqual(self.client.get(path).status_code, 403, path)
        self.assertEqual(
            self.client.post("/api/archive/rules", json={}).status_code, 403
        )
        self.assertEqual(self.client.post("/api/archive/cleanup").status_code, 403)

    def test_the_rules_endpoint_round_trips(self):
        self._login()
        body = self.client.get("/api/archive/rules").get_json()
        self.assertIn("on_fav_track", body["events"])
        self.assertEqual(body["rules"]["artist_scope"], "all")

        rv = self.client.post(
            "/api/archive/rules", json={"artist_scope": "top", "artist_limit": 15}
        )
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["rules"]["artist_scope"], "top")
        self.assertEqual(
            self.client.get("/api/archive/rules").get_json()["rules"]["artist_limit"], 15
        )


class EventRulesTestCase(RulesTestBase):
    def test_turning_an_event_off_stops_that_archiving(self):
        self._login()
        rules.save({"on_fav_track": False})
        self.client.post("/api/favorite", json={"deezer_id": "1", "on": True})
        self.assertEqual(self.app.deezer_prefetch.ids, [])

        # …and only that one: the others still fire.
        rules.save({"on_fav_track": True})
        self.client.post("/api/favorite", json={"deezer_id": "2", "on": True})
        self.assertEqual(self.app.deezer_prefetch.ids, ["2"])

    def test_each_favourite_kind_has_its_own_switch(self):
        from supysonic.deezer import backfill

        rules.save({"on_fav_album": False})
        self.assertIsNone(
            backfill.archive_entity(self.app, self.app.deezer, "album", "10")
        )
        thread = backfill.archive_entity(self.app, self.app.deezer, "playlist", "7")
        self.assertIsNotNone(thread)
        thread.join(timeout=5)
        self.assertEqual(self.app.deezer_prefetch.ids, ["1", "2", "3", "4", "5"])

    def test_artist_scope_releases_takes_the_most_recent_n(self):
        from supysonic.deezer import backfill

        rules.save({"artist_scope": "releases", "artist_limit": 1})
        thread = backfill.archive_entity(self.app, self.app.deezer, "artist", "9")
        thread.join(timeout=5)
        # Album 11 is the 2021 release; 10 is 2020. One release means only 11.
        self.assertEqual(self.app.deezer_prefetch.ids, ["1", "2", "3", "4", "5"])
        self.assertEqual(self.app.deezer.dz.gw.taken_albums, ["11"])

    def test_artist_scope_top_takes_tracks_not_releases(self):
        from supysonic.deezer import backfill

        rules.save({"artist_scope": "top", "artist_limit": 2})
        thread = backfill.archive_entity(self.app, self.app.deezer, "artist", "9")
        thread.join(timeout=5)
        self.assertEqual(len(self.app.deezer_prefetch.ids), 2)
        self.assertEqual(self.app.deezer.dz.gw.taken_albums, [])


class PlayContextTestCase(RulesTestBase):
    def test_playing_archives_only_the_track_by_default(self):
        self._login()
        self.client.post(
            "/api/listen",
            json={"deezer_id": "1", "listened": 200, "context": {"kind": "album", "id": "10"}},
        )
        self.assertEqual(self.app.deezer_prefetch.ids, [])

    def test_the_context_is_archived_once_when_enabled(self):
        from supysonic.deezer import backfill

        backfill._recent_contexts.clear()
        rules.save({"on_play_context": True})
        self._login()
        for _ in range(3):  # three tracks of the same album
            self.client.post(
                "/api/listen",
                json={
                    "deezer_id": "1",
                    "listened": 200,
                    "context": {"kind": "album", "id": "10"},
                },
            )
        import time as _time

        for _ in range(100):  # let the single worker finish
            if self.app.deezer_prefetch.ids:
                break
            _time.sleep(0.02)
        # One pass over the album, not one per track change.
        self.assertEqual(self.app.deezer_prefetch.ids, ["1", "2", "3", "4", "5"])

    def test_a_radio_queue_has_no_context_to_archive(self):
        from supysonic.deezer import backfill

        backfill._recent_contexts.clear()
        rules.save({"on_play_context": True})
        self.assertIsNone(
            backfill.archive_play_context(
                self.app, self.app.deezer, {"kind": "flow", "id": ""}
            )
        )
        # An artist context would mean a discography because someone pressed play.
        self.assertIsNone(
            backfill.archive_play_context(
                self.app, self.app.deezer, {"kind": "artist", "id": "9"}
            )
        )


class PlayCountTestCase(RulesTestBase):
    def test_the_web_player_records_plays_locally(self):
        """The cleanup decides what to drop from this data. Before it existed,
        only Subsonic's scrobble wrote it, so a library played entirely through
        the web app looked untouched."""
        self._login()
        track = self._track("1", archived=False)
        self.assertIsNone(track.last_play)

        self.client.post("/api/listen", json={"deezer_id": "1", "listened": 200})
        track = Track[track.id]
        self.assertEqual(track.play_count, 1)
        self.assertIsNotNone(track.last_play)

    def test_a_skip_is_not_a_play(self):
        self._login()
        track = self._track("1", archived=False)
        self.client.post("/api/listen", json={"deezer_id": "1", "listened": 3})
        self.assertIsNone(Track[track.id].last_play)


class CleanupTestCase(RulesTestBase):
    def _enable(self, **over):
        settings = {"clean_on": True, "clean_min_free_gb": 0.0, "clean_stale_days": 30}
        settings.update(over)
        rules.save(settings)

    def test_disabled_by_default_and_deletes_nothing(self):
        old = now() - timedelta(days=400)
        track = self._track("1", played=old)
        stats = cleanup.run(self.app, force=True)
        self.assertTrue(stats["skipped"])
        self.assertTrue(os.path.isfile(Track[track.id].path))

    def test_a_recently_played_track_is_never_a_candidate(self):
        self._enable()
        self._track("1", played=now())
        self.assertEqual(cleanup.candidates(self.app), [])

    def test_favorites_and_playlist_tracks_are_protected(self):
        self._enable()
        old = now() - timedelta(days=400)
        fav = self._track("1", played=old)
        inpl = self._track("2", played=old)
        loose = self._track("3", played=old)

        user = User.get(User.name == "alice")
        StarredTrack.create(user=user, starred=fav, date=now())
        pl = Playlist.create(user=user, name="Mix")
        PlaylistTrack.create(playlist=pl, track=inpl, index=0)

        ids = {t.id for t, _ in cleanup.candidates(self.app)}
        self.assertEqual(ids, {loose.id})

        # …unless the admin says otherwise. That is what the switches are for.
        self._enable(clean_keep_fav=False)
        ids = {t.id for t, _ in cleanup.candidates(self.app)}
        self.assertEqual(ids, {fav.id, loose.id})

    def test_an_uploaded_file_is_never_a_candidate(self):
        """It exists nowhere else — deleting it destroys the only copy. No
        setting may make it eligible."""
        self._enable(clean_keep_fav=False, clean_keep_playlist=False)
        old = now() - timedelta(days=400)
        local = self._track("1", played=old)
        Track.update(deezer_id=None).where(Track.id == local.id).execute()
        self.assertEqual(cleanup.candidates(self.app), [])

    def test_deletion_priority_follows_the_setting(self):
        self._enable()
        old = now() - timedelta(days=400)
        older = now() - timedelta(days=900)
        small_old = self._track("1", size=100, played=older, plays=9)
        big_recent = self._track("2", size=9000, played=old, plays=1)

        self._enable(clean_order="oldest_play")
        self.assertEqual(cleanup.candidates(self.app)[0][0].id, small_old.id)

        self._enable(clean_order="largest")
        self.assertEqual(cleanup.candidates(self.app)[0][0].id, big_recent.id)

        self._enable(clean_order="least_played")
        self.assertEqual(cleanup.candidates(self.app)[0][0].id, big_recent.id)

    def test_a_run_stops_once_the_floor_is_met(self):
        """It frees what is needed, not everything it is allowed to touch."""
        self._enable()
        old = now() - timedelta(days=400)
        for i in range(4):
            self._track(str(i + 1), size=1000, played=old - timedelta(days=i))

        # Pretend we are exactly 1500 bytes short of the floor.
        original = cleanup.deficit
        cleanup.deficit = lambda app, settings=None: 1500
        try:
            stats = cleanup.run(self.app, force=True)
        finally:
            cleanup.deficit = original

        self.assertEqual(stats["deleted"], 2)  # 2 x 1000 >= 1500, then stop
        self.assertEqual(stats["freed"], 2000)
        left = [t for t in Track.select() if os.path.isfile(t.path)]
        self.assertEqual(len(left), 2)

    def test_the_row_survives_so_the_track_still_works(self):
        self._enable()
        old = now() - timedelta(days=400)
        track = self._track("1", size=1000, played=old)
        user = User.get(User.name == "alice")
        pl = Playlist.create(user=user, name="Mix")
        PlaylistTrack.create(playlist=pl, track=track, index=0)
        self._enable(clean_keep_playlist=False)

        original = cleanup.deficit
        cleanup.deficit = lambda app, settings=None: 10**9
        try:
            cleanup.run(self.app, force=True)
        finally:
            cleanup.deficit = original

        row = Track[track.id]
        self.assertFalse(os.path.isfile(row.path))
        self.assertEqual(row.deezer_id, "1")  # re-fetchable
        self.assertEqual(row.last_modification, 0)  # flagged "not archived"
        self.assertEqual(len(pl.get_tracks()), 1)  # still in the playlist

    def test_podcast_episodes_are_protected_by_default(self):
        from supysonic.db import PodcastChannel, PodcastEpisode

        self._enable()
        user = User.get(User.name == "alice")
        channel = PodcastChannel.create(
            user=user, url="u", title="Show", status="completed"
        )
        path = os.path.join(self.archive, "ep.mp3")
        with open(path, "wb") as fh:
            fh.write(b"\0" * 500)
        PodcastEpisode.create(
            channel=channel,
            title="Ep",
            path=path,
            publish_date=now() - timedelta(days=400),
        )
        self.assertEqual(cleanup.candidates(self.app), [])

        self._enable(clean_keep_podcast=False)
        self.assertEqual(len(cleanup.candidates(self.app)), 1)

    def test_an_episode_of_a_vanished_show_is_never_a_candidate(self):
        """When a show leaves Deezer the archive is the only copy left — that is
        the entire reason the channel became a local podcast."""
        from supysonic.db import PodcastChannel, PodcastEpisode

        self._enable(clean_keep_podcast=False)
        user = User.get(User.name == "alice")
        channel = PodcastChannel.create(
            user=user, url="u", title="Gone show", status="completed", gone=now()
        )
        path = os.path.join(self.archive, "gone.mp3")
        with open(path, "wb") as fh:
            fh.write(b"\0" * 500)
        PodcastEpisode.create(
            channel=channel,
            title="Ep",
            path=path,
            publish_date=now() - timedelta(days=400),
        )
        self.assertEqual(cleanup.candidates(self.app), [])

    def test_preview_deletes_nothing(self):
        self._enable()
        old = now() - timedelta(days=400)
        track = self._track("1", played=old)
        self._login()
        body = self.client.get("/api/archive/cleanup/preview").get_json()
        self.assertTrue(body["enabled"])
        self.assertEqual(body["eligible"], 1)
        self.assertTrue(os.path.isfile(Track[track.id].path))

    def test_the_endpoint_refuses_when_the_rules_are_off(self):
        self._login()
        rv = self.client.post("/api/archive/cleanup")
        self.assertEqual(rv.status_code, 409)


if __name__ == "__main__":
    unittest.main()

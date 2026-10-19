# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot B of the Deezer detachment: the account is imported once, never mirrored.

The scheduled sync reads no part of the Deezer account; the one-off import only
adds to what we hold (a favourite removed on Deezer stays, a local playlist is
never emptied, a second import duplicates nothing); the favourites list is the
database's own.
"""

import time
import unittest
from unittest import mock

from supysonic.db import Playlist, PlaylistTrack, StarredTrack, Track, User
from supysonic.deezer import ids, importer, scheduler

from . import test_deezer, test_webui

raw_track = test_deezer.raw_track

ACCOUNT_READS = (
    "get_user_playlists",
    "get_user_favorite_ids",
    "get_smart_tracklist",
    "get_flow",
    "get_module_page",
    "get_user_shows",
)


class ImportAccountTestCase(test_deezer.DeezerTestCase):
    def _gw(self):
        gw = self.provider._dz.gw
        gw.tracks_by_id = {str(i): raw_track(i, f"T{i}", num=i) for i in (1, 2, 3)}
        gw.playlists = [{"id": "100", "title": "Mix", "description": None}]
        gw.playlist_tracks["100"] = [raw_track(1, "T1", num=1), raw_track(2, "T2", num=2)]
        gw.fav_ids = [1, 2]
        return gw

    def test_two_imports_in_a_row_duplicate_nothing(self):
        self._gw()
        imp = importer.DeezerImporter(self.provider, "alice")
        first = imp.import_account()
        self.assertEqual((first["playlists"], first["favorites"], first["failed"]), (1, 2, []))
        imp.import_account()
        self.assertEqual(Playlist.select().count(), 1)
        self.assertEqual(PlaylistTrack.select().count(), 2)
        self.assertEqual(StarredTrack.select().count(), 2)
        self.assertEqual(Track.select().count(), 3 - 1)

    def test_a_favourite_removed_on_deezer_stays_here(self):
        gw = self._gw()
        imp = importer.DeezerImporter(self.provider, "alice")
        imp.import_account()
        gw.fav_ids = [1]
        imp.import_account()
        starred = {s.starred_id for s in StarredTrack.select()}
        self.assertEqual(starred, {ids.track_uuid("1"), ids.track_uuid("2")})

    def test_a_local_playlist_is_extended_never_emptied_or_renamed(self):
        gw = self._gw()
        imp = importer.DeezerImporter(self.provider, "alice")
        imp.import_account()
        pl = Playlist[ids.playlist_uuid("100")]
        pl.name = "Renamed here"
        pl.save()
        # Deezer now lists only track 3: ours keeps 1 and 2, gains 3 at the end.
        gw.playlist_tracks["100"] = [raw_track(3, "T3", num=3)]
        imp.import_account()
        pl = Playlist[ids.playlist_uuid("100")]
        self.assertEqual(pl.name, "Renamed here")
        self.assertEqual([t.deezer_id for t in pl.get_tracks()], ["1", "2", "3"])

    def test_one_failing_half_is_reported_and_the_other_still_runs(self):
        self._gw()
        imp = importer.DeezerImporter(self.provider, "alice")
        with mock.patch.object(imp, "sync_playlists", side_effect=RuntimeError("down")):
            out = imp.import_account()
        self.assertEqual(out["favorites"], 2)
        self.assertEqual(len(out["failed"]), 1)
        self.assertIn("playlists", out["failed"][0])


class ScheduledSyncReadsNoAccountTestCase(test_deezer.DeezerTestCase):
    def test_a_whole_cycle_makes_no_account_read(self):
        gw = self.provider._dz.gw
        reads = []
        for name in ACCOUNT_READS:
            for obj in (gw, self.provider._dz.api, self.provider):
                if hasattr(obj, name):
                    setattr(obj, name, lambda *a, _n=name, **k: reads.append(_n) or [])
        # A trap for anything else that reaches for the account.
        for name in ("get_user_playlists", "get_user_favorite_ids", "get_user_shows"):
            setattr(self.provider._dz.gw, name, lambda *a, _n=name, **k: reads.append(_n) or [])
        self.provider.get_user_shows = lambda *a, **k: reads.append("get_user_shows") or []
        self.provider.get_smart_tracklist = lambda *a, **k: reads.append("get_smart_tracklist")

        app = mock.Mock()
        app.deezer = self.provider
        app.config = {
            "DEEZER": {
                "sync_user": "alice",
                "scan_local": False,
                "archive_dir": self.archive_dir,
                "sync_playlists": True,
                "sync_favorites": True,
                "sync_podcasts": True,
                "import_flow": True,
                "import_new_releases": True,
                "import_new_albums": True,
            }
        }
        with mock.patch.object(scheduler, "_reachable", return_value=True), mock.patch(
            "supysonic.deezer.backfill.sweep_for", return_value={"total": 0}
        ) as sweep:
            self.assertTrue(scheduler._run_sync(app))
        self.assertEqual(reads, [])
        self.assertEqual(sweep.call_count, 1)


class ImportRouteTestCase(test_webui.WebUITestCase):
    def test_import_is_admin_only_and_reports_its_progress(self):
        self.assertEqual(self.client.post("/api/deezer/import-account").status_code, 401)
        self._login()

        def fake(self_):
            self_._progress("working")
            return {"playlists": 3, "favorites": 7, "failed": []}

        with mock.patch.object(importer.DeezerImporter, "import_account", fake), mock.patch(
            "supysonic.webui._dz_live", return_value=self.app.deezer
        ):
            self.app.config["DEEZER"]["sync_user"] = "alice"
            rv = self.client.post("/api/deezer/import-account")
            self.assertEqual(rv.status_code, 200)
            deadline = time.time() + 10
            status = {}
            while time.time() < deadline:
                status = self.client.get("/api/deezer/import-account").get_json()
                if not status["running"]:
                    break
                time.sleep(0.05)
        self.assertFalse(status["running"])
        self.assertEqual((status["playlists"], status["favorites"]), (3, 7))

    def test_a_guest_cannot_import(self):
        from supysonic.managers.user import UserManager

        UserManager.add("bob", "B0bpass", admin=False)
        self.client.post("/api/login", json={"username": "bob", "password": "B0bpass"})
        self.assertEqual(self.client.post("/api/deezer/import-account").status_code, 403)
        self.assertEqual(self.client.get("/api/deezer/import-account").status_code, 403)

    def test_the_explorer_is_gone(self):
        self._login()
        for path in ("/api/explore", "/api/explore/genre/132", "/api/explore/countries"):
            self.assertEqual(self.client.get(path).status_code, 404, path)


class UpgradeOfAnExistingServerTestCase(test_deezer.DeezerTestCase):
    """An old config (every sync_* switch on) over a database that already holds
    what the old sync mirrored: nothing is removed, nothing breaks."""

    def test_old_config_and_existing_rows_survive_a_cycle(self):
        gw = self.provider._dz.gw
        gw.tracks_by_id = {str(i): raw_track(i, f"T{i}", num=i) for i in (1, 2)}
        gw.playlists = [{"id": "100", "title": "Mix", "description": None}]
        gw.playlist_tracks["100"] = [raw_track(1, "T1", num=1), raw_track(2, "T2", num=2)]
        gw.fav_ids = [1, 2]
        imp = importer.DeezerImporter(self.provider, "alice")
        imp.import_account()
        before = (Playlist.select().count(), PlaylistTrack.select().count(),
                  StarredTrack.select().count(), Track.select().count())
        # Deezer now shows an empty account (as after the user left it).
        gw.playlists, gw.fav_ids = [], []
        app = mock.Mock()
        app.deezer = self.provider
        app.config = {"DEEZER": {
            "sync_user": "alice", "scan_local": False, "archive_dir": self.archive_dir,
            "sync_playlists": True, "sync_favorites": True, "sync_podcasts": True,
            "import_flow": True, "import_new_releases": True, "import_new_albums": True,
            "push_to_deezer": True, "archive_library": True,
        }}
        with mock.patch.object(scheduler, "_reachable", return_value=True), mock.patch(
            "supysonic.deezer.backfill.sweep_for", return_value={"total": 0}
        ):
            self.assertTrue(scheduler._run_sync(app))
        after = (Playlist.select().count(), PlaylistTrack.select().count(),
                 StarredTrack.select().count(), Track.select().count())
        self.assertEqual(before, after)


def _only_own_tests(cls, *own):
    for name in dir(cls):
        if name.startswith("test_") and name not in own:
            setattr(cls, name, None)


_only_own_tests(
    ImportRouteTestCase,
    "test_import_is_admin_only_and_reports_its_progress",
    "test_a_guest_cannot_import",
    "test_the_explorer_is_gone",
)
for _c in (ImportAccountTestCase, ScheduledSyncReadsNoAccountTestCase,
           UpgradeOfAnExistingServerTestCase):
    _only_own_tests(_c, *[n for n in vars(_c) if n.startswith("test_")])


if __name__ == "__main__":
    unittest.main()

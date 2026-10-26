# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot B of the Deezer detachment: the account is imported once, never mirrored.

The scheduled sync reads no part of the Deezer account; the account is imported
by Mes comptes (tests/test_library_import.py: a favourite removed on Deezer
stays, one removed HERE never comes back, a local playlist is never emptied);
the favourites list is the database's own.
"""

import unittest
from unittest import mock

from supysonic.db import Playlist, PlaylistTrack, StarredTrack, Track, User
from supysonic.deezer import importer, scheduler

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
    def test_the_forgetful_import_route_is_gone(self):
        """The account is imported by Mes comptes (libraryimport), which
        remembers what it took. The old one-off route re-added every favourite
        removed here; it is gone, for everybody."""
        self._login()
        self.assertEqual(self.client.post("/api/deezer/import-account").status_code, 404)
        self.assertEqual(self.client.get("/api/deezer/import-account").status_code, 404)

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
        imp.sync_playlists()
        alice = User.get(name="alice")
        StarredTrack.insert_many(
            [{"user": alice.id, "starred": t.id} for t in Track.select()]
        ).execute()
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
    "test_the_forgetful_import_route_is_gone",
    "test_the_explorer_is_gone",
)
for _c in (ScheduledSyncReadsNoAccountTestCase,
           UpgradeOfAnExistingServerTestCase):
    _only_own_tests(_c, *[n for n in vars(_c) if n.startswith("test_")])


if __name__ == "__main__":
    unittest.main()

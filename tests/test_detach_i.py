# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot I of the Deezer detachment: the switches that no longer exist.

A server installed before the detachment has a configuration file that names
every one of them, and a database holding the playlists the old nightly sync
wrote ("Deezer · Flow", the smart tracklists, "Nouveautés en vrac"). Both must
go on working on this code: the unknown options are ignored, the old playlists
are ordinary playlists, and the scheduler does what is left of its job.
"""

import os
import shutil
import tempfile
import unittest

from supysonic.config import DefaultConfig, IniConfig
from supysonic.db import Playlist, User, init_database, release_database
from supysonic.deezer import ids, importer
from supysonic.deezer.provider import DeezerProvider
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from .test_deezer import MockDz
from .testbase import TestBase

REMOVED = (
    "push_to_deezer",
    "report_listens",
    "sync_playlists",
    "sync_favorites",
    "import_new_releases",
    "import_flow",
    "import_new_albums",
    "smart_tracklists",
)

#: What `docker/entrypoint.sh` and the sample files of the previous release wrote.
OLD_CONF = """\
[deezer]
enabled = yes
arl = not-a-real-arl
archive_dir = {archive}
default_quality = FLAC
sync_user = alice
sync_playlists = yes
sync_favorites = yes
import_new_releases = yes
import_new_albums = yes
import_flow = yes
smart_tracklists = new-releases discovery monthly-top
push_to_deezer = yes
report_listens = yes
scan_local = yes
preload = yes
sync_at = 04:00
"""


class ConfigTestCase(unittest.TestCase):
    def test_the_defaults_no_longer_name_the_removed_options(self):
        for key in REMOVED:
            self.assertNotIn(key, DefaultConfig.DEEZER)

    def test_the_sample_files_no_longer_name_them(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for name in ("config.sample", "config/supysonic.conf.example", ".env.example",
                     "docker/entrypoint.sh", "docker-compose.yml"):
            with open(os.path.join(root, name), encoding="utf-8") as fh:
                text = fh.read()
            for key in REMOVED + ("DEEZER_REPORT_LISTENS", "DEEZER_PUSH"):
                self.assertNotIn(key, text, "%s still names %s" % (name, key))


class UpgradeTestCase(TestBase):
    """An old file over a database that already holds the old sync's playlists."""

    def setUp(self):
        super().setUp()
        self.archive_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.archive_dir, True)
        self.provider = DeezerProvider("dummy-arl", self.archive_dir, "FLAC")
        self.provider._dz = MockDz()
        self.dir = tempfile.mkdtemp()
        self.conf = os.path.join(self.dir, "supysonic.conf")
        with open(self.conf, "w", encoding="utf-8") as fh:
            fh.write(OLD_CONF.format(archive=self.archive_dir))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_an_old_configuration_file_is_read_and_its_dead_options_ignored(self):
        cfg = IniConfig([self.conf])
        self.assertEqual(cfg.DEEZER["sync_user"], "alice")
        self.assertEqual(cfg.DEEZER["sync_at"], "04:00")
        self.assertTrue(cfg.DEEZER["scan_local"])
        # Read, kept and harmless: nothing in the code asks for them.
        self.assertIs(cfg.DEEZER["push_to_deezer"], True)
        self.assertEqual(cfg.DEEZER["smart_tracklists"], "new-releases discovery monthly-top")

    def test_the_old_sync_playlists_are_ordinary_playlists_and_nothing_is_purged(self):
        alice = User.get(name="alice")
        for key, name in (("reco:flow", "Deezer · Flow"), ("smart:discovery", "Deezer · Découverte"),
                          ("reco:newalbums", "Deezer · Nouveautés en vrac")):
            Playlist.create(id=ids.playlist_uuid(key), user=alice, name=name)
        imp = importer.DeezerImporter(self.provider, "alice")
        imp.sync({"sync_podcasts": True, "podcast_episodes": 30, **IniConfig([self.conf]).DEEZER})
        self.assertEqual(
            sorted(p.name for p in Playlist.select()),
            ["Deezer · Découverte", "Deezer · Flow", "Deezer · Nouveautés en vrac"],
        )

    def test_the_scheduled_refresh_reads_no_part_of_the_account(self):
        gw = self.provider._dz.gw
        asked = []
        for name in ("get_user_playlists", "get_user_favorite_ids", "get_tracks", "get_playlist_tracks"):
            setattr(gw, name, lambda *a, _n=name, **k: asked.append(_n) or [])
        importer.DeezerImporter(self.provider, "alice").sync(IniConfig([self.conf]).DEEZER)
        self.assertEqual(asked, [])

    def test_the_app_boots_on_the_old_file_and_serves_the_old_library(self):
        path = os.path.join(self.dir, "old.db")
        archive, cache, conf = self.archive_dir, self.dir, self.conf

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(self.DEEZER, **IniConfig([conf]).DEEZER)

        release_database()
        init_database("sqlite:///" + path)
        release_database()
        app = create_application(Config())
        try:
            UserManager.add("bob", "B0b", admin=True)
            client = app.test_client()
            client.post("/api/login", json={"username": "bob", "password": "B0b"})
            Playlist.create(id=ids.playlist_uuid("reco:flow"), user=User.get(name="bob"), name="Deezer · Flow")
            lists = client.get("/api/me/playlists").get_json()["playlists"]
            self.assertIn("Deezer · Flow", [p["title"] for p in lists])
            self.assertEqual(client.get("/api/flow").status_code, 200)
            for gone in ("/api/flow/clusters", "/api/recommendations", "/api/smarttracklist/discovery"):
                self.assertEqual(client.get(gone).status_code, 404, gone)
            self.assertEqual(client.get("/api/home").status_code, 200)
        finally:
            release_database()


if __name__ == "__main__":
    unittest.main()

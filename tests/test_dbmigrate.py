# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

import os
import tempfile
import unittest

from supysonic.db import (
    Album,
    Artist,
    Folder,
    Playlist,
    PlaylistTrack,
    StarredTrack,
    Track,
    User,
    init_database,
    migrate_database,
    release_database,
)
from supysonic.managers.user import UserManager


class DbMigrateTestCase(unittest.TestCase):
    """SQLite -> SQLite exercises the engine-agnostic copy logic offline."""

    def setUp(self):
        self.src = tempfile.mkstemp(suffix=".db")
        self.dst = tempfile.mkstemp(suffix=".db")
        self.src_uri = "sqlite:///" + self.src[1]
        self.dst_uri = "sqlite:///" + self.dst[1]

    def tearDown(self):
        release_database()
        for fd, path in (self.src, self.dst):
            os.close(fd)
            try:
                os.remove(path)
            except OSError:
                pass

    def _seed(self):
        init_database(self.src_uri)
        root = Folder.create(root=True, name="Music", path="/music")
        child = Folder.create(
            root=False, name="Artist", path="/music/artist", parent=root
        )
        artist = Artist.create(name="The Artist")
        album = Album.create(name="The Album", artist=artist)
        track = Track.create(
            disc=1,
            number=1,
            title="Song",
            duration=180,
            album=album,
            artist=artist,
            bitrate=1411,
            path="/music/artist/song.flac",
            last_modification=0,
            root_folder=root,
            folder=child,
            deezer_id="123",
        )
        UserManager.add("alice", "secret", admin=True)
        alice = User.get(User.name == "alice")
        pl = Playlist.create(user=alice, name="Fav")
        PlaylistTrack.create(playlist=pl, track=track, index=0)
        StarredTrack.create(user=alice, starred=track)
        release_database()

    def test_migrate_copies_all_data(self):
        self._seed()
        copied = migrate_database(self.src_uri, self.dst_uri)

        # The proxy is now bound to the destination, so models read from it.
        self.assertEqual(Folder.select().count(), 2)
        self.assertEqual(Artist.select().count(), 1)
        self.assertEqual(Album.select().count(), 1)
        self.assertEqual(Track.select().count(), 1)
        self.assertEqual(User.select().count(), 1)
        self.assertEqual(PlaylistTrack.select().count(), 1)
        self.assertEqual(StarredTrack.select().count(), 1)

        track = Track.get()
        self.assertEqual(track.title, "Song")
        self.assertEqual(track.deezer_id, "123")
        # Foreign keys (incl. the self-referential folder parent) are preserved.
        self.assertEqual(track.folder.name, "Artist")
        self.assertEqual(track.folder.parent.name, "Music")
        self.assertEqual(track.album.artist.name, "The Artist")

        self.assertEqual(copied["track"], 1)
        self.assertEqual(copied["folder"], 2)
        self.assertNotIn("meta", copied)

    def test_credentials_survive(self):
        self._seed()
        migrate_database(self.src_uri, self.dst_uri)
        # The argon2 hash copied across verbatim, so login still works.
        self.assertIsNotNone(UserManager.try_auth("alice", "secret"))

    def test_refuses_nonempty_destination(self):
        self._seed()
        migrate_database(self.src_uri, self.dst_uri)
        release_database()
        with self.assertRaises(RuntimeError):
            migrate_database(self.src_uri, self.dst_uri)

    def test_skip_if_populated_is_idempotent(self):
        self._seed()
        migrate_database(self.src_uri, self.dst_uri)
        release_database()
        self.assertIsNone(
            migrate_database(self.src_uri, self.dst_uri, skip_if_populated=True)
        )

    def test_identical_source_and_dest_rejected(self):
        self._seed()
        with self.assertRaises(RuntimeError):
            migrate_database(self.src_uri, self.src_uri)


if __name__ == "__main__":
    unittest.main()

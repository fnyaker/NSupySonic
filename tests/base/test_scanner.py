# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2017-2023 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import mutagen
import os
import os.path
import shutil
import tempfile
import unittest

from contextlib import contextmanager

from supysonic import db
from supysonic.managers.folder import FolderManager
from supysonic.scanner import Scanner


class ScannerTestCase(unittest.TestCase):
    def setUp(self):
        db.init_database("sqlite:")

        # A private copy: these tests write temporary tracks next to the
        # fixture, and tests/assets/folder is scanned by other test modules
        # too — run in parallel, one of them listed a copy this one was
        # deleting and failed on the missing file.
        self.__library = tempfile.mkdtemp()
        library = os.path.join(self.__library, "folder")
        shutil.copytree("tests/assets/folder", library)
        folder = FolderManager.add("folder", library)
        self.assertIsNotNone(folder)

        self.folderid = folder.id
        self.__scan()

    def tearDown(self):
        db.release_database()
        shutil.rmtree(self.__library, ignore_errors=True)

    @contextmanager
    def __temporary_track_copy(self):
        track = db.Track.select().first()
        with tempfile.NamedTemporaryFile(
            dir=os.path.dirname(track.path), delete=False
        ) as tf:
            with open(track.path, "rb") as f:
                tf.write(f.read())
        try:
            yield tf.name
        finally:
            os.remove(tf.name)

    def __scan(self, force=False):
        self.scanner = Scanner(force=force)
        self.scanner.queue_folder("folder")
        self.scanner.run()

    def test_scan(self):
        self.assertEqual(db.Track.select().count(), 1)

        self.assertRaises(TypeError, self.scanner.queue_folder, None)
        self.assertRaises(
            TypeError, self.scanner.queue_folder, db.Folder[self.folderid]
        )

    def test_rescan(self):
        self.__scan()
        self.assertEqual(db.Track.select().count(), 1)

    def test_force_rescan(self):
        self.__scan(True)
        self.assertEqual(db.Track.select().count(), 1)

    def test_scan_file(self):
        self.scanner.scan_file("/some/inexistent/path")
        self.assertEqual(db.Track.select().count(), 1)

    def test_scanned_metadata(self):
        self.assertEqual(db.Track.select().count(), 1)

        track = db.Track.select().first()
        artist = db.Artist.select().where(db.Artist.id == track.artist).first()
        album = db.Album.select().where(db.Album.id == track.album).first()

        self.assertEqual(track.bitrate, 128)
        self.assertEqual(track.disc, 1)
        self.assertEqual(track.number, 1)
        self.assertEqual(track.duration, 4)
        self.assertEqual(track.has_art, True)
        self.assertEqual(track.title, "[silence]")
        self.assertEqual(artist.name, "Some artist")
        self.assertEqual(album.name, "Awesome album")

    def test_remove_file(self):
        track = db.Track.select().first()
        self.assertRaises(TypeError, self.scanner.remove_file, None)
        self.assertRaises(TypeError, self.scanner.remove_file, track)

        self.scanner.remove_file("/some/inexistent/path")
        self.assertEqual(db.Track.select().count(), 1)

        self.scanner.remove_file(track.path)
        self.scanner.prune()
        self.assertEqual(db.Track.select().count(), 0)
        self.assertEqual(db.Album.select().count(), 0)
        self.assertEqual(db.Artist.select().count(), 0)

    def test_move_file(self):
        track = db.Track.select().first()
        self.assertRaises(TypeError, self.scanner.move_file, None, "string")
        self.assertRaises(TypeError, self.scanner.move_file, track, "string")
        self.assertRaises(TypeError, self.scanner.move_file, "string", None)
        self.assertRaises(TypeError, self.scanner.move_file, "string", track)

        self.scanner.move_file("/some/inexistent/path", track.path)
        self.assertEqual(db.Track.select().count(), 1)

        self.scanner.move_file(track.path, track.path)
        self.assertEqual(db.Track.select().count(), 1)

        self.assertRaises(
            Exception, self.scanner.move_file, track.path, "/some/inexistent/path"
        )

        with self.__temporary_track_copy() as tf:
            self.__scan()
            self.assertEqual(db.Track.select().count(), 2)
            self.scanner.move_file(tf, track.path)
            self.assertEqual(db.Track.select().count(), 1)

        track = db.Track.select().first()
        new_path = track.path.replace("silence", "silence_moved")
        self.scanner.move_file(track.path, new_path)

        track = db.Track.select().first()
        self.assertEqual(db.Track.select().count(), 1)
        self.assertEqual(track.path, new_path)

    def test_rescan_corrupt_file(self):
        with self.__temporary_track_copy() as tf:
            self.__scan()
            self.assertEqual(db.Track.select().count(), 2)

            with open(tf, "wb") as f:
                f.seek(0, 0)
                f.write(b"\x00" * 4096)
                f.truncate()

            self.__scan(True)
            self.assertEqual(db.Track.select().count(), 1)

    def test_rescan_removed_file(self):
        with self.__temporary_track_copy():
            self.__scan()
            self.assertEqual(db.Track.select().count(), 2)

        self.__scan()
        self.assertEqual(db.Track.select().count(), 1)

    def test_scan_tag_change(self):
        with self.__temporary_track_copy() as tf:
            self.__scan()
            copy = db.Track.get(path=tf)
            self.assertEqual(copy.artist.name, "Some artist")
            self.assertEqual(copy.album.name, "Awesome album")

            tags = mutagen.File(copy.path, easy=True)
            tags["artist"] = "Renamed artist"
            tags["album"] = "Crappy album"
            tags.save()

            self.__scan(True)
            copy = db.Track.get(path=tf)
            self.assertEqual(copy.artist.name, "Renamed artist")
            self.assertEqual(copy.album.name, "Crappy album")
            self.assertIsNotNone(db.Artist.get(name="Some artist"))
            self.assertIsNotNone(db.Album.get(name="Awesome album"))

    def test_a_file_vanishing_mid_scan_does_not_abort_it(self):
        # Listed by scandir, gone by the time it is stat()ed: a file moved or
        # deleted while a scan runs. It used to raise FileNotFoundError out of
        # the scan and leave every file after it unscanned.
        track = db.Track.select().first()
        folder = os.path.dirname(track.path)
        doomed = os.path.join(folder, "a-doomed.mp3")
        survivor = os.path.join(folder, "z-survivor.mp3")
        shutil.copyfile(track.path, doomed)
        shutil.copyfile(track.path, survivor)

        from supysonic import scanner as scanner_module

        real_scandir = scanner_module.os.scandir

        def scandir(path):
            with real_scandir(path) as it:
                entries = sorted(it, key=lambda e: e.name)
            for entry in entries:
                if entry.path == doomed:
                    os.remove(doomed)  # after listing, before stat()
                yield entry

        scanner_module.os.scandir = scandir
        try:
            self.__scan()
        finally:
            scanner_module.os.scandir = real_scandir

        paths = {t.path for t in db.Track.select()}
        self.assertIn(survivor, paths)
        self.assertNotIn(doomed, paths)

    def test_stats(self):
        stats = self.scanner.stats()
        self.assertEqual(stats.added.artists, 1)
        self.assertEqual(stats.added.albums, 1)
        self.assertEqual(stats.added.tracks, 1)
        self.assertEqual(stats.deleted.artists, 0)
        self.assertEqual(stats.deleted.albums, 0)
        self.assertEqual(stats.deleted.tracks, 0)


class ScannerDeletionsTestCase(unittest.TestCase):
    def setUp(self):
        self.__dir = tempfile.mkdtemp()
        db.init_database("sqlite:")
        FolderManager.add("folder", self.__dir)

        # Create folder hierarchy
        self._firstsubdir = tempfile.mkdtemp(dir=self.__dir)
        subdir = self._firstsubdir
        for _ in range(4):
            subdir = tempfile.mkdtemp(dir=subdir)

        # Put a file in the deepest folder
        self._trackpath = os.path.join(subdir, "silence.mp3")
        shutil.copyfile("tests/assets/folder/silence.mp3", self._trackpath)

        self._scan()

        # Create annotation data
        track = db.Track.get()
        firstdir = db.Folder.get(path=self._firstsubdir)
        user = db.User.create(
            name="user", password="password", salt="salt", last_play=track
        )
        db.StarredFolder.create(user=user, starred=track.folder_id)
        db.StarredFolder.create(user=user, starred=firstdir)
        db.StarredArtist.create(user=user, starred=track.artist_id)
        db.StarredAlbum.create(user=user, starred=track.album_id)
        db.StarredTrack.create(user=user, starred=track)
        db.RatingFolder.create(user=user, rated=track.folder_id, rating=2)
        db.RatingFolder.create(user=user, rated=firstdir, rating=2)
        db.RatingTrack.create(user=user, rated=track, rating=2)

    def tearDown(self):
        db.release_database()
        shutil.rmtree(self.__dir)

    def _scan(self):
        scanner = Scanner()
        scanner.queue_folder("folder")
        scanner.run()

        return scanner.stats()

    def _check_assertions(self, stats):
        self.assertEqual(stats.deleted.artists, 1)
        self.assertEqual(stats.deleted.albums, 1)
        self.assertEqual(stats.deleted.tracks, 1)
        self.assertEqual(db.Track.select().count(), 0)
        self.assertEqual(db.Album.select().count(), 0)
        self.assertEqual(db.Artist.select().count(), 0)
        self.assertEqual(db.User.select().count(), 1)
        self.assertEqual(db.Folder.select().count(), 1)

    def test_parent_folder(self):
        shutil.rmtree(self._firstsubdir)
        stats = self._scan()
        self._check_assertions(stats)

    def test_track(self):
        os.remove(self._trackpath)
        stats = self._scan()
        self._check_assertions(stats)


if __name__ == "__main__":
    unittest.main()

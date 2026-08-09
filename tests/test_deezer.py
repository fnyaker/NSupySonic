# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

import os
import os.path
import tempfile
import unittest
from pathlib import Path

from supysonic.db import (
    Track,
    Album,
    Artist,
    ClientPrefs,
    Folder,
    Playlist,
    PlaylistTrack,
    StarredTrack,
    User,
)
from supysonic.deezer import ids
from supysonic.deezer.provider import DeezerProvider
from supysonic.deezer import archive, importer

from .testbase import TestBase


def raw_track(sid, title="Title", art=("1", "Artist"), alb=("10", "Album"),
              num=1, disc=1, dur=200, pic="covermd5"):
    return {
        "SNG_ID": str(sid),
        "SNG_TITLE": title,
        "ART_ID": art[0],
        "ART_NAME": art[1],
        "ALB_ID": alb[0],
        "ALB_TITLE": alb[1],
        "ALB_PICTURE": pic,
        "DURATION": dur,
        "TRACK_NUMBER": num,
        "DISK_NUMBER": disc,
        "TRACK_TOKEN": f"tok{sid}",
    }


class MockGW:
    def __init__(self):
        self.playlists = []
        self.playlist_tracks = {}
        self.fav_ids = []
        self.tracks_by_id = {}
        self.album_tracks = {}
        self.user_artists = []
        self.discographies = {}
        self.smart_tracklists = {}
        # Recorded write calls (Subsonic -> Deezer push)
        self.created = []
        self.added = []
        self.removed = []
        self.deleted = []
        self.fav_added = []
        self.fav_removed = []
        self.next_create_id = 999

    def get_user_playlists(self, user_id, limit=25):
        return self.playlists

    def get_playlist_tracks(self, playlist_id):
        return self.playlist_tracks.get(str(playlist_id), [])

    def get_user_favorite_ids(self, limit=10000):
        return {"data": [{"SNG_ID": str(i)} for i in self.fav_ids]}

    def get_tracks(self, ids_):
        return [self.tracks_by_id[str(i)] for i in ids_]

    def get_album_tracks(self, alb_id):
        return self.album_tracks.get(str(alb_id), [])

    def get_user_artists(self, user_id, limit=25):
        return self.user_artists

    def get_artist_discography(self, art_id, index=0, limit=25):
        return self.discographies.get(str(art_id), {"data": []})

    def get_smart_tracklist(self, stl_id):
        return self.smart_tracklists.get(str(stl_id)) or {"DATA": {}, "SONGS": {"data": []}}

    # writes
    def create_playlist(self, title, status=0, description=None, songs=[]):
        self.created.append((title, list(songs)))
        return self.next_create_id

    def add_songs_to_playlist(self, playlist_id, songs, offset=-1):
        self.added.append((str(playlist_id), list(songs)))

    def remove_songs_from_playlist(self, playlist_id, songs):
        self.removed.append((str(playlist_id), list(songs)))

    def delete_playlist(self, playlist_id):
        self.deleted.append(str(playlist_id))

    def add_song_to_favorites(self, sng_id):
        self.fav_added.append(str(sng_id))

    def remove_song_from_favorites(self, sng_id):
        self.fav_removed.append(str(sng_id))


class MockApi:
    def __init__(self):
        self.releases = {"data": []}
        self.flow = {"data": []}

    def get_editorial_releases(self, limit=10):
        return self.releases

    def get_user_flow(self, user_id, limit=25):
        return self.flow


class MockDz:
    def __init__(self):
        self.gw = MockGW()
        self.api = MockApi()
        self.current_user = {"id": 42, "name": "tester", "can_stream_lossless": True}


class DeezerTestCase(TestBase):
    def setUp(self):
        super().setUp()
        self.archive_dir = tempfile.mkdtemp()
        self.provider = DeezerProvider("dummy-arl", self.archive_dir, "FLAC")
        # Bypass the real ARL login with a mock backend.
        self.provider._dz = MockDz()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.archive_dir, ignore_errors=True)
        super().tearDown()

    # -- ids -------------------------------------------------------------

    def test_ids_are_deterministic(self):
        self.assertEqual(ids.track_uuid("123"), ids.track_uuid("123"))
        self.assertNotEqual(ids.track_uuid("123"), ids.track_uuid("124"))
        self.assertNotEqual(ids.track_uuid("1"), ids.album_uuid("1"))

    # -- library upsert --------------------------------------------------

    def test_upsert_track_creates_rows(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        self.assertTrue(root.root)
        t = library.upsert_track(raw_track(1, "Song"), root, "FLAC")

        self.assertEqual(t.deezer_id, "1")
        self.assertEqual(t.id, ids.track_uuid("1"))
        self.assertEqual(t.album.deezer_id, "10")
        self.assertEqual(t.album.cover_md5, "covermd5")
        self.assertEqual(t.artist.deezer_id, "1")
        self.assertTrue(t.path.endswith(".flac"))
        self.assertTrue(t.path.startswith(self.archive_dir))
        self.assertFalse(os.path.isfile(t.path))  # lazy: not fetched yet

        # Idempotent
        t2 = library.upsert_track(raw_track(1, "Song (remastered)"), root, "FLAC")
        self.assertEqual(t2.id, t.id)
        self.assertEqual(Track.select().where(Track.deezer_id == "1").count(), 1)
        self.assertEqual(t2.title, "Song (remastered)")

    # -- session health / credential -------------------------------------

    def test_every_deezer_request_has_a_timeout(self):
        """A request without a timeout can park a server thread forever; enough
        of those and the app stops answering at all. The session must impose one
        on any call that doesn't ask for its own."""
        import requests
        from deezerpy import DEFAULT_TIMEOUT, Deezer

        seen = {}

        class Recorder(requests.adapters.HTTPAdapter):
            def send(self, request, **kwargs):
                seen["timeout"] = kwargs.get("timeout")
                raise requests.ConnectionError("no network in tests")

        dz = Deezer()
        dz.session.mount("https://", Recorder())
        with self.assertRaises(requests.ConnectionError):
            dz.session.get("https://example.invalid/x")
        self.assertEqual(seen["timeout"], DEFAULT_TIMEOUT)

        # An explicit timeout still wins.
        with self.assertRaises(requests.ConnectionError):
            dz.session.get("https://example.invalid/x", timeout=(1, 2))
        self.assertEqual(seen["timeout"], (1, 2))

    def test_check_login_separates_a_dead_arl_from_a_dead_network(self):
        from deezerpy import Deezer
        from supysonic.deezer.provider import DeezerProvider

        provider = DeezerProvider("dummy", self.archive_dir, "FLAC")

        # Deezer answers and says no: the credential is the problem.
        original = Deezer.login_via_arl
        Deezer.login_via_arl = lambda self, arl, child=0: False
        try:
            status = provider.check_login(force=True)
        finally:
            Deezer.login_via_arl = original
        self.assertFalse(status["ok"])
        self.assertEqual(status["reason"], "arl")

        # Deezer doesn't answer at all: says nothing about the credential, so it
        # must NOT send the admin chasing a perfectly good ARL.
        def boom(self, arl, child=0):
            raise OSError("connection reset")

        Deezer.login_via_arl = boom
        try:
            status = provider.check_login(force=True)
        finally:
            Deezer.login_via_arl = original
        self.assertFalse(status["ok"])
        self.assertEqual(status["reason"], "network")

        # A healthy session reports the account and never raises.
        provider._dz = MockDz()
        provider._last_check = 0
        status = provider.check_login()
        self.assertTrue(status["ok"])
        self.assertEqual(status["account"], "tester")

    def test_set_arl_drops_everything_derived_from_the_old_one(self):
        self.provider._fav_cache = ("checksum", [1, 2, 3])
        self.provider.set_arl("  newarl  ")
        self.assertEqual(self.provider.arl, "newarl")
        self.assertIsNone(self.provider._dz)  # forces a fresh login
        self.assertIsNone(self.provider._fav_cache)  # no data from the old account

    def test_stored_arl_overrides_the_configured_one(self):
        from supysonic import deezer as dzmod

        cfg = {
            "enabled": True,
            "arl": "from-config",
            "archive_dir": self.archive_dir,
        }
        self.assertEqual(dzmod.get_provider({"DEEZER": cfg}).arl, "from-config")

        dzmod.store_arl("z" * 64)
        try:
            self.assertEqual(dzmod.get_provider({"DEEZER": cfg}).arl, "z" * 64)
            # …and it enables the proxy even if the config never did.
            off = dict(cfg, enabled=False, arl=None)
            self.assertIsNotNone(dzmod.get_provider({"DEEZER": off}))
        finally:
            dzmod.store_arl(None)
        self.assertEqual(dzmod.get_provider({"DEEZER": cfg}).arl, "from-config")

        # Anything that isn't shaped like an ARL is refused outright: it ends up
        # in an outgoing Cookie header.
        self.assertFalse(dzmod.valid_arl("short"))
        self.assertFalse(dzmod.valid_arl("a" * 40 + "\r\nCookie: x"))
        self.assertFalse(dzmod.valid_arl("a" * 40 + "; path=/"))
        self.assertTrue(dzmod.valid_arl("a" * 192))
        with self.assertRaises(ValueError):
            dzmod.store_arl("nope")

    # -- concurrent imports ----------------------------------------------

    def test_upsert_survives_a_lost_insert_race(self):
        """Two plays of the same album at once: both miss the existence check,
        both insert, and the loser's INSERT violates the unique constraint. That
        used to escape as a 502 on a perfectly ordinary first play (and poisoned
        the surrounding transaction on Postgres) — it must read back the winner's
        row instead.

        The race is reproduced faithfully: the rows really exist, the existence
        check is forced to miss them once (as it does when the winner commits
        between our SELECT and our INSERT), and the constraint violation that
        follows is a real one from the database.
        """
        from supysonic.db import Album, Artist, Folder, Track
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        # The "winner": everything for this album/artist now exists.
        first = library.upsert_track(raw_track(1, "First"), root, "FLAC")

        def blind_once(owner, name, exc):
            """Make the next lookup miss, as if the winner hadn't committed yet."""
            original = getattr(owner, name)
            state = {"used": False}

            def wrapper(*args, **kwargs):
                if not state["used"]:
                    state["used"] = True
                    raise exc
                return original(*args, **kwargs)

            setattr(owner, name, wrapper)
            return (owner, name, original)

        patches = [
            blind_once(Folder, "get", Folder.DoesNotExist()),
            blind_once(Artist, "get_by_id", Artist.DoesNotExist()),
            blind_once(Album, "get_by_id", Album.DoesNotExist()),
            blind_once(Track, "get_by_id", Track.DoesNotExist()),
        ]
        try:
            # Same track id as the winner: every single upsert loses its race.
            track = library.upsert_track(raw_track(1, "First"), root, "FLAC")
        finally:
            for owner, name, original in patches:
                setattr(owner, name, original)

        self.assertEqual(track.id, first.id)
        self.assertEqual(Track.select().where(Track.deezer_id == "1").count(), 1)
        self.assertEqual(Folder.select().where(Folder.name == "Album").count(), 1)
        self.assertEqual(Artist.select().where(Artist.name == "Artist").count(), 1)
        self.assertEqual(Album.select().where(Album.name == "Album").count(), 1)

    def test_upsert_track_picks_a_new_path_when_one_is_taken(self):
        """A path race is NOT the same as a track race: a different track grabbed
        the filename we picked, so the loser must move to the next free one
        rather than adopt someone else's row."""
        from supysonic.db import Track
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        taken = library.upsert_track(raw_track(1, "Same Name"), root, "FLAC")

        real_unique = library._unique_path
        state = {"used": False}

        def collide(base, tid):
            # First attempt hands back a path that is already someone else's.
            if not state["used"]:
                state["used"] = True
                return taken.path
            return real_unique(base, tid)

        library._unique_path = collide
        try:
            other = library.upsert_track(raw_track(2, "Same Name"), root, "FLAC")
        finally:
            library._unique_path = real_unique

        self.assertNotEqual(other.id, taken.id)
        self.assertNotEqual(other.path, taken.path)
        self.assertEqual(Track.select().count(), 2)

    # -- multi-artist credits --------------------------------------------

    def test_credits_from_gateway_payload(self):
        from supysonic.deezer.library import _credits

        # No ARTISTS list (the trimmed favourites payload) means "Deezer told
        # us nothing" — NOT "one artist". Anything else and re-importing a
        # track through favourites would overwrite a known feature credit.
        self.assertEqual(_credits(raw_track(1)), [])

        # A full list is ordered by ARTISTS_SONGS_ORDER, not by array position,
        # and ROLE_ID 0/5 map to Main/Featured.
        raw = raw_track(1)
        raw["ARTISTS"] = [
            {"ART_ID": "3", "ART_NAME": "C", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "2"},
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        self.assertEqual(
            _credits(raw),
            [("1", "A", "Main"), ("2", "B", "Featured"), ("3", "C", "Featured")],
        )

        # Deezer repeats an artist that holds two roles; the first wins.
        raw["ARTISTS"].append(
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "9"}
        )
        self.assertEqual([c[0] for c in _credits(raw)], ["1", "2", "3"])

        # Junk never crashes and never invents a credit.
        self.assertEqual(_credits({}), [])
        self.assertEqual(_credits({"ART_ID": "1", "ART_NAME": "A", "ARTISTS": "nope"}), [])
        self.assertEqual(_credits({"ARTISTS": [{"ART_NAME": "no id"}]}), [])

    def test_upsert_track_stores_credits(self):
        from supysonic.db import TrackArtist
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        raw = raw_track(1, "Feature")
        raw["ARTISTS"] = [
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        t = library.upsert_track(raw, root, "FLAC")

        # Track.artist stays the PRIMARY — archive paths and the classic
        # Subsonic `artist` field must not move.
        self.assertEqual(t.artist.deezer_id, "1")
        self.assertEqual(
            [(a.name, r) for a, r in t.credited_artists()], [("A", "Main"), ("B", "Featured")]
        )
        self.assertEqual(t.display_artist(), "A feat. B")
        # The featured artist got a real Artist row of its own.
        self.assertTrue(Artist.select().where(Artist.deezer_id == "2").exists())

        # Re-importing replaces the credits rather than duplicating them.
        library.upsert_track(raw, root, "FLAC")
        self.assertEqual(TrackArtist.select().where(TrackArtist.track == t.id).count(), 2)

        # A LATER, poorer payload (favourites: no ARTISTS) must not wipe them.
        library.upsert_track(raw_track(1, "Feature"), root, "FLAC")
        self.assertEqual(TrackArtist.select().where(TrackArtist.track == t.id).count(), 2)

    def test_credits_always_include_the_primary_artist(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        # ARTISTS that omits ART_ID entirely (Deezer does this on some remixes).
        raw = raw_track(1, "Orphan")
        raw["ARTISTS"] = [
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
        ]
        t = library.upsert_track(raw, root, "FLAC")
        names = [a.name for a, _r in t.credited_artists()]
        self.assertIn("Artist", names)  # the primary is never dropped
        self.assertIn("B", names)

    def test_credited_only_artist_survives_prune(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        raw = raw_track(1, "Feature")
        raw["ARTISTS"] = [
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        library.upsert_track(raw, root, "FLAC")
        # B owns no Track of its own, only a credit — pruning must keep it, or
        # the "feat." link would dangle after the next scan.
        Artist.prune()
        self.assertTrue(Artist.select().where(Artist.deezer_id == "2").exists())

    def test_deleting_a_folder_hierarchy_takes_the_credits_with_it(self):
        from supysonic.db import TrackArtist
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        raw = raw_track(1, "Feature")
        raw["ARTISTS"] = [
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        library.upsert_track(raw, root, "FLAC")
        self.assertEqual(TrackArtist.select().count(), 2)

        # A bulk hierarchy delete doesn't cascade; orphan credit rows would pin
        # the featured artist against prune() for good.
        root.delete_hierarchy()
        self.assertEqual(TrackArtist.select().count(), 0)
        Artist.prune()
        self.assertFalse(Artist.select().where(Artist.deezer_id == "2").exists())

    def test_deleting_one_track_takes_its_credits_with_it(self):
        from supysonic.db import TrackArtist
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        raw = raw_track(1, "Feature")
        raw["ARTISTS"] = [
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        t = library.upsert_track(raw, root, "FLAC")
        # This is the path the scanner and the local importer take.
        t.delete_instance(recursive=True)
        self.assertEqual(TrackArtist.select().count(), 0)

    def test_subsonic_child_exposes_credits(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        raw = raw_track(1, "Feature", art=("1", "A"))
        raw["ARTISTS"] = [
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "0", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "5", "ARTISTS_SONGS_ORDER": "1"},
        ]
        t = library.upsert_track(raw, root, "FLAC")
        user = User.create(name="sub", password="x", salt="x", mail="s@x")
        prefs = ClientPrefs.create(user=user, client_name="tests")
        child = t.as_subsonic_child(user, prefs)

        # Classic clients keep the single-string artist they've always parsed…
        self.assertEqual(child["artist"], "A")
        # …and OpenSubsonic clients get the full list plus the credit line.
        self.assertEqual([a["name"] for a in child["artists"]], ["A", "B"])
        self.assertEqual(child["displayArtist"], "A feat. B")

    def test_display_artist_without_a_main_credit(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        raw = raw_track(1, "Odd")
        # An unmapped ROLE_ID makes everyone "Featured"; the line must not read
        # "A feat. A, B" by promoting the first name and repeating it.
        raw["ARTISTS"] = [
            {"ART_ID": "1", "ART_NAME": "A", "ROLE_ID": "77", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "2", "ART_NAME": "B", "ROLE_ID": "77", "ARTISTS_SONGS_ORDER": "1"},
        ]
        t = library.upsert_track(raw, root, "FLAC")
        self.assertEqual(t.display_artist(), "A, B")

    def test_upsert_track_stores_replaygain(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        # Deezer sends GAIN as a string in dB; it lands on the Track row as a
        # float for the web player's static volume normalization.
        raw = raw_track(1, "Loud")
        raw["GAIN"] = "-8.4"
        t = library.upsert_track(raw, root, "FLAC")
        self.assertAlmostEqual(t.gain, -8.4)

        # A later refresh without GAIN keeps the value we already learned.
        t2 = library.upsert_track(raw_track(1, "Loud"), root, "FLAC")
        self.assertAlmostEqual(t2.gain, -8.4)

        # A track with no GAIN at all stays null (never normalized).
        t3 = library.upsert_track(raw_track(2, "Unknown"), root, "FLAC")
        self.assertIsNone(t3.gain)

    def test_replaygain_tag_metadata(self):
        # The gain is also carried into the archived file's tags (ReplayGain),
        # so it travels with the FLAC/MP3 like the cover — readable by other
        # players (e.g. Subsonic clients) offline. Here we verify the tag value
        # the writer emits (the mutagen write itself is best-effort and guarded).
        from supysonic.deezer.metadata import meta_from_gw, _replaygain_tag

        info = raw_track(1, "Loud")
        info["GAIN"] = "-8.4"
        self.assertEqual(meta_from_gw(info)["gain"], "-8.4")

        # Deezer GAIN is the loudness; the ReplayGain adjustment is -(GAIN+18.4).
        self.assertEqual(_replaygain_tag("-8.4"), "-10.00 dB")  # -(-8.4+18.4)
        self.assertEqual(_replaygain_tag(-18.4), "0.00 dB")  # reference → no change
        self.assertEqual(_replaygain_tag(-24), "5.60 dB")  # quiet track → boost
        self.assertIsNone(_replaygain_tag(None))
        self.assertIsNone(_replaygain_tag(""))
        self.assertIsNone(_replaygain_tag("nan-ish"))

    def test_find_local_track_is_network_free(self):
        # An imported track is found by its Deezer id with a pure DB lookup, so
        # streaming archived audio never needs Deezer (offline resilience).
        from supysonic.deezer import archive, library

        root = library.get_root_folder(self.archive_dir)
        library.upsert_track(raw_track(42, "Hello"), root, "FLAC")
        found = archive.find_local_track("42")
        self.assertIsNotNone(found)
        self.assertEqual(found.id, ids.track_uuid("42"))
        self.assertIsNone(archive.find_local_track("999"))

    def test_scan_local_imports_and_spares_deezer(self):
        from supysonic.deezer import library, local

        root = library.get_root_folder(self.archive_dir)
        # A lazy Deezer row (no file on disk) must survive the local scan.
        library.upsert_track(raw_track(5, "Deezer Song"), root, "FLAC")

        d = os.path.join(self.archive_dir, "Some Artist", "Some Album")
        os.makedirs(d, exist_ok=True)
        fpath = os.path.join(d, "song.mp3")
        with open(fpath, "wb") as fh:
            fh.write(b"\x00")

        class FakeTag:
            title = "My Song"
            artist = "Some Artist"
            albumartist = None
            album = "Some Album"
            genre = "Rock"
            disc = 1
            track = 3
            year = 2020
            length = 200.0
            bitrate = 320000
            images = []

        orig = local._load_tag
        local._load_tag = lambda p: FakeTag() if p == fpath else None
        try:
            out = local.scan_local(self.archive_dir)
        finally:
            local._load_tag = orig

        self.assertEqual(out["added"], 1)
        t = Track[ids.local_track_uuid(fpath)]
        self.assertIsNone(t.deezer_id)  # the "local" marker
        self.assertEqual(t.title, "My Song")
        self.assertEqual(t.genre, "Rock")
        self.assertEqual(t.bitrate, 320)
        # The lazy Deezer track is untouched.
        self.assertIsNotNone(Track.get_or_none(Track.id == ids.track_uuid("5")))
        # Idempotent: a second scan adds nothing and doesn't prune the present file.
        out2 = local.scan_local(self.archive_dir)
        self.assertEqual(out2["added"], 0)
        self.assertEqual(out2["removed"], 0)

    # -- importer: playlists ---------------------------------------------

    def test_sync_playlists(self):
        gw = self.provider._dz.gw
        gw.playlists = [{"id": "100", "title": "My Playlist", "description": "d"}]
        gw.playlist_tracks["100"] = [raw_track(1, "A", num=1), raw_track(2, "B", num=2)]

        imp = importer.DeezerImporter(self.provider, "alice")
        n = imp.sync_playlists()
        self.assertEqual(n, 1)

        pl = Playlist.get(Playlist.deezer_id == "100")
        self.assertEqual(pl.name, "My Playlist")
        self.assertEqual(pl.user, User.get(name="alice"))
        self.assertEqual([t.deezer_id for t in pl.get_tracks()], ["1", "2"])

        # Re-sync is idempotent (no duplicate playlist / tracks)
        imp.sync_playlists()
        self.assertEqual(Playlist.select().where(Playlist.deezer_id == "100").count(), 1)
        self.assertEqual(len(pl.get_tracks()), 2)

    def test_sync_keeps_archived_track_gone_from_deezer(self):
        # A downloaded (archived) track that Deezer stops returning — e.g. it went
        # unavailable — must stay in the playlist; a dropped track we never
        # archived is correctly removed.
        gw = self.provider._dz.gw
        gw.playlists = [{"id": "100", "title": "Mix", "description": None}]
        gw.playlist_tracks["100"] = [
            raw_track(1, "Keep", num=1),
            raw_track(2, "Stay", num=2),
            raw_track(3, "Drop", num=3),
        ]

        imp = importer.DeezerImporter(self.provider, "alice")
        imp.sync_playlists()

        # Archive track 1 only (a real file on disk).
        t1 = Track.get(Track.deezer_id == "1")
        os.makedirs(os.path.dirname(t1.path), exist_ok=True)
        with open(t1.path, "wb") as fh:
            fh.write(b"flac")

        # Deezer now returns only track 2 (1 went unavailable, 3 was removed).
        gw.playlist_tracks["100"] = [raw_track(2, "Stay", num=2)]
        imp.sync_playlists()

        pl = Playlist.get(Playlist.deezer_id == "100")
        got = [t.deezer_id for t in pl.get_tracks()]
        self.assertIn("1", got)  # archived → preserved
        self.assertIn("2", got)  # still on Deezer
        self.assertNotIn("3", got)  # dropped and not archived → removed

    def test_sync_large_playlist_is_fast(self):
        import time

        # 2000 tracks across ~100 albums/artists (exercises the import cache).
        gw = self.provider._dz.gw
        gw.playlists = [{"id": "500", "title": "Big", "description": None}]
        big = [
            raw_track(
                i,
                f"T{i}",
                art=(str(i % 100), f"Art{i % 100}"),
                alb=(str(i % 100), f"Alb{i % 100}"),
                num=i,
            )
            for i in range(1, 2001)
        ]
        gw.playlist_tracks["500"] = big

        imp = importer.DeezerImporter(self.provider, "alice")
        start = time.monotonic()
        imp.sync_playlists()
        elapsed = time.monotonic() - start

        pl = Playlist.get(Playlist.deezer_id == "500")
        self.assertEqual(len(pl.get_tracks()), 2000)
        self.assertEqual(Artist.select().count(), 100)
        # Single transaction + bulk insert: thousands of rows in well under a
        # second on any sane machine. Generous bound to avoid CI flakiness.
        self.assertLess(elapsed, 15, f"import too slow: {elapsed:.1f}s")

    # -- importer: favorites + unstar ------------------------------------

    def test_sync_favorites_and_unlove(self):
        gw = self.provider._dz.gw
        gw.tracks_by_id = {"1": raw_track(1, "A"), "2": raw_track(2, "B")}
        gw.fav_ids = [1, 2]

        imp = importer.DeezerImporter(self.provider, "alice")
        self.assertEqual(imp.sync_favorites(), 2)
        alice = User.get(name="alice")
        self.assertEqual(
            StarredTrack.select().where(StarredTrack.user == alice).count(), 2
        )

        # Unlove track 2 on Deezer -> star removed locally on next sync
        gw.fav_ids = [1]
        imp.sync_favorites()
        starred = {
            s.starred_id for s in StarredTrack.select().where(StarredTrack.user == alice)
        }
        self.assertIn(ids.track_uuid("1"), starred)
        self.assertNotIn(ids.track_uuid("2"), starred)

    # -- archive: fetch + extension fix ----------------------------------

    def test_ensure_archived_writes_file_and_updates_row(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        track = library.upsert_track(raw_track(7, "Lazy"), root, "FLAC")
        self.assertTrue(track.path.endswith(".flac"))

        info = raw_track(7, "Lazy")
        info["GAIN"] = "-6.2"  # authoritative loudness from the resolve response

        # Pretend FLAC is unavailable: we only get MP3_320 back.
        def fake_resolve(sng_id, quality=None):
            return ("http://x/stream", "MP3_320", info, sng_id)

        def fake_download(url, track_id, dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(b"\x00" * 4096)

        self.provider.resolve = fake_resolve
        self.provider.download_to = fake_download
        self.provider.fetch_cover = lambda md5, size=1000: None

        archive.ensure_archived(self.provider, track)

        # Extension corrected to .mp3, file present, bitrate computed.
        self.assertTrue(track.path.endswith(".mp3"))
        self.assertTrue(os.path.isfile(track.path))
        self.assertGreater(track.bitrate, 0)
        reloaded = Track[ids.track_uuid("7")]
        self.assertTrue(reloaded.path.endswith(".mp3"))
        # The loudness gain is archived on the row alongside bitrate/art.
        self.assertAlmostEqual(reloaded.gain, -6.2)

    def test_archiving_takes_the_full_metadata_not_just_the_audio(self):
        """A row often starts life from a playlist listing, which carries a
        subset of the fields. Once the audio is archived, that row IS the
        metadata — Deezer may never answer about this track again — so the
        richer song.getData payload has to land on it."""
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        # A thin import: no track/disc number, no release date, no credits.
        thin = raw_track(9, "Thin")
        for key in ("TRACK_NUMBER", "DISK_NUMBER", "PHYSICAL_RELEASE_DATE", "ARTISTS"):
            thin.pop(key, None)
        track = library.upsert_track(thin, root, "FLAC")
        self.assertFalse(track.year)

        # …and the authoritative payload that comes back when we fetch the audio.
        full = raw_track(9, "Thin")
        full.update(
            {
                "TRACK_NUMBER": "4",
                "DISK_NUMBER": "2",
                "PHYSICAL_RELEASE_DATE": "2021-05-03",
                "GAIN": "-8.5",
                "ISRC": "FRX123456789",
                "ARTISTS": [
                    {"ART_ID": "1", "ART_NAME": "Artist", "ARTISTS_SONGS_ORDER": "0"},
                    {"ART_ID": "77", "ART_NAME": "Guest", "ARTISTS_SONGS_ORDER": "1"},
                ],
            }
        )
        self.provider.resolve = lambda sng_id, quality=None: (
            "http://x/stream", "FLAC", full, sng_id
        )

        def fake_download(url, track_id, dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(b"\x00" * 4096)

        self.provider.download_to = fake_download
        self.provider.fetch_cover = lambda md5, size=1000: None

        archive.ensure_archived(self.provider, track)

        row = Track[ids.track_uuid("9")]
        self.assertEqual(row.number, 4)
        self.assertEqual(row.disc, 2)
        self.assertEqual(row.year, 2021)
        self.assertAlmostEqual(row.gain, -8.5)
        self.assertIn("Guest", [a.name for a, _role in row.credited_artists()])

        # And the sidecar, so the archive describes itself even if the database
        # is lost: ids and roles that no audio tag can hold.
        meta = library.read_track_metadata(row)
        self.assertIsNotNone(meta)
        self.assertEqual(meta["deezer_id"], "9")
        self.assertEqual(meta["gw"]["ISRC"], "FRX123456789")
        self.assertIn("Guest", [c["name"] for c in meta["credits"]])

    def test_the_metadata_sidecar_never_stores_a_credential(self):
        """The gateway payload also carries stream tokens. Those are secrets
        with no business in a file that outlives the session."""
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        track = library.upsert_track(raw_track(11, "Tokens"), root, "FLAC")
        info = raw_track(11, "Tokens")
        info.update(
            {"TRACK_TOKEN": "secret-token", "MEDIA": [{"HREF": "https://signed/url"}]}
        )
        library.save_track_metadata(track, info)

        with open(library.metadata_path(track), encoding="utf-8") as fh:
            raw = fh.read()
        self.assertNotIn("secret-token", raw)
        self.assertNotIn("signed/url", raw)

    def test_ensure_archived_writes_cover_sidecar(self):
        # The album art is archived on disk (cover.jpg next to the audio) and
        # then served locally with no Deezer call — like the sound itself.
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        track = library.upsert_track(raw_track(8, "Art"), root, "FLAC")
        info = raw_track(8, "Art")

        self.provider.resolve = lambda sng_id, quality=None: (
            "http://x/stream", "MP3_320", info, sng_id
        )

        def fake_download(url, track_id, dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(b"\x00" * 4096)

        fetches = []
        self.provider.download_to = fake_download
        self.provider.fetch_cover = lambda md5, size=1000: (
            fetches.append(md5) or b"JPEGDATA"
        )

        archive.ensure_archived(self.provider, track)

        # cover.jpg written in the album folder and the Folder marked for it.
        folder = Track[ids.track_uuid("8")].folder
        cover_path = os.path.join(folder.path, "cover.jpg")
        self.assertTrue(os.path.isfile(cover_path))
        self.assertEqual(folder.cover_art, "cover.jpg")
        with open(cover_path, "rb") as fh:
            self.assertEqual(fh.read(), b"JPEGDATA")

        # Now the album cover resolves from disk without touching Deezer.
        fetches.clear()

        class FakeCache:
            def set(self, k, v):  # would only be hit on a Deezer fallback
                raise AssertionError("should serve the local sidecar")

        got = archive.deezer_cover_path(
            self.provider, FakeCache(), str(track.album_id)
        )
        self.assertEqual(got, cover_path)
        self.assertEqual(fetches, [])  # no Deezer fetch

    # -- resolve: expired-session recovery --------------------------------

    class _FakeDz:
        """A dz whose media URL calls work only when `alive` (expired license
        tokens make get_track_url fail for every quality until a re-login)."""

        def __init__(self, alive):
            self.alive = alive
            self.gw = self
            self.current_user = {"can_stream_lossless": True}

        def get_track(self, sng_id):
            return raw_track(sng_id)

        def get_track_url(self, token, fmt):
            return "http://x/media" if self.alive else None

    def test_resolve_relogins_on_expired_session(self):
        relogins = []
        self.provider._dz = self._FakeDz(alive=False)

        def fake_relogin():
            relogins.append(1)
            self.provider._dz = self._FakeDz(alive=True)
            return self.provider._dz

        self.provider.relogin = fake_relogin

        url, fmt, info, used_id = self.provider.resolve("7")
        self.assertEqual(url, "http://x/media")
        self.assertEqual(fmt, "FLAC")
        self.assertEqual(relogins, [1])

    def test_resolve_no_relogin_when_session_is_fresh(self):
        # A resolve failing right after a re-login is a genuinely unavailable
        # track: raise instead of hammering the login endpoint.
        import time

        from supysonic.deezer.provider import DeezerError

        relogins = []
        self.provider._dz = self._FakeDz(alive=False)
        self.provider._last_relogin = time.monotonic()
        self.provider.relogin = lambda: relogins.append(1)

        with self.assertRaises(DeezerError):
            self.provider.resolve("7")
        self.assertEqual(relogins, [])

    # -- push: playlist reconcile (Subsonic -> Deezer) -------------------

    def test_push_reconcile_playlist(self):
        from supysonic.deezer import library, push

        root = library.get_root_folder(self.archive_dir)
        t1 = library.upsert_track(raw_track(1, "A"), root, "FLAC")
        t2 = library.upsert_track(raw_track(2, "B"), root, "FLAC")
        gw = self.provider._dz.gw

        pl = Playlist.create(user=User.get(name="alice"), name="Mix")
        pl.add(t1)
        pl.add(t2)

        # First push -> creates the Deezer playlist and stores its id
        push.reconcile_playlist(self.provider, pl)
        self.assertEqual(len(gw.created), 1)
        self.assertEqual(gw.created[0], ("Mix", ["1", "2"]))
        self.assertEqual(pl.deezer_id, "999")

        # Now Deezer has tracks 1,2. Add a 3rd locally, drop the 1st -> diff push
        gw.playlist_tracks["999"] = [{"SNG_ID": "1"}, {"SNG_ID": "2"}]
        t3 = library.upsert_track(raw_track(3, "C"), root, "FLAC")
        pl.clear()
        pl.add(t2)
        pl.add(t3)
        push.reconcile_playlist(self.provider, pl)
        self.assertEqual(gw.added[-1], ("999", ["3"]))
        self.assertEqual(gw.removed[-1], ("999", ["1"]))

    def test_push_reconcile_skips_reco_playlists(self):
        from supysonic.deezer import push

        gw = self.provider._dz.gw
        pl = Playlist.create(user=User.get(name="alice"), name="Deezer · Flow")
        push.reconcile_playlist(self.provider, pl)
        self.assertEqual(gw.created, [])
        self.assertIsNone(pl.deezer_id)

    # -- push: favorites -------------------------------------------------

    def test_push_favorite(self):
        from supysonic.deezer import push

        gw = self.provider._dz.gw
        push.push_favorite(self.provider, "Track", "5", True)
        push.push_favorite(self.provider, "Track", "5", False)
        push.push_favorite(self.provider, "Folder", "9", True)  # unsupported -> no-op
        self.assertEqual(gw.fav_added, ["5"])
        self.assertEqual(gw.fav_removed, ["5"])

    # -- cover art for Deezer entities -----------------------------------

    def test_deezer_entities_expose_coverart(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive_dir)
        t = library.upsert_track(
            raw_track(1, "S", art=("9", "Art9"), alb=("10", "Alb"), pic="covermd5"),
            root,
            "FLAC",
        )
        alice = User.get(name="alice")

        child = t.as_subsonic_child(alice, None)
        # Not archived yet -> cover points at the album (fetched from Deezer).
        self.assertEqual(child["coverArt"], str(t.album_id))

        alb = Album[ids.album_uuid("10")]
        self.assertEqual(alb.as_subsonic_album(alice)["coverArt"], str(alb.id))

        art = Artist[ids.artist_uuid("9")]
        self.assertEqual(art.as_subsonic_artist(alice)["coverArt"], str(art.id))

        pl = Playlist.create(user=alice, name="P", deezer_id="77")
        self.assertEqual(pl.as_subsonic_playlist(alice)["coverArt"], str(pl.id))

    def test_deezer_cover_path_routes_by_type(self):
        import os
        from supysonic.deezer import archive, library

        root = library.get_root_folder(self.archive_dir)
        t = library.upsert_track(
            raw_track(1, "S", art=("9", "Art9"), alb=("10", "Alb"), pic="md5cover"),
            root,
            "FLAC",
        )
        calls = []
        self.provider.fetch_cover = lambda md5, size=1000: b"album" if md5 else None
        self.provider.fetch_image = (
            lambda kind, did, size="xl": calls.append((kind, str(did))) or b"img"
        )

        class FakeCache:
            def __init__(self, d):
                self.d = d

            def set(self, k, v):
                p = os.path.join(self.d, k.replace("/", "_"))
                with open(p, "wb") as fh:
                    fh.write(v)
                return p

        cache = FakeCache(self.archive_dir)

        p = archive.deezer_cover_path(self.provider, cache, str(t.album_id))
        self.assertTrue(p and os.path.isfile(p))  # album -> md5 cover

        archive.deezer_cover_path(self.provider, cache, str(t.artist.id))
        self.assertIn(("artist", "9"), calls)

        pl = Playlist.create(user=User.get(name="alice"), name="P", deezer_id="77")
        archive.deezer_cover_path(self.provider, cache, str(pl.id))
        self.assertIn(("playlist", "77"), calls)

    # -- smart tracklists (new releases, discovery, inspired-by, ...) -----

    def test_smart_tracklists(self):
        gw = self.provider._dz.gw
        gw.smart_tracklists["new-releases"] = {
            "DATA": {"TITLE": "Nouveautés"},
            "SONGS": {"data": [raw_track(201, "NR1"), raw_track(202, "NR2")]},
        }
        gw.smart_tracklists["discovery"] = {
            "DATA": {"TITLE": "Découverte"},
            "SONGS": {"data": [raw_track(203, "D1")]},
        }
        # "empty-one" returns nothing -> skipped, no playlist

        imp = importer.DeezerImporter(self.provider, "alice")
        out = imp.sync_smart_tracklists(["new-releases", "discovery", "empty-one"])

        self.assertEqual(out, {"new-releases": 2, "discovery": 1})

        nr = Playlist.get(Playlist.id == ids.playlist_uuid("smart:new-releases"))
        self.assertEqual(nr.name, "Deezer · Nouveautés")
        self.assertEqual([t.deezer_id for t in nr.get_tracks()], ["201", "202"])

        disc = Playlist.get(Playlist.id == ids.playlist_uuid("smart:discovery"))
        self.assertEqual(disc.name, "Deezer · Découverte")

        with self.assertRaises(Playlist.DoesNotExist):
            Playlist.get(Playlist.id == ids.playlist_uuid("smart:empty-one"))

    def test_smart_ids_from_config(self):
        self.assertEqual(
            importer.smart_ids_from_config({"smart_tracklists": "new-releases, discovery"}),
            ["new-releases", "discovery"],
        )
        self.assertEqual(
            importer.smart_ids_from_config({}), importer.DEFAULT_SMART_TRACKLISTS
        )

    # -- prefetch worker -------------------------------------------------

    def test_prefetcher_archives_in_background(self):
        from supysonic.deezer import library
        from supysonic.deezer.prefetch import DeezerPrefetcher

        root = library.get_root_folder(self.archive_dir)
        track = library.upsert_track(raw_track(11, "Pre"), root, "FLAC")
        info = raw_track(11, "Pre")

        self.provider.resolve = lambda sng_id, quality=None: ("u", "FLAC", info, sng_id)

        def fake_dl(url, tid, dest):
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(b"\x00" * 2048)

        self.provider.download_to = fake_dl
        self.provider.fetch_cover = lambda md5, size=1000: None

        pf = DeezerPrefetcher(self.provider, workers=1)
        pf.enqueue(track)
        pf.enqueue(track)  # dedup: same track only fetched once
        pf._queue.join()

        self.assertTrue(os.path.isfile(track.path))


if __name__ == "__main__":
    unittest.main()

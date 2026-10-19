# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot B of the multi-provider plan: Deezer, YouTube and the local files behind
the provider interface, and the HTTP they share. Nothing here touches the
network: the Deezer client is a stub that counts what it is asked, YouTube's
functions are replaced, and the question every test keeps asking is the
resilience rule's: a failure to REACH a provider is never a verdict."""

import collections
import os
import shutil
import tempfile
import unittest
from unittest import mock

import requests

from deezerpy._circuit import breaker
from deezerpy.errors import DeezerUnavailable
from deezerpy.errors import GWAPIError

from supysonic import db as dbmod
from supysonic.db import Folder, Meta, Track, TrackSource, init_database, release_database
from supysonic.deezer import ids
from supysonic.deezer import youtube as yt
from supysonic.deezer.provider import DeezerError, DeezerProvider, ShowUnavailable, TrackUnavailable
from supysonic.providers import (
    CapabilityMissing,
    Gone,
    NotFound,
    ProviderAuth,
    ProviderError,
    ProviderHeld,
    ProviderUnavailable,
    Registry,
    base,
    http,
)
from supysonic.providers.builtin import register_builtin
from supysonic.providers.deezer import DeezerAdapter, hit_from_gw
from supysonic.providers.fake import tiny_wav
from supysonic.providers.local import LocalProvider
from supysonic.providers.registry import MemoryStore
from supysonic.providers.youtube import YoutubeAdapter


# -- a Deezer client that counts ---------------------------------------------------


def gw_track(sid="111", **extra):
    out = {
        "SNG_ID": sid, "SNG_TITLE": "Song", "ART_NAME": "Artist", "ART_ID": "500",
        "ALB_TITLE": "Album", "ALB_ID": "600", "ALB_PICTURE": "abc123",
        "DURATION": "200", "TRACK_NUMBER": "3", "DISK_NUMBER": "1", "ISRC": "FR1234567890",
        "PHYSICAL_RELEASE_DATE": "2001-02-03", "EXPLICIT_LYRICS": "1",
        "TRACK_TOKEN": "tok", "FILESIZE_FLAC": "30000000", "FILESIZE_MP3_320": "9000000",
        "FILESIZE_MP3_128": "4000000",
    }
    out.update(extra)
    return out


class Section:
    """``gw`` or ``api``: every method counts its call and answers from
    ``answers`` (a value, or an exception to raise)."""

    def __init__(self, calls, prefix, answers):
        self._calls, self._prefix, self._answers = calls, prefix, answers

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        def call(*args, **kwargs):
            self._calls.append(self._prefix + name)
            answer = self._answers.get(self._prefix + name, {"data": []})
            if isinstance(answer, BaseException):
                raise answer
            return answer(*args, **kwargs) if callable(answer) else answer

        return call


class StubDz:
    def __init__(self, answers=None, lossless=True):
        self.calls = []
        self.answers = {"gw.get_track": gw_track()}
        self.answers.update(answers or {})
        self.gw = Section(self.calls, "gw.", self.answers)
        self.api = Section(self.calls, "api.", self.answers)
        self.current_user = {"id": 42, "name": "tester", "can_stream_lossless": lossless}


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def adapter_on(dz, archive="/nonexistent"):
    provider = DeezerProvider("arl", archive, "FLAC")
    provider._dz = dz
    return DeezerAdapter(lambda: provider), provider


class DeezerAdapterTestCase(unittest.TestCase):
    def tearDown(self):
        for host in ("api.deezer.com", "www.deezer.com"):
            breaker.reset(host)

    # -- translating what Deezer says ---------------------------------------------

    def test_a_track_is_a_normalised_hit(self):
        hit = hit_from_gw(gw_track())
        self.assertEqual(hit["ref"], "111")
        self.assertEqual(hit["title"], "Song")
        self.assertEqual(hit["artists"], [{"ref": "500", "name": "Artist"}])
        self.assertEqual(hit["album"], {"ref": "600", "name": "Album"})
        self.assertEqual(
            (hit["duration"], hit["number"], hit["disc"], hit["isrc"], hit["release_date"]),
            (200, 3, 1, "FR1234567890", "2001-02-03"),
        )
        self.assertTrue(hit["explicit"])
        self.assertIn("abc123", hit["cover_url"])

    def test_search_is_one_public_api_call_per_kind_and_normalised(self):
        dz = StubDz({"api.search_track": {"data": [
            {"id": 1, "title": "T", "duration": 99, "artist": {"id": 5, "name": "A"},
             "album": {"id": 7, "title": "Al", "cover_xl": "https://x/c.jpg"}},
            {"title": "no id"},
        ]}})
        adapter, _ = adapter_on(dz)
        result = adapter.search("q", kinds=("track",), limit=5)
        self.assertEqual(dz.calls, ["api.search_track"])
        self.assertEqual([t["ref"] for t in result["tracks"]], ["1"])
        self.assertEqual(result["tracks"][0]["album"], {"ref": "7", "name": "Al"})
        self.assertEqual(result["albums"], [])

    def test_offers_follow_the_files_deezer_lists_and_the_accounts_licence(self):
        adapter, _ = adapter_on(StubDz())
        offers = adapter.offers("111")
        self.assertEqual([(o["fmt"], o["bitrate"]) for o in offers],
                         [("flac", 1000), ("mp3", 320), ("mp3", 128)])
        self.assertTrue(offers[0]["quality"] > offers[1]["quality"] > offers[2]["quality"])
        adapter, _ = adapter_on(StubDz(lossless=False))
        self.assertEqual([o["fmt"] for o in adapter.offers("111")], ["mp3", "mp3"])
        # no file size listed at all: the licence is the answer
        adapter, _ = adapter_on(StubDz({"gw.get_track": gw_track(
            FILESIZE_FLAC="0", FILESIZE_MP3_320="0", FILESIZE_MP3_128="0")}))
        self.assertEqual(len(adapter.offers("111")), 3)

    def test_an_album_is_its_full_tracklist_never_the_pages_first_few(self):
        dz = StubDz({
            "gw.get_album_page": {"DATA": {"ALB_TITLE": "Al", "ART_ID": "5", "ART_NAME": "A"},
                                  "SONGS": {"data": [gw_track("1"), gw_track("2")]}},
            "gw.get_album_tracks": [gw_track(str(i)) for i in range(1, 41)],
        })
        adapter, _ = adapter_on(dz)
        album = adapter.get_album("600")
        self.assertEqual(len(album["tracks"]), 40)
        self.assertEqual(album["title"], "Al")
        self.assertIn("gw.get_album_tracks", dz.calls)

    def test_a_playlist_is_its_full_tracklist(self):
        dz = StubDz({
            "gw.get_playlist_page": {"DATA": {"TITLE": "Mix", "PARENT_USERNAME": "me"}},
            "gw.get_playlist_tracks": [gw_track(str(i)) for i in range(1, 31)],
        })
        playlist = adapter_on(dz)[0].get_playlist("9")
        self.assertEqual((playlist["title"], len(playlist["tracks"])), ("Mix", 30))

    def test_links_are_read_without_asking_anyone(self):
        dz = StubDz()
        adapter, _ = adapter_on(dz)
        self.assertEqual(adapter.parse_link("https://www.deezer.com/fr/album/302127"),
                         {"provider": "deezer", "kind": "album", "ref": "302127"})
        self.assertEqual(adapter.parse_link("https://deezer.com/track/3135556")["kind"], "track")
        for bad in ("https://evil.example/album/1", "https://www.deezer.com/album/x",
                    "ftp://deezer.com/album/1", "", None):
            self.assertIsNone(adapter.parse_link(bad))
        self.assertEqual(dz.calls, [])

    # -- the rule: no failure to reach Deezer is a verdict ------------------------

    def test_transport_trouble_is_never_gone_whatever_asks(self):
        outage = DeezerUnavailable("api.deezer.com is down")
        wrapped = DeezerError("cannot reach Deezer to resolve track 111: x")
        wrapped.__cause__ = outage
        for answers in (
            {"gw.get_track": outage},
            {"gw.get_track": requests.ConnectionError("reset")},
            {"gw.get_track": requests.Timeout("slow")},
            {"gw.get_track": wrapped},
        ):
            adapter, _ = adapter_on(StubDz(answers))
            for call in (
                lambda a: a.offers("111"),
                lambda a: a.get_track("111"),
                lambda a: a.fetch("111", {"fmt": "flac"}, "/tmp/never"),
                lambda a: list(a.open_stream("111", {"fmt": "flac"})),
                lambda a: a.fetch_cover("111"),
            ):
                with self.assertRaises(ProviderUnavailable) as caught:
                    call(adapter)
                self.assertNotIsInstance(caught.exception, NotFound)

    def test_an_open_circuit_answers_at_once_and_is_not_a_verdict(self):
        adapter, provider = adapter_on(StubDz())
        # monotonic() counts from boot: 0.0 would read "checked just now" on a young machine
        provider._last_check = float("-inf")
        for _ in range(3):
            breaker.on_failure("api.deezer.com", requests.ConnectionError("x"), False)
        self.assertFalse(adapter.available())
        self.assertEqual(adapter.health()["status"], base.HEALTH_NETWORK)
        self.assertTrue(adapter.configured())  # an outage is not "never set up"

    def test_only_a_deezer_answer_makes_a_track_or_a_show_gone(self):
        dz = StubDz()
        adapter, provider = adapter_on(dz)
        provider.resolve = mock.Mock(side_effect=TrackUnavailable("no source"))
        with self.assertRaises(Gone):
            adapter.fetch("111", {"fmt": "flac"}, "/tmp/never")
        provider.get_show_page = mock.Mock(side_effect=ShowUnavailable("gone"))
        with self.assertRaises(Gone):
            adapter.get_show("77")

    def test_an_answer_that_is_not_a_verdict_condemns_nothing(self):
        adapter, _ = adapter_on(StubDz({"gw.get_track": GWAPIError("DATA_ERROR")}))
        with self.assertRaises(ProviderError) as caught:
            adapter.get_track("111")
        self.assertNotIsInstance(caught.exception, (NotFound, ProviderUnavailable))

    def test_a_dead_arl_is_an_auth_error_and_says_nothing_about_the_track(self):
        adapter, provider = adapter_on(StubDz())
        provider._dz = None
        provider._login_error = ("arl", "Deezer rejected the ARL")
        provider._login_retry_at = float("inf")
        with self.assertRaises(ProviderAuth):
            adapter.offers("111")
        self.assertEqual(adapter.health()["status"], base.HEALTH_AUTH)
        self.assertEqual(adapter.account()["status"], base.HEALTH_AUTH)

    def test_an_id_that_is_not_numeric_never_reaches_deezer(self):
        dz = StubDz()
        adapter, _ = adapter_on(dz)
        for ref in ("../etc/passwd", "1; DROP", "", "12" * 20, None):
            for call in (adapter.offers, adapter.get_track, adapter.get_album,
                         adapter.get_artist, adapter.get_playlist, adapter.fetch_cover,
                         adapter.get_show, adapter.get_episodes, adapter.get_artist_albums):
                with self.assertRaises(ProviderError):
                    call(ref)
        self.assertEqual(dz.calls, [])

    # -- audio --------------------------------------------------------------------

    def test_fetch_resolves_the_offers_quality_and_downloads_to_dest(self):
        adapter, provider = adapter_on(StubDz())
        provider.resolve = mock.Mock(return_value=("https://cdn/x", "FLAC", {}, "112"))
        provider.download_to = mock.Mock()
        adapter.fetch("111", {"fmt": "flac"}, "/tmp/out.flac")
        provider.resolve.assert_called_once_with("111", "FLAC")
        args = provider.download_to.call_args[0]
        self.assertEqual((args[0], args[1], str(args[2])), ("https://cdn/x", "112", "/tmp/out.flac"))
        adapter.fetch("111", {"fmt": "mp3", "bitrate": 128}, "/tmp/out.mp3")
        self.assertEqual(provider.resolve.call_args[0], ("111", "MP3_128"))

    def test_open_stream_hands_on_the_first_block_after_checking_it(self):
        adapter, provider = adapter_on(StubDz())
        provider.resolve = mock.Mock(return_value=("https://cdn/x", "FLAC", {}, "111"))
        provider.iter_decrypted = lambda url, tid: iter([b"fLaC1", b"2", b"3"])
        self.assertEqual(b"".join(adapter.open_stream("111", {"fmt": "flac"})), b"fLaC123")
        provider.iter_decrypted = mock.Mock(side_effect=DeezerError("did not decrypt to audio"))
        with self.assertRaises(ProviderError):
            list(adapter.open_stream("111", {"fmt": "flac"}))

    def test_the_cover_comes_from_the_tracks_picture(self):
        adapter, provider = adapter_on(StubDz())
        provider.fetch_cover = mock.Mock(return_value=b"\xff\xd8jpg")
        self.assertEqual(adapter.fetch_cover("111", 500), b"\xff\xd8jpg")
        provider.fetch_cover.assert_called_once_with("abc123", 500)
        provider.fetch_cover = mock.Mock(return_value=None)
        with self.assertRaises(ProviderError):
            adapter.fetch_cover("111")

    # -- the account: read only ---------------------------------------------------

    def test_import_account_only_reads(self):
        dz = StubDz({
            "gw.get_user_playlists": [{"id": "9", "title": "Mine", "description": "d"}],
            "gw.get_playlist_tracks": [gw_track("1"), gw_track("2")],
            "gw.get_user_favorite_ids": {"data": [{"SNG_ID": "1"}, {"SNG_ID": "2"}]},
            "gw.get_tracks": [gw_track("1"), gw_track("2")],
        })
        adapter, _ = adapter_on(dz)
        items = list(adapter.import_account())
        self.assertEqual([i["kind"] for i in items], ["playlist", "favorites"])
        self.assertEqual(len(items[0]["tracks"]), 2)
        self.assertEqual(
            set(dz.calls),
            {"gw.get_user_playlists", "gw.get_playlist_tracks",
             "gw.get_user_favorite_ids", "gw.get_tracks"},
        )

    # -- health, configuration ----------------------------------------------------

    def test_health_and_configuration(self):
        adapter, provider = adapter_on(StubDz())
        provider.check_login = mock.Mock(return_value={"ok": True, "account": "tester"})
        self.assertEqual(adapter.health()["status"], base.HEALTH_OK)
        self.assertEqual(adapter.account(), {"name": "tester", "status": "ok"})
        provider.check_login = mock.Mock(return_value={"ok": False, "reason": "arl", "detail": "dead"})
        self.assertEqual(adapter.health(force=True), {"status": "auth", "detail": "dead"})
        provider.check_login.assert_called_with(force=True)
        none = DeezerAdapter(lambda: None)
        self.assertFalse(none.configured() or none.available())
        self.assertEqual(none.health()["status"], base.HEALTH_AUTH)
        schema = adapter.config_schema()
        self.assertEqual([(f["key"], f["masked"]) for f in schema], [("arl", True)])
        with self.assertRaises(ProviderUnavailable):
            none.search("q")

    def test_the_adapter_follows_the_object_the_app_swaps(self):
        """setup_deezer replaces app.deezer when an admin saves a new ARL."""
        box = [None]
        adapter = DeezerAdapter(lambda: box[0])
        self.assertFalse(adapter.configured())
        box[0] = DeezerProvider("arl", "/x", "FLAC")
        self.assertTrue(adapter.configured())


# -- YouTube -------------------------------------------------------------------------


class YoutubeAdapterTestCase(unittest.TestCase):
    VID = "dQw4w9WgXcQ"

    def setUp(self):
        yt.reset()
        self.addCleanup(yt.reset)
        patch = mock.patch.object(yt, "installed", return_value=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.adapter = YoutubeAdapter()
        self.adapter.switch = lambda: True  # no database here

    def raw_hit(self):
        return yt.normalize_hit({
            "videoId": self.VID, "title": "Song",
            "artists": [{"id": "UC1", "name": "Artist"}],
            "album": {"id": "MPRE1", "name": "Album"}, "duration_seconds": 215,
            "isExplicit": True, "thumbnails": [{"url": "https://i.ytimg.com/x=w60-h60", "width": 60}],
        })

    def test_it_is_the_fallback_and_declares_what_it_does(self):
        self.assertEqual(self.adapter.role, base.FALLBACK)
        self.assertEqual(self.adapter.capabilities, {base.SEARCH, base.AUDIO, base.LINKS})
        base.check_declared(self.adapter)

    def test_search_is_the_one_existing_request_and_the_hit_promises_an_opus_offer(self):
        with mock.patch.object(yt, "search", return_value=[self.raw_hit()]) as search:
            result = self.adapter.search("song", limit=7)
            self.adapter.search("song", kinds=("album",))
        search.assert_called_once_with("song", limit=7)
        track = result["tracks"][0]
        self.assertEqual((track["ref"], track["title"], track["duration"]), (self.VID, "Song", 215))
        self.assertEqual(track["artists"], [{"ref": "UC1", "name": "Artist"}])
        self.assertEqual([(o["fmt"], o["bitrate"]) for o in track["offers"]], [("opus", 133)])

    def test_offers_ask_nobody(self):
        with mock.patch.object(yt, "search") as search, mock.patch.object(yt, "download_audio") as dl:
            self.assertEqual(self.adapter.offers(self.VID)[0]["fmt"], "opus")
        search.assert_not_called()
        dl.assert_not_called()
        with self.assertRaises(ProviderError):
            self.adapter.offers("not a video id")

    def test_a_failure_is_not_gone_and_only_youtubes_answer_is(self):
        with mock.patch.object(yt, "search", side_effect=yt.YoutubeError("boom")):
            with self.assertRaises(ProviderUnavailable):
                self.adapter.search("q")
        with mock.patch.object(yt, "download_audio", side_effect=yt.YoutubeUnavailable("removed")):
            with self.assertRaises(Gone):
                self.adapter.fetch(self.VID, {}, "/tmp/never")
        with mock.patch.object(yt, "download_audio", side_effect=yt.YoutubeError("net")):
            with self.assertRaises(ProviderUnavailable) as caught:
                self.adapter.fetch(self.VID, {}, "/tmp/never")
        self.assertNotIsInstance(caught.exception, NotFound)

    def test_a_hold_is_a_held_error_and_switches_availability_off(self):
        yt._hold(60, "YouTube refused the request")
        self.assertFalse(self.adapter.available())
        self.assertTrue(self.adapter.configured())
        with self.assertRaises(ProviderHeld) as caught:
            self.adapter.search("q")
        self.assertGreater(caught.exception.retry_in, 0)
        health = self.adapter.health()
        self.assertEqual(health["status"], base.HEALTH_NETWORK)
        self.assertGreater(health["retry_in"], 0)

    def test_fetch_writes_the_original_stream_to_dest_and_cleans_up(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)

        def produce(video_id, workdir):
            path = os.path.join(workdir, video_id + ".opus")
            with open(path, "wb") as fh:
                fh.write(b"OggS" + b"\0" * 60)
            return path

        dest = os.path.join(d, "sub", "out.opus")
        with mock.patch.object(yt, "download_audio", side_effect=produce):
            self.adapter.fetch(self.VID, {}, dest)
            self.assertEqual(read(dest)[:4], b"OggS")
            self.assertEqual(os.listdir(os.path.dirname(dest)), ["out.opus"])
            self.assertTrue(b"".join(self.adapter.open_stream(self.VID, {})).startswith(b"OggS"))

    def test_not_audio_is_refused(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)

        def produce(video_id, workdir):
            path = os.path.join(workdir, "x.opus")
            with open(path, "wb") as fh:
                fh.write(b"<html>consent wall</html>")
            return path

        dest = os.path.join(d, "out.opus")
        with mock.patch.object(yt, "download_audio", side_effect=produce):
            with self.assertRaises(ProviderUnavailable):
                self.adapter.fetch(self.VID, {}, dest)
        self.assertFalse(os.path.exists(dest))

    def test_links(self):
        parse = self.adapter.parse_link
        self.assertEqual(parse("https://youtu.be/" + self.VID),
                         {"provider": "youtube", "kind": "track", "ref": self.VID})
        self.assertEqual(parse("https://music.youtube.com/watch?v=" + self.VID)["ref"], self.VID)
        self.assertEqual(parse("https://www.youtube.com/playlist?list=PLabcdefghijkl")["kind"], "playlist")
        for bad in ("https://evil.example/watch?v=" + self.VID, "https://youtu.be/short",
                    "javascript:alert(1)", ""):
            self.assertIsNone(parse(bad))


# -- the local files ---------------------------------------------------------------


class _DbCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "t.db")
        release_database()
        init_database("sqlite:///" + self.path)
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.addCleanup(release_database)


class LocalProviderTestCase(_DbCase):
    def upload(self, name="song.wav", data=None):
        folder = Folder.create(name="Music", root=True, path=self.dir)
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(tiny_wav() if data is None else data)
        track = Track.create(
            title="Up", number=1, disc=1, duration=1, has_art=False, bitrate=128,
            path=path, last_modification=1, root_folder=folder, folder=folder,
            album=dbmod.Album.create(name="A", artist=dbmod.Artist.create(name="Z")),
            artist=dbmod.Artist.get(name="Z"),
        )
        return track

    def test_it_offers_the_file_it_holds_and_never_a_source_row(self):
        track = self.upload()
        local = LocalProvider()
        base.check_declared(local)
        offers = local.offers(str(track.id))
        self.assertEqual((offers[0]["fmt"], offers[0]["lossless"]), ("wav", True))
        out = os.path.join(self.dir, "copy.wav")
        local.fetch(str(track.id), offers[0], out)
        original = read(track.path)
        self.assertEqual(read(out), original)
        self.assertEqual(b"".join(local.open_stream(str(track.id), offers[0])), original)
        self.assertEqual(TrackSource.select().count(), 0)

    def test_it_is_audio_only_and_reads_only_the_databases_path(self):
        local = LocalProvider()
        self.assertEqual(local.capabilities, {base.AUDIO})
        for ref in ("../../etc/passwd", "12", ""):
            with self.assertRaises(ProviderError):
                local.offers(ref)
        with self.assertRaises(NotFound):
            local.offers("00000000-0000-0000-0000-000000000001")
        track = self.upload()
        os.remove(track.path)
        with self.assertRaises(NotFound):
            local.offers(str(track.id))


# -- the registry ------------------------------------------------------------------


class RegistrationTestCase(_DbCase):
    def registry(self, deezer=None):
        return register_builtin(Registry(), lambda: deezer)

    def test_the_three_builtins_register_and_are_well_formed(self):
        reg = self.registry(DeezerProvider("arl", "/x", "FLAC"))
        self.assertEqual([p.id for p in reg.all()], ["deezer", "youtube", "local"])
        self.assertEqual([p.role for p in reg.all()], ["main", "fallback", "main"])
        self.assertEqual(reg.require("deezer", base.PODCASTS).id, "deezer")
        with self.assertRaises(CapabilityMissing):
            reg.require("local", base.SEARCH)
        searchable = [p.id for p in reg.with_capability(base.SEARCH)]
        self.assertEqual(searchable, ["deezer", "youtube"] if yt.installed() else ["deezer"])

    def test_an_existing_deezer_config_connects_by_itself(self):
        """[deezer] arl / DEEZER_ARL build app.deezer exactly as before; the
        adapter only follows it, so a server that upgrades needs no setting."""
        provider = DeezerProvider("arl", "/x", "FLAC")
        self.assertIn("deezer", [p.id for p in self.registry(provider).enabled()])
        self.assertNotIn("deezer", [p.id for p in self.registry(None).enabled()])

    def test_an_outage_does_not_switch_deezer_off(self):
        provider = DeezerProvider("arl", "/x", "FLAC")
        reg = self.registry(provider)
        for _ in range(3):
            breaker.on_failure("api.deezer.com", requests.ConnectionError("x"), False)
        try:
            self.assertFalse(provider.available())
            self.assertIn("deezer", [p.id for p in reg.enabled()])
        finally:
            breaker.reset("api.deezer.com")

    def test_the_admins_deezer_switch_still_works(self):
        reg = self.registry(DeezerProvider("arl", "/x", "FLAC"))
        reg.set_enabled("deezer", False)
        self.assertNotIn("deezer", [p.id for p in reg.enabled()])

    def test_the_old_youtube_switch_commands_enabled_both_ways(self):
        from supysonic.webui import youtube as webui_youtube

        self.assertEqual(webui_youtube.ENABLED_KEY, "yt.enabled")
        with mock.patch.object(yt, "installed", return_value=True):
            reg = self.registry()
            self.assertIn("youtube", [p.id for p in reg.enabled()])  # on by default
            Meta.create(key="yt.enabled", value="0")
            reg.get("youtube")._switch = (0.0, None)
            self.assertNotIn("youtube", [p.id for p in reg.enabled()])
            self.assertFalse(webui_youtube.enabled())
            reg.set_enabled("youtube", True)  # writes the legacy key
            self.assertEqual(Meta.get(Meta.key == "yt.enabled").value, "1")
            self.assertTrue(webui_youtube.enabled())
            self.assertIn("youtube", [p.id for p in reg.enabled()])
            self.assertIsNone(Meta.get_or_none(Meta.key == "prov.youtube.on"))

    def test_without_the_extra_youtube_is_off_and_listed(self):
        with mock.patch.object(yt, "installed", return_value=False):
            reg = self.registry()
            self.assertIn("youtube", [p.id for p in reg.all()])
            self.assertNotIn("youtube", [p.id for p in reg.enabled()])

    def test_the_app_registers_them_outside_of_tests(self):
        """The upgrade path: an old config, an existing database."""
        from supysonic.config import DefaultConfig
        from supysonic.web import create_application

        path, cache = os.path.join(self.dir, "app.db"), self.dir

        class Config(DefaultConfig):
            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache)
                self.DEEZER = dict(self.DEEZER, enabled=True, arl="x" * 192, archive_dir=cache)

        release_database()
        with mock.patch("supysonic.web._enrich_backfill", create=True):
            app = create_application(Config())
        self.assertEqual([p.id for p in app.providers.all()][:3], ["deezer", "youtube", "local"])
        self.assertTrue(app.providers.get("deezer").configured())
        self.assertIn("deezer", [p.id for p in app.providers.enabled()])
        # the admin saves a new ARL: setup_deezer swaps the object, nothing re-registers
        before = app.providers.get("deezer")
        app.deezer = None
        self.assertFalse(app.providers.get("deezer").configured())
        self.assertIs(app.providers.get("deezer"), before)


# -- the shared HTTP ---------------------------------------------------------------


class HttpTestCase(unittest.TestCase):
    def tearDown(self):
        breaker.reset("provider-b.example")

    def test_a_session_has_the_default_timeout_and_the_breaker(self):
        seen = {}

        def fake_request(self_, method, url, **kwargs):
            seen["timeout"] = kwargs.get("timeout")
            return mock.Mock(status_code=200)

        s = http.session("testb", ["Provider-B.example"])
        with mock.patch.object(requests.Session, "request", fake_request):
            s.get("https://provider-b.example/x")
        self.assertEqual(seen["timeout"], http.DEFAULT_TIMEOUT)
        self.assertEqual(http.hosts("testb"), ("provider-b.example",))
        self.assertTrue(http.reachable("testb"))
        for _ in range(3):
            breaker.on_failure("provider-b.example", requests.ConnectionError("x"), False)
        self.assertFalse(http.reachable("testb"))
        self.assertGreater(http.retry_in("testb"), 0)
        with self.assertRaises(DeezerUnavailable):  # short-circuited, no socket
            s.get("https://provider-b.example/x")
        self.assertTrue(http.is_transport_failure(DeezerUnavailable("x")))
        breaker.reset("provider-b.example")
        self.assertTrue(http.reachable("testb"))
        self.assertTrue(http.reachable("never-registered"))

    def test_deezers_hosts_are_registered_with_the_adapter(self):
        DeezerAdapter(lambda: None)
        self.assertIn("api.deezer.com", http.hosts("deezer"))
        self.assertIn("www.deezer.com", http.hosts("deezer"))


if __name__ == "__main__":
    unittest.main()

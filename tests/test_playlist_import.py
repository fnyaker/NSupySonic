# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Importing a shared playlist link: reading each service, matching, saving.

Offline: the pages are fixtures written in the shape each service serves
(Spotify's embed ``__NEXT_DATA__``, Apple Music's ``serialized-server-data`` and
schema.org block, ytmusicapi's ``get_playlist``), and the network is a stub.
``tests/net`` reads real links.
"""

import json
import os
import shutil
import tempfile
import unittest

from supysonic import linkimport
from supysonic.config import DefaultConfig
from supysonic.db import Playlist, release_database
from supysonic.managers.user import UserManager
from supysonic.web import create_application
from supysonic.webui import playlist_import

SPOTIFY_ID = "37i9dQZF1DXcBWIGoYBM5M"


def spotify_page(tracks, name="Today's Top Hits"):
    data = {
        "props": {
            "pageProps": {
                "state": {
                    "data": {
                        "entity": {
                            "type": "playlist",
                            "name": name,
                            "title": name,
                            "coverArt": {
                                "sources": [
                                    {"url": "https://i.scdn.co/image/small", "width": 60},
                                    {"url": "https://i.scdn.co/image/big", "width": 640},
                                ]
                            },
                            "trackList": tracks,
                        }
                    }
                }
            }
        }
    }
    return (
        "<!DOCTYPE html><html><head><title>Spotify</title></head><body>"
        '<script id="__NEXT_DATA__" type="application/json">' + json.dumps(data) + "</script>"
        "</body></html>"
    )


def sp_track(title, subtitle, ms, kind="track"):
    return {
        "uri": "spotify:track:xxxxxxxxxxxxxxxxxxxxxx",
        "title": title,
        "subtitle": subtitle,
        "duration": ms,
        "isExplicit": False,
        "entityType": kind,
    }


def apple_page():
    server = [
        {
            "intent": {"$kind": "PlaylistDetailPageIntent"},
            "data": {
                "sections": [
                    {
                        "itemKind": "containerDetailHeaderLockup",
                        "items": [{"title": "Chill FR", "subtitleLinks": [{"title": "Apple Music"}]}],
                    },
                    {
                        "itemKind": "trackLockup",
                        "items": [
                            {
                                "title": "Alors on danse",
                                "artistName": "Stromae",
                                "albumName": "Cheese",
                                "duration": 207000,
                                "contentDescriptor": {"identifiers": {"storeAdamID": "1"}},
                            },
                            {
                                "title": "Bella",
                                "artistName": "Maître Gims & Vianney",
                                "duration": 230500,
                                "contentDescriptor": {"identifiers": {"storeAdamID": "2"}},
                            },
                            # the same row a second time (another section repeats it)
                            {
                                "title": "Alors on danse",
                                "artistName": "Stromae",
                                "duration": 207000,
                                "contentDescriptor": {"identifiers": {"storeAdamID": "1"}},
                            },
                        ],
                    },
                ]
            },
        }
    ]
    ld = {
        "@context": "http://schema.org",
        "@type": "MusicPlaylist",
        "name": "Chill FR",
        "numTracks": 2,
        "image": "https://is1-ssl.mzstatic.com/image/thumb/x/1200x630cw.png",
        "track": [{"@type": "MusicRecording", "name": "Alors on danse", "duration": "PT3M27S"}],
    }
    return (
        '<html><head><meta property="og:title" content="Chill FR on Apple Music">'
        '<script type="application/ld+json" id="schema:music-playlist">' + json.dumps(ld) + "</script>"
        '</head><body><script type="application/json" id="serialized-server-data">'
        + json.dumps(server)
        + "</script></body></html>"
    )


class ParseTestCase(unittest.TestCase):
    def test_every_form_of_link(self):
        cases = {
            "https://www.deezer.com/fr/playlist/1479458365": ("deezer", "playlist", "1479458365"),
            "https://deezer.com/playlist/908622995?utm_source=x": ("deezer", "playlist", "908622995"),
            "https://www.deezer.com/en/album/302127": ("deezer", "album", "302127"),
            f"https://open.spotify.com/playlist/{SPOTIFY_ID}?si=abc": ("spotify", "playlist", SPOTIFY_ID),
            f"https://open.spotify.com/intl-fr/playlist/{SPOTIFY_ID}": ("spotify", "playlist", SPOTIFY_ID),
            f"https://open.spotify.com/embed/album/{SPOTIFY_ID}": ("spotify", "album", SPOTIFY_ID),
            f"spotify:playlist:{SPOTIFY_ID}": ("spotify", "playlist", SPOTIFY_ID),
            "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI": (
                "youtube", "playlist", "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"),
            "https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs": (
                "youtube", "playlist", "RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs"),
            "https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890abc": ("youtube", "playlist", "PL1234567890abc"),
            "https://music.youtube.com/browse/VLPL1234567890abc": ("youtube", "playlist", "PL1234567890abc"),
            "https://music.apple.com/fr/playlist/chill-fr/pl.u-8aAVZAgCo1Y3D": ("apple", "playlist", "pl.u-8aAVZAgCo1Y3D"),
            "https://music.apple.com/us/album/cheese/1442838443": ("apple", "album", "1442838443"),
        }
        for url, want in cases.items():
            got = linkimport.parse(url)
            self.assertIsNotNone(got, url)
            self.assertEqual((got["source"], got["kind"], got["id"]), want, url)

    def test_a_link_inside_a_message(self):
        got = linkimport.parse(f"Écoute ça !! https://open.spotify.com/playlist/{SPOTIFY_ID}).")
        self.assertEqual(got["id"], SPOTIFY_ID)

    def test_short_links_are_kept_for_resolution(self):
        got = linkimport.parse("https://link.deezer.com/s/30ZYvQ8bhbuX0Cq2kIgDh")
        self.assertEqual((got["source"], got["kind"]), ("deezer", "short"))
        self.assertEqual(got["url"], "https://link.deezer.com/s/30ZYvQ8bhbuX0Cq2kIgDh")
        self.assertEqual(linkimport.parse("https://spotify.link/aBcD")["kind"], "short")

    def test_refuses_what_it_cannot_read(self):
        for text in (
            "",
            "hello",
            "https://example.com/playlist/123",
            "https://deezer.com.evil.example/playlist/123",
            "https://evil.example/?u=https://www.deezer.com/playlist/1",
            "https://www.deezer.com/fr/track/1",
            "https://www.deezer.com/fr/playlist/../../admin",
            "javascript:alert(1)//open.spotify.com/playlist/" + SPOTIFY_ID,
            "ftp://open.spotify.com/playlist/" + SPOTIFY_ID,
            "https://open.spotify.com/playlist/short",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.apple.com/fr/song/x/1",
        ):
            self.assertIsNone(linkimport.parse(text), text)

    def test_a_short_link_path_cannot_steer_the_request(self):
        got = linkimport.parse("https://link.deezer.com/s/a%2F..%2F@evil?x=1#y")
        self.assertEqual(got["url"], "https://link.deezer.com/s/a2F..2Fevil")


class FakeResponse:
    def __init__(self, status=200, location=None, body=b""):
        self.status_code = status
        self.headers = {"Location": location} if location else {}
        self.body = body

    def iter_content(self, n):
        yield self.body

    def close(self):
        pass


class FakeSession:
    def __init__(self, answers):
        self.answers = answers
        self.asked = []

    def get(self, url, **kw):
        self.asked.append(url)
        return self.answers[url]

    def close(self):
        pass


class ShortLinkTestCase(unittest.TestCase):
    def test_follows_redirects_within_the_service(self):
        s = FakeSession(
            {
                "https://link.deezer.com/s/abc": FakeResponse(
                    302, "https://www.deezer.com/fr/playlist/1479458365?host=1&utm=2"
                ),
            }
        )
        got = linkimport.resolve_short(s, linkimport.parse("https://link.deezer.com/s/abc"))
        self.assertEqual((got["kind"], got["id"]), ("playlist", "1479458365"))

    def test_never_follows_a_redirect_elsewhere(self):
        s = FakeSession({"https://spotify.link/abc": FakeResponse(302, "http://169.254.169.254/latest")})
        with self.assertRaises(linkimport.LinkError):
            linkimport.resolve_short(s, linkimport.parse("https://spotify.link/abc"))
        self.assertEqual(s.asked, ["https://spotify.link/abc"])  # nothing else was fetched

    def test_a_page_that_carries_its_target(self):
        body = (
            b'<html><script>window.location="https://www.deezer.com/fr/playlist/42?x=1&amp;y=2"</script></html>'
        )
        s = FakeSession({"https://deezer.page.link/abc": FakeResponse(200, None, body)})
        got = linkimport.resolve_short(s, linkimport.parse("https://deezer.page.link/abc"))
        self.assertEqual(got["id"], "42")


class ReadersTestCase(unittest.TestCase):
    def test_spotify_embed(self):
        page = spotify_page(
            [
                sp_track("Alors on danse", "Stromae", 207000),
                sp_track("Bella", "Maître Gims, Vianney", 230500),
                sp_track("Un épisode", "Un podcast", 1800000, kind="episode"),
            ]
        )
        got = linkimport.parse_spotify(page)
        self.assertEqual(got["name"], "Today's Top Hits")
        self.assertEqual(got["cover"], "https://i.scdn.co/image/big")
        self.assertEqual([t["title"] for t in got["tracks"]], ["Alors on danse", "Bella"])
        self.assertEqual(got["tracks"][1]["artists"], ["Maître Gims", "Vianney"])
        self.assertEqual(got["tracks"][1]["duration"], 230)  # 230.5 s, rounded to even

    def test_spotify_page_without_data_is_an_error(self):
        with self.assertRaises(linkimport.LinkError):
            linkimport.parse_spotify("<html>consent wall</html>")

    def test_apple_page(self):
        got = linkimport.parse_apple(apple_page())
        self.assertEqual(got["name"], "Chill FR")
        self.assertEqual(
            [(t["title"], t["artists"], t["duration"]) for t in got["tracks"]],
            [("Alors on danse", ["Stromae"], 207), ("Bella", ["Maître Gims", "Vianney"], 230)],
        )
        self.assertEqual(got["tracks"][0]["album"], "Cheese")
        self.assertTrue(got["cover"].endswith("/600x600bb.png"))
        self.assertFalse(got["truncated"])

    def test_apple_schema_org_fallback(self):
        page = apple_page().split('<script type="application/json"')[0]
        got = linkimport.parse_apple(page)
        self.assertEqual([(t["title"], t["duration"]) for t in got["tracks"]], [("Alors on danse", 207)])
        self.assertTrue(got["truncated"])  # 1 read of numTracks 2

    def test_youtube_playlist(self):
        raw = {
            "title": "Mix",
            "trackCount": 3,
            "thumbnails": [{"url": "https://lh3.googleusercontent.com/x=w120-h120", "width": 120}],
            "tracks": [
                {"videoId": "AAAAAAAAAAA", "title": "Alors on danse", "artists": [{"name": "Stromae", "id": "c"}],
                 "album": {"name": "Cheese", "id": "a"}, "duration_seconds": 207, "isAvailable": True},
                {"videoId": "BBBBBBBBBBB", "title": "Stromae - Papaoutai (Official Video)",
                 "artists": [{"name": "StromaeVEVO", "id": "v"}], "album": None, "duration_seconds": 232},
                {"videoId": "CCCCCCCCCCC", "title": "Gone", "artists": [], "isAvailable": False},
                {"videoId": None, "title": "deleted"},
            ],
        }
        got = linkimport.parse_youtube(raw)
        self.assertEqual(
            [(t["title"], t["artists"]) for t in got["tracks"]],
            [("Alors on danse", ["Stromae"]), ("Papaoutai", ["Stromae"])],
        )
        self.assertEqual(got["tracks"][1]["yt"]["video_id"], "BBBBBBBBBBB")
        self.assertEqual(got["cover"], "https://lh3.googleusercontent.com/x=w544-h544")

    def test_a_playlist_youtube_says_is_gone_holds_nobody_off(self):
        """YouTube answering "no such playlist" says nothing about YouTube: it
        used to hold every YouTube search and first play off for a minute."""
        from unittest import mock

        from supysonic.deezer import youtube as yt

        yt.reset()
        self.addCleanup(yt.reset)
        client = mock.Mock()
        client.get_playlist.side_effect = Exception("The playlist does not exist.")
        with mock.patch.object(yt, "installed", return_value=True), mock.patch.object(yt, "_client", return_value=client):
            with self.assertRaises(linkimport.LinkError):
                linkimport.read_youtube({"id": "PLxxxxxxxxxxxxxxxx"})
            self.assertFalse(yt.held()[0])
            client.get_playlist.side_effect = Exception("HTTP Error 429: Too Many Requests")
            with self.assertRaises(linkimport.LinkError):
                linkimport.read_youtube({"id": "PLxxxxxxxxxxxxxxxx"})
            self.assertTrue(yt.held()[0])

    def test_video_titles(self):
        self.assertEqual(
            linkimport.clean_video_title("Daft Punk - One More Time (Official Video) [HD]", ["Daft Punk"]),
            ("One More Time", ["Daft Punk"]),
        )
        # A real version word is kept: it is a different recording.
        self.assertEqual(
            linkimport.clean_video_title("Song (Live at Wembley)", ["Band"]), ("Song (Live at Wembley)", ["Band"])
        )
        # " - " in a title that is not "artist - title" is left alone.
        self.assertEqual(
            linkimport.clean_video_title("Prelude - Remastered", ["Chopin"]), ("Prelude - Remastered", ["Chopin"])
        )

    def test_every_field_is_bounded(self):
        e = linkimport.entry("x" * 5000, ["a" * 5000] * 50, "b" * 5000, 10**9, "not an isrc")
        self.assertEqual(len(e["title"]), 300)
        self.assertEqual(len(e["artists"]), 1)  # the same name 50 times
        self.assertEqual(e["duration"], 24 * 3600)
        self.assertIsNone(e["isrc"])
        self.assertIsNone(linkimport.entry("   "))


def dz(i, title, artist, duration, album="Album"):
    return {
        "id": i,
        "title": title,
        "duration": duration,
        "artist": {"id": i * 10, "name": artist},
        "album": {"id": i * 100, "title": album, "cover_medium": "https://img/c.jpg"},
    }


class ImportApi:
    """Deezer's public API, answering by query."""

    catalogue = [
        dz(1, "Alors on danse (Radio Edit)", "Stromae", 206),
        dz(2, "Alors on danse", "Stromae", 290, album="Live"),  # too long: not the same cut
        dz(3, "Bella", "Maître Gims", 231),
        dz(4, "Bella", "Somebody Else", 230),
        dz(5, "Papaoutai", "Stromae", 232),
    ]

    def __init__(self):
        self.queries = []

    def search(self, query, limit=25, **kw):
        self.queries.append(query)
        words = set(query.lower().split())
        return {"data": [t for t in self.catalogue if words & set(t["title"].lower().split())]}

    def get_track_by_ISRC(self, isrc):
        if isrc == "BEUM70900001":
            return dz(6, "Alors On Danse", "Stromae", 207)
        if isrc == "BEUM71300002":
            return dz(5, "Papaoutai", "Stromae", 232)
        if isrc == "BEUM79999999":
            # What deezerpy raises for an ISRC Deezer does not know (error 800).
            from deezerpy.errors import DataException

            raise DataException("no data")
        return {"error": {}}

    def get_playlist(self, pid):
        return {"id": int(pid), "title": "Ma playlist Deezer", "picture_big": "https://img/p.jpg"}

    def get_playlist_tracks(self, pid, index=0, limit=100):
        return {"data": [dz(3, "Bella", "Maître Gims", 231)], "total": 1}


class ImportRouteTestCase(unittest.TestCase):
    def setUp(self):
        self.db = tempfile.mkstemp()
        self.dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path, cache = self.db[1], self.dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)

        self.app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bbb", admin=False)

        from supysonic.deezer.provider import DeezerProvider

        from .test_webui import MockDz, MockPrefetch

        provider = DeezerProvider("arl", self.archive, "FLAC")
        provider._dz = MockDz()
        self.api = provider._dz.api = ImportApi()
        self.app.deezer = provider
        self.app.deezer_prefetch = MockPrefetch()
        self.app.config["DEEZER"]["archive_dir"] = self.archive
        self.client = self.app.test_client()
        playlist_import._jobs.clear()

        self.pages = {}
        self._orig = (linkimport.read_spotify, linkimport.read_apple)
        linkimport.read_spotify = lambda session, link: linkimport.parse_spotify(self.pages[link["id"]])
        linkimport.read_apple = lambda session, link: linkimport.parse_apple(self.pages[link["id"]])

    def tearDown(self):
        linkimport.read_spotify, linkimport.read_apple = self._orig
        playlist_import._jobs.clear()
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.db[0])
        os.remove(self.db[1])

    def login(self, who="alice", pw="Alic3"):
        self.client.post("/api/logout")
        self.assertEqual(self.client.post("/api/login", json={"username": who, "password": pw}).status_code, 200)

    def start(self, url):
        rv = self.client.post("/api/import/playlist", json={"url": url})
        self.assertEqual(rv.status_code, 200, rv.get_json())
        return rv.get_json()["id"]

    def status(self, jid):
        return self.client.get(f"/api/import/playlist/{jid}").get_json()

    def local_track(self, title, artist, length):
        from supysonic.deezer import library, local

        root = library.get_root_folder(self.archive)
        d = os.path.join(self.archive, artist, "Demo")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, title.replace(" ", "_") + ".mp3")
        with open(path, "wb") as fh:
            fh.write(b"localaudio")

        class Tag:
            albumartist = None
            album = "Demo"
            genre = None
            disc = 1
            track = 1
            year = None
            bitrate = 320000
            images = []

        Tag.title, Tag.artist, Tag.length = title, artist, float(length)
        orig = local._load_tag
        local._load_tag = lambda p: Tag() if p == path else None
        try:
            return local.import_local_file(path, root)
        finally:
            local._load_tag = orig

    def test_requires_login(self):
        rv = self.client.post("/api/import/playlist", json={"url": "https://www.deezer.com/playlist/1"})
        self.assertEqual(rv.status_code, 401)

    def test_unknown_link_is_refused(self):
        self.login()
        rv = self.client.post("/api/import/playlist", json={"url": "https://example.com/x"})
        self.assertEqual(rv.status_code, 400)
        self.assertIn("Lien non reconnu", rv.get_json()["error"])
        self.assertEqual(self.client.post("/api/import/playlist", json={"url": 5}).status_code, 400)

    def test_matches_library_first_then_deezer_and_leaves_the_rest(self):
        self.login()
        mine = self.local_track("Papaoutai", "Stromae", 233)
        self.pages[SPOTIFY_ID] = spotify_page(
            [
                sp_track("Alors on danse", "Stromae", 207000),  # Deezer's radio edit (soft label, same length)
                sp_track("Papaoutai", "Stromae", 232000),       # on disk already
                sp_track("Bella", "Maître Gims, Vianney", 230000),
                sp_track("Totally Unknown", "Nobody", 100000),
            ]
        )
        job = self.status(self.start(f"https://open.spotify.com/playlist/{SPOTIFY_ID}"))
        self.assertEqual(job["state"], "done", job)
        self.assertEqual((job["total"], job["matched"]), (4, 3))
        self.assertEqual(job["counts"], {"local": 1, "deezer": 2})
        items = job["items"]
        self.assertEqual(items[0]["track"]["deezer_id"], "1")
        self.assertTrue(items[0]["sure"])
        self.assertEqual((items[1]["via"], items[1]["track"]["deezer_id"]), ("local", str(mine.id)))
        self.assertEqual(items[2]["track"]["deezer_id"], "3")  # Gims's, not somebody else's Bella
        self.assertIsNone(items[3]["track"])
        self.assertEqual(items[3]["line"]["title"], "Totally Unknown")
        # the library match cost no search
        self.assertFalse(any("papaoutai" in q.lower() for q in self.api.queries))

    def test_isrc_wins_over_a_search(self):
        self.login()
        page = apple_page().replace('"albumName": "Cheese",', '"albumName": "Cheese", "isrc": "BEUM70900001",')
        self.pages["pl.u-8aAVZAgCo1Y3D"] = page
        job = self.status(self.start("https://music.apple.com/fr/playlist/chill-fr/pl.u-8aAVZAgCo1Y3D"))
        self.assertEqual(job["items"][0]["track"]["deezer_id"], "6")  # a search would have said 1

    def test_an_isrc_naming_another_song_is_not_believed(self):
        self.login()
        page = apple_page().replace('"albumName": "Cheese",', '"albumName": "Cheese", "isrc": "BEUM71300002",')
        self.pages["pl.u-8aAVZAgCo1Y3D"] = page
        job = self.status(self.start("https://music.apple.com/fr/playlist/chill-fr/pl.u-8aAVZAgCo1Y3D"))
        self.assertEqual(job["items"][0]["track"]["deezer_id"], "1")  # not Papaoutai

    def test_an_isrc_deezer_does_not_know_still_leaves_the_search(self):
        self.login()
        page = apple_page().replace('"albumName": "Cheese",', '"albumName": "Cheese", "isrc": "BEUM79999999",')
        self.pages["pl.u-8aAVZAgCo1Y3D"] = page
        job = self.status(self.start("https://music.apple.com/fr/playlist/chill-fr/pl.u-8aAVZAgCo1Y3D"))
        self.assertEqual(job["items"][0]["track"]["deezer_id"], "1")
        self.assertTrue(self.api.queries)

    def test_a_save_in_progress_does_not_resend_the_list(self):
        from supysonic.webui import playlist_import as pi

        job = {k: None for k in ("id", "source", "source_label", "kind", "url", "name", "cover",
                                 "total", "truncated", "done", "matched", "error", "playlist_id")}
        job.update(items=[{"line": {}, "track": None}] * 3, counts={})
        for state, has in (("matching", False), ("done", True), ("saving", False), ("saved", True)):
            job["state"] = state
            self.assertEqual("items" in pi._snapshot(job), has, state)

    def test_a_deezer_link_is_its_own_match(self):
        self.login()
        job = self.status(self.start("https://www.deezer.com/fr/playlist/1479458365"))
        self.assertEqual(job["name"], "Ma playlist Deezer")
        self.assertEqual([i["track"]["deezer_id"] for i in job["items"]], ["3"])
        self.assertEqual(self.api.queries, [])

    def test_save_makes_a_local_playlist_never_a_deezer_one(self):
        self.login()
        self.pages[SPOTIFY_ID] = spotify_page(
            [sp_track("Bella", "Maître Gims", 231000), sp_track("Nope", "Nobody", 1000)]
        )
        jid = self.start(f"https://open.spotify.com/playlist/{SPOTIFY_ID}")
        created = []
        gw = self.app.deezer._dz.gw
        gw.create_playlist = lambda *a, **k: created.append(a) or 999
        gw.get_track = lambda sid: {
            "SNG_ID": sid, "SNG_TITLE": "Bella", "DURATION": 231, "ART_ID": 30, "ART_NAME": "Maître Gims",
            "ALB_ID": 300, "ALB_TITLE": "Album", "ALB_PICTURE": "", "TRACK_NUMBER": 1, "DISK_NUMBER": 1,
        }
        rv = self.client.post(f"/api/import/playlist/{jid}/save", json={"title": "  Mon  import "})
        self.assertEqual(rv.status_code, 200, rv.get_json())
        job = self.status(jid)
        self.assertEqual(job["state"], "saved", job)
        pl = Playlist[job["playlist_id"]]
        self.assertEqual(pl.name, "Mon import")
        self.assertIsNone(pl.deezer_id)
        self.assertEqual([t.title for t in pl.get_tracks()], ["Bella"])
        self.assertEqual(created, [])

    def test_a_guest_can_listen_but_not_save_and_nobody_else_sees_the_job(self):
        self.login("bob", "B0bbb")
        self.pages[SPOTIFY_ID] = spotify_page([sp_track("Bella", "Maître Gims", 231000)])
        jid = self.start(f"https://open.spotify.com/playlist/{SPOTIFY_ID}")
        self.assertEqual(self.status(jid)["items"][0]["track"]["deezer_id"], "3")
        self.assertEqual(self.client.post(f"/api/import/playlist/{jid}/save", json={}).status_code, 403)
        self.login()
        self.assertEqual(self.client.get(f"/api/import/playlist/{jid}").status_code, 404)
        self.assertEqual(self.client.post(f"/api/import/playlist/{jid}/save", json={}).status_code, 404)

    def test_a_page_it_cannot_read_says_why(self):
        self.login()
        self.pages[SPOTIFY_ID] = "<html>nothing here</html>"
        job = self.status(self.start(f"https://open.spotify.com/playlist/{SPOTIFY_ID}"))
        self.assertEqual(job["state"], "error")
        self.assertIn("Spotify", job["error"])

    def test_keep_picks_lines_and_ignores_garbage(self):
        self.login()
        self.pages[SPOTIFY_ID] = spotify_page(
            [sp_track("Bella", "Maître Gims", 231000), sp_track("Papaoutai", "Stromae", 232000)]
        )
        jid = self.start(f"https://open.spotify.com/playlist/{SPOTIFY_ID}")
        rv = self.client.post(f"/api/import/playlist/{jid}/save", json={"keep": "all"})
        self.assertEqual(rv.status_code, 400)
        gw = self.app.deezer._dz.gw
        gw.get_track = lambda sid: {
            "SNG_ID": sid, "SNG_TITLE": "Papaoutai", "DURATION": 232, "ART_ID": 50, "ART_NAME": "Stromae",
            "ALB_ID": 500, "ALB_TITLE": "Racine carrée", "ALB_PICTURE": "", "TRACK_NUMBER": 1, "DISK_NUMBER": 1,
        }
        rv = self.client.post(f"/api/import/playlist/{jid}/save", json={"keep": [1, 1, -1, 99, True, "0"]})
        self.assertEqual(rv.status_code, 200)
        pl = Playlist[self.status(jid)["playlist_id"]]
        self.assertEqual([t.title for t in pl.get_tracks()], ["Papaoutai"])


if __name__ == "__main__":
    unittest.main()

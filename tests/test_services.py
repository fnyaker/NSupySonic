# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Exporting a playlist to another service (supysonic/services, webui/services.py).

What is pinned is what an export must never get wrong: a song is only exported
when the service's copy IS that recording (the ISRC first, then a search judged
like a replacement — a cover or a remix is "not found", never a stand-in);
nothing is created when nothing matched or when the service stopped answering
half-way; every unmatched song is named; a credential is stored encrypted, per
user, refreshed and rotated, and never readable by another account; and the
list file is a file every reader opens (a formula is text, XML stays XML).
Spotify and YouTube Music are fakes that record what they were asked.
"""

import json
import os
import shutil
import tempfile
import threading
import unittest
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, urlparse

from supysonic.config import DefaultConfig
from supysonic.db import (
    Album,
    Artist,
    Folder,
    Playlist,
    PlaylistTrack,
    ServiceLink,
    StarredTrack,
    Track,
    User,
    release_database,
)
from supysonic.managers.user import UserManager
from supysonic.services import spotify as sp
from supysonic.services import ytmusic as ytm
from supysonic.web import create_application
from supysonic.webui import services as S

CLIENT_ID = "0123456789abcdef0123456789abcdef"


class FakeResponse:
    def __init__(self, status=200, body=None, headers=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.content = b"" if body is None else json.dumps(body).encode()

    def json(self):
        return self._body


class FakeSpotify:
    """Spotify's Web API, as much of it as an export touches."""

    def __init__(self):
        self.catalogue = []  # (uri, title, [artists], seconds, isrc)
        self.calls = []
        self.playlists = {}
        self.token_calls = []
        self.expire_next = False
        self.throttle_once = False
        self.fail_search_after = None
        self.searches = 0
        self.access = "AT1"

    # requests.Session's surface
    def post(self, url, data=None, timeout=None, **kw):
        self.token_calls.append(dict(data))
        if data.get("grant_type") == "refresh_token" and data.get("refresh_token") == "dead":
            return FakeResponse(400, {"error": "invalid_grant"})
        self.access = "AT%d" % (len(self.token_calls) + 1)
        return FakeResponse(
            200,
            {"access_token": self.access, "expires_in": 3600, "refresh_token": "RT%d" % len(self.token_calls)},
        )

    def request(self, method, url, headers=None, params=None, json=None, timeout=None):
        assert isinstance(timeout, tuple), "a scalar timeout is only the connect phase"
        path = url.split("/v1", 1)[1]
        self.calls.append((method, path, params, json))
        if headers.get("Authorization") != "Bearer " + self.access:
            return FakeResponse(401, {"error": {"status": 401}})
        if self.throttle_once:
            self.throttle_once = False
            return FakeResponse(429, {}, {"Retry-After": "2"})
        if path == "/me":
            return FakeResponse(200, {"id": "lea", "display_name": "Léa"})
        if path == "/search":
            self.searches += 1
            if self.fail_search_after is not None and self.searches > self.fail_search_after:
                import requests

                raise requests.ConnectionError("down")
            return FakeResponse(200, {"tracks": {"items": self._search(params["q"])}})
        if path == "/me/playlists" and method == "POST":
            pid = "PL%d" % (len(self.playlists) + 1)
            self.playlists[pid] = {"meta": json, "items": []}
            return FakeResponse(201, {"id": pid, "external_urls": {"spotify": "https://open.spotify.com/playlist/" + pid}})
        if path.startswith("/playlists/") and path.endswith("/items") and method == "POST":
            pid = path.split("/")[2]
            self.playlists[pid]["items"].extend(json["uris"])
            return FakeResponse(201, {"snapshot_id": "x"})
        return FakeResponse(404, {"error": {"status": 404}})

    def _search(self, q):
        def item(e):
            return {"uri": e[0], "name": e[1], "artists": [{"name": a} for a in e[2]], "duration_ms": e[3] * 1000}

        if q.startswith("isrc:"):
            return [item(e) for e in self.catalogue if e[4] == q[5:]][:10]
        words = q.lower().replace('"', " ").replace("track:", " ").replace("artist:", " ").split()
        hits = [e for e in self.catalogue if all(w in (e[1] + " " + " ".join(e[2])).lower() for w in words)]
        return [item(e) for e in hits][:10]


class ServicesTestCase(unittest.TestCase):
    def setUp(self):
        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path, cache, archive = self.__db[1], self.__dir, self.archive

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(getattr(self, "DEEZER", {}), archive_dir=archive, enabled=False)

        self.app = create_application(Config())
        self.app.deezer = None
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bbb", admin=False)
        self.alice = self._login("alice", "Alic3")
        self.bob = self._login("bob", "B0bbb")
        self.fake = FakeSpotify()
        self._real_session = sp.new_session
        sp.new_session = lambda: self.fake
        self._fill()

    def tearDown(self):
        sp.new_session = self._real_session
        with S._jobs_lock:
            S._jobs.clear()
            S._running.clear()
        S._pending.clear()
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    def _login(self, name, password):
        c = self.app.test_client()
        r = c.post("/api/login", json={"username": name, "password": password})
        self.assertEqual(r.status_code, 200)
        return c

    def _fill(self):
        with self.app.app_context():
            root = Folder.create(root=True, name="root", path=self.archive)
            folder = Folder.create(root=False, name="a", path=os.path.join(self.archive, "a"), parent=root)

            def track(title, artist, seconds, n, youtube_id=None, deezer_id=None):
                art = Artist.get_or_create(name=artist)[0]
                alb = Album.get_or_create(name="Album " + artist, artist=art)[0]
                return Track.create(
                    disc=1, number=n, title=title, duration=seconds, album=alb, artist=art,
                    bitrate=320, path=os.path.join(self.archive, "a", f"{n}.flac"),
                    last_modification=0, root_folder=root, folder=folder,
                    youtube_id=youtube_id, deezer_id=deezer_id,
                )

            self.tracks = [
                track("Alors on danse", "Stromae", 207, 1, deezer_id="2163521"),
                track("Papaoutai", "Stromae", 232, 2),
                track("=HYPERLINK(\"x\")", "Moi\x01", 61, 3, youtube_id="dQw4w9WgXcQ"),
                track("Introuvable", "Personne", 180, 4),
            ]
            # An ISRC, where an archived track keeps it: the JSON sidecar.
            from supysonic.deezer import library

            path = library.metadata_path(self.tracks[0])
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                json.dump({"ISRC": "be-ef1-09-00001"}, fh)
            alice = User.get(name="alice")
            self.pl = Playlist.create(user=alice, name="Soirée", created=library._now())
            for k, t in enumerate(self.tracks):
                PlaylistTrack.create(playlist=self.pl, track=t.id, index=k)
            StarredTrack.create(user=alice, starred=self.tracks[1].id)

    def _link_spotify(self, client=None, user="alice", refresh="RT0", expires_at=10**10):
        with self.app.app_context():
            S._store(User.get(name=user).id, "spotify",
                     json.dumps({"access_token": self.fake.access, "refresh_token": refresh,
                                 "expires_at": expires_at}), "Léa")

    def _configure(self):
        r = self.alice.put("/api/services/spotify/app", json={"client_id": CLIENT_ID})
        self.assertEqual(r.status_code, 200, r.get_json())

    def _run(self, client, service, **body):
        r = client.post(f"/api/services/{service}/export", json={"kind": "playlist", "id": str(self.pl.id), **body})
        self.assertEqual(r.status_code, 202, r.get_json())
        for t in threading.enumerate():
            if t.name == f"export-{service}":
                t.join(10)
        job = client.get(f"/api/services/export/{r.get_json()['job']}")
        self.assertEqual(job.status_code, 200)
        return job.get_json()

    # -- the list file -----------------------------------------------------------------

    def test_csv_is_a_spreadsheet_file_with_formulas_kept_as_text(self):
        r = self.alice.get(f"/api/services/list/playlist/{self.pl.id}?fmt=csv")
        self.assertEqual(r.status_code, 200)
        self.assertIn("attachment", r.headers["Content-Disposition"])
        text = r.data.decode("utf-8")
        self.assertTrue(text.startswith("\ufeffTitle,Artist,Album,ISRC,Duration\r\n"))
        import csv
        import io

        rows = list(csv.reader(io.StringIO(text.lstrip("\ufeff"))))
        self.assertEqual(rows[1], ["Alors on danse", "Stromae", "Album Stromae", "BEEF10900001", "207"])
        self.assertEqual(rows[3][0], "'=HYPERLINK(\"x\")", "a formula is kept as text")
        self.assertEqual(len(rows), 5)

    def test_xspf_parses_even_with_a_control_character_in_a_name(self):
        r = self.alice.get(f"/api/services/list/playlist/{self.pl.id}?fmt=xspf")
        root = ET.fromstring(r.data)
        ns = {"x": "http://xspf.org/ns/0/"}
        self.assertEqual(root.find("x:title", ns).text, "Soirée")
        tracks = root.findall("x:trackList/x:track", ns)
        self.assertEqual(len(tracks), 4)
        self.assertEqual(tracks[2].find("x:creator", ns).text, "Moi")
        self.assertEqual(tracks[0].find("x:duration", ns).text, "207000")

    def test_list_file_refuses_what_it_cannot_name(self):
        self.assertEqual(self.alice.get("/api/services/list/playlist/nope?fmt=csv").status_code, 404)
        self.assertEqual(self.alice.get(f"/api/services/list/playlist/{self.pl.id}?fmt=exe").status_code, 400)
        self.assertIn(self.alice.get(f"/api/services/list/../{self.pl.id}?fmt=csv").status_code, (400, 404))
        r = self.bob.get("/api/services/list/favorites/me?fmt=txt")
        self.assertEqual(r.data.decode(), "\n", "bob's favourites are his own, and empty")
        r = self.alice.get("/api/services/list/favorites/me?fmt=txt")
        self.assertEqual(r.data.decode(), "Stromae - Papaoutai\n")

    # -- linking -------------------------------------------------------------------------

    def test_only_the_admin_configures_spotify_and_sees_its_client_id(self):
        r = self.bob.put("/api/services/spotify/app", json={"client_id": CLIENT_ID})
        self.assertEqual(r.status_code, 403)
        r = self.alice.put("/api/services/spotify/app", json={"client_id": "not-an-id"})
        self.assertEqual(r.status_code, 400)
        self._configure()
        mine = {s["id"]: s for s in self.alice.get("/api/services").get_json()["services"]}
        self.assertEqual(mine["spotify"]["client_id"], CLIENT_ID)
        self.assertTrue(mine["spotify"]["redirect_uri"].endswith("/api/services/spotify/callback"))
        theirs = {s["id"]: s for s in self.bob.get("/api/services").get_json()["services"]}
        self.assertTrue(theirs["spotify"]["ready"])
        self.assertNotIn("client_id", theirs["spotify"])
        self.assertNotIn("deezer", theirs, "the server's Deezer account is the admin's")

    def test_spotify_link_round_trip_stores_an_encrypted_credential(self):
        self._configure()
        url = self.alice.get("/api/services/spotify/authorize").get_json()["url"]
        q = parse_qs(urlparse(url).query)
        self.assertEqual(q["code_challenge_method"], ["S256"])
        self.assertEqual(q["client_id"], [CLIENT_ID])
        self.assertNotIn("client_secret", q)
        state = q["state"][0]
        # Spotify sends the browser back: here a DIFFERENT browser (the system
        # browser an Android WebView hands the page to), with no session.
        stranger = self.app.test_client()
        r = stranger.get(f"/api/services/spotify/callback?code=C0DE&state={state}")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Compte Spotify relié", r.data.decode())
        self.assertEqual(self.fake.token_calls[0]["code_verifier"] and self.fake.token_calls[0]["grant_type"], "authorization_code")
        with self.app.app_context():
            row = ServiceLink.get(ServiceLink.service == "spotify")
            self.assertEqual(row.user.name, "alice")
            self.assertEqual(row.account, "Léa")
            self.assertNotIn("AT2", row.data)
            self.assertNotIn("RT1", row.data)
        # The state is single use.
        r = stranger.get(f"/api/services/spotify/callback?code=C0DE&state={state}")
        self.assertIn("expiré", r.data.decode())
        linked = {s["id"]: s for s in self.alice.get("/api/services").get_json()["services"]}
        self.assertTrue(linked["spotify"]["linked"])
        theirs = {s["id"]: s for s in self.bob.get("/api/services").get_json()["services"]}
        self.assertFalse(theirs["spotify"]["linked"])

    def test_the_signed_in_browser_lands_back_on_the_settings(self):
        self._configure()
        url = self.alice.get("/api/services/spotify/authorize").get_json()["url"]
        state = parse_qs(urlparse(url).query)["state"][0]
        r = self.alice.get(f"/api/services/spotify/callback?error=access_denied&state={state}")
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r.headers["Location"].endswith("/app/#/settings?svc=spotify-denied"))

    def test_a_forged_state_links_nothing(self):
        self._configure()
        self.alice.get("/api/services/spotify/authorize")
        r = self.app.test_client().get("/api/services/spotify/callback?code=C0DE&state=guess")
        self.assertIn("expiré", r.data.decode())
        self.assertEqual(self.fake.token_calls, [])
        with self.app.app_context():
            self.assertEqual(ServiceLink.select().count(), 0)

    def test_youtube_headers_without_a_session_are_refused_in_words(self):
        r = self.alice.post("/api/services/youtube/connect", json={"headers": "accept: */*\nuser-agent: x"})
        if not ytm.installed():
            self.assertIn("ytmusicapi", r.get_json()["error"])
        else:
            self.assertEqual(r.status_code, 400)
            self.assertIn("cookie", r.get_json()["error"])

    # -- the export ---------------------------------------------------------------------

    def test_spotify_export_matches_by_isrc_then_by_search_and_names_the_rest(self):
        self._configure()
        self._link_spotify()
        self.fake.catalogue = [
            ("spotify:track:alors", "Alors On Danse - Radio Edit", ["Stromae"], 206, "BEEF10900001"),
            # A cover by somebody else, and a remix: neither is the song.
            ("spotify:track:cover", "Papaoutai", ["Karaoke Stars"], 232, None),
            ("spotify:track:remix", "Papaoutai (Afro Remix)", ["Stromae"], 240, None),
            ("spotify:track:papa", "Papaoutai", ["Stromae"], 232, None),
        ]
        job = self._run(self.alice, "spotify", name="Ma soirée")
        self.assertIsNone(job["error"])
        self.assertEqual((job["total"], job["done"], job["matched"], job["missing_count"]), (4, 4, 2, 2))
        self.assertEqual(
            sorted(m["title"] for m in job["missing"]), ["=HYPERLINK(\"x\")", "Introuvable"]
        )
        self.assertEqual(job["url"], "https://open.spotify.com/playlist/PL1")
        pl = self.fake.playlists["PL1"]
        self.assertEqual(pl["items"], ["spotify:track:alors", "spotify:track:papa"])
        self.assertEqual(pl["meta"]["name"], "Ma soirée")
        self.assertFalse(pl["meta"]["public"])
        isrc_queries = [c[2]["q"] for c in self.fake.calls if c[1] == "/search" and c[2]["q"].startswith("isrc:")]
        self.assertEqual(isrc_queries, ["isrc:BEEF10900001"])
        for c in self.fake.calls:
            if c[1] == "/search":
                self.assertLessEqual(c[2]["limit"], 10, "Spotify's cap since February 2026")

    def test_nothing_found_creates_nothing(self):
        self._configure()
        self._link_spotify()
        job = self._run(self.alice, "spotify")
        self.assertEqual(job["matched"], 0)
        self.assertIn("Aucun titre", job["error"])
        self.assertEqual(self.fake.playlists, {})

    def test_a_service_that_stops_answering_stops_the_export(self):
        self._configure()
        self._link_spotify()
        self.fake.catalogue = [("spotify:track:alors", "Alors on danse", ["Stromae"], 207, "BEEF10900001")]
        self.fake.fail_search_after = 1
        job = self._run(self.alice, "spotify")
        self.assertIn("injoignable", job["error"])
        self.assertLess(job["done"], 4, "the rest is not filed as 'not found'")
        self.assertEqual(self.fake.playlists, {})

    def test_an_expired_token_is_refreshed_and_the_rotated_one_kept(self):
        self._configure()
        self._link_spotify(expires_at=0)
        self.fake.access = "stale"
        self.fake.catalogue = [("spotify:track:papa", "Papaoutai", ["Stromae"], 232, None)]
        self.fake.throttle_once = True
        slept = []
        real = sp.time.sleep
        sp.time.sleep = slept.append
        try:
            job = self._run(self.alice, "spotify")
        finally:
            sp.time.sleep = real
        self.assertIsNone(job["error"])
        self.assertEqual(slept, [2.0], "Retry-After is honoured, once")
        self.assertEqual(self.fake.token_calls[0]["refresh_token"], "RT0")
        with self.app.app_context():
            from supysonic.managers.user import decrypt_password

            stored = json.loads(decrypt_password(ServiceLink.get().data))
        self.assertEqual(stored["refresh_token"], "RT1")

    def test_a_revoked_token_asks_to_link_again(self):
        self._configure()
        self._link_spotify(refresh="dead", expires_at=0)
        job = self._run(self.alice, "spotify")
        self.assertTrue(job["relink"])
        self.assertIn("reconnectez", job["error"])

    def test_exports_are_private_to_their_user(self):
        self._configure()
        self._link_spotify()
        self.assertEqual(
            self.bob.post("/api/services/spotify/export", json={"kind": "playlist", "id": str(self.pl.id)}).status_code,
            409, "bob has no Spotify linked: alice's is not his",
        )
        self.fake.catalogue = [("spotify:track:papa", "Papaoutai", ["Stromae"], 232, None)]
        r = self.alice.post("/api/services/spotify/export", json={"kind": "playlist", "id": str(self.pl.id)})
        job_id = r.get_json()["job"]
        for t in threading.enumerate():
            if t.name == "export-spotify":
                t.join(10)
        self.assertEqual(self.bob.get(f"/api/services/export/{job_id}").status_code, 404)
        self.assertEqual(self.bob.post("/api/services/deezer/export", json={"kind": "playlist", "id": str(self.pl.id)}).status_code, 403)

    def test_youtube_export_uses_the_video_a_track_came_from(self):
        created = {}

        class FakeYTM:
            def create_playlist(self, title, description, privacy_status="PRIVATE", video_ids=None):
                created.update(title=title, privacy=privacy_status, ids=list(video_ids))
                return "PLyt"

            def add_playlist_items(self, *a, **k):
                raise AssertionError("one batch is enough here")

        from supysonic.deezer import youtube

        hits = {
            "stromae papaoutai": [
                {"video_id": "aaaaaaaaaaa", "title": "Papaoutai", "artists": [{"name": "Stromae"}], "duration": 233},
            ],
        }
        real_search = youtube.search
        youtube.search = lambda q, *a, **k: hits.get(q.lower(), [])
        real_client = ytm.Client.__init__

        def init(self, headers_json, ytm_=None):
            real_client(self, headers_json, FakeYTM())

        ytm.Client.__init__ = init
        try:
            with self.app.app_context():
                S._store(User.get(name="alice").id, "youtube", "{}", "Léa")
            job = self._run(self.alice, "youtube")
        finally:
            youtube.search = real_search
            ytm.Client.__init__ = real_client
        self.assertIsNone(job["error"])
        self.assertEqual(created["ids"], ["aaaaaaaaaaa", "dQw4w9WgXcQ"])
        self.assertEqual(created["privacy"], "PRIVATE")
        self.assertEqual(job["url"], "https://music.youtube.com/playlist?list=PLyt")

    def test_one_export_at_a_time_per_user(self):
        self._configure()
        self._link_spotify()
        with S._jobs_lock:
            S._running.add(self._alice_id())
        r = self.alice.post("/api/services/spotify/export", json={"kind": "playlist", "id": str(self.pl.id)})
        self.assertEqual(r.status_code, 429)

    def _alice_id(self):
        with self.app.app_context():
            return User.get(name="alice").id


if __name__ == "__main__":
    unittest.main()

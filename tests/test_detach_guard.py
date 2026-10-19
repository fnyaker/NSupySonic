# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The guard of the Deezer detachment (D18): what the app is allowed to ask Deezer.

A spy stands in for the Deezer client, answers every call with nothing and
remembers its name. Every route of ``/api`` is then visited, with every method
it takes and a sample id in each path slot, as the account owner. The calls the
spy heard must all be on ``ALLOWED``: fetching sound, searching the catalogue,
reading the pages of what is being looked at, probing a track, the audio
reference of the automatch. Anything else is the app reading the user's account
or writing to it again, and fails here by name.
"""

import re
import time
import unittest
from unittest import mock

from supysonic.db import Track
from supysonic.deezer.provider import DeezerProvider

from .test_detach_a import _AppCase

#: ``gateway|api.method`` — each is a way of getting SOUNDS or catalogue FACTS.
ALLOWED = {
    # sound: the stream URL and the track's own record
    "gw.get_track",
    "gw.get_tracks",
    "gw.get_tracks_data",
    "gw.get_track_url",
    "gw.get_user_data",
    "gw.get_track_token",
    "gw.get_track_lyrics",
    # catalogue pages (the entity is in front of the user)
    "gw.get_album_page",
    "gw.get_album_tracks",
    "gw.get_artist",
    "gw.get_artist_page",
    "gw.get_artist_discography_tabs",
    "gw.get_playlist_page",
    "gw.get_playlist_tracks",
    "gw.get_show_page",
    "gw.get_show_episodes",
    "gw.get_channels",
    "gw.get_channel",
    "gw.get_track_mix",
    "gw.get_artist_radio",
    "gw.search",
    "gw.search_music",
    "api.search",
    "api.search_track",
    "api.search_album",
    "api.search_artist",
    "api.search_playlist",
    "api.search_podcast",
    "api.advanced_search",
    "api.get_track",
    "api.get_album",
    "api.get_artist",
    "api.get_playlist",
    "api.get_artist_top",
    "api.get_artist_albums",
    "api.get_artist_related",
    "api.get_artist_radio",
    "api.get_album_tracks",
    "api.get_playlist_tracks",
    "api.get_podcast",
    "api.get_episode",
    "api.get_genre_artists",
    "api.get_chart",
    "api.get_chart_tracks",
    "api.get_chart_albums",
    "api.get_chart_artists",
    "api.get_chart_playlists",
    "api.get_editorial_releases",
    "api.get_editorial_genre_charts",
    "api.get_genres",
    "api.get_radio",
    "api.get_country_charts",
}

#: The one-off import of the account (Réglages → Compte Deezer) is the only
#: place the account is read, and only by these calls. It runs on a worker
#: thread, so it is driven on its own rather than attributed by route.
IMPORT_ENDPOINT = "webapi.import_account"
IMPORT_READS = {"gw.get_user_playlists", "gw.get_user_favorite_ids", "gw.get_playlist_tracks", "gw.get_tracks"}

_SAMPLE = {
    "int": "1",
    "string": "1",
    "path": "x",
    "uuid": "00000000-0000-0000-0000-000000000001",
}
_SKIP_ENDPOINTS = re.compile(r"logout|static")


class Spy:
    """Anything asked of it is a call: recorded, answered with an empty page."""

    def __init__(self, calls, prefix="", where=None):
        self._calls = calls
        self._prefix = prefix
        self._where = where if where is not None else [""]

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        if name in ("gw", "api"):
            return Spy(self._calls, name + ".", self._where)
        if name in ("current_user",):
            return {"id": 42, "name": "tester", "can_stream_lossless": True}
        if name == "close":  # releasing the sockets asks Deezer nothing
            return lambda: None
        full = self._prefix + name

        def call(*args, **kwargs):
            self._calls.append((self._where[0], full))
            return {"data": [], "results": {}}

        return call


class DeezerGuardTestCase(_AppCase):
    def setUp(self):
        super().setUp()
        self.make_track("1", "One")
        self.calls = []
        self.spy = Spy(self.calls)
        # The spy is the only client there is: nothing can log in for real,
        # whatever a route does to the session (a new ARL, a failed resolve).
        self.app.deezer._dz = self.spy
        self.app.deezer.relogin = lambda: self.spy
        patcher = mock.patch.object(DeezerProvider, "dz", property(lambda _self: self.spy))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _visit(self, skip_import=True):
        visited = 0
        for rule in self.app.url_map.iter_rules():
            if not rule.rule.startswith("/api/") or _SKIP_ENDPOINTS.search(rule.endpoint):
                continue
            if skip_import and rule.endpoint == IMPORT_ENDPOINT:
                continue
            path = rule.rule
            for arg, conv in rule._converters.items():
                kind = getattr(conv, "regex", "")
                sample = _SAMPLE["uuid"] if "uuid" in arg or "uid" in arg else (
                    _SAMPLE["int"] if type(conv).__name__ == "IntegerConverter" else _SAMPLE["string"]
                )
                path = path.replace("<%s:%s>" % (type(conv).__name__, arg), sample)
                path = re.sub(r"<(?:[a-z]+:)?%s>" % re.escape(arg), sample, path)
            for method in sorted(rule.methods - {"HEAD", "OPTIONS"}):
                visited += 1
                self.spy._where[0] = rule.endpoint
                kwargs = {"json": {}} if method in ("POST", "PUT", "PATCH", "DELETE") else {}
                self.client.open(path, method=method, **kwargs)
        return visited

    def test_every_route_only_asks_deezer_what_is_allowed(self):
        visited = self._visit()
        self.assertGreater(visited, 150, "the walk should reach the whole API")
        self.assertEqual(sorted({(w, c) for w, c in self.calls if c not in ALLOWED}), [])

    def test_the_account_is_never_read_or_written(self):
        self._visit()
        account = re.compile(
            r"favorite|playlists?$|get_user_(?!data)|flow|smart|listen|bookmark|module|recommend|"
            r"(create|edit|delete|add|remove)_"
        )
        offending = [c for _w, c in set(self.calls) if "." in c and account.search(c.split(".", 1)[1])]
        # a playlist PAGE is the catalogue; a user's playlists are the account.
        offending = [c for c in offending if not c.endswith(("_page", "_tracks", "_playlist"))]
        self.assertEqual(sorted(offending), [])

    def test_the_one_off_import_is_the_only_reader_of_the_account(self):
        from supysonic import webui

        webui._import_job.clear()  # another test's worker may have left it running
        webui._import_job.update(running=False)
        rv = self.client.post("/api/deezer/import-account", json={})
        self.assertTrue(rv.get_json()["ok"])
        deadline = time.monotonic() + 30  # a worker thread: wait for its end
        while webui._import_job.get("running") and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertFalse(webui._import_job.get("running"))
        heard = {c for _w, c in self.calls}
        self.assertLessEqual(heard, IMPORT_READS)
        self.assertIn("gw.get_user_playlists", heard)

    def test_the_things_the_user_does_stay_on_this_server(self):
        track = Track.select().first()
        self.client.post("/api/favorite", json={"deezer_id": str(track.id), "on": True})
        self.client.post("/api/favorite", json={"deezer_id": str(track.id), "on": False})
        pl = self.client.post("/api/playlists", json={"title": "Mine", "tracks": [str(track.id)]}).get_json()
        self.client.post("/api/listen", json={"deezer_id": str(track.id), "listened": 60})
        self.client.delete("/api/playlist/" + pl["id"])
        self.assertEqual(self.calls, [])


class SpyTestCase(unittest.TestCase):
    def test_the_spy_hears_a_call_and_an_unknown_one_is_not_allowed(self):
        calls = []
        Spy(calls).gw.add_song_to_favorites("1")
        Spy(calls).api.get_user_flow(1)
        self.assertEqual([c for _w, c in calls], ["gw.add_song_to_favorites", "api.get_user_flow"])
        self.assertNotIn(calls[0][1], ALLOWED)


if __name__ == "__main__":
    unittest.main()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The web app opens albums, artists and playlists by the row's ``id``.

A track already carried its UUID (lot E/G); its album, its artists and the
credits only carried the id Deezer lists them under, so every link had to be
built from a provider's id. They carry ``id`` now, a catalogue result the
library holds gets the id of its row, and a page opened by either answers the
same. A client that kept the old shape (a persisted queue) still opens them by
``deezer_id``: the routes accept both."""

import re
import unittest
from pathlib import Path

from supysonic.db import Playlist, User
from supysonic.deezer import ids

from .test_detach_e import _Case
from .test_webui import MockApi

ROOT = Path(__file__).resolve().parent.parent

class SearchApi(MockApi):
    """The catalogue answers with entities the fixture library also holds."""

    def search_album(self, query, limit=25, **kw):
        return {"data": [
            {"id": 21, "title": "Album Un", "cover_medium": "u", "artist": {"id": 11, "name": "Édith"}},
            {"id": 555, "title": "Ailleurs", "cover_medium": "u", "artist": {"id": 12, "name": "X"}},
        ]}

    def search_artist(self, query, limit=25, **kw):
        return {"data": [{"id": 11, "name": "Édith", "picture_medium": "u"}, {"id": 12, "name": "X"}]}

    def search_playlist(self, query, limit=25, **kw):
        return {"data": [{"id": 77, "title": "P", "user": {"name": "o"}}, {"id": 78, "title": "Q", "user": {"name": "o"}}]}


class EntityIdsTestCase(_Case):
    def test_a_row_s_entities_are_the_uuid_the_browser_derives(self):
        # Tracks do not repeat their album's and artists' ids (it would be 28%
        # more bytes on a big list): webapp/src/lib/entity.js hashes the
        # provider id, which is the id of the row because rows are created
        # under it. Pinned both ways.
        rows = self.get("/api/album/" + str(self.alb1.id)).get_json()["tracks"]
        for r in rows:
            self.assertNotIn("id", r["album"])
            self.assertEqual(str(ids.album_uuid(r["album"]["deezer_id"])), str(self.alb1.id))
            self.assertEqual(str(ids.artist_uuid(r["artist"]["deezer_id"])), str(self.art.id))

    def test_the_js_vectors_are_python_s(self):
        src = (ROOT / "webapp" / "test" / "entity.test.mjs").read_text()
        for name, fn in (("ALBUMS", ids.album_uuid), ("ARTISTS", ids.artist_uuid)):
            block = re.search(name + r" = \{(.*?)\};", src).group(1)
            pairs = re.findall(r'"(\d+)": "([0-9a-f-]{36})"', block)
            self.assertEqual(len(pairs), 3)
            for dz, u in pairs:
                self.assertEqual(str(fn(dz)), u, dz)
        js = (ROOT / "webapp" / "src" / "lib" / "entity.js").read_text()
        self.assertIn(str(ids.NS_ALBUM), js)
        self.assertIn(str(ids.NS_ARTIST), js)

    def test_the_pages_carry_the_artist_s_id(self):
        page = self.get("/api/artist/" + str(self.art.id)).get_json()
        self.assertEqual(page["artist"]["id"], str(self.art.id))
        card = page["albums"][0]
        self.assertEqual(card["id"], str(self.alb1.id))
        self.assertEqual(card["artist"]["id"], str(self.art.id))
        album = self.get("/api/album/" + str(self.alb1.id)).get_json()["album"]
        self.assertEqual(album["artist"]["id"], str(self.art.id))

    def test_a_page_by_id_is_the_page_by_provider_id(self):
        for kind, uid, did in (("album", self.alb1.id, "21"), ("artist", self.art.id, "11")):
            a = self.get(f"/api/{kind}/{uid}")
            b = self.get(f"/api/{kind}/{did}")
            self.assertEqual(a.status_code, 200)
            self.assertEqual(a.get_json(), b.get_json(), kind)

    def test_everything_a_link_reaches_answers_by_id(self):
        uid = str(self.art.id)
        for path in (
            f"/api/artist/{uid}/tracks",
            f"/api/artist/{uid}/discography",
            f"/api/radio/artist/{uid}",
            f"/api/artist/{uid}/on-deezer",
            f"/api/album/{self.alb1.id}/on-deezer",
            f"/api/playlist/{self.pl.id}",
        ):
            self.assertEqual(self.get(path).status_code, 200, path)

    def test_the_credits_link_to_the_artist_by_id(self):
        body = self.get("/api/track/" + str(self.t1.id) + "/credits").get_json()
        people = [p for c in body["credits"] for p in c["people"] if p.get("deezer_id") or p.get("id")]
        self.assertTrue(people)
        self.assertIn(str(self.art.id), {p.get("id") for p in people})

    def test_starring_by_id_stars_the_same_row_as_by_provider_id(self):
        self.assertEqual(self.client.post("/api/favorite/album", json={"id": str(self.alb1.id), "on": True}).status_code, 200)
        self.assertTrue(self.get("/api/album/21").get_json()["album"]["is_favorite"])
        self.client.post("/api/favorite/album", json={"id": str(self.alb1.id), "on": False})
        self.assertFalse(self.get("/api/album/" + str(self.alb1.id)).get_json()["album"]["is_favorite"])
        # A catalogue album the library does not hold is still starred by its provider id.
        rv = self.client.post("/api/favorite/album", json={"deezer_id": "555", "title": "Ailleurs", "artist": "X", "artist_id": "12", "on": True})
        self.assertEqual(rv.status_code, 200)

    def test_an_unknown_or_hostile_id_is_a_404_not_a_crash(self):
        for raw in ("00000000-0000-0000-0000-000000000000", "not-an-id", "1%3Fx"):
            for kind in ("album", "artist"):
                self.assertIn(self.get(f"/api/{kind}/{raw}").status_code, (404, 503), (kind, raw))

    def test_a_search_hit_the_library_holds_carries_its_row_id(self):
        with self.app.app_context():
            Playlist.create(user=User.get(name="alice"), name="Imp", deezer_id="77")
        self.provider._dz.api = SearchApi()
        r = self.get("/api/search?q=edith").get_json()
        by_dz = lambda xs: {x["deezer_id"]: x for x in xs}  # noqa: E731
        albums, artists, pls = by_dz(r["albums"]), by_dz(r["artists"]), by_dz(r["playlists"])
        self.assertEqual(albums["21"]["id"], str(self.alb1.id))
        self.assertEqual(artists["11"]["id"], str(self.art.id))
        self.assertIn("id", pls["77"])
        # Not held: only the provider's id, which the catalogue page is asked by.
        for x in (albums["555"], artists["12"], pls["78"]):
            self.assertNotIn("id", x)

    def test_the_search_costs_three_more_small_reads_at_most(self):
        from .test_deezer import count_statements

        self.provider._dz.api = SearchApi()
        with count_statements() as c:
            self.get("/api/search?q=edith")
        self.assertLessEqual(sum(c.values()), 12, dict(c))


if __name__ == "__main__":
    unittest.main()

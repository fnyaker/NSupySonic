# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Recommendations, the Flow's discovery level and the releases of favourite
artists (supysonic/discover.py, supysonic/releases.py, webui/discover.py).

A small library with a known shape: a loved frenchcore artist, an uptempo
artist the provider lists as close to it, a hardcore artist next to it by sound,
techno a little further, jazz and classical far away. Everything the screens
answer is checked against that shape, and every read is checked to ask no
provider at all.
"""

import datetime
import os
import random
import sqlite3
import unittest

from supysonic import db as dbmod
from supysonic import discover, releases
from supysonic.db import (
    Album, Artist, ArtistLink, ArtistRelease, ArtistTop, ArtistWatch, Meta,
    StarredArtist, StarredTrack, Track, TrackAnalysis, TrackNeighbor, User,
    UserTaste, init_database, release_database,
)
from supysonic.providers.errors import ProviderUnavailable
from supysonic.providers.fake import FakeProvider

from .test_detach_a import _AppCase

GENRES = {
    "Fav": "Frenchcore",
    "Near": "Uptempo",
    "Other": "Hardcore",
    "Mid": "Techno",
    "Far": "Jazz",
    "Farther": "Classical",
}
DEEZER_IDS = {"Fav": "100", "Near": "200", "Other": "300", "Mid": "400", "Far": "500", "Farther": "600"}


def count_statements(fn):
    from tests.test_deezer import count_statements as _count

    with _count() as counts:
        fn()
    return sum(counts.values())


class _Library(_AppCase):
    def setUp(self):
        super().setUp()
        from supysonic.deezer import library

        self.root = library.get_root_folder(self.archive)
        self.user = User.get(User.name == "alice")
        self.tracks = {}
        n = 0
        for name, style in GENRES.items():
            artist = Artist.create(name=name, deezer_id=DEEZER_IDS[name])
            album = Album.create(name=f"{name} LP", artist=artist, deezer_id=str(int(DEEZER_IDS[name]) + 1))
            rows = []
            for i in range(6):
                n += 1
                t = Track.create(
                    disc=1, number=i + 1, title=f"{name} {i}", duration=200, has_art=False,
                    album=album, artist=artist, bitrate=0,
                    path=os.path.join(self.archive, f"{name}-{i}.flac"),
                    last_modification=1, root_folder=self.root, folder=self.root,
                )
                TrackAnalysis.create(track=t, style=style, version=5)
                rows.append(t)
            self.tracks[name] = rows
        # The person plays Fav every day and loves it.
        long_ago = dbmod.now() - datetime.timedelta(days=2)
        for t in self.tracks["Fav"][:4]:  # two of its titles never played
            Track.update(play_count=12, last_play=long_ago).where(Track.id == t.id).execute()
        StarredArtist.create(user=self.user, starred=Artist.get(Artist.name == "Fav"))
        StarredTrack.create(user=self.user, starred=self.tracks["Fav"][0])
        # Other sounds like Fav.
        for seed in self.tracks["Fav"][:4]:
            for rank, nb in enumerate(self.tracks["Other"]):
                TrackNeighbor.create(track=seed, neighbor=nb, score=0.92 - 0.01 * rank, rank=rank)
        # Deezer lists Near as Fav's closest artist, Mid further down.
        for pos, (ref, name) in enumerate([("200", "Near"), ("700", "Stranger"), ("400", "Mid")]):
            ArtistLink.create(provider="deezer", artist_ref="100", other_ref=ref, other_name=name,
                              score=1.0 - 0.1 * pos, pos=pos * 6)
        ArtistTop.create(provider="deezer", ref="9001", artist_ref="700", artist_name="Stranger",
                         title="Stranger hit", duration=180, pos=0)
        discover.invalidate()

    def dist_of(self, track_id):
        name = Track.get_by_id(track_id).artist.name
        return name


class TasteTestCase(_Library):
    def test_the_profile_leans_on_what_is_played_and_loved(self):
        taste = discover.profile(self.user, fresh=True)
        fav = Artist.get(Artist.name == "Fav").id
        self.assertEqual(taste.top_artists(1), [fav])
        self.assertEqual(taste.top_genres(1)[0][0], "Frenchcore")
        # carried up the tree: hardcore is Frenchcore's parent
        self.assertIn("Hardcore", taste.genres)
        self.assertLess(taste.genres["Hardcore"], taste.genres["Frenchcore"])

    def test_the_profile_costs_a_bounded_number_of_statements(self):
        n = count_statements(lambda: discover.profile(self.user, fresh=True))
        self.assertLessEqual(n, 10)


class LevelTestCase(_Library):
    def candidates(self):
        taste = discover.profile(self.user, fresh=True)
        pool = discover.track_candidates(self.user, taste, random.Random(1))
        discover._dedupe_library(pool)
        return pool

    def mean_distance(self, level, seeds=8):
        pool = self.candidates()
        dists = []
        for s in range(seeds):
            picked = discover.pick(pool, level, 4, random.Random(s), known_share=0.0)
            dists += [c.dist for c in picked]
        return sum(dists) / len(dists)

    def test_the_mean_distance_grows_with_the_slider(self):
        means = [self.mean_distance(lv) for lv in (0.0, 0.25, 0.5, 0.75, 1.0)]
        for a, b in zip(means, means[1:]):
            self.assertLess(a, b, means)
        # measured: 0.12 / 0.27 / 0.48 / 0.67 / 0.83 on this library
        self.assertLess(means[0], 0.25)
        self.assertGreater(means[-1], 0.7)

    def test_at_zero_everything_is_a_step_from_what_is_played(self):
        pool = self.candidates()
        picked = discover.pick(pool, 0.0, 8, random.Random(3), known_share=0.0)
        names = {Track.get_by_id(c.track).artist.name for c in picked if c.track}
        self.assertLessEqual(names, {"Fav", "Other", "Near"})

    def test_at_one_nothing_is_in_the_loved_family(self):
        pool = self.candidates()
        picked = discover.pick(pool, 1.0, 8, random.Random(3), known_share=0.0)
        styles = {
            TrackAnalysis.get_by_id(c.track).style for c in picked if c.track is not None
        }
        self.assertTrue(styles)
        self.assertNotIn("Frenchcore", styles)
        self.assertNotIn("Hardcore", styles)
        self.assertLessEqual(styles, {"Jazz", "Classical", "Techno"})

    def test_the_flow_keeps_a_known_share_that_falls_with_the_level(self):
        for level, n, low, high in ((0.0, 5, 0.6, 1.0), (1.0, 10, 0.0, 0.35)):
            picked = discover.flow(self.user, level, n, seed="x")
            known = sum(1 for c in picked if c.dist == 0.0) / len(picked)
            self.assertGreaterEqual(known, low, level)
            self.assertLessEqual(known, high, level)

    def test_never_more_than_two_titles_of_one_artist_outside_the_known(self):
        picked = discover.pick(self.candidates(), 0.5, 8, random.Random(0), known_share=0.0)
        per = {}
        for c in picked:
            per[c.artist] = per.get(c.artist, 0) + 1
        self.assertLessEqual(max(per.values()), discover.PER_ARTIST)

    def test_a_refresh_changes_the_draw_and_a_seed_repeats_it(self):
        a = [c.key for c in discover.flow(self.user, 0.5, 10, seed="a")]
        b = [c.key for c in discover.flow(self.user, 0.5, 10, seed="a")]
        c = [c.key for c in discover.flow(self.user, 0.5, 10, seed="b")]
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_a_library_with_no_plays_no_genre_and_no_links_still_answers(self):
        TrackAnalysis.delete().execute()
        TrackNeighbor.delete().execute()
        ArtistLink.delete().execute()
        StarredArtist.delete().execute()
        StarredTrack.delete().execute()
        Track.update(play_count=0, last_play=None).execute()
        discover.invalidate()
        for level in (0.0, 0.5, 1.0):
            self.assertEqual(len(discover.flow(self.user, level, 10, seed="z")), 10)


class RoutesTestCase(_Library):
    def test_the_level_is_kept_per_person_and_validated(self):
        self.assertAlmostEqual(self.client.get("/api/discover/prefs").json["level"], discover.DEFAULT_LEVEL)
        r = self.client.put("/api/discover/prefs", json={"level": 0.8})
        self.assertEqual(r.json["step"], "Aventure")
        self.assertAlmostEqual(UserTaste.get(UserTaste.user == self.user).discovery, 0.8)
        self.assertEqual(self.client.put("/api/discover/prefs", json={"level": "nan"}).status_code, 400)
        self.assertEqual(self.client.put("/api/discover/prefs", json={"level": "x"}).status_code, 400)
        self.assertAlmostEqual(self.client.put("/api/discover/prefs", json={"level": 7}).json["level"], 1.0)

    def test_the_flow_answers_at_the_stored_level_and_says_why(self):
        self.client.put("/api/discover/prefs", json={"level": 0.0})
        r = self.client.get("/api/flow?seed=a")
        self.assertEqual(r.status_code, 200)
        self.assertGreaterEqual(len(r.json["tracks"]), 30)
        self.assertTrue(all(t.get("why") for t in r.json["tracks"]))
        self.assertEqual(self.client.get("/api/flow?d=abc").status_code, 400)

    def test_a_catalogue_title_is_shaped_like_a_search_result(self):
        r = self.client.get("/api/flow?d=0.5&seed=s")
        cat = [t for t in r.json["tracks"] if t["deezer_id"] == "9001"]
        if cat:  # a draw: when it is offered, it is playable by its Deezer id
            self.assertEqual(cat[0]["artist"]["name"], "Stranger")
            self.assertEqual(cat[0]["why"], "Proche de Fav")

    def test_recommendations_carry_titles_albums_and_artists(self):
        r = self.client.get("/api/recommend?d=0.4&seed=a")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json["tracks"])
        self.assertTrue(r.json["albums"])
        names = [a["name"] for a in r.json["artists"]]
        self.assertIn("Stranger", names)  # close on Deezer, absent from the library
        self.assertNotIn("Fav", names)
        album_titles = {a["title"] for a in r.json["albums"]}
        self.assertNotIn("Fav LP", album_titles)  # played: not a recommendation

    def test_a_muted_artist_is_never_recommended(self):
        self.client.post("/api/discover/mute", json={"provider": "deezer", "id": "700"})
        names = [a["name"] for a in self.client.get("/api/recommend?d=0.4&seed=b").json["artists"]]
        self.assertNotIn("Stranger", names)
        for bad in ({"provider": "deezer", "id": "../x"}, {"provider": "spotify", "id": "1"},
                    {"provider": "local", "id": "nope"}):
            self.assertEqual(self.client.post("/api/discover/mute", json=bad).status_code, 400)

    def test_the_screens_ask_no_provider_and_a_bounded_number_of_statements(self):
        fake = FakeProvider(id="deezer")
        self.app.providers._providers["deezer"] = fake
        self.app.deezer = None  # whatever Deezer is doing, the screens answer
        discover.invalidate()
        n = count_statements(lambda: self.client.get("/api/recommend?d=0.5&seed=q"))
        self.assertLessEqual(n, 40)
        n = count_statements(lambda: self.client.get("/api/flow?d=0.5&seed=q"))
        self.assertLessEqual(n, 30)
        self.assertEqual(self.client.get("/api/releases").status_code, 200)
        self.assertEqual(self.client.get("/api/discover/prefs").status_code, 200)
        self.assertEqual(sum(fake.calls.values()), 0)

    def test_a_guest_sees_only_what_they_may_read(self):
        from supysonic.managers.user import UserManager

        UserManager.add("bob", "B0bpass", admin=False)
        private = self.tracks["Far"][0]
        Track.update(owner=self.user.id).where(Track.id == private.id).execute()
        guest = self.app.test_client()
        guest.post("/api/login", json={"username": "bob", "password": "B0bpass"})
        ids = {t["deezer_id"] for t in guest.get("/api/flow?d=1&seed=g").json["tracks"]}
        self.assertNotIn(str(private.id), ids)
        self.assertNotIn(str(private.deezer_id), ids)

    def test_the_admin_routes_are_the_admin_s(self):
        from supysonic.managers.user import UserManager

        UserManager.add("bob", "B0bpass", admin=False)
        guest = self.app.test_client()
        guest.post("/api/login", json={"username": "bob", "password": "B0bpass"})
        self.assertEqual(guest.get("/api/releases/settings").status_code, 403)
        self.assertEqual(guest.post("/api/releases/check").status_code, 403)
        r = self.client.put("/api/releases/settings", json={"every": 12, "close": 9, "window": 30})
        self.assertEqual((r.json["every"], r.json["close"], r.json["window"]), (12, 5, 30))
        self.assertEqual(self.client.put("/api/releases/settings", json={"every": "x"}).status_code, 400)


class ReleasesTestCase(_Library):
    def setUp(self):
        super().setUp()
        self.fake = FakeProvider(id="deezer")
        self.app.providers._providers.clear()
        self.app.providers.register(self.fake)
        today = dbmod.now().date()
        self.fake.releases = {
            "100": [
                {"ref": "1001", "title": "Fav new", "release_date": (today - datetime.timedelta(days=3)).isoformat(),
                 "kind": "album", "cover_url": "https://x/c.jpg", "tracks_count": 10},
                {"ref": "1002", "title": "Fav old", "release_date": "2001-01-01", "kind": "album"},
            ],
            "200": [{"ref": "2001", "title": "Near single",
                     "release_date": (today - datetime.timedelta(days=10)).isoformat(), "kind": "single"}],
            "777": [{"ref": "7001", "title": "Not close enough",
                     "release_date": today.isoformat(), "kind": "album"}],
        }
        self.fake.related = {"100": [
            {"ref": "200", "name": "Near", "cover_url": "https://x/n.jpg"},
            {"ref": "300", "name": "Other"},
            {"ref": "777", "name": "Third"},
        ]}
        self.fake.tops = {"200": [{"ref": "5001", "title": "Near hit", "artists": [{"name": "Near"}],
                                   "duration": 150}]}
        Meta.insert(key=releases.KEY_CLOSE, value="2").on_conflict_replace().execute()

    def run_job(self, **kw):
        return releases.run_once(self.app, stats={"pause": 0}, **kw)

    def test_a_run_finds_the_favourites_and_their_closest_and_nothing_old(self):
        self.run_job()
        got = {r.ref for r in ArtistRelease.select()}
        self.assertEqual(got, {"1001", "2001"})
        r = self.client.get("/api/releases").json
        self.assertEqual([x["title"] for x in r["releases"]], ["Fav new", "Near single"])
        self.assertEqual(r["releases"][1]["close_to"], "Fav")
        self.assertEqual(r["unseen"], 2)
        self.client.post("/api/releases/seen")
        self.assertEqual(self.client.get("/api/releases").json["unseen"], 0)
        self.assertEqual(ArtistTop.get(ArtistTop.ref == "5001").artist_ref, "200")

    def test_each_artist_is_asked_once_per_period(self):
        stats = self.run_job()
        # one favourite: its similar artists, the tops of its 3 links, then
        # the releases of the favourite and its 2 closest.
        self.assertEqual(dict(self.fake.calls), {"similar_artists": 1, "artist_top": 3, "artist_releases": 3})
        self.assertEqual(stats["asked"], 7)
        self.fake.calls.clear()
        self.run_job()
        self.assertEqual(sum(self.fake.calls.values()), 0)  # nothing is due yet
        ArtistWatch.update(checked=dbmod.now() - datetime.timedelta(hours=7)).execute()
        self.run_job()
        self.assertEqual(dict(self.fake.calls), {"artist_releases": 3})

    def test_running_twice_never_duplicates_a_release(self):
        self.run_job()
        self.run_job(force=True)
        self.assertEqual(ArtistRelease.select().count(), 2)

    def test_an_outage_marks_nothing_and_the_work_waits(self):
        self.fake.fail = {"artist_releases": ProviderUnavailable("down", provider="deezer")}
        stats = self.run_job()
        self.assertEqual(stats["stopped"], "deezer")
        self.assertEqual(ArtistWatch.select().where(ArtistWatch.checked.is_null(False)).count(), 0)
        self.fake.fail = None
        self.run_job()
        self.assertEqual(ArtistRelease.select().count(), 2)

    def test_switched_off_asks_nobody(self):
        releases.save_settings({"on": False})
        self.run_job()
        self.assertEqual(sum(self.fake.calls.values()), 0)

    def test_a_person_sees_only_their_favourites_releases(self):
        from supysonic.managers.user import UserManager

        self.run_job()
        UserManager.add("bob", "B0bpass", admin=False)
        guest = self.app.test_client()
        guest.post("/api/login", json={"username": "bob", "password": "B0bpass"})
        self.assertEqual(guest.get("/api/releases").json["releases"], [])


class UpgradeTestCase(unittest.TestCase):
    """A server at 20261021 boots on this code with its data untouched."""

    def setUp(self):
        import tempfile

        fd, self.path = tempfile.mkstemp()
        os.close(fd)
        self.uri = "sqlite:///" + self.path
        init_database(self.uri)

    def tearDown(self):
        release_database()
        os.remove(self.path)

    def test_the_tables_arrive_and_nothing_else_changes(self):
        u = User.create(name="u", password="x", salt="x")
        a = Artist.create(name="A", deezer_id="1")
        StarredArtist.create(user=u, starred=a)
        release_database()
        conn = sqlite3.connect(self.path)
        for table in ("artist_watch", "artist_release", "artist_link", "artist_top", "user_taste", "artist_mute"):
            conn.execute(f"DROP TABLE {table}")
        conn.execute("UPDATE meta SET value = '20261021' WHERE key = 'schema_version'")
        conn.commit()
        before = conn.execute("SELECT * FROM starred_artist").fetchall()
        conn.close()
        init_database(self.uri)
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
        self.assertEqual(ArtistRelease.select().count(), 0)
        conn = sqlite3.connect(self.path)
        self.assertEqual(conn.execute("SELECT * FROM starred_artist").fetchall(), before)
        conn.close()
        # nobody moved the slider: the default level
        self.assertEqual(discover.level_of(u), discover.DEFAULT_LEVEL)

    def test_the_tables_are_in_the_copy_between_engines(self):
        order = {m._meta.table_name for m in dbmod._migration_order()}
        self.assertLessEqual(
            {"artist_watch", "artist_release", "artist_link", "artist_top", "user_taste", "artist_mute"},
            order,
        )


if __name__ == "__main__":
    unittest.main()

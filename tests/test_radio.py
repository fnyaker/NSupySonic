# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The genre graph and the genre radios built on it."""

import json
import os
import random
import shutil
import tempfile
import unittest

from supysonic.deezer import analysis as ana
from supysonic.deezer import genregraph as G
from supysonic.deezer import radio as R


class GraphTestCase(unittest.TestCase):
    def test_every_genre_the_engine_can_name_is_in_the_graph(self):
        missing = [l for l, _a in ana.known_genres() if not G.known(l)]
        self.assertEqual(missing, [])

    def test_similarity_is_a_symmetric_unit_interval_measure(self):
        labels = [l for l, _a in ana.known_genres()]
        rng = random.Random(1)
        for _ in range(400):
            a, b = rng.choice(labels), rng.choice(labels)
            s = G.similarity(a, b)
            self.assertTrue(0.0 <= s <= 1.0, (a, b, s))
            self.assertAlmostEqual(s, G.similarity(b, a), places=9, msg=(a, b))
        for l in labels[:30]:
            self.assertEqual(G.similarity(l, l), 1.0)
        self.assertEqual(G.similarity("Frenchcore", "not a genre"), 0.0)

    def test_it_says_what_the_scenes_say(self):
        sim = G.similarity
        self.assertGreater(sim("Frenchcore", "Uptempo"), sim("Frenchcore", "Hardstyle"))
        self.assertGreater(sim("Frenchcore", "Hardstyle"), sim("Frenchcore", "Jazz / acoustique"))
        self.assertGreater(sim("Hardtekk", "Tribe"), sim("Hardtekk", "Techno"))
        self.assertGreater(sim("Techno", "House"), sim("Techno", "Country"))
        self.assertGreater(sim("Drum & bass", "Jungle"), sim("Drum & bass", "Trance"))
        self.assertLess(sim("Death metal", "Lo-fi"), 0.2)

    def test_lookup_ignores_case_accents_and_punctuation(self):
        self.assertEqual(G.label("frenchcore"), "Frenchcore")
        self.assertEqual(G.label("DRUM  & BASS"), "Drum & bass")
        self.assertEqual(G.label("electronique"), "Électronique")

    def test_the_tree_has_one_root_chain_per_genre(self):
        self.assertEqual(G.lineage("Pieep")[:3], ["Pieep", "Uptempo", "Hardcore"])
        self.assertEqual(G.family_of("Pieep"), "Hard dance")
        self.assertEqual(G.family_of("Jazz / acoustique"), "Jazz et blues")
        self.assertIn("Frenchcore", G.children_of("Hardcore"))

    def test_asking_for_a_branch_means_all_of_it_and_the_dial_widens_it(self):
        tight = G.expand(["Hardcore"], spread=0.0)
        self.assertEqual(tight["Hardcore"], 1.0)
        self.assertGreaterEqual(tight["Frenchcore"], 0.9)
        self.assertNotIn("Jazz / acoustique", tight)
        wide = G.expand(["Hardcore"], spread=1.0)
        self.assertGreater(len(wide), len(tight))
        self.assertIn("Hard techno", wide)
        # Two seeds widen the pool; they do not dilute either.
        two = G.expand(["Hardcore", "Trance"], spread=0.0)
        self.assertEqual(two["Trance"], 1.0)
        self.assertEqual(two["Gabber"], tight["Gabber"])
        self.assertEqual(G.expand(["nothing"], 0.5), {})


def _cands(n_core=40, n_reach=40):
    out = []
    for i in range(n_core):
        out.append(R.Cand(f"c{i}", f"A{i % 12}", "Frenchcore", plays=i % 5, weight=1.0))
    for i in range(n_reach):
        out.append(R.Cand(f"r{i}", f"B{i % 12}", "Hardstyle", plays=0, weight=0.5))
    return out


class ScoringTestCase(unittest.TestCase):
    def test_a_recently_played_track_is_damped_at_any_dial(self):
        now = 1_000_000.0
        fresh = R.Cand("a", "x", "Frenchcore", plays=3, last_play=now - 60, weight=1)
        old = R.Cand("b", "x", "Frenchcore", plays=3, last_play=now - 10 * 86400, weight=1)
        for d in (0.0, 0.5, 1.0):
            self.assertLess(R.taste(fresh, 0, d, now), R.taste(old, 0, d, now) * 0.3)

    def test_discovery_prefers_the_unheard_and_loosens_the_usual(self):
        now = 1.0
        loved = R.Cand("a", "x", "Frenchcore", plays=40, starred=True, weight=1)
        new = R.Cand("b", "y", "Frenchcore", plays=0, weight=1)
        self.assertGreater(R.taste(loved, 0, 0.0, now), R.taste(new, 0, 0.0, now))
        gap_low = R.taste(loved, 0, 0.0, now) / R.taste(new, 0, 0.0, now)
        gap_high = R.taste(loved, 0, 1.0, now) / R.taste(new, 0, 1.0, now)
        self.assertLess(gap_high, gap_low)

    def test_unknown_tempo_is_not_a_bad_fit_but_a_wrong_one_is(self):
        self.assertEqual(R.bpm_fit(None, 170, 200), 1.0)
        self.assertEqual(R.bpm_fit(180, 170, 200), 1.0)
        self.assertLess(R.bpm_fit(120, 170, 200), 0.2)
        self.assertGreater(R.bpm_fit(165, 170, 200), R.bpm_fit(140, 170, 200))


class PickTestCase(unittest.TestCase):
    def _queue(self, discovery, seed, randomness=0.5, **kw):
        cands = R.score(_cands(**kw), discovery=discovery, now=1e9)
        return R.pick(cands, 30, discovery=discovery, randomness=randomness,
                      rng=random.Random(seed))

    def test_the_dial_moves_the_share_of_neighbouring_genres(self):
        share = lambda q: sum(c.genre != "Frenchcore" for c in q) / len(q)
        self.assertEqual(share(self._queue(0.0, 1)), 0.0)
        self.assertGreater(share(self._queue(1.0, 1)), 0.3)
        self.assertLessEqual(share(self._queue(1.0, 1)), R.MAX_REACH_SHARE + 0.05)

    def test_a_thin_core_hands_its_slots_to_the_reach_not_to_silence(self):
        q = self._queue(0.1, 2, n_core=3, n_reach=60)
        self.assertEqual(len(q), 30)

    def test_two_radios_on_the_same_style_are_not_the_same_queue(self):
        a = [c.id for c in self._queue(0.3, 1)]
        b = [c.id for c in self._queue(0.3, 2)]
        self.assertNotEqual(a, b)
        self.assertLess(len(set(a) & set(b)) / len(a), 0.95)
        # …and a seed repeats a queue exactly.
        self.assertEqual(a, [c.id for c in self._queue(0.3, 1)])

    def test_randomness_zero_is_a_ranking(self):
        a = [c.id for c in self._queue(0.0, 1, randomness=0.0)]
        b = [c.id for c in self._queue(0.0, 99, randomness=0.0)]
        self.assertEqual(a, b)

    def test_an_artist_is_not_repeated_inside_the_gap(self):
        q = self._queue(0.3, 3)
        for i in range(len(q)):
            window = [c.artist for c in q[max(0, i - R.ARTIST_GAP): i]]
            self.assertNotIn(q[i].artist, window)

    def test_no_track_twice(self):
        ids = [c.id for c in self._queue(0.8, 4)]
        self.assertEqual(len(ids), len(set(ids)))


class RadioEndpointTestCase(unittest.TestCase):
    def setUp(self):
        from supysonic.config import DefaultConfig
        from supysonic.db import release_database
        from supysonic.managers.user import UserManager
        from supysonic.web import create_application

        self._db = tempfile.mkstemp()
        self._dir = tempfile.mkdtemp()
        self._archive = tempfile.mkdtemp()
        db_path, cache = self._db[1], self._dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)

        self.app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0b-secret-77", admin=False)
        self.client = self.app.test_client()
        self._release = release_database
        self._seed()

    def tearDown(self):
        self._release()
        shutil.rmtree(self._dir, ignore_errors=True)
        shutil.rmtree(self._archive, ignore_errors=True)
        os.close(self._db[0])
        os.remove(self._db[1])

    def _seed(self):
        from supysonic.db import TrackAnalysis, now
        from supysonic.deezer import library

        root = library.get_root_folder(self._archive)
        styles = ["frenchcore"] * 14 + ["hardstyle"] * 8 + ["jazz"] * 8
        for i, style in enumerate(styles):
            t = library.upsert_track(
                {"SNG_ID": str(7000 + i), "SNG_TITLE": f"T{i}", "ART_ID": str(i % 7),
                 "ART_NAME": f"Artist {i % 7}", "ALB_ID": "1", "ALB_TITLE": "A",
                 "ALB_PICTURE": "x", "DURATION": 200, "TRACK_NUMBER": 1, "DISK_NUMBER": 1,
                 "EXPLICIT_LYRICS": "0", "GAIN": "-7.0"}, root)
            t.last_modification = 1
            t.save()
            TrackAnalysis.create(track=t, version=ana.ANALYSIS_VERSION, analyzed=now(),
                                 bpm=190.0, style=style, style_confidence=0.8,
                                 data=json.dumps({}))

    def _login(self, user="alice", pw="Alic3"):
        r = self.client.post("/api/login", json={"username": user, "password": pw})
        self.assertEqual(r.status_code, 200, r.data)

    def test_it_requires_login(self):
        self.assertEqual(self.client.get("/api/radio/genre?seeds=Frenchcore").status_code, 401)
        self.assertEqual(self.client.get("/api/radio/genres").status_code, 401)

    def test_unknown_or_missing_seeds_are_refused(self):
        self._login()
        for q in ("", "?seeds=", "?seeds=nonsense", "?seeds=%3Cscript%3E"):
            r = self.client.get("/api/radio/genre" + q)
            self.assertEqual(r.status_code, 400, q)

    def test_a_style_gives_that_style_and_a_guest_may_ask(self):
        for user, pw in (("alice", "Alic3"), ("bob", "B0b-secret-77")):
            self.client.get("/api/logout")
            self._login(user, pw)
            r = self.client.get("/api/radio/genre?seeds=Frenchcore&discovery=0&count=10&seed=1")
            self.assertEqual(r.status_code, 200, r.data)
            body = r.get_json()
            self.assertEqual(len(body["tracks"]), 10)
            self.assertEqual({w["genre_name"] for w in body["why"]}, {"Frenchcore"})

    def test_hostile_numbers_are_clamped_not_trusted(self):
        self._login()
        r = self.client.get("/api/radio/genre?seeds=Frenchcore&count=999999&discovery=nan"
                            "&randomness=-5&bpm_min=abc&bpm_max=1e999")
        self.assertEqual(r.status_code, 200)
        self.assertLessEqual(len(r.get_json()["tracks"]), 100)

    def test_the_dial_brings_in_neighbours_and_never_jazz(self):
        self._login()
        r = self.client.get("/api/radio/genre?seeds=Hardcore&discovery=1&count=20&seed=3")
        names = {w["genre_name"] for w in r.get_json()["why"]}
        self.assertIn("Frenchcore", names)
        self.assertNotIn("Jazz / acoustique", names)

    def test_the_genre_tree_counts_tracks(self):
        self._login()
        rows = {g["name"]: g for g in self.client.get("/api/radio/genres").get_json()["genres"]}
        self.assertEqual(rows["Frenchcore"]["tracks"], 14)
        self.assertGreaterEqual(rows["Hardcore"]["branch"], 14)
        self.assertEqual(rows["Frenchcore"]["parent"], "Hardcore")


if __name__ == "__main__":
    unittest.main()


class RecommendationsTestCase(RadioEndpointTestCase):
    def _star(self, user, n):
        from supysonic.db import StarredTrack, Track, User

        u = User.get(User.name == user)
        for t in Track.select().limit(n):
            StarredTrack.create(user=u, starred=t)

    def test_for_you_follows_the_listener_and_differs_each_visit(self):
        self._star("alice", 6)
        self._login()
        a = self.client.get("/api/recommendations/library").get_json()["mixes"]
        self.assertTrue(a)
        for m in a:
            self.assertTrue(m["tracks"])
            self.assertTrue(m["id"].startswith("for-you-"))
        seen = set()
        for _ in range(8):
            ms = self.client.get("/api/recommendations/library").get_json()["mixes"]
            seen.add(tuple(t["deezer_id"] for t in ms[0]["tracks"][:6]))
        self.assertGreater(len(seen), 1)  # not the same mix every time
        same = self.client.get("/api/recommendations/library?seed=7").get_json()
        again = self.client.get("/api/recommendations/library?seed=7").get_json()
        self.assertEqual(same, again)

    def test_a_listener_with_no_history_gets_an_empty_list_not_an_error(self):
        from supysonic.db import StarredTrack, Track, TrackAnalysis

        TrackAnalysis.delete().execute()
        self._login()
        r = self.client.get("/api/recommendations/library")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["mixes"], [])

    def test_similar_tracks_share_the_genre_and_leave_the_seed_out(self):
        from supysonic.db import Track, User

        u = User.get(User.name == "alice")
        seed = Track.select().first()
        got = R.similar(u, seed.deezer_id, count=8, rng=random.Random(1))
        self.assertTrue(got)
        self.assertNotIn(seed.id, [c.id for c in got])
        self.assertEqual({c.genre for c in got if c.weight >= 0.9}, {R.track_genre(seed.deezer_id)[0]})
        self.assertEqual(R.similar(u, "424242424"), [])  # unknown track: nothing, no crash

    def test_favourite_genres_spread_over_families(self):
        profile = {"Frenchcore": 50.0, "Uptempo": 40.0, "Techno": 8.0, "Jazz / acoustique": 6.0}
        for seed in range(20):
            got = R.favourite_genres(profile, 3, random.Random(seed))
            fams = [G.family_of(g) for g in got]
            self.assertEqual(len(got), len(set(got)))
            self.assertGreaterEqual(len(set(fams)), 2)

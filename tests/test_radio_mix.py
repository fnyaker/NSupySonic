# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The rebuilt radios, the Flow refills, the listening history and the
releases of listened artists (supysonic/radio.py, mix.py, listening.py,
releases.py; design: /mnt/project-files/algos/refonte-decouverte.md).

The library has the shape that made the old radio drift: a cluster X around
the seed, a cluster Y elsewhere, and a few BRIDGE titles that sound like both.
Refilling from the queue's last title walks across the bridge into Y within a
few refills; anchored on the seed it must not.
"""

import datetime
import os
import random
import unittest

from supysonic import db as dbmod
from supysonic import listening, mix, radio, releases
from supysonic.db import (
    Album, Artist, ArtistRelease, ArtistWatch, ListenEvent, Track, TrackAnalysis,
    TrackNeighbor, User,
)
from supysonic.providers.fake import FakeProvider

from .test_detach_a import _AppCase


class _Graph(_AppCase):
    """X: 6 artists x 5 titles, all near each other; Y: the same, near each
    other; B: 3 bridge titles near X's seed side AND near all of Y."""

    def setUp(self):
        super().setUp()
        from supysonic.deezer import library

        self.root = library.get_root_folder(self.archive)
        self.user = User.get(User.name == "alice")
        self.rows = {"X": [], "Y": [], "B": []}
        n = 0
        for group, artists, per in (("X", 6, 5), ("Y", 6, 5), ("B", 3, 1)):
            for a in range(artists):
                artist = Artist.create(name=f"{group}{a}")
                album = Album.create(name=f"{group}{a} LP", artist=artist)
                for i in range(per):
                    n += 1
                    t = Track.create(
                        disc=1, number=i + 1, title=f"{group}{a}-{i}", duration=200,
                        has_art=False, album=album, artist=artist, bitrate=0,
                        path=os.path.join(self.archive, f"{group}{a}-{i}.flac"),
                        last_modification=1, root_folder=self.root, folder=self.root,
                    )
                    TrackAnalysis.create(track=t, style="Techno" if group != "Y" else "Jazz", version=5)
                    self.rows[group].append(t)
        rng = random.Random(7)
        X, Y, B = self.rows["X"], self.rows["Y"], self.rows["B"]
        self.seed = X[0]

        def link(a, nbs):
            scored = sorted(nbs, key=lambda p: -p[1])[:50]
            for rank, (b, s) in enumerate(scored):
                TrackNeighbor.create(track=a, neighbor=b, score=s, rank=rank)

        for t in X:
            nbs = [(o, 0.80 + 0.1 * rng.random()) for o in X if o.id != t.id]
            nbs += [(b, 0.86) for b in B]  # the bridge sounds like X ...
            link(t, nbs)
        for t in Y:
            link(t, [(o, 0.80 + 0.1 * rng.random()) for o in Y if o.id != t.id] + [(b, 0.86) for b in B])
        for b in B:  # ... and Y sounds even more like the bridge
            link(b, [(y, 0.95) for y in Y] + [(x, 0.70) for x in X])

    def share_y(self, ids):
        ys = {t.id for t in self.rows["Y"]}
        return sum(1 for i in ids if i in ys) / max(1, len(ids))


class RadioTestCase(_Graph):
    def refills(self, anchored, rounds=6, n=10):
        """Play the radio like the player does: each refill after the queue."""
        queue = []
        heard = []
        shares = []
        rng = random.Random(3)
        for _ in range(rounds):
            if anchored:
                got = radio.build(self.user, [self.seed.id], n, recent=heard[-20:],
                                  exclude=queue, rng=rng)
            else:  # the old player and server: the nearest neighbours, in rank
                # order, of the queue's LAST title
                last = queue[-1] if queue else self.seed.id
                got = [
                    nid for (nid,) in TrackNeighbor.select(TrackNeighbor.neighbor)
                    .where(TrackNeighbor.track == last)
                    .order_by(TrackNeighbor.rank).tuples()
                    if nid not in queue and nid != self.seed.id
                ][:n]
            shares.append(self.share_y(got))
            queue += got
            heard += got
        return shares

    def test_anchored_on_its_seed_the_radio_does_not_drift(self):
        drift = self.refills(anchored=False)
        kept = self.refills(anchored=True)
        # measured: the old way is all Y from the third refill on; anchored,
        # Y only comes once the seed's own sound is used up.
        self.assertGreaterEqual(max(drift), 0.9, drift)
        self.assertEqual(kept[:3], [0.0, 0.0, 0.0], kept)

    def test_two_radios_of_one_seed_differ(self):
        a = radio.build(self.user, [self.seed.id], 12, rng=random.Random(1))
        b = radio.build(self.user, [self.seed.id], 12, rng=random.Random(2))
        self.assertNotEqual(a, b)
        self.assertGreaterEqual(len(set(a) ^ set(b)), 4)

    def test_artists_are_capped_and_spaced(self):
        ids = radio.build(self.user, [self.seed.id], 24, rng=random.Random(5))
        artists = [Track.get_by_id(i).artist_id for i in ids]
        per = {}
        for a in artists:
            per[a] = per.get(a, 0) + 1
        self.assertLessEqual(max(per.values()), 3)
        for i, a in enumerate(artists):
            self.assertNotIn(a, artists[max(0, i - 2):i], (i, artists))

    def test_a_skip_is_not_offered_again_and_pushes_its_neighbours_away(self):
        bridge = [b.id for b in self.rows["B"]]
        base = [radio.build(self.user, [self.seed.id], 20, rng=random.Random(s)) for s in range(6)]
        skipped = [radio.build(self.user, [self.seed.id], 20, skipped=bridge[:2],
                               rng=random.Random(s)) for s in range(6)]
        for ids in skipped:
            self.assertFalse(set(bridge[:2]) & set(ids))
        # the skipped bridge titles' neighbours (Y, and the last bridge) fall
        self.assertLessEqual(sum(map(self.share_y, skipped)), sum(map(self.share_y, base)))

    def test_a_title_skipped_twice_and_never_heard_is_left_out(self):
        b = self.rows["B"][0]
        for _ in range(2):
            listening.record(self.user, b, 3)
        for s in range(5):
            self.assertNotIn(b.id, radio.build(self.user, [self.seed.id], 30, rng=random.Random(s)))

    def test_a_track_with_no_neighbours_falls_back_on_its_artist_and_genre(self):
        TrackNeighbor.delete().execute()
        ids = radio.build(self.user, [self.seed.id], 10, rng=random.Random(0))
        self.assertEqual(len(ids), 10)
        styles = {TrackAnalysis.get_by_id(i).style for i in ids}
        self.assertEqual(styles, {"Techno"})


class RadioRoutesTestCase(_Graph):
    def test_the_track_radio_answers_and_varies(self):
        a = self.client.get(f"/api/radio/track/{self.seed.id}").json["tracks"]
        b = self.client.get(f"/api/radio/track/{self.seed.id}").json["tracks"]
        self.assertEqual(len(a), 40)
        self.assertNotEqual([t["deezer_id"] for t in a], [t["deezer_id"] for t in b])

    def test_next_keeps_the_seed_and_leaves_the_queue_out(self):
        queue = [str(t.id) for t in self.rows["X"][:10]]
        r = self.client.post("/api/radio/next", json={
            "seed": {"kind": "track", "id": str(self.seed.id)},
            "recent": queue[-5:], "skipped": [], "exclude": queue,
        })
        got = [t["deezer_id"] for t in r.json["tracks"]]
        self.assertTrue(got)
        self.assertFalse(set(got) & set(queue))

    def test_an_artist_radio_starts_with_the_artist_and_gives_it_room(self):
        artist = self.seed.artist
        tracks = self.client.get(f"/api/radio/artist/{artist.id}").json["tracks"]
        self.assertEqual(tracks[0]["artist"]["name"], artist.name)
        own = sum(1 for t in tracks if t["artist"]["name"] == artist.name)
        self.assertGreaterEqual(own, 3)

    def test_bad_input_is_refused_or_empty(self):
        post = self.client.post
        self.assertEqual(post("/api/radio/next", json={"seed": "x"}).status_code, 400)
        self.assertEqual(post("/api/radio/next", json={"seed": {"kind": "nope", "id": "1"}}).status_code, 400)
        self.assertEqual(post("/api/radio/next", json={"seed": {"kind": "track", "id": "../etc"}}).json["tracks"], [])
        r = post("/api/radio/next", json={"seed": {"kind": "track", "id": str(self.seed.id)},
                                          "exclude": "notalist", "recent": [{"a": 1}], "n": "x"})
        self.assertEqual(r.status_code, 200)

    def test_a_guest_never_gets_another_person_s_upload(self):
        from supysonic.managers.user import UserManager

        UserManager.add("bob", "B0bpass", admin=False)
        alice = User.get(User.name == "alice")
        private = self.rows["X"][1]
        Track.update(owner=alice.id).where(Track.id == private.id).execute()
        guest = self.app.test_client()
        guest.post("/api/login", json={"username": "bob", "password": "B0bpass"})
        for _ in range(3):
            got = [t["deezer_id"] for t in guest.get(f"/api/radio/track/{self.seed.id}").json["tracks"]]
            self.assertNotIn(str(private.id), got)


class AssembleTestCase(unittest.TestCase):
    def items(self, n_artists=4, per=6):
        out = []
        for a in range(n_artists):
            for i in range(per):
                out.append(mix.Item(f"{a}-{i}", 1.0 - 0.01 * i, artist=a, album=f"al{a}"))
        return out

    def test_the_draw_follows_the_scores(self):
        rng = random.Random(0)
        hits = {"big": 0, "small": 0}
        for _ in range(4000):
            first = mix.gumbel_order([mix.Item("big", 2.0), mix.Item("small", 1.0)], rng)[0]
            hits[first.key] += 1
        # proportional to the score: 2/3 of the time
        self.assertAlmostEqual(hits["big"] / 4000, 2 / 3, delta=0.03)

    def test_caps_and_gaps_hold_while_there_is_choice(self):
        got = mix.assemble(self.items(), 12, random.Random(1), cap=3, gap=3)
        artists = [it.artist for it in got]
        self.assertEqual(len(got), 12)
        for i, a in enumerate(artists):
            self.assertNotIn(a, artists[max(0, i - 2):i])
        self.assertTrue(all(artists.count(a) <= 3 for a in set(artists)))

    def test_a_thin_pool_is_still_filled(self):
        got = mix.assemble(self.items(n_artists=1, per=8), 8, random.Random(1), cap=3, gap=3)
        self.assertEqual(len(got), 8)
        got = mix.assemble(self.items(n_artists=1, per=8), 8, random.Random(1), cap=3, gap=3, relax=False)
        self.assertEqual(len(got), 6)  # twice the cap and no more

    def test_mmr_keeps_two_of_one_album_apart(self):
        def adjacent(lam):
            total = 0
            for seed in range(200):
                items = [mix.Item(f"a{i}", 1.0, album="A") for i in range(3)]
                items += [mix.Item(f"b{i}", 1.0, album="B") for i in range(3)]
                got = mix.assemble(items, 6, random.Random(seed), cap=99, gap=0, lam=lam)
                albums = [it.album for it in got]
                total += sum(1 for x, y in zip(albums, albums[1:]) if x == y)
            return total / 200

        # measured: 2.0 same-album neighbours out of 5 by chance, ~0 with MMR
        self.assertGreater(adjacent(1.0), 1.6)
        self.assertLess(adjacent(mix.LAMBDA), 1.2)


class ListeningTestCase(_Graph):
    def test_outcomes_follow_the_published_rules(self):
        self.assertEqual(listening.outcome(5, 200), -1)
        self.assertEqual(listening.outcome(29, 200), -1)
        self.assertEqual(listening.outcome(60, 200), 0)
        self.assertEqual(listening.outcome(100, 200), 1)  # half
        self.assertEqual(listening.outcome(240, 900), 1)  # four minutes
        self.assertEqual(listening.outcome(20, 21), 0)  # too short to be a listen (Last.fm)
        self.assertEqual(listening.outcome(5, 21), -1)
        self.assertEqual(listening.outcome(0, 0), -1)

    def test_the_player_report_is_kept_per_person_skips_included(self):
        t = self.rows["X"][2]
        self.client.post("/api/listen", json={"id": str(t.id), "listened": 4})
        self.client.post("/api/listen", json={"id": str(t.id), "listened": 150,
                                              "context": {"kind": "radio", "id": "x"}})
        rows = list(ListenEvent.select().order_by(ListenEvent.id))
        self.assertEqual([(r.outcome, r.listened) for r in rows], [(-1, 4), (1, 150)])
        self.assertEqual(rows[1].source, "radio")
        self.assertEqual(Track.get_by_id(t.id).play_count, 1)  # the skip is not a play

    def test_frequent_and_recent_ranks_before_frequent_long_ago(self):
        now = dbmod.now()
        a, b = self.rows["X"][1], self.rows["X"][2]
        for d in range(5):
            ListenEvent.create(user=self.user, track=a, at=now - datetime.timedelta(hours=d * 5),
                               listened=200, outcome=1)
            ListenEvent.create(user=self.user, track=b, at=now - datetime.timedelta(days=200 + d),
                               listened=200, outcome=1)
        h = listening.history(self.user)
        self.assertGreater(h.track[a.id], h.track[b.id])

    def test_two_people_have_two_profiles(self):
        from supysonic import discover
        from supysonic.managers.user import UserManager

        UserManager.add("bob", "B0bpass", admin=False)
        bob = User.get(User.name == "bob")
        for t in self.rows["Y"][:3]:
            for _ in range(3):
                listening.record(bob, t, 250)
        for t in self.rows["X"][:3]:
            for _ in range(3):
                listening.record(self.user, t, 250)
        discover.invalidate()
        mine = discover.profile(self.user, fresh=True).top_artists(1)
        theirs = discover.profile(bob, fresh=True).top_artists(1)
        self.assertNotEqual(mine, theirs)
        self.assertTrue(Artist.get_by_id(theirs[0]).name.startswith("Y"))


class FlowRefillTestCase(_Graph):
    def test_a_refill_never_brings_back_what_the_queue_holds(self):
        first = self.client.get("/api/flow?seed=a").json["tracks"]
        queue = [t["deezer_id"] for t in first]
        r = self.client.post("/api/flow", json={"exclude": queue, "skipped": queue[:2]})
        again = [t["deezer_id"] for t in r.json["tracks"]]
        self.assertFalse(set(again) & set(queue))

    def test_the_genre_pool_changes_from_one_draw_to_the_next(self):
        from supysonic import discover

        taste = discover.profile(self.user, fresh=True)

        def fresh(q):
            return q

        a = {r[0] for r in discover._sample_unplayed(fresh, taste, random.Random(1))[:20]}
        b = {r[0] for r in discover._sample_unplayed(fresh, taste, random.Random(2))[:20]}
        self.assertNotEqual(a, b)


class ListenedReleasesTestCase(_Graph):
    def setUp(self):
        super().setUp()
        self.fake = FakeProvider(id="deezer")
        self.app.providers._providers.clear()
        self.app.providers.register(self.fake)
        today = dbmod.now().date()
        recent = (today - datetime.timedelta(days=4)).isoformat()
        older = (today - datetime.timedelta(days=20)).isoformat()
        heard = self.rows["X"][0].artist
        Artist.update(deezer_id="42").where(Artist.id == heard.id).execute()
        for _ in range(4):
            listening.record(self.user, self.rows["X"][0], 250)
        self.fake.releases = {"42": [
            {"ref": "1", "title": "Big Album", "release_date": recent, "kind": "album"},
            {"ref": "2", "title": "Big Album (Single)", "release_date": older, "kind": "single"},
            {"ref": "3", "title": "Best Of", "release_date": recent, "kind": "compile"},
        ]}
        self.fake.related = {}

    def test_an_artist_listened_to_but_not_starred_is_followed(self):
        releases.run_once(self.app, stats={"pause": 0})
        self.assertTrue(ArtistWatch.select().where(ArtistWatch.ref == "42").exists())
        self.assertEqual(ArtistRelease.select().count(), 3)
        shown = self.client.get("/api/releases").json["releases"]
        # the compilation left out, the single folded into its album
        self.assertEqual([r["title"] for r in shown], ["Big Album"])

    def test_the_setting_can_turn_it_off(self):
        releases.save_settings({"listened": 0})
        releases.run_once(self.app, stats={"pause": 0})
        self.assertFalse(ArtistWatch.select().where(ArtistWatch.ref == "42").exists())

    def test_a_guest_with_no_history_does_not_see_the_owner_s(self):
        from supysonic.managers.user import UserManager

        releases.run_once(self.app, stats={"pause": 0})
        UserManager.add("bob", "B0bpass", admin=False)
        guest = self.app.test_client()
        guest.post("/api/login", json={"username": "bob", "password": "B0bpass"})
        self.assertEqual(guest.get("/api/releases").json["releases"], [])


class UpgradeTestCase(unittest.TestCase):
    """A server at 20261022 boots on this code: the history table arrives
    empty, nothing else moves, and the profile still answers from the shared
    counters until the person's own history is long enough."""

    def test_the_history_table_arrives_and_nothing_else_changes(self):
        import sqlite3
        import tempfile

        from supysonic.db import init_database, release_database

        fd, path = tempfile.mkstemp()
        os.close(fd)
        uri = "sqlite:///" + path
        try:
            init_database(uri)
            u = User.create(name="u", password="x", salt="x")
            release_database()
            conn = sqlite3.connect(path)
            conn.execute("DROP TABLE listen_event")
            conn.execute("UPDATE meta SET value = '20261022' WHERE key = 'schema_version'")
            conn.commit()
            before = conn.execute("SELECT * FROM user").fetchall()
            conn.close()
            init_database(uri)
            self.assertEqual(dbmod.Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
            self.assertEqual(ListenEvent.select().count(), 0)
            self.assertEqual(listening.history(u).events, 0)
            release_database()
            conn = sqlite3.connect(path)
            self.assertEqual(conn.execute("SELECT * FROM user").fetchall(), before)
            conn.close()
        finally:
            release_database()
            os.remove(path)


if __name__ == "__main__":
    unittest.main()

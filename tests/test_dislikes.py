# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

""""Je n'aime pas" (supysonic/dislikes.py): the title, its other rows and the
titles that sound almost the same leave the radios, the Flow and the mixes;
the farther neighbours are only pushed down; nothing a person plays
themselves is touched."""

import os
import random
import sqlite3
import tempfile
import unittest

from supysonic import db as dbmod
from supysonic import discover, dislikes, radio
from supysonic.db import Album, Track, TrackDislike, TrackNeighbor, User, UserTaste

from .test_discover import count_statements
from .test_radio_mix import _Graph


class _Disliked(_Graph):
    def setUp(self):
        super().setUp()
        X = self.rows["X"]
        # X[1] is disliked; X[2] sounds almost the same as it (rank 0, 0.95),
        # X[3] is a farther neighbour (0.82), X[4] is untouched.
        self.bad, self.twin, self.near, self.far = X[1], X[2], X[3], X[4]
        TrackNeighbor.delete().where(TrackNeighbor.track == self.bad.id).execute()
        TrackNeighbor.create(track=self.bad, neighbor=self.twin, score=0.95, rank=0)
        TrackNeighbor.create(track=self.bad, neighbor=self.near, score=0.82, rank=1)
        # nobody else lists the twin or the bad one among their very first
        TrackNeighbor.update(rank=TrackNeighbor.rank + 3).where(
            TrackNeighbor.neighbor.in_([self.bad.id, self.twin.id])
            & (TrackNeighbor.track != self.bad.id)
        ).execute()
        # The same recording on a single, by the same artist.
        single = Album.create(name="Single", artist=self.bad.artist)
        self.copy = Track.create(
            disc=1, number=1, title=self.bad.title, duration=200, has_art=False,
            album=single, artist=self.bad.artist, bitrate=0,
            path=os.path.join(self.archive, "copy.flac"), last_modification=1,
            root_folder=self.root, folder=self.root, deezer_id="777",
        )

    def dislike(self, track=None, on=True):
        r = self.client.post("/api/dislike", json={"id": str((track or self.bad).id), "on": on})
        self.assertEqual(r.status_code, 200, r.data)
        return r.json


class DislikesTestCase(_Disliked):
    def test_the_title_its_copy_and_its_twin_are_excluded_the_near_one_pushed(self):
        dislikes.set_disliked(self.user, self.bad, True)
        d = dislikes.load(self.user)
        self.assertEqual(d.tracks, {self.bad.id})
        self.assertTrue({self.bad.id, self.copy.id, self.twin.id} <= d.excluded)
        self.assertNotIn(self.near.id, d.excluded)
        # its second neighbour: FLOOR plus a twentieth of the way to 1
        self.assertAlmostEqual(d.factor(self.near.id), 0.3 + 0.7 / 20, places=6)
        # a title of the other cluster: untouched
        self.assertEqual(d.factor(self.rows["Y"][0].id), 1.0)
        self.assertIn("777", d.deezer)

    def test_a_neighbour_is_only_very_close_among_the_first_ranks(self):
        TrackNeighbor.update(rank=dislikes.VERY_CLOSE_RANK).where(
            (TrackNeighbor.track == self.bad.id) & (TrackNeighbor.neighbor == self.twin.id)
        ).execute()
        dislikes.set_disliked(self.user, self.bad, True)
        d = dislikes.load(self.user)
        self.assertNotIn(self.twin.id, d.excluded)
        self.assertAlmostEqual(d.factor(self.twin.id), 0.3 + 0.7 * 3 / 20)

    def test_the_radio_never_offers_them_and_offers_the_near_one_less(self):
        def counts():
            seen = {}
            for s in range(40):
                for i in radio.build(self.user, [self.seed.id], 8, rng=random.Random(s)):
                    seen[i] = seen.get(i, 0) + 1
            return seen

        before = counts()
        self.assertTrue(before.get(self.bad.id) and before.get(self.twin.id))
        dislikes.set_disliked(self.user, self.bad, True)
        after = counts()
        for gone in (self.bad.id, self.twin.id, self.copy.id):
            self.assertNotIn(gone, after)
        # 40 radios of 8 titles: the near title 13 times before, 4 after (measured)
        self.assertLess(after.get(self.near.id, 0), before[self.near.id])

    def test_a_radio_started_on_the_disliked_title_still_answers(self):
        dislikes.set_disliked(self.user, self.bad, True)
        r = self.client.get(f"/api/radio/track/{self.bad.id}").json["tracks"]
        self.assertGreaterEqual(len(r), 20)

    def test_the_flow_leaves_them_out_and_their_weight_out_of_the_taste(self):
        from supysonic import listening

        for _ in range(4):
            listening.record(self.user, self.bad, 200)
        discover.invalidate(self.user)
        self.assertIn(self.bad.id, discover.profile(self.user).tracks)
        self.dislike()
        taste = discover.profile(self.user)
        self.assertNotIn(self.bad.id, taste.tracks)
        for s in range(10):
            ids = {c.track for c in discover.flow(self.user, 0.2, 30, seed=str(s))}
            self.assertFalse(ids & {self.bad.id, self.twin.id, self.copy.id})

    def test_a_catalogue_title_of_the_same_recording_is_left_out(self):
        dislikes.set_disliked(self.user, self.bad, True)
        pool = {
            "deezer:777": discover.Cand("deezer:777", 0.3, 0.5, "", provider="deezer", ref="777"),
            "deezer:778": discover.Cand("deezer:778", 0.3, 0.5, "", provider="deezer", ref="778"),
        }
        discover.apply_dislikes(pool, dislikes.load(self.user))
        self.assertEqual(list(pool), ["deezer:778"])

    def test_loading_costs_four_statements_at_most(self):
        dislikes.set_disliked(self.user, self.bad, True)
        n = count_statements(lambda: dislikes.load(self.user, fresh=True))
        self.assertLessEqual(n, 4)


class RoutesTestCase(_Disliked):
    def test_on_off_listed_and_in_the_heart_ids(self):
        self.assertEqual(self.dislike(), {"disliked": True, "id": str(self.bad.id)})
        ids = [t["deezer_id"] for t in self.client.get("/api/me/dislikes").json["tracks"]]
        self.assertEqual(ids, [str(self.bad.id)])
        self.assertEqual(self.client.get("/api/me/favorite-ids").json["disliked"], [str(self.bad.id)])
        self.dislike(on=False)
        self.assertEqual(self.client.get("/api/me/dislikes").json["tracks"], [])
        self.assertEqual(TrackDislike.select().count(), 0)

    def test_twice_is_once(self):
        self.dislike()
        self.dislike()
        self.assertEqual(TrackDislike.select().count(), 1)

    def test_the_third_title_of_an_artist_offers_to_mute_it(self):
        X = self.rows["X"]
        same = [t for t in X if t.artist_id == self.bad.artist_id and t.id != self.bad.id]
        self.assertNotIn("artist_hint", self.dislike())
        self.assertNotIn("artist_hint", self.dislike(same[0]))
        hint = self.dislike(same[1])["artist_hint"]
        self.assertEqual((hint["provider"], hint["id"], hint["count"]),
                         ("local", str(self.bad.artist_id), 3))
        self.client.post("/api/discover/mute", json={"provider": "local", "id": hint["id"]})
        self.assertNotIn("artist_hint", self.dislike(same[2]))

    def test_bad_input_is_refused(self):
        post = self.client.post
        self.assertEqual(post("/api/dislike", json={"id": "../etc"}).status_code, 400)
        self.assertEqual(post("/api/dislike", json={}).status_code, 400)
        self.assertEqual(post("/api/dislike", data="x").status_code, 400)

    def test_a_guest_cannot_dislike_another_person_s_upload_and_has_their_own_list(self):
        from supysonic.managers.user import UserManager

        UserManager.add("bob", "B0bpass", admin=False)
        Track.update(owner=self.user.id).where(Track.id == self.far.id).execute()
        guest = self.app.test_client()
        guest.post("/api/login", json={"username": "bob", "password": "B0bpass"})
        self.assertEqual(guest.post("/api/dislike", json={"id": str(self.far.id)}).status_code, 400)
        self.dislike()
        self.assertEqual(guest.get("/api/me/dislikes").json["tracks"], [])
        bob = User.get(User.name == "bob")
        self.assertFalse(dislikes.load(bob))

    def test_a_home_mix_leaves_them_out(self):
        self.dislike()
        r = self.client.get("/api/home/mix/techno")
        self.assertEqual(r.status_code, 200)
        ids = {t["deezer_id"] for t in r.json["tracks"]}
        self.assertTrue(ids)
        self.assertFalse(ids & {str(self.bad.id), str(self.twin.id), "777"})

    def test_the_route_needs_a_login(self):
        anon = self.app.test_client()
        self.assertIn(anon.post("/api/dislike", json={"id": str(self.bad.id)}).status_code, (401, 403))
        self.assertIn(anon.get("/api/me/dislikes").status_code, (401, 403))


class UpgradeTestCase(unittest.TestCase):
    """A server at 20261030 boots on this code: the table and the column
    arrive, nothing else moves."""

    def test_the_table_and_the_column_arrive(self):
        from supysonic.db import init_database, release_database

        fd, path = tempfile.mkstemp()
        os.close(fd)
        uri = "sqlite:///" + path
        try:
            init_database(uri)
            u = User.create(name="u", password="x", salt="x")
            UserTaste.create(user=u, discovery=0.6)
            release_database()
            conn = sqlite3.connect(path)
            conn.execute("DROP TABLE track_dislike")
            conn.execute("ALTER TABLE user_taste DROP COLUMN energy")
            conn.execute("UPDATE meta SET value = '20261030' WHERE key = 'schema_version'")
            conn.commit()
            before = conn.execute("SELECT user_id, discovery FROM user_taste").fetchall()
            conn.close()
            init_database(uri)
            self.assertEqual(dbmod.Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
            self.assertEqual(TrackDislike.select().count(), 0)
            self.assertIsNone(UserTaste.get(UserTaste.user == u).energy)
            release_database()
            conn = sqlite3.connect(path)
            self.assertEqual(conn.execute("SELECT user_id, discovery FROM user_taste").fetchall(), before)
            conn.close()
        finally:
            release_database()
            os.remove(path)

    def test_the_table_is_in_the_copy_between_engines(self):
        self.assertIn("track_dislike", {m._meta.table_name for m in dbmod._migration_order()})


if __name__ == "__main__":
    unittest.main()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot F of the Deezer detachment: the neighbours index, and a radio, a flow and
a home that read the library and nothing else — including on a server that
already had data (an old database, an old config, vectors on disk, no
neighbours yet)."""

import datetime
import os
import random
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock

from supysonic import db as dbmod
from supysonic import similar
from supysonic.config import DefaultConfig
from supysonic.db import (
    Track,
    TrackAnalysis,
    TrackNeighbor,
    User,
    init_database,
    now,
    release_database,
)
from supysonic.deezer import embedding as emb
from supysonic.deezer import library
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from . import test_detach_a as _ta
from . import test_webui as _tw
from .test_deezer import count_statements

DIM = emb.V2_EMBED_DIM
AUTH = 1  # the session's user lookup, which every /api request pays


def vector(cluster, seed, spread=0.15):
    """A vector near the centre of ``cluster`` (centres are far apart)."""
    # Even and odd clusters of a pair are opposites (cosine -1): never neighbours.
    sign = 1 if cluster % 2 == 0 else -1
    centre = random.Random(1000 + cluster // 2)
    noise = random.Random(seed)
    return [sign * centre.gauss(0, 1) + noise.gauss(0, 1) * spread for _ in range(DIM)]


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (sum(x * x for x in a) ** 0.5 * sum(y * y for y in b) ** 0.5)


class Base(unittest.TestCase):
    _login = _tw.WebUITestCase._login

    def setUp(self):  # noqa: F811 - extends the borrowed one
        _tw.WebUITestCase.setUp(self)
        UserManager.add("bob", "B0b")
        self._n = 0
        similar.drop_index()

    def tearDown(self):  # noqa: F811
        similar.drop_index()
        _tw.WebUITestCase.tearDown(self)

    def track(self, title, *, cluster=None, artist="1", album="10", bpm=None,
              style=None, plays=0, last_play=None, archived=True, seed=None, spread=0.15):
        self._n += 1
        sid = str(7000 + self._n)
        root = library.get_root_folder(self.archive)
        t = library.upsert_track(
            {
                "SNG_ID": sid,
                "SNG_TITLE": title,
                "ART_NAME": f"Artist {artist}",
                "ART_ID": artist,
                "ALB_TITLE": f"Album {album}",
                "ALB_ID": album,
                "DURATION": "200",
                "TRACK_NUMBER": str(self._n),
                "DISK_NUMBER": "1",
                "ALB_PICTURE": "md5" + album,
            },
            root,
        )
        if archived:
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"flacdata")
            t.last_modification = 1700000000
        t.play_count = plays
        t.last_play = last_play
        t.save()
        if cluster is not None:
            self.assertTrue(
                emb.save_embedding(
                    t, vector(cluster, seed if seed is not None else self._n, spread)
                )
            )
        if bpm is not None or style is not None:
            TrackAnalysis.create(track=t, bpm=bpm, style=style)
        return t

    def titles(self, path):
        rv = self.client.get(path)
        self.assertEqual(rv.status_code, 200, path)
        return [t["title"] for t in rv.get_json()["tracks"]]


class WeightTest(unittest.TestCase):
    def test_tempo_weight_is_one_within_six_percent_or_an_octave(self):
        self.assertEqual(similar.tempo_weight(174, 174), 1.0)
        self.assertEqual(similar.tempo_weight(174, 174 * 1.059), 1.0)
        self.assertEqual(similar.tempo_weight(87, 174), 1.0)
        self.assertEqual(similar.tempo_weight(348, 174.5), 1.0)
        self.assertEqual(similar.tempo_weight(174, 174 * 1.07), similar.TEMPO_MISMATCH)
        self.assertEqual(similar.tempo_weight(128, 174), similar.TEMPO_MISMATCH)

    def test_an_unknown_tempo_holds_nothing_against_a_track(self):
        self.assertEqual(similar.tempo_weight(None, 174), 1.0)
        self.assertEqual(similar.tempo_weight(0, 174), 1.0)
        self.assertEqual(similar.tempo_weight(128, None), 1.0)

    def test_the_same_served_genre_is_favoured(self):
        self.assertAlmostEqual(similar.pair_weight(174, "dnb", 174, "dnb"), 1.1)
        self.assertEqual(similar.pair_weight(174, "dnb", 174, "house"), 1.0)
        self.assertEqual(similar.pair_weight(174, None, 174, None), 1.0)
        self.assertAlmostEqual(similar.pair_weight(128, "dnb", 174, "dnb"), 0.8 * 1.1)


class IndexTest(Base):
    def populate(self):
        self.a = [self.track(f"A{i}", cluster=0, artist="1", plays=i) for i in range(6)]
        self.b = [self.track(f"B{i}", cluster=1, artist="2", album="20") for i in range(6)]

    def test_a_track_is_next_to_its_own_cluster(self):
        self.populate()
        for t in self.a + self.b:
            similar.rebuild_for(t, symmetric=False)
        rows = list(
            TrackNeighbor.select().where(TrackNeighbor.track == self.a[0].id).order_by(TrackNeighbor.rank)
        )
        # Unrelated clusters sit at a cosine of about zero: not neighbours.
        self.assertGreaterEqual(len(rows), 5)
        self.assertEqual([r.rank for r in rows], list(range(len(rows))))
        scores = [r.score for r in rows]
        self.assertEqual(scores, sorted(scores, reverse=True))
        own = {t.id for t in self.a[1:]}
        self.assertEqual({r.neighbor_id for r in rows[:5]}, own)
        self.assertNotIn(self.a[0].id, {r.neighbor_id for r in rows})

    def test_only_fifty_are_kept(self):
        for i in range(60):
            self.track(f"T{i}", cluster=0)
        t = Track.select().first()
        similar.rebuild_for(t, symmetric=False)
        self.assertEqual(
            TrackNeighbor.select().where(TrackNeighbor.track == t.id).count(), similar.KEEP
        )

    def neighbours_of(self, t):
        return [
            r.neighbor_id
            for r in TrackNeighbor.select()
            .where(TrackNeighbor.track == t.id)
            .order_by(TrackNeighbor.rank)
        ]

    def test_a_tempo_that_does_not_agree_sends_a_track_down(self):
        me = self.track("Me", cluster=0, bpm=174, spread=0.0)
        # Closer in sound, but at the wrong tempo...
        far = self.track("Far", cluster=0, bpm=100, spread=0.02, seed=11)
        # ...than one at the same tempo that sounds a little less alike.
        near = self.track("Near", cluster=0, bpm=348, spread=0.3, seed=12)
        similar.rebuild_for(me, symmetric=False)
        self.assertEqual(self.neighbours_of(me), [near.id, far.id])

    def test_the_same_served_genre_sends_a_track_up(self):
        me = self.track("Me", cluster=0, style="dnb", spread=0.0)
        other = self.track("Other", cluster=0, style="house", spread=0.1, seed=11)
        same = self.track("Same", cluster=0, style="dnb", spread=0.12, seed=12)
        cos = lambda t: cosine(
            emb.common_part(emb.load_embedding(me)), emb.common_part(emb.load_embedding(t))
        )
        self.assertGreater(cos(other), cos(same))  # the sound alone would say Other
        similar.rebuild_for(me, symmetric=False)
        self.assertEqual(self.neighbours_of(me), [same.id, other.id])

    def test_a_late_arrival_is_offered_to_the_tracks_it_lands_next_to(self):
        self.populate()
        for t in self.a + self.b:
            similar.rebuild_for(t, symmetric=False)
        similar.drop_index()
        late = self.track("Late", cluster=0)
        self.assertEqual(TrackNeighbor.select().where(TrackNeighbor.neighbor == late.id).count(), 0)
        similar.rebuild_for(late)
        offered = {r.track_id for r in TrackNeighbor.select().where(TrackNeighbor.neighbor == late.id)}
        self.assertEqual(offered, {t.id for t in self.a})
        # and re-running changes nothing (no duplicate, no growth)
        similar.rebuild_for(late)
        self.assertEqual(TrackNeighbor.select().where(TrackNeighbor.neighbor == late.id).count(), 6)

    def test_a_track_without_a_vector_has_no_neighbours(self):
        t = self.track("Mute")
        self.assertEqual(similar.rebuild_for(t), 0)
        self.assertEqual(TrackNeighbor.select().count(), 0)

    def test_pure_python_ranks_like_numpy(self):
        self.populate()
        t = self.a[0]
        similar.rebuild_for(t, symmetric=False)
        with_np = [r.neighbor_id for r in TrackNeighbor.select().where(TrackNeighbor.track == t.id).order_by(TrackNeighbor.rank)]
        similar.drop_index()
        with mock.patch.object(similar, "np", None):
            similar.rebuild_for(t, symmetric=False)
            without = [r.neighbor_id for r in TrackNeighbor.select().where(TrackNeighbor.track == t.id).order_by(TrackNeighbor.rank)]
        self.assertEqual(set(with_np[:5]), set(without[:5]))
        self.assertEqual(set(with_np[:5]), {x.id for x in self.a[1:]})

    def test_the_full_rebuild_fills_the_table(self):
        self.populate()
        job = similar.rebuild_job()
        snap = job.run()
        self.assertEqual(snap["failed"], 0)
        self.assertEqual(snap["done"], 12)
        self.assertEqual(similar.status()["tracks"], 12)
        # finished: no checkpoint left behind
        self.assertIsNone(dbmod.Meta.get_or_none(dbmod.Meta.key == similar.CURSOR_KEY))

    def test_the_queue_is_bounded_and_does_nothing_under_test(self):
        with self.app.app_context():
            self.assertFalse(similar.queue_track(self.track("X", cluster=0).id))


class RouteTest(Base):
    def test_track_radio_follows_the_stored_neighbours_in_three_reads(self):
        a = [self.track(f"A{i}", cluster=0) for i in range(14)]
        [self.track(f"B{i}", cluster=1, artist="2", album="20") for i in range(6)]
        job = similar.rebuild_job()
        job.run()
        similar.drop_index()
        self._login()
        with count_statements() as n:
            titles = self.titles(f"/api/radio/track/{a[0].id}")
        self.assertLessEqual(sum(n.values()), AUTH + 3, n)
        self.assertEqual(set(titles), {f"A{i}" for i in range(1, 14)})
        # The Deezer id of the same row works too.
        self.assertEqual(self.titles(f"/api/radio/track/{a[0].deezer_id}"), titles)

    def test_radio_works_with_deezer_unreachable(self):
        a = [self.track(f"A{i}", cluster=0) for i in range(4)]
        similar.rebuild_job().run()
        similar.drop_index()
        self._login()
        self.app.deezer = None
        self.assertEqual(len(self.titles(f"/api/radio/track/{a[0].id}")), 3)
        self.assertEqual(len(self.titles("/api/flow")) >= 0, True)

    def test_what_is_not_on_disk_or_was_just_played_is_not_offered(self):
        me = self.track("Me", cluster=0)
        gone = self.track("Gone", cluster=0, archived=False)
        dead = self.track("Dead", cluster=0)
        Track.update(unavailable=now()).where(Track.id == dead.id).execute()
        fresh = self.track("Fresh", cluster=0, last_play=now() - datetime.timedelta(minutes=2))
        old = self.track("Old", cluster=0, last_play=now() - datetime.timedelta(days=2))
        ok = self.track("Ok", cluster=0)
        similar.rebuild_job().run()
        similar.drop_index()
        self._login()
        self.assertEqual(
            sorted(self.titles(f"/api/radio/track/{me.id}")), ["Ok", "Old"]
        )
        del gone, fresh, old, ok

    def test_a_private_upload_is_for_its_owner_only(self):
        me = self.track("Me", cluster=0)
        mine = self.track("Alices", cluster=0)
        Track.update(owner=User.get(name="alice")).where(Track.id == mine.id).execute()
        public = self.track("Public", cluster=0)
        similar.rebuild_job().run()
        similar.drop_index()
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        self.assertEqual(self.titles(f"/api/radio/track/{me.id}"), ["Public"])
        del public

    def test_a_track_with_no_vector_starts_from_its_artist_then_its_genre(self):
        me = self.track("Me", artist="1", style="frenchcore", plays=1)
        self.track("Same artist", artist="1", plays=5)
        self.track("Same genre", artist="2", album="20", style="frenchcore", plays=9)
        self.track("Other", artist="3", album="30", style="house", plays=99)
        self._login()
        self.assertEqual(
            self.titles(f"/api/radio/track/{me.id}"), ["Same artist", "Same genre"]
        )

    def test_unknown_and_hostile_ids_give_an_empty_queue(self):
        self._login()
        for raw in ("123456789", "..x", "not-a-uuid", "0" * 70):
            self.assertEqual(self.titles(f"/api/radio/track/{raw}"), [], raw)
            self.assertEqual(self.titles(f"/api/radio/artist/{raw}"), [], raw)

    def test_flow_continues_from_the_last_tracks_played(self):
        self.track("A0", cluster=0, last_play=now() - datetime.timedelta(hours=2))
        a1 = self.track("A1", cluster=0, last_play=now() - datetime.timedelta(hours=1))
        for i in range(2, 6):
            self.track(f"A{i}", cluster=0)
        for i in range(4):
            self.track(f"B{i}", cluster=1, artist="2", album="20")
        similar.rebuild_job().run()
        similar.drop_index()
        self._login()
        titles = self.titles("/api/flow")
        self.assertEqual(set(titles[:4]), {"A2", "A3", "A4", "A5"})
        self.assertNotIn("A1", titles)
        del a1

    def test_flow_with_no_history_offers_the_most_played(self):
        self.track("Low", plays=1)
        self.track("High", plays=9)
        self._login()
        self.assertEqual(self.titles("/api/flow"), ["High", "Low"])

    def test_flow_is_open_to_a_guest(self):
        self.track("Low", plays=1)
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        self.assertEqual(self.titles("/api/flow"), ["Low"])

    def test_artist_radio_starts_with_the_artist_then_what_sounds_like_them(self):
        own = [self.track(f"Own{i}", cluster=0, artist="1", plays=10 - i) for i in range(3)]
        for i in range(3):
            self.track(f"Like{i}", cluster=0, artist="2", album="20")
        for i in range(3):
            self.track(f"Far{i}", cluster=1, artist="3", album="30")
        similar.rebuild_job().run()
        similar.drop_index()
        self._login()
        titles = self.titles("/api/radio/artist/1")
        self.assertEqual(titles[:3], ["Own0", "Own1", "Own2"])
        self.assertEqual(set(titles[3:6]), {"Like0", "Like1", "Like2"})
        self.assertEqual(self.titles(f"/api/radio/artist/{own[0].artist_id}"), titles)
        neigh = similar.artist_neighbors(own[0].artist_id)
        self.assertEqual(len(neigh), 1)  # artist 2 sounds like artist 1; 3 does not


class HomeTest(Base):
    def test_the_rows(self):
        old = now() - datetime.timedelta(days=200)
        a = self.track("Loved long ago", album="10", plays=5, last_play=old)
        self.track("Loved long ago 2", album="10", plays=4, last_play=old)
        self.track("Played lately", album="20", artist="2", plays=7, last_play=now())
        self.track("Never played", album="30", artist="3")
        Track.update(created=now() - datetime.timedelta(days=30)).where(Track.id == a.id).execute()
        self._login()
        data = self.client.get("/api/home").get_json()
        self.assertEqual(data["recent"][0]["title"], "Album 30")
        self.assertEqual({x["title"] for x in data["recent"]}, {"Album 10", "Album 20", "Album 30"})
        self.assertEqual([x["title"] for x in data["popular"]], ["Album 20"])
        self.assertEqual([x["title"] for x in data["forgotten"]], ["Album 10"])
        card = data["forgotten"][0]
        self.assertEqual(card["nb_tracks"], 2)
        self.assertEqual(card["artist"]["name"], "Artist 1")
        self.assertTrue(card["id"] and card["deezer_id"])

    def test_the_mixes_are_the_three_most_present_genres(self):
        for style, count in (("frenchcore", 7), ("techno", 6), ("house", 5), ("trance", 5), ("rare", 4)):
            for i in range(count):
                self.track(f"{style}{i}", style=style, plays=i if style == "techno" else 0,
                           album=str(40 + i % 3))
        self._login()
        data = self.client.get("/api/home").get_json()
        self.assertEqual(
            [m["title"] for m in data["mixes"]], ["Mix Frenchcore", "Mix Techno", "Mix House"]
        )
        self.assertEqual([m["id"] for m in data["mixes"]], ["frenchcore", "techno", "house"])
        self.assertTrue(all(m["cover"] for m in data["mixes"]))

    def test_the_home_is_six_reads_at_most(self):
        for i in range(20):
            self.track(f"T{i}", style="techno" if i % 2 else "house", album=str(i % 4),
                       plays=i, last_play=now() - datetime.timedelta(days=100))
        self._login()
        with count_statements() as n:
            self.assertEqual(self.client.get("/api/home").status_code, 200)
        self.assertLessEqual(sum(n.values()), AUTH + 6, n)

    def test_a_mix_leads_with_the_most_played_and_is_the_same_all_day(self):
        for i in range(40):
            self.track(f"T{i}", style="techno", plays=100 if i == 17 else 0)
        self.track("Other", style="house")
        self._login()
        data = self.client.get("/api/home/mix/techno").get_json()
        self.assertEqual(data["playlist"]["title"], "Mix Techno")
        titles = [t["title"] for t in data["tracks"]]
        self.assertEqual(len(titles), 25)
        self.assertEqual(titles[0], "T17")
        self.assertEqual(len(set(titles)), 25)
        self.assertNotIn("Other", titles)
        self.assertEqual(self.titles("/api/home/mix/techno"), titles)
        self.assertTrue(data["playlist"]["cover"])
        tomorrow = now() + datetime.timedelta(days=1)
        with mock.patch("supysonic.webui.now", return_value=tomorrow):
            other = self.titles("/api/home/mix/techno")
        self.assertEqual(other[0], "T17")
        self.assertNotEqual(other, titles)

    def test_a_mix_that_does_not_exist_or_is_malformed(self):
        self.track("T", style="techno")
        self._login()
        self.assertEqual(self.client.get("/api/home/mix/nothing").status_code, 404)
        self.assertIn(self.client.get("/api/home/mix/..%2Fx").status_code, (400, 404))
        self.assertEqual(self.client.get("/api/home/mix/" + "a" * 80).status_code, 400)

    def test_the_home_needs_no_deezer(self):
        self.track("T", style="techno", plays=1)
        self._login()
        self.app.deezer = None
        self.assertEqual(self.client.get("/api/home").status_code, 200)
        self.assertEqual(self.client.get("/api/home/mix/techno").status_code, 200)

    def test_a_guest_sees_the_shared_library_not_a_private_upload(self):
        mine = self.track("Private", style="techno")
        Track.update(owner=User.get(name="alice")).where(Track.id == mine.id).execute()
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        data = self.client.get("/api/home").get_json()
        self.assertEqual(data["recent"], [])
        self.assertEqual(self.client.get("/api/home/mix/techno").status_code, 404)


class RebuildRouteTest(Base):
    def test_admin_only(self):
        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        self.assertEqual(self.client.post("/api/similar/rebuild").status_code, 403)
        self.assertEqual(self.client.get("/api/similar/rebuild").status_code, 403)

    def test_the_button_rebuilds_and_the_status_reports(self):
        for i in range(4):
            self.track(f"A{i}", cluster=0)
        self._login()
        from supysonic.webui import neighbors

        done = []
        real = similar.run_rebuild
        with mock.patch.object(
            similar, "run_rebuild", lambda app, job: (real(app, job), done.append(1))
        ):
            body = self.client.post("/api/similar/rebuild").get_json()
            self.assertTrue(body["ok"])
            for _ in range(200):
                if done:
                    break
                import time

                time.sleep(0.05)
        self.assertTrue(done)
        status = self.client.get("/api/similar/rebuild").get_json()
        self.assertFalse(status["running"])
        self.assertEqual(status["tracks"], 4)
        self.assertEqual(status["done"], 4)
        del neighbors


class UpgradeTest(unittest.TestCase):
    """A server that predates this lot: the 20261012 database, its tracks and
    vectors on disk, the old config with the Deezer options nothing reads any
    more. It boots, plays a radio at once from what the database knows, and
    after the rebuild button from the neighbours."""

    make_old_database = _ta.UpgradeTestCase.make_old_database

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "old.db")
        similar.drop_index()

    def tearDown(self):
        similar.drop_index()
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)

    def test_an_existing_server(self):
        self.make_old_database()
        # What the old server already held: archived tracks with their vectors.
        init_database("sqlite:///" + self.path)
        root = library.get_root_folder(self.archive)
        rows = []
        for i in range(6):
            t = library.upsert_track(
                {
                    "SNG_ID": str(900 + i), "SNG_TITLE": f"Old{i}", "ART_NAME": "Old Artist",
                    "ART_ID": "5", "ALB_TITLE": "Old Album", "ALB_ID": "50", "DURATION": "200",
                    "TRACK_NUMBER": str(i + 1), "DISK_NUMBER": "1",
                },
                root,
            )
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"flacdata")
            t.last_modification = 1700000000
            t.play_count = 6 - i
            t.save()
            emb.save_embedding(t, vector(0, i))
            rows.append(t)
        release_database()

        path, cache = self.path, self.dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(
                    self.DEEZER, push_to_deezer=True, report_listens=True,
                    smart_tracklists="new-releases,inspired-by-3", flow_user_id="1",
                )

        app = create_application(Config())
        self.assertEqual(
            dbmod.Meta["schema_version"].value, dbmod.SCHEMA_VERSION
        )
        UserManager.add("alice", "Alic3", admin=True)
        client = app.test_client()
        client.post("/api/login", json={"username": "alice", "password": "Alic3"})

        # Nothing was ever computed: the radio still answers, from the artist.
        self.assertEqual(TrackNeighbor.select().count(), 0)
        body = client.get(f"/api/radio/track/{rows[0].id}").get_json()
        self.assertEqual(len(body["tracks"]), 5)
        self.assertEqual(client.get("/api/flow").status_code, 200)
        home = client.get("/api/home").get_json()
        self.assertEqual([a["title"] for a in home["recent"]], ["Old Album"])
        self.assertEqual(home["mixes"], [])  # nothing measured yet

        # The button fills the index from the vectors already on disk.
        job = similar.rebuild_job()
        with app.app_context():
            job.run()
        self.assertEqual(similar.status()["tracks"], 6)
        similar.drop_index()
        body = client.get(f"/api/radio/track/{rows[0].id}").get_json()
        self.assertEqual(len(body["tracks"]), 5)
        # Booting again changes nothing.
        release_database()
        init_database("sqlite:///" + self.path)
        self.assertEqual(TrackNeighbor.select().count(), 6 * 5)


if __name__ == "__main__":
    unittest.main()

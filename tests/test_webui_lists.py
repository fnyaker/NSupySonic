# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The big lists' fast path, and the validator every JSON answer carries.

A playlist or the favourites is read as TUPLES (``webui._db_track_rows``)
instead of three model objects per row — 4x faster on 4000 tracks, measured
with tools/perf_api.py. That is only worth anything if the answer is the SAME,
byte for byte, as the model path's (``_db_track``): every shape a row can
take is here — a Deezer track with credits, one with none, a local upload, an
unavailable one, one with no gain, one whose artist has no Deezer id — and the
two are compared field by field. The other two rewrites (my playlists in four
statements instead of two per playlist, the favourite ids without hydrating a
row) are held to the same answers and to their statement counts.
"""

import collections
import contextlib
import os
from datetime import datetime, timedelta
import shutil
import tempfile
import unittest

import peewee

from supysonic.config import DefaultConfig
from supysonic.db import (
    Album,
    Artist,
    Folder,
    Playlist,
    PlaylistTrack,
    StarredTrack,
    Track,
    User,
    release_database,
)
from supysonic.managers.user import UserManager
from supysonic.web import create_application


@contextlib.contextmanager
def count_statements():
    counts = collections.Counter()
    original = peewee.Database.execute_sql

    def execute_sql(self, sql, *args, **kwargs):
        counts[sql.split(None, 1)[0].upper()] += 1
        return original(self, sql, *args, **kwargs)

    peewee.Database.execute_sql = execute_sql
    try:
        yield counts
    finally:
        peewee.Database.execute_sql = original


def raw(sid, title, art, alb, artists=None, gain=None):
    t = {
        "SNG_ID": str(sid),
        "SNG_TITLE": title,
        "ART_ID": art[0],
        "ART_NAME": art[1],
        "ALB_ID": alb[0],
        "ALB_TITLE": alb[1],
        "ALB_PICTURE": alb[2],
        "DURATION": 200 + sid % 7,
        "TRACK_NUMBER": 1,
        "DISK_NUMBER": 1,
        "TRACK_TOKEN": f"tok{sid}",
    }
    if gain is not None:
        t["GAIN"] = gain
    if artists:
        t["ARTISTS"] = artists
    return t


class ListsTestCase(unittest.TestCase):
    def setUp(self):
        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path = self.__db[1]
        cache = self.__dir
        archive = self.archive

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
                self.DEEZER = dict(getattr(self, "DEEZER", {}), archive_dir=archive, enabled=False)

        self.app = create_application(Config())
        # Deezer switched off: every list below is the database's own answer.
        self.app.deezer = None
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bb", admin=False)
        self.client = self.app.test_client()
        self._fill()

    def tearDown(self):
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    def _fill(self):
        from supysonic.deezer import library

        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            A = ("11", "Édith")
            B = ("12", "Bob & Co")
            credits = [
                {"ART_ID": "11", "ART_NAME": "Édith", "ROLE_ID": "0"},
                {"ART_ID": "12", "ART_NAME": "Bob & Co", "ROLE_ID": "5"},
            ]
            t1 = library.upsert_track(raw(1, "Été", A, ("21", "Album Un", "aa11"), credits, gain="-7.5"), root)
            t2 = library.upsert_track(raw(2, "Nuit", B, ("22", "Album Deux", None)), root)
            t3 = library.upsert_track(raw(3, "Zéro", A, ("21", "Album Un", "aa11")), root)
            t3.unavailable = library._now()
            t3.save()
            # A local upload: no Deezer id anywhere, its own artist and album.
            folder = Folder.create(root=False, name="up", path=os.path.join(self.archive, "up"), parent=root)
            art = Artist.create(name="Moi")
            alb = Album.create(name="Maison", artist=art)
            t4 = Track.create(
                disc=1, number=1, title="Démo", duration=61, album=alb, artist=art, bitrate=320,
                path=os.path.join(self.archive, "up", "demo.mp3"), last_modification=0,
                root_folder=root, folder=folder,
            )
            # An artist the importer made without a Deezer id.
            nobody = Artist.create(name="Sans id")
            t5 = library.upsert_track(raw(5, "Orphelin", ("13", "X"), ("23", "Alb", "bb22")), root)
            t5.artist = nobody
            t5.save()
            self.tracks = [t1, t2, t3, t4, t5]
            alice = User.get(name="alice")
            bob = User.get(name="bob")
            # Timestamps are whole seconds (db.now): spell out an order, or
            # "newest first" is a tie the database breaks as it likes.
            at = lambda k: datetime(2026, 1, 1) + timedelta(minutes=k)  # noqa: E731
            for k, t in enumerate(self.tracks):
                StarredTrack.create(user=alice, starred=t.id, date=at(k))
                if k % 2 == 0:
                    StarredTrack.create(user=bob, starred=t.id, date=at(k))
            self.big = Playlist.create(user=alice, name="Big", created=at(1))
            for k, t in enumerate(self.tracks + self.tracks[::-1]):
                PlaylistTrack.create(playlist=self.big, track=t.id, index=k)
            self.local_first = Playlist.create(user=alice, name="Local first", created=at(2))
            PlaylistTrack.create(playlist=self.local_first, track=t4.id, index=0)
            PlaylistTrack.create(playlist=self.local_first, track=t1.id, index=1)
            self.empty = Playlist.create(user=alice, name="Empty", created=at(3))

    def _login(self, who="alice", pw="Alic3"):
        rv = self.client.post("/api/login", json={"username": who, "password": pw})
        self.assertEqual(rv.status_code, 200)

    def test_the_tuple_path_answers_what_the_model_path_did(self):
        from supysonic import webui

        with self.app.test_request_context():
            q = webui._db_playlist_track_rows(self.big)
            fast = webui._db_tracks(q)
            slow = webui._db_tracks(list(q))  # a list: the model path
        self.assertEqual(len(fast), 10)
        self.assertEqual(fast, slow)
        by_id = {t["deezer_id"]: t for t in fast}
        # The shapes this covers, so a fixture change cannot quietly drop one.
        self.assertEqual([a["name"] for a in by_id["1"]["artists"]], ["Édith", "Bob & Co"])
        self.assertEqual(by_id["1"]["display_artist"], "Édith feat. Bob & Co")
        self.assertEqual(by_id["1"]["gain"], -7.5)
        self.assertIsNone(by_id["2"]["album"]["cover"])
        self.assertTrue(by_id["3"]["unavailable"])
        local = by_id[str(self.tracks[3].id)]
        self.assertTrue(local["local"])
        self.assertEqual(local["album"]["cover"], "/api/localcover/" + str(self.tracks[3].id))
        self.assertEqual(local["artist"]["deezer_id"], str(self.tracks[3].artist.id))
        self.assertEqual(by_id["5"]["artists"][0]["deezer_id"], str(self.tracks[4].artist.id))

    def test_a_query_with_a_limit_reads_its_credits_by_id(self):
        # MySQL refuses LIMIT inside IN (...): a limited query takes the id list.
        from supysonic import webui

        with self.app.test_request_context():
            q = webui._db_playlist_track_rows(self.big).limit(3)
            self.assertEqual(webui._db_tracks(q), webui._db_tracks(list(q)))

    def test_favourites_are_the_same_list_in_three_statements(self):
        self._login()
        with count_statements() as counts:
            favs = self.client.get("/api/me/favorites").get_json()["tracks"]
        self.assertEqual(len(favs), 5)
        # Newest star first, as before.
        self.assertEqual(favs[0]["deezer_id"], "5")
        # The session, the list, its credits.
        self.assertLessEqual(counts["SELECT"], 3, counts)

    def test_favourite_ids_are_the_same_set(self):
        self._login()
        ids = set(self.client.get("/api/me/favorite-ids").get_json()["ids"])
        self.assertEqual(ids, {"1", "2", "3", "5", str(self.tracks[3].id)})
        self.client.post("/api/logout")
        self._login("bob", "B0bb")
        ids = self.client.get("/api/me/favorite-ids").get_json()["ids"]
        # A guest's list keeps its order: newest first.
        self.assertEqual(ids, ["5", "3", "1"])

    def test_my_playlists_counts_and_covers_in_four_statements(self):
        self._login()
        with count_statements() as counts:
            pls = self.client.get("/api/me/playlists").get_json()["playlists"]
        by_name = {p["title"]: p for p in pls}
        self.assertEqual(by_name["Big"]["nb_tracks"], 10)
        self.assertEqual(by_name["Big"]["cover"], "https://e-cdns-images.dzcdn.net/images/cover/aa11/500x500-000000-80-0-0.jpg")
        # A local first track: its own cover route.
        self.assertEqual(by_name["Local first"]["cover"], "/api/localcover/" + str(self.tracks[3].id))
        self.assertEqual(by_name["Empty"], {
            "id": str(self.empty.id), "deezer_id": None, "title": "Empty", "cover": None,
            "nb_tracks": 0, "editable": True,
        })
        # Newest first, as the model path listed them.
        self.assertEqual([p["title"] for p in pls], ["Empty", "Local first", "Big"])
        # The session, the playlists, their counts, their first tracks — not
        # two per playlist.
        self.assertLessEqual(counts["SELECT"], 4, counts)

    def test_an_unchanged_answer_is_revalidated_not_resent(self):
        self._login()
        rv = self.client.get("/api/me/favorites")
        self.assertEqual(rv.status_code, 200)
        tag = rv.headers["ETag"]
        self.assertTrue(tag.startswith('W/"'), tag)
        self.assertEqual(rv.headers["Cache-Control"], "private, no-cache")
        again = self.client.get("/api/me/favorites", headers={"If-None-Match": tag})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.get_data(), b"")
        # Something changed: a full answer, with another tag.
        with self.app.app_context():
            StarredTrack.delete().where(StarredTrack.starred == self.tracks[0].id).execute()
        changed = self.client.get("/api/me/favorites", headers={"If-None-Match": tag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["ETag"], tag)

    def test_the_validator_survives_compression(self):
        self._login()
        rv = self.client.get("/api/playlist/" + str(self.big.id), headers={"Accept-Encoding": "gzip"})
        self.assertEqual(rv.headers.get("Content-Encoding"), "gzip")
        tag = rv.headers["ETag"]
        rv = self.client.get(
            "/api/playlist/" + str(self.big.id), headers={"Accept-Encoding": "gzip", "If-None-Match": tag}
        )
        self.assertEqual(rv.status_code, 304)
        self.assertIsNone(rv.headers.get("Content-Encoding"))

    def test_only_json_gets_carry_a_validator(self):
        self._login()
        rv = self.client.post("/api/listen", json={"id": "1", "seconds": 5})
        self.assertIsNone(rv.headers.get("ETag"))
        rv = self.client.get("/api/me/playlists", headers={"If-None-Match": '"nope"'})
        self.assertEqual(rv.status_code, 200)

    def test_an_artists_album_grid_is_counted_once_not_per_album(self):
        from supysonic.deezer import library

        with self.app.app_context():
            root = library.get_root_folder(self.archive)
            A = ("11", "Édith")
            for k in range(6):
                for n in range(k + 1):
                    t = library.upsert_track(raw(100 + 10 * k + n, f"T{k}{n}", A, (f"3{k}", f"Disque {k}", None)), root)
                    t.year = 1990 + k + n
                    t.save()
        self._login()
        with count_statements() as counts:
            art = self.client.get("/api/artist/11").get_json()
        cards = {c["title"]: c for c in art["albums"]}
        self.assertEqual(cards["Disque 3"]["nb_tracks"], 4)
        self.assertEqual(cards["Disque 3"]["year"], 1993)
        # The fixture's own album, whose tracks carry no year.
        self.assertEqual(cards["Album Un"]["nb_tracks"], 2)
        self.assertIsNone(cards["Album Un"]["year"])
        # Seven albums, and the grid costs the same as it would for one: the
        # count per album is gone (it was 2 statements each).
        self.assertLessEqual(counts["SELECT"], 8, counts)
        with count_statements() as counts:
            disco = self.client.get("/api/artist/11/discography").get_json()["discography"]
        self.assertEqual(len(disco["album"]), 7)
        self.assertEqual(disco["album"][0]["year"], 1995)  # newest first (an album is its first year)
        self.assertLessEqual(counts["SELECT"], 5, counts)

    def test_podcasts_are_counted_once_not_per_show(self):
        from supysonic.db import PodcastChannel, PodcastEpisode

        with self.app.app_context():
            alice = User.get(name="alice")
            for k in range(5):
                c = PodcastChannel.create(user=alice, url=f"https://example.org/{k}", title=f"Show {k}")
                for n in range(k):
                    PodcastEpisode.create(channel=c, title=f"E{n}", path=f"/x/{k}/{n}.mp3" if n % 2 else None)
        self._login()
        with count_statements() as counts:
            shows = self.client.get("/api/podcasts").get_json()["podcasts"]
        by = {c["title"]: c for c in shows}
        self.assertEqual(by["Show 4"]["episode_count"], 4)
        self.assertEqual(by["Show 4"]["archived_count"], 2)
        self.assertEqual(by["Show 0"]["episode_count"], 0)
        self.assertEqual(by["Show 0"]["archived_count"], 0)
        self.assertLessEqual(counts["SELECT"], 3, counts)


if __name__ == "__main__":
    unittest.main()

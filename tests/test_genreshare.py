# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A genre model handed from one server to another (supysonic/webui/genreshare.py).

What matters: what goes out comes back the same (labels on the same tracks, a
head that classifies as before), a file never overwrites a tag this server
chose, a head this server cannot read is refused BEFORE it replaces the working
one, and a hostile file is a 400, never a crash or a write.
"""

import base64
import struct
import unittest

from supysonic.db import GenreModel, GenreTag, Track, TrackTag

from . import test_webui as _studio

# The studio's fixtures, borrowed through the module: a TestCase class bound to
# a name here would be collected and its whole suite run a second time.
def _borrow(name):
    def call(self, *a, **kw):
        return getattr(_studio.GenreStudioTestCase, name)(self, *a, **kw)
    return call

V2 = 2560


def _encode(values):
    return base64.b64encode(struct.pack(f"<{len(values)}e", *[float(v) for v in values])).decode("ascii")


class GenreShareTestCase(unittest.TestCase):
    setUp = _borrow("setUp")
    tearDown = _borrow("tearDown")
    _login = _borrow("_login")
    _track = _borrow("_track")
    _tag = _borrow("_tag")
    _store_embedding = _borrow("_store_embedding")

    def _label(self, track, tag):
        r = self.client.post("/api/genre/label", json={"track": str(track.deezer_id), "tag": tag["id"]})
        self.assertEqual(r.status_code, 200, r.data)

    def _put_head(self, labels, dim=V2):
        rows = []
        for i in range(len(labels)):
            row = [0.0] * dim
            row[i] = 4.0
            rows += row
        r = self.client.put("/api/genre/model", json={
            "labels": labels, "weights": _encode(rows + [0.0] * len(labels)),
            "dim": dim, "kind": "linear", "metrics": {"balanced": 0.9, "examples": 12},
        })
        self.assertEqual(r.status_code, 200, r.data)

    def _export(self):
        r = self.client.get("/api/genre/share/export")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertIn("attachment", r.headers["Content-Disposition"])
        return r.json

    def _tags(self):
        return {str(tt.track.deezer_id): tt.tag.name for tt in TrackTag.select().join(Track)}

    def test_admin_only(self):
        self._login("bob", "B0bbb")
        self.assertEqual(self.client.get("/api/genre/share/export").status_code, 403)
        self.assertEqual(self.client.post("/api/genre/share/preview", json={}).status_code, 403)
        self.assertEqual(self.client.post("/api/genre/share/import", json={}).status_code, 403)

    def test_round_trip_restores_labels_and_head(self):
        self._login()
        zaag, krach = self._tag("Zaag", "hard"), self._tag("Deutscher Krach")
        a, b = self._track("1001"), self._track("1002")
        self._label(a, zaag)
        self._label(b, krach)
        self._put_head(["Zaag", "Deutscher Krach"])
        weights = GenreModel.get(GenreModel.active == True).weights  # noqa: E712

        f = self._export()
        self.assertEqual({t["deezer_id"]: t["genre"] for t in f["tags"]}, {"1001": "Zaag", "1002": "Deutscher Krach"})
        self.assertEqual(f["head"]["labels"], ["Zaag", "Deutscher Krach"])
        self.assertEqual({g["name"]: g["archetype"] for g in f["genres"]}["Zaag"], "hard")

        # Another server: same library, no tags, no genres, no model.
        TrackTag.delete().execute()
        GenreTag.delete().execute()
        GenreModel.delete().execute()

        p = self.client.post("/api/genre/share/preview", json=f)
        self.assertEqual(p.status_code, 200, p.data)
        self.assertEqual(p.json["tags"], {"total": 2, "local": 2, "deezer": 0, "unknown": 0, "kept": 0, "already": 0})
        self.assertTrue(p.json["head"]["compatible"], p.json["head"])
        self.assertEqual(sorted(p.json["new_genres"]), ["Deutscher Krach", "Zaag"])

        r = self.client.post("/api/genre/share/import", json={"file": f, "head": True, "tags": True})
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.json["job"]["tagged"], 2)
        self.assertEqual(self._tags(), {"1001": "Zaag", "1002": "Deutscher Krach"})
        head = GenreModel.get(GenreModel.active == True)  # noqa: E712
        self.assertEqual(head.weights, weights)
        self.assertEqual(GenreTag.get(GenreTag.name == "Zaag").archetype, "hard")

    def test_a_tag_chosen_here_is_never_overwritten(self):
        self._login()
        zaag, uptempo = self._tag("Zaag"), self._tag("Uptempo")
        a, b = self._track("2001"), self._track("2002")
        self._label(a, zaag)
        self._label(b, zaag)
        f = self._export()
        # This server changed its mind about 2001 since.
        self._label(a, uptempo)
        p = self.client.post("/api/genre/share/preview", json=f).json["tags"]
        self.assertEqual((p["kept"], p["already"]), (1, 1))
        r = self.client.post("/api/genre/share/import", json={"file": f, "tags": True})
        self.assertEqual(r.status_code, 200, r.data)
        job = r.json["job"]
        self.assertEqual((job["kept"], job["already"], job["tagged"]), (1, 1, 0))
        self.assertEqual(self._tags(), {"2001": "Uptempo", "2002": "Zaag"})

    def test_a_track_not_here_and_deezer_off_is_not_a_verdict(self):
        self._login()
        f = {"format": "nsupysonic-genre", "version": 1, "tags": [
            {"genre": "Zaag", "deezer_id": "999001", "title": "x", "artist": "y"},
            {"genre": "Zaag", "title": "Upload only there", "artist": "Somebody"},
        ]}
        p = self.client.post("/api/genre/share/preview", json=f).json
        self.assertEqual((p["tags"]["deezer"], p["tags"]["unknown"]), (1, 1))
        job = self.client.post("/api/genre/share/import", json={"file": f, "tags": True}).json["job"]
        self.assertEqual((job["failed"], job["not_found"], job["tagged"]), (1, 1, 0))
        # The genre itself arrives: tagging can start on it here.
        self.assertTrue(GenreTag.select().where(GenreTag.name == "Zaag").exists())

    def test_a_head_s_metrics_are_bounded(self):
        self._login()
        r = self.client.put("/api/genre/model", json={
            "labels": ["A", "B"], "weights": _encode([0.0] * (2 * V2 + 2)), "dim": V2, "kind": "linear",
            "metrics": {"junk": "x" * (3 * 1024 * 1024)},
        })
        self.assertEqual(r.status_code, 413, r.data)
        self.assertFalse(GenreModel.select().exists())

    def test_a_genre_is_matched_without_case(self):
        """"zaag" in a file is this server's "Zaag": a second tag split one class
        in two (and MySQL's case-blind index refused it, a 500)."""
        self._login()
        self._tag("Zaag")
        a = self._track("3001")
        f = {"format": "nsupysonic-genre", "version": 1, "tags": [{"genre": "zaag", "deezer_id": "3001"}]}
        p = self.client.post("/api/genre/share/preview", json=f).json
        self.assertEqual(p["new_genres"], [])
        job = self.client.post("/api/genre/share/import", json={"file": f, "tags": True}).json["job"]
        self.assertEqual(job["tagged"], 1)
        self.assertEqual([g.name for g in GenreTag.select()], ["Zaag"])
        self.assertEqual(TrackTag.get(TrackTag.track == a).tag.name, "Zaag")

    def test_the_preview_costs_the_same_whatever_the_file(self):
        """Uploads and YouTube lines were one statement each (a LOWER() scan
        for an upload); the preview reads them in batches."""
        from .test_deezer import count_statements

        self._login()
        up = self._track("3101")
        up.deezer_id = None
        up.title = "Mon Upload"
        up.save()
        artist = up.artist.name

        def file(n):
            tags = [{"genre": "Zaag", "title": f"upload {i}", "artist": "x"} for i in range(n)]
            tags += [{"genre": "Zaag", "youtube_id": "AAAAAAAAA%02d" % i} for i in range(n)]
            tags.append({"genre": "Zaag", "title": "mon upload", "artist": artist.upper()})
            return {"format": "nsupysonic-genre", "version": 1, "tags": tags}

        counts = []
        for n in (5, 50):
            with count_statements() as c:
                p = self.client.post("/api/genre/share/preview", json=file(n))
            self.assertEqual(p.status_code, 200, p.data)
            self.assertEqual(p.json["tags"]["local"], 1)  # the upload, found by its title and artist
            counts.append(sum(c.values()))
        self.assertEqual(counts[0], counts[1], counts)

    def test_an_unreadable_head_never_replaces_the_working_one(self):
        self._login()
        self._put_head(["A", "B"])
        working = GenreModel.get(GenreModel.active == True).id  # noqa: E712
        f = self._export()

        narrow = dict(f, head=dict(f["head"], dim=4))
        p = self.client.post("/api/genre/share/preview", json=narrow).json
        self.assertFalse(p["head"]["compatible"])
        self.assertEqual(self.client.post("/api/genre/share/import", json={"file": narrow, "head": True}).status_code, 400)

        other = dict(f, embedding=dict(f["embedding"], extractor="vggish"))
        self.assertEqual(self.client.post("/api/genre/share/import", json={"file": other, "head": True}).status_code, 400)

        # Right width, weights that do not add up: store_head's own refusal.
        torn = dict(f, head=dict(f["head"], weights=_encode([1.0] * 10)))
        self.assertEqual(self.client.post("/api/genre/share/import", json={"file": torn, "head": True}).status_code, 400)

        self.assertEqual(GenreModel.get(GenreModel.active == True).id, working)  # noqa: E712

    def test_hostile_files_are_refused(self):
        self._login()
        for bad in (None, [], {"format": "other"}, {"format": "nsupysonic-genre", "version": 99},
                    {"format": "nsupysonic-genre", "version": 1, "tags": "x"},
                    {"format": "nsupysonic-genre", "version": 1, "head": {"labels": "x"}}):
            self.assertEqual(self.client.post("/api/genre/share/preview", json=bad).status_code, 400, bad)
            self.assertEqual(
                self.client.post("/api/genre/share/import", json={"file": bad, "tags": True}).status_code, 400, bad
            )
        # Junk inside a valid file is skipped, never written: an id that is no
        # Deezer id, a colour that is markup, an archetype nobody knows.
        f = {"format": "nsupysonic-genre", "version": 1,
             "genres": [{"name": "Zaag", "color": "<script>", "archetype": "banana"}],
             "tags": [{"genre": "Zaag", "deezer_id": "../../etc"}, {"genre": ""}, "x"]}
        r = self.client.post("/api/genre/share/import", json={"file": f, "tags": True})
        self.assertEqual(r.status_code, 200, r.data)
        z = GenreTag.get(GenreTag.name == "Zaag")
        self.assertEqual((z.color, z.archetype), (None, None))
        self.assertEqual(TrackTag.select().count(), 0)

    def test_the_self_training_pool_is_untagged_tracks_with_a_vector(self):
        """/genre/pool (supysonic/webui/genre.py): what the studio's
        self-training learns from. A tagged track is an example already, and a
        track without a vector has nothing to learn from."""
        self._login()
        zaag = self._tag("Zaag")
        tagged, free, bare = self._track("3001"), self._track("3002"), self._track("3003")
        stored = self._track("3004", archived=False)
        for t in (tagged, free, stored):
            self._store_embedding(t, [0.1] * V2)
        self._label(tagged, zaag)
        r = self.client.get("/api/genre/pool")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.json["ids"], ["3002"])
        self.assertNotIn(str(bare.deezer_id), r.json["ids"])
        self.assertEqual(self.client.get("/api/genre/pool?limit=x").status_code, 200)
        self._login("bob", "B0bbb")
        self.assertEqual(self.client.get("/api/genre/pool").status_code, 403)


if __name__ == "__main__":
    unittest.main()

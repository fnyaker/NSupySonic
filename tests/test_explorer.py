# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The background explorer (deezer/explorer.py) and its place in the Flow.

Nothing here touches the network: Deezer's API, the preview download and the
analysis are replaced by recorders, so what is asserted is the rule — which genres
are searched, what is accepted, what is never archived, when it stands down."""

import json
import random
import unittest

from supysonic import discover
from supysonic.db import Discovery, Track, TrackAnalysis, now
from supysonic.deezer import analysis as ana
from supysonic.deezer import explorer as X

from .test_discover import _Library


class _Gate:
    """A Throttle stand-in: lets ``n`` units through, then says stop."""

    def __init__(self, n=999):
        self.n, self.reason = n, None

    def wait(self):
        self.n -= 1
        return self.n >= 0

    def spent(self, _s):
        pass


def _track(i):
    return {"id": 800000 + i, "title": f"T{i}", "duration": 200,
            "preview": f"https://cdnt-preview.dzcdn.net/api/1/1/{i}.mp3",
            "artist": {"id": 50 + i, "name": f"Art {i}"},
            "album": {"id": 5, "title": "Al", "cover_medium": "u"}}


class _Api:
    def __init__(self, tracks):
        self.tracks = tracks
        self.calls = []

    def search_playlist(self, q, limit=12):
        self.calls.append(("playlists", q))
        return {"data": [{"id": 1, "nb_tracks": 40}]}

    def get_playlist_tracks(self, pid, index=0, limit=-1):
        self.calls.append(("tracks", pid))
        return {"data": self.tracks}

    def search(self, q, limit=25, index=0, **kw):
        self.calls.append(("search", q))
        return {"data": self.tracks}


class _Dz:
    def __init__(self, api):
        self.api = api


class _Provider:
    def __init__(self, tracks):
        self.dz = _Dz(_Api(tracks))

    def available(self):
        return True


class ChoosingTestCase(unittest.TestCase):
    def test_only_genres_the_engine_knows_are_ever_searched(self):
        vocab = [l for l, _a in ana.known_genres()]
        w = X.target_weights({"Frenchcore": 50.0}, {"Frenchcore": 40}, vocab + ["Not a genre"])
        self.assertNotIn("Not a genre", w)
        picks = set()
        rng = random.Random(1)
        for _ in range(60):
            picks.update(X.pick_targets(3, rng, w))
        known = {X.genretree.get().node(v) for v in vocab}
        self.assertTrue(picks <= known)

    def test_it_looks_near_what_is_played_and_where_the_library_is_thin(self):
        vocab = ["Frenchcore", "Uptempo", "Hardstyle", "Jazz / acoustique", "Trance"]
        w = X.target_weights({"Frenchcore": 100.0}, {"Frenchcore": 100}, vocab)
        self.assertGreater(w["Uptempo"], w["Hardstyle"])
        self.assertGreater(w["Hardstyle"], w["Jazz / acoustique"])
        self.assertLess(w["Frenchcore"], w["Uptempo"])  # the well stocked genre is the least worth a look
        flat = X.target_weights({}, {}, vocab)
        self.assertTrue(all(v > 0 for v in flat.values()))

    def test_verification_wants_the_genre_heard_and_confidently(self):
        res = lambda style, conf: {"verdict": {"style": style, "conf": conf}}
        self.assertTrue(X.verify("Frenchcore", res("frenchcore", 0.8))[0])
        self.assertTrue(X.verify("Gabber", res("hardcore", 0.8))[0])         # a direct parent
        self.assertFalse(X.verify("Frenchcore", res("hardstyle", 0.9))[0])    # a cousin
        self.assertFalse(X.verify("Techno", res("house", 0.9))[0])            # a sibling
        self.assertFalse(X.verify("Frenchcore", res("frenchcore", 0.2))[0])   # unsure
        self.assertFalse(X.verify("Frenchcore", res("nonsense", 0.9))[0])


class ExploreTestCase(_Library):
    def _run(self, tracks, verdicts, gate=None, archive=None, rng_seed=1, targets=1):
        provider = _Provider(tracks)
        it = iter(verdicts)
        analyze = lambda path: {"verdict": next(it), "bpm": 180.0}
        stats = X.explore_once(
            provider, gate or _Gate(), rng=random.Random(rng_seed), targets=targets,
            per_target=len(tracks), archive=archive, analyze=analyze,
            fetch=lambda url, dest: True, pause=lambda s: None,
        )
        return provider, stats

    def _force_target(self, label):
        import unittest.mock as m

        return m.patch.object(X, "pick_targets", lambda n, rng, weights=None: [label])

    def test_keepers_are_recorded_and_the_rest_never_asked_again(self):
        tracks = [_track(1), _track(2), _track(3)]
        good = {"style": "frenchcore", "conf": 0.8}
        bad = {"style": "jazz", "conf": 0.9}
        with self._force_target("Frenchcore"):
            _api, st = self._run(tracks, [good, bad, good])
            self.assertEqual((st["found"], st["rejected"]), (2, 1))
            rows = {r.deezer_id: r for r in Discovery.select()}
            self.assertEqual(len(rows), 3)
            self.assertEqual(sum(r.state == "new" for r in rows.values()), 2)
            info = json.loads(next(r for r in rows.values() if r.state == "new").payload)
            self.assertTrue(info["title"].startswith("T"))
            self.assertTrue(info["artist"].startswith("Art"))
            _api2, st2 = self._run(tracks, [good] * 3)
            self.assertEqual(st2["found"] + st2["rejected"], 0)  # a second pass fetches nothing new

    def test_nothing_is_archived_unless_the_operator_said_so(self):
        archived = []
        ok = {"style": "frenchcore", "conf": 0.9}
        with self._force_target("Frenchcore"):
            self._run([_track(11), _track(12)], [ok, ok], archive=None)
        self.assertEqual(archived, [])
        with self._force_target("Frenchcore"):
            self._run([_track(21), _track(22)], [ok, {"style": "jazz", "conf": 0.9}], archive=archived.append)
        self.assertEqual(len(archived), 1)  # only the verified one
        self.assertIn(archived[0], ("800021", "800022"))

    def test_it_stands_down_the_moment_the_gate_says_so(self):
        ok = {"style": "frenchcore", "conf": 0.9}
        with self._force_target("Frenchcore"):
            self._run([_track(31), _track(32), _track(33)], [ok, ok, ok], gate=_Gate(3))
        self.assertEqual(Discovery.select().count(), 2)  # the target, then one gate per preview

    def test_a_library_track_is_not_looked_for_again(self):
        t = Track.select().first()
        Track.update(deezer_id="777001").where(Track.id == t.id).execute()
        api = _Api([dict(_track(1), id=777001), _track(2)])
        got = X.find_tracks(api, "Frenchcore", random.Random(1), 5, pause=lambda s: None)
        self.assertEqual([str(g["id"]) for g in got], ["800002"])

    def test_the_flow_offers_finds_like_the_librarys_unplayed_titles(self):
        for i, dz in enumerate(("900001", "900002")):
            Discovery.create(deezer_id=dz, state="new", target="Frenchcore", style="Frenchcore",
                             confidence=0.8, bpm=190.0, found=now(),
                             payload=json.dumps(X.info_of(_track(i + 1))))
        Discovery.create(deezer_id="900003", state="rejected", target="Frenchcore", style="Frenchcore",
                         found=now(), payload=json.dumps(X.info_of(_track(3))))
        discover.invalidate()
        taste = discover.profile(self.user, fresh=True)
        pool = discover.track_candidates(self.user, taste, random.Random(1))
        found = {k: c for k, c in pool.items() if isinstance(k, str) and k.startswith("deezer:9000")}
        self.assertEqual(sorted(found), ["deezer:900001", "deezer:900002"])  # the rejected one never
        c = found["deezer:900001"]
        self.assertEqual((c.provider, c.ref), ("deezer", "900001"))
        self.assertTrue(c.why.startswith("Une découverte"))
        self.assertEqual(c.info["title"], "T1")
        # a guest (content-only) is never offered one
        from supysonic.db import User

        guest = User.create(name="guest", password="x", salt="x", admin=False)
        gp = discover.track_candidates(guest, discover.profile(guest, fresh=True), random.Random(1))
        self.assertFalse([k for k in gp if isinstance(k, str) and k.startswith("deezer:9000")])
        # taken into the library (played, liked): no longer a find
        t = Track.select().first()
        Track.update(deezer_id="900001").where(Track.id == t.id).execute()
        discover.invalidate()
        pool = discover.track_candidates(self.user, discover.profile(self.user, fresh=True), random.Random(1))
        self.assertNotIn("deezer:900001", pool)
        X.prune()
        self.assertIsNone(Discovery.get_or_none(Discovery.deezer_id == "900001"))

    def test_the_cached_pool_never_crosses_databases(self):
        import time

        # a copy kept for ANOTHER database (as the previous test's) must not be served
        X._pool_cache = (time.monotonic(), -1, [("999", "Frenchcore", {"title": "stale"})])
        self.assertEqual(X.pool_rows(), [])

    def test_the_explorer_switches_are_the_admins_and_are_cleaned(self):
        r = self.client.put("/api/explorer", json={"enabled": False, "archive": True, "pool": 99999})
        self.assertEqual(r.status_code, 200)
        body = r.json
        self.assertFalse(body["enabled"])
        self.assertTrue(body["archive"])
        self.assertEqual(body["pool"], X.POOL_MAX)
        self.assertTrue(self.client.get("/api/explorer").json["archive"])


if __name__ == "__main__":
    unittest.main()

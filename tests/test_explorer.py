# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The background explorer (deezer/explorer.py) and its place in the radio.

Nothing here touches the network: Deezer's API, the preview download and the
analysis are replaced by recorders, so what is asserted is the rule — which genres
are searched, what is accepted, what is never archived, when it stands down."""

import json
import random
import unittest

from supysonic.deezer import analysis as ana
from supysonic.deezer import explorer as X
from supysonic.deezer import radio as R

from .test_radio import RadioEndpointTestCase


class _Gate:
    """A Throttle stand-in: lets ``n`` units through, then says stop."""

    def __init__(self, n=999):
        self.n, self.reason = n, None

    def wait(self):
        self.n -= 1
        return self.n >= 0

    def spent(self, _s):
        pass


def _track(i, genre_tag="x"):
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


def _payload(t):
    return {"deezer_id": str(t["id"]), "title": t["title"], "duration": 200,
            "artist": {"deezer_id": str(t["artist"]["id"]), "name": t["artist"]["name"]},
            "artists": [], "display_artist": t["artist"]["name"],
            "album": {"deezer_id": "5", "title": "Al", "cover": "u"}}


class ChoosingTestCase(unittest.TestCase):
    def test_only_genres_the_engine_knows_are_ever_searched(self):
        vocab = [l for l, _a in ana.known_genres()]
        w = X.target_weights({"Frenchcore": 50.0}, {"Frenchcore": 40}, vocab + ["Not a genre"])
        self.assertNotIn("Not a genre", w)
        picks = set()
        rng = random.Random(1)
        for _ in range(60):
            picks.update(X.pick_targets(3, rng, w))
        self.assertTrue(picks <= set(vocab))

    def test_it_looks_near_what_is_played_and_where_the_library_is_thin(self):
        vocab = ["Frenchcore", "Uptempo", "Hardstyle", "Jazz / acoustique", "Trance"]
        w = X.target_weights({"Frenchcore": 100.0}, {"Frenchcore": 100}, vocab)
        self.assertGreater(w["Uptempo"], w["Hardstyle"])
        self.assertGreater(w["Hardstyle"], w["Jazz / acoustique"])
        # the well stocked genre is the least worth looking for
        self.assertLess(w["Frenchcore"], w["Uptempo"])
        # an empty library follows no taste: nothing is excluded
        flat = X.target_weights({}, {}, vocab)
        self.assertTrue(all(v > 0 for v in flat.values()))

    def test_verification_wants_the_genre_heard_and_confidently(self):
        res = lambda style, conf: {"verdict": {"style": style, "conf": conf}}
        self.assertTrue(X.verify("Frenchcore", res("frenchcore", 0.8))[0])
        self.assertTrue(X.verify("Gabber", res("hardcore", 0.8))[0])      # parent
        self.assertFalse(X.verify("Frenchcore", res("hardstyle", 0.9))[0])  # a cousin
        self.assertFalse(X.verify("Frenchcore", res("frenchcore", 0.2))[0])  # unsure
        self.assertFalse(X.verify("Frenchcore", res("nonsense", 0.9))[0])


class PreviewTestCase(unittest.TestCase):
    def test_only_https_on_deezers_own_hosts(self):
        ok = X._preview_ok
        self.assertTrue(ok("https://cdnt-preview.dzcdn.net/api/1/1/a.mp3"))
        for bad in ("http://cdnt-preview.dzcdn.net/a.mp3", "https://evil.example/a.mp3",
                    "https://dzcdn.net.evil.example/a.mp3", "file:///etc/passwd",
                    "https://127.0.0.1/a.mp3", "", None):
            self.assertFalse(ok(bad), bad)

    def test_a_redirect_or_an_oversize_body_is_refused(self):
        import os
        import tempfile

        class Resp:
            def __init__(self, status, chunks):
                self.status_code, self._c = status, chunks
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def iter_content(self, n): return iter(self._c)

        class Sess:
            def __init__(self, r): self.r, self.kw = r, None
            def get(self, url, **kw):
                self.kw = kw
                return self.r

        d = tempfile.mkdtemp()
        dest = os.path.join(d, "p.mp3")
        url = "https://cdnt-preview.dzcdn.net/a.mp3"
        s = Sess(Resp(200, [b"x" * 20000]))
        self.assertTrue(X.fetch_preview(url, dest, s))
        self.assertFalse(s.kw["allow_redirects"])
        self.assertFalse(X.fetch_preview(url, dest, Sess(Resp(302, []))))
        big = Resp(200, [b"x" * 1_000_000] * 4)
        self.assertFalse(X.fetch_preview(url, dest, Sess(big)))
        self.assertFalse(X.fetch_preview("http://x.dzcdn.net/a", dest, Sess(Resp(200, [b"x"]))))


class ExploreTestCase(RadioEndpointTestCase):
    def _run(self, tracks, verdicts, gate=None, archive=None, rng_seed=1, targets=1):
        api = _Api(tracks)
        i = iter(verdicts)
        analyze = lambda path: {"verdict": next(i), "bpm": 180.0}
        stats = X.explore_once(
            api, gate or _Gate(), rng=random.Random(rng_seed), targets=targets, per_target=len(tracks),
            to_payload=_payload, archive=archive, analyze=analyze,
            fetch=lambda url, dest: True, pause=lambda s: None,
        )
        return api, stats

    def _force_target(self, label):
        import unittest.mock as m
        return m.patch.object(X, "pick_targets", lambda n, rng, weights=None: [label])

    def test_keepers_are_recorded_and_the_rest_never_asked_again(self):
        from supysonic.db import Discovery

        tracks = [_track(1), _track(2), _track(3)]
        good = {"style": "frenchcore", "conf": 0.8}
        bad = {"style": "jazz", "conf": 0.9}
        with self._force_target("Frenchcore"):
            api, st = self._run(tracks, [good, bad, good])
            self.assertEqual((st["found"], st["rejected"]), (2, 1))
            rows = {r.deezer_id: r for r in Discovery.select()}
            self.assertEqual(len(rows), 3)
            self.assertEqual(sum(r.state == "new" for r in rows.values()), 2)
            self.assertEqual(json.loads(next(r for r in rows.values() if r.state == "new").payload)["title"][:1], "T")
            # a second pass over the same tracks fetches nothing new
            api2, st2 = self._run(tracks, [good] * 3)
            self.assertEqual(st2["found"] + st2["rejected"], 0)

    def test_nothing_is_archived_unless_the_operator_said_so(self):
        archived = []
        tracks = [_track(11), _track(12)]
        ok = {"style": "frenchcore", "conf": 0.9}
        with self._force_target("Frenchcore"):
            self._run(tracks, [ok, ok], archive=None)
        self.assertEqual(archived, [])
        tracks = [_track(21), _track(22)]
        with self._force_target("Frenchcore"):
            self._run(tracks, [ok, {"style": "jazz", "conf": 0.9}], archive=archived.append)
        self.assertEqual(len(archived), 1)  # only the verified one, not both
        self.assertIn(archived[0], ("800021", "800022"))

    def test_it_stands_down_the_moment_the_gate_says_so(self):
        from supysonic.db import Discovery

        ok = {"style": "frenchcore", "conf": 0.9}
        with self._force_target("Frenchcore"):
            self._run([_track(31), _track(32), _track(33)], [ok, ok, ok], gate=_Gate(3))
        # gate: 1 for the target, then one per preview → 2 previews, third refused
        self.assertEqual(Discovery.select().count(), 2)

    def test_a_library_track_is_not_looked_for_again(self):
        from supysonic.db import Track

        t = Track.select().first()
        dz = str(t.deezer_id)
        api = _Api([dict(_track(1), id=int(dz)), _track(2)])
        got = X.find_tracks(api, "Frenchcore", random.Random(1), 5, pause=lambda s: None)
        self.assertEqual([str(g["id"]) for g in got], ["800002"])

    def test_the_pool_serves_the_radio_and_skips_what_joined_the_library(self):
        from supysonic.db import Discovery, Track, now

        for i, dz in enumerate(("900001", "900002")):
            Discovery.create(deezer_id=dz, state="new", target="Frenchcore", style="Frenchcore",
                             confidence=0.8, bpm=190.0, found=now(),
                             payload=json.dumps(_payload(_track(i + 1) | {"id": int(dz)})))
        Discovery.create(deezer_id="900003", state="rejected", target="Frenchcore", style="Frenchcore",
                         found=now(), payload=json.dumps(_payload(_track(3))))
        from supysonic.deezer import genregraph as G

        w = G.expand(["Frenchcore"], 0.5)
        got = X.pool_candidates(w)
        self.assertEqual(sorted(p["deezer_id"] for p, *_ in got), ["900001", "900002"])
        # once one is in the library (played, liked) it is no longer a "find"
        t = Track.select().first()
        Track.update(deezer_id="900001").where(Track.id == t.id).execute()
        got = X.pool_candidates(w)
        self.assertEqual([p["deezer_id"] for p, *_ in got], ["900002"])
        X.prune()
        self.assertIsNone(Discovery.get_or_none(Discovery.deezer_id == "900001"))

    def test_the_radio_mixes_finds_in_only_when_the_dial_is_up(self):
        from supysonic.db import Discovery, now

        for i in range(8):
            Discovery.create(deezer_id=str(910000 + i), state="new", target="Frenchcore",
                             style="Frenchcore", confidence=0.8, bpm=190.0, found=now(),
                             payload=json.dumps(_payload(_track(i) | {"id": 910000 + i})))
        self._login()
        r0 = self.client.get("/api/radio/genre?seeds=Frenchcore&discovery=0&count=20&seed=1").get_json()
        self.assertEqual(r0["discovered"], 0)
        self.assertFalse(any(t.get("discovery") for t in r0["tracks"]))
        r1 = self.client.get("/api/radio/genre?seeds=Frenchcore&discovery=1&count=20&seed=1").get_json()
        self.assertGreater(r1["discovered"], 0)
        flagged = [i for i, t in enumerate(r1["tracks"]) if t.get("discovery")]
        self.assertEqual(len(flagged), r1["discovered"])
        self.assertNotIn(0, flagged)

    def test_the_explorer_switches_are_the_admins_and_are_cleaned(self):
        self._login("bob", "B0b-secret-77")
        self.assertIn(self.client.get("/api/radio/explorer").status_code, (401, 403))
        self.client.get("/api/logout")
        self._login()
        r = self.client.put("/api/radio/explorer", json={"enabled": False, "archive": True, "pool": 99999})
        body = r.get_json()
        self.assertFalse(body["enabled"])
        self.assertTrue(body["archive"])
        self.assertEqual(body["pool"], X.POOL_MAX)
        self.assertEqual(self.client.get("/api/radio/explorer").get_json()["archive"], True)


if __name__ == "__main__":
    unittest.main()

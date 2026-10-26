# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The Flow one title at a time (discover.flow_next, POST /api/flow/next) and
the energy of each title (energy.py): the session's listens, skips and
buttons steer the next choice, little by little; the energy notch holds it.

The library is _Graph's: cluster X (Techno) and cluster Y (Jazz). X is given
the measures of a calm record and Y those of an intense one."""

import json
import random
import unittest

from supysonic import discover, energy, listening
from supysonic.db import TrackAnalysis, UserTaste

from .test_discover import count_statements
from .test_radio_mix import _Graph


def measures(loud):
    """Analysis data of a calm (0) to intense (1) record."""
    return json.dumps({
        "lufs": -20 + 14 * loud, "lra": 14 - 10 * loud, "centroid": 1200 + 2500 * loud,
        "fluxPeak": 0.2 + 0.7 * loud, "entropy": 0.5 + 0.3 * loud,
    })


class EnergyTestCase(unittest.TestCase):
    def test_louder_denser_faster_is_more_energetic_and_the_ranks_spread(self):
        rows = [(i, 80 + 10 * i, 0.9, measures(i / 9)) for i in range(10)]
        e = energy.compute(rows)
        self.assertEqual(sorted(e, key=e.get), list(range(10)))
        self.assertAlmostEqual(e[0], 0.0)
        self.assertAlmostEqual(e[9], 1.0)

    def test_missing_or_broken_measures_are_left_out(self):
        rows = [
            (1, None, 0, measures(0.2)),
            (2, 150, 0.1, measures(0.8)),  # a tempo not trusted: not used
            (3, None, 0, "not json"),       # nothing: no energy at all
            (4, None, 0, json.dumps({"lufs": -10})),  # one measure is not enough
        ]
        e = energy.compute(rows)
        self.assertLess(e[1], e[2])
        self.assertNotIn(3, e)
        self.assertNotIn(4, e)

    def test_the_fit_and_the_names(self):
        self.assertEqual(energy.fit(0.2, None), 1.0)
        self.assertEqual(energy.fit(None, 0.7), energy.UNKNOWN)
        self.assertGreater(energy.fit(0.7, 0.7), energy.fit(0.9, 0.7))
        self.assertEqual(energy.step_name(None), "Libre")
        self.assertEqual(energy.step_name(0.68), "Énergique")


class _Session(_Graph):
    def setUp(self):
        super().setUp()
        for group, loud in (("X", 0.15), ("Y", 0.85), ("B", 0.5)):
            for i, t in enumerate(self.rows[group]):
                TrackAnalysis.update(data=measures(loud + 0.002 * i), bpm=90 + 80 * loud,
                                     bpm_confidence=0.9).where(TrackAnalysis.track == t.id).execute()
        energy.invalidate()
        discover.invalidate()
        discover.forget_sessions()
        # some taste: three X titles heard through
        for t in self.rows["X"][:3]:
            listening.record(self.user, t, 200)
        self.X = {t.id for t in self.rows["X"]}
        self.Y = {t.id for t in self.rows["Y"]}

    def picks(self, session, runs=40, level=0.4, **kw):
        out = []
        for s in range(runs):
            got = discover.flow_next(self.user, level, session, sid=f"s{s % 4}",
                                     rng=random.Random(s), **kw)
            out += [c.track for c in got]
        return out

    def share(self, ids, group):
        return sum(1 for i in ids if i in group) / max(1, len(ids))


class FlowNextTestCase(_Session):
    def test_one_title_never_one_heard_or_queued(self):
        heard = [(t.id, 1) for t in self.rows["X"][3:6]]
        queued = [t.id for t in self.rows["X"][6:9]]
        s = discover.Session(heard=heard)
        for tid in self.picks(s, runs=20, exclude=queued):
            self.assertNotIn(tid, {h for h, _o in heard} | set(queued))
        two = discover.flow_next(self.user, 0.4, s, n=2, rng=random.Random(1))
        self.assertEqual(len(two), 2)
        self.assertNotEqual(two[0].track, two[1].track)

    def test_the_energy_notch_holds_the_choice(self):
        calm = self.picks(discover.Session(energy=0.1))
        intense = self.picks(discover.Session(energy=0.9))
        # measured: 40 picks, calm 100 % X, intense 100 % Y (base: 97 % X)
        self.assertGreaterEqual(self.share(calm, self.X), 0.85)
        self.assertGreaterEqual(self.share(intense, self.Y), 0.85)

    def test_more_like_this_pulls_and_less_like_this_pushes(self):
        base = self.picks(discover.Session())
        y = self.rows["Y"][0].id
        more = self.picks(discover.Session(more=[y]))
        # measured: Y 0 % -> 60 % after one "plus comme ça"; X 97 % -> 12 %
        # after two "moins comme ça"
        self.assertGreater(self.share(more, self.Y), self.share(base, self.Y) + 0.2,
                           (self.share(base, self.Y), self.share(more, self.Y)))
        x = [t.id for t in self.rows["X"][:2]]
        less = self.picks(discover.Session(less=x))
        self.assertLess(self.share(less, self.X), self.share(base, self.X))
        self.assertFalse(set(less) & set(x))

    def test_skips_turn_the_flow_little_by_little(self):
        xs = [t.id for t in self.rows["X"][5:]]

        def after(k):
            return self.share(self.picks(discover.Session(heard=[(x, -1) for x in xs[:k]])), self.X)

        base, one, three, five = after(0), after(1), after(3), after(5)
        # measured (40 picks, the person's taste in X): X 95-97 % with no skip,
        # 97 % after one, 80 % after three in a row, 27 % after five; before
        # the streak counted, five in a row still left 90-97 % (a near genre
        # only gets x0.19, a far one is out of the discovery band).
        self.assertGreaterEqual(one, 0.85)
        self.assertGreaterEqual(one, three)
        self.assertLess(five, 0.6, (base, one, three, five))
        self.assertEqual(discover.Session(heard=[(xs[0], -1), (xs[1], 1), (xs[2], -1)]).skip_streak(), 1)
        # one title heard through ends the streak
        healed = discover.Session(heard=[(x, -1) for x in xs[:5]] + [(self.rows["X"][4].id, 1)])
        self.assertEqual(healed.skip_streak(), 0)
        self.assertGreater(self.share(self.picks(healed), self.X), 0.85)

    def test_with_no_notch_what_is_heard_through_sets_a_soft_aim(self):
        ys = [(t.id, 1) for t in self.rows["Y"][-4:]]
        s = discover.Session(heard=ys)
        aim, band = discover._energy_aim(s, energy.energies())
        self.assertGreater(aim, 0.6)
        self.assertGreater(band, energy.BAND)
        self.assertIsNone(discover._energy_aim(discover.Session(heard=ys[:2]), energy.energies())[0])

    def test_a_disliked_title_is_never_the_next(self):
        from supysonic import dislikes

        bad = self.rows["X"][4]
        dislikes.set_disliked(self.user, bad, True)
        self.assertNotIn(bad.id, self.picks(discover.Session(), runs=30))

    def test_a_warm_session_costs_a_handful_of_statements(self):
        s = discover.Session(heard=[(self.rows["X"][0].id, 1)], more=[self.rows["Y"][0].id])
        discover.flow_next(self.user, 0.4, s, sid="warm", rng=random.Random(0))
        n = count_statements(lambda: discover.flow_next(self.user, 0.4, s, sid="warm",
                                                        rng=random.Random(1)))
        # the "more" neighbours, the anchors' neighbours, their artists, the
        # pairs for the order: measured 4 (the pool itself is kept per session)
        self.assertLessEqual(n, 6)


class RoutesTestCase(_Session):
    def post(self, **body):
        return self.client.post("/api/flow/next", json=body)

    def test_the_route_answers_one_title_with_its_energy(self):
        r = self.post(sid="abc", d=0.4, energy=0.9, heard=[{"id": str(self.rows["X"][0].id), "s": 3}])
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(len(r.json["tracks"]), 1)
        t = r.json["tracks"][0]
        self.assertIn("energy", t)
        self.assertEqual(r.json["energy_step"], "Intense")
        self.assertEqual(len(self.post(sid="abc", n=2).json["tracks"]), 2)
        self.assertEqual(len(self.post(sid="abc", n=9).json["tracks"]), 2)

    def test_bad_input_is_refused_or_ignored(self):
        self.assertEqual(self.client.post("/api/flow/next", data="x").status_code, 400)
        self.assertEqual(self.post(d="nan").status_code, 400)
        self.assertEqual(self.post(energy=True).status_code, 400)
        self.assertEqual(self.post(energy="x").status_code, 400)
        r = self.post(heard=[{"id": "../etc", "s": "x"}, "nope", {"s": 5}], more="x",
                      less=[{"a": 1}], exclude="no", sid="!!", n="x")
        self.assertEqual(r.status_code, 200)
        anon = self.app.test_client()
        self.assertIn(anon.post("/api/flow/next", json={}).status_code, (401, 403))

    def test_the_notch_is_kept_per_person(self):
        prefs = self.client.get("/api/discover/prefs").json
        self.assertIsNone(prefs["energy"])
        self.assertEqual(prefs["energy_step"], "Libre")
        self.assertEqual([s["name"] for s in prefs["energy_steps"]][:2], ["Libre", "Très calme"])
        r = self.client.put("/api/discover/prefs", json={"energy": 0.7})
        self.assertEqual(r.json["energy_step"], "Énergique")
        self.assertEqual(UserTaste.get(UserTaste.user == self.user).energy, 0.7)
        # the slider alone leaves the notch alone, and the reverse
        self.client.put("/api/discover/prefs", json={"level": 0.6})
        self.assertEqual(self.client.get("/api/discover/prefs").json["energy"], 0.7)
        self.client.put("/api/discover/prefs", json={"energy": None})
        prefs = self.client.get("/api/discover/prefs").json
        self.assertIsNone(prefs["energy"])
        self.assertEqual(prefs["level"], 0.6)
        self.assertEqual(self.client.put("/api/discover/prefs", json={"energy": "x"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()

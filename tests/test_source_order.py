# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Réglages → Sources → Ordre des sources (plan multi-provider §3 and §5): a
main source, then the fallbacks in the order they are asked; the best quality
first where the order was never chosen, and between two equally good matches.
Every screen reads the names and places from the server: none is written in
the web app."""

import unittest
from unittest import mock

from supysonic.db import Track, now
from supysonic.providers import base
from supysonic.providers.deezer import DeezerAdapter
from supysonic.providers.fake import FakeProvider
from supysonic.providers.info import MusicBrainzProvider
from supysonic.providers.local import LocalProvider
from supysonic.providers.registry import MemoryStore, Registry
from supysonic.providers.youtube import YoutubeAdapter

from . import test_webui
from .test_access import _Case

FLAC = {"fmt": "flac", "lossless": True, "bit_depth": 16, "sample_rate": 44100}
MP3 = {"fmt": "mp3", "bitrate": 320}
OPUS = {"fmt": "opus", "bitrate": 96}


def fallback(pid, ceiling):
    return FakeProvider(pid, role=base.FALLBACK, ceiling=ceiling)


class RegistryOrderTestCase(unittest.TestCase):
    def setUp(self):
        self.reg = Registry(MemoryStore())
        # Registered worst first: the order nobody chose must not be this one.
        self.low = self.reg.register(fallback("low", OPUS))
        self.hi = self.reg.register(fallback("hi", FLAC))
        self.lead = self.reg.register(FakeProvider("lead", ceiling=MP3))
        self.facts = self.reg.register(MusicBrainzProvider())

    def ids(self, providers):
        return [p.id for p in providers]

    def test_nobody_ordered_the_one_that_can_lead_then_the_best_quality(self):
        self.assertEqual(self.ids(self.reg.sound()), ["lead", "hi", "low"])
        self.assertEqual(self.reg.main().id, "lead")
        self.assertEqual(self.ids(self.reg.fallbacks()), ["hi", "low"])

    def test_the_admins_order_is_the_order_asked(self):
        self.reg.set_sources(order=["lead", "low", "hi"])
        self.assertEqual(self.ids(self.reg.fallbacks()), ["low", "hi"])
        # …and quality still wins between two of them, the order breaking ties.
        self.assertEqual(self.reg.by_quality(["low", "hi"]), ["hi", "low"])
        twin = self.reg.register(fallback("twin", OPUS))
        self.reg.set_sources(order=["lead", "twin", "low", "hi"])
        self.assertEqual(self.reg.by_quality(["low", "twin"]), ["twin", "low"])
        self.assertEqual(twin.id, "twin")

    def test_a_source_that_cannot_lead_is_refused_first_and_nothing_is_written(self):
        with self.assertRaises(ValueError):
            self.reg.set_sources(order=["hi", "lead"], enabled={"low": False})
        self.assertEqual(self.ids(self.reg.sound()), ["lead", "hi", "low"])
        self.assertTrue(self.reg.is_enabled("low"))

    def test_a_source_switched_off_is_no_fallback(self):
        self.reg.set_sources(enabled={"hi": False})
        self.assertEqual(self.ids(self.reg.fallbacks()), ["low"])
        self.assertEqual(self.ids(self.reg.sound()), ["lead", "hi", "low"])  # still listed

    def test_with_the_main_one_off_the_next_that_can_lead_leads(self):
        other = self.reg.register(FakeProvider("other", ceiling=OPUS))
        self.reg.set_sources(order=["lead", "other", "hi", "low"], enabled={"lead": False})
        self.assertEqual(self.reg.main().id, other.id)
        self.reg.set_sources(enabled={"other": False})
        self.assertIsNone(self.reg.main())
        self.assertEqual(self.ids(self.reg.fallbacks()), ["hi", "low"])

    def test_a_provider_without_a_switch_cannot_be_switched(self):
        dz = self.reg.register(DeezerAdapter(lambda: None))
        with self.assertRaises(ValueError):
            self.reg.set_sources(enabled={dz.id: False})

    def test_facts_and_local_files_are_not_sources(self):
        self.reg.register(LocalProvider())
        self.assertEqual(self.ids(self.reg.sound()), ["lead", "hi", "low"])


class SourcesApiTestCase(_Case):
    CLOSE_ANONYMOUS = False

    def setUp(self):
        super().setUp()
        reg = self.app.providers
        reg.register(DeezerAdapter(lambda: self.app.deezer))
        reg.register(YoutubeAdapter())
        self.fa = reg.register(fallback("fba", OPUS))
        self.fb = reg.register(fallback("fbb", MP3))
        reg.set_enabled("fake", False)  # the test server's own fake source

    def get(self):
        rv = self.client.get("/api/sources")
        self.assertEqual(rv.status_code, 200)
        return rv.get_json()

    def test_everybody_reads_the_order_with_names_places_and_quality(self):
        self.as_bob()
        j = self.get()
        self.assertFalse(j["admin"])
        self.assertEqual(j["main"], "deezer")
        by = {s["id"]: s for s in j["sources"]}
        dz = by["deezer"]
        self.assertEqual((dz["name"], dz["place"], dz["rank"]), ("Deezer", "main", 0))
        self.assertEqual(dz["quality"]["label"], "FLAC")
        self.assertTrue(dz["quality"]["lossless"])
        self.assertFalse(dz["switchable"])
        # Nobody ordered: the better fallback first.
        self.assertEqual((by["fbb"]["place"], by["fbb"]["rank"]), ("fallback", 1))
        self.assertEqual(by["fba"]["rank"], 2)
        yt = by["youtube"]
        if not yt["configured"]:  # the optional extra is not installed here
            self.assertEqual(yt["place"], "off")
            self.assertIn("supysonic[youtube]", yt["setup"])
        # Every screen gets the same, with the person: no request of its own.
        me = self.client.get("/api/me").get_json()["user"]["sources"]
        self.assertEqual([(s["id"], s["place"]) for s in me], [(s["id"], s["place"]) for s in j["sources"]])

    def test_only_an_admin_changes_it(self):
        self.as_bob()
        rv = self.client.put("/api/sources", json={"order": ["deezer", "fba", "fbb"]})
        self.assertEqual(rv.status_code, 403)

        self.as_alice()
        rv = self.client.put("/api/sources", json={"order": ["deezer", "fba", "fbb"]})
        self.assertEqual(rv.status_code, 200, rv.get_data(as_text=True))
        by = {s["id"]: s for s in rv.get_json()["sources"]}
        self.assertEqual((by["fba"]["rank"], by["fbb"]["rank"]), (1, 2))
        me = self.client.get("/api/me").get_json()["user"]["sources"]
        self.assertEqual([s["id"] for s in me if s["place"] == "fallback"], ["fba", "fbb"])

        rv = self.client.put("/api/sources", json={"enabled": {"fba": False}})
        by = {s["id"]: s for s in rv.get_json()["sources"]}
        self.assertEqual((by["fba"]["place"], by["fbb"]["rank"]), ("off", 1))

    def test_what_cannot_be_is_refused_whole(self):
        self.as_alice()
        for body in (
            {"order": ["fba", "deezer"]},  # a fallback cannot lead
            {"enabled": {"deezer": False}},  # Deezer has no switch that means anything
            {"order": "deezer"},
            {"order": ["x" * 17]},
            {"enabled": {"fba": "no"}},
            {"order": ["fba"] * 17},
        ):
            rv = self.client.put("/api/sources", json=body)
            self.assertEqual(rv.status_code, 400, body)
            self.assertTrue(rv.get_json()["error"])
        self.assertEqual(self.get()["main"], "deezer")
        self.assertEqual(self.client.put("/api/sources", data="nope").status_code, 400)


class FallbackOrderTestCase(_Case):
    """The replacement sheet asks the fallbacks in the admin's order, one at a
    time, and stops at the first that has something."""

    CLOSE_ANONYMOUS = False

    def setUp(self):
        super().setUp()
        reg = self.app.providers
        reg.register(DeezerAdapter(lambda: self.app.deezer))
        reg.register(fallback("fba", OPUS))
        reg.register(fallback("fbb", MP3))
        self.asked = []
        self.answers = {"fba": [], "fbb": []}

        def searcher(pid):
            def search(track, query, seen, n=5, ranked=True):
                self.asked.append(pid)
                return list(self.answers[pid])

            return search

        p = mock.patch(
            "supysonic.webui.availability.FALLBACK_SEARCH",
            {"fba": searcher("fba"), "fbb": searcher("fbb")},
        )
        p.start()
        self.addCleanup(p.stop)
        self.as_alice()
        dead = test_webui.WebUITestCase._make_deezer_track(self, sng_id="60", title="Song", archived=False)
        Track.update(unavailable=now()).where(Track.id == dead.id).execute()

    def hit(self, pid, ref):
        return {"deezer_id": ref, "title": "Other", "duration": 10, "source": pid,
                "artists": [{"name": "Nobody"}], "album": {"title": "X"}}

    def candidates(self):
        return self.client.get("/api/replace/candidates/60", query_string={"fallbacks": "1"}).get_json()

    def test_in_order_and_no_further_than_the_first_with_something(self):
        self.answers["fbb"] = [self.hit("fbb", "b1")]
        self.answers["fba"] = [self.hit("fba", "a1")]
        self.candidates()
        self.assertEqual(self.asked, ["fbb"])  # nobody ordered: MP3 320 is better than Opus 96

        self.client.put("/api/sources", json={"order": ["deezer", "fba", "fbb"]})
        self.asked.clear()
        body = self.candidates()
        self.assertEqual(self.asked, ["fba"])
        self.assertIn("a1", [c["deezer_id"] for c in body["candidates"]])

        self.answers["fba"] = []
        self.asked.clear()
        self.candidates()
        self.assertEqual(self.asked, ["fba", "fbb"])

    def test_a_fallback_switched_off_is_never_asked(self):
        self.answers["fbb"] = [self.hit("fbb", "b1")]
        self.client.put("/api/sources", json={"enabled": {"fbb": False}})
        self.candidates()
        self.assertEqual(self.asked, ["fba"])


if __name__ == "__main__":
    unittest.main()

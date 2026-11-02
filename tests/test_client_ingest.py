# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The server's side of analysing on the client PC: the list of what to measure, the
measures coming back (range-checked, version-checked, admin-only), the setting that says
who measures, and the shared decision (`analysis._store_verdict`). The measuring itself is
webapp/measure; what these pin is that a client can never write anything the server's own
pass would not."""

import json
import os
import shutil
import subprocess
import unittest
from unittest import mock

from supysonic.db import Meta, Track, TrackAnalysis
from supysonic.deezer import analysis as ana
from supysonic.managers.user import UserManager

from .test_discover import _Library

GOOD = {
    "version": ana.ANALYSIS_VERSION,
    "spectral": {"centroid": 3100.0, "spread": 3500.0, "flatness": 0.2, "flatness_hi": 0.5,
                 "entropy": 0.9, "rolloff": 7000.0, "flux_peak": 1.8, "lufs": -9.5, "lra": 3.1,
                 "frames": 5000},
    "tempo": {"bpm": 200.0, "confidence": 0.9, "salience": 2.5, "alternation": 0.95,
              "attacks": 220.0, "grid": 0.4},
}


class _Archived(_Library):
    def setUp(self):
        super().setUp()
        self.track = self.tracks["Fav"][0]
        TrackAnalysis.delete().where(TrackAnalysis.track == self.track).execute()
        os.makedirs(os.path.dirname(self.track.path), exist_ok=True)
        with open(self.track.path, "wb") as fp:
            fp.write(b"fLaC")

    def post(self, body=None, tid=None, client=None):
        return (client or self.client).post(
            f"/api/analysis/{tid or self.track.id}/measures", json=body if body is not None else GOOD)


class IngestTestCase(_Archived):
    def test_valid_measures_are_decided_and_stored_by_the_server(self):
        r = self.post()
        self.assertEqual(r.status_code, 200, r.data)
        row = TrackAnalysis.get(TrackAnalysis.track == self.track)
        self.assertEqual(row.version, ana.ANALYSIS_VERSION)
        self.assertEqual(row.bpm, 200.0)
        self.assertEqual(row.bpm_source, "measured")
        self.assertTrue(row.style)  # the server's rules / head / tag decided it
        data = json.loads(row.data)
        self.assertEqual(data["measuredBy"], "client")
        self.assertAlmostEqual(data["pulse"], 0.4)
        self.assertAlmostEqual(data["lra"], 3.1)

    def test_the_tempo_gates_are_the_servers(self):
        for tempo, label in (
            ({**GOOD["tempo"], "attacks": 10.0}, "too few bass attacks a minute"),
            ({**GOOD["tempo"], "salience": 1.0}, "no salience"),
            ({**GOOD["tempo"], "bpm": 400.0}, "out of range"),
            (None, "no tracker output"),
        ):
            TrackAnalysis.delete().where(TrackAnalysis.track == self.track).execute()
            self.assertEqual(self.post({**GOOD, "tempo": tempo}).status_code, 200, label)
            self.assertIsNone(TrackAnalysis.get(TrackAnalysis.track == self.track).bpm, label)

    def test_a_current_verdict_is_not_overwritten_unless_forced(self):
        self.post()
        row = TrackAnalysis.get(TrackAnalysis.track == self.track)
        TrackAnalysis.update(bpm=111.0).where(TrackAnalysis.track == self.track).execute()
        self.post()
        self.assertEqual(TrackAnalysis.get(TrackAnalysis.track == self.track).bpm, 111.0)
        self.post({**GOOD, "force": True})
        self.assertEqual(TrackAnalysis.get(TrackAnalysis.track == self.track).bpm, 200.0)
        self.assertEqual(row.version, ana.ANALYSIS_VERSION)

    def test_a_client_for_another_version_is_refused(self):
        r = self.post({**GOOD, "version": ana.ANALYSIS_VERSION - 1})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json["server"], ana.ANALYSIS_VERSION)
        self.assertEqual(self.post({k: v for k, v in GOOD.items() if k != "version"}).status_code, 409)
        self.assertIsNone(TrackAnalysis.get_or_none(TrackAnalysis.track == self.track))

    def test_hostile_numbers_are_refused_and_nothing_is_stored(self):
        def with_spectral(**kw):
            return {**GOOD, "spectral": {**GOOD["spectral"], **kw}}

        bad = [
            with_spectral(centroid=-1), with_spectral(centroid=1e9), with_spectral(flatness="x"),
            with_spectral(entropy=float("nan")), with_spectral(lufs=True), with_spectral(lra=500),
            with_spectral(centroid=None), {**GOOD, "spectral": None}, {**GOOD, "spectral": [1]},
            {**GOOD, "tempo": {**GOOD["tempo"], "bpm": "fast"}},
            {**GOOD, "tempo": {**GOOD["tempo"], "grid": 7}},
            {**GOOD, "tempo": [1, 2]}, {**GOOD, "tempo": {"bpm": 120}},
        ]
        for body in bad:
            r = self.client.post(f"/api/analysis/{self.track.id}/measures",
                                 data=json.dumps(body, allow_nan=True), content_type="application/json")
            self.assertEqual(r.status_code, 400, body)
        self.assertIsNone(TrackAnalysis.get_or_none(TrackAnalysis.track == self.track))
        for raw in (b"not json", b"[]", b""):
            r = self.client.post(f"/api/analysis/{self.track.id}/measures", data=raw,
                                 content_type="application/json")
            self.assertEqual(r.status_code, 400)

    def test_ids_must_name_an_archived_track(self):
        self.assertEqual(self.post(tid="not-a-uuid").status_code, 400)
        self.assertEqual(self.post(tid="00000000-0000-4000-8000-000000000000").status_code, 404)
        os.remove(self.track.path)
        self.assertEqual(self.post().status_code, 404)

    def test_only_the_admin_may_send_measures_or_ask_what_to_measure(self):
        UserManager.add("bob", "B0b-secret-77", admin=False)
        guest = self.app.test_client()
        self.assertEqual(guest.post("/api/login", json={"username": "bob", "password": "B0b-secret-77"}).status_code, 200)
        self.assertEqual(self.post(client=guest).status_code, 403)
        self.assertEqual(guest.get("/api/analysis/todo").status_code, 403)
        self.assertEqual(guest.put("/api/analysis/where", json={"where": "client"}).status_code, 403)
        anon = self.app.test_client()
        self.assertEqual(anon.get("/api/analysis/todo").status_code, 401)
        self.assertEqual(anon.post(f"/api/analysis/{self.track.id}/measures", json=GOOD).status_code, 401)


class GateTestCase(unittest.TestCase):
    def test_gate_tempo(self):
        ok = {"bpm": 140.0, "salience": 2.0, "confidence": 0.9, "alternation": 0.9}
        self.assertEqual(ana.gate_tempo(100, ok, 0.3), (140.0, 0.9, 0.3, 0.9))
        self.assertEqual(ana.gate_tempo(39.9, ok, 0.3)[0], None)
        self.assertEqual(ana.gate_tempo(100, {**ok, "salience": ana.MIN_BEAT_SALIENCE - 0.01}, 0.3)[0], None)
        self.assertEqual(ana.gate_tempo(100, {**ok, "bpm": ana.MAX_BPM + 1}, 0.3)[0], None)
        self.assertEqual(ana.gate_tempo(100, None, 0.3)[0], None)


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class TodoTestCase(_Library):
    def setUp(self):
        super().setUp()
        self.made = []
        for i, name in enumerate(("Fav", "Near", "Other")):
            t = self.tracks[name][0]
            TrackAnalysis.delete().where(TrackAnalysis.track == t).execute()
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                            f"sine=frequency={300 + 100 * i}:sample_rate=48000:duration=1",
                            "-ac", "2", t.path], check=True)
            self.made.append(t)

    def test_it_lists_archived_unmeasured_tracks_with_what_a_client_needs(self):
        r = self.client.get("/api/analysis/todo?limit=2")
        self.assertEqual(r.status_code, 200)
        body = r.json
        self.assertEqual(len(body["tracks"]), 2)
        self.assertEqual(body["version"], ana.ANALYSIS_VERSION)
        t = body["tracks"][0]
        self.assertEqual((t["rate"], t["channels"]), (48000, 2))
        self.assertTrue(t["url"].startswith("/api/stream/"))
        self.assertEqual(body["spectral_seconds"], ana.MAX_SECONDS)
        self.assertTrue(body["next"])
        more = self.client.get("/api/analysis/todo?limit=2&after=" + body["next"]).json
        ids = {x["id"] for x in body["tracks"]} | {x["id"] for x in more["tracks"]}
        self.assertEqual(ids, {str(t.id) for t in self.made})
        self.assertIsNone(more["next"])

    def test_a_measured_track_is_not_listed_unless_forced(self):
        self.assertEqual(self.client.post(f"/api/analysis/{self.made[0].id}/measures", json=GOOD).status_code, 200)
        listed = {x["id"] for x in self.client.get("/api/analysis/todo").json["tracks"]}
        self.assertNotIn(str(self.made[0].id), listed)
        forced = {x["id"] for x in self.client.get("/api/analysis/todo?force=1").json["tracks"]}
        self.assertIn(str(self.made[0].id), forced)
        self.assertEqual(self.client.get("/api/analysis/todo?after=junk").status_code, 400)


    def test_vector_only_lags_are_listed_for_a_client_that_can_embed(self):
        from supysonic.deezer import embedding as emb

        t = self.made[0]
        self.assertEqual(self.client.post(f"/api/analysis/{t.id}/measures", json=GOOD).status_code, 200)
        with mock.patch.object(emb, "model_path", return_value=__file__), \
                mock.patch.object(emb, "model_info", return_value={"size": 5, "filename": "m.onnx"}):
            plain = self.client.get("/api/analysis/todo?limit=20").json
            wide = self.client.get("/api/analysis/todo?limit=20&embed=1").json
        self.assertNotIn(str(t.id), [x["id"] for x in plain["tracks"]])
        mine = [x for x in wide["tracks"] if x["id"] == str(t.id)]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["need"], {"measure": False, "embed": True})
        others = [x for x in wide["tracks"] if x["id"] != str(t.id)]
        self.assertTrue(all(x["need"] == {"measure": True, "embed": True} for x in others))
        self.assertEqual(wide["extractor"]["dim"], emb.EMBED_DIM)
        self.assertIsNone(plain["extractor"])


class WhereTestCase(_Archived):
    def test_the_choice_is_validated_kept_and_shown(self):
        self.assertEqual(self.client.get("/api/analysis/plan").json["where"], "server")
        for bad in ({"where": "cloud"}, {"where": None}, {}, {"where": ["client"]}):
            self.assertEqual(self.client.put("/api/analysis/where", json=bad).status_code, 400, bad)
        self.assertEqual(self.client.put("/api/analysis/where", json={"where": "client"}).json["where"], "client")
        self.assertEqual(self.client.get("/api/analysis/plan").json["where"], "client")

    def test_in_client_mode_the_servers_job_does_not_measure(self):
        from supysonic.webui import analysis as wa

        Meta.create(key="analysis_where", value="client")
        with mock.patch.object(ana, "backfill", side_effect=AssertionError("the server measured")):
            with wa._analysis_lock:
                wa._analysis_job.update(running=True, cancel=False, stage="measure", mode="now")
            wa._run_analysis(self.app, False, 1, None, "now", None)
        self.assertFalse(wa._analysis_job["running"])
        self.assertIsNone(wa._analysis_job["error"])


if __name__ == "__main__":
    unittest.main()


class ClientEmbeddingTestCase(_Archived):
    def test_a_client_that_can_embed_makes_the_vector_step_due_without_onnxruntime(self):
        from supysonic.deezer import embedding as emb
        from supysonic.webui import analysis as web

        self.post()
        with mock.patch.object(emb, "why_unavailable", return_value="no onnxruntime"), \
                mock.patch.object(emb, "model_path", return_value=__file__):
            Meta.delete().where(Meta.key == "analysis_where").execute()
            self.assertFalse(web.plan()["extractor"])  # the server's own pass cannot embed
            Meta.create(key="analysis_where", value="client")
            p = web.plan()
        self.assertTrue(p["extractor"])
        self.assertEqual(p["stale_embed"], TrackAnalysis.select().where(TrackAnalysis.embed_version < emb.EMBED_VERSION).count())
        self.assertGreaterEqual(p["stale_embed"], 1)  # the track measured above has no vector yet
        self.assertGreaterEqual(p["todo"], 1)

    """The vector a client computes with its own copy of the extractor: validated like
    every other number, stored as the sidecar the server's own pass writes, stamped, and the
    style decided again from it. The model itself is served to the admin only."""

    def vec(self, **kw):
        import base64
        import struct

        from supysonic.deezer import embedding as emb

        vals = kw.pop("values", None) or [((i % 7) - 3) / 10.0 for i in range(emb.EMBED_DIM)]
        return {"version": emb.EMBED_VERSION, "data": base64.b64encode(struct.pack(f"<{len(vals)}e", *vals)).decode(), **kw}

    def test_a_vector_sent_with_the_measures_is_stored_as_the_sidecar_and_stamped(self):
        from supysonic.deezer import embedding as emb

        r = self.post({**GOOD, "embedding": self.vec()})
        self.assertEqual(r.status_code, 200, r.data)
        stored = emb.load_embedding(self.track)
        self.assertEqual(len(stored), emb.EMBED_DIM)
        self.assertAlmostEqual(stored[1], -0.2, places=2)
        self.assertEqual(TrackAnalysis.get(TrackAnalysis.track == self.track).embed_version, emb.EMBED_VERSION)

    def test_a_vector_alone_completes_a_track_measured_before(self):
        from supysonic.deezer import embedding as emb

        self.post()
        self.assertEqual(TrackAnalysis.get(TrackAnalysis.track == self.track).embed_version, 0)
        r = self.client.post(f"/api/analysis/{self.track.id}/embedding", json=self.vec())
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(TrackAnalysis.get(TrackAnalysis.track == self.track).embed_version, emb.EMBED_VERSION)
        self.assertIsNotNone(emb.load_embedding(self.track))

    def test_a_vector_for_a_track_never_measured_is_refused(self):
        r = self.client.post(f"/api/analysis/{self.track.id}/embedding", json=self.vec())
        self.assertEqual(r.status_code, 422)  # not 409: that one means "wrong version" and stops a client run

    def test_hostile_vectors_are_refused_and_nothing_is_written(self):
        from supysonic.deezer import embedding as emb

        nan = [float("nan")] + [0.0] * (emb.EMBED_DIM - 1)
        bad = [
            self.vec(version=emb.EMBED_VERSION - 1),
            self.vec(values=[0.1] * 10),
            self.vec(values=nan),
            {"version": emb.EMBED_VERSION, "data": "!!not base64!!"},
            {"version": emb.EMBED_VERSION, "data": "A" * (emb.EMBED_DIM * 8)},
            {"version": emb.EMBED_VERSION},
            [1, 2],
        ]
        self.post()
        for body in bad:
            r = self.client.post(f"/api/analysis/{self.track.id}/embedding", json=body)
            self.assertIn(r.status_code, (400, 409), body)
        self.assertIsNone(emb.load_embedding(self.track))
        r = self.post({**GOOD, "embedding": self.vec(values=[0.1] * 10)}, tid=self.track.id)
        self.assertEqual(r.status_code, 400)

    def test_the_model_is_served_to_the_admin_unmodified_and_to_nobody_else(self):
        import tempfile

        from supysonic.deezer import embedding as emb

        self.assertEqual(self.client.get("/api/analysis/extractor/model").status_code, 404)
        with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as fp:
            fp.write(b"ONNX-BYTES" * 100)
        try:
            with mock.patch.object(emb, "model_path", return_value=fp.name):
                r = self.client.get("/api/analysis/extractor/model", headers={"Range": "bytes=0-9"})
                self.assertEqual(r.status_code, 206)
                self.assertEqual(r.data, b"ONNX-BYTES")
                self.assertIn("private", r.headers["Cache-Control"])
                UserManager.add("bob", "B0b-secret-77", admin=False)
                guest = self.app.test_client()
                guest.post("/api/login", json={"username": "bob", "password": "B0b-secret-77"})
                self.assertEqual(guest.get("/api/analysis/extractor/model").status_code, 403)
                self.assertEqual(self.app.test_client().get("/api/analysis/extractor/model").status_code, 401)
        finally:
            os.unlink(fp.name)

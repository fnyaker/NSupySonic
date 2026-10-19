# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot D of the Deezer detachment: what is written to disk and kept in the rows.

The oldest release date, Deezer's tempo kept for good, credits read from the
sidecar or the file's own tags, an archive no longer carrying Deezer's gain —
and the migration that brings the archives ALREADY on a server (old sidecars,
old tags, gains in the rows) to that format without ever touching a track being
played."""

import hashlib
import json
import os
import shutil
import subprocess
import unittest
from unittest import mock

import mutagen
from mutagen.flac import FLAC
from mutagen.id3 import ID3, TXXX
from mutagen.mp3 import MP3

from supysonic import filetags
from supysonic.db import Album, Meta, Track
from supysonic.deezer import analysis, diskmigrate, library, local, metadata

from . import test_detach_c as _c
from . import test_webui as _tw
from .test_deezer import count_statements

raw_track = _tw.raw_track
HAS_FFMPEG = bool(shutil.which("ffmpeg"))


def make_audio(path, kind="flac"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    codec = ["-c:a", "libmp3lame"] if kind == "mp3" else []
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=1", *codec, path],
        check=True,
    )


class FakeProvider:
    """The public API's side of the provider, counting what it is asked."""

    def __init__(self, bpm=150, up=True):
        self.bpm, self.up, self.asked = bpm, up, []
        self.dz = self

    @property
    def api(self):
        return self

    def available(self):
        return self.up

    def get_track(self, sid):
        self.asked.append(str(sid))
        return {"bpm": self.bpm}


class DatesTest(_c.LyricsTestCase):
    def test_the_oldest_valid_date_wins(self):
        # A digital reissue of 2015 of an album pressed in 1998.
        f = library.normalize_track(
            {**raw_track(1), "PHYSICAL_RELEASE_DATE": "1998-06-02", "DIGITAL_RELEASE_DATE": "2015-01-09"}
        )
        self.assertEqual((f["release_date"], f["year"]), ("1998-06-02", 1998))
        # ...whichever order they come in, and with the physical one absent.
        f = library.normalize_track(
            {**raw_track(1), "PHYSICAL_RELEASE_DATE": "2015-01-09", "DIGITAL_RELEASE_DATE": "1998-06-02"}
        )
        self.assertEqual(f["release_date"], "1998-06-02")
        f = library.normalize_track({**raw_track(1), "DIGITAL_RELEASE_DATE": "2015-01-09"})
        self.assertEqual(f["release_date"], "2015-01-09")

    def test_unknown_and_malformed_dates_are_not_dates(self):
        for bad in ("0000-00-00", "", None, "2015", "2015-13-01", "2015-00-10", "x"):
            f = library.normalize_track(
                {**raw_track(1), "PHYSICAL_RELEASE_DATE": bad, "DIGITAL_RELEASE_DATE": bad}
            )
            self.assertIsNone(f["release_date"], bad)
            self.assertIsNone(f["year"], bad)
        # A zero date next to a real one is ignored, not "the oldest".
        f = library.normalize_track(
            {**raw_track(1), "PHYSICAL_RELEASE_DATE": "0000-00-00", "DIGITAL_RELEASE_DATE": "2015-01-09"}
        )
        self.assertEqual(f["release_date"], "2015-01-09")

    def test_rows_get_the_date_and_only_ever_an_older_one(self):
        raw = {**raw_track(1), "PHYSICAL_RELEASE_DATE": "1998-06-02", "DIGITAL_RELEASE_DATE": "2015-01-09"}
        t = library.upsert_track(raw, self.root, "FLAC")
        self.assertEqual(t.release_date, "1998-06-02")
        self.assertEqual(t.year, 1998)
        self.assertEqual(Album[t.album_id].release_date, "1998-06-02")
        # A thinner listing later (no date at all) erases nothing...
        t = library.upsert_track(raw_track(1), self.root, "FLAC")
        self.assertEqual(Track[t.id].release_date, "1998-06-02")
        self.assertEqual(Album[t.album_id].release_date, "1998-06-02")
        # ...a LATER date does not replace it...
        later = {**raw_track(1), "DIGITAL_RELEASE_DATE": "2020-02-02"}
        library.upsert_track(later, self.root, "FLAC")
        self.assertEqual(Track[t.id].release_date, "1998-06-02")
        # ...an OLDER one does, on the track and on its album.
        older = {**raw_track(1), "PHYSICAL_RELEASE_DATE": "1997-01-01"}
        library.upsert_track(older, self.root, "FLAC")
        self.assertEqual(Track[t.id].release_date, "1997-01-01")
        self.assertEqual(Album[t.album_id].release_date, "1997-01-01")

    def test_archiving_refreshes_the_row_and_writes_the_fact(self):
        t = self._archived_track()
        info = {**raw_track(1), "PHYSICAL_RELEASE_DATE": "2001-03-12", "ISRC": "GBDUW0000059",
                "LABEL_NAME": "Lab"}
        library.refresh_track_metadata(t, info)
        t.save()
        self.assertEqual(Track[t.id].release_date, "2001-03-12")
        library.save_track_metadata(t, info)
        library.update_track_facts(t, library.deezer_facts(t, info), "deezer")
        facts = library.read_track_facts(t)
        self.assertEqual(facts["release_date"], {"value": "2001-03-12", "source": "deezer"})
        self.assertEqual(facts["isrc"]["value"], "GBDUW0000059")
        self.assertEqual(facts["label"]["value"], "Lab")

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg")
    def test_an_upload_takes_its_date_from_its_tags(self):
        path = os.path.join(self.archive_dir, "Uploads", "x", "u.flac")
        make_audio(path)
        f = FLAC(path)
        f["date"] = "2011-04-05"
        f["isrc"] = "GBDUW0000059"
        f["label"] = "Lab"
        f.save()
        t = local.import_local_file(path, self.root)
        self.assertEqual(Track[t.id].release_date, "2011-04-05")
        facts = library.read_track_facts(t)
        self.assertEqual(facts["release_date"], {"value": "2011-04-05", "source": "tags"})

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg")
    def test_an_upload_and_an_archive_give_the_same_fact_keys(self):
        up = os.path.join(self.archive_dir, "Uploads", "x", "u.flac")
        make_audio(up)
        f = FLAC(up)
        f["date"] = "2011-04-05"
        f["isrc"] = "GBDUW0000059"
        f["label"] = "Lab"
        f.save()
        upload = local.import_local_file(up, self.root)
        archive = self._archived_track()
        info = {**raw_track(1), "PHYSICAL_RELEASE_DATE": "2001-03-12", "ISRC": "GBDUW0000059",
                "LABEL_NAME": "Lab"}
        library.save_track_metadata(archive, info)
        library.update_track_facts(archive, library.deezer_facts(archive, info), "deezer")
        a, u = library.read_track_facts(archive), library.read_track_facts(upload)
        self.assertEqual(set(a) & {"release_date", "isrc", "label"}, {"release_date", "isrc", "label"})
        self.assertEqual(set(u) & {"release_date", "isrc", "label"}, set(a) & {"release_date", "isrc", "label"})
        for k in ("release_date", "isrc", "label"):
            self.assertEqual(set(a[k]), {"value", "source"})
            self.assertEqual(set(u[k]), {"value", "source"})
        self.assertEqual((a["isrc"]["source"], u["isrc"]["source"]), ("deezer", "tags"))


class BpmTest(_c.LyricsTestCase):
    def test_deezer_is_asked_once_for_ever(self):
        t = self._archived_track(5)
        prov = FakeProvider(174)
        self.assertEqual(analysis._deezer_bpm(prov, t), 174.0)
        self.assertEqual(prov.asked, ["5"])
        self.assertEqual(Track[t.id].deezer_bpm, 174.0)
        self.assertEqual(library.read_track_facts(t)["deezer_bpm"],
                         {"value": 174.0, "source": "deezer"})
        # A "second first pass", from a cold process: no memory, a fresh row.
        analysis._hints.clear()
        again = Track[t.id]
        self.assertEqual(analysis._deezer_bpm(prov, again), 174.0)
        self.assertEqual(analysis.deezer_bpm_for(None, again), (174.0, True))
        self.assertEqual(prov.asked, ["5"], "no second request to api.deezer.com")

    def test_no_figure_is_an_answer_too(self):
        t = self._archived_track(6)
        prov = FakeProvider(0)
        self.assertIsNone(analysis._deezer_bpm(prov, t))
        self.assertEqual(Track[t.id].deezer_bpm, 0.0)
        analysis._hints.clear()
        self.assertIsNone(analysis._deezer_bpm(prov, Track[t.id]))
        self.assertEqual(prov.asked, ["6"])
        self.assertNotIn("deezer_bpm", library.read_track_facts(t))

    def test_an_outage_is_not_an_answer(self):
        t = self._archived_track(7)
        down = FakeProvider(150, up=False)
        self.assertEqual(analysis.deezer_bpm_for(down, t), (None, False))
        self.assertIsNone(Track[t.id].deezer_bpm)  # asked again once it is back

    def test_hints_come_from_the_rows_without_the_worker(self):
        t = self._archived_track(8)
        Track.update(deezer_bpm=128.0).where(Track.id == t.id).execute()
        none = self._archived_track(9)
        Track.update(deezer_bpm=0.0).where(Track.id == none.id).execute()
        analysis._hints.clear()
        analysis._hint_queue.clear()
        analysis._hint_queued.clear()
        known, waiting = analysis.tempo_hints(["8", "9"], FakeProvider())
        self.assertEqual((known, waiting), ({"8": 128.0}, []))
        self.assertEqual(len(analysis._hint_queue), 0)

    def test_the_worker_keeps_what_it_learns(self):
        t = self._archived_track(10)
        analysis._hints.clear()
        prov = FakeProvider(140)
        analysis._hint_queue.append("10")
        analysis._hint_queued.add("10")
        analysis._drain_hints(prov)
        self.assertEqual(Track[t.id].deezer_bpm, 140.0)
        self.assertEqual(library.read_track_facts(t)["deezer_bpm"]["value"], 140.0)

    def test_the_audit_reads_the_column(self):
        t = self._archived_track(11)
        Track.update(deezer_bpm=100.0, last_modification=5).where(Track.id == t.id).execute()
        prov = FakeProvider(999)
        with mock.patch.object(analysis, "ffmpeg_available", return_value=True), mock.patch.object(
            analysis, "_measure_tempo", return_value=(200.0, 0.9, 0.5)
        ):
            s = analysis.audit_published_tempo(prov, limit=5)
        self.assertEqual(prov.asked, [])
        self.assertEqual((s["published"], s["half"]), (1, 1))


class StudioAndGenreTest(_c.WebUITestCase):
    def test_the_studio_rows_carry_deezer_bpm(self):
        from supysonic.webui import genre as wg

        with self.app.app_context():
            t = Track.select().first()
        rows = []
        if t is not None:
            rows = [wg._track_json(t)]
        self.assertTrue(all("deezer_bpm" in r and "bpm_source" in r for r in rows))

    def test_a_tags_genre_applies_to_a_deezer_row_too(self):
        class T:
            deezer_id = "5"
            genre = "Frenchcore"

        got = analysis.file_genre(T())
        self.assertIsNotNone(got)
        self.assertEqual(got[0], "Frenchcore")


class CreditsTest(_c.WebUITestCase):
    _credits_setup = _tw.WebUITestCase._credits_setup

    def _row(self, sid, info=None, contributors=False):
        from tempfile import mkdtemp

        d = mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        with self.app.app_context():
            root = library.get_root_folder(d)
            t = library.upsert_track(
                {"SNG_ID": str(sid), "SNG_TITLE": "S", "ART_ID": "1", "ART_NAME": "A",
                 "ALB_ID": "10", "ALB_TITLE": "Alb", "ALB_PICTURE": "c", "DURATION": 100,
                 "TRACK_NUMBER": 1, "DISK_NUMBER": 1}, root, "FLAC")
            os.makedirs(os.path.dirname(t.path), exist_ok=True)
            with open(t.path, "wb") as fh:
                fh.write(b"\x00")
            payload = dict(info or {})
            if contributors:
                payload["SNG_CONTRIBUTORS"] = {"composer": ["Sidecar Composer"]}
            library.save_track_metadata(t, payload)
        return t

    def test_an_archive_never_asks_deezer_even_without_contributors(self):
        gw = self._credits_setup()
        self._login()
        self._row(600, {"ISRC": "GBDUW0000059", "PHYSICAL_RELEASE_DATE": "2001-03-12"})
        data = self.client.get("/api/track/600/credits").get_json()
        self.assertEqual(gw.credit_calls, [], "a track on disk costs Deezer nothing")
        self.assertEqual(data["info"]["isrc"], "GBDUW0000059")
        self.assertEqual(data["info"]["released"], "2001-03-12")

    def test_the_sidecar_answers(self):
        gw = self._credits_setup()
        self._login()
        self._row(601, contributors=True)
        data = self.client.get("/api/track/601/credits").get_json()
        self.assertEqual(gw.credit_calls, [])
        self.assertTrue(any(c["role"] == "composer" for c in data["credits"]))

    def test_not_archived_still_asks_deezer(self):
        gw = self._credits_setup()
        self._login()
        self.client.get("/api/track/3135556/credits")
        self.assertEqual(gw.credit_calls, ["3135556"])

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg")
    def test_an_upload_reads_its_own_tags(self):
        from tempfile import mkdtemp

        gw = self._credits_setup()
        self._login()
        d = mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        path = os.path.join(d, "u.flac")
        make_audio(path)
        f = FLAC(path)
        f["composer"] = "Ann; Bob"
        f["lyricist"] = "Cy"
        f["producer"] = "Di"
        f["label"] = "Lab"
        f["date"] = "2011-04-05"
        f.save()
        with self.app.app_context():
            t = local.import_local_file(path, library.get_root_folder(d))
        data = self.client.get(f"/api/track/{t.id}/credits").get_json()
        self.assertEqual(gw.credit_calls, [])
        by = {c["role"]: [p["name"] for p in c["people"]] for c in data["credits"]}
        self.assertEqual(by["composer"], ["Ann", "Bob"])
        self.assertEqual(by["lyricist"], ["Cy"])
        self.assertEqual(by["producer"], ["Di"])
        self.assertEqual(data["info"]["label"], "Lab")
        self.assertEqual(data["info"]["released"], "2011-04-05")


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg")
class WritingTest(_c.LyricsTestCase):
    def test_a_tagged_archive_carries_no_gain_and_the_oldest_date(self):
        info = {**raw_track(1), "GAIN": "-8.4", "PHYSICAL_RELEASE_DATE": "1998-06-02",
                "DIGITAL_RELEASE_DATE": "2015-01-09"}
        meta = metadata.meta_from_gw(info)
        self.assertNotIn("gain", meta)
        self.assertEqual(meta["date"], "1998-06-02")
        for kind in ("flac", "mp3"):
            p = os.path.join(self.archive_dir, f"a.{kind}")
            make_audio(p, kind)
            metadata.tag_file(p, meta, None)
            audio = mutagen.File(p)
            tags = {k.lower() for k in audio.tags.keys()}
            self.assertFalse([k for k in tags if "replaygain" in k], (kind, tags))

    def test_the_sidecar_drops_what_deezer_must_not_decide(self):
        t = self._archived_track()
        t.gain = -9.0
        t.save()
        info = {**raw_track(1), "GAIN": "-8.4", "RANK_SNG": "7", "PROVIDER_ID": "3",
                "LYRICS_ID": "9", "ISRC": "GBDUW0000059"}
        library.save_track_metadata(t, info)
        data = json.load(open(library.metadata_path(t)))
        self.assertNotIn("gain", data)
        for k in ("GAIN", "RANK_SNG", "PROVIDER_ID", "LYRICS_ID"):
            self.assertNotIn(k, data["gw"])
        self.assertEqual(data["gw"]["ISRC"], "GBDUW0000059")


OLD_GW = {
    "SNG_ID": "1", "ISRC": "GBDUW0000059", "LABEL_NAME": "Lab",
    "PHYSICAL_RELEASE_DATE": "1998-06-02", "DIGITAL_RELEASE_DATE": "2015-01-09",
    "GAIN": "-8.4", "RANK_SNG": "7", "PROVIDER_ID": "3", "LYRICS_ID": "9",
}


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg")
class MigrationTest(_c.LyricsTestCase):
    """Three archives as an existing server holds them, brought up to date."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(diskmigrate, "BPM_PAUSE", 0)
        patcher.start()
        self.addCleanup(patcher.stop)
        diskmigrate._counts.update(sidecar=0, tags=0, bpm=0, bpm_unreachable=0, unchanged=0)
        self.a = self._old_archive(1, "flac", sidecar=True)
        self.b = self._old_archive(2, "mp3", sidecar=True)
        self.c = self._old_archive(3, "flac", sidecar=False, old_tags=False)

    def _old_archive(self, sid, kind, *, sidecar, old_tags=True):
        quality = "FLAC" if kind == "flac" else "MP3_320"
        t = library.upsert_track(
            {**raw_track(sid), "GAIN": "-8.4", "PHYSICAL_RELEASE_DATE": "1998-06-02"}, self.root, quality
        )
        make_audio(t.path, kind)
        if old_tags:
            if kind == "flac":
                f = FLAC(t.path)
                f["title"] = "T"
                f["date"] = "2015-01-09"
                f["replaygain_track_gain"] = "-10.00 dB"
                f["lyrics"] = "words that must survive"
                f.save()
            else:
                tags = ID3()
                tags.add(TXXX(encoding=3, desc="REPLAYGAIN_TRACK_GAIN", text="-10.00 dB"))
                tags.save(t.path)
        t.last_modification = 1000
        t.save()
        if sidecar:
            with open(library.metadata_path(t), "w") as fh:
                json.dump({"deezer_id": str(sid), "title": "T", "gain": -8.4, "year": 2015,
                           "gw": {**OLD_GW, "SNG_ID": str(sid)}}, fh)
        return Track[t.id]

    def _digest(self, *tracks):
        out = {}
        for t in tracks:
            for p in (t.path, library.metadata_path(t)):
                if os.path.exists(p):
                    out[p] = (hashlib.sha256(open(p, "rb").read()).hexdigest(), os.stat(p).st_mtime_ns)
        return out

    def test_old_archives_are_brought_to_the_new_format(self):
        prov = FakeProvider(150)
        stats = diskmigrate.make_job(prov).run()
        self.assertEqual((stats["done"], stats["failed"]), (3, 0), stats)
        # Sidecar: no gain, no excluded fields, the facts block.
        data = json.load(open(library.metadata_path(self.a)))
        self.assertNotIn("gain", data)
        self.assertEqual(set(data["gw"]) & {"GAIN", "RANK_SNG", "PROVIDER_ID", "LYRICS_ID"}, set())
        self.assertEqual(data["gw"]["ISRC"], "GBDUW0000059")
        facts = library.read_track_facts(Track[self.a.id])
        self.assertEqual(facts["release_date"]["value"], "1998-06-02")
        self.assertEqual(facts["deezer_bpm"], {"value": 150.0, "source": "deezer"})
        # Tags: ReplayGain gone, the oldest date, every other tag kept.
        f = FLAC(self.a.path)
        self.assertNotIn("replaygain_track_gain", f)
        self.assertEqual(f["date"], ["1998-06-02"])
        self.assertEqual(f["lyrics"], ["words that must survive"])
        self.assertNotIn("TXXX:REPLAYGAIN_TRACK_GAIN", ID3(self.b.path))
        # A sidecar-less archive gets one; its tempo is learnt.
        self.assertTrue(os.path.exists(library.metadata_path(self.c)))
        self.assertEqual({Track[t.id].deezer_bpm for t in (self.a, self.b, self.c)}, {150.0})
        self.assertEqual(sorted(prov.asked), ["1", "2", "3"])
        # Nothing staged is left behind, and the row's measured gain is not touched.
        left = [n for _d, _s, fs in os.walk(self.archive_dir) for n in fs if "migrating" in n or n.endswith(".part")]
        self.assertEqual(left, [])
        self.assertAlmostEqual(Track[self.a.id].gain, -8.4)

    def test_a_second_run_changes_nothing(self):
        prov = FakeProvider(150)
        diskmigrate.make_job(prov).run()
        before = self._digest(self.a, self.b, self.c)
        asked = list(prov.asked)
        diskmigrate._counts.update(sidecar=0, tags=0, bpm=0, unchanged=0)
        stats = diskmigrate.make_job(prov).run()
        self.assertEqual(stats["failed"], 0)
        self.assertEqual(self._digest(self.a, self.b, self.c), before, "bytes and mtimes identical")
        self.assertEqual(prov.asked, asked, "no request the second time")
        self.assertEqual(diskmigrate._counts["unchanged"], 3)

    def test_a_track_stays_playable_while_it_is_rewritten(self):
        seen = []
        real = os.replace

        def checked(src, dst, *a, **k):
            if dst == self.a.path:
                # Published file untouched until the swap, and whole at every moment.
                FLAC(dst)
                seen.append((os.path.getsize(dst) > 0, os.path.basename(src).startswith(".")))
                FLAC(src)  # the staged copy is complete before it is published
            return real(src, dst, *a, **k)

        with mock.patch.object(os, "replace", checked):
            diskmigrate.make_job(None).run()
        self.assertEqual(seen, [(True, True)])
        FLAC(self.a.path)

    def test_a_file_that_cannot_be_tagged_stays_as_it_was(self):
        junk = self.a.path
        open(junk, "wb").write(b"not a flac at all")
        before = open(junk, "rb").read()
        stats = diskmigrate.make_job(None).run()
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(open(junk, "rb").read(), before)
        self.assertEqual(stats["done"], 2)

    def test_deezer_unreachable_costs_nothing_but_the_tempo(self):
        down = FakeProvider(150, up=False)
        stats = diskmigrate.make_job(down).run()
        self.assertEqual((stats["done"], stats["failed"]), (3, 0))
        self.assertEqual(diskmigrate._counts["bpm_unreachable"], 3)
        self.assertIsNone(Track[self.a.id].deezer_bpm)
        self.assertNotIn("replaygain_track_gain", FLAC(self.a.path))

    def test_it_resumes_where_it_stopped(self):
        job = diskmigrate.make_job(None)
        job.page_size = 1
        job.run(limit=1)
        self.assertIsNotNone(Meta.get_or_none(Meta.key == diskmigrate.CURSOR_KEY))
        stats = diskmigrate.make_job(None).run()
        self.assertEqual(stats["done"], 2)
        self.assertIsNone(Meta.get_or_none(Meta.key == diskmigrate.CURSOR_KEY))


class MigrationRouteTest(_c.WebUITestCase):
    def test_admin_only_and_classified(self):
        from supysonic.webui import remote

        self.assertEqual(remote.POLICY["archive_migrate_start"], "admin")
        self.assertEqual(remote.POLICY["archive_migrate_status"], "admin")
        self.assertEqual(self.client.post("/api/archive/migrate").status_code, 401)
        self.assertEqual(self.client.get("/api/archive/migrate").status_code, 401)

    def test_start_and_status(self):
        self._login()
        with mock.patch.object(diskmigrate, "start", return_value=True) as start:
            rv = self.client.post("/api/archive/migrate", json={"force": True})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(start.call_args.kwargs, {"force": True})
        body = self.client.get("/api/archive/migrate").get_json()
        self.assertIn("counts", body)
        self.assertIn("running", body)


class StatementsTest(_c.LyricsTestCase):
    def test_hint_lookup_is_one_statement(self):
        for i in range(20, 25):
            self._archived_track(i)
        analysis._hints.clear()
        with count_statements() as n:
            analysis.tempo_hints([str(i) for i in range(20, 25)], None)
        # No provider: nothing queued, and the rows are read in a single query.
        self.assertEqual(sum(n.values()), 0)
        with count_statements() as n:
            analysis.tempo_hints([str(i) for i in range(20, 25)], FakeProvider())
        self.assertEqual(sum(n.values()), 1)
        analysis._hint_queue.clear()
        analysis._hint_queued.clear()


if __name__ == "__main__":
    unittest.main()

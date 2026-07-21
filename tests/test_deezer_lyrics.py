# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Offline tests for lyrics archiving (Deezer + LRCLIB), with mocked network."""

import os
import os.path
import tempfile

from supysonic.db import Track
from supysonic.deezer import library, lyrics

from .testbase import TestBase


def raw_track(sid, title="Creep", art=("1", "Radiohead"), alb=("10", "Pablo Honey"), dur=239):
    return {
        "SNG_ID": str(sid),
        "SNG_TITLE": title,
        "ART_ID": art[0],
        "ART_NAME": art[1],
        "ALB_ID": alb[0],
        "ALB_TITLE": alb[1],
        "ALB_PICTURE": "cover",
        "DURATION": dur,
        "TRACK_NUMBER": 1,
        "DISK_NUMBER": 1,
    }


class FakeResp:
    def __init__(self, status, data):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


class FakeSession:
    """Routes LRCLIB /get and /search to canned responses, recording calls."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def get(self, url, params=None, timeout=None, headers=None):
        self.calls.append((url.rsplit("/", 1)[-1], params))
        return self.routes[url.rsplit("/", 1)[-1]]


class FakeProvider:
    def __init__(self, gw_lyrics=None, boom=False):
        self._gw = gw_lyrics
        self._boom = boom

    def get_lyrics(self, sng_id):
        if self._boom:
            raise RuntimeError("deezer down")
        return self._gw


SYNCED_LRC = "[00:14.20] I'm running\n[00:19.55] out of soul\n[00:19.55] out of soul"
GW_SYNCED = {
    "LYRICS_TEXT": "plain deezer",
    "LYRICS_SYNC_JSON": [
        {"milliseconds": "0", "line": "deezer one"},
        {"milliseconds": "2500", "line": "deezer two"},
    ],
    "LYRICS_COPYRIGHTS": "(c)",
}


class LyricsTestCase(TestBase):
    def setUp(self):
        super().setUp()
        self.archive_dir = tempfile.mkdtemp()
        self.root = library.get_root_folder(self.archive_dir)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.archive_dir, ignore_errors=True)
        super().tearDown()

    def _archived_track(self, sid=1, **kw):
        t = library.upsert_track(raw_track(sid, **kw), self.root, "FLAC")
        os.makedirs(os.path.dirname(t.path), exist_ok=True)
        with open(t.path, "wb") as fh:
            fh.write(b"\x00")  # stand-in for archived audio
        return t

    # -- LRC parsing ----------------------------------------------------

    def test_parse_lrc(self):
        parsed = lyrics.parse_lrc(SYNCED_LRC)
        # Three timestamps (one line repeats), sorted by time.
        self.assertEqual(len(parsed), 3)
        self.assertEqual(parsed[0], {"time": 14200, "text": "I'm running"})
        self.assertEqual(parsed[1]["time"], 19550)
        # 3-digit fractions are milliseconds, 2-digit are centiseconds.
        self.assertEqual(lyrics.parse_lrc("[01:02.5] x"), [{"time": 62500, "text": "x"}])
        self.assertEqual(lyrics.parse_lrc("[01:02.500] x"), [{"time": 62500, "text": "x"}])
        # Metadata tags are ignored.
        self.assertEqual(lyrics.parse_lrc("[ar:Radiohead]\n[00:01.00] hi"),
                         [{"time": 1000, "text": "hi"}])

    def test_lrc_round_trip(self):
        synced = [{"time": 14200, "text": "a"}, {"time": 62500, "text": "b"}]
        back = lyrics.parse_lrc(lyrics.synced_to_lrc(synced))
        self.assertEqual(back, synced)

    # -- source normalizers --------------------------------------------

    def test_normalize_gw(self):
        norm = lyrics.normalize_gw_lyrics(GW_SYNCED)
        self.assertEqual(norm["source"], "deezer")
        self.assertEqual(len(norm["synced"]), 2)
        self.assertEqual(norm["synced"][1]["time"], 2500)
        self.assertIsNone(lyrics.normalize_gw_lyrics(None))
        self.assertIsNone(lyrics.normalize_gw_lyrics({}))

    def test_fetch_lrclib_get(self):
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC, "plainLyrics": "p"})})
        res = lyrics.fetch_lrclib("Creep", "Radiohead", "Pablo Honey", 239, session=sess)
        self.assertEqual(res["source"], "lrclib")
        self.assertEqual(len(res["synced"]), 3)
        self.assertEqual(sess.calls[0][0], "get")  # exact signature tried first

    def test_fetch_lrclib_search_fallback(self):
        # /get 404s -> /search picks the closest synced result by duration.
        sess = FakeSession({
            "get": FakeResp(404, {"code": 404}),
            "search": FakeResp(200, [
                {"syncedLyrics": "", "plainLyrics": "only plain", "duration": 100},
                {"syncedLyrics": SYNCED_LRC, "plainLyrics": "p", "duration": 240},
            ]),
        })
        res = lyrics.fetch_lrclib("Creep", "Radiohead", None, 239, session=sess)
        self.assertEqual(len(res["synced"]), 3)
        self.assertEqual([c[0] for c in sess.calls], ["get", "search"])

    def test_fetch_lrclib_instrumental_is_none(self):
        sess = FakeSession({"get": FakeResp(200, {"instrumental": True, "syncedLyrics": None})})
        self.assertIsNone(lyrics.fetch_lrclib("x", "y", None, None, session=sess))

    def test_fetch_lrclib_needs_title_and_artist(self):
        self.assertIsNone(lyrics.fetch_lrclib("", "artist"))
        self.assertIsNone(lyrics.fetch_lrclib("title", ""))

    # -- sidecar storage ------------------------------------------------

    def test_write_read_sidecar_synced(self):
        t = self._archived_track()
        lyr = {"synced": [{"time": 1000, "text": "hi"}], "text": "hi", "source": "lrclib"}
        path = lyrics.write_sidecar(t, lyr)
        self.assertTrue(path.endswith(".lrc"))
        self.assertTrue(os.path.isfile(path))
        got = lyrics.read_sidecar(t)
        self.assertEqual(got["synced"], [{"time": 1000, "text": "hi"}])
        self.assertEqual(got["source"], "archive")

    def test_write_read_sidecar_plain(self):
        t = self._archived_track()
        lyrics.write_sidecar(t, {"synced": [], "text": "just words\nno timing"})
        got = lyrics.read_sidecar(t)
        self.assertEqual(got["synced"], [])
        self.assertIn("just words", got["text"])

    def test_read_sidecar_absent(self):
        t = self._archived_track()
        self.assertIsNone(lyrics.read_sidecar(t))

    # -- ensure_lyrics: source priority + archiving --------------------

    def test_ensure_uses_existing_sidecar(self):
        t = self._archived_track()
        lyrics.write_sidecar(t, {"synced": [{"time": 5, "text": "cached"}], "text": "cached"})
        # No provider, no session: it must not touch the network at all.
        res = lyrics.ensure_lyrics(None, t)
        self.assertEqual(res["synced"][0]["text"], "cached")

    def test_ensure_prefers_deezer_synced(self):
        t = self._archived_track()
        prov = FakeProvider(gw_lyrics=GW_SYNCED)
        # Deezer already has synced lyrics -> LRCLIB is never consulted.
        sess = FakeSession({})
        res = lyrics.ensure_lyrics(prov, t, session=sess, embed=False)
        self.assertEqual(res["source"], "deezer")
        self.assertEqual(sess.calls, [])
        self.assertTrue(os.path.isfile(lyrics.sidecar_path(t)))

    def test_ensure_falls_back_to_lrclib_for_synced(self):
        t = self._archived_track()
        # Deezer has only plain text; LRCLIB has synced -> synced wins.
        prov = FakeProvider(gw_lyrics={"LYRICS_TEXT": "plain only"})
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC, "plainLyrics": "p"})})
        res = lyrics.ensure_lyrics(prov, t, session=sess, embed=False)
        self.assertEqual(res["source"], "lrclib")
        self.assertEqual(len(res["synced"]), 3)

    def test_ensure_lrclib_only_when_no_provider(self):
        t = self._archived_track()
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC})})
        res = lyrics.ensure_lyrics(None, t, session=sess, embed=False)
        self.assertEqual(res["source"], "lrclib")

    def test_ensure_survives_deezer_error(self):
        t = self._archived_track()
        prov = FakeProvider(boom=True)
        sess = FakeSession({"get": FakeResp(200, {"plainLyrics": "words"})})
        res = lyrics.ensure_lyrics(prov, t, session=sess, embed=False)
        self.assertEqual(res["source"], "lrclib")
        self.assertEqual(res["text"], "words")

    def test_ensure_none_when_nothing_found(self):
        t = self._archived_track()
        prov = FakeProvider(gw_lyrics=None)
        sess = FakeSession({"get": FakeResp(404, {}), "search": FakeResp(200, [])})
        self.assertIsNone(lyrics.ensure_lyrics(prov, t, session=sess, embed=False))
        # Nothing written, so a later run can retry.
        self.assertFalse(os.path.isfile(lyrics.sidecar_path(t)))

    def test_ensure_embed_is_best_effort(self):
        # The dummy file isn't real audio; embedding must fail silently and the
        # sidecar must still be written.
        t = self._archived_track()
        sess = FakeSession({"get": FakeResp(200, {"syncedLyrics": SYNCED_LRC})})
        res = lyrics.ensure_lyrics(None, t, session=sess, embed=True)
        self.assertIsNotNone(res)
        self.assertTrue(os.path.isfile(lyrics.sidecar_path(t)))

    def test_ensure_allow_lrclib_false_is_deezer_only(self):
        # The archive hot path (allow_lrclib=False) never touches LRCLIB, even
        # when Deezer only has plain lyrics.
        t = self._archived_track()
        prov = FakeProvider(gw_lyrics={"LYRICS_TEXT": "plain only"})
        sess = FakeSession({})  # any LRCLIB call would KeyError
        res = lyrics.ensure_lyrics(prov, t, session=sess, embed=False, allow_lrclib=False)
        self.assertEqual(res["source"], "deezer")
        self.assertEqual(sess.calls, [])

    def test_ensure_allow_lrclib_false_none_when_deezer_empty(self):
        t = self._archived_track()
        res = lyrics.ensure_lyrics(
            FakeProvider(None), t, session=FakeSession({}), embed=False, allow_lrclib=False
        )
        self.assertIsNone(res)
        self.assertFalse(os.path.isfile(lyrics.sidecar_path(t)))

    # -- backfill -------------------------------------------------------

    def test_backfill(self):
        archived = self._archived_track(1, title="Creep")
        # A second track that is NOT archived (no file on disk) must be skipped.
        library.upsert_track(raw_track(2, title="Karma Police"), self.root, "FLAC")
        # Pre-existing sidecar on a third archived track -> counted as skipped.
        already = self._archived_track(3, title="No Surprises")
        lyrics.write_sidecar(already, {"synced": [], "text": "have it"})

        prov = FakeProvider(gw_lyrics=GW_SYNCED)
        stats = lyrics.backfill_archived_lyrics(
            prov, session=FakeSession({}), sleep=0, progress=lambda s: None
        )
        self.assertEqual(stats["scanned"], 1)  # only track 1 needed fetching
        self.assertEqual(stats["synced"], 1)
        self.assertEqual(stats["skipped"], 1)  # track 3 already had a sidecar
        self.assertTrue(os.path.isfile(lyrics.sidecar_path(archived)))

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Multi-provider lot C: the quality scale and the shared matching rule.

No network, no schema: pure functions, plus real files made by ffmpeg for the
header reading (skipped without it, required where NS_REQUIRE_FFMPEG=1).
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

from supysonic import matching
from supysonic.providers import quality as Q

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
if not HAVE_FFMPEG and os.environ.get("NS_REQUIRE_FFMPEG") == "1":  # pragma: no cover
    raise RuntimeError("NS_REQUIRE_FFMPEG=1 but ffmpeg is not on PATH")


def offer(fmt, bitrate=0, **kw):
    return dict(fmt=fmt, bitrate=bitrate, **kw)


class QualityTable(unittest.TestCase):
    # (offer, class, effective kbit/s): literal, from docs/multi-provider.md §3.
    CASES = [
        (offer("flac", lossless=True, bit_depth=16, sample_rate=44100), 40, 0),
        (offer("flac", lossless=True, bit_depth=24, sample_rate=96000), 50, 0),
        (offer("flac", lossless=True, bit_depth=24, sample_rate=44100), 50, 0),
        (offer("flac", lossless=True, bit_depth=16, sample_rate=96000), 50, 0),
        (offer("flac", lossless=True, bit_depth=16, sample_rate=48000), 40, 0),
        (offer("mp3", 320), 30, 320),
        (offer("mp3", 192), 30, 192),
        (offer("mp3", 191), 20, 191),
        (offer("mp3", 128), 20, 128),
        (offer("mp3", 96), 20, 96),
        (offer("mp3", 95), 10, 95),
        (offer("m4a", 128), 20, 166),
        (offer("opus", 133), 30, 200),
        (offer("opus", 64), 20, 96),
        (offer("ogg", 128), 20, 154),
    ]

    def test_table(self):
        for o, cls, eff in self.CASES:
            q = Q.from_offer(o)
            self.assertEqual((q.cls, q.effective_kbps), (cls, eff), o)

    def test_order_is_total_and_stable(self):
        offers = [o for o, _, _ in self.CASES]
        ranked = Q.rank(offers)
        keys = [(Q.from_offer(o).cls, Q.from_offer(o).effective_kbps) for o in ranked]
        self.assertEqual(keys, sorted(keys, reverse=True))
        # Equal notes keep their input order: the provider order is the tie-break.
        a, b = offer("mp3", 320, ref="a"), offer("mp3", 320, ref="b")
        self.assertEqual([o["ref"] for o in Q.rank([a, b])], ["a", "b"])
        self.assertEqual([o["ref"] for o in Q.rank([b, a])], ["b", "a"])
        self.assertIs(Q.best([a, b]), a)
        self.assertIs(Q.best([offer("mp3", 128), b, a]), b)
        self.assertIsNone(Q.best([]))

    def test_opus_133_beats_mp3_128_but_not_flac(self):
        self.assertGreater(Q.from_offer(offer("opus", 133)), Q.from_offer(offer("mp3", 128)))
        self.assertLess(Q.from_offer(offer("opus", 133)), Q.from_offer(offer("flac", lossless=True)))

    def test_malformed_offers_are_the_lowest_note(self):
        for bad in (None, {}, "flac", offer("mp3", "abc"), offer(None, None), offer("mp3", float("inf"))):
            self.assertEqual(Q.from_offer(bad).cls, Q.LOW, bad)
        self.assertEqual(Q.from_offer(offer("mp3", -5)).effective_kbps, 0)

    def test_lossless_guess_follows_the_format_unless_told(self):
        self.assertEqual(Q.from_offer(offer("flac")).cls, 40)
        self.assertEqual(Q.from_offer(offer("mp3", 320, lossless=False)).cls, 30)

    def test_labels(self):
        self.assertEqual(Q.label(Q.from_offer(offer("flac", lossless=True))), "FLAC")
        self.assertEqual(
            Q.label(Q.from_offer(offer("flac", lossless=True, bit_depth=24, sample_rate=96000))), "FLAC 24/96"
        )
        self.assertEqual(Q.label(Q.from_offer(offer("opus", 133))), "Opus 133k")
        self.assertEqual(Q.label(Q.from_offer(offer("mp3", 320))), "MP3 320k")
        self.assertEqual(Q.label(None), "")


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class QualityFromFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.addClassCleanup(shutil.rmtree, cls.dir, True)

    def make(self, name, *args):
        path = os.path.join(self.dir, name)
        cmd = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000", *args, path]
        subprocess.run(cmd, check=True)
        return path

    def test_flac_16_and_24(self):
        q = Q.from_file(self.make("a.flac", "-sample_fmt", "s16", "-ar", "44100"))
        self.assertEqual((q.cls, q.fmt, q.bit_depth), (Q.LOSSLESS, "flac", 16))
        q = Q.from_file(self.make("b.flac", "-sample_fmt", "s32", "-ar", "96000", "-bits_per_raw_sample", "24"))
        self.assertEqual(q.cls, Q.HIRES)
        self.assertEqual(Q.label(q), "FLAC 24/96")

    def test_mp3_and_opus(self):
        q = Q.from_file(self.make("c.mp3", "-b:a", "320k"))
        self.assertEqual((q.cls, q.fmt), (Q.HIGH, "mp3"))
        self.assertAlmostEqual(q.bitrate, 320, delta=2)
        q = Q.from_file(self.make("d.mp3", "-b:a", "128k"))
        self.assertEqual(q.cls, Q.MEDIUM)
        q = Q.from_file(self.make("e.opus", "-c:a", "libopus", "-b:a", "128k"))
        self.assertEqual((q.cls, q.fmt), (Q.HIGH, "opus"))  # 128 × 1.5 = 192
        q = Q.from_file(self.make("f.opus", "-c:a", "libopus", "-b:a", "64k"))
        self.assertEqual(q.cls, Q.MEDIUM)

    def test_not_audio_or_missing_is_none(self):
        bad = os.path.join(self.dir, "x.flac")
        with open(bad, "wb") as f:
            f.write(b"not audio at all")
        self.assertIsNone(Q.from_file(bad))
        self.assertIsNone(Q.from_file(os.path.join(self.dir, "nope.flac")))


def trk(title, artist="Stromae", duration=207, isrc=None, **kw):
    d = {"title": title, "artists": [{"name": artist}], "duration": duration, "isrc": isrc}
    d.update(kw)
    return d


class SameRecording(unittest.TestCase):
    def test_radio_edit_label_is_maybe_not_sure(self):
        album = trk("Alors on danse", duration=207)
        yt = trk("Alors on danse (Radio Edit)", duration=207)
        # "Edit" is a cut's label, and a label is not always right: maybe, never sure.
        self.assertEqual(matching.same_recording(album, yt), "maybe")
        self.assertEqual(matching.same_recording(album, trk("Alors on danse (Edit)", duration=208)), "maybe")
        # "Remastered" names a pressing, not another recording.
        self.assertEqual(matching.same_recording(album, trk("Alors on danse (Remastered 2011)")), "sure")
        self.assertEqual(matching.same_recording(album, trk("Alors on danse (Edit)", duration=240)), "no")

    def test_isrc_wins(self):
        a = trk("One", isrc="FR-Z03-12-00001", duration=100)
        b = trk("Totally Different", artist="Other", isrc="FRZ031200001", duration=300)
        self.assertEqual(matching.same_recording(a, b), "sure")

    def test_same_isrc_never_makes_two_titles_agree_without_it(self):
        a, b = trk("One"), trk("Two")
        self.assertEqual(matching.same_recording(a, b), "no")
        self.assertEqual(matching.same_recording(trk("One", isrc="FRZ031200001"), trk("Two", isrc="FRZ031200002")), "no")

    def test_remix_and_live_are_other_recordings(self):
        self.assertEqual(matching.same_recording(trk("Halo"), trk("Halo (Remix)")), "no")
        self.assertEqual(matching.same_recording(trk("Halo"), trk("Halo - Live")), "no")
        self.assertEqual(matching.same_recording(trk("Halo (Live)"), trk("Halo - Live")), "sure")

    def test_feat_and_punctuation_and_accents(self):
        a = trk("Halo", artist="Beyoncé", duration=261)
        b = {"title": "HALO!", "display_artist": "Beyonce feat. Jay-Z", "duration": 262}
        self.assertEqual(matching.same_recording(a, b), "sure")

    def test_other_artist_or_length(self):
        self.assertEqual(matching.same_recording(trk("Halo"), trk("Halo", artist="Cover Band")), "no")
        self.assertEqual(matching.same_recording(trk("Halo", duration=200), trk("Halo", duration=204)), "no")
        self.assertEqual(matching.same_recording(trk("Halo", duration=200), trk("Halo", duration=203)), "sure")
        self.assertEqual(matching.same_recording(trk("Halo", duration=0), trk("Halo", duration=203)), "maybe")

    def test_rows_and_empty_input(self):
        row = SimpleNamespace(title="Halo", artist=SimpleNamespace(name="Beyoncé"), duration=261, isrc=None)
        self.assertEqual(matching.same_recording(row, trk("Halo", artist="Beyonce", duration=261)), "sure")
        self.assertEqual(matching.same_recording({}, {}), "no")

    def test_match_key_groups_in_one_pass(self):
        a = trk("Beyoncé", artist="Beyoncé")
        b = trk("BEYONCE (Remastered 2011)", artist="beyonce")
        self.assertEqual(matching.match_key(a), matching.match_key(b))
        self.assertNotEqual(matching.match_key(a), matching.match_key(trk("Beyoncé (Remix)", artist="Beyoncé")))
        self.assertNotEqual(matching.match_key(a), matching.match_key(trk("Beyoncé", artist="Other")))
        with_isrc = trk("x", isrc="FRZ031200001")
        self.assertEqual(matching.match_key(with_isrc), matching.match_key(trk("y", artist="z", isrc="frz031200001")))


class MovedWithoutChange(unittest.TestCase):
    def test_old_import_sites_see_the_same_objects(self):
        from supysonic.webui import availability, playlist_import

        for name in ("match_score", "closeness", "_core_title", "_fold", "_artist_names", "PLAUSIBLE"):
            self.assertIs(getattr(availability, name), getattr(matching, name), name)
        self.assertIs(playlist_import.PLAUSIBLE, matching.PLAUSIBLE)
        self.assertEqual(matching.PLAUSIBLE, 0.8)

    def test_cut_label_rule_unchanged(self):
        dead = SimpleNamespace(title="Alors on danse", artist=SimpleNamespace(name="Stromae"), duration=207)
        yt = {"title": "Alors on danse (Radio Edit)", "artists": [{"name": "Stromae"}], "duration": 207}
        self.assertIsNotNone(matching.match_score(dead, yt))
        self.assertIsNone(matching.match_score(dead, {**yt, "title": "Alors on danse (Remix)"}))


if __name__ == "__main__":
    unittest.main()

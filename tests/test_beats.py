# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The server's beat tracker (supysonic/deezer/beats.py, Mixxx's analyser
ported) and what analysis.py serves from it.

The signal tests run the real ffmpeg on lavfi-generated material whose answer
is physics — a kick every 60/128 s is 128 BPM — and hold the tracker to the
hundredth, which the envelope estimator it replaced never was (it read 154
for 150). The rest pins the pure parts (Mixxx's constant-tempo pass, the
reconciliation with Deezer's figure) on numbers worked out by hand. Every
measured value is written next to its assertion.

Needs numpy and ffmpeg; the CI image job has both, and NS_REQUIRE_FFMPEG=1
turns a missing ffmpeg into a failure there.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

try:
    import numpy  # noqa: F401

    HAVE_NUMPY = True
except Exception:  # pragma: no cover
    HAVE_NUMPY = False

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
if not HAVE_FFMPEG and os.environ.get("NS_REQUIRE_FFMPEG") == "1":  # pragma: no cover
    raise RuntimeError("NS_REQUIRE_FFMPEG=1 but ffmpeg is not on PATH")


def _kick_expr(bpm, amp=0.8, tail=0.0):
    p = 60.0 / bpm
    body = f"exp(-9*mod(t\\,{p}))" if not tail else f"({tail}+{1 - tail:.2f}*exp(-14*mod(t\\,{p})))"
    return f"{amp}*sin(2*PI*(45+160*exp(-35*mod(t\\,{p})))*mod(t\\,{p}))*{body}"


@unittest.skipUnless(HAVE_NUMPY and HAVE_FFMPEG, "needs numpy and ffmpeg")
class TrackerTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def file(self, name, expr, seconds=40):
        path = os.path.join(self.dir, name + ".flac")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi",
             "-i", f"aevalsrc='{expr}':s=44100:d={seconds}", "-c:a", "flac", path],
            check=True, timeout=60,
        )
        return path

    def test_a_kick_reads_at_its_exact_tempo(self):
        from supysonic.deezer import beats

        # Measured 90.0 / 128.0 / 150.0 / 174.0 exactly, coverage 0.90-0.98.
        # The envelope estimator read these to the nearest whole BPM at best.
        for bpm in (90, 128, 150, 174):
            with self.subTest(bpm=bpm):
                r = beats.analyse(self.file(f"k{bpm}", _kick_expr(bpm)))
                self.assertAlmostEqual(r["bpm"], bpm, delta=0.05)
                self.assertGreater(r["confidence"], 0.8)

    def test_a_tempo_between_whole_numbers_is_kept(self):
        # 140.5 is not a whole BPM: Mixxx's rounding only snaps to a simpler
        # value that the measurement's own error bars allow. Measured 140.5.
        from supysonic.deezer import beats

        r = beats.analyse(self.file("k1405", _kick_expr(140.5), seconds=60))
        self.assertAlmostEqual(r["bpm"], 140.5, delta=0.05)

    def test_hardcore_is_not_read_at_half_tempo(self):
        """The Rayleigh weighting centres on 120 BPM, so a 200 BPM kick is
        tracked on every other beat (Mixxx's own hardcore failure); the half
        beats striking as hard as the beats doubles it back. Measured 200.0,
        doubled; a limitered tail (-2.5 dB) changes nothing."""
        from supysonic.deezer import beats

        for name, expr in (("fc", _kick_expr(200)), ("fcl", _kick_expr(200, 0.9, 0.75))):
            with self.subTest(name):
                r = beats.analyse(self.file(name, expr))
                self.assertAlmostEqual(r["bpm"], 200, delta=0.05)

    def test_an_offbeat_stab_does_not_double_the_tempo(self):
        """Hard house's donk: a 300 Hz stab on every offbeat, as loud as the
        kick. The tracker's phase may sit on the donk, the kicks then read 13.7
        times the 'beats' in the bass — that is not a doubled tempo (DOUBLE_MAX).
        Measured 128.0."""
        from supysonic.deezer import beats

        p = 60.0 / 128
        donk = f"0.5*sin(2*PI*300*t)*exp(-25*mod(t+{p / 2}\\,{p}))"
        r = beats.analyse(self.file("donk", _kick_expr(128, 0.5) + "+" + donk))
        self.assertAlmostEqual(r["bpm"], 128, delta=0.05)
        self.assertFalse(r["doubled"])

    def test_the_server_serves_no_tempo_for_a_pad(self):
        """Three detuned saws beating against each other: the bass band rises
        84 times a minute (the attack gate lets it through) but no onset lands
        where a beat would. Salience measured 1.01 against a floor of 1.12; a
        kick reads 3+."""
        from supysonic.deezer import analysis as ana

        pad = "0.3*(2*mod(110*t\\,1)-1)+0.3*(2*mod(110.7*t\\,1)-1)+0.3*(2*mod(109.4*t\\,1)-1)"
        self.assertEqual(ana._measure_tempo(self.file("pad", pad, 30)), (None, 0.0, 0.0))
        bpm, conf, _grid = ana._measure_tempo(self.file("k", _kick_expr(128)))
        self.assertEqual(bpm, 128.0)

    def test_without_numpy_the_envelope_estimator_still_answers(self):
        from supysonic.deezer import analysis as ana
        from supysonic.deezer import beats

        path = self.file("k", _kick_expr(128))
        saved = beats.np
        beats.np = None
        try:
            self.assertFalse(beats.available())
            bpm, _conf, _grid = ana._measure_tempo(path)
        finally:
            beats.np = saved
        # The old estimator: within a BPM, as it always was.
        self.assertAlmostEqual(bpm, 128, delta=1.0)


@unittest.skipUnless(HAVE_NUMPY, "needs numpy")
class ConstantTempoTestCase(unittest.TestCase):
    """Mixxx's BeatUtils on beat lists built by hand."""

    def test_a_jittered_click_comes_out_exact(self):
        # 120 BPM at 44.1 kHz with the QM tracker's own ±256-sample quantisation.
        from supysonic.deezer import beats

        sr = 44100
        period = 60 * sr / 120
        jitter = [0, 256, -256, 128, -128, 0, 256, -256]
        b = [i * period + jitter[i % len(jitter)] for i in range(200)]
        bpm, covered = beats.const_bpm(beats.const_regions(b, sr), sr)
        self.assertEqual(bpm, 120.0)
        self.assertGreater(covered, 0.99)

    def test_a_beatless_bridge_does_not_move_the_tempo(self):
        # 64 beats, a stretch where the beats float off the grid, 64 more on the
        # SAME grid: the tempo is the grid's, and the regions either side
        # are joined across the bridge.
        from supysonic.deezer import beats

        sr = 44100
        period = 60 * sr / 128
        b = [i * period for i in range(64)]
        b += [64 * period + k * period * 1.13 for k in range(1, 12)]
        b += [(96 + i) * period for i in range(64)]
        bpm, _covered = beats.const_bpm(beats.const_regions(b, sr), sr)
        self.assertEqual(bpm, 128.0)

    def test_rounding_takes_the_simplest_value_the_error_allows(self):
        from supysonic.deezer import beats

        self.assertEqual(beats.round_bpm(127.9, 128.04, 128.2), 128.0)
        # No whole BPM inside: halves are only tried under 85 BPM...
        self.assertEqual(beats.round_bpm(80.4, 80.52, 80.6), 80.5)
        # ...and above it a third, then a twelfth — even when a half would also
        # fit, as here (140.5 and 140.33 are both inside).
        self.assertAlmostEqual(beats.round_bpm(140.30, 140.33, 140.36), 140 + 1 / 3)
        self.assertAlmostEqual(beats.round_bpm(140.30, 140.42, 140.55), 140 + 1 / 3)
        # Nothing simple inside the range: the measurement itself.
        self.assertEqual(beats.round_bpm(140.01, 140.02, 140.03), 140.02)


class ReconcileTestCase(unittest.TestCase):
    """The tracker's tempo against Deezer's figure (analysis._reconcile_tracked)."""

    def r(self, published, measured, conf=0.9, alternation=None):
        from supysonic.deezer import analysis as ana

        return ana._reconcile_tracked(published, measured, conf, alternation)

    def test_the_tracker_is_the_tempo(self):
        self.assertEqual(self.r(None, 150.0)[::2], (150.0, "measured"))
        # Deezer rounded: the tracker's figure is served.
        self.assertEqual(self.r(150.4, 150.0)[0], 150.0)

    def test_deezer_at_twice_moves_the_octave_up(self):
        # dnb tracked at 87, Deezer 174: the signal cannot tell, Deezer can.
        bpm, _conf, src = self.r(174.0, 87.0)
        self.assertEqual((bpm, src), (174.0, "measured+octave"))

    def test_deezer_at_half_is_its_hardcore_listing(self):
        # Frenchcore at 200 that Deezer lists at 100, every beat a kick.
        self.assertEqual(self.r(100.0, 200.0, alternation=0.95)[0], 200.0)

    def test_deezer_at_half_and_a_half_time_groove_halve(self):
        # A one-drop tracked at double time: alternate beats unequal (0.21
        # measured) AND Deezer at half — both witnesses agree.
        self.assertEqual(self.r(76.0, 152.0, alternation=0.21)[0], 76.0)
        # One witness is not enough.
        self.assertEqual(self.r(76.0, 152.0, alternation=None)[0], 152.0)

    def test_any_other_disagreement_follows_confidence(self):
        self.assertEqual(self.r(117.0, 175.0, conf=0.9)[0], 175.0)
        bpm, conf, src = self.r(117.0, 175.0, conf=0.2)
        self.assertEqual((bpm, src), (117.0, "deezer"))


if __name__ == "__main__":
    unittest.main()

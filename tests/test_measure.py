# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""deezer/measure.py (the numpy twin) against ffmpeg and against the Rust crate.

WIP groundwork for analysing on the client PC (docs/claude/client-analysis.md).
Pins what is KNOWN to match ffmpeg's aspectralstats — centroid, spread, rolloff,
flux — and the Rust crate against the twin. Flatness and entropy are NOT pinned to
ffmpeg: they are the open calibration problem, and a test asserting otherwise
would be asserting something false."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

import numpy as np

from supysonic.deezer import analysis as ana
from supysonic.deezer import measure as M

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUST = os.path.join(ROOT, "webapp", "measure", "target", "release", "examples", "measure")
RATE = 44100


def _signal(seconds=8, seed=5):
    rng = np.random.default_rng(seed)
    n = RATE * seconds
    t = np.arange(n) / RATE
    x = 0.25 * np.sin(2 * np.pi * 330 * t) + 0.12 * np.sin(2 * np.pi * 4100 * t) * (np.sin(2 * np.pi * 3 * t) > 0)
    x += 0.04 * rng.standard_normal(n)
    for k in range(int(seconds * 2)):
        s = int(k * 0.5 * RATE)
        m = np.arange(int(0.15 * RATE))
        x[s:s + len(m)] += 0.7 * np.sin(2 * np.pi * (55 + 90 * np.exp(-m / 900)) * m / RATE) * np.exp(-m / 3000)
    return np.clip(x, -1, 1).astype(np.float32)


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class AgainstFfmpegTestCase(unittest.TestCase):
    def test_the_descriptors_we_can_reproduce_match_aspectralstats(self):
        x = _signal()
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "s.wav")
            import wave

            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes((x * 32767).astype("<i2").tobytes())
            ref = ana._spectral(path)
            # compare on what ffmpeg actually read: the 16-bit file
            back = np.frombuffer(open(path, "rb").read()[44:], "<i2").astype(np.float32) / 32768.0
            mine = M.measure([back], RATE)
        finally:
            shutil.rmtree(d, ignore_errors=True)
        for key, tol in (("centroid", 0.002), ("spread", 0.002), ("rolloff", 0.002), ("flux_peak", 0.01)):
            self.assertAlmostEqual(mine[key] / ref[key], 1.0, delta=tol, msg=key)

    def test_the_known_mismatch_is_documented_not_hidden(self):
        # entropy / flatness are the calibrated stand-ins; this fails the day someone
        # claims otherwise without redoing client-analysis.md.
        self.assertEqual(M.ENTROPY_FIT, (1.0, 0.0))
        self.assertIn("could not reproduce", M.__doc__)


@unittest.skipUnless(os.path.exists(RUST), "native build of webapp/measure not present")
class RustAgainstTwinTestCase(unittest.TestCase):
    def test_rust_and_numpy_agree(self):
        x = _signal(6)
        out = subprocess.run([RUST, str(RATE), "1"], input=x.tobytes(), capture_output=True, check=True).stdout
        rs = json.loads(out)
        py = M.measure([x], RATE)
        for key in ("centroid", "spread", "rolloff", "flux_peak", "entropy"):
            self.assertAlmostEqual(rs[key] / py[key], 1.0, delta=1e-4, msg=key)
        self.assertEqual(rs["frames"], py["frames"])
        # float32 vs float64 windowing moves the noise-floor-bound flatness slightly
        self.assertAlmostEqual(rs["flatness"] / py["flatness"], 1.0, delta=0.05)


if __name__ == "__main__":
    unittest.main()

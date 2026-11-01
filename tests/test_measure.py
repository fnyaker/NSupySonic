# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""deezer/measure.py (the numpy twin) against ffmpeg and against the Rust crate.

WIP groundwork for analysing on the client PC (docs/agents/analysis-genre.md).
Pins what matches ffmpeg's aspectralstats — centroid, spread, rolloff, flux, entropy
(its exact formula) and flatness (on a full-band signal) — and the Rust crate against
the twin. Flatness on band-limited LOSSY files is the one known difference."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest

try:
    import numpy as np

    from supysonic.deezer import measure as M

    HAVE_NUMPY = True
except Exception:  # pragma: no cover - the minimal environment has no numpy
    HAVE_NUMPY = False

from supysonic.deezer import analysis as ana

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUST = os.path.join(ROOT, "webapp", "measure", "target", "release", "examples", "measure")
RUST_TEMPO = os.path.join(ROOT, "webapp", "measure", "target", "release", "examples", "tempo")
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


@unittest.skipUnless(HAVE_NUMPY and shutil.which("ffmpeg"), "needs numpy and ffmpeg")
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
        for key, tol in (("centroid", 0.002), ("spread", 0.002), ("rolloff", 0.002), ("flux_peak", 0.01),
                         ("entropy", 0.002), ("flatness", 0.02)):
            self.assertAlmostEqual(mine[key] / ref[key], 1.0, delta=tol, msg=key)


@unittest.skipUnless(HAVE_NUMPY and os.path.exists(RUST), "needs numpy and a native build of webapp/measure")
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


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class ProbeTestCase(unittest.TestCase):
    """The image ships ffmpeg alone: the rate and channel count are read from its banner."""

    def _make(self, d, name, rate, layout, codec_args=()):
        path = os.path.join(d, name)
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={rate}:duration=1",
             "-ac", str(layout), *codec_args, path], check=True)
        return path

    def test_rate_and_channels_without_ffprobe(self):
        d = tempfile.mkdtemp()
        try:
            for name, rate, ch, extra in (
                ("a.flac", 44100, 2, ()), ("b.flac", 48000, 1, ()),
                ("c.wav", 22050, 2, ()), ("d.mp3", 44100, 2, ("-b:a", "128k")),
            ):
                self.assertEqual(ana.probe_audio(self._make(d, name, rate, ch, extra)), (rate, ch), name)
            with open(os.path.join(d, "x.flac"), "wb") as fp:
                fp.write(b"not audio")
            with self.assertRaises(ValueError):
                ana.probe_audio(os.path.join(d, "x.flac"))
        finally:
            shutil.rmtree(d, ignore_errors=True)


def _kick(bpm):
    p = 60.0 / bpm
    return (f"0.8*sin(2*PI*(45+160*exp(-35*mod(t\\,{p})))*mod(t\\,{p}))*exp(-9*mod(t\\,{p}))")


@unittest.skipUnless(HAVE_NUMPY and shutil.which("ffmpeg") and os.path.exists(RUST_TEMPO),
                     "needs numpy, ffmpeg and a native build of webapp/measure (examples/tempo)")
class RustTempoTestCase(unittest.TestCase):
    """The Rust beat tracker against supysonic/deezer/beats.py: the tempo the client
    measures is the tempo the server serves, beat for beat."""

    def test_the_same_tempo_and_the_same_beats_as_the_server(self):
        from supysonic.deezer import beats

        d = tempfile.mkdtemp()
        try:
            for bpm in (132, 150, 200):
                path = os.path.join(d, f"k{bpm}.wav")
                subprocess.run(
                    ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                     f"aevalsrc='{_kick(bpm)}':s=44100:d=30", "-ac", "1", path], check=True)
                py = beats.analyse(path)
                raw = subprocess.run(
                    ["ffmpeg", "-v", "0", "-i", path, "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "-"],
                    capture_output=True, check=True).stdout
                rs = json.loads(subprocess.run([RUST_TEMPO], input=raw, capture_output=True, check=True).stdout)
                self.assertIsNotNone(py, bpm)
                self.assertAlmostEqual(rs["bpm"], py["bpm"], delta=0.01, msg=bpm)
                self.assertEqual(rs["doubled"], py["doubled"], bpm)
                self.assertEqual(len(rs["beats"]), len(py["beats"]), bpm)
                same = sum(abs(a - b) < 2e-4 for a, b in zip(rs["beats"], py["beats"]))
                self.assertGreaterEqual(same / len(py["beats"]), 0.98, bpm)
        finally:
            shutil.rmtree(d, ignore_errors=True)

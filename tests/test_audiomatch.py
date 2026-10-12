"""The auto-match's audio comparison, held to MEASURED numbers on real ffmpeg.

An unavailable track is replaced without asking when its Deezer preview and a
candidate score >= 0.99, so what that number separates has to be shown here,
on audio made the way a record is made: an arranged piece (a melody walking a
scale on the off-beat eighths, a bass line moving per bar, a pitched kick
sweeping down on every beat, a noise hat on the off-beat), a "preview" cut from
it the way Deezer cuts one (30 s from inside the track, faded in and out, MP3
128), and the candidates a search really returns: the same master in another
codec or at another level, a remaster, a version at another tempo, the
instrumental, a re-performance, another song.

Measured when this was written (sample-aligned, 40 dB floor):
same master FLAC 0.9999, Opus 128 0.9991, -6 dB 0.9999, remaster 0.9922,
re-performed (timing drifting 10 ms) 0.9805, instrumental 0.742,
3 % faster 0.425, another song 0.368.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

from supysonic.deezer import audiomatch as am

HAVE = am.available()
if not HAVE and os.environ.get("NS_REQUIRE_FFMPEG") == "1":  # pragma: no cover
    # The CI job that installs ffmpeg also installs numpy: a skip there would
    # be the suite testing less than it claims.
    raise RuntimeError("NS_REQUIRE_FFMPEG=1 but numpy or ffmpeg is missing")


def _song(step=7, melody=1.0, rate=1.0, jitter=0.0, bpm=124, seconds=62):
    beat = 60.0 / bpm
    t = f"(t*{rate}+{jitter}*sin(t*0.7))"
    note = f"220*pow(2,mod(floor({t}/{beat / 2})*{step},12)/12)"
    expr = (
        f"{melody}*0.25*sin(2*PI*{note}*{t})*(0.6+0.4*sin(2*PI*{t}/{beat * 8}))"
        f"+0.3*sin(2*PI*55*pow(2,mod(floor({t}/{beat * 4})*5,7)/12)*{t})"
        f"+0.6*sin(2*PI*(50+120*exp(-mod({t},{beat})*25))*mod({t},{beat}))*exp(-mod({t},{beat})*9)"
        f"+0.12*(random(0)*2-1)*exp(-mod({t}+{beat / 2},{beat})*40)"
    )
    return f"aevalsrc='{expr}':s=44100:d={seconds}"


class _Material(unittest.TestCase):
    # Each distinct performance is rendered ONCE (aevalsrc is the slow part,
    # ~2.5 s apiece), all at the same time; every encoding of a master is then
    # cut from that master's file.
    SONGS = {
        "master": _song(),
        "live": _song(jitter=0.01),
        "instrumental": _song(melody=0.0),
        "faster": _song(rate=1.03),
        "other": _song(step=5, bpm=128),
        "short": _song(seconds=8),
    }

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="ns-audiomatch-")
        cls.files = {}
        procs = []
        for name, src in cls.SONGS.items():
            path = os.path.join(cls.dir, name + ".flac")
            cls.files[name] = path
            procs.append(subprocess.Popen(
                ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", src, "-c:a", "flac", "-y", path]
            ))
        for p in procs:
            if p.wait() != 0:
                raise RuntimeError("ffmpeg could not render the test material")
        cls.ref = am.decode(cls._encode(
            "preview",
            ["-af", "atrim=20:50,asetpts=PTS-STARTPTS,afade=t=in:d=1,afade=t=out:st=29:d=1"],
            ("-c:a", "libmp3lame", "-b:a", "128k"), "mp3",
        ))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    @classmethod
    def _encode(cls, name, extra=(), codec=("-c:a", "flac"), ext="flac", source="master"):
        path = os.path.join(cls.dir, f"{name}.{ext}")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", cls.files[source], *extra, *codec, "-y", path],
            check=True,
        )
        return path

    def _score(self, path):
        return am.match(self.ref, am.decode(path))


@unittest.skipUnless(HAVE, "needs numpy and ffmpeg")
class AudioMatchTestCase(_Material):

    def test_the_same_master_matches_in_any_codec_and_at_any_level(self):
        for name, extra, codec, ext in (
            ("flac", (), ("-c:a", "flac"), "flac"),  # measured 0.9999
            ("opus", (), ("-c:a", "libopus", "-b:a", "128k"), "ogg"),  # YouTube: 0.9991
            ("quiet", ("-af", "volume=-6dB"), ("-c:a", "flac"), "flac"),  # 0.9999
        ):
            with self.subTest(name):
                score, offset, overlap = self._score(self._encode(name, extra, codec, ext))
                self.assertGreaterEqual(score, am.THRESHOLD)
                # Found where the preview was cut from: 20 s + the 1.5 s trimmed.
                self.assertAlmostEqual(offset, 21.5, delta=0.05)
                self.assertGreater(overlap, 25)

    def test_a_remaster_of_the_same_performance_matches(self):
        score, _, _ = self._score(
            self._encode("remaster", ["-af", "treble=g=4,acompressor=threshold=0.2:ratio=4"])
        )
        self.assertGreaterEqual(score, am.THRESHOLD)  # measured 0.9922

    def test_another_performance_never_matches(self):
        for name, ceiling in (
            ("live", 0.985),  # measured 0.9805
            ("instrumental", 0.8),  # 0.742
            ("faster", 0.6),  # 0.425
            ("other", 0.6),  # 0.368
        ):
            with self.subTest(name):
                score, _, _ = self._score(self.files[name])
                self.assertLess(score, ceiling)
                self.assertLess(score, am.THRESHOLD)

    def test_a_candidate_too_short_to_overlap_decides_nothing(self):
        score, _, overlap = self._score(self.files["short"])
        self.assertEqual((score, overlap), (0.0, 0.0))

    def test_audio_streamed_in_pieces_reads_the_same_as_the_file(self):
        """Deezer candidates are compared from their decrypted stream, fed to
        ffmpeg in whatever pieces the network delivers."""
        path = self.files["master"]
        with open(path, "rb") as fh:
            data = fh.read()
        pieces = (data[i:i + 3001] for i in range(0, len(data), 3001))
        streamed = am.decode(chunks=pieces)
        self.assertEqual(streamed.size, am.decode(path).size)
        self.assertGreaterEqual(am.match(self.ref, streamed)[0], am.THRESHOLD)

    def test_silence_is_refused_rather_than_compared(self):
        path = os.path.join(self.dir, "silence.flac")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                        "anullsrc=r=44100:cl=mono:d=0.3", "-y", path], check=True)
        with self.assertRaises(am.MatchError):
            am.decode(path)


class _Resp:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def iter_content(self, n):
        for i in range(0, len(self.data), n):
            yield self.data[i:i + n]

    def close(self):
        pass


class _FakeDeezer:
    """What decide() asks of the provider, answering from real audio files."""

    def __init__(self, archive_dir, previews, streams, results, dead_preview=True):
        from types import SimpleNamespace as NS

        self.archive_dir = archive_dir
        self.calls = []
        self._previews, self._streams = previews, streams

        def get_track(sid):
            self.calls.append(("track", str(sid)))
            if not dead_preview:
                return {"id": int(sid), "preview": ""}
            return {"id": int(sid), "preview": f"https://cdnt-preview.dzcdn.net/{sid}.mp3"}

        def search(query, limit=25):
            self.calls.append(("search", query))
            return {"data": results}

        def get(url, stream=False):
            self.calls.append(("get", url))
            sid = url.rsplit("/", 1)[1].split(".")[0]
            with open(self._previews[sid], "rb") as fh:
                return _Resp(fh.read())

        self.dz = NS(api=NS(get_track=get_track, search=search, session=NS(get=get)))

    def resolve(self, sid, quality=None):
        self.calls.append(("resolve", str(sid)))
        return f"https://stream/{sid}", "FLAC", {}, str(sid)

    def iter_decrypted(self, url, used):
        with open(self._streams[used], "rb") as fh:
            data = fh.read()
        for i in range(0, len(data), 4096):
            yield data[i:i + 4096]


@unittest.skipUnless(HAVE, "needs numpy and ffmpeg")
class DecideTestCase(_Material):
    """decide(): the reference, the candidates' order, and what is never heard."""

    SONGS = {"master": _song(), "other": _song(step=5, bpm=128)}

    def setUp(self):
        from types import SimpleNamespace as NS
        from supysonic.deezer import automatch

        self.automatch = automatch
        self.archive = tempfile.mkdtemp(prefix="ns-am-archive-")
        self.addCleanup(shutil.rmtree, self.archive, True)
        self._orig_local = automatch.local_candidates
        automatch.local_candidates = lambda track: []
        self.addCleanup(setattr, automatch, "local_candidates", self._orig_local)
        self.track = NS(id=1, deezer_id="900", title="Song (Remastered 2011)",
                        artist=NS(name="The Band"), duration=62)
        mp3 = ("-c:a", "libmp3lame", "-b:a", "128k")
        self.previews = {
            "900": self._encode("dead-preview", ["-af", "atrim=20:50,asetpts=PTS-STARTPTS,afade=t=in:d=1,afade=t=out:st=29:d=1"], mp3, "mp3"),
            # The same master's own preview, cut from ELSEWHERE: no overlap, so
            # the preview cannot decide and the full stream must.
            "501": self._encode("other-cut", ["-af", "atrim=0:12,asetpts=PTS-STARTPTS"], mp3, "mp3"),
            "502": self._encode("decoy-preview", ["-af", "atrim=20:50,asetpts=PTS-STARTPTS"], mp3, "mp3", source="other"),
        }
        self.streams = {"501": self.files["master"], "502": self.files["other"]}

    def _hit(self, sid, title="Song", artist="The Band", duration=62):
        return {"id": int(sid), "title": title, "duration": duration,
                "artist": {"name": artist}, "album": {"title": "Album"},
                "preview": f"https://cdnt-preview.dzcdn.net/{sid}.mp3"}

    def test_the_same_recording_is_found_by_ear_and_a_decoy_is_not(self):
        search = [
            self._hit("502", duration=62),             # same title, another song: heard first
            self._hit("501", duration=63),             # the same master
            self._hit("503", artist="A Cover Band"),   # another artist: never heard
        ]
        dz = _FakeDeezer(self.archive, self.previews, self.streams, search)
        v = self.automatch.decide(dz, self.track, self.archive)
        self.assertEqual(v.status, "match", v.tried)
        self.assertEqual(v.best.id, "501")
        self.assertGreaterEqual(v.score, 0.99)
        labels = [label for label, _ in v.tried]
        self.assertEqual(labels[0], "deezer:502")
        self.assertLess(v.tried[0][1], 0.99)  # the decoy, heard and refused
        self.assertNotIn(("resolve", "503"), dz.calls)
        self.assertNotIn("deezer:503", labels)
        # 501's preview did not overlap, so its stream was what decided.
        self.assertIn(("resolve", "501"), dz.calls)
        # Nothing is left behind in the archive.
        staging = os.path.join(self.archive, self.automatch.STAGING_DIR)
        self.assertEqual(os.listdir(staging), [])

    def test_without_a_preview_nothing_is_heard(self):
        dz = _FakeDeezer(self.archive, self.previews, self.streams, [self._hit("501")],
                         dead_preview=False)
        v = self.automatch.decide(dz, self.track, self.archive)
        self.assertEqual(v.status, "no_reference")
        self.assertIn("no preview", v.reason)
        self.assertEqual([c[0] for c in dz.calls], ["track"])  # no search, no download

    def test_only_deezer_answering_can_end_in_a_verdict(self):
        from deezerpy.errors import DeezerUnavailable

        dz = _FakeDeezer(self.archive, self.previews, self.streams, [])

        def down(sid):
            raise DeezerUnavailable("api.deezer.com is not answering")

        dz.dz.api.get_track = down
        with self.assertRaises(DeezerUnavailable):
            self.automatch.decide(dz, self.track, self.archive)

    def test_a_preview_url_off_deezers_cdn_is_never_fetched(self):
        from supysonic.deezer.automatch import _preview_url_ok

        self.assertTrue(_preview_url_ok("https://cdnt-preview.dzcdn.net/a.mp3"))
        for url in ("http://cdnt-preview.dzcdn.net/a.mp3", "https://dzcdn.net.evil.com/a",
                    "https://127.0.0.1/a.mp3", "file:///etc/passwd", "https://evil.com/dzcdn.net"):
            self.assertFalse(_preview_url_ok(url), url)

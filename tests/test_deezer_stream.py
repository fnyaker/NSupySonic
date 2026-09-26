# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The audio path: from Deezer's encrypted bytes to an archive that plays forever.

Every Deezer track anybody hears goes through three functions that no test used
to run: ``provider.blowfish_key``, ``provider.iter_decrypted`` (every third
2048-byte chunk of the stream is Blowfish-CBC) and ``archive.open_live_stream``,
the tee that plays a cold track while it downloads and keeps it. The tests that
archived a track replaced the download with a function writing 4096 zero bytes —
which the archive then accepted as a FLAC, failed to tag, and kept for good.

So these run the real code over a real HTTP connection, against a local stand-in
for the CDN that delivers a body the way a network does: in pieces that line up
with nothing, sometimes cut short. What they check is what a listener gets (the
original audio, byte for byte, as it arrives) and what the archive keeps (that
audio, tagged, or nothing at all).
"""

import hashlib
import http.server
import os
import random
import shutil
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import mutagen.flac
import mutagen.id3
import requests
from Crypto.Cipher import Blowfish

from deezerpy import new_session
from deezerpy._circuit import breaker

from supysonic.db import Track
from supysonic.deezer import archive, ids, library
from supysonic.deezer import provider as provider_mod
from supysonic.deezer.provider import DeezerError, DeezerProvider, blowfish_key

from .testbase import TestBase

ASSETS = Path(__file__).parent / "assets"
FLAC = (ASSETS / "formats" / "silence.flac").read_bytes()
MP3 = (ASSETS / "formats" / "silence.mp3").read_bytes()
COVER = (ASSETS / "cover.jpg").read_bytes()

# Deezer's scheme, pinned by implementations that share no code with ours. The
# keys come from Node's md5 (key[i] = md5hex[i] ^ md5hex[i + 16] ^ secret[i]);
# the digest from OpenSSL's Blowfish:
#   openssl enc -e -bf-cbc -nopad -K <key of 3135556> -iv 0001020304050607 \
#       -provider legacy -provider default
KEYS = {
    "3135556": "6c6c666b39662c37652575603c643439",
    "1": "3464656e343a7d3a672c236a33696061",
    "916424": "61336f6a33692660317e2764696a3166",
}
IV = b"\x00\x01\x02\x03\x04\x05\x06\x07"
BLOCK = bytes((i * 7 + 3) % 256 for i in range(2048))
BLOCK_ENCRYPTED_SHA256 = "48ceb46f82f435de61a879f2f772c5eff0f380f0bc7399f685ede31f2b9e23c0"


def encrypt_like_deezer(plain: bytes, track_id) -> bytes:
    """What the CDN serves for a track: the 2048-byte blocks at offsets 0, 6144,
    12288... encrypted on their own (the IV starts over each time), everything
    else — including a short last block — in the clear."""
    key = bytes.fromhex(KEYS[str(track_id)])
    out = bytearray()
    for offset in range(0, len(plain), 2048):
        block = plain[offset : offset + 2048]
        if offset % 6144 == 0 and len(block) == 2048:
            block = Blowfish.new(key, Blowfish.MODE_CBC, IV).encrypt(block)
        out += block
    return bytes(out)


def fake_flac(size: int, seed: int = 0) -> bytes:
    """Bytes that open like a FLAC, for sizes the real asset does not have."""
    return b"fLaC" + random.Random(seed).randbytes(size - 4)


class Cdn:
    """A local stand-in for Deezer's CDN.

    Bodies are written in pieces that are never a multiple of 2048, with a
    pause every few so the client really does receive them apart; ``chunked``
    also frames them as HTTP chunks of those sizes. ``*-truncated`` sends two
    thirds and hangs up. ``gated`` sends three blocks, then waits for ``gate``
    before the rest, and records when it did.
    """

    PIECES = (1, 7, 1000, 2047, 3, 2049, 4096, 13, 3001, 511)

    def __init__(self):
        self.bodies = {}
        self.hits = []
        self.gate = threading.Event()
        self.rest_sent = threading.Event()
        cdn = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def handle(self):
                try:
                    super().handle()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the listener left, which is what some tests are about

            def do_GET(self):
                cdn.hits.append(self.path)
                body, mode = cdn.bodies.get(self.path, (None, None))
                if body is None or mode == "forbidden":
                    self.send_response(404 if body is None else 403)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self._send(body, mode)

            def _send(self, body, mode):
                chunked = mode.startswith("chunked")
                truncated = mode.endswith("truncated")
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                if chunked:
                    self.send_header("Transfer-Encoding", "chunked")
                else:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if truncated:
                    body = body[: len(body) * 2 // 3]
                    self.close_connection = True
                head, rest = (body[:6144], body[6144:]) if mode == "gated" else (body, b"")
                self._pieces(head, chunked)
                if mode == "gated":
                    cdn.gate.wait(5)
                    cdn.rest_sent.set()
                    self._pieces(rest, chunked)
                if chunked and not truncated:
                    self.wfile.write(b"0\r\n\r\n")

            def _pieces(self, data, chunked):
                offset = n = 0
                while offset < len(data):
                    piece = data[offset : offset + Cdn.PIECES[n % len(Cdn.PIECES)]]
                    offset += len(piece)
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(piece), piece) if chunked else piece)
                    self.wfile.flush()
                    n += 1
                    if n % 4 == 0:
                        time.sleep(0.001)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def serve(self, name: str, body: bytes, mode: str = "length") -> str:
        path = "/" + name.replace(" ", "-")
        self.bodies[path] = (body, mode)
        return self.base + path

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeGW:
    """The only gateway call an archive makes once the audio is in: lyrics."""

    LYRICS = {
        "LYRICS_TEXT": "Work it harder\nMake it better",
        "LYRICS_SYNC_JSON": [
            {"line": "Work it harder", "milliseconds": "1500"},
            {"line": "Make it better", "milliseconds": "3250"},
        ],
    }

    def get_track_lyrics(self, sng_id):
        return self.LYRICS


def gw_info(sid, **extra):
    """A ``song.getData`` payload, as rich as the one an archive is finalized from."""
    info = {
        "SNG_ID": str(sid),
        "SNG_TITLE": "Harder",
        "VERSION": "(Live)",
        "ART_ID": "27",
        "ART_NAME": "Daft Punk",
        "ALB_ID": "302127",
        "ALB_TITLE": "Alive",
        "ALB_PICTURE": "coverhash",
        "DURATION": "5",
        "TRACK_NUMBER": "4",
        "DISK_NUMBER": "1",
        "PHYSICAL_RELEASE_DATE": "2007-11-19",
        "ISRC": "GBDUW0000059",
        "GAIN": "-8.4",
        "ARTISTS": [
            {"ART_ID": "27", "ART_NAME": "Daft Punk", "ARTISTS_SONGS_ORDER": "0"},
            {"ART_ID": "99", "ART_NAME": "Guest", "ARTISTS_SONGS_ORDER": "1"},
        ],
    }
    info.update(extra)
    return info


class _CdnMixin:
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.cdn = Cdn()
        # The session production uses (timeouts, circuit breaker), minus the
        # environment's proxy settings: the CDN here is on loopback.
        cls.session = new_session()
        cls.session.trust_env = False

    @classmethod
    def tearDownClass(cls):
        cls.session.close()
        cls.cdn.close()
        super().tearDownClass()

    def _provider(self, archive_dir):
        breaker.reset()
        provider = DeezerProvider("dummy-arl", archive_dir, "FLAC")
        provider._dz = types.SimpleNamespace(
            session=self.session, http_headers={"User-Agent": "tests"}, gw=FakeGW()
        )
        return provider

    def _files(self, directory):
        return sorted(
            os.path.relpath(os.path.join(d, f), directory)
            for d, _dirs, files in os.walk(directory)
            for f in files
        )


class KnownAnswerTestCase(unittest.TestCase):
    def test_the_key_is_deezers(self):
        for track_id, key in KEYS.items():
            self.assertEqual(blowfish_key(track_id).hex(), key, track_id)
        # The gateway hands ids over as strings or numbers; the key is the id's.
        self.assertEqual(blowfish_key(3135556), blowfish_key("3135556"))

    def test_the_streams_these_tests_build_are_the_ones_the_cdn_serves(self):
        # The encryption below is what every other test feeds the real code, so
        # it is checked against OpenSSL rather than trusted.
        encrypted = Blowfish.new(bytes.fromhex(KEYS["3135556"]), Blowfish.MODE_CBC, IV).encrypt(BLOCK)
        self.assertEqual(hashlib.sha256(encrypted).hexdigest(), BLOCK_ENCRYPTED_SHA256)
        stream = encrypt_like_deezer(BLOCK * 7, "3135556")
        for index in range(7):
            block = stream[index * 2048 : (index + 1) * 2048]
            self.assertEqual(block == encrypted, index % 3 == 0, index)


class BlocksTestCase(unittest.TestCase):
    """``decrypt_blocks`` on its own: any cut of the body, the same file."""

    def test_the_file_comes_back_whatever_pieces_it_arrives_in(self):
        rng = random.Random(7)
        key = bytes.fromhex(KEYS["3135556"])
        for size in (2048, 3 * 2048 + 5, 7 * 2048, 7 * 2048 + 1999):
            plain = fake_flac(size, seed=size)
            body = encrypt_like_deezer(plain, "3135556")
            for trial in range(100):
                cuts = sorted(rng.sample(range(1, size), rng.randint(0, min(40, size - 1))))
                pieces = [body[a:b] for a, b in zip([0] + cuts, cuts + [size])]
                with self.subTest(size=size, trial=trial):
                    out = list(provider_mod.decrypt_blocks(pieces, key))
                    self.assertEqual(b"".join(out), plain)
                    # Whole blocks until the tail: the first thing handed on is
                    # always the first block, which is what gets checked for audio.
                    self.assertTrue(all(len(o) % 2048 == 0 for o in out[:-1]))
                    self.assertGreaterEqual(len(out[0]), min(size, 2048))

    def test_what_opens_like_audio(self):
        for head in (FLAC[:8], MP3[:8], b"\xff\xfb\x90\x64", b"\xff\xf3\x00", b"ID3\x03"):
            self.assertTrue(provider_mod.looks_like_audio(head), head)
        for head in (b"", b"f", b"<html>", b"\x00\x00\x00\x00", b"\xff\x1f", b"fLa", b"RIFF"):
            self.assertFalse(provider_mod.looks_like_audio(head), head)


class DecryptionTestCase(_CdnMixin, unittest.TestCase):
    """``iter_decrypted`` against the real network stack."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.provider = self._provider(self.dir)

    def _decrypt(self, url, track_id="3135556"):
        return b"".join(self.provider.iter_decrypted(url, track_id))

    def test_it_undoes_the_cdns_encryption_however_the_bytes_arrive(self):
        cases = {
            "the real FLAC": FLAC,
            "one block": fake_flac(2048),
            # Blocks 0, 3 and 6 are encrypted: each starts its own CBC chain.
            "seven blocks": fake_flac(7 * 2048, seed=1),
            # A short block where an encrypted one would be is left alone —
            # 5 bytes cannot even be decrypted, 16 bytes can and must not be.
            "short tail of 5": fake_flac(3 * 2048 + 5, seed=2),
            "short tail of 16": fake_flac(3 * 2048 + 16, seed=3),
        }
        for name, plain in cases.items():
            for mode in ("length", "chunked"):
                with self.subTest(name, mode=mode):
                    url = self.cdn.serve(f"{name}-{mode}", encrypt_like_deezer(plain, "3135556"), mode)
                    self.assertEqual(self._decrypt(url), plain)

    def test_it_hands_audio_on_as_it_arrives(self):
        """The whole point of the live stream: the first second plays while the
        rest is still on its way."""
        self.cdn.gate.clear()
        self.cdn.rest_sent.clear()
        plain = fake_flac(10 * 2048, seed=4)
        url = self.cdn.serve("gated", encrypt_like_deezer(plain, "3135556"), "gated")
        chunks = self.provider.iter_decrypted(url, "3135556")
        first = next(chunks)
        self.assertFalse(self.cdn.rest_sent.is_set(), "the first chunk waited for the whole body")
        self.assertEqual(first, plain[:2048])
        self.cdn.gate.set()
        self.assertEqual(first + b"".join(chunks), plain)

    def test_a_body_cut_short_is_an_error_not_a_shorter_track(self):
        plain = fake_flac(6 * 2048, seed=5)
        for mode in ("length-truncated", "chunked-truncated"):
            with self.subTest(mode):
                url = self.cdn.serve(f"cut-{mode}", encrypt_like_deezer(plain, "3135556"), mode)
                with self.assertRaises(requests.RequestException):
                    self._decrypt(url)

    def test_a_refusal_from_the_cdn_is_an_error(self):
        url = self.cdn.serve("expired", b"x", "forbidden")
        with self.assertRaises(requests.HTTPError):
            self._decrypt(url)

    def test_what_does_not_decrypt_to_audio_is_refused_before_a_byte_is_handed_on(self):
        plain = fake_flac(4 * 2048, seed=6)
        cases = {
            # The key of another track: what a wrong id or a changed scheme yields.
            "wrong key": encrypt_like_deezer(plain, "1"),
            # An error page answered with a 200, short enough to arrive in clear...
            "error page": b"<html><body>403 Forbidden</body></html>",
            # ...or long enough to be "decrypted" into noise.
            "long error page": b"<html>" + b" " * 3000 + b"</html>",
        }
        for name, body in cases.items():
            with self.subTest(name):
                url = self.cdn.serve(f"bad-{name}", body)
                received = []
                with self.assertRaises(DeezerError):
                    for chunk in self.provider.iter_decrypted(url, "3135556"):
                        received.append(chunk)
                self.assertEqual(received, [])

    def test_an_empty_body_is_not_a_track(self):
        url = self.cdn.serve("empty", b"")
        with self.assertRaises(DeezerError):
            self._decrypt(url)


class DownloadToTestCase(_CdnMixin, unittest.TestCase):
    """The background path: ``download_to`` publishes a whole file or nothing."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.provider = self._provider(self.dir)
        self.dest = Path(self.dir, "Artist", "Album", "01 Track.flac")

    def test_it_publishes_the_decrypted_file(self):
        url = self.cdn.serve("dl-ok", encrypt_like_deezer(FLAC, "3135556"), "chunked")
        self.provider.download_to(url, "3135556", self.dest)
        self.assertEqual(self.dest.read_bytes(), FLAC)
        self.assertEqual(self._files(self.dir), [os.path.join("Artist", "Album", "01 Track.flac")])

    def test_a_failed_download_leaves_nothing_behind(self):
        # Nothing else ever removes a stray partial: it would sit in the archive
        # (and in its reported size) for good.
        bad = {
            "cut": (encrypt_like_deezer(FLAC, "3135556"), "length-truncated"),
            "garbage": (encrypt_like_deezer(FLAC, "1"), "length"),
            "empty": (b"", "length"),
            "refused": (b"x", "forbidden"),
        }
        for name, (body, mode) in bad.items():
            with self.subTest(name):
                url = self.cdn.serve(f"dl-{name}", body, mode)
                with self.assertRaises(Exception):
                    self.provider.download_to(url, "3135556", self.dest)
                self.assertEqual(self._files(self.dir), [])

    def test_a_failed_download_keeps_the_previous_archive(self):
        url = self.cdn.serve("dl-first", encrypt_like_deezer(FLAC, "3135556"))
        self.provider.download_to(url, "3135556", self.dest)
        url = self.cdn.serve("dl-cut", encrypt_like_deezer(fake_flac(9000), "3135556"), "chunked-truncated")
        with self.assertRaises(requests.RequestException):
            self.provider.download_to(url, "3135556", self.dest)
        self.assertEqual(self.dest.read_bytes(), FLAC)


class LiveStreamTestCase(_CdnMixin, TestBase):
    """``open_live_stream``: a cold track, played while it downloads."""

    SID = "3135556"

    def setUp(self):
        super().setUp()
        self.archive_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.archive_dir, ignore_errors=True)
        self.provider = self._provider(self.archive_dir)
        self.provider.fetch_cover = lambda md5, size=1000: COVER if md5 == "coverhash" else None
        self.analysed = []
        patcher = mock.patch(
            "supysonic.deezer.analysis.queue_analysis",
            lambda track, provider=None: self.analysed.append(track.id),
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        root = library.get_root_folder(self.archive_dir)
        self.track = library.upsert_track(gw_info(self.SID), root, "FLAC")
        self.aborted = 0

    def _on_abort(self):
        self.aborted += 1

    def _resolve_to(self, url, fmt="FLAC", used_id=None, info=None):
        answer = (url, fmt, info or gw_info(self.SID), used_id or self.SID)
        self.provider.resolve = lambda sng_id, quality=None: answer

    def _open(self):
        return archive.open_live_stream(self.provider, self.track, self._on_abort)

    def _leftovers(self):
        return [f for f in self._files(self.archive_dir) if ".part" in f]

    def test_a_cold_track_plays_while_it_downloads_and_is_kept(self):
        self.cdn.gate.clear()
        self.cdn.rest_sent.clear()
        self._resolve_to(self.cdn.serve("live-ok", encrypt_like_deezer(FLAC, self.SID), "gated"))
        mimetype, stream = self._open()
        self.assertEqual(mimetype, "audio/flac")
        dest = Path(self.track.path)

        first = next(stream)
        self.assertFalse(self.cdn.rest_sent.is_set(), "the listener waited for the whole file")
        self.assertFalse(dest.exists(), "a partial download was published as the archive")
        self.cdn.gate.set()
        heard = first + b"".join(stream)

        # The listener heard the original audio, exactly.
        self.assertEqual(heard, FLAC)
        # And the archive holds that audio, tagged from the gateway payload.
        audio = mutagen.flac.FLAC(dest)
        original = mutagen.flac.FLAC(ASSETS / "formats" / "silence.flac")
        self.assertEqual(audio.info.md5_signature, original.info.md5_signature)
        self.assertEqual(audio.info.total_samples, original.info.total_samples)
        self.assertEqual(audio["title"], ["Harder (Live)"])
        self.assertEqual(audio["artist"], ["Daft Punk", "Guest"])
        self.assertEqual(audio["album"], ["Alive"])
        self.assertEqual(audio["tracknumber"], ["4"])
        self.assertEqual(audio["date"], ["2007-11-19"])
        self.assertEqual(audio["isrc"], ["GBDUW0000059"])
        # Deezer's GAIN is a loudness: the adjustment is -(GAIN + 18.4).
        self.assertEqual(audio["replaygain_track_gain"], ["-10.00 dB"])
        self.assertEqual([p.data for p in audio.pictures], [COVER])
        self.assertEqual(audio["lyrics"], ["Work it harder\nMake it better"])

        # Everything else about it is on disk too, beside the audio.
        folder = dest.parent
        self.assertEqual((folder / "cover.jpg").read_bytes(), COVER)
        lrc = dest.with_suffix(".lrc").read_text(encoding="utf-8")
        self.assertEqual(lrc.splitlines(), ["[00:01.50] Work it harder", "[00:03.25] Make it better"])
        self.assertTrue(os.path.isfile(library.metadata_path(self.track)))
        self.assertEqual(self._leftovers(), [])

        # The row says so, and the analysis was queued for it.
        row = Track[ids.track_uuid(self.SID)]
        self.assertEqual(row.path, str(dest))
        self.assertGreater(row.last_modification, 0)
        self.assertTrue(row.has_art)
        self.assertIsNone(row.unavailable)
        self.assertEqual(row.bitrate, int(os.path.getsize(dest) * 8 / 5 / 1000))
        self.assertEqual(self.analysed, [row.id])
        self.assertEqual(self.aborted, 0)

    def test_a_fallback_is_decrypted_with_the_key_of_the_track_actually_served(self):
        # Deezer substitutes another version (FALLBACK.SNG_ID) for a track it
        # cannot serve; the stream is encrypted for THAT id.
        self._resolve_to(
            self.cdn.serve("live-fallback", encrypt_like_deezer(FLAC, "916424")), used_id="916424"
        )
        _mimetype, stream = self._open()
        self.assertEqual(b"".join(stream), FLAC)
        self.assertEqual(mutagen.flac.FLAC(self.track.path).info.total_samples, 214272)

    def test_an_mp3_when_there_is_no_flac(self):
        self._resolve_to(self.cdn.serve("live-mp3", encrypt_like_deezer(MP3, self.SID)), fmt="MP3_320")
        mimetype, stream = self._open()
        self.assertEqual(mimetype, "audio/mpeg")
        self.assertEqual(b"".join(stream), MP3)
        self.assertTrue(self.track.path.endswith(".mp3"))
        tags = mutagen.id3.ID3(self.track.path)
        self.assertEqual(tags["TIT2"].text, ["Harder (Live)"])
        self.assertEqual(tags["TPE1"].text, ["Daft Punk", "Guest"])
        self.assertEqual(tags.getall("APIC")[0].data, COVER)
        self.assertEqual(tags.getall("USLT")[0].text, "Work it harder\nMake it better")
        self.assertEqual(Track[ids.track_uuid(self.SID)].path, self.track.path)

    def test_a_listener_who_leaves_early_leaves_no_archive_and_it_is_fetched_again(self):
        self._resolve_to(self.cdn.serve("live-leave", encrypt_like_deezer(FLAC, self.SID), "chunked"))
        _mimetype, stream = self._open()
        next(stream)
        stream.close()  # what the WSGI server does when the client hangs up
        self.assertFalse(os.path.exists(self.track.path))
        self.assertEqual(self._leftovers(), [])
        self.assertEqual(self.aborted, 1)
        self.assertEqual(Track[ids.track_uuid(self.SID)].last_modification, 0)
        self.assertEqual(self.analysed, [])

    def test_a_download_that_breaks_off_is_never_kept(self):
        self._resolve_to(self.cdn.serve("live-cut", encrypt_like_deezer(FLAC, self.SID), "length-truncated"))
        _mimetype, stream = self._open()
        with self.assertRaises(requests.RequestException):
            b"".join(stream)
        self.assertFalse(os.path.exists(self.track.path))
        self.assertEqual(self._leftovers(), [])
        self.assertEqual(self.aborted, 1)
        self.assertEqual(Track[ids.track_uuid(self.SID)].last_modification, 0)

    def test_a_stream_that_is_not_audio_is_neither_played_nor_kept(self):
        self._resolve_to(self.cdn.serve("live-garbage", encrypt_like_deezer(FLAC, "1")))
        _mimetype, stream = self._open()
        heard = []
        with self.assertRaises(DeezerError):
            for chunk in stream:
                heard.append(chunk)
        self.assertEqual(heard, [])
        self.assertFalse(os.path.exists(self.track.path))
        self.assertEqual(self._leftovers(), [])
        self.assertEqual(Track[ids.track_uuid(self.SID)].last_modification, 0)

    def test_a_track_archived_meanwhile_is_played_from_disk(self):
        url = self.cdn.serve("live-meanwhile", encrypt_like_deezer(FLAC, self.SID))
        self._resolve_to(url)
        _mimetype, stream = self._open()
        # Another worker finished it between the resolve and the first read.
        Path(self.track.path).parent.mkdir(parents=True, exist_ok=True)
        Path(self.track.path).write_bytes(FLAC)
        self.assertEqual(b"".join(stream), FLAC)
        self.assertNotIn("/live-meanwhile", self.cdn.hits)

    def test_when_another_download_publishes_first_the_stream_steps_aside(self):
        self._resolve_to(self.cdn.serve("live-race", encrypt_like_deezer(FLAC, self.SID), "chunked"))
        _mimetype, stream = self._open()
        heard = next(stream)
        # The background archiver publishes (and finalizes) while we play.
        other = b"fLaC" + b"the background archiver's copy"
        Path(self.track.path).write_bytes(other)
        heard += b"".join(stream)
        self.assertEqual(heard, FLAC)  # the listener still heard the whole track...
        self.assertEqual(Path(self.track.path).read_bytes(), other)  # ...the first archive stands...
        self.assertEqual(self._leftovers(), [])
        self.assertEqual(self.analysed, [])  # ...and is not finalized a second time
        self.assertEqual(self.aborted, 0)

    def test_an_archiver_that_finishes_while_the_stream_waits_for_the_lock_wins(self):
        """The background archiver holds the track's lock for its whole download.
        A stream that ends meanwhile has already looked for the file (not there
        yet) and waits; by the time it gets the lock the file is there, and it
        must look again rather than publish over it."""

        class HeldByTheArchiver:
            def __init__(self):
                self.lock = threading.Lock()
                self.waited_on = threading.Event()

            def __enter__(self):
                self.waited_on.set()
                self.lock.acquire()

            def __exit__(self, *exc):
                self.lock.release()

        held = HeldByTheArchiver()
        held.lock.acquire()
        self.provider._track_locks[self.SID] = held
        self._resolve_to(self.cdn.serve("live-lock", encrypt_like_deezer(FLAC, self.SID)))
        _mimetype, stream = self._open()
        heard = []
        listener = threading.Thread(target=lambda: heard.append(b"".join(stream)))
        listener.start()
        try:
            self.assertTrue(held.waited_on.wait(10), "the stream never tried to publish")
            other = b"fLaC" + b"the background archiver's copy"
            Path(self.track.path).write_bytes(other)
        finally:
            held.lock.release()
            listener.join(10)
        self.assertEqual(heard, [FLAC])
        self.assertEqual(Path(self.track.path).read_bytes(), other)
        self.assertEqual(self._leftovers(), [])
        self.assertEqual(self.analysed, [])

    def test_a_failure_while_finalizing_does_not_cut_the_music(self):
        self._resolve_to(self.cdn.serve("live-finalize", encrypt_like_deezer(FLAC, self.SID)))
        _mimetype, stream = self._open()
        with mock.patch.object(library, "refresh_track_metadata", side_effect=RuntimeError("db gone")), \
                self.assertLogs("supysonic.deezer.archive", "WARNING"):
            self.assertEqual(b"".join(stream), FLAC)


class EpisodeFetchTestCase(_CdnMixin, unittest.TestCase):
    """Podcast episodes: plain audio from a third-party host, archived for good."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.provider = self._provider(self.dir)
        # The SSRF guard refuses loopback by design (its own tests are in
        # test_deezer_resilience); here the host IS the loopback stand-in.
        patcher = mock.patch.object(provider_mod, "check_public_url", lambda url: ["127.0.0.1"])
        patcher.start()
        self.addCleanup(patcher.stop)

    def _fetch(self, url):
        received = []
        for chunk in self.provider.iter_episode(url):
            received.append(chunk)
        return b"".join(received)

    def test_whatever_audio_the_host_serves_arrives_as_it_was_sent(self):
        formats = {
            name: (ASSETS / "formats" / f"silence.{name}").read_bytes()
            for name in ("mp3", "m4a", "ogg", "flac")
        }
        # Something nobody listed as a format is still not a page.
        formats["unknown"] = b"\x00\x00\x01\xba" + bytes(range(256)) * 40
        for name, body in formats.items():
            for mode in ("length", "chunked"):
                with self.subTest(name, mode=mode):
                    self.assertEqual(self._fetch(self.cdn.serve(f"ep-{name}-{mode}", body, mode)), body)

    def test_a_page_instead_of_the_episode_is_refused(self):
        pages = {
            "html": b"<!DOCTYPE html><html><body>Episode removed</body></html>",
            "indented": b"\r\n  <html><head><title>Consent</title></head></html>",
            "bom": b"\xef\xbb\xbf<?xml version='1.0'?><error/>",
            "json": b'{"error": "not found"}',
            "empty": b"",
        }
        for name, body in pages.items():
            with self.subTest(name):
                received = []
                with self.assertRaises(DeezerError):
                    for chunk in self.provider.iter_episode(self.cdn.serve(f"page-{name}", body)):
                        received.append(chunk)
                self.assertEqual(received, [])

    def test_a_failed_episode_download_leaves_nothing_behind(self):
        dest = Path(self.dir, "Podcasts", "Show", "2026-09-26 Episode.mp3")
        for name, body, mode in (
            ("cut", MP3, "length-truncated"),
            ("page", b"<html>gone</html>", "length"),
            ("empty", b"", "length"),
        ):
            with self.subTest(name):
                with self.assertRaises(Exception):
                    self.provider.download_episode_to(self.cdn.serve(f"epdl-{name}", body, mode), dest)
                self.assertEqual(self._files(self.dir), [])
        self.provider.download_episode_to(self.cdn.serve("epdl-ok", MP3, "chunked"), dest)
        self.assertEqual(dest.read_bytes(), MP3)
        self.assertEqual(self._files(self.dir), [os.path.relpath(dest, self.dir)])


class StreamRouteTestCase(_CdnMixin, unittest.TestCase):
    """``/api/stream/<id>``, the web player's first play of a Deezer track."""

    SID = "3135556"

    def setUp(self):
        from supysonic.config import DefaultConfig
        from supysonic.db import release_database
        from supysonic.deezer.workload import Priority
        from supysonic.managers.user import UserManager
        from supysonic.web import create_application

        fd, db_path = tempfile.mkstemp()
        os.close(fd)
        cache = tempfile.mkdtemp()
        self.archive_dir = tempfile.mkdtemp()
        self.addCleanup(os.remove, db_path)
        self.addCleanup(shutil.rmtree, cache, ignore_errors=True)
        self.addCleanup(shutil.rmtree, self.archive_dir, ignore_errors=True)

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)

        self.app = create_application(Config())
        self.addCleanup(release_database)
        UserManager.add("alice", "Alic3", admin=True)
        self.provider = self._provider(self.archive_dir)
        self.provider.fetch_cover = lambda md5, size=1000: None
        self.app.deezer = self.provider
        self.queued = []
        self.app.deezer_prefetch = types.SimpleNamespace(
            download_ids=lambda ids, priority=None: self.queued.extend((i, priority) for i in ids)
        )
        self.app.config["DEEZER"]["archive_dir"] = self.archive_dir
        self.prefetch_priority = Priority.PREFETCH
        patcher = mock.patch("supysonic.deezer.analysis.queue_analysis", lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)

        root = library.get_root_folder(self.archive_dir)
        self.track = library.upsert_track(gw_info(self.SID), root, "FLAC")
        self.client = self.app.test_client()
        self.client.post("/api/login", json={"username": "alice", "password": "Alic3"})

    def _resolve_to(self, url):
        self.provider.resolve = lambda sng_id, quality=None: (url, "FLAC", gw_info(self.SID), self.SID)

    def test_a_first_play_streams_the_audio_and_the_next_one_is_served_from_disk(self):
        self._resolve_to(self.cdn.serve("route-ok", encrypt_like_deezer(FLAC, self.SID), "chunked"))
        rv = self.client.get(f"/api/stream/{self.SID}")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.mimetype, "audio/flac")
        self.assertEqual(rv.data, FLAC)
        rv.close()
        # Kept, so the next play is a file: seekable, no Deezer involved.
        rv = self.client.get(f"/api/stream/{self.SID}", headers={"Range": "bytes=0-3"})
        self.assertEqual(rv.status_code, 206)
        self.assertEqual(rv.data, b"fLaC")
        rv.close()
        self.assertEqual(self.cdn.hits.count("/route-ok"), 1)
        self.assertEqual(self.queued, [])

    def test_a_stream_refused_on_its_first_bytes_is_this_routes_502(self):
        for name, body, mode in (
            ("route-garbage", encrypt_like_deezer(FLAC, "1"), "length"),
            ("route-expired", b"x", "forbidden"),
        ):
            with self.subTest(name):
                self.queued.clear()
                self._resolve_to(self.cdn.serve(name, body, mode))
                with self.assertLogs("supysonic.webui", "WARNING"):
                    rv = self.client.get(f"/api/stream/{self.SID}")
                self.assertEqual(rv.status_code, 502)
                self.assertEqual(rv.get_json(), {"error": "track unavailable"})
                self.assertFalse(os.path.exists(self.track.path))
                # It gets one more go in the background, ahead of bulk work.
                self.assertEqual(self.queued, [(self.SID, self.prefetch_priority)])

    def test_the_response_passes_everything_on_to_the_stream(self):
        from supysonic.webui import _then

        def stream(log):
            try:
                yield b"a"
                yield b"b"
            finally:
                log.append("closed")

        started = stream([])
        self.assertEqual(list(_then(next(started), started)), [b"a", b"b"])
        exhausted = stream([])
        list(exhausted)
        self.assertEqual(list(_then(None, exhausted)), [])
        # The client leaves while the block the route read is going out, before
        # the stream is resumed: its cleanup must still run, now.
        log = []
        started = stream(log)
        response = _then(next(started), started)
        next(response)
        response.close()
        self.assertEqual(log, ["closed"])

    def test_a_listener_who_leaves_mid_stream_gets_the_archive_queued(self):
        self._resolve_to(self.cdn.serve("route-leave", encrypt_like_deezer(FLAC, self.SID)))
        rv = self.client.get(f"/api/stream/{self.SID}", buffered=False)
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(next(iter(rv.response)), FLAC[:2048])
        rv.close()  # the WSGI server, when the client hangs up
        self.assertEqual(self.queued, [(self.SID, self.prefetch_priority)])
        self.assertFalse(os.path.exists(self.track.path))
        self.assertEqual(
            [f for f in self._files(self.archive_dir) if f.endswith(".part")], []
        )


class EnsureArchivedTestCase(_CdnMixin, TestBase):
    """``ensure_archived``, the path every non-live fetch takes, end to end."""

    def setUp(self):
        super().setUp()
        self.archive_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.archive_dir, ignore_errors=True)
        self.provider = self._provider(self.archive_dir)
        self.provider.fetch_cover = lambda md5, size=1000: None
        patcher = mock.patch("supysonic.deezer.analysis.queue_analysis", lambda *a, **k: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        root = library.get_root_folder(self.archive_dir)
        self.track = library.upsert_track(gw_info("1"), root, "FLAC")

    def _resolve_to(self, url):
        self.provider.resolve = lambda sng_id, quality=None: (url, "FLAC", gw_info("1"), "1")

    def test_it_archives_the_audio_deezer_sent(self):
        self._resolve_to(self.cdn.serve("bg-ok", encrypt_like_deezer(FLAC, "1"), "chunked"))
        archive.ensure_archived(self.provider, self.track)
        audio = mutagen.flac.FLAC(self.track.path)
        self.assertEqual(audio.info.total_samples, 214272)
        self.assertEqual(audio["title"], ["Harder (Live)"])
        self.assertGreater(Track[ids.track_uuid("1")].last_modification, 0)

    def test_what_is_not_audio_is_not_archived(self):
        self._resolve_to(self.cdn.serve("bg-garbage", encrypt_like_deezer(FLAC, "916424")))
        with self.assertRaises(DeezerError):
            archive.ensure_archived(self.provider, self.track)
        self.assertEqual(self._files(self.archive_dir), [])
        self.assertEqual(Track[ids.track_uuid("1")].last_modification, 0)


if __name__ == "__main__":
    unittest.main()

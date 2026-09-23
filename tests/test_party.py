# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The listen party (supysonic/webui/party.py).

Three things are worth pinning here. The capability model: the party id is the
only credential a guest has, and it must open exactly what the host is playing
and nothing else in the library. The timeline: what the host publishes is what
guests read, sanitised on the way through. And the audio: a guest schedules
chunk k at k·CHUNK_SECONDS on its own clock, so the chunks must be cut from the
archive to the SAMPLE — that is measured against a reference decode with real
ffmpeg, on real (noise) audio, because a periodic test tone would let an
off-by-a-period cut pass.
"""

import array
import os
import shutil
import subprocess
import tempfile
import time
import unittest

from supysonic.config import DefaultConfig
from supysonic.db import Track, User, release_database
from supysonic.managers.user import UserManager
from supysonic.web import create_application
from supysonic.webui import party as P

HAVE_FFMPEG = shutil.which("ffmpeg") is not None


class _Prefetch:
    def __init__(self):
        self.ids = []
        self.episode_ids = []
        self.priorities = []

    def download_ids(self, ids, priority=None):
        ids = list(ids)
        self.ids += ids
        self.priorities += [priority] * len(ids)
        return len(ids)

    def download_episode_ids(self, ids, priority=None):
        self.episode_ids += list(ids)
        return len(ids)


def _pcm(args):
    """Decode with ffmpeg to 48 kHz mono s16 — the common ground for comparing."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", *args, "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"],
        stdout=subprocess.PIPE,
        check=True,
    ).stdout
    a = array.array("h")
    a.frombytes(out)
    return a


def _best_lag(chunk, ref, start_sample, span=1500):
    """The lag (samples) at which `chunk` best matches `ref` near `start_sample`.

    A cut that is exact lands at 0. Measured on noise, where only the true
    alignment matches.
    """
    n = 2400
    seg = chunk[1000 : 1000 + n]
    best = None
    for lag in range(-span, span + 1):
        o = start_sample + 1000 + lag
        r = ref[o : o + n]
        if len(r) < n:
            continue
        err = sum(abs(x - y) for x, y in zip(seg[::6], r[::6]))
        if best is None or err < best[0]:
            best = (err, lag)
    return best[1]


class PartyTestCase(unittest.TestCase):
    def setUp(self):
        P._parties.clear()
        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        db_path = self.__db[1]
        cache = self.__dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(
                    self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True
                )

        self.app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bbb", admin=False)
        self.app.deezer_prefetch = _Prefetch()
        self.host = self.app.test_client()
        self.host.post("/api/login", json={"username": "alice", "password": "Alic3"})
        # A guest has no session at all.
        self.guest = self.app.test_client()

    def tearDown(self):
        P._parties.clear()
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        shutil.rmtree(self.archive, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    # -- fixtures ---------------------------------------------------------------

    def _track(self, name="song.flac", seconds=20.0, owner=None, write=True):
        """A local track row, backed by real (noise) audio when ffmpeg is here."""
        from supysonic.deezer import library, local

        root = library.get_root_folder(self.archive)
        d = os.path.join(self.archive, "Band", "Album")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, name)
        # The row needs a file either way (its mtime is read); `write` decides
        # whether it is real audio.
        if not write or not HAVE_FFMPEG:
            with open(path, "wb") as fh:
                fh.write(b"audio")
        else:
            if HAVE_FFMPEG:
                subprocess.run(
                    [
                        "ffmpeg", "-v", "error", "-y", "-f", "lavfi",
                        "-i", f"anoisesrc=d={seconds}:c=pink:r=44100:a=0.3:seed=7",
                        "-af", "lowpass=f=6000", "-ac", "2", path,
                    ],
                    check=True,
                )

        class Tag:
            artist = "Band"
            albumartist = None
            album = "Album"
            genre = None
            title = "Song"
            disc = 1
            track = 1
            year = None
            length = seconds
            bitrate = 900000
            images = []

        orig = local._load_tag
        local._load_tag = lambda p: Tag() if p == path else None
        try:
            return local.import_local_file(path, root, owner=owner)
        finally:
            local._load_tag = orig

    def _start(self):
        r = self.host.post("/api/party")
        self.assertEqual(r.status_code, 200)
        return r.get_json()["id"]

    def _publish(self, pid, track, p=0.0, playing=True, **extra):
        body = {
            "track": {
                "id": str(track.id) if isinstance(track, Track) else str(track),
                "title": "Song",
                "artist": "Band",
                "album": "Album",
                "duration": 20,
            },
            "playing": playing,
            "t": P.server_ms(),
            "p": p,
        }
        body.update(extra)
        return self.host.post(f"/api/party/{pid}/state", json=body)

    # -- lifecycle & capability ----------------------------------------------------

    def test_hosting_needs_a_session(self):
        self.assertEqual(self.guest.post("/api/party").status_code, 401)

    def test_one_party_per_host_and_an_unguessable_id(self):
        pid = self._start()
        # 128 random bits, url-safe.
        self.assertGreaterEqual(len(pid), 22)
        self.assertRegex(pid, r"\A[A-Za-z0-9_-]+\Z")
        # A second press re-opens the same party rather than stranding guests.
        self.assertEqual(self._start(), pid)
        self.assertEqual(self.host.get("/api/party/mine").get_json()["party"]["id"], pid)

    def test_a_host_can_take_its_party_back_after_a_restart(self):
        pid = self._start()
        P._parties.clear()  # what a server restart does to the registry
        r = self.host.post("/api/party", json={"resume": pid})
        self.assertEqual(r.get_json()["id"], pid)
        # ...but never an id somebody else is using, nor a malformed one.
        bob = self.app.test_client()
        bob.post("/api/login", json={"username": "bob", "password": "B0bbb"})
        self.assertNotEqual(bob.post("/api/party", json={"resume": pid}).get_json()["id"], pid)
        self.host.delete(f"/api/party/{pid}")
        self.assertNotEqual(self.host.post("/api/party", json={"resume": "short"}).get_json()["id"], "short")

    def test_another_user_can_neither_see_nor_drive_it(self):
        pid = self._start()
        bob = self.app.test_client()
        bob.post("/api/login", json={"username": "bob", "password": "B0bbb"})
        self.assertIsNone(bob.get("/api/party/mine").get_json()["party"])
        t = self._track(write=False)
        body = {"track": {"id": str(t.id)}, "playing": True, "t": P.server_ms(), "p": 0}
        self.assertEqual(bob.post(f"/api/party/{pid}/state", json=body).status_code, 404)
        self.assertEqual(bob.delete(f"/api/party/{pid}").status_code, 404)
        # Still alive for its guests.
        self.assertEqual(self.guest.get(f"/api/party/{pid}").status_code, 200)

    def test_unknown_and_malformed_ids_are_404(self):
        for pid in ("nope", "x" * 22, "../../etc", "a" * 100):
            self.assertEqual(self.guest.get(f"/api/party/{pid}").status_code, 404, pid)
            self.assertEqual(self.guest.get(f"/api/party/{pid}/clock").status_code, 404, pid)

    def test_ending_it_closes_it_for_guests(self):
        pid = self._start()
        self.assertEqual(self.host.delete(f"/api/party/{pid}").status_code, 200)
        self.assertEqual(self.guest.get(f"/api/party/{pid}").status_code, 404)
        self.assertIsNone(self.host.get("/api/party/mine").get_json()["party"])

    def test_a_silent_host_ends_the_party(self):
        pid = self._start()
        P._parties[pid].host_seen -= P.PARTY_TTL + 1
        self.assertEqual(self.guest.get(f"/api/party/{pid}").status_code, 404)

    # -- the timeline -------------------------------------------------------------

    def test_guests_read_what_the_host_published(self):
        pid = self._start()
        t = self._track(write=False)
        before = P.server_ms()
        r = self._publish(pid, t, p=12.5, xfade=6, norm="medium")
        self.assertEqual(r.status_code, 200)
        s = self.guest.get(f"/api/party/{pid}").get_json()
        self.assertEqual(s["host"], "alice")
        self.assertTrue(s["playing"])
        self.assertTrue(s["live"])
        self.assertEqual(s["track"]["id"], str(t.id))
        self.assertEqual(s["track"]["title"], "Song")
        self.assertEqual(s["anchor"]["p"], 12.5)
        self.assertGreaterEqual(s["anchor"]["t"], before)
        self.assertEqual(s["xfade"], 6)
        self.assertEqual(s["norm"], "medium")
        # Guests have no session: art always comes through the party.
        self.assertEqual(s["track"]["cover"], f"/api/party/{pid}/cover/{t.id}")
        self.assertEqual(s["chunk"], {"len": P.CHUNK_SECONDS, "ov": P.CHUNK_OVERLAP})
        self.assertIn("now", s)
        self.assertEqual(self.guest.get(f"/api/party/{pid}").headers["Cache-Control"], "no-store")

    def test_the_next_track_is_announced(self):
        pid = self._start()
        t = self._track(write=False)
        nxt = {"track": {"id": "3135556", "title": "Next"}, "at": 18.5, "start": 0.4, "fade": 6, "gap": 0.15}
        self._publish(pid, t, next=nxt)
        s = self.guest.get(f"/api/party/{pid}").get_json()
        self.assertEqual(s["next"]["track"]["id"], "3135556")
        self.assertEqual(s["next"]["at"], 18.5)
        self.assertEqual(s["next"]["start"], 0.4)
        self.assertEqual(s["next"]["fade"], 6)
        self.assertEqual(s["next"]["gap"], 0.15)
        # ...and it is fetchable before it starts, so guests can preload it.
        self.assertIn("3135556", P._parties[pid].media)

    def test_a_loading_host_is_not_a_paused_one(self):
        # A skip: the host announces the new track before its element plays it.
        pid = self._start()
        t = self._track(write=False)
        self._publish(pid, t, playing=False, buf=True)
        s = self.guest.get(f"/api/party/{pid}").get_json()
        self.assertFalse(s["playing"])
        self.assertTrue(s["buf"])
        # Loading and playing at once is not a state: playing wins.
        self._publish(pid, t, playing=True, buf=True)
        s = self.guest.get(f"/api/party/{pid}").get_json()
        self.assertTrue(s["playing"])
        self.assertFalse(s["buf"])
        # And a real pause says so.
        self._publish(pid, t, playing=False)
        self.assertFalse(self.guest.get(f"/api/party/{pid}").get_json()["buf"])

    def test_the_host_payload_is_sanitised(self):
        pid = self._start()
        t = self._track(write=False)
        r = self.host.post(
            f"/api/party/{pid}/state",
            json={
                "track": {"id": str(t.id), "title": "A\x00B" + "x" * 1000, "duration": 1e30, "gain": "loud"},
                "playing": True,
                "t": P.server_ms(),
                "p": 3,
                "xfade": 999,
                "norm": "<script>",
            },
        )
        self.assertEqual(r.status_code, 200)
        s = self.guest.get(f"/api/party/{pid}").get_json()
        self.assertTrue(s["track"]["title"].startswith("AB"))
        self.assertLessEqual(len(s["track"]["title"]), 300)
        self.assertEqual(s["track"]["duration"], 24 * 3600)
        self.assertIsNone(s["track"]["gain"])
        self.assertEqual(s["xfade"], 12)
        self.assertEqual(s["norm"], "off")

    def test_an_anchor_off_the_server_clock_is_refused(self):
        pid = self._start()
        t = self._track(write=False)
        body = {"track": {"id": str(t.id)}, "playing": True, "t": P.server_ms() - 3_600_000, "p": 0}
        self.assertEqual(self.host.post(f"/api/party/{pid}/state", json=body).status_code, 400)
        body = {"track": {"id": str(t.id)}, "playing": True, "p": 0}
        self.assertEqual(self.host.post(f"/api/party/{pid}/state", json=body).status_code, 400)

    def test_the_host_cannot_publish_what_it_may_not_read(self):
        pid = self._start()
        bob = User.get(User.name == "bob")
        # Bob's private upload. Alice is an admin, so she may read it — make the
        # host a non-admin to prove the check is the host's own access.
        private = self._track(name="private.flac", write=False, owner=bob)
        User.update(admin=False).where(User.name == "alice").execute()
        r = self._publish(pid, private)
        self.assertEqual(r.status_code, 400)
        # Garbage and unknown ids are refused too.
        self.assertEqual(self._publish(pid, "not-an-id").status_code, 400)
        self.assertEqual(self._publish(pid, "3a1f0f0e-8f7e-4c3a-9f1e-000000000000").status_code, 400)

    def test_a_heartbeat_keeps_the_host_live_without_touching_the_timeline(self):
        pid = self._start()
        t = self._track(write=False)
        self._publish(pid, t, p=5)
        v = self.guest.get(f"/api/party/{pid}").get_json()["v"]
        P._parties[pid].host_seen -= P.HOST_OFFLINE + 1
        self.assertFalse(self.guest.get(f"/api/party/{pid}").get_json()["live"])
        r = self.host.post(f"/api/party/{pid}/state", json={"hb": 1})
        self.assertEqual(r.status_code, 200)
        s = self.guest.get(f"/api/party/{pid}").get_json()
        self.assertTrue(s["live"])
        self.assertEqual(s["v"], v)
        self.assertEqual(s["anchor"]["p"], 5)

    # -- listeners & clock ----------------------------------------------------------

    def test_listeners_join_report_and_leave(self):
        pid = self._start()
        lid = self.guest.post(f"/api/party/{pid}/join", json={"name": "  Zoé\n "}).get_json()["lid"]
        self.guest.get(f"/api/party/{pid}?l={lid}&q=2.4&st=sync")
        hb = self.host.post(f"/api/party/{pid}/state", json={"hb": 1}).get_json()
        self.assertEqual(len(hb["listeners"]), 1)
        self.assertEqual(hb["listeners"][0]["name"], "Zoé")
        self.assertEqual(hb["listeners"][0]["q"], 2.4)
        self.assertEqual(hb["listeners"][0]["st"], "sync")
        # Guests see names — never another guest's id, which is what
        # authorises that guest's `leave`.
        s = self.guest.get(f"/api/party/{pid}").get_json()
        self.assertEqual(s["listeners"], [{"name": "Zoé"}])
        self.assertTrue(self.guest.get(f"/api/party/{pid}?l={lid}").get_json()["me"])
        # sendBeacon posts text/plain.
        self.guest.post(f"/api/party/{pid}/leave", data=f'{{"lid": "{lid}"}}', content_type="text/plain")
        hb = self.host.post(f"/api/party/{pid}/state", json={"hb": 1}).get_json()
        self.assertEqual(hb["listeners"], [])
        # ...and a guest that was dropped is told so, to take a seat again.
        self.assertFalse(self.guest.get(f"/api/party/{pid}?l={lid}").get_json()["me"])
        self.assertNotIn("me", self.guest.get(f"/api/party/{pid}").get_json())

    def test_silent_listeners_drop_off_and_the_party_has_a_ceiling(self):
        pid = self._start()
        lid = self.guest.post(f"/api/party/{pid}/join", json={}).get_json()["lid"]
        self.assertEqual(P._parties[pid].listeners[lid]["name"], "Invité")
        P._parties[pid].listeners[lid]["seen"] -= P.LISTENER_TTL + 1
        hb = self.host.post(f"/api/party/{pid}/state", json={"hb": 1}).get_json()
        self.assertEqual(hb["listeners"], [])
        for _ in range(P.MAX_LISTENERS):
            self.assertEqual(self.guest.post(f"/api/party/{pid}/join", json={}).status_code, 200)
        self.assertEqual(self.guest.post(f"/api/party/{pid}/join", json={}).status_code, 429)

    def test_the_clock_probe(self):
        pid = self._start()
        before = P.server_ms()
        r = self.guest.get(f"/api/party/{pid}/clock")
        after = P.server_ms()
        j = r.get_json()
        self.assertLessEqual(before, j["t1"])
        self.assertLessEqual(j["t1"], j["t2"])
        self.assertLessEqual(j["t2"], after)
        self.assertEqual(r.headers["Cache-Control"], "no-store")

    # -- what a guest may fetch -------------------------------------------------------

    def test_only_what_the_host_plays_is_reachable(self):
        pid = self._start()
        played = self._track(name="played.flac", write=False)
        other = self._track(name="other.flac", write=False)
        self._publish(pid, played)
        self.assertEqual(self.guest.get(f"/api/party/{pid}/chunk/{other.id}/0").status_code, 404)
        self.assertEqual(self.guest.get(f"/api/party/{pid}/cover/{other.id}").status_code, 404)
        self.assertEqual(self.guest.get(f"/api/party/{pid}/chunk/3135556/0").status_code, 404)
        # And none of it works without the party.
        self.assertEqual(self.guest.get(f"/api/stream/{played.id}").status_code, 401)

    def test_chunk_parameters_are_validated(self):
        pid = self._start()
        t = self._track(write=False)
        self._publish(pid, t)
        base = f"/api/party/{pid}/chunk/{t.id}"
        self.assertEqual(self.guest.get(f"{base}/0?f=mp3").status_code, 400)
        self.assertEqual(self.guest.get(f"{base}/0?f=flac&sr=96000").status_code, 400)
        self.assertEqual(self.guest.get(f"{base}/0?f=flac&sr=x").status_code, 400)
        self.assertEqual(self.guest.get(f"{base}/{P.MAX_CHUNK_INDEX + 1}").status_code, 400)
        self.assertEqual(self.guest.get(f"{base}/-1").status_code, 404)  # not a route
        # Far past the end of a 20 s track.
        self.assertEqual(self.guest.get(f"{base}/40").status_code, 404)

    def test_a_cold_track_waits_for_the_hosts_own_download_first(self):
        from supysonic.deezer.workload import Priority

        pid = self._start()
        self._publish(pid, "3135556")
        pf = self.app.deezer_prefetch
        r = self.guest.get(f"/api/party/{pid}/chunk/3135556/0")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.headers["Retry-After"], "2")
        # Within the grace, the host's own stream is archiving it: no second
        # download.
        self.assertEqual(pf.ids, [])
        P._parties[pid].media["3135556"]["since"] -= P.ARCHIVE_GRACE + 1
        self.guest.get(f"/api/party/{pid}/chunk/3135556/0")
        self.guest.get(f"/api/party/{pid}/chunk/3135556/1")
        # Past it, exactly one download, at the priority of someone waiting.
        self.assertEqual(pf.ids, ["3135556"])
        self.assertEqual(pf.priorities, [Priority.USER])

    def test_a_local_upload_whose_file_is_gone_is_not_preparing_forever(self):
        pid = self._start()
        t = self._track(write=False)
        self._publish(pid, t)
        os.remove(t.path)
        self.assertEqual(self.guest.get(f"/api/party/{pid}/chunk/{t.id}/0").status_code, 404)

    # -- the audio itself (real ffmpeg) -------------------------------------------------

    @unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
    def test_chunks_are_cut_to_the_sample(self):
        pid = self._start()
        t = self._track(seconds=20.0)
        self._publish(pid, t)
        ref = _pcm(["-i", t.path])
        L, OV = P.CHUNK_SECONDS, P.CHUNK_OVERLAP
        chunks = {}
        for k in (1, 2):
            r = self.guest.get(f"/api/party/{pid}/chunk/{t.id}/{k}?f=flac&sr=48000")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.mimetype, "audio/flac")
            path = os.path.join(self.__dir, f"c{k}.flac")
            with open(path, "wb") as fh:
                fh.write(r.data)
            chunks[k] = _pcm(["-i", path])
        # Exactly L + OV long, and starting exactly at k·L.
        for k, pcm in chunks.items():
            self.assertEqual(len(pcm), round((L + OV) * 48000), k)
            self.assertEqual(_best_lag(pcm, ref, round(k * L * 48000)), 0, k)
        # The seam: chunk 1's overlap tail IS chunk 2's head, sample for sample,
        # which is what makes a crossfade across it a no-op.
        tail = chunks[1][round(L * 48000) :]
        head = chunks[2][: len(tail)]
        self.assertEqual(len(tail), round(OV * 48000))
        worst = max(abs(a - b) for a, b in zip(tail, head))
        self.assertLessEqual(worst, 2)  # s16 rounding, nothing more

    @unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
    def test_opus_chunks_decode_to_their_exact_length(self):
        # Opus carries an encoder delay (pre-skip) and pads its last frame; a
        # decoder that honours the header lands on exactly L + OV. If either
        # leaked, every chunk would be shifted and every seam would stutter.
        pid = self._start()
        t = self._track(seconds=20.0)
        self._publish(pid, t)
        r = self.guest.get(f"/api/party/{pid}/chunk/{t.id}/1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.mimetype, "audio/ogg")
        path = os.path.join(self.__dir, "c.ogg")
        with open(path, "wb") as fh:
            fh.write(r.data)
        pcm = _pcm(["-i", path])
        self.assertEqual(len(pcm), round((P.CHUNK_SECONDS + P.CHUNK_OVERLAP) * 48000))
        ref = _pcm(["-i", t.path])
        self.assertEqual(_best_lag(pcm, ref, round(P.CHUNK_SECONDS * 48000)), 0)

    @unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
    def test_a_chunk_is_cut_once_whoever_asks(self):
        pid = self._start()
        t = self._track(seconds=12.0)
        self._publish(pid, t)
        calls = []
        orig = P._cut
        P._cut = lambda *a: calls.append(a) or orig(*a)
        try:
            for _ in range(3):
                r = self.guest.get(f"/api/party/{pid}/chunk/{t.id}/0")
                self.assertEqual(r.status_code, 200)
        finally:
            P._cut = orig
        self.assertEqual(len(calls), 1)
        self.assertIn("max-age", r.headers["Cache-Control"])

    @unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
    def test_an_mp3_is_made_seekable_before_it_is_cut(self):
        pid = self._start()
        flac = self._track(name="src.flac", seconds=14.0)
        mp3_path = os.path.join(os.path.dirname(flac.path), "song.mp3")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", flac.path, "-c:a", "libmp3lame", "-q:a", "2", mp3_path],
            check=True,
        )
        from supysonic.deezer import library, local

        class Tag:
            artist = "Band"
            albumartist = None
            album = "Album"
            genre = None
            title = "Song"
            disc = 1
            track = 2
            year = None
            length = 14.0
            bitrate = 190000
            images = []

        orig = local._load_tag
        local._load_tag = lambda p: Tag()
        try:
            mp3 = local.import_local_file(mp3_path, library.get_root_folder(self.archive))
        finally:
            local._load_tag = orig
        self._publish(pid, mp3)
        url = f"/api/party/{pid}/chunk/{mp3.id}/1?f=flac&sr=48000"
        r = self.guest.get(url)
        # A VBR MP3 cannot be cut to the sample: the first ask starts an exact-
        # seek copy in the background and says so.
        self.assertEqual(r.status_code, 503)
        deadline = time.time() + 30
        while time.time() < deadline:
            r = self.guest.get(url)
            if r.status_code == 200:
                break
            time.sleep(0.2)
        self.assertEqual(r.status_code, 200)
        path = os.path.join(self.__dir, "m.flac")
        with open(path, "wb") as fh:
            fh.write(r.data)
        # Chunk 1 aligns with the MP3's own full decode. Measured: 1 sample
        # (21 µs) — the exact-seek copy is a lossy Opus re-encode, whose phase
        # is not bit-identical — against 1534 samples (32 ms) for a direct cut.
        ref = _pcm(["-i", mp3_path])
        lag = _best_lag(_pcm(["-i", path]), ref, round(P.CHUNK_SECONDS * 48000))
        self.assertLessEqual(abs(lag), 1)

    # -- the link ------------------------------------------------------------------------

    def test_the_short_link_forwards_into_the_app(self):
        pid = self._start()
        r = self.guest.get(f"/party/{pid}")
        self.assertEqual(r.status_code, 200)
        body = r.get_data(as_text=True)
        self.assertIn(f"url=/app/#/party/{pid}", body)
        self.assertIn("Listen party de alice", body)
        self.assertEqual(r.headers["X-Robots-Tag"], "noindex")
        self.assertEqual(self.guest.get("/party/bad").status_code, 404)
        # An ended party still forwards (the app says it is over), naming nobody.
        self.host.delete(f"/api/party/{pid}")
        body = self.guest.get(f"/party/{pid}").get_data(as_text=True)
        self.assertNotIn("alice", body)

    def test_the_host_name_is_escaped_in_the_link_page(self):
        UserManager.add("<b>eve</b>", "Ev3ee", admin=False)
        eve = self.app.test_client()
        eve.post("/api/login", json={"username": "<b>eve</b>", "password": "Ev3ee"})
        pid = eve.post("/api/party").get_json()["id"]
        body = self.guest.get(f"/party/{pid}").get_data(as_text=True)
        self.assertNotIn("<b>eve</b>", body)
        self.assertIn("&lt;b&gt;eve&lt;/b&gt;", body)


if __name__ == "__main__":
    unittest.main()

"""The listen-party bench's server (webapp/test/party/run.mjs).

A real application on a throwaway database, with one admin and a library of two
click tracks cut by ffmpeg, served by werkzeug the way `flask run` would. It
prints `READY <port> <json>` once it answers — the json carrying each track's
id and the media time of every click in it — and serves until it is killed.

The clicks are spaced IRREGULARLY on purpose: with a regular click, a guest a
whole period off would pair up perfectly with the wrong click and look in sync.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

from werkzeug.serving import make_server  # noqa: E402

from supysonic.config import DefaultConfig  # noqa: E402
from supysonic.managers.user import UserManager  # noqa: E402
from supysonic.web import create_application  # noqa: E402

RATE = 44100


def click_track(path, seconds, spacings, title):
    """A FLAC of silence with a 1 ms click at irregular times; returns them."""
    n = int(seconds * RATE)
    pcm = bytearray(n * 4)
    times = []
    t = 0.5
    k = 0
    while t < seconds - 0.5:
        start = round(t * RATE)
        times.append(start / RATE)
        for i in range(44):
            v = int(28000 * (1 - i / 44))
            for ch in (0, 2):
                o = (start + i) * 4 + ch
                pcm[o : o + 2] = v.to_bytes(2, "little", signed=True)
        t += spacings[k % len(spacings)]
        k += 1
    raw = path + ".wav"
    with wave.open(raw, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(pcm))
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", raw, "-c:a", "flac",
         "-metadata", f"title={title}", "-metadata", "artist=Bench",
         "-metadata", "album=Bench", "-metadata", "track=1", path],
        check=True,
    )
    os.remove(raw)
    return times


def main():
    work = tempfile.mkdtemp(prefix="nsparty-")
    db = os.path.join(work, "db.sqlite")
    cache = os.path.join(work, "cache")
    archive = os.path.join(work, "archive")
    os.makedirs(cache)
    os.makedirs(os.path.join(archive, "Bench", "Bench"))

    class Config(DefaultConfig):
        def __init__(self):
            super().__init__()
            self.BASE = dict(self.BASE, database_uri="sqlite:///" + db)
            self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
            self.DEEZER = dict(getattr(self, "DEEZER", {}), archive_dir=archive)

    app = create_application(Config())
    with app.app_context():
        UserManager.add("bench", "Bench1", admin=True)
        from supysonic.deezer import library, local

        root = library.get_root_folder(archive)
        tracks = {}
        for name, seconds, spacings in (
            ("a", 60, [0.37, 0.41, 0.45, 0.39, 0.43]),
            ("b", 40, [0.44, 0.38, 0.42, 0.36]),
        ):
            path = os.path.join(archive, "Bench", "Bench", f"click-{name}.flac")
            times = click_track(path, seconds, spacings, f"Click {name.upper()}")
            t = local.import_local_file(path, root)
            tracks[name] = {"id": str(t.id), "duration": seconds, "clicks": times, "title": t.title}

    server = make_server("127.0.0.1", 0, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("READY", server.server_port, json.dumps(tracks), flush=True)
    try:
        sys.stdin.read()  # the runner closes our stdin when it is done
    finally:
        server.shutdown()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

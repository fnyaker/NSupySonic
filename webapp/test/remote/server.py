"""The remote-control bench's server (webapp/test/remote/run.mjs).

A real application on a throwaway database: an admin ("owner", whose player is
driven), a second account ("friend", whose own session a claimed link must
hand back), and a library of four short WAV tracks — WAV so the bench needs no
ffmpeg. Served by werkzeug the way `flask run` would; prints
`READY <port> <json>` once it answers and serves until its stdin closes.
"""

import json
import math
import os
import shutil
import struct
import sys
import tempfile
import threading
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

import mediafile  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from supysonic.config import DefaultConfig  # noqa: E402
from supysonic.managers.user import UserManager  # noqa: E402
from supysonic.web import create_application  # noqa: E402

RATE = 22050


def tone_track(path, seconds, freq, title):
    frames = bytearray()
    for i in range(int(seconds * RATE)):
        v = int(1800 * math.sin(2 * math.pi * freq * i / RATE))
        frames += struct.pack("<hh", v, v)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))
    mf = mediafile.MediaFile(path)
    mf.title = title
    mf.artist = "Bench"
    mf.album = "Bench"
    mf.track = 1
    mf.save()


def main():
    work = tempfile.mkdtemp(prefix="nsremote-")
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
        UserManager.add("owner", "Owner1", admin=True)
        UserManager.add("friend", "Friend1", admin=False)
        from supysonic.deezer import library, local

        root = library.get_root_folder(archive)
        tracks = []
        for k, (title, freq) in enumerate((("Alpha", 220), ("Bravo", 262), ("Charlie", 330), ("Delta", 392))):
            path = os.path.join(archive, "Bench", "Bench", f"{k}-{title}.wav")
            tone_track(path, 40, freq, title)
            t = local.import_local_file(path, root)
            tracks.append({"id": str(t.id), "title": t.title})

    server = make_server("127.0.0.1", 0, app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("READY", server.server_port, json.dumps(tracks), flush=True)
    try:
        sys.stdin.read()
    finally:
        server.shutdown()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

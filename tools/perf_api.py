#!/usr/bin/env python3
"""Time the web app's API on a library the size real ones reach.

    python tools/perf_api.py                    # 8000 tracks, the default shape
    python tools/perf_api.py --tracks 20000     # bigger
    python tools/perf_api.py --serve            # ...and keep serving it (for a browser)

A throwaway database is filled through the importer's own upsert path
(``library.upsert_track``, credits included), then every route the player's
screens call is asked for, as the admin, with Deezer switched off — which is
both the offline case and the one where the answer is the database's alone,
so what is measured is this server's own work: queries, serialisation, gzip.

For each route it prints the median wall time over a few runs, the SQL
statement count (the number an N+1 moves by thousands), the response size and
its gzipped size. Nothing here touches the network.
"""

import argparse
import collections
import contextlib
import gzip
import json
import os
import random
import shutil
import statistics
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

import peewee  # noqa: E402

from supysonic.config import DefaultConfig  # noqa: E402
from supysonic.managers.user import UserManager  # noqa: E402
from supysonic.web import create_application  # noqa: E402


@contextlib.contextmanager
def count_statements():
    counts = collections.Counter()
    original = peewee.Database.execute_sql

    def execute_sql(self, sql, *args, **kwargs):
        counts[sql.split(None, 1)[0].upper()] += 1
        return original(self, sql, *args, **kwargs)

    peewee.Database.execute_sql = execute_sql
    try:
        yield counts
    finally:
        peewee.Database.execute_sql = original


WORDS = (
    "amour nuit été cœur étoile rêve lumière ciel feu ombre danse vent mer soleil "
    "horizon silence océan éclat encore toujours jamais demain hier ville route "
    "night love fire dream light heart rain gold wild blue storm echo neon"
).split()


def title(r):
    return " ".join(r.choice(WORDS).capitalize() if i == 0 else r.choice(WORDS) for i in range(r.randint(1, 4)))


def populate(app, n_tracks, n_playlists, n_fav, big_playlist):
    from supysonic.db import Playlist, PlaylistTrack, StarredTrack, User
    from supysonic.deezer import library

    r = random.Random(7)
    with app.app_context():
        admin = User.get(name="bench")
        root = library.get_root_folder(app.config["DEEZER"]["archive_dir"])
        n_artists = max(20, n_tracks // 16)
        n_albums = max(40, n_tracks // 6)
        artists = [(str(1_000_000 + i), f"{title(r)} {i}") for i in range(n_artists)]
        albums = []
        for i in range(n_albums):
            a = r.choice(artists)
            albums.append((str(2_000_000 + i), f"{title(r)} {i}", a, f"{i:032x}"))
        tracks = []
        t0 = time.time()
        for i in range(n_tracks):
            alb = r.choice(albums)
            raw = {
                "SNG_ID": str(3_000_000 + i),
                "SNG_TITLE": title(r),
                "ART_ID": alb[2][0],
                "ART_NAME": alb[2][1],
                "ALB_ID": alb[0],
                "ALB_TITLE": alb[1],
                "ALB_PICTURE": alb[3],
                "DURATION": r.randint(90, 420),
                "TRACK_NUMBER": 1 + i % 14,
                "DISK_NUMBER": 1,
                "TRACK_TOKEN": f"tok{i}",
            }
            if r.random() < 0.2:
                feat = r.choice(artists)
                raw["ARTISTS"] = [
                    {"ART_ID": alb[2][0], "ART_NAME": alb[2][1], "ROLE_ID": "0"},
                    {"ART_ID": feat[0], "ART_NAME": feat[1], "ROLE_ID": "5"},
                ]
            tracks.append(library.upsert_track(raw, root))
        print(f"  {n_tracks} tracks in {time.time() - t0:.1f}s", file=sys.stderr)
        pls = []
        for p in range(n_playlists):
            pl = Playlist.create(user=admin, name=f"Playlist {p} {title(r)}")
            size = big_playlist if p == 0 else r.randint(5, 150)
            rows = r.sample(tracks, min(size, len(tracks)))
            PlaylistTrack.insert_many(
                [{"playlist": pl.id, "track": t.id, "index": k} for k, t in enumerate(rows)]
            ).execute()
            pls.append(pl)
        StarredTrack.insert_many(
            [{"user": admin.id, "starred": t.id} for t in r.sample(tracks, min(n_fav, len(tracks)))]
        ).execute()
        return {
            "big": str(pls[0].id),
            "small": str(pls[-1].id),
            "album": albums[0][0],
            "artist": artists[0][0],
            "track": str(tracks[0].deezer_id),
            "ids": [str(t.deezer_id) for t in tracks[:12]],
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", type=int, default=8000)
    ap.add_argument("--playlists", type=int, default=60)
    ap.add_argument("--favorites", type=int, default=4000)
    ap.add_argument("--big-playlist", type=int, default=4000)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--serve", action="store_true", help="keep serving on a port afterwards")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument(
        "--audio",
        help="a WAV file archived as the first 12 tracks (ids[\"ids\"]), so /api/stream "
        "serves them from disk with real byte ranges",
    )
    args = ap.parse_args()

    work = tempfile.mkdtemp(prefix="nsperf-")
    db = os.path.join(work, "db.sqlite")
    cache = os.path.join(work, "cache")
    archive = os.path.join(work, "archive")
    os.makedirs(cache)
    os.makedirs(archive)

    class Config(DefaultConfig):
        def __init__(self):
            super().__init__()
            self.BASE = dict(self.BASE, database_uri="sqlite:///" + db)
            self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)
            self.DEEZER = dict(getattr(self, "DEEZER", {}), archive_dir=archive, enabled=False)

    app = create_application(Config())
    with app.app_context():
        UserManager.add("bench", "Bench1", admin=True)
        from supysonic.db import db as _db

        # One transaction for the whole fill: SQLite commits one statement at a
        # time otherwise, and the fill is thousands of upserts.
        _db.execute_sql("PRAGMA synchronous=OFF")
    print(f"populating ({args.tracks} tracks)...", file=sys.stderr)
    ids = populate(app, args.tracks, args.playlists, args.favorites, args.big_playlist)
    if args.audio:
        from supysonic.db import Track
        from supysonic.deezer import ids as dzids

        with app.app_context():
            for sng in ids["ids"]:
                t = Track[dzids.track_uuid(sng)]
                # The served type comes from the extension.
                path = os.path.splitext(t.path)[0] + ".wav"
                os.makedirs(os.path.dirname(path), exist_ok=True)
                shutil.copyfile(args.audio, path)
                Track.update(path=path).where(Track.id == t.id).execute()
    # Each request opens its own connection (web.py), as the server does.
    from supysonic.db import close_connection

    close_connection()

    client = app.test_client()
    rv = client.post("/api/login", json={"username": "bench", "password": "Bench1"})
    assert rv.status_code == 200, rv.data

    routes = [
        ("GET", "/api/me", None),
        ("GET", "/api/home", None),
        ("GET", "/api/me/playlists", None),
        ("GET", "/api/me/favorites", None),
        ("GET", "/api/me/favorite-ids", None),
        ("GET", f"/api/playlist/{ids['big']}", None),
        ("GET", f"/api/playlist/{ids['small']}", None),
        ("GET", f"/api/album/{ids['album']}", None),
        ("GET", f"/api/artist/{ids['artist']}", None),
        ("GET", "/api/search?q=amour", None),
        ("GET", "/api/search?q=night%20fire", None),
        ("POST", "/api/gains", {"ids": ids["ids"]}),
        ("GET", f"/api/lyrics/{ids['track']}", None),
        ("GET", "/api/me/local", None),
        ("GET", "/api/podcasts", None),
        ("GET", "/api/deezer/status", None),
        ("GET", "/api/version", None),
        ("GET", "/api/storage", None),
    ]
    print(f"{'route':42s} {'median':>9s} {'min':>8s} {'sql':>5s} {'bytes':>9s} {'gzip':>8s}  status")
    for method, url, body in routes:
        times = []
        stmts = None
        status = None
        size = gz = 0
        for k in range(args.runs):
            with count_statements() as counts:
                t0 = time.perf_counter()
                rv = client.open(url, method=method, json=body, headers={"Accept-Encoding": "identity"})
                data = rv.get_data()
                times.append((time.perf_counter() - t0) * 1000)
            if stmts is None:
                stmts = sum(counts.values())
                status = rv.status_code
                size = len(data)
                gz = len(gzip.compress(data, 6))
        print(
            f"{method + ' ' + url[:36]:42s} {statistics.median(times):8.1f}ms {min(times):7.1f}ms "
            f"{stmts:5d} {size:9d} {gz:8d}  {status}"
        )

    if args.serve:
        from werkzeug.serving import make_server

        server = make_server("127.0.0.1", args.port, app, threaded=True)
        print("READY", server.server_port, json.dumps(ids), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

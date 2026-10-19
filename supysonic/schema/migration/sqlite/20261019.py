# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Detaching from the Deezer account: release dates and Deezer's tempo on their
own columns, starred playlists, the nearest-tracks index and the enrichment
ledger. Idempotent, like every migration since 20260808."""

import sqlite3

TABLES = """
CREATE TABLE IF NOT EXISTS starred_playlist (
    user_id CHAR(36) NOT NULL REFERENCES user,
    starred_id CHAR(36) NOT NULL REFERENCES playlist,
    date DATETIME NOT NULL,
    PRIMARY KEY (user_id, starred_id)
);
CREATE INDEX IF NOT EXISTS index_starred_playlist_user_id_fk ON starred_playlist(user_id);
CREATE INDEX IF NOT EXISTS index_starred_playlist_starred_id_fk ON starred_playlist(starred_id);
CREATE TABLE IF NOT EXISTS track_neighbor (
    track_id CHAR(36) NOT NULL REFERENCES track ON DELETE CASCADE,
    neighbor_id CHAR(36) NOT NULL REFERENCES track ON DELETE CASCADE,
    score REAL NOT NULL,
    rank INTEGER NOT NULL,
    PRIMARY KEY (track_id, neighbor_id)
);
CREATE INDEX IF NOT EXISTS index_track_neighbor_track_id_rank ON track_neighbor(track_id, rank);
CREATE INDEX IF NOT EXISTS index_track_neighbor_neighbor_id_fk ON track_neighbor(neighbor_id);
CREATE TABLE IF NOT EXISTS track_enrichment (
    track_id CHAR(36) NOT NULL PRIMARY KEY REFERENCES track ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL,
    method VARCHAR(16) NOT NULL,
    mbid VARCHAR(36),
    tried DATETIME NOT NULL,
    error VARCHAR(255)
);
"""

COLUMNS = (
    ("track", "release_date", "VARCHAR(10)"),
    ("track", "deezer_bpm", "REAL"),
    ("album", "release_date", "VARCHAR(10)"),
)


def apply(args):
    file = args.pop("database")
    with sqlite3.connect(file, **args) as conn:
        c = conn.cursor()
        for table, column, kind in COLUMNS:
            c.execute(f"PRAGMA table_info({table})")
            if column not in {row[1] for row in c.fetchall()}:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
        c.executescript(TABLES)
        conn.commit()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Detaching from the Deezer account: release dates and Deezer's tempo on their
own columns, starred playlists, the nearest-tracks index and the enrichment
ledger. Idempotent, like every migration since 20260808."""

try:
    import MySQLdb as provider
except ImportError:
    import pymysql as provider

CHARSET = " DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

TABLES = (
    """CREATE TABLE IF NOT EXISTS starred_playlist (
    user_id CHAR(32) NOT NULL REFERENCES user(id),
    starred_id CHAR(32) NOT NULL REFERENCES playlist(id),
    date DATETIME NOT NULL,
    PRIMARY KEY (user_id, starred_id)
)""",
    """CREATE TABLE IF NOT EXISTS track_neighbor (
    track_id CHAR(32) NOT NULL REFERENCES track(id) ON DELETE CASCADE,
    neighbor_id CHAR(32) NOT NULL REFERENCES track(id) ON DELETE CASCADE,
    score DOUBLE NOT NULL,
    rank INTEGER NOT NULL,
    PRIMARY KEY (track_id, neighbor_id)
)""",
    """CREATE TABLE IF NOT EXISTS track_enrichment (
    track_id CHAR(32) NOT NULL PRIMARY KEY REFERENCES track(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL,
    method VARCHAR(16) NOT NULL,
    mbid VARCHAR(36),
    tried DATETIME NOT NULL,
    error VARCHAR(255)
)""",
)

INDEXES = (
    ("starred_playlist", "index_starred_playlist_user_id_fk", "user_id"),
    ("starred_playlist", "index_starred_playlist_starred_id_fk", "starred_id"),
    ("track_neighbor", "index_track_neighbor_track_id_rank", "track_id, rank"),
    ("track_neighbor", "index_track_neighbor_neighbor_id_fk", "neighbor_id"),
)

COLUMNS = (
    ("track", "release_date", "VARCHAR(10)"),
    ("track", "deezer_bpm", "DOUBLE"),
    ("album", "release_date", "VARCHAR(10)"),
)


def apply(args):
    conn = provider.connect(**args)
    try:
        with conn.cursor() as c:
            for table, column, kind in COLUMNS:
                c.execute(
                    "SELECT COUNT(*) FROM information_schema.columns "
                    "WHERE table_schema = DATABASE() "
                    "AND table_name = %s AND column_name = %s",
                    (table, column),
                )
                if not c.fetchone()[0]:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            for statement in TABLES:
                c.execute(statement + CHARSET)
            for table, name, cols in INDEXES:
                c.execute(
                    "SELECT COUNT(*) FROM information_schema.statistics "
                    "WHERE table_schema = DATABASE() "
                    "AND table_name = %s AND index_name = %s",
                    (table, name),
                )
                if not c.fetchone()[0]:
                    c.execute(f"CREATE INDEX {name} ON {table}({cols})")
        conn.commit()
    finally:
        conn.close()

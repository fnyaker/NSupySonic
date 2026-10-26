# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The navigation rework: a release's tracklist, kept by the releases watcher
so the home lists new TITLES without asking anyone, and a show's "archive new
episodes automatically" switch. Idempotent."""

try:
    import MySQLdb as provider
except ImportError:
    import pymysql as provider

COLUMNS = (
    ("artist_release", "tracks", "TEXT"),
    ("podcast_channel", "auto_archive", "BOOLEAN NOT NULL DEFAULT false"),
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
        conn.commit()
    finally:
        conn.close()

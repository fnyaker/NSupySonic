# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The navigation rework: a release's tracklist, kept by the releases watcher
so the home lists new TITLES without asking anyone, and a show's "archive new
episodes automatically" switch. Idempotent."""

import sqlite3

COLUMNS = (
    ("artist_release", "tracks", "TEXT"),
    ("podcast_channel", "auto_archive", "BOOLEAN NOT NULL DEFAULT 0"),
)


def apply(args):
    file = args.pop("database")
    with sqlite3.connect(file, **args) as conn:
        c = conn.cursor()
        for table, column, kind in COLUMNS:
            c.execute(f"PRAGMA table_info({table})")
            if column not in {row[1] for row in c.fetchall()}:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
        conn.commit()

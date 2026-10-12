# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""track.youtube_id: the video a YouTube fallback track was fetched from
(deezer/youtube.py). Idempotent, like every column added since 20260808: a
database rewound past it (see tests/test_schema.py) must boot, not fail."""

import sqlite3


def apply(args):
    file = args.pop("database")
    with sqlite3.connect(file, **args) as conn:
        c = conn.cursor()
        c.execute("PRAGMA table_info(track)")
        if "youtube_id" not in {row[1] for row in c.fetchall()}:
            c.execute("ALTER TABLE track ADD COLUMN youtube_id VARCHAR(16)")
        conn.commit()

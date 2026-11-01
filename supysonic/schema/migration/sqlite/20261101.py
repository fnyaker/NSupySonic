# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""track_analysis.embed_version / decided_head: which generation of the pipeline
produced each stage of a track's analysis, so staleness is one SQL count rather
than a walk over sidecar files. Idempotent, like every column added since
20260808."""

import sqlite3


def apply(args):
    file = args.pop("database")
    with sqlite3.connect(file, **args) as conn:
        c = conn.cursor()
        c.execute("PRAGMA table_info(track_analysis)")
        have = {row[1] for row in c.fetchall()}
        if "embed_version" not in have:
            c.execute(
                "ALTER TABLE track_analysis ADD COLUMN embed_version INTEGER NOT NULL DEFAULT 0"
            )
        if "decided_head" not in have:
            c.execute("ALTER TABLE track_analysis ADD COLUMN decided_head VARCHAR(40)")
        conn.commit()

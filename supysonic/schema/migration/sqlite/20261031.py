# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The titles a person does not want to hear (supysonic/dislikes.py), and the
Flow's starting energy. Strictly additive, idempotent."""

import sqlite3


def apply(args):
    file = args.pop("database")
    with sqlite3.connect(file, **args) as conn:
        c = conn.cursor()
        c.execute("PRAGMA table_info(user_taste)")
        if "energy" not in {row[1] for row in c.fetchall()}:
            c.execute("ALTER TABLE user_taste ADD COLUMN energy REAL")
        c.execute(
            "CREATE TABLE IF NOT EXISTS track_dislike ("
            " user_id CHAR(36) NOT NULL REFERENCES user ON DELETE CASCADE,"
            " track_id CHAR(36) NOT NULL REFERENCES track ON DELETE CASCADE,"
            " created DATETIME NOT NULL,"
            " PRIMARY KEY (user_id, track_id))"
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS index_track_dislike_track_id_fk ON track_dislike(track_id)"
        )
        conn.commit()

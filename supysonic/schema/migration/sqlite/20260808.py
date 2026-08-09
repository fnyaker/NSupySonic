# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Repair: make sure podcast_channel.subscribed exists.

``subscribed`` was added by appending to 20260806.sql — a file some servers had
ALREADY applied. The runner skips any migration whose date is not newer than the
recorded schema version, so on those servers the column was never created and
every query touching podcast_channel failed (peewee selects all model fields).

Hence this catch-up, and hence it must be idempotent: on a database that already
has the column (a fresh install, or one that first applied 20260806 after the
edit) it has to do nothing rather than fail the boot.
"""

import sqlite3


def apply(args):
    file = args.pop("database")
    with sqlite3.connect(file, **args) as conn:
        c = conn.cursor()
        c.execute("PRAGMA table_info(podcast_channel)")
        columns = {row[1] for row in c.fetchall()}
        if "subscribed" not in columns:
            c.execute(
                "ALTER TABLE podcast_channel "
                "ADD COLUMN subscribed BOOLEAN NOT NULL DEFAULT true"
            )
        conn.commit()

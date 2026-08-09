# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Repair: make sure podcast_channel.subscribed exists. See the SQLite twin."""

import psycopg2


def apply(args):
    with psycopg2.connect(**args) as conn:
        c = conn.cursor()
        # IF NOT EXISTS is supported here, and says exactly what we mean.
        c.execute(
            "ALTER TABLE podcast_channel "
            "ADD COLUMN IF NOT EXISTS subscribed BOOLEAN NOT NULL DEFAULT true"
        )
        conn.commit()

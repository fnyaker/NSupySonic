# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Repair: make sure podcast_channel.subscribed exists. See the SQLite twin.

MySQL has no portable ``ADD COLUMN IF NOT EXISTS``, so the column list is read
from information_schema first.
"""

try:
    import MySQLdb as provider
except ImportError:
    import pymysql as provider


def apply(args):
    conn = provider.connect(**args)
    try:
        with conn.cursor() as c:
            c.execute(
                "SELECT COUNT(*) FROM information_schema.columns "
                "WHERE table_schema = DATABASE() "
                "AND table_name = 'podcast_channel' AND column_name = 'subscribed'"
            )
            if not c.fetchone()[0]:
                c.execute(
                    "ALTER TABLE podcast_channel "
                    "ADD COLUMN subscribed BOOLEAN NOT NULL DEFAULT true"
                )
        conn.commit()
    finally:
        conn.close()

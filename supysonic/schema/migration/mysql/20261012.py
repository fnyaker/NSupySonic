# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""track.youtube_id. See the SQLite twin; MySQL has no portable
``ADD COLUMN IF NOT EXISTS``, so information_schema is read first."""

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
                "AND table_name = 'track' AND column_name = 'youtube_id'"
            )
            if not c.fetchone()[0]:
                c.execute("ALTER TABLE track ADD COLUMN youtube_id VARCHAR(16)")
        conn.commit()
    finally:
        conn.close()

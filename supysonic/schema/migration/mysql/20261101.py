# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""track_analysis.embed_version / decided_head. See the SQLite twin; MySQL has no
portable ``ADD COLUMN IF NOT EXISTS``, so information_schema is read first."""

try:
    import MySQLdb as provider
except ImportError:
    import pymysql as provider

_COLUMNS = (
    ("embed_version", "INTEGER NOT NULL DEFAULT 0"),
    ("decided_head", "VARCHAR(40)"),
)


def apply(args):
    conn = provider.connect(**args)
    try:
        with conn.cursor() as c:
            for name, ddl in _COLUMNS:
                c.execute(
                    "SELECT COUNT(*) FROM information_schema.columns "
                    "WHERE table_schema = DATABASE() "
                    "AND table_name = 'track_analysis' AND column_name = %s",
                    (name,),
                )
                if not c.fetchone()[0]:
                    c.execute(f"ALTER TABLE track_analysis ADD COLUMN {name} {ddl}")
        conn.commit()
    finally:
        conn.close()

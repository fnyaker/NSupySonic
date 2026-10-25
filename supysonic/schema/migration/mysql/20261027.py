# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Each person's own accounts and what is imported from them (plan
multi-provider §15, lot P2): the account's import options, and every item
already imported or unticked by its holder: each is imported once, and an
unticked one never. Idempotent."""

try:
    import MySQLdb as provider
except ImportError:
    import pymysql as provider

CHARSET = " DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

TABLES = (
    """CREATE TABLE IF NOT EXISTS library_item (
    account VARCHAR(36) NOT NULL,
    kind VARCHAR(12) NOT NULL,
    ref VARCHAR(64) NOT NULL,
    excluded BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (account, kind, ref)
)""",
)

COLUMNS = (("provider_account", "options", "TEXT"),)


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
            for statement in TABLES:
                c.execute(statement + CHARSET)
        conn.commit()
    finally:
        conn.close()

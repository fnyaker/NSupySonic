# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Each person's own accounts and what is imported from them (plan
multi-provider §15, lot P2): the account's import options, and every item
already imported or unticked by its holder: each is imported once, and an
unticked one never. Idempotent."""

import sqlite3

TABLES = """
CREATE TABLE IF NOT EXISTS library_item (
    account VARCHAR(36) NOT NULL,
    kind VARCHAR(12) NOT NULL,
    ref VARCHAR(64) NOT NULL,
    excluded BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (account, kind, ref)
);
"""

COLUMNS = (("provider_account", "options", "TEXT"),)


def apply(args):
    file = args.pop("database")
    with sqlite3.connect(file, **args) as conn:
        c = conn.cursor()
        for table, column, kind in COLUMNS:
            c.execute(f"PRAGMA table_info({table})")
            if column not in {row[1] for row in c.fetchall()}:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
        c.executescript(TABLES)
        conn.commit()

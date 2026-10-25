# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Who may use which provider account (plan multi-provider §15): groups of
people, their members, the grants, and how an account was signed in.
Idempotent, like every migration since 20260808."""

import sqlite3

TABLES = """
CREATE TABLE IF NOT EXISTS user_group (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    created DATETIME NOT NULL
);
CREATE TABLE IF NOT EXISTS user_group_member (
    group_id CHAR(36) NOT NULL REFERENCES user_group ON DELETE CASCADE,
    user_id CHAR(36) NOT NULL REFERENCES user ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS index_user_group_member_user_id_fk ON user_group_member(user_id);
CREATE TABLE IF NOT EXISTS provider_grant (
    provider VARCHAR(16) NOT NULL,
    account VARCHAR(36) NOT NULL,
    feature VARCHAR(16) NOT NULL,
    subject VARCHAR(40) NOT NULL,
    PRIMARY KEY (provider, account, feature, subject)
);
"""

COLUMNS = (("provider_account", "mode", "VARCHAR(16)"),)


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

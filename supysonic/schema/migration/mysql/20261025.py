# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Who may use which provider account (plan multi-provider §15): groups of
people, their members, the grants, and how an account was signed in.
Idempotent, like every migration since 20260808."""

try:
    import MySQLdb as provider
except ImportError:
    import pymysql as provider

CHARSET = " DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

TABLES = (
    """CREATE TABLE IF NOT EXISTS user_group (
    id CHAR(32) PRIMARY KEY,
    name VARCHAR(64) NOT NULL UNIQUE,
    created DATETIME NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS user_group_member (
    group_id CHAR(32) NOT NULL REFERENCES user_group(id) ON DELETE CASCADE,
    user_id CHAR(32) NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id),
    INDEX index_user_group_member_user_id_fk (user_id)
)""",
    """CREATE TABLE IF NOT EXISTS provider_grant (
    provider VARCHAR(16) NOT NULL,
    account VARCHAR(36) NOT NULL,
    feature VARCHAR(16) NOT NULL,
    subject VARCHAR(40) NOT NULL,
    PRIMARY KEY (provider, account, feature, subject)
)""",
)

COLUMNS = (("provider_account", "mode", "VARCHAR(16)"),)


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

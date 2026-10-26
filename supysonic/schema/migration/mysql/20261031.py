# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The titles a person does not want to hear (supysonic/dislikes.py), and the
Flow's starting energy. Strictly additive, idempotent."""

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
                "AND table_name = 'user_taste' AND column_name = 'energy'"
            )
            if not c.fetchone()[0]:
                c.execute("ALTER TABLE user_taste ADD COLUMN energy FLOAT")
            c.execute(
                "CREATE TABLE IF NOT EXISTS track_dislike ("
                " user_id CHAR(32) NOT NULL,"
                " track_id CHAR(32) NOT NULL,"
                " created DATETIME NOT NULL,"
                " CONSTRAINT track_dislike_user_fk FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,"
                " CONSTRAINT track_dislike_track_fk FOREIGN KEY (track_id) REFERENCES track(id) ON DELETE CASCADE,"
                " PRIMARY KEY (user_id, track_id)"
                ") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        conn.commit()
    finally:
        conn.close()

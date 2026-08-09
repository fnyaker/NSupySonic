# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Guards for the two ways schema work goes wrong silently.

Both of these shipped a 500 to production that the rest of the suite could not
see, because the suite runs on SQLite and the deployment runs on Postgres.
"""

import os
import os.path
import re
import tempfile
import unittest

from peewee import SqliteDatabase

from supysonic import db as dbmod
from supysonic.db import (
    SCHEMA_VERSION,
    PodcastChannel,
    Track,
    db,
    init_database,
    release_database,
)

MIGRATION_ROOT = os.path.join(os.path.dirname(dbmod.__file__), "schema", "migration")
PROVIDERS = ("sqlite", "postgres", "mysql")
# Where this fork's own migrations start. Everything older is upstream history,
# which legitimately includes engine-specific migrations.
FORK_EPOCH = "20260605"


def _dates(provider):
    """The migration dates shipped for one engine."""
    folder = os.path.join(MIGRATION_ROOT, provider)
    out = set()
    for name in os.listdir(folder):
        if name[0] in ("_", "."):
            continue
        date, ext = os.path.splitext(name)
        if ext in (".sql", ".py"):
            out.add(date)
    return out


class SchemaVersionTestCase(unittest.TestCase):
    def test_every_engine_ships_this_forks_migrations(self):
        """A migration added for one engine and forgotten for another leaves
        that engine's databases missing a column — which surfaces as a 500 on
        every query touching the table, and only for the people running it.

        Scoped to this fork's own migrations: upstream legitimately ships
        engine-SPECIFIC ones (binary-id conversions for MySQL/SQLite, a
        Postgres-only fix), and those are history we don't police.
        """
        ours = {p: {d for d in _dates(p) if d >= FORK_EPOCH} for p in PROVIDERS}
        # 20260614 is a Postgres-only repair (a citext/collation fix); it has no
        # SQLite or MySQL counterpart by design.
        for p in ("postgres", "mysql"):
            ours[p].discard("20260614")
        for provider in PROVIDERS[1:]:
            self.assertEqual(
                ours[provider],
                ours["sqlite"],
                f"{provider} is missing (or has extra) migrations vs sqlite",
            )

    def test_schema_version_matches_the_latest_migration(self):
        """SCHEMA_VERSION is what decides which migrations still have to run. If
        it lags behind the newest file, that migration never runs; if it leads,
        the version is recorded as done before the work exists."""
        self.assertEqual(SCHEMA_VERSION, max(_dates("sqlite")))

    def test_model_columns_exist_in_the_base_schema(self):
        """A field added to a model but not to schema/<engine>.sql gives a fresh
        install a table it cannot query."""
        for provider in PROVIDERS:
            path = os.path.join(
                os.path.dirname(dbmod.__file__), "schema", f"{provider}.sql"
            )
            with open(path, encoding="utf-8") as fh:
                sql = fh.read()
            for model in (Track, PodcastChannel):
                table = model._meta.table_name
                m = re.search(
                    r"CREATE TABLE IF NOT EXISTS %s \((.*?)\n\)" % table, sql, re.S
                )
                self.assertIsNotNone(m, f"{table} missing from {provider}.sql")
                body = m.group(1)
                for field in model._meta.sorted_fields:
                    column = field.column_name
                    self.assertRegex(
                        body,
                        r"\b%s\b" % re.escape(column),
                        f"{table}.{column} missing from {provider}.sql",
                    )


class QueryShapeTestCase(unittest.TestCase):
    """Python binds `&` tighter than `>`, so

        Track.deezer_id.is_null(False) & Track.last_modification > 0

    builds ``(deezer_id IS NOT NULL AND last_modification) > 0``. SQLite
    evaluates that happily and Postgres rejects it outright, so the mistake
    passes every test here and 500s in production. These assert the SHAPE of the
    SQL, which is engine-independent.
    """

    @classmethod
    def setUpClass(cls):
        if db.obj is None:
            db.initialize(SqliteDatabase(":memory:"))

    def _where(self, expr):
        return Track.select().where(expr).sql()[0].split("WHERE", 1)[1]

    def test_a_comparison_combined_with_and_must_be_parenthesized(self):
        unparenthesized = self._where(
            Track.deezer_id.is_null(False) & Track.last_modification > 0
        )
        # The bug, spelled out: the comparison swallowed the whole AND.
        self.assertTrue(unparenthesized.strip().endswith("> ?)"))

        correct = self._where(
            Track.deezer_id.is_null(False) & (Track.last_modification > 0)
        )
        self.assertIn('("t1"."last_modification" > ?)', correct)

    def test_the_archived_count_query_is_well_formed(self):
        """The actual expression /api/storage runs."""
        where = self._where(
            Track.deezer_id.is_null(False) & (Track.last_modification > 0)
        )
        self.assertIn('("t1"."deezer_id" IS NOT NULL)', where)
        self.assertIn('("t1"."last_modification" > ?)', where)


class MigrationRepairTestCase(unittest.TestCase):
    """The exact failure this repair exists for.

    ``podcast_channel.subscribed`` was added by appending to an ALREADY-RELEASED
    migration file. The runner skips any migration dated at or before the
    recorded schema version, so servers that had applied 20260806 never got the
    column — and every query touching the table 500'd, because peewee selects all
    of a model's fields.

    This reconstructs such a database and checks that booting the current code
    repairs it.
    """

    def setUp(self):
        self.fd, self.path = tempfile.mkstemp(suffix=".db")
        self.uri = "sqlite:///" + self.path

    def tearDown(self):
        release_database()
        os.close(self.fd)
        try:
            os.remove(self.path)
        except OSError:
            pass

    def test_a_database_missing_the_column_gets_it_back(self):
        import sqlite3

        # A current database…
        init_database(self.uri)
        release_database()

        # …rewound to the state the edit left real servers in: 20260807 applied
        # (so `gone` is there) but `subscribed` never created, because the file
        # that would have created it was already marked done.
        conn = sqlite3.connect(self.path)
        conn.execute("ALTER TABLE podcast_channel DROP COLUMN subscribed")
        conn.execute("UPDATE meta SET value = '20260807' WHERE key = 'schema_version'")
        conn.commit()
        cols = {r[1] for r in conn.execute("PRAGMA table_info(podcast_channel)")}
        conn.close()
        self.assertNotIn("subscribed", cols)  # the broken state, reproduced

        # Booting the current code must repair it, not crash on it.
        init_database(self.uri)
        self.assertEqual(PodcastChannel.select().count(), 0)  # the query that 500'd

        conn = sqlite3.connect(self.path)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(podcast_channel)")}
        version = conn.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()[0]
        conn.close()
        self.assertIn("subscribed", cols)
        self.assertIn("gone", cols)
        self.assertEqual(version, SCHEMA_VERSION)

    def test_the_repair_is_idempotent(self):
        """It also runs on databases that already have the column (a fresh
        install, or one that applied 20260806 after the edit): it must do
        nothing rather than fail the boot."""
        import importlib

        _mod = importlib.import_module("supysonic.schema.migration.sqlite.20260808")

        init_database(self.uri)
        release_database()
        # Applying it twice on a database that already has the column.
        for _ in range(2):
            _mod.apply({"database": self.path})
        init_database(self.uri)
        self.assertEqual(PodcastChannel.select().count(), 0)


if __name__ == "__main__":
    unittest.main()

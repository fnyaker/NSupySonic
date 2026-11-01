# Database schema and config & secrets

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: changing the schema/migrations, config options, env vars, or anything near the ARL.

## Database / schema

Peewee ORM. `SCHEMA_VERSION` in `supysonic/db.py` is a date string (currently `20261101`); bump it
and add a migration under `supysonic/schema/migration/{sqlite,postgres,mysql}/` when changing the
schema. SQLite by default; Postgres/MySQL supported. A migration script is split on `;` AFTER its
`--` comment lines are dropped (`db.split_sql_script`): a `;` inside a comment used to cut it in two
and run the second half as SQL, which failed every SQLite upgrade through 20260730.
`tests/test_schema.py` splits every shipped script and requires each piece to be a statement.

## Config & secrets

Two config paths (pick one): env vars in `.env` (simplest — `DEEZER_ARL`, `SUPYSONIC_ADMIN_*`,
`DEEZER_QUALITY`, `DEEZER_SYNC_AT`) consumed by `docker/entrypoint.sh`, or a mounted
`config/supysonic.conf` (full control). The full annotated option set is in `config.sample` and
`config/supysonic.conf.example`.

**The ARL is a full-account credential — treat it like a password.** `.env`, `config/supysonic.conf`,
the SPA `dist/`, and `*.har` API captures (which contain real session tokens) are all gitignored and
excluded from the Docker build context. Never commit them.

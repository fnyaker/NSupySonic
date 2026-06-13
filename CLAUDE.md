# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NSupySonic-Deezer is a fork of [supysonic](https://github.com/spl0k/supysonic) (a Python
Subsonic API server) wired into a **Subsonic ↔ Deezer proxy**. Deezer playlists, favorites,
Flow and new releases appear as native library entries in any Subsonic client, plus there is a
custom Svelte web player at `/app`. Tracks are fetched in FLAC, archived once, and transcoded
to Opus on demand. AGPL-3.0, Python 3.10+.

## Core design rule

**Always archive FLAC, transcode to Opus (320/128/64). NEVER stream MP3 directly from Deezer.**
This applies to both the web player and Subsonic clients. Deezer entities are materialized as
ordinary supysonic DB rows under a dedicated `Deezer` root folder, so supysonic's normal
browse/search/playlist/star endpoints work **unchanged** — only streaming is intercepted.

## Commands

```sh
# Python tests (no network). Discovery is driven by tests/__init__.py load_tests.
python -m unittest                                   # whole suite
python -m unittest tests.test_deezer                 # one module
python -m unittest tests.test_webui.SomeClass.test_x # one test
coverage run -m unittest                             # what CI runs
coverage run -a -m unittest tests.net.suite          # network tests (CI only; hit real services)

# Dev install (a project .venv is expected)
pip install -e . && pip install lxml coverage        # == ci-requirements.txt

# Run the server
supysonic-server                                     # serves on :5722
export FLASK_APP="supysonic.web:create_application()"; flask run   # backend dev server

# Web UI (Svelte SPA)
cd webapp && npm install && npm run build            # -> supysonic/webui/dist (gitignored)
cd webapp && npm run dev                             # hot reload; proxies /api -> localhost:5000

# Deezer CLI
supysonic-cli deezer login-test                      # check the ARL works
supysonic-cli deezer import <deezer-url|track|album|playlist <id>>
supysonic-cli deezer sync                            # import playlists/favorites/new releases

# Docker (full stack: builds SPA + python image, runs entrypoint that creates admin + auto-sync)
docker compose up --build                            # web player at :5722/app, Subsonic at :5722/rest
```

Note: the upstream `tests/` are unittest-based; there is no pytest config. CI runs two
workflows — `tests.yaml` (unittest across py3.10–3.14) and `docker.yaml` (image build).

## Architecture

Three Deezer code layers, from low to high:

1. **`deezerpy/`** — the vendored Deezer client (based on RemixDev's deezer-py). Three transports
   with deliberate reliability roles (learned the hard way; do not "simplify" back to one):
   - `api.py` — **public `api.deezer.com`**. Used for **search**, **recommendations** (editorial
     releases + chart artists/playlists), and **artist pages/radio**. Stable, typed, returns image URLs.
   - `gw.py` — **private gateway `gw-light.php`**. Used for album/playlist/mix pages, lyrics, Flow
     (`radio.getUserRadio`), track radio, favorites & playlist writes, and stream tokens.
   - `graphql.py` — **`pipe.deezer.com`** (`Deezer.gql`). Auths with a JWT minted from the ARL.
     Currently only powers **customizable Flow clusters** (`FlowConfig`/`UpdateFlowConfig`).
   - **Gotcha — full tracklists:** album/playlist *page* calls only return the first ~10–40 tracks.
     Always fetch the full list via `get_album_tracks` (`song.getListByAlbum` nb:-1) /
     `get_playlist_tracks` (`playlist.getSongs` nb:-1).
   - **Gotcha — JWT minting:** `POST https://auth.deezer.com/login/arl?...` (POST, not GET) with the
     session cookies returns JSON `{"jwt": ...}`. An expired/invalid JWT comes back as a GraphQL
     error on HTTP 200 (`Jwt*Error`), so the client re-mints + retries once on any `Jwt*` error.

2. **`supysonic/deezer/`** — the proxy logic:
   - `provider.py` — ARL login + stream decryption; the single object the rest of the app talks to.
   - `archive.py` — `ensure_archived` (first-play fetch → Blowfish-CBC decrypt → tag → store under
     `archive_dir`) and import helpers.
   - `library.py` — DB upsert + deterministic archive paths. `ids.py` — deterministic `uuid5` IDs
     from Deezer IDs (plus nullable `deezer_id` columns on Track/Album/Artist/Playlist).
   - `importer.py` — Deezer → Subsonic sync (writes straight to DB). `push.py` — Subsonic → Deezer
     mirror (star/unstar, playlist CRUD), hooked from `api/playlists.py` & `api/annotation.py`,
     guarded by `push_to_deezer`, fail-soft.
   - `prefetch.py` — background preload of upcoming tracks + the `/api/download` pre-archive worker.
   - `scheduler.py` — auto-sync: full sync on startup (after ~20s) then daily at `sync_at` (04:00)
     or every `sync_interval`, whenever a `sync_user` exists.

3. **`supysonic/webui/`** — the custom `/api` blueprint (`__init__.py`, all routes `@login_required`,
   numeric-id validation on stream/favorite) and `spa.py`, which serves the built Svelte SPA at
   **`/app/`** (hash-routed). Admin UI stays at `/`, Subsonic at `/rest`.

**Streaming interception** lives in `supysonic/api/media.py` (`_ensure_deezer_archived`): first play
archives the FLAC, then the existing transcode/cache/`send_file` path runs unchanged. The permanent
FLAC archive is separate from supysonic's capped `transcode_cache`.

**Web app** (`webapp/`): Svelte 4 + Vite 5 SPA, hash routing (svelte-spa-router), consuming `/api`.
Builds into `supysonic/webui/dist`. No emoji in the UI — all glyphs go through
`src/components/Icon.svelte` (Lucide-style SVG). Home is **card-based** (mixes / recommended
playlists / albums / artists), not track shelves.

## Database / schema

Peewee ORM. `SCHEMA_VERSION` in `supysonic/db.py` is a date string (currently `20260606`); bump it
and add a migration under `supysonic/schema/migration/{sqlite,postgres,mysql}/` when changing the
schema. SQLite by default; Postgres/MySQL supported.

## Config & secrets

Two config paths (pick one): env vars in `.env` (simplest — `DEEZER_ARL`, `SUPYSONIC_ADMIN_*`,
`DEEZER_QUALITY`, `DEEZER_SYNC_AT`) consumed by `docker/entrypoint.sh`, or a mounted
`config/supysonic.conf` (full control). The full annotated option set is in `config.sample` and
`config/supysonic.conf.example`.

**The ARL is a full-account credential — treat it like a password.** `.env`, `config/supysonic.conf`,
the SPA `dist/`, and `*.har` API captures (which contain real session tokens) are all gitignored and
excluded from the Docker build context. Never commit them.

## Tests

All proxy/web tests run offline with mocks: `tests/test_deezer.py` (mock provider),
`tests/test_webui.py` (`MockGW` + `MockApi` cover every `/api` route), `tests/test_graphql.py`
(fake session routing auth-vs-pipe POSTs by host). `tests/net/` hits real services and is CI-only.
Add a test alongside these when touching the proxy or `/api`.

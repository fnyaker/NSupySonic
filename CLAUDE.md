# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NSupySonic is a fork of [supysonic](https://github.com/spl0k/supysonic) (a Python
Subsonic API server) wired into a **Subsonic ↔ Deezer proxy**. Deezer playlists, favorites,
Flow and new releases appear as native library entries in any Subsonic client, plus there is a
custom Svelte web player at `/app`. Tracks are fetched in FLAC, archived once, and transcoded
to Opus on demand. AGPL-3.0, Python 3.10+.

## Core design rule

**Always archive FLAC, transcode to Opus (320/128/64). NEVER stream MP3 directly from Deezer.**
This applies to both the web player and Subsonic clients. Deezer entities are materialized as
ordinary supysonic DB rows under a dedicated `Deezer` root folder, so supysonic's normal
browse/search/playlist/star endpoints work **unchanged** — only streaming is intercepted.

## Engineering principles (definition of done)

Before considering **any** change finished — in this session or any future Claude Code session —
run it through these questions. They are not optional polish; they are the bar.

1. **Does it break anything else?** Trace the logic you're touching end to end. What else reads
   this state, subscribes to this store, or depends on this DOM shape? (E.g. windowing a list
   breaks any code that `querySelector`s a row that may no longer be mounted — provide an
   index-based path instead.) Prefer changes that keep the observable result identical.
2. **Is it fast, optimized, fluid?** Think about the worst realistic input, not the happy path
   (a 4000-track "play all favorites" queue, not a 12-track album). Avoid O(n) work on every
   update and unbounded DOM/network fan-out. Long lists must be **windowed/virtualized**
   (`components/VirtualList.svelte`, `components/TrackList.svelte`), never rendered whole.
3. **Same result, faster tech?** If a different approach yields the *exact same* end result but
   is materially faster/lighter, choose it — don't add an artificial throttle when the real fix
   is to not do the work at all (render only what's visible).
4. **Security.** Are the endpoints this touches properly protected (`@login_required`, numeric-id
   validation, quota/ownership checks)? What happens on hostile or random input — does anything
   leak, crash, or return data it shouldn't? Never trust client-supplied ids/paths. Never commit
   secrets (the ARL is a full-account credential).
5. **Reliability & UX.** Fail soft where a feature is best-effort; keep the UI responsive and the
   result pretty. Test the change by actually exercising it, not just building.
6. **Coherence with what the user actually wants.** Before shipping, picture the user in front of
   it: what will they *do* with this? Does it truly answer their need, or just technically match
   the words of the request? Will using it feel good — or are there irritating friction points
   (controls too cramped, targets too small, a fader glued to its neighbour)? If so, fix them
   *now*, not after they complain. Sweat the spacing, rhythm, alignment and feel.
7. **Premium bar.** Every screen should look and feel like a team of senior engineers and
   designers sweated it — top-of-the-top, not "good enough". No cramped or default-looking UI, no
   emoji (glyphs go through `Icon.svelte`). When a layout feels off, it *is* off; keep iterating
   until it reads as considered and effortless.

## Commands

```sh
# Python tests (no network). Discovery is driven by tests/__init__.py load_tests.
python -m unittest                                   # whole suite (~90s)
python -m unittest tests.test_deezer                 # one module
python -m unittest tests.test_webui.SomeClass.test_x # one test
coverage run -m unittest                             # what CI runs
coverage run -a -m unittest tests.net.suite          # network tests (CI only; hit real services)

# Same suite across processes — ~25s on 4 cores. Takes the same test ids.
python tools/partest.py                              # whole suite
python tools/partest.py -j8 tests.test_webui
python tools/partest.py --coverage && coverage combine

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
supysonic-cli deezer lyrics [--overwrite] [--limit N]  # archive synced lyrics for archived tracks

# Docker (full stack: builds SPA + python image, runs entrypoint that creates admin + auto-sync)
docker compose up --build                            # web player at :5722/app, Subsonic at :5722/rest
```

Note: the upstream `tests/` are unittest-based; there is no pytest config.
`tests/__init__.py` swaps argon2 for cheap parameters — hashing was half the
suite's wall clock — which is test-only and guarded by a test that pins the
production defaults. CI runs three
workflows — `tests.yaml` (unittest across py3.10–3.14), `docker.yaml` (image build) and
`android.yaml` (native app APK, uploaded as a run artifact / attached to `v*` releases).

## Android app

`android/` is a native Kotlin app: a fullscreen WebView hosts the SPA (`<server>/app/`,
configured at first launch: URL + optional port + SSL-verify toggle for self-signed certs)
while `PlayerService` (foreground service + MediaSessionCompat) keeps the process alive in
the background and owns the media notification / lockscreen / Bluetooth controls. Audio
stays in the WebView — the native side is only a remote control + keep-alive. The bridge is
`android/app/src/main/assets/nsshim.js`, injected at document start: it REPLACES
`navigator.mediaSession` and forwards the metadata/playbackState/positionState/action-handlers
that `Player.svelte` already maintains to `window.NSNative.publish()`, and routes transport
commands back via `window.__nsNativeCmd()`. No webapp-side code is involved, so the app works
against any deployed SPA version. Build: `gradle -p android assembleRelease` (JDK 17, SDK 34 —
CI does this; no wrapper is committed).

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
   - `lyrics.py` — archive synced lyrics as a `.lrc` sidecar next to each archived audio file
     (+ embedded plain text in the tags), sourced best-first from **Deezer's own** lyrics then the
     public **LRCLIB** API (https://lrclib.net); synced wins over plain. `ensure_lyrics` is called on
     archive and on first `/api/lyrics` view; `backfill_archived_lyrics` (CLI `deezer lyrics`)
     backfills every already-archived track that lacks a sidecar.
   - `prefetch.py` — background preload of upcoming tracks + the `/api/download` pre-archive worker.
   - `scheduler.py` — auto-sync: full sync on startup (after ~20s) then daily at `sync_at` (04:00)
     or every `sync_interval`, whenever a `sync_user` exists.

**Resilience rules (learned from a production outage — do not regress):**
- Every upsert in `library.py` is a check-then-insert, which is **not atomic**. Concurrent plays of
  the same album race and the loser gets a unique-constraint violation (and, on Postgres, a poisoned
  transaction). All of them go through `library.create_or_get` (insert inside its own
  `db.atomic()` → savepoint, then read the winner's row back). Keep any new upsert on that path.
- `deezerpy` requests carry a **default timeout** (`deezerpy.DEFAULT_TIMEOUT`, applied by `_Session`)
  — `requests` has none, and one black-holed socket parks a server thread until the gunicorn worker
  is killed. Never build a bare `requests.Session()` for Deezer.
- The `/api` blueprint has a catch-all error handler: an unforeseen failure becomes a JSON 500 with
  the traceback in the log, never an HTML page the SPA can't parse.
- The ARL can die at any moment. `DeezerProvider.check_login()` is the cached health check and
  distinguishes `"arl"` (credential dead — admin action) from `"network"` (says nothing about it);
  `/api/deezer/status` surfaces it and the SPA raises a notice (`lib/deezerhealth.js`).

3. **`supysonic/webui/`** — the custom `/api` blueprint (`__init__.py`, all routes `@login_required`,
   numeric-id validation on stream/favorite), `share.py` (waveform peaks + full-file/ffmpeg-clip
   downloads for the SPA's share sheet, all cached) and `spa.py`, which serves the built Svelte SPA at
   **`/app/`** (hash-routed). Admin UI stays at `/`, Subsonic at `/rest`.

**Streaming interception** lives in `supysonic/api/media.py` (`_ensure_deezer_archived`): first play
archives the FLAC, then the existing transcode/cache/`send_file` path runs unchanged. The permanent
FLAC archive is separate from supysonic's capped `transcode_cache`.

**Podcasts** are Deezer *shows*/*episodes*, kept in dedicated `PodcastChannel`/`PodcastEpisode` tables
(not Track rows — episodes have no artist/album and map onto Subsonic's podcast types). The gw methods
(`deezer.pageShow`, `show.add/deleteFavorite`, `episode.bookmarkSet`) were confirmed from a HAR capture;
see `docs/plan-podcasts.md`. Episodes stream as **plain MP3 straight from the podcast host** (no FLAC,
no Blowfish — `provider.download_episode_to` just follows redirects), archived under
`archive_dir/Podcasts/<Show>/` on first play. Subsonic endpoints live in `supysonic/api/podcast.py`
(`getPodcasts`, `getNewestPodcasts`, `createPodcastChannel`, `refreshPodcasts`, `delete*`,
`downloadPodcastEpisode`); `media.py` resolves a stream/download id to a Track **or** a `PodcastEpisode`.
The local channel rows are the source of truth for subscriptions; `importer.sync_podcasts` refreshes them.
Per-user playback state is server-side: `PodcastProgress` (auto-saved position, `finished` flag) and
`PodcastMarker` (manual bookmarks) via `/api/podcast/progress` + marker CRUD; the SPA merges them with
its localStorage copy newest-wins (`webapp/src/lib/podcastProgress.js`), and the admin's positions are
mirrored to Deezer (`episode.bookmarkSet`) fail-soft.

**Unavailable tracks** (`supysonic/webui/availability.py`): Deezer drops tracks from its catalogue,
and `Track.unavailable` (a timestamp, so a verdict expires and is re-tested) records the ones we
have confirmed dead. The verdict is only ever set from `TrackUnavailable` — the dedicated exception
`provider._resolve_once` raises when Deezer *answers* that there is no source — never from a network
error, and never before a re-login has confirmed it (an expired media licence token looks exactly the
same). **Archiving clears it**: once the FLAC is on disk the track plays forever, whatever Deezer
does, which is why the probe checks the file before asking anyone. `/api/track/<id>/probe` is what the
player calls the moment playback errors (the `<audio>` element can't tell a dead track from a dropped
packet), so a dead track is skipped at once instead of after four reloads. `/api/replace` swaps a
track for another one — same position in every playlist, plus favourites — in a worker thread, and
mirrors it to Deezer for the admin's own playlists.

**Unavailable means BOTH sources are gone** — not "Deezer dropped it". `DELETE /api/track/<id>` is
the third answer next to replace-and-upload, and `availability.verify_gone` re-checks *at the moment
of deletion*: a file on disk → refuse (and clear the verdict); Deezer still resolves → refuse; an
inconclusive network answer → refuse. Only `TrackUnavailable` with no file, or a local upload whose
file is gone, authorises it. Scoped like a replacement (own playlists/favourites; an admin also drops
the row, `recursive=True`) and mirrored to Deezer for the admin, fail-soft.

**An archived track carries its whole identity on disk**, which is what makes the above safe:
`_finalize_archive` writes the audio, `cover.jpg`, the `.lrc` lyrics, the file tags, **refreshes the
DB row from the authoritative `song.getData` payload** (`library.refresh_track_metadata` — rows are
often created from a thinner playlist listing, and it only ever upgrades fields), and writes a
`<track>.json` sidecar (`library.save_track_metadata` / `read_track_metadata`) with the Deezer ids,
contributor roles and ISRC that no audio tag can hold. That sidecar is a **whitelist** of gw fields —
the raw payload also carries stream tokens and signed URLs, which must never be written to a file
that outlives the session.

**Archive completeness** (`supysonic/deezer/backfill.py`, `supysonic/webui/storage.py`) is
**event-driven, never polled**. Archiving happens the moment something becomes yours:

- *playing* it (the FLAC stream is teed to disk by `archive.open_live_stream`, `on_abort` re-queues
  it if the client disconnects; the Opus path and `api/media.py::_ensure_deezer_archived` call
  `ensure_archived` outright; podcast episodes archive on first play too);
- *starring a track* (`/api/favorite`, and Subsonic's `star` via `annotation._archive_starred`);
- *favouriting an album, a playlist or an artist* (`/api/favorite/<kind>` and Subsonic's `star` →
  `backfill.archive_entity`, in a worker thread, always the FULL tracklist — never the ~10-track
  page). An **artist means the whole discography**: `_archive_discography` walks Deezer's `all` tab
  (official releases + "more", not the guest appearances), fed release by release so the first album
  downloads while the rest is still being listed, and deduplicated across editions;
- *adding tracks to a playlist* or creating one (`/api/playlists`, `/api/playlist/<id>/tracks`, and
  Subsonic's `createPlaylist`/`updatePlaylist`);
- *subscribing to a show* (`/api/podcasts` POST → `backfill.archive_show`, every episode).

Everything goes through the bounded background download queue (`prefetch.download_ids` /
`download_episode_ids`) and is fail-soft: archiving is a *consequence* of the action, never a
condition for it. Rows already on disk are filtered out first, so re-starring a big library costs
nothing. A discography is bigger than the queue, so `backfill._queue_all` waits for room
(`QUEUE_RETRY_DELAY`) instead of dropping the overflow — it gives up only if `archive_library` is
switched off under it. **Do not add a periodic archive loop** — the app knows the instant it
happens, so re-asking on a timer is work for nothing.

The nightly sync then runs `sweep_for` as the *safety net* for what events can't see (a Deezer-side
change we only learn about at sync time, a download that failed while the server was down), and
Réglages → Compte has the same sweep as a button with live progress; `_sweep_lock` keeps them from
running twice at once. All of it is gated by `[deezer] archive_library` (default on, checked in
`backfill.archiving_enabled` so the switch silences the events too) and **only ever adds**.
`/api/storage` reports archive size, free disk and the two derived caches; `/api/cache/flush` empties
those caches (expiring the protection first, or the button would silently do nothing) and cannot
touch `archive_dir`.

**Archive rules** (`supysonic/deezer/rules.py`, `/api/archive/rules`, Réglages → Archive) make all of
the above configurable at runtime: one boolean per event (`rules.EVENTS`), the artist scope
(`all` / `releases` / `top` + `artist_limit`), and the cleanup policy. Values live one-per-row in
`Meta` under the `dz.` prefix (`Meta.key` is `CharField(32)` — keep names short) and override the
config file, exactly like the ARL; `rules.load` caches for a second because it is read on every star
and every play. `archive_library` stays the master switch above all of them. There is deliberately no
`on_play` switch — playing a Deezer track *must* archive it, since the Opus transcode reads the
archived FLAC; what is optional is `on_play_context` (playing one track pulls its whole album or
playlist, opt-in, deduplicated per container per hour by `backfill._first_time_seen`).

**Local play counts.** `/api/listen` writes `Track.play_count` / `last_play` (≥20 s counts, a skip
doesn't). Before that only Subsonic's `scrobble` did, so a library played entirely through the web
app looked untouched — and the cleanup decides what to drop from exactly this data.

**Cleanup** (`supysonic/deezer/cleanup.py`) is the **only** code in the project that deletes archived
audio. It is off by default, needs a free-space floor (`clean_min_free_gb`) to do anything, and is
event-driven like the rest — `prefetch._check_space` looks right after a download, the one moment the
archive can have crossed the floor. Guarantees that are **not** configurable: only rows with a
`deezer_id` are eligible (an upload exists nowhere else — deleting it destroys the only copy), and
the Track row survives, so the title keeps its place in every playlist and re-archives on the next
play (`last_modification = 0` is what marks it "not archived" everywhere). Configurable: what is
protected (favourites / playlist tracks / podcasts, all on), the staleness window, and the deletion
priority (`CLEANUP_ORDERS`). `/api/archive/cleanup/preview` shows exactly what would go, in order,
before anything does.

**Nothing else deletes an archive.** Unsubscribing from a podcast keeps every archived episode: the
channel is flagged `subscribed = False` instead of being deleted (only a show with nothing on disk is
removed), and Subsonic's `deletePodcastEpisode` reports success without touching the file. Same rule
for tracks: the importer keeps archived tracks Deezer stopped returning. And when a WHOLE show leaves
Deezer, `provider.get_show_page` raises `ShowUnavailable` (Deezer answering, never a network error),
the sync sets `PodcastChannel.gone` and the channel becomes a **local podcast**: episodes, art
(`library.save_show_cover` archives a `cover.jpg` beside the audio) and playback all come off disk,
and the sync stops asking about it until the verdict ages out (`importer.GONE_RECHECK`, 7 days).

**Web app** (`webapp/`): Svelte 4 + Vite 5 SPA, hash routing (svelte-spa-router), consuming `/api`.
Builds into `supysonic/webui/dist`. No emoji in the UI — all glyphs go through
`src/components/Icon.svelte` (Lucide-style SVG). Home is **card-based** (mixes / recommended
playlists / albums / artists), not track shelves. Podcasts have their own pages
(`routes/Podcasts.svelte` grid + subscribe, `routes/Show.svelte` episode list) consuming
`/api/podcasts`, `/api/podcast/<id>` and streaming episodes through `/api/stream/<episode-uuid>`
(an episode is shaped like a track whose `deezer_id` is its UUID, so the existing queue/player
plays it unchanged). Sharing goes through `components/ShareSheet.svelte` (global modal, opened via
`openShare(track)` from stores.js): whole file or an excerpt selected on a zoomable canvas waveform
(peaks from `/api/share/waveform`), cut server-side by `/api/share/clip` and handed to the Web Share
API (download fallback). Podcast markers live in `lib/markers.js`.

**Offline & versioning** (the SPA is an *install*, not a page — treat it as one):
- `public/sw.js` serves the shell **cache-first** (an instant launch on any network) and stages a new
  build on demand: it fetches the new `index.html` + every asset it references and only then
  publishes the shell, so an interrupted update leaves the previous *complete* build in place. It
  never touches `/api` or audio.
- `lib/appversion.js` is the other half: the bundle's own id (`__APP_BUILD__`, injected by
  `vite.config.js`, also written to `dist/version.json`) is compared with the server's
  (`/app/version.json`, never cached). Different → stage in the background → reload (automatically
  only within the first 90 s of a session, otherwise via a notice; guarded against reload loops).
  It also does the **startup-only** Android update check (`window.NSNative.appVersion()` vs
  `/api/version`'s `android.version`).
- `lib/reconcile.js` merges a refetched list into the one on screen (identity preserved for
  unchanged rows) — playlists and favourites paint from the offline cache first and the network copy
  is reconciled in, never swapped wholesale. `lib/actions.js#warmPlaylists` pulls every playlist's
  tracklist into the offline cache in the background, one at a time.
- Persistent, actionable messages go through the `notices` store + `components/Notices.svelte`
  (toasts are for transient confirmations only).
- Cover art: a cached blob (`offlineCovers`, keyed resolution-independently by `coverKey`) is the
  **preferred** source in `Cover.svelte`, not a fallback — it's the server's archived 1000px art, so
  waiting for a CDN request to fail first is pure delay. Anything you play caches its cover
  (`playcache.cacheCoverFor`), so hi-res art works offline for everything you've listened to.

## Database / schema

Peewee ORM. `SCHEMA_VERSION` in `supysonic/db.py` is a date string (currently `20260807`); bump it
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

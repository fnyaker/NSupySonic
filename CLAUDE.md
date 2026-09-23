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
cd webapp && npm test                                # node --test: the analysis DSP, the animation catalogue/skins/drivers, the scope, the genre trainers, the cover loader.
                                                     # No test framework — but run the npm install above first: the modules under
                                                     # test reach svelte/store via stores.js, and a pretest guard says so in one line.
cd webapp && node test/render/run.mjs --world forge --genre frenchcore --bpm 200   # render bench: contact sheet in test/render/out/
cd webapp && node test/render/run.mjs --check        # every world, held to the picture contracts (headless Chromium, no GPU needed)

# Deezer CLI
supysonic-cli deezer login-test                      # check the ARL works
supysonic-cli deezer import <deezer-url|track|album|playlist <id>>
supysonic-cli deezer sync                            # import playlists/favorites/new releases
supysonic-cli deezer lyrics [--overwrite] [--limit N]  # archive synced lyrics for archived tracks
supysonic-cli deezer analyze [--force] [--limit N] [--workers N]  # measure tempo + style for archived tracks
supysonic-cli deezer embed [--force] [--limit N]       # extract genre embeddings (needs onnxruntime)
supysonic-cli deezer embed --self-test                 # check the mel front-end without a reference

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

**Surviving a long background stay.** Everything the app *is* — the audio, the queue, the UI —
lives in the WebView's renderer process, which Android may kill whenever nobody is looking at it;
the app process itself is only safe while the foreground service is up (it isn't, once playback
wound down or the paused notification was swiped away). A killed renderer leaves a WebView that
can only ever show a blank page again, which is why "paused in the background too long" used to
mean "restart the app". So MainActivity **rebuilds** the WebView (`rebuildWebView`, on the screen
`doUpdateVisitedHistory` last saw) instead of restarting the activity, and does it **when the user
comes back**, never in the background — a background reload can fail (off the home LAN) and park
the app on an error screen, and the renderer it builds is just as killable. `onRenderProcessGone`
therefore only flags `pendingRebuild` (and drops the now-dead media notification); `onResume`
rebuilds it, retries a load that failed while we were away, and — after a long absence, and only
while nothing is playing — pings the page and rebuilds it if it doesn't answer, which is the one
thing that catches a renderer wedged rather than killed. The SPA persists its session, so a
rebuilt page comes back on the same track at the same position. Having actually caught Android
doing it is also the only moment the app offers the battery-optimization exemption
(`offerBatteryExemptionOnce`, once ever) — the setup screen keeps the same button.

**Linking the Deezer account from the app** (`DeezerLoginActivity`): there is no email/password
endpoint left that a server could call — Deezer's web one (`ajax/action.php` + reCAPTCHA) answers
403 since 2024, and the mobile gateway (`mobile_userAuth`, which *does* return an ARL) needs keys
extracted from Deezer's own binaries. So the only remaining path to an ARL is a real browser
session, and the app provides one: a throwaway WebView loads **Deezer's own login page**, the user
signs in there, and the `arl` cookie Deezer sets is read out of the jar and handed back through
`window.__nsDeezerArl` to `Réglages → Compte Deezer`, which saves it via `/api/settings` (already
validating + probing it). **The password never reaches the app or the server**; only the ARL
crosses back, and only to a page served by the configured server (`MainActivity.deliverArl` checks
the origin). That WebView gets **no `NSNative` bridge**. The Deezer jar is wiped on entry (so the
ARL is always the account just typed) and again on success (no second copy left on the device) —
scoped to `deezer.com`, never `removeAllCookies()`, which would log the user out of their own
server. Cookie arrival is polled (~600 ms, only while the screen is up): Deezer's login is an XHR,
so no navigation fires and there is no cookie-change callback to hook. Google/Apple SSO is refused
inside any WebView — email + password is the supported route. SPA side: `lib/nativeDeezer.js`.

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

**Resilience rules (learned from a production outage — do not regress).** The governing rule:
**Deezer is optional to the app running.** Everything on disk — playing archived music, browsing,
playlists, favourites, uploads, the SPA itself — must keep working at full speed while Deezer is
unreachable, and the parts that do need Deezer must fail *fast* and *without a verdict*.

- Every upsert in `library.py` is a check-then-insert, which is **not atomic**. Concurrent plays of
  the same album race and the loser gets a unique-constraint violation (and, on Postgres, a poisoned
  transaction). All of them go through `library.create_or_get` (insert inside its own
  `db.atomic()` → savepoint, then read the winner's row back). Keep any new upsert on that path.
- `deezerpy` requests carry a **default timeout** (`deezerpy.DEFAULT_TIMEOUT`, applied by `_Session`)
  — `requests` has none, and one black-holed socket parks a server thread until the gunicorn worker
  is killed. Never build a bare `requests.Session()` for Deezer, and never pass a *scalar* timeout
  (that applies the whole budget to the connect phase alone).
- **Latency, not errors, is what an outage takes the app down with.** Every call blocking for the
  timeout parks a thread; enough of them and the worker runs out of threads and of file descriptors
  (`Errno 24`), and the app is down for everyone — including the users who never needed Deezer. So:
  - `deezerpy/_circuit.py` holds a **per-host circuit breaker** on the shared `_Session`. After a
    few *transport* failures a host is short-circuited: further calls raise `DeezerUnavailable`
    instantly instead of paying the timeout, until a cooldown elapses and one probe is let through.
    Per host on purpose (a rate-limited `api.deezer.com` must not stop playback from the CDN); only
    transport failures count (an HTTP error or a gateway error payload is Deezer *answering*).
  - `api_call` in `api.py`/`gw.py` retries against a **wall-clock budget** (`NET_BUDGET`), not just a
    count, and never retries a short-circuited call. Their non-network replays (CSRF refresh,
    gateway `FALLBACK`) are bounded too — they used to recurse without limit.
  - `DeezerProvider.available()` is the instant, no-network "is it worth calling Deezer?" read.
    `_dz_api()` / `_dz_live()` in the webui are the route-level version: they return `None` instead
    of raising, so a route drops to its database answer at once. **Reading `provider.dz` logs in**,
    so touching it outside a `try` is how an outage became a 500 — go through those helpers.
  - A failed login is not retried on every request (`_login_retry_at` backoff), and a re-login
    `close()`s the old client so its connection pool goes back to the OS.
- **A failure to reach Deezer is never a verdict about the data.** `TrackUnavailable` and
  `ShowUnavailable` condemn a track / retire a subscription, and the user is then offered to replace
  or delete it — so they may only be raised when Deezer *answered*. `errors.is_transport_failure()`
  (which walks the `__cause__` chain) is the test; `provider.resolve` downgrades any unconfirmed
  verdict to a plain `DeezerError`, and `_url_from_info` raises rather than reporting "no source"
  when it could not ask.
- Background work backs off instead of burning through itself: the download queue waits out the
  breaker's cooldown (`prefetch._outage_wait`, and *only* while a circuit is actually open) rather
  than failing every queued id in seconds, and the scheduler postpones a sync while Deezer is
  unreachable (the local scan still runs).
- **Podcast episode URLs come from third-party feeds**, so `check_public_url` refuses anything but
  http(s) to a public address — and then the fetch **connects to the address it just validated**
  (`_PinnedAddressAdapter`, via requests' `build_connection_pool_key_attributes`). Checking the
  *name* alone can never be enough: the guard resolves it and the HTTP client resolves it again, so
  a resolver that answers differently the second time (DNS rebinding) walks straight past a
  name-based check and its answer gets archived and served by `/api/stream`. The pin moves the TCP
  connection only — SNI, certificate validation and the `Host` header still carry the real hostname
  — and it walks the host's addresses itself, since pinning gives up the fail-over
  `create_connection` does for free. It steps aside when a proxy is configured (the proxy does the
  resolving, and it is the operator's boundary).
- `socket.getaddrinfo` takes no timeout, and glibc's defaults make one stalled lookup 20s+.
  `requests` folds DNS into its connect timeout, so the session is covered — but the podcast SSRF
  pre-flight (`check_public_url`) resolves *before* requests is involved, once per redirect hop, on
  a host a third-party feed chose. It goes through `provider.resolve_addresses`: a deadline, a
  short-lived cache (positive *and* negative, so the next caller never re-pays a timeout), and a
  bounded set of **daemon** lookup threads — a `ThreadPoolExecutor` would be joined at interpreter
  exit and one wedged name would hang the shutdown of the worker being recycled because of it.
- The `/api` blueprint has a catch-all error handler: an unforeseen failure becomes a JSON 500 with
  the traceback in the log, never an HTML page the SPA can't parse.
- The ARL can die at any moment. `DeezerProvider.check_login()` is the cached health check and
  distinguishes `"arl"` (credential dead — admin action) from `"network"` (says nothing about it);
  `/api/deezer/status` surfaces it, with `retry_in`, and the SPA raises a notice
  (`lib/deezerhealth.js`) — an actionable one for the credential, an explanatory one ("your
  downloaded library is still there") for an outage, re-checked when the server says it will retry.

3. **`supysonic/webui/`** — the custom `/api` blueprint (`__init__.py`, all routes `@login_required`,
   numeric-id validation on stream/favorite), `share.py` (waveform peaks + full-file/ffmpeg-clip
   downloads for the SPA's share sheet, all cached), `edges.py` (where a file's audio starts and
   stops, for the crossfade), `analysis.py` (serving the whole-track verdict) and `spa.py`, which serves the built Svelte SPA at
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
mirrors it to Deezer for the admin's own playlists. It then **retires the source**
(`_retire_replaced`): a row that is flagged unavailable, has no file, and is referenced by no
playlist and no favourite is deleted — otherwise the corpse stayed listed under "Indisponibles" for
ever with nothing left to replace. Narrow on purpose, since `/api/replace` accepts any source. The
SPA mirrors that timing: the work is a worker thread, so the list is dropped optimistically
(`resolvedUnavailable`) and refetched only once the job reports done (`unavailableVersion`) —
refetching on sheet-close re-read the old state and the row flickered back.

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

Everything goes through the bounded, **priority-ordered** background download queue
(`prefetch.download_ids` / `download_episode_ids`, see the priority section below) and is fail-soft:
archiving is a *consequence* of the action, never a condition for it. Rows already on disk are filtered out first, so re-starring a big library costs
nothing. A discography is bigger than the queue, so `backfill._queue_all` waits for room
(`QUEUE_RETRY_DELAY`) instead of dropping the overflow — it gives up only if `archive_library` is
switched off under it. **Do not add a periodic archive loop** — the app knows the instant it
happens, so re-asking on a timer is work for nothing.

**A person waiting in front of the app outranks every background job**
(`supysonic/deezer/workload.py`, `webapp/src/lib/ladder.js`, `webapp/src/lib/coverqueue.js`). That
rule needs a mechanism per kind of contention, and all of them exist because the app once queued a
user's own requests for thirty seconds behind work they never asked for:

- **Request threads.** The server answers from one worker × 16 threads, and a first play of a Deezer
  track holds one of them for as long as the FLAC takes. The client PREFETCHES through the same
  route, so a handful of prefetches took the whole pool. A request nobody is looking at says so
  (`X-NS-Background: 1`, or `?bg=1`) and is held to a quarter of the pool; over that it is
  **refused** (503 + `Retry-After`), never queued — a background request that waits is still holding
  the thread it was meant not to hold, and the client reads the refusal as "not cached yet". A
  background `/api/stream` of a not-yet-archived track never downloads inline at all: it queues the
  archive at prefetch priority and answers at once.
- **Download slots.** `workload.Priority` orders one queue serving three urgencies — `USER` (0),
  `PREFETCH` (5), `BULK` (9, the default). The client says **why** it wants a track (`why` on
  `/api/download`), never how urgent it is, and an unknown reason is bulk, so nothing can claim the
  front by accident. Bulk workers also `quiet_wait` while a foreground archive is in flight (one
  link, one Deezer session, one disk head).
- **CPU.** `workload.renice` puts the archive workers and every batch job behind everything else,
  and `workload.cpu_workers` sizes a library-wide job from the machine (half its cores) rather than
  asking the operator.
- **The client's own ladder** (`lib/ladder.js`): a track change used to fire seven requests at once.
  Now the audio goes first; the artwork, the genre verdict, the lyrics, the silence bounds and the
  play count wait until the element can play and then run **one at a time**; the prefetch of the
  next track waits for the same signal. Caching the artwork before telling the media session about
  it is also what stopped the same cover being fetched twice per track change.
- **Artwork** (`lib/coverqueue.js`): four covers in flight, each freed slot going to whichever
  waiting cover is closest to the viewport, with the scroll direction counted as closer. Art that
  costs no request (above the fold, or already on the device) never queues, and everything degrades
  to "just load it" — a missing picture is worse than an unordered one.

Worker recycling (`GUNICORN_MAX_REQUESTS`) is **off by default**: the hours-long library jobs run on
threads inside the worker, and recycling killed them mid-run.

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

**Search leads with the titles**: the "Tout" tab is ten tracks, then a shelf of albums, then
artists, playlists and podcasts — a search is usually for a song, and the shortlist has to be the
first thing on screen rather than something you scroll past two shelves to reach. Each section
carries a "Tout afficher" that switches to its own tab (the track one shows the full count).

**Swipe a track row right to queue it next** (`components/TrackRow.svelte`, touch only). Same
gesture language as the now-playing sheet: arm on touchstart, commit to an axis after ~10px, and
leave a gesture that locks to "y" entirely to the scroller. The row slides and the strip it vacates
on the LEFT is what shows the action — drawn there rather than behind the row, so the row needs no
opaque background of its own and nothing has to match whatever page background (gradient header
included) it sits on. Deliberately wordless: the strip is ~64px wide at the point it commits, and
any honest label gets clipped to a word naming a different action ("Lire ensuite" → "Lire"); the
toast on release says it in full. A gesture starting on a control belongs to that control, one
starting at the very left edge is left to iOS's own back gesture, and a drag swallows the click the
browser synthesises from it.

**Back goes to the SCREEN, not the route** (`lib/nav.js`): hash routing gives real history, but the
router destroys a page's component state on the way out and rebuilds it empty on the way in — so
coming back from an album landed you at the top of a blank search page. Every history entry gets an
id stamped into `history.state`, and against it nav.js keeps the scroll offset plus a scratch object
the screen fills in (`rememberScreen` / `recallScreen`: the search query + results + tab, the
Library tab and playlist filter, the Artist tab). Only a *traversal* gets that state back — a fresh
push onto the same route starts clean, so tapping "Rechercher" in the nav still gives an empty box.
Two traps are already paid for: the router's own hashchange listener is registered at import time
and builds the new screen synchronously inside it, so nav.js resolves the current entry **lazily**
(`syncEntry` on every entry point) rather than racing listeners; and a scroll restore must **settle**
(the offset holding on a page whose height stopped moving) instead of stopping at the first frame it
fits, because popstate lands one task before hashchange and those first frames can still be
measuring the page being left.

**Offline & versioning** (the SPA is an *install*, not a page — treat it as one):
- `public/sw.js` serves the shell **cache-first** (an instant launch on any network) and stages a new
  build on demand: it fetches the new `index.html` + every asset **the build manifest lists** and
  only then publishes the shell, so an interrupted update leaves the previous *complete* build in
  place. It never touches `/api` or audio. The manifest (`assets` in `dist/version.json`, written by
  `vite.config.js#buildStamp` from the emitted bundle) is what makes code-splitting safe: scraping
  `href=`/`src=` out of `index.html` finds only what Vite statically preloads and says nothing about
  a chunk reached through a dynamic `import()`, so a lazily-loaded route would install, go offline,
  and then fail the first time somebody opened it. The HTML scrape is kept as the fallback, for an
  older server whose `version.json` has no `assets`.

**The heavy screens load when they are opened.** Everything on the first screen is in the main
bundle and worth being there; three things are not, and together they were a third of what every
visitor downloaded, parsed and compiled before the first note played — which is the "the whole app
got slower" this answers. **Réglages** carries the animation catalogue, **the genre studio** carries
a WebAssembly trainer, and **the projector** is a screen most people never open, so all three are
`wrap({ asyncComponent })` routes. The scene modules are split the same way: `lib/viz/index.js`
imports a scene on demand and `createScene` returns a PROMISE (a caller must cope with the scene
arriving late and with the mode having changed again — `Visualizer.svelte` holds a token per build
for exactly that). Two files exist only to keep the catalogue OFF the critical path:
`lib/viz/modes.js` is the registry with no scene imports (the now-playing screens were dragging the
whole scene tree in for two constants) and `lib/viz/worlds/catalogue.js` is each world's name and
blurb without the shader that draws it, because `skins.js` and the settings gallery only need to
know an id is real. Every world is its own chunk (one literal `import()` each in
`worlds/index.js`), fetched the first time it is on screen. Rollup hoists a module two chunks share
into their common parent, so ONE static importer left in the main graph puts the whole tree back:
`palette.js` and the settings panel therefore load `skins.js` and the catalogue dynamically. Measured,
main bundle **656 kB → 457 kB** (223 → 158 kB gzipped), CSS **128 kB → 85 kB**; the GL engine is a
55 kB chunk and the largest world 16 kB.
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
- The account's playlists live in ONE store (`stores.js#playlists`, owned by
  `actions.js#userPlaylists`/`invalidatePlaylists`): the sidebar, the library tab and the "add to
  playlist" sheet all paint from it, so a playlist created from a sheet that opens OVER a screen —
  which never remounts it — is listed everywhere at once. `upsertPlaylistLocal` /
  `removePlaylistLocal` show a create/rename/delete instantly; `invalidatePlaylists` then refetches
  (debounced — `/me/playlists` counts every playlist's tracks, and the edit paths call it per
  operation).
- **ReplayGain is preloaded, never fetched from under a playing track** (`lib/gaincache.js`).
  Normalization is STATIC — `loadTrack` picks the gain at the source handover and holds it for the
  whole track — so a gain that lands one request later is not a refinement, it is the volume moving
  in the middle of a song. The current track and the next `GAIN_WINDOW` are therefore primed
  together in one call (`POST /api/gains`, DB rows first then a single `song.getListData` for the
  rest) as soon as the queue moves, and the answers are kept on the device (IndexedDB, negatives
  too, with a TTL), so a track played once never waits for the network again. The prefetcher and
  the downloader prime it with the audio — what has its bytes on the device has its gain there. A
  gain that still arrives late is applied only within `GAIN_LATE_GRACE` of the track's start;
  past that it is cached for next time rather than jumped in. The one deliberate exception is the
  user changing the normalization level, which may move it now.
- Cover art: a cached blob (`offlineCovers`, keyed resolution-independently by `coverKey`) is the
  **preferred** source in `Cover.svelte`, not a fallback — it's the server's archived 1000px art, so
  waiting for a CDN request to fail first is pure delay. Anything you play caches its cover
  (`playcache.cacheCoverFor`), so hi-res art works offline for everything you've listened to.

**Whole-track analysis is the SERVER's job** (`supysonic/deezer/analysis.py`, served by
`supysonic/webui/analysis.py`, consumed by `webapp/src/lib/analysis.js`). The tempo and the style
are properties of the whole piece, and a detector working them out live spends the first fifteen
seconds of every track converging — through the intro, which is the least representative part of it
— and pays that cost again on every device, on every play. Same reasoning as the loudness: the audio
does not change, so neither does the answer. Measure once, keep it in `track_analysis`, serve it.

- The TEMPO is **Deezer's own** where Deezer has one: its public API publishes a `bpm` per track,
  exact and free. Anything else (a local upload, a track with no figure) is measured from a
  low-passed envelope — ffmpeg decimates to 1 kHz u8 and the per-frame peak is a `max`/`min` over a
  ten-byte slice, so no audio sample is ever touched from Python.
- The DESCRIPTORS come from ffmpeg's `aspectralstats` and `ebur128`: centroid, spread, flatness,
  entropy, rolloff and flux per frame, plus integrated loudness and **loudness range**. LRA is the
  single best "how squashed is this" axis there is — a limitered hardcore master sits near 3 LU, a
  live quartet near 15 — and it replaces the client's spectral crest, whose scale could not be
  reconciled across the two implementations. **No new Python dependency**: no numpy, no model,
  nothing to install on a server that already has ffmpeg.
- Everything it classifies on is **physical or scale-free** (BPM, hertz, decibels, 0..1 ratios), on
  purpose: the client's live classifier works on its own normalized feature scales and the two must
  not be expected to share a threshold. They are independent readings — where the served one exists
  it is the authority, and the live one covers what has not been measured yet.
- Event-driven like the rest: `archive._finalize_archive` queues it on a daemon thread behind a
  one-at-a-time semaphore, so it is never why an archive, a stream or a shutdown waits.
  `deezer analyze` is the catch-up and the way to re-measure after `ANALYSIS_VERSION` moves. The
  endpoint **never measures** — the player asks about tracks it is *about* to play, and a request
  that started a three-second ffmpeg pass would answer long after it mattered while holding a thread.
- **The catch-up is a button too, and it finishes whatever the library.** The Étiquetage tab starts
  the same `backfill` the CLI runs (`POST /api/analysis/backfill`, admin-only, worker + poll), with
  a **Reclasser tout** toggle (`force`) and a **Parallèle** count where **0 means auto** (persisted
  in `Meta`; `analysis.auto_workers` → `workload.cpu_workers`, half the machine's cores). Above one
  worker the Deezer bpm lookup is skipped on purpose — its session is not meant to be hammered from
  several threads — and the tempo is measured from the files. Each pool thread takes and returns its
  own peewee connection; the work is ffmpeg, so the box bounds it, not Python.
- **A crashed ffmpeg is not the same as a failed measurement.** Some ffmpeg builds trip
  `av_assert0(best_input >= 0)` in the CLI's filtergraph scheduler (`ffmpeg_filter.c`) while
  flushing at END OF STREAM: the process dies of SIGABRT (`returncode -6`) having already decoded
  the whole track and printed every frame of it. Judging the run by its exit code threw a COMPLETE
  measurement away and called four perfectly healthy FLACs broken. So `_spectral` parses FIRST and
  judges after: a run that produced at least `MIN_SALVAGE_FRAMES` is a measurement whatever killed
  the process, and `lufs`/`lra` come from ebur128's **running** per-frame line (`_EBUR_RUNNING`)
  when the abort took the Summary block with it — the same two numbers, since the integrated value
  at the last frame IS the whole-stream one. With nothing salvageable and a death by signal it
  retries once **without `ebur128`** (`_spectral_cmd(loudness=False)`): the loudness meter is the
  droppable half — `lra` has a default — while without `aspectralstats` there is no verdict at all.
  `-t` also moved BEFORE `-i`, so the read limit ends the demuxer and the graph gets an ordinary
  end of stream instead of an output-side trim. And `ffmpeg_tail` skips per-frame filter telemetry
  (`_EBUR_PROGRESS`): ebur128 prints a line every 100 ms, so quoting the last three lines buried
  the assertion that explained the crash under two progress dumps.
- **A failure must name its CAUSE, never just its count.** This is a rule about every batch job,
  not a detail of this one. The analysis used to report `"<file>: analysis failed"` — one filename,
  no reason, and only the first of them — because four layers each dropped a little more: ffmpeg
  printed `Invalid data found when processing input` on stderr, `_spectral` raised
  `"ffmpeg exited 1"` and discarded the text it was holding, `analyze_track` turned that into
  `None`, and the job turned `None` into the word "failed". The reason existed at every step and
  survived none of them, so the only way to debug a library job was to read the container log —
  which is exactly what somebody running the app from a phone cannot do. So: `ffmpeg_tail` keeps
  ffmpeg's own words (and drops the banner, which is never the reason); `analyze_track_verbose`
  returns `(row, reason)` — the same contract as `embedding.embed_file_verbose` — naming the STAGE
  (`spectral pass:`, `classify:`, `database:`, `file missing from the archive`) and quoting what it
  said; `_record_failure` keeps a bounded per-track ledger (`failures`, capped at
  `FAILURE_SAMPLE_MAX`) plus a full tally (`failure_reasons`), so the one-line summary names the
  cause that DOMINATES the run rather than whichever file happened to be first. Both backfills and
  both job endpoints carry it, `components/JobFailures.svelte` shows it with a copy button, and the
  CLI prints it. The job dicts are snapshotted at the web boundary (`_job_snapshot`) because the
  ledger belongs to the worker threads and a status poll must never iterate a list being appended
  to. Re-running the backfill without "Reclasser tout" retries exactly the failures, since anything
  with a current verdict is skipped — so a diagnosis costs one button, not a whole library.
- **It walks the library by page and CHECKPOINTS, never `list()`s it.** `analysis._walk_library`
  keyset-paginates by primary key (`PAGE_SIZE`) and writes the cursor to `Meta` after every page
  (`analysis_cursor` / `embed_cursor`, cleared at the end, ignored past `RESUME_MAX_AGE` or when the
  `force` flag differs). Materialising the library built every Track object before the first
  measurement ran, and a restart lost the whole run — which is what "it stops around ten thousand
  tracks" was. `webui/analysis.resume_if_interrupted` / `webui/genre.resume_if_interrupted` restart
  an interrupted job on boot without being asked, so "analyse everything" means everything, across
  as many restarts as it takes.
- **The mel front-end only transforms the patches it embeds** (`embedding.patch_offsets` +
  `_log_mel_patches`). Building the whole file's spectrogram and keeping a sixtieth of it made the
  cost *and* the peak memory scale with the track's length — numpy's rfft returns complex128
  whatever it is fed, so an hour-long set reached the better part of a gigabyte of temporaries for
  sixty patches. A one-minute track and a two-hour one now cost the same.
- **A model that will not load is retried, not condemned.** `embedding._session_retry_at` holds a
  load failure for `SESSION_RETRY_DELAY` and then forgets it. The old permanent flag meant one bad
  second ended every extraction for the life of the process — and it is also how uploading the model
  fixes a running server.

The client takes the global answers and keeps the per-moment ones. `engine.js` primes the verdicts
for the queue window (one call, like `/api/gains`) and **seeds the beat tracker** with the served
BPM, so the grid starts locked and only the phase has to be found — the first bar is on the beat
instead of the fourth. The kick, the onsets and the transients stay live: no whole-file average can
stand in for an event.

**The genre studio** (`supysonic/deezer/embedding.py` + `genre.py`, `supysonic/webui/genre.py`,
`webapp/src/lib/genre/`, `routes/Genres.svelte`) is the answer to "the classifier does not know MY
genres". The heuristic above knows the styles it was written with; this teaches it yours.

- **The studio opens onto a vocabulary WIDER than the detector.** The first admin visit seeds a
  `GenreTag` per entry in `analysis.known_genres()` — the ~54 families the live classifier can name
  (`FAMILIES`) plus `EXTRA_GENRES`, ~170 sub-genres it cannot, from detroit to drumfunk and from
  rawphase to bossa nova — so tagging starts by CONFIRMING a guess instead of typing the vocabulary
  first, and a sub-genre the heuristic could never guess is still one click away. Nothing in
  `EXTRA_GENRES` is ever *returned* by `classify`; it is there to be hand-applied and then predicted
  by the trained head. Every label is chosen so the animation engine resolves it
  (`viz/skins.js#skinId` lowercases and strips everything but letters and digits), and a test in
  `webapp/test/viz.test.mjs` reads this Python list and fails if any label has no skin. It is additive and version-aware (a `Meta` value remembers how many the engine
  knew): a release that adds families re-syncs them on the next admin visit, a genre you delete
  stays deleted as long as the vocabulary has not changed, and the *Genres du moteur* button brings
  back just the missing ones. Only the admin seeds; a guest reading `/genre/status` writes nothing.
- **Measuring the library is a button, not a shell.** The Étiquetage tab starts the very backfill
  the CLI runs (`POST /genre/embed`, admin-only, worker + poll): every archived track without a
  vector is decoded once, so pressing it again only picks up what has been archived since. The
  counters stream back as it goes — it is minutes to hours of work and must never hold a request.
  `backfill_embeddings(on_stats=…)` is the one implementation, shared with `deezer embed`.
- **The big model is FROZEN and only ever extracts.** Fine-tuning something trained on millions of
  recordings with two hundred of your own mostly destroys what it knew. So `discogs-effnet` (ONNX,
  via onnxruntime) turns a track into one 1280-d vector and nothing else, and every bit of learning
  happens in a small head on top — a few hundred examples by 1280 dimensions, which trains in a
  browser tab. It is also exactly how the model's licence asks to be used: unmodified.
- **The model is never vendored and never fetched silently.** It is a third-party artefact with its
  own licence (CC BY-NC-ND), so the operator supplies a copy they obtained themselves — imported
  from the studio's **Extracteur** card (`POST /api/genre/extractor`, admin-only, stored in
  `<cache_dir>/models/discogs-effnet-bsdynamic-1.onnx`) or pointed at with `[deezer] embed_model`.
  It must be the **dynamic-batch** ONNX export
  (`https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx`):
  the front-end feeds however many patches a track yields, and the `-bs64` export declares a fixed
  batch of 64, which onnxruntime refuses — `validate_model` rejects it with that sentence rather than
  letting it fail at inference. onnxruntime is an optional dependency
  (`pip install 'supysonic[embedding]'`, and in the Docker image): without it the module reports
  itself unavailable and the heuristic classifier keeps doing its job unchanged.
- **The front-end is the dangerous part.** A mel-spectrogram with the wrong window, scale or
  normalization yields vectors that look perfectly healthy and mean nothing. The parameters are the
  published MusiCNN ones (16 kHz mono, 512-sample Hann, hop 256, 96 Slaney mel bands,
  `log10(10000·x + 1)`, 128-frame patches), and since "looks healthy but is wrong" is the failure
  mode, `deezer embed --self-test` checks it without a reference implementation: two halves of the
  SAME track must embed closer to each other than to other tracks.
- **Extracting needs the optional dependency; USING what was extracted must not.** `load_embedding`,
  `save_embedding` and `encode_embedding` are plain `struct` ("e" is float16), and `genre.predict`
  is plain Python. An archive copied from a server that had onnxruntime is a perfectly good training
  set on one that does not — and that is also why the studio's candidate list is never gated on the
  extractor.
- **Training is the browser's job, in a Worker** (`lib/genre/trainer.js` → `worker.js`). Seconds of
  solid arithmetic on the main thread is not a progress bar, it is a freeze. Three modes:
  `train.js` is a linear softmax head (a second, the right default), and `deep.js` is an MLP on a
  committed WebAssembly kernel (`wasm/kernel.c`, `build.sh`, ~4 KB) for the genres a plane cannot
  separate — hardtekk against frenchcore, zaag against uptempo. The MLP is a **generic stack of
  dense layers**, so the studio offers one hidden layer (256) or two (2×512): the second bends a
  boundary the first only bent once. Measured against the identical loops in JavaScript, the
  kernel's `fwd` is 8× and `accum_outer` 12×. The `.wasm` is committed on purpose: no toolchain is
  needed to build this repository.
- The linear trainer's **random projection is decided by the score**, not assumed: it is free on
  clustered data (1.000 at 4× the speed) and costly on marginal data, so it trains projected and
  re-runs at full width when balanced accuracy comes back under 0.8. The deep trainer keeps the same
  code path but defaults it OFF — measured, projecting to 384 cost ten points (0.890 against 0.998)
  to save five seconds, and five seconds is not worth ten points on the one path that exists
  *because* the accuracy was not enough.
- **The CSP had to be widened by exactly one token.** `script-src 'self' 'wasm-unsafe-eval'` permits
  WebAssembly compilation and nothing else — not `eval()`, not `new Function`, not inline script.
  Without it `WebAssembly.instantiate` is refused outright and deep training cannot run at all.
- **One tag per track, admin-only, one model.** A track labelled both frenchcore and uptempo teaches
  the head that the two describe the same sound; a track that genuinely sits between them is better
  left out. And two users disagreeing about what hardtekk is would train the single shared model
  against itself.
- The studio ships the head as base64 float16 (`encodeHead`: `W, b` for a linear head, `W1, b1, W2,
  b2` for an MLP, `W1, b1, W2, b2, W3, b3` for a two-hidden-layer one) and `PUT /api/genre/model`
  **refuses a head it cannot read back** — it stores, re-reads, and deletes the row if the weights
  do not match the labels and dim given. A model stored but unusable would silently do nothing for
  ever.
- Tagging is **confirming, not typing**: every candidate arrives with the current model's guess,
  ordered by play count (the labels that matter are on the music this library actually plays), the
  keyboard is the interface (`1`…`9` choose, `↵` confirms, `→` skips, `espace` previews) and the
  preview jumps a third of the way into the track — nobody judges a genre from the intro. The
  preview carries a **seek bar that follows the element's own clock**, so it stays true to whatever
  the stream/transcode pipeline is actually delivering: its length falls back to the candidate's
  known duration when the stream reports none, and a seek on a not-yet-seekable source is chased
  and landed as soon as the buffer allows rather than being dropped. The preview shares the
  player's volume, with its own slider. The button is in Réglages → Animations → Analyse rythmique.
- **Tagging is reachable from wherever the track is.** The studio is for a tagging pass; the other
  moment is noticing a wrong genre while listening or scrolling a list, so an admin also gets
  *Étiqueter le genre…* in any track's three-dot menu (`actions.buildTrackMenu` → `openGenreTag`),
  opening the same global sheet over the current screen, plus the quiet tag button in both
  now-playing views.
- **The genre chip reads the SERVED verdict first** (`webapp/src/lib/trackverdict.js`). It used to
  read the live classifier only, so it needed the analysis engine running, the `smart` scene
  selected AND the classifier past its confidence floor — miss any one and there was no label at
  all, which is why it showed up about half the time. The server measured the track once and a
  hand-applied tag is not a guess at all, so that leads; the live reading covers what nobody has
  measured yet.

**Audio analysis** (`webapp/src/lib/audio/`) is ONE engine, shared. `engine.js` owns a single clock
and a single pass over the analysers; every view reads the same frame object by reference, so a
second visualizer on screen costs a function call. It is refcounted — nothing runs until a view asks
for frames — and it runs at the shallowest level any live subscriber needs (spectrum / rhythm /
smart). Three things in there are load-bearing:

- `graph.js` is the Web Audio graph (moved from the old `lib/visualizer.js`). Its normalization gain
  is **per source, not shared**: a crossfade has two tracks audible at once, each with its own
  ReplayGain, and one shared node could only ever be right for one of them. A separate fade gain
  sits after it so the two envelopes are scheduled independently.
- Two analysers, not one. `spectrum.js` reads the low end from an 8192-point FFT (5.9 Hz bins) and
  the rest from a 2048-point one (43 ms window), blended across 300-600 Hz, and **interpolates
  between bins** where a log band is narrower than one. That is what fixed the old visualizer's
  bass: a single 512-point FFT is a 93 Hz bin, so every bar below ~400 Hz floored onto the same two
  or three bins and drew as flat groups of identical bars.
- The clock is the **audio thread** (a tiny AudioWorklet posting every 4 render quanta), not rAF.
  rAF stops in a hidden tab, which is the normal case for the player once the projector window is
  in front of it. rAF is the fallback, and carries the first frames while the worklet compiles.

**`features.js` — three rules, each of which replaced something measurably wrong:**

- The onset function is **SuperFlux** (Böck & Widmer, DAFx-13): log magnitude, differenced against
  a version of the frame ~20 ms back that has been **maximum-filtered across three bins**. A
  partial that merely drifted is covered by its own neighbour's maximum and contributes nothing;
  energy appearing where there was none still does. Plain flux fired on every vibrato and every
  tremolo pad — measured, a sustained chord with no attack anywhere in it produced `midFlux` of
  **0.987 out of 1**. It now produces 0.000. The lookback is indexed by TIME, not by frame count,
  because this engine's clock is not guaranteed regular, and consecutive frames of a 2048-sample
  window overlap almost entirely (their difference is window smear, not music).
- **Level is information.** Adaptive whitening divided every bin by its own running maximum, which
  makes a whisper and a wall of sound produce the same numbers *by design* — right for a beat
  tracker, wrong for an animation asked to be calm when the music is calm. `dynamics` is this
  moment against `loudRef` (the track's own loud level: up in 0.4 s, down over 25 s), and
  **everything a scene draws is multiplied by it** while the tracker keeps the ungated signal, so
  the grid survives a breakdown even when the animation settles. Measured on identical material 12
  dB down, the old extractor read the same kick strength (0.365 against 0.355); it now reads 0.122.
  End to end, a −20 dB breakdown used to render **1.23× brighter than the drop** and now renders
  0.60×.
- **There is a melody in there too.** One exponential average per bin splits what PERSISTS (a held
  note, a pad, a voice) from what APPEARS (a drum), and the persistent half carries `chroma`,
  `melody`, `melodyPitch`, `melodyFlux` and `chordChange`. The chroma counts how far a bin stands
  above the third of an octave around it — a prefix sum makes each window O(1) — and divides by
  how many bins land on each pitch class: an FFT is linear and pitch is logarithmic, so raw energy
  gave flat noise a strongly peaked chroma and it read as a clear melody, exactly backwards.

**THE KICK IS FOUR WITNESSES, AND NONE OF THEM IS THE LEVEL.** The detector used to ratio two
envelopes of the 25-180 Hz band — a 3 ms attack against a 90 ms release — and it failed on exactly
the music this player exists for. Measured through the full chain on synthesised hardcore (audio →
`features.js` → `tempo.js`, pinned by `test/synth.mjs` + `test/audio.test.mjs`): techno **1.94
detections per kick**, frenchcore **2.08**, uptempo **0.40 — sixty per cent missed**, and
frenchcore under a screech **3.74**. Two assumptions produced all four:

- *It assumed the kick is in the kick band when it lands.* A hardcore, frenchcore or uptempo kick is
  a pitched sine driven into a distortion chain; it **starts at 190-260 Hz** and sweeps down over
  the next fifty milliseconds. Measured, the 25-180 Hz band is 4-6 dB **down** at the attack and
  does not peak until a fifth of a beat later, by which time it is indistinguishable from the
  previous kick's tail. That is the sixty per cent.
- *It assumed the level means something.* These masters are limitered flat, so when a transient
  arrives the limiter pulls the whole mix down to hold the ceiling and the loudest moment in the
  music reads as a **drop** in every band at once.

So nothing in it is a level. Four witnesses, each a step over the same 26 ms lag, each scale-free:
**lift** (the 28-420 Hz region's energy step in dB — the whole story for a techno kick in a quiet
bar, near useless under a limiter), **pitch** (that region's centroid stepping UP, in octaves — the
fundamental restarting high, the one thing a tail cannot counterfeit because a tail always sweeps
DOWN), **click** (the beater band's step), and **sub** (the bottom two octaves, which is the only
witness a pure 808 with no beater and no pitch movement brings). A kick is the best-supported
COMBINATION: **two witnesses are required**, and one alone is capped below the trigger — a hi-hat
can be several times louder than any kick in the track and used to clip its way over the threshold
on the click alone.

**Something must have STRUCK, and it must have struck LOW.** Those are the two halves of the
decision, and which witness may answer each is not interchangeable. *Struck* is **the beater and
only the beater**: a bass note swelling back between kicks moves the region's pitch (0.88, because
it is higher than the last kick's tail) and would convict itself on that alone, while its beater
witness reads 0.14 — a note that fades in has no transient to put up there. *Low* is either energy
arriving at the bottom (`lift` or `sub` over 0.8) or, when there is no room left down there,
**the fundamental restarting high with that beater on it**, which is what a kick over its own
predecessor's tail looks like. The exception is the kick with no beater at all — an 808, a sine
bass drum — which convicts on the sub alone, at a bar set far above what a pad's own wobble reaches.

**A CENTROID MEASURED ON AN EMPTY REGION IS NOT A MEASUREMENT**, and that is what convicted a
hi-hat. The other three witnesses are STEPS in decibels: they measure themselves and read zero when
nothing is there. The pitch witness is a SHAPE, and the shape of the noise floor is noise — it
wanders by a third of an octave a frame, which normalises into a witness of 0.61 on a techno track
whose kicks (their centroid moves DOWN as the bottom fills) never produce one at all. Measured,
techno with hats on every offbeat fired **2.00 per kick**, the extra one on the hat — which is
4-16 kHz noise with a 24 dB/octave skirt and puts *nothing* in the kick region: at the offbeat that
region sat **56 dB** below where this track's kicks put it. Every true kick that relies on the
restart path sits within **15 dB** of its own track's region level, so the witness is faded out
between 20 and 36 dB down, and the hat reads 1.00 per kick at any hat level.

**The region is read PER OCTAVE, not per bin.** It spans nearly four octaves (28-420 Hz) and an FFT
is linear, so a plain mean over its bins gave 210-420 Hz half the vote and 28-56 Hz a twenty-eighth
— the top of the region, where a kick barely lives, outweighing the bottom, where it does. Measured,
a correctly low-cut 700 Hz hoover whose only residue is the part sitting above the corner moved the
plain mean by 15 dB on a bar with no kick in it.

**And every adaptive scale has a floor set from the smallest step a real kick makes.** They were set
low and it showed on the one material with nothing to divide by: an ambient pad of three detuned
saws, whose partials beat against each other several times a second, so the bottom two octaves
wobble by 4.6 dB and the beater band by 2.1 — which, against floors of 4.5 and 4, read as a full sub
witness (1.02) and half a beater (0.52) and held `kick` at its cap for the whole track. A real
beater step measured 5.7 dB at the very least and 15-30 dB everywhere else.

The limiter is removed as a **common mode**: the median of eight octave bands'
steps, believed only when the bands agree to within 5 dB, because a gain change moves every band by
the same number of decibels and no instrument does. And the gate is a **Schmitt trigger**, not a
refractory window: a 300 ms hardcore tail and a 60 ms roll sit on the same side of any fixed window,
so the evidence has to fall back through a release level before another attack counts. Each witness
scales against a **slowly-rising, slowly-falling** estimate of what this track's kicks weigh, never
a running maximum — a roll's notes are shortened to fit their subdivision, so they step further than
the ordinary kicks, and with a maximum one bar of sixteenths raised the bar for the whole phrase and
took uptempo from 1.00 back down to 0.27. All of it now reads **1.00-1.01 per kick at 9-17 ms
latency** across sixteen records of real audio from trap to speedcore, with `pattern.mainKick`
scoring 97-100% precision on them.

**The limit it does have is stated rather than papered over.** A lead whose residue lands inside the
kick's region, restarting high with an attack on it, is numerically identical to a kick over a
saturated low end — a 320 Hz stab reads `lift 0.23, pitch 1.00, click 0.95, sub 0.00` and an uptempo
kick on a full bottom reads `0.23, 1.39, 0.95, 0.00`. Every attempt to separate them on one frame's
evidence cost real kicks (a sub veto took uptempo from 1.00 to 0.72). It is separated one layer up,
where the GRID is known: `features.kickHit` is a percussive-attack detector, `pattern.mainKick` is
the kick answer, and on that exact case it scores **F1 0.99**.

`tempo.js` is a spectral-flux onset function on a fixed 100 Hz grid, an autocorrelation summed over
harmonics, and a phase-locked loop. Once locked, beats are **predicted**, not detected, so a scene
lands on the beat instead of a detector's latency after it.

**The reading has to be ONE number.** A tempo that walks off to a harmonic and back — 120, then 250,
then 120 — is worse than no tempo at all: everything downstream (the animation's grid, the
classifier's `tempoTrust`, the label in the header) re-times with it. Six things keep it still, and
each of them was measured against a tracker that did not have it. The generators in
`webapp/test/audio.test.mjs` schedule onsets on a timeline and render them into frames (asking "is
this frame near a beat" silently drops events above ~180 BPM, and a tracker fed a train with holes
in it is being tested against nothing); across a 70→250 BPM sweep of busy material the old tracker
got 54 of 74 cases exactly right with 381 tempo jumps between them, this one gets 72 with 1:

- the ODF is **conditioned** before anything reads it. A local mean (~120 ms) is subtracted and the
  rest half-wave rectified, which removes a riser, a filter sweep or a reverb wash — all of them
  raise the flux *continuously*, and a continuous rise is not a beat. What is left is expressed in
  units of the track's own average onset and **clipped**, so one enormous FX stab is worth about one
  and a quarter kicks in an eight-second window instead of twenty. The clip is deliberately far
  above an ordinary onset (25×): flattening a kick and a hi-hat onto the same value is its own way
  of losing the tempo.
- the autocorrelation runs on a **bass-weighted** mix, because every genre this player is pointed at
  puts its beat there and the treble is where the effects and the offbeat hats live;
- the harmonic-summed correlation is **averaged over time** (a running tempogram, ~2 s of estimates
  over an 8 s window). One estimate is a snapshot an FX bar can dominate; the average cannot be
  moved by one bar of anything;
- a shortlist of candidates is then scored on how well the ODF actually **folds onto each one's
  grid**, normalised by what a window that size would catch from noise — autocorrelation cannot tell
  a tempo from twice that tempo, and a half-empty grid can;
- the octave is arbitrated by **two witnesses, and the second one has a veto**. The fold asks a
  local question (is there anything at the halfway point, in the bass or across the band) and is
  fooled whenever one beat of the bar is simply louder than the others — measured on uptempo with
  rolls on the last beat of every other bar, it voted steadily to halve a perfectly correct 240 BPM
  grid. So `levelScore` asks the global one: does the music actually **fit** that level better, on
  the same terms every candidate is judged by. The fold PROPOSES and the score DISPOSES — a fold
  vote toward a level the score says is measurably worse is suppressed outright, while the score
  can move the grid on its own. Within the fold the old asymmetry stands: to go *faster* only the
  bass may answer (an offbeat hi-hat is not a beat); to go *slower* the whole band is asked, or a
  140 BPM track with a kick every other beat reports 70;
- nothing moves the grid without **persistence**: a candidate that is neither the current tempo nor
  an octave of it must win five consecutive estimates, and the incumbent carries a bonus.
- **the local mean's window is longer than a beat**, which a fixed 120 ms is not above ~200 BPM. At
  240 the beat is 250 ms, so the mean tracked the beat and subtracted most of it: measured, the
  running tempogram at the TRUE lag fell from 0.364 to 0.084 as the estimators converged, confidence
  fell with it, and the grid unlocked after ten seconds and re-locked a quarter of the tempo away —
  with the winner having been correct on every single estimate. It now scales with the grid
  (`MEAN_BEATS`), still far shorter than the risers and reverb washes it exists to remove;
- and **two candidates four grid slots apart are the same peak**. A 6% log distance is four whole
  slots at 120 BPM and barely one and a half at 240, so up there the shoulder of a peak was
  shortlisted as a rival to the peak itself. That never changed which tempo won, but it collapsed
  the confidence margin — and confidence under the floor is what UNLOCKS the grid.

**THE SERVED TEMPO IS AN ANCHOR, NOT A HINT.** Somebody measured the whole track; an eight-second
window deciding it disagrees is the single most common way this tracker was wrong, and the user's
report of it was exact: *"it tries to overwrite the tempo the server sent it with nothing"*. Three
things were wrong and all three are fixed:

- **the seed was only applied to an UNLOCKED tracker**, which in practice meant almost never. The
  verdict comes over the network, behind the audio in the request ladder, so by the time it lands
  the grid has been locked for seconds — on three seconds of whatever the intro happened to be.
  Measured on uptempo with the kick on the offbeat: seeded at t=0 it read 220 BPM, seeded at t=4 s
  it read 110, for the whole track. `seed()` now works at any time; on the seed's level or one or
  two octaves off it, the level moves and **the phase is kept** (the beats do not shift, only their
  name), so a late seed cannot make the animation jump.
- **the seed anchors the OCTAVE, not the tempo.** `levelPrior` — a narrow bell over a floor, used by
  everything octave-related — all but settles which metrical level the grid runs at, and `octBar`
  puts a move AWAY from it beyond the vote's reach. But `weightFor`, which picks the winner among
  candidates, uses the ordinary prior: which tempo it is is not ambiguous in the signal, and a
  served figure that is simply wrong (117 on a 175 BPM track) has to be overruled by the music.
  Putting the seed in both made a wrong figure unbeatable, which is the opposite failure and just as
  bad. A seed the music contradicts at full strength for twenty seconds has its own level moved
  (`seedDoubt`), so a tempo published at half its real value is corrected by the track rather than
  by one window of it.
- **a whole-track measurement is a reason to stay locked.** There is material whose autocorrelation
  at its own beat is genuinely poor for eight seconds at a time — rolls, a half-time passage, a bar
  of one held note — and a grid sitting exactly on the server's figure used to lose confidence
  estimate by estimate until it fell through the floor and re-locked somewhere else. While the grid
  agrees with the seed, the seed floors the confidence.

**KNOWING THE GENRE IS WHAT SETTLES THE OCTAVE, and nothing else can.** A 250 BPM uptempo track and
a 125 BPM house track produce the same autocorrelation, at the same lags, in the same proportions;
no amount of signal processing separates them. What separates them is knowing which record is
playing, which the engine does know — the server measured the track, or the live classifier named a
family. `style.js#tempoRangeFor` is that knowledge written down (frenchcore 170-230, uptempo
170-260, hardtekk 140-180, hardstyle 140-165, dnb 160-180…), `tempo.js#setTempoRange` moves the
prior's plateau to it, and `engine.js#applyTempoRange` feeds it in from the verdict or, failing
that, from the live classifier once it is confident. The ranges are deliberately WIDE: they set a
plateau, not a target, and all they are for is making the octave either side implausible. **A
missing row is not a bug** — the tracker falls back to the default 90-200 plateau. This is the
published result on tempo octave errors in electronic music, and it is the one table in the audio
code an operator might reasonably want to extend.

**And a breakdown is not a tempo change.** With no drums in it the last seconds carry no onsets and
the autocorrelation is reading a pad; the estimate is skipped entirely (both going into the quiet
part and coming out of it, which is the window that is three-quarters empty) and the grid coasts on
what the music had before. That alone is where "128 BPM, then 64, then 255" came from.

Two older details are still there for the same reasons they always were: the ODF is smoothed
(~20 ms) before the autocorrelation, or a period that is not a whole number of grid slots (174 BPM
is 34.5) loses half its correlation to its own double; and every candidate is divided by the
**same** harmonic weight, or slow candidates get a free pass because their harmonics fall off the
end of the search range. `webapp/test/audio.test.mjs` pins all of it (`npm test`; no
test framework to install, though `npm install` must have run — `test/preflight.mjs` says that in
one line rather than letting node abort five files and report them as five DSP failures, which is
a trap that has already cost one debugging session) — the wall-clock bug it caught would have made
the tracker drift with the frame rate.

**`pattern.js` — the MUSICAL reading, above the per-frame one.** `features.js` says "a kick landed
and it was this hard"; `tempo.js` says "the grid is here"; neither answers the questions an
animation wants to ask. At 200 BPM a frenchcore roll fires five hits inside one beat, so a scene
that throws something on every `kickHit` is a strobe — the user's words: *the blocks should fall on
the drop and on the main kicks, so there has to be a way of telling them apart*. It publishes
`mainKick` (on the grid, outside a roll) with `mainPower` and `bigKick`, `rollKick` with `roll` and
`rollDiv` (the subdivision, 2/3/4/6/8/12/16 — a triplet fill and a sixteenth run are different
pictures), and the arrangement: `drop` (the frame the music comes back after being out long enough
to be missed), `dropped`, `build`, `breakdown` and `energy`. It is O(1) per frame — **0.5 µs,
measured, against 49 µs for `features.process`** — allocates nothing after construction, and is
read through `m.mainKick` / `m.roll` / `m.drop` in `lib/viz/musical.js` like everything else. Its
four events cross the projector channel **latched**, for the same reason every other event does.

`style.js` reads the kick's shape (attack, decay, click, grit → soft / hard / industrial) and a
smoothed family vector (techno, hardtekk, zaag, frenchcore, uptempo, pieep, krach, rock, metal,
strings, vocal…). It publishes TWO things for two jobs: the family, which is legible and is what the
UI shows, and a five-way **archetype** mix (sustain / voice / groove / hard / rock), which is what
the renderer blends on — animations can interpolate between five archetypes, not between eighteen
genre names, and a scene that re-drew itself every time the classifier changed its mind between two
neighbouring hardcore subgenres would be unwatchable. Nothing hard-switches: both outputs are
weights, smoothed over seconds, and the dominant family changes with hysteresis.

Five archetypes are enough to blend between and nowhere near enough to tell hardtekk from
frenchcore, so there is a THIRD output: **`look`, seven numbers** (`LOOK_KEYS`: motion, density,
punch, smooth, warm, melodic, chaos) blended by the same family weights. It is deliberately not a
name — a name cannot be interpolated — and every family starts from its archetype's look and
overrides only what it actually differs on, so a new family costs one line. The GL engine carries it
to every world (`uLookA` / `uLookB` in the Music block) — the hard worlds read it to tell neighbours
apart (`chaos` widens `shatter`'s cracks, `melodic` decides how much of `forge`'s anthem ribbon is
drawn) — and `palette.js` leans the chosen hue a third of the way toward red or cyan on
`warm`, never replacing the source the user picked. A **served** verdict names a family, so
`style.familyLook(id)` turns that name back into the seven numbers and `engine.merged` carries
them: without it the look vector was dropped exactly when the server had measured the track, and a
track that had been analysed lost every genre-specific layer while an unmeasured one kept them.

**A quiet passage is not a different genre.** A breakdown has no drums, no pulse and no grit, so
every measurement says "ambient" and the whole look of a hardcore track would change halfway
through and change back at the drop. The classifier's adaptation rate is therefore scaled by
`dynamics²`: at half level it only slows a little, at a twentieth it all but freezes and holds what
it knows until there is something to form an opinion from.

**Animations** (`webapp/src/lib/viz/`): a mode registry (`off`, `bars`, `pulse`, `scope`, `aurora`,
`smart` — `modes.js`), a palette whose SOURCE the user picks (cover art / the spectrum itself / fixed
schemes), and quality tiers that `auto`-resolve from the device. Two kinds of scene come out of
`lib/viz/index.js`, and the host has to know which: **`gl`** — every full-screen mode except the
oscilloscope is the WebGL2 engine (`scenes/gl.js`) with a policy for which WORLD it shows (`pulse`,
`aurora` and `bars` are one fixed world each — `pulse`, `aurora`, `spectrum` — and `smart` lets the
genre choose among all 47) — and **`2d`**: the oscilloscope, which draws the samples on a canvas,
and `scenes/bars.js`, the spectrum on a 2D canvas, which is what a device with no WebGL2 gets instead
of any world (`createFallback`). `Visualizer.svelte` therefore owns TWO canvases and shows the one the
scene's `kind` asks for: a canvas has one context type for its whole life. `scene.update()` runs on
every analysis frame (~94 Hz, so a beat is never missed) and `scene.draw()` on rAF under the user's
frame cap — the two rates are separate on purpose. Réglages → Animations configures all of it around
a live preview (sticky, so it stays in view while the controls under it are moving it) and a readout
of what the engine currently believes, down to the world it chose.

**The oscilloscope** (`lib/viz/scenes/scope.js`, `scope` in the registry) is the one scene that draws the music rather than
something *about* it, and that changes what "good" means: a scope is only worth looking at if it is
STABLE and HONEST. Four things carry that, and each was measured.

- **IT IS TRIGGERED.** Drawing the newest N samples every frame makes the waveform slide sideways at
  the difference between the frame rate and the music's own period — unreadable within a second.
  Each frame hunts backwards for the last rising zero crossing and starts its window there.
  Measured on a sustained tone, the trace moves **0.007 px a frame triggered against 86.5 px
  free-running**.
- **The trigger is LOW-PASSED** (one pole at 320 Hz), which is what makes it lock to the music
  instead of to the cymbals: a bright master's raw zero crossings are dominated by a top end that
  has no stable period at all. Same idea as a scope's HF-reject coupling. The gate is a Schmitt one
  whose hysteresis scales with the trigger signal's own weight, so it is not a number that suits one
  master.
- **ONE TIMEBASE FOR BOTH CHANNELS.** The trigger runs on the mono sum and its offset is applied to
  both traces, because the whole point of two traces is reading one against the other — a
  hard-panned stab, a mono bass under a stereo lead, a phase problem. Two independent triggers would
  slide the channels against each other and destroy the only thing they are there to show.
- **The tap is PER CHANNEL, and it had to be new.** An `AnalyserNode` downmixes to mono before it
  measures anything, so the engine's two existing analysers cannot answer this at all.
  `graph.js#requestScope` adds a `ChannelSplitter` after the output with one analyser per channel,
  read with `getFloatTimeDomainData`. It taps BEFORE the look-ahead delay like the others (both
  screens must draw the same instant), it is **refcounted and built on demand** — two analysers copy
  every render quantum into their ring buffers whether or not anyone reads them — and a mono source
  is up-mixed rather than left with a dead second output, so it shows two identical traces, which is
  what a real scope with both probes on one signal shows.

**PRECISION is the quality setting; the TIMEBASE is not.** Every tier shows the same ~42 ms slice,
because eight times as much waveform at ultra would not be more precision, it would be an unreadable
picture. What the tier moves (`scope` in `quality.js`) is how much of that slice survives to the
screen: the trigger's search room (25 ms → 250 ms, and more of it is strictly more stable — it is
what still finds an edge under a held pad), the column ceiling (**256 / 512 / 2048 / 4044** columns
measured on a 4K-wide lane), per-column **min/max** instead of peak-preserving decimation, and the
sub-sample trigger. That last one is where the trap was: `exact` takes min/max over the whole samples
in each column, and `ceil()` rounded the fractional trigger straight back off, so `fine` did nothing
until the column's **fractional ends** were read by interpolation too. That is now the entire
difference between the tiers that interpolate the trigger and the tiers that do not — **1.03 px of
frame-to-frame drift against 0.007 px**, a factor of 158 — and it closes the hairline gap between one
column and the next for free.

Everything else follows the house rules. The **auto-range compresses rather than normalises**
(`gain = (target/ref)^0.6`): raising a quiet passage to full height would throw away the one thing a
waveform is best at showing, so 20 dB down draws at 40% of the loud part instead of 10% — visibly
quieter, never a dead line. It is **shared between the channels**, or a mix that is louder on one
side would look centred. And its reference is deliberately **not the peak**: a peak envelope is a
scale set by the loudest instant and held there, which measured out at a reference of 0.85 while most
windows held 0.09 and drew the trace at six per cent of its lane — honest, unreadable. A **slow
attack** (0.35 s) fixes it with the envelope that already existed: a 0.15 s kick can only pull it
part of the way up, so the scale lands on what the music spends its time at (measured, 0.53 of full
deflection on average) and the transients clip to the rails, which is what a scope does and what they
should look like. The phosphor is a **time constant**, and the stroke alphas are multiplied by the
wash they settle against (steady state is `alpha/wash` on a trace that redraws in the same place), so
persistence and exposure are identical at a 30 fps cap and at 144. The two lanes take the **free
strips around the artwork** — above and below it, or beside it — the same answer aurora gives its
ribbons and for the same reason.

**The beam does not dim with the tier, and that is the one place this scene parts company with the
others.** Their `preset.glow` is a brightness ladder (0.45 at low against 1.25 at ultra) because what
it scales is atmosphere; here it would scale the SIGNAL, and at 0.45 with no post pass behind it
(`POST.low` is null) the trace was very nearly invisible. So `glow` is read as the halo budget it
really is — the part the bloom duplicates anyway — floored, and the core and the graticule are the
same at every tier. The beam does get **wider as the columns get coarser** (by the square root of the
ratio): the same alpha laid along 256 long diagonal segments puts far less ink on any one pixel than
along 1548 short ones, so a low tier drew a trace that was there and could not be seen — and a coarse
trace *should* read as a fatter, softer beam, which is exactly what a scope with less resolution
looks like.

**Two settings, in Réglages → Animations, shown when the scope is the scene on either screen**:
the **orientation** (two bands stacked, or two columns side by side) and how the **two channels are
coloured** (the palette's two ends, one hue, or the hue walking along the trace exactly as it walks
across the bars). Both are a LEAN on the palette SOURCE the user already picked, never a replacement,
and both are pushed into the live scene rather than rebuilding it — flipping the orientation should
move the lanes, not restart a trigger lock and an auto-range that took a second to settle.

**The raw samples are not an analysis LEVEL, they are orthogonal to all three.** A scope wants the
waveform and none of the ladder; a smart scene wants the whole ladder and no waveform. So
`subscribeFrames(fn, level, { wave: samples })` asks for them per subscriber and the engine takes the
largest window anyone wants, exactly as it takes the deepest level — two scopes on screen share one
splitter. On the projector the window crosses the channel **whole**, as Int16: a waveform reduced
before it crosses is one the projector cannot trigger. It is strictly opt-in and sized by the VIEWER
(`wv` on its hello), so a projector on any other scene still costs the ~800 bytes a frame it always
did and one on the scope costs up to 32 kB — a memcpy inside one browser process. A viewer that does
not ask is sent nothing; a publisher that cannot answer leaves the projector's scope with no probe on
it, drawing its graticule and a flat line, which is the truth rather than a broken picture.

**THE ANIMATIONS ARE SHADERS, AND THAT WAS THE WHOLE FIX** (`lib/viz/gl/`, `lib/viz/scenes/gl.js`).
They used to be 2D-canvas scenes — additive strokes over a translucent wash — and every one of them
looked like what it was: hairlines on black, eight-bit trails you could count, a bloom bolted on
after the fact on a second canvas. No amount of care inside the scenes could fix that, because the
medium was the ceiling. Every full-screen animation except the oscilloscope is now a fragment
shader, drawn by one WebGL2 engine in four files:

- `gl/renderer.js` — one context per CANVAS (not per scene: a mode change must not recompile the
  shaders it already has), **HDR** render targets (RGBA16F; RGBA8 with the scene scaled by
  `uHeadroom` where float targets are missing, so the bloom and the tone map still see values above
  one), a program cache, and the four things a device WILL do to it: lose the context (prevented,
  then every object rebuilt on restore and programs recompiled lazily from their source — a world
  never knows), lack float targets, compile slowly (`KHR_parallel_shader_compile`, polled, so a first
  switch to a world is never a frozen frame) and be too slow (`EXT_disjoint_timer_query_webgl2`: the
  GPU's own time per frame, because timing the JavaScript that issues the calls measures nothing).
- `gl/glsl.js` — the **Music block**: one std140 uniform block carrying the whole musical state, the
  palette and the frame, uploaded ONCE per frame however many programs read it. Its layout is
  declared once (`MUSIC_SLOTS`) and generates both the GLSL and the JS offsets, because a writer and
  a reader that disagree by one vec4 do not fail — they silently feed every world the wrong numbers.
  **There is no wall-clock time in it.** A world's clocks are beats, bars and phrases (`uClock`), so
  "no constant that should be musical" is a property of the interface rather than a rule to police;
  the one thing that needs seconds, the film grain, lives in the post pass. Also here: the library
  chunks a world pulls in by name (`uses`: noise, fbm, sdf, voronoi, caustics, `crowd` — the person seen from behind that lasers and stage share — …, with dependencies),
  and the assembly of a world's fragment and particle programs.
- `gl/postfx.js` — what runs after a world has drawn: the **dissolve** between two worlds, the
  **bloom** (the Jimenez/CoD 13-tap downsample with a Karis average on the first step and a tent on
  the way up — the filter that does not shimmer when a bright line moves), the **AgX** tone map
  (a hot neon rolls toward white THROUGH its own hue instead of clipping to a flat cyan blob — in
  scenes built of emissive light that is the difference between lit and clipped), a radial
  chromatic fringe that swells for an instant on an impact, and triangular dither plus grain (an
  8-bit output cannot hold a smooth dark gradient). Deliberately **no vignette**: darkening the
  edges would undo the rule that a picture fills a beamer.
- `scenes/gl.js` — the musical reading turned into uniforms, and the POLICY: which world, dressed
  how. `update` reads the music at analysis rate; `draw` extrapolates the clocks to the instant of
  the frame and computes every envelope from event STAMPS at that instant, so motion is as smooth
  at the projector's 45 Hz of analysis as at 94. A **dynamic resolution governor** steers on the
  GPU time (or the frame interval when there is no timer) between the tier's floor and ceiling.
  **Flashes are the engine's, not the worlds'**: a world calls `flash(power)`, and this file
  decides — never more than three onsets a second whatever the music does (the WCAG general-flash
  threshold, and on a projector in a room full of people the line between a style and a medical
  risk), scaled by the user's setting (`vizFlash`: off / soft / full, one setting for both
  screens), and none at all under `prefers-reduced-motion`.

**A world is one file** (`lib/viz/worlds/<id>.js`), fetched the first time it is on screen:
`{ id, uses, feedback?, params, look, fragment, particles?, create() }`. `params` become `P_NAME`
defines (sixteen at most, packed into four vec4s) that a skin may override; `look` is the world's
grade (exposure, bloom, threshold, saturation), blended during a dissolve; `particles` is a
STATELESS instanced sprite (`particle(id, …)` computes everything from its index and the music, so
thousands cost nothing on the CPU); `create()` returns the DRIVER — the few lines of JavaScript that
integrate what a shader cannot (a camera's travel, a stepped rotation, a runner's stride) into eight
floats of `state` and a ring of eight `(birth, power, a, b)` events (`worlds/kit.js`). The rules,
each of which a world broke once:

- **The driver gets seconds; it must spend beats.** `dt / m.beat`, `m.overBeats(n)`,
  `m.ease(v, target, beats, dt)`. Events are stamped in beats and aged in the shader against
  `uClock.x`. The two deliberate exceptions are perceptual, not musical: a flash's decay, and a
  temporal average's time constant (aurora's denoise is 60 ms at any frame rate — a blend of 0.28
  PER FRAME was a 60 ms average at 60 fps and a 25 ms one at 144).
- **Feedback is a time constant, not a per-frame factor**, for the same reason. The feedback worlds
  (`flow`, `ink`, `aurora`) get their dt from the driver.
- **Anti-alias against the real footprint, in pixels.** `uFrame.w` is one pixel in p-space. A line's
  width is its screen width at every depth, and where lines pack tighter than the pixels can hold
  they fade into their average light instead of shimmering. The footprint is the WHOLE gradient:
  `horizon`'s road lines run almost flat toward the horizon at the sides, and there it is the
  vertical change in x that decides how many a pixel covers — reading one axis drew a band of
  coloured moiré under the sun. `pixels` only draws its aperture grille where a virtual pixel is
  big enough to carry one; a mask finer than the screen's own pixels is moiré, not texture.
- **Draw on the frame, around the artwork.** p-space is y −1..1 and x −aspect..aspect; `uHole` is the
  artwork's centre and half extents, **measured from the DOM** (`Visualizer.svelte`'s `occluder`,
  through `lib/viz/geometry.js`), and `clearOfHole` dims what falls under it. It is the artwork's
  OWN box (`hx/hy/ahw/ahh`), not the frame-centred one geometry.js grows for the scope's polar
  primitives: the mobile cover sits above the middle, and the grown box centred every world 7% of
  the frame below the cover it was framing. A world puts its motif in the band the artwork leaves
  free (the pixel runner stands on a ground line under the cover; horizon's floor and storm's lake
  start there and the synthwave sun rises from behind it; the spectrum frames it with a bank below
  and a mirrored bank above) and fills a 16:9 beamer to all four edges. A world CENTRED on the
  artwork (galaxy, kaleido) dims under it harder than the house third and lifts what is outside: the
  core is hidden by definition, so the light goes to the arms that are seen.
- **A long clock wraps at a period its shader is exactly periodic in.** Uniforms are float32: the
  wobble's LFO phase reached 3.4e4 in ten minutes at 250 BPM, which a few hours on is a visible
  stutter. It now wraps at 200π (both its oscillators close there); the night drive at a multiple of
  its lamp and dash spacing; the pixel runner's ground, skyline and stars each at their own.
- **A spring is substepped against its own period.** The `slices` jump was a stiff spring integrated
  in fixed 1/60 s steps; at 250 BPM its period is 84 ms, past where semi-implicit Euler is stable,
  and the position ran to −Infinity in seven seconds — a black world for the rest of the night.
- **Never name a variable after a GLSL built-in.** `float all = …` compiles, and the `all(…)` three
  lines later does not; the world renders black. Tested.
- **Nothing oscillates faster than a frame can show.** Rain's pane "shivered" on the kick at 80
  radians a beat — faster than any refresh rate — which aliased into jitter; it is one thump now.
  And nothing moves at a speed the thing it depicts never has: the record turns a revolution a
  bar (32 rpm at 128 BPM, a real 33), not every two beats (a blur at 180).

**The catalogue: 47 worlds on eleven shelves** (`worlds/catalogue.js` — names and blurbs, no shader,
so naming a world costs nothing; `worlds/index.js` — one LITERAL `import()` per world, so each is its
own chunk: a session of techno never downloads the frenchcore forge).

| shelf | worlds |
|---|---|
| Hard | `forge` (a shaded anvil struck on the kick, spark fountains skittering across a lit floor, the anthem as gold satin), `shatter` (the frame in refracting glass shards), `lasers` (laser fans in smoke over a crowd whose hands go up on the drop, flame columns on big kicks, a liquid sky in the breakdown), `bounce` (a jelly core squashed on the kick), `saw` (a spinning blade and sawtooth lasers — zaag, literally), `stairs` (a raymarched helix whose steps light with the arpeggio), `pingpong` (a neon rally: glass paddles that glide to meet the ball on the beat, one bounce on the far half), `soundsystem` (a speaker wall whose cones pump), `static` (the artwork's own signal torn apart: bands, pixel-sort streaks, chroma-error blocks), `fireworks` (shells aimed at the NEXT beat, in a real show's colours turned to the palette, over a skyline and water that catch every burst) |
| Techno & machines | `tunnel` (a panelled corridor lit only by its ring fixtures, a light running down it on every beat, a polished floor mirroring the ceiling), `warehouse` (concrete pillars, sodium lamps, moving heads sweeping the haze and pooling on a wet floor, strobes that are flashes), `ridges` (Unknown Pleasures), `lattice` (a cone-marched chrome space frame carrying a current), `circuit` |
| Trance & psy | `hyperspace`, `kaleido` (line-art KIFS), `galaxy`, `flow` |
| Bass & breaks | `wobble` (the LFO's own shape, with its wake and current crackling along it), `chrome` (liquid metal), `slices` |
| Urbain | `vinyl`, `halo` (the spectrum as a breathing crown round the artwork, its echoes going out through smoke the 808 pushes aside), `nightdrive` (the wet motorway behind a car whose brake lights flare on the kick), `neon` (a wet street under ten real neon signs — a heart, a martini, a bolt, a moon, notes… — laid out on slots the artwork never hides) |
| Pop & groove | `bokeh` (lens bokeh in a luminous room, with glitter the one thing in focus), `discoball`, `silk`, `artwork` (the cover's own colours), `plasma` |
| Rock & metal | `stage` (the band backlit against an LED wall showing the artwork, beams on a lighting desk's cues, the crowd), `inferno`, `storm` (a cloud deck lit from below by the last light, over a lake that mirrors every strike) |
| Calme | `nebula`, `aurora`, `ocean`, `cathedral` (a Gothic rose of pointed lancets and leaded glass, down a nave of fluted columns), `ink`, `rain` (every drop a lens refracting the city), `fireflies` (a meadow whose fireflies fall into step on the drop) |
| Monde | `carnival` (polyrhythm as rings of beads, under festoons of bulbs chasing the beat), `tropics` |
| Rétro | `horizon` (the banded sun over a true ground plane), `pixels` (a CRT raster, a runner on a real gait, a brick equaliser whose caps fall under gravity) |
| Classiques | `pulse`, `spectrum` — also the fixed `pulse` and `bars` modes |

**A world is machinery; a SKIN is what one genre does with it** (`lib/viz/skins.js`). 226 rows, one
per genre, each naming its world, how its palette leans (`hue` / `sat` / `light`, applied by
`palette.js#setSkin` on top of the source the user picked, never replacing it), its `speed` and
`energy`, and a bag of world parameters. The bag carries two kinds of parameter and only one of them
is worth the table's length: a SCALING one (`sparks`, `shards`, `count`) says how much of the motif
there is; a SHAPE one changes what the motif IS — `kaleido`'s `mirror` 0 is a pinwheel (goa) and
`web` 1 a web (darkpsy, forest), `wobble`'s `wave` is the LFO's shape (sine / square / saw: melodic
dubstep, riddim, brostep), `lasers`' `raw` goes from euphoric sweeps to raw red fire, `slices`' `axis`
turns bands into falling columns (jungle), `tunnel`'s `sides` / `twist` / `dash` make a hexagon, a
helix or strobing rings (EBM, peaktime), `vinyl`'s `rpm` turns a 78 faster than a 33 (swing). The
anchor rows (techno, house, ambient, pop, hardstyle, rock, electronic) override almost nothing: they
ARE the default each world was written around. `skinFor(name, archetype)` normalises whatever it is
handed (an id, a French label, a hand-typed tag with spaces, accents or hyphens) through `ALIASES`
and falls back to the archetype's anchor, which is the same world `catalogue.worldFor` names. A
**pinned** world (`vizWorld` / `vizScreenWorld`, one per screen) keeps the playing genre's colours,
and its parameters only when that genre lives on the pinned world.

**The studio's vocabulary is the same vocabulary** (`analysis.EXTRA_GENRES` + `known_genres()`). The
live classifier honestly separates ~54 families, so a *tag* is where a sub-genre name comes from —
and a label the studio offers that the animation cannot resolve is a track somebody tagged carefully
and then watched get animated generically. The two lists are written in different languages; a test
reads the Python one and requires every label to reach a row of its own, not the archetype floor.

**Nothing hard-switches.** style.js refuses to rename the dominant family until a challenger has led
by a clear margin for a second and a half, and a change of world is a **dissolve**: the new world is
fetched and compiled while the old one keeps playing, and only once it is READY does a noise-edged
burn carry the new picture through the old over one bar (`DISSOLVE_FS`) — so a first visit to a world
is never a black frame. A second change while the first is still dissolving drops the one that was
leaving: three worlds on screen is not a crossfade, and it is three times the work.

**`lib/viz/geometry.js`** is what is left of the canvas-era geometry: it measures the occluder for
`uHole`, and it is the primitives the oscilloscope is drawn on (`place(angle, radial)`, where radial 1
is the frame's own edge rather than a circle inscribed in it, and the expanding `ringRx/ringRy`).
**`place` returns ONE shared array**, reused on every call so a 94 Hz loop makes no garbage: a caller
holding two results at once holds the same array twice, and the segment between them collapses to a
point with no error anywhere. Read the first point's numbers out before asking for the second.

**`lib/viz/post.js` is the CANVAS scenes' post pass** (the scope's bloom and grain) — the GL engine
has its own. What it learned still stands: the bloom is a second, small canvas over the first,
blended by CSS (the obvious build, reading the scene canvas and upscaling on the CPU side, measured
45–52 ms a frame against 0.26 ms for the scene); every `ctx.filter` runs on a small buffer, because
a filter applies over the area drawn INTO; and it times its own first frames and steps down a level
at a time. `webapp/test/post.test.mjs` pins it.

**How the animations are tested — two places, because only one of them has a GPU.**

- **`webapp/test/render/run.mjs`, the render bench** (not part of `npm test`: it needs a browser).
  It starts the Vite dev server, opens `test/render/bench.html` in headless Chromium (Playwright on
  SwiftShader, so no GPU is needed), drives each world through a synthetic arrangement
  (`music.mjs`: intro, builds, drops, a breakdown, at any BPM and genre) and writes a contact sheet
  per world to `test/render/out/` (git-ignored) — the only honest way to review a shader is to look
  at it. `--check` holds every world to the contracts: all four edges carry light in the drop; the
  drop is neither black nor washed out and almost nothing clips; the drop and the breakdown are
  measurably different pictures; on the phone layout under a centred cover, less than a quarter of
  the light sits behind it; and the picture moves materially more over the same two seconds at 180
  BPM than at 90 (`--tempo`). That last one is read three ways and the strongest counts — frame to
  frame on 24×14 blocks (grain and dither cancel; a fast world saturates), over the whole window (a
  calm world's slow drift only shows there) and pixel by pixel (a sea's small waves average out of
  every block) — because a single pair of frames right on a kick measures the kick's envelope, and
  most worlds scored ~1.0 on it. A clock in seconds scores ~1.0 on all three. Feedback worlds are
  warmed for ten seconds before they are judged: they are their own history. The dev server runs
  with no watcher and no hot reload: editing a world during a sweep used to reload the bench page
  under it, and every world after that "crashed" with `window.bench` undefined. By default a world
  runs on its OWN defaults (`fixed`), which is what the contracts are about; `--skin` pins it the
  way the smart engine does, so it wears `--genre`'s skin — the only way to see a shape switch
  (`tunnel` as ebm's helix, as peaktime's dashes) before a user does. `--pscale 2` renders the phone
  layout at twice the size, to read detail.
- **`webapp/test/viz.test.mjs` and `musical.test.mjs`** (node, in `npm test`) pin everything that can
  be decided without a GPU and that a GPU would only ever report as a black screen: the loader, the
  catalogue and the skins agree; every classifier family resolves by id AND by French label, and
  every studio sub-genre to a row of its own; every skin names a real world with parameters that
  world declares, and every world is some genre's picture; neighbours sharing a world (goa/darkpsy,
  dubstep/brostep, gabber/speedcore…) differ on a SHAPE switch; every `P_` define and every uniform a
  shader names is one the engine declares, and no variable shadows a GLSL built-in; the engine
  exposes no seconds clock. Then every world's DRIVER is run at 90 and 180 BPM over the same wall
  clock — measured 1.82x (flow) to 2.31x (forge) as far; a rate in seconds scores 1.00 — for ten
  minutes at 60 and at 250 BPM with quarter-second hitches (no NaN, no state past 1e4), and must
  stamp its events in beats near now. It found both faults above the day it was written: the
  diverging spring and the unbounded clocks. The oscilloscope's own tests (the trace against real
  samples) are unchanged and live there too.

**No constant that should be musical** (`lib/viz/musical.js`) is still the layer every driver reads:
`m.overBeats(n)` is a lifetime, `m.perBeat(n)` a rate, `m.ease(v, target, beats, dt)` a smoothing,
and the shape of the moment comes off `m.drive` / `m.weight` / `m.build` / `m.breakdown` /
`m.dropped`, plus the stamps (`m.stamp.main`, `.snare`, `.drop`, …) a driver turns into events. The
old canvas scenes had to be policed into it by a stopwatch test; the shaders cannot break it, and
the drivers are held to it by the test above.

**ANALYSIS AND RENDERING ARE DIFFERENT THINGS, and `lib/viz/bridge.js` is the line between them.**
The sound is analysed ONCE, in the tab that has the audio — one beat tracker, one classifier — so
the genre, the tempo and the grid are decided once and both screens agree by construction. What
crosses the channel is that analysis. What each side does with it is its own business: the player
and the projector pick their own scene (`vizMode` / `vizScreenMode`), their own quality tier and
their own frame rate, and neither waits for the other. The player can sit on "Aucune" while the
projector runs, which is a supported arrangement and now has a button for it.

The level the analysis runs AT is the only thing that must be shared, and it is **the most demanding
of the two**: the viewer announces what its scene needs (`lv` on its hello, re-announced when the
projector's mode changes), `host.js` subscribes at that level, and the engine's own
`recomputeLevel` maxes it with whatever this tab wants — so the rule falls out of machinery that
already existed.

**Why the two screens used to drift apart** — it was never a clock problem, it was a sampling one.
The engine runs at ~94 Hz and the channel publishes at 45, so a beat, which is true on exactly ONE
analysis frame, had a better than even chance of landing in a frame the throttle dropped: the
projector was missing about half of every track's beats, kicks and downbeats. Continuous values can
be sampled; **events have to be latched**. `beat`, `downbeat`, `kickHit`, the style kick's `hit` and
the peak `onset` are accumulated across the dropped frames and cleared once sent. `kickHit` was also
simply absent from the payload, so every animation that fires on a kick never fired at all on the
second screen — which was every animation built on the kick. `webapp/test/bridge.test.mjs` pins both halves:
no event lost to the throttle, and no event reported twice.

**The projector window** (`routes/Viz.svelte`, `lib/viz/bridge.js`, `lib/viz/host.js`) is the same
SPA on `#/viz`, opened in a second tab to be dragged onto a beamer. It plays **nothing**: a second
`<audio>` would be a second stream, a second decode and a second playhead drifting out of sync with
the room within a minute. The playing tab publishes its analysis frames over a BroadcastChannel
(~800 bytes at 45 Hz — the melodic channel, the dynamics gate and the `look` vector are in there
too; without them the projector ran the same scenes with no quiet passages, no melody layer and the
neutral default look, which is most of why the second screen looked more generic than the player it
mirrors) and the projector renders them — one decode, one analysis, one timeline. A
live viewer is also what tells the engine to keep running while the player tab is hidden. That
window never writes the playback session back (`DISPLAY_ONLY` in `stores.js`): its snapshot is
frozen at the moment it opened, and writing it would roll the real player's position back to then.

Three things keep that link alive, and each fixes a way it used to die:
- the engine's **upgrade to the audio-thread clock is retried**, not attempted once. An AudioWorklet
  needs an AudioContext, and the context only exists once something wired the player's element into
  the graph — which normally happens *after* a projector window has subscribed. Giving up on the
  first look left the engine on rAF for the session, and rAF stops in a hidden tab: the projector
  froze the moment the player went behind it.
- liveness is a **transport heartbeat**, not the frames. A paused player sends no frames and is
  still very much there, and the viewer's own ping is a `setInterval` in a window browsers throttle
  to once a minute — so the timeout is generous (90 s), a closing window says goodbye, and a
  re-woken one re-announces at once.
- **more than one tab can publish.** Leaving the app open twice is ordinary, and both tabs answered
  a projector's hello, so it showed whichever landed last — for an idle second tab, "nothing
  playing" over the top of a tab that was playing. Every message carries its sender and the
  projector follows ONE: it prefers a tab reporting playback and only lets another take over once
  that one goes quiet.

**Animations stop when the music does.** `Visualizer.svelte` takes a `paused` prop: it keeps drawing
through a 600 ms fade so the scene winds down rather than freezing, then stops the loop, drops its
engine subscription and clears the canvas. The projector learns the transport state from the
heartbeat and does the same.

**Eco mode** (`ecoMode` in stores.js, `EcoToggle.svelte`) is the switch above all of them: no
animation anywhere on the device — the visualizer, the backdrop's crossfades and the live lyric line
— without destroying the setup underneath, so turning it off restores exactly what was there. It
lives in the full-screen player footers next to the quality chip: one tap away, and taking no place
in the transport row. `effectiveMode` returns `"off"` for it, and **"off" means no canvas anywhere**,
the settings preview included — a preview that kept a canvas alive to show what was just switched
off would be precisely the waste the setting exists to stop.

**Crossfade + silence trimming** (`components/Player.svelte`, `lib/edges.js`,
`supysonic/webui/edges.py`). Two ideas that need each other: masters carry a beat of digital silence
at each end, and a crossfade that ignores them fades one track's silence into another's — the gap it
was meant to remove. The server measures the bounds once per (file, threshold) with ffmpeg's
`silencedetect` and caches them; it **never archives to answer**, so asking about the next track can
never start a download, and a file that is not on disk simply answers `ready:false` and plays
untrimmed. The handover happens at the **start** of the fade, not its end: the incoming element
becomes `audio` and the queue advances there and then, so the seek bar and the lock screen name the
track you are beginning to hear. A manual skip is not an overlap — it gets a 60 ms ramp, long enough
to kill the click of a cut mid-waveform and short enough to be inaudible as a delay. Crossfading
needs the Web Audio graph, so like the effects it is off by default (see the note in `graph.js`
about a suspended AudioContext silencing a backgrounded tab).

## Database / schema

Peewee ORM. `SCHEMA_VERSION` in `supysonic/db.py` is a date string (currently `20260919`); bump it
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

**A TEST EXISTS TO SAY HOW THE THING BEHAVES IN REAL CONDITIONS.** Not to say that there is a test.
Three perfect frames of a sound nobody has ever recorded prove nothing, because no sound is perfect
— so a test that draws its input is testing its own drawing, and the bar is: understand the music,
then simulate it the way it is actually made. This applies to everything in this repository, and
every claim a test makes should be a MEASURED number written down next to the assertion.

`webapp/npm test` (node --test, no dependency to install) is the SPA's suite. Its audio half drives
the **whole analysis chain** — real audio through a real FFT into `features.js` into `tempo.js` into
`pattern.js` — on sixteen records, because every fault listed above passed a suite that drove one
module at a time with material chosen to suit it. Its animation half (see **How the animations are
tested**) pins what can be decided without a GPU — the catalogue, the skins, the shader contracts,
the drivers' musical time — and leaves the pixels to the render bench (`test/render/run.mjs
--check`), which is not part of `npm test` because it needs a browser. Run it after touching a world.

`test/synth.mjs` is the instrument: it writes **samples**, not spectra, and analyses them with an
iterative radix-2 FFT and a Hann window scaled exactly as `AnalyserNode.getFloatFrequencyData`
scales it. Drawn spectra have no leakage, no phase, no intermodulation and only the harmonics
somebody remembered to draw, and every one of those absences hid a fault: a lead's filter transient,
a hat's skirt, a pad beating against itself. Every source is the production recipe for the sound it
names — a pitched sine swept and driven into a waveshaper and a clipper, three detuned saws through
a moving low-pass and a **24 dB/octave** mix low-cut (the order is the part that matters: a lead's
low end is a filter transient, not a fundamental, and 6 dB/octave does not remove a transient), a
kick sub layer that outlasts the punch, a real lookahead limiter, rolls shortened to fit their
subdivision, a reverse bass modelled as the sidechained note it is rather than a gated one.

Three rules hold it together, and each was bought:
- **Keep it physical.** Every knob corresponds to something a producer does. A test that only passes
  because the generator is unrealistic is worse than no test — and when the instrument is wrong, fix
  the instrument FIRST: making the hi-hat a real hi-hat did not stop it being convicted, which is
  what turned a mystery into a stated fault in `features.js`, where the fix belonged.
- **Never move the material to make the code pass.** If the two are genuinely inseparable, say so in
  the test with the measured evidence and assert the layer that *does* resolve it.
- **Score both ends on the same window.** A detection belongs to the kick it is nearest to and is
  scored only if that kick is inside the window. Scoring detections over one interval and ground
  truth over another invents faults at the seam — two of the three outliers in the whole suite were
  a kick rendered at exactly 30.000 s being dropped from the ground truth while its perfectly good
  detection at 30.016 s stayed. For the same reason the bench never analyses past the music: a
  window straddling the end of the buffer is a step function, and the FFT of a step is broadband
  splatter weighted to the bottom, which the kick detector convicts and is right to.

Renders and analyses are memoised per options object, which is what keeps the suite at ~30 s.

All proxy/web tests run offline with mocks: `tests/test_deezer.py` (mock provider),
`tests/test_webui.py` (`MockGW` + `MockApi` cover every `/api` route), `tests/test_graphql.py`
(fake session routing auth-vs-pipe POSTs by host), `tests/test_deezer_resilience.py` (a fake HTTP
adapter that times out / answers garbage, pinning the rules above: the breaker opens and stops
costing sockets, retries stay inside their budget, and no transport failure ever condemns a track or
a show). Note that its circuit breaker is a process-wide singleton — reset it in `setUp` when a test
trips it. `tests/net/` hits real services and is CI-only.
`tests/test_webui.py::GenreStudioTestCase` covers the studio's API without onnxruntime (which is
the normal install): the vectors it reads are written by `struct`, so the whole tagging/training/
shipping path is exercised on a stock server. It also covers the extractor's upload/delete round
trip and that the operator's `embed_model` is never deleted. Its "a head that does not fit is
refused" test deliberately logs a traceback — that is the refusal working.
Add a test alongside these when touching the proxy or `/api`.

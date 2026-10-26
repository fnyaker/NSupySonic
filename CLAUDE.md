# CLAUDE.md

NSupySonic is a fork of [supysonic](https://github.com/spl0k/supysonic) (a Python Subsonic API
server) wired into a **Subsonic ↔ Deezer proxy**, with its own Svelte web player at `/app` and a
native Android app (`android/`). Tracks are fetched in FLAC, archived once, and transcoded to Opus
on demand. AGPL-3.0, Python 3.10+. `AGENTS.md` is this same file.

This file is SHORT on purpose: it is the process and the rules every task follows. What each part
of the code learned the hard way lives in `docs/agents/` and is read **only for the areas a task
touches** (step 2 below). Do not paste area detail back in here.

## The process — every task, in this order

1. **Restate the need.** What will the person DO with the result, on which device, on which
   network (a phone on a bad mobile link is the default case, not the edge case)? A request names
   symptoms; find the cause before choosing a fix.
2. **Read the notes for what you touch, and nothing else.** Pick the rows of the table under
   *Area notes* that match the files you will change, read those files, and follow their rules.
   Then read the code itself — the notes say why, the code says what.
3. **Research before inventing.** Any behaviour, algorithm or design the person did not specify is
   researched first in SEVERAL online sources (papers, the reference implementation, how the
   established apps do it), and the sources are named in the PR. Never "do as I think".
4. **Write the change against the rules below**, the seven of *Non-negotiable rules* first.
5. **Test it the way it will be used** (see *Before pushing*). Measure, and write the numbers in
   the PR and next to the assertions.
6. **Push, open the PR, drive CI to fully green, merge without asking.** Then the next lot of the
   same plan starts at once — never ask before chaining lots.
7. **Write down what you learned** in the matching `docs/agents/` file (a rule, why, the measured
   number). A rule that applies to every area goes here, in one or two lines.

## Non-negotiable rules

These are the person's own standing requirements. Each one has been broken before, and repeating
them cost the person their patience.

1. **What the person does NOW comes first — always.** Order of priority, on the server AND on the
   device, for threads, download slots, CPU, disk and **network bandwidth**:
   (a) the action just taken (the track tapped plays NOW, the screen opened paints NOW);
   (b) preloading what comes right after it (the next track once this one plays, the next screen);
   (c) everything else — playlist/offline downloads, account sync and import, archiving, analysis,
   backfills — which must YIELD while (a) or (b) needs the resource: paused or throttled, never
   competing. A background download that slows a tapped track is a bug, not a trade-off. The
   mechanisms already exist — use them, never bypass them: `supysonic/deezer/workload.py`
   (`Priority` USER/PREFETCH/BULK, `X-NS-Background`, `renice`, `quiet_wait`),
   `webapp/src/lib/ladder.js`, `webapp/src/lib/coverqueue.js`; details in
   [server.md](docs/agents/server.md) (*A person waiting in front of the app…*). Any NEW consumer of
   the network or the CPU must plug into them.
2. **Long work runs in the background and SAYS SO.** Anything that can take more than ~1 s (a sync,
   an import, a library job, a bulk download) runs on a worker, never in a request thread, never
   blocks a screen, and never slows the server for others (bounded concurrency, reniced). The UI
   shows that it is running, its progress, and when it ends what it did or the CAUSE of each
   failure (never just a count). A button that seems to do nothing is a bug. Jobs resume after a
   restart instead of starting over.
3. **Built for a slow, flaky mobile link.** Count requests and bytes for every screen and action;
   nothing fans out unbounded; nothing retries in a storm; a failure fails fast and offers
   "Réessayer"; what was fetched once is kept on the device. A screen that cannot load says why
   (`LoadFailed.svelte`), never an endless spinner.
4. **Every click is fast, and it is measured.** A click must answer at once (optimistic UI, then
   the network). Worst realistic input, not the happy path: an 8 000-track library, a 4 000-track
   queue. Long lists are windowed (`VirtualList.svelte`, `TrackList.svelte`). Tools:
   `tools/perf_api.py`, `webapp/test/clicks/run.mjs`, `webapp/test/ui/run.mjs`,
   `webapp/test/requests/run.mjs` (all in [commands.md](docs/agents/commands.md)).
5. **Premium UI.** Every screen looks like a senior design team sweated it: no cramped controls, no
   default-looking widget, no micro-freeze, no emoji (glyphs through `Icon.svelte`), French UI copy.
   When a layout feels off it IS off — fix the small inconsistencies too.
6. **Everything configurable is configurable from the web UI** (Réglages), API keys and credentials
   included; only file paths may stay config-file-only. A value set in the UI lives in `Meta` and
   overrides the file.
7. **Upgrading an existing server just works.** Old config file, existing database (a migration for
   SQLite, PostgreSQL AND MySQL), existing archive and devices with an older app or SPA. Every
   change that touches config, schema, stored data or the client/server contract is tested as an
   upgrade, and on a real PostgreSQL when the database is touched.

And the architecture's own rules, detailed in the area notes:

- **Always archive FLAC, transcode to Opus (320/128/64). Never stream MP3 straight from Deezer.**
  (Exception: the YouTube fallback keeps its original Opus.) Deezer entities are ordinary supysonic
  rows, so the Subsonic API works unchanged; only streaming is intercepted.
- **Deezer is optional to the app running.** Everything on disk works at full speed with Deezer
  unreachable; what needs Deezer fails fast. **A failure to reach a provider is never a verdict**
  about a track or a show. Nothing the user does writes to the Deezer account
  (`tests/test_detach_guard.py`). → [server.md](docs/agents/server.md), [providers.md](docs/agents/providers.md)
- **Security.** Every route `@login_required` (or a capability token), ids validated, ownership
  checked, client-supplied ids/paths never trusted, hostile input neither crashes nor leaks. Never
  commit secrets: the ARL is a full-account credential; `.env`, `config/supysonic.conf`, `dist/`
  and `*.har` captures are gitignored.
- **Nothing deletes archived audio** except `deezer/cleanup.py`, and never an upload.

## Before pushing (definition of done)

- **Does it break anything else?** Trace what else reads this state, store or DOM shape.
- **Same result, cheaper?** Prefer not doing the work (render only what is visible) to throttling it.
- **Tested for real, logic AND screen.** Run the suites that cover it (below). A change to a
  component is OPENED in headless Chromium (a bench under `webapp/test/*/run.mjs`, or a throwaway
  Playwright script on `tools/perf_api.py --serve`) and LOOKED at in a desktop window, on a phone,
  and in the full-screen player's narrow side panel. What a bench can hold (a geometry, a request
  count, a statement count) gets a check, run once against the old code to see it fail.
- **Tests say how it behaves in real conditions**: real ffmpeg, real audio, counts not times, waits
  on events not clocks. → [testing.md](docs/agents/testing.md)
- **Upgrade path tested** (rule 7) and **background work yields** (rule 1) when relevant.

## CI and merging

Seven workflows (`tests`, `webapp`, `docker`, `network`, `android`, `release`, `security`). **Fully
green means every job of every workflow that ran, including the security scanners.** `security.yaml`
(CodeQL, Semgrep, Bandit, Trivy, Gitleaks) is `continue-on-error`, so its check can show green with
findings: read each job's log and fix every finding the change introduced (or mark a false positive
with a justified inline `nosec` / `nosemgrep`). Fix a red check whatever caused it. Once fully
green, merge without asking. No skipped or disabled test to get there.

## Area notes — read the ones you touch

| You touch… | Read |
|---|---|
| any test, bench or build command | [commands.md](docs/agents/commands.md), [testing.md](docs/agents/testing.md) |
| `deezerpy/`, `supysonic/deezer/` (provider, archive, prefetch, backfill, rules, cleanup, importer, podcasts, YouTube, unavailable tracks, recommendations/radio/releases), `supysonic/webui/` routes, `supysonic/api/media.py`, priorities and background jobs | [server.md](docs/agents/server.md) |
| `supysonic/providers/`, `sources.py`, `access.py`, accounts, groups, library import | [providers.md](docs/agents/providers.md) |
| `android/` (WebView, native player, offline store, updater, Deezer login) | [android.md](docs/agents/android.md) |
| `webapp/src` screens, routing, back navigation, offline cache, service worker, code splitting, queue, search, sleep timer | [webapp.md](docs/agents/webapp.md) |
| `Player.svelte`, crossfade, silence trim, direct/processed output, `webapp/appcore`, big-list cost | [playback.md](docs/agents/playback.md) |
| server-side analysis (tempo, descriptors), genre studio, embeddings, genre tree | [analysis-genre.md](docs/agents/analysis-genre.md) |
| `webapp/rhythm` (live analysis: kick, tempo, beat, pattern, style), `lib/audio/latency.js` | [rhythm.md](docs/agents/rhythm.md) |
| `webapp/src/lib/viz/` (worlds, skins, shaders, scope, projector, eco mode) | [animations.md](docs/agents/animations.md) |
| listen party, remote control | [party-remote.md](docs/agents/party-remote.md) |

Plans and studies: `docs/detachement-deezer.md`, `docs/multi-provider.md`, `todo.md`.

## Essential commands

```sh
pip install -e . && pip install lxml coverage        # dev install (a project .venv is expected)
python tools/partest.py                              # Python suite in parallel (what CI runs); takes test ids
python -m unittest tests.test_webui.SomeClass.test_x # one test (unittest, no pytest)
NS_REQUIRE_FFMPEG=1 python tools/partest.py          # fail, don't skip, without ffmpeg
cd webapp && npm install && npm test && npm run build   # SPA suite and build (-> supysonic/webui/dist)
cd webapp && npm run wasm                            # after touching a Rust crate; commit the .wasm files
python tools/perf_api.py [--serve]                   # every /api route timed on a big synthetic library
docker build -t nsupysonic:dev . && docker/smoke.sh nsupysonic:dev
```

Every browser bench and the rest: [commands.md](docs/agents/commands.md).

## Database / schema

Peewee ORM. `SCHEMA_VERSION` in `supysonic/db.py` is a date string (currently `20261031`); bump it
and add a migration under `supysonic/schema/migration/{sqlite,postgres,mysql}/` when changing the
schema. SQLite by default; Postgres/MySQL supported (PostgreSQL has no REPLACE: write portable
upserts). A migration script is split on `;` AFTER its `--` comment lines are dropped
(`db.split_sql_script`); `tests/test_schema.py` requires each piece to be a statement.
Every migration since `20260808` is idempotent: each boot checks the models against the database (one
query) and replays them if a column or table is missing (`db._repair_skipped_migrations`; a data-only one,
`DATA_MIGRATIONS`, only with its column). Keep new migrations idempotent.

## Config & secrets

Either env vars in `.env` (`DEEZER_ARL`, `SUPYSONIC_ADMIN_*`, `DEEZER_QUALITY`, `DEEZER_SYNC_AT`,
read by `docker/entrypoint.sh`) or a mounted `config/supysonic.conf`. Every option is annotated in
`config.sample` and `config/supysonic.conf.example`.

## Keeping these notes useful

- This file stays under 16 KB (`tests/test_agent_docs.py` checks it, and that every area file is
  listed in the table). New detail goes into the area file it belongs to.
- An area note states the rule, why it exists, and the number that proved it — not a changelog.
- Stale notes are worse than none: when code changes a documented behaviour, update the note in
  the same PR.

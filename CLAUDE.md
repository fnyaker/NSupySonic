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
This applies to both the web player and Subsonic clients. The one exception is the YouTube
fallback (below): YouTube has no lossless audio, so its original Opus is archived as is. Deezer entities are materialized as
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

## Quick commands

```sh
python -m unittest                      # Python suite (~55s); one module: python -m unittest tests.test_deezer
python tools/partest.py                 # same suite across processes (~12s, what CI runs)
supysonic-server                        # serves on :5722 (web player at /app, Subsonic at /rest)
cd webapp && npm install && npm run build   # SPA -> supysonic/webui/dist
cd webapp && npm test                   # SPA suite (node --test)
```

Everything else (wasm rebuilds, browser benches, CLI, Docker, CI) is in `docs/claude/commands.md`.

## Detailed docs: read ONLY what the task touches

The deep design notes live in `docs/claude/` (one topic per file, each starts with a "Read when" line).
This file stays short on purpose: **before editing an area, open its file below** — they hold
rules learned from production outages and measurements ("do not regress"), so skipping one risks
re-introducing a fixed bug. Use `grep -rn <term> docs/claude/` to find where something is documented.

| If the task touches… | Read |
|---|---|
| Test/build/CLI/Docker/CI commands | `docs/claude/commands.md` |
| First orientation: deezerpy / supysonic/deezer / webui layers, `/api/stream`, stream decrypt | `docs/claude/architecture.md` |
| **Any Deezer network call**, timeouts, retries, circuit breaker, SSRF on podcast URLs, outage UX | `docs/claude/resilience.md` |
| Podcasts (shows, episodes, progress, markers) | `docs/claude/podcasts.md` |
| Unavailable tracks, replace/delete, YouTube fallback, audio auto-match | `docs/claude/unavailable-youtube-automatch.md` |
| Archiving events, download queue priorities, archive rules, cleanup, API perf/ETag/precompression | `docs/claude/archive-workload.md` |
| SPA screens, queue, nav/back, offline & service worker, ReplayGain, lazy routes | `docs/claude/webapp-ui.md` |
| Server-side tempo/genre analysis (`analysis.py`, `beats.py`) | `docs/claude/server-analysis.md` |
| Genre studio: embeddings, trainer, tagging, references | `docs/claude/genre-studio.md` |
| Rhythm analyser (Rust): audio thread/delivery/latency | `docs/claude/rhythm-audio-thread.md` |
| …kick detector, `features.rs` | `docs/claude/rhythm-kick-features.md` |
| …tempo, beat grid, served tempo, bar models | `docs/claude/rhythm-tempo-beat.md` |
| …pattern, style classifier, piep, genre channel | `docs/claude/rhythm-pattern-style.md` |
| Animations: registry, Rust CPU side, oscilloscope | `docs/claude/viz-core-scope.md` |
| Animations: WebGL engine, worlds, skins, catalogue, house style | `docs/claude/viz-gl-worlds.md` |
| Animations: tests, render bench, projector/bridge, eco mode | `docs/claude/viz-testing-bridge.md` |
| Crossfade, silence trim, direct vs processed audio path | `docs/claude/audio-output.md` |
| App core Rust (sync estimators, track-list index), big-list cost | `docs/claude/appcore.md` |
| Listen party | `docs/claude/party.md` |
| Remote control (and **any new `/api` route**: it must be classified in `POLICY`) | `docs/claude/remote.md` |
| Schema/migrations (`SCHEMA_VERSION`), config, ARL/secrets | `docs/claude/db-config.md` |
| Writing/changing any test | `docs/claude/tests.md` |
| Genre similarity graph, genre radios (`/radio`) | `docs/claude/radio-genres.md` |
| Running the analysis in the browser (WASM) — findings and blockers | `docs/claude/client-analysis.md` |
| Native Android app / WebView shell | `docs/claude/android.md` |

Cross-cutting reminders (details in the files above): archive FLAC, transcode to Opus, never stream
Deezer MP3; Deezer is optional to the app running; a failure to reach Deezer is never a verdict about
the data; a person waiting outranks background jobs; keep docs in step — when a change alters a
documented rule or measurement, update the matching `docs/claude/` file in the same change.

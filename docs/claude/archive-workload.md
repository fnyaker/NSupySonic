# Archive completeness, priorities, rules, API perf, cleanup

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching archiving events, the download queue, request-thread budgets, archive rules, cleanup, play counts, or API response time/ETags/SPA precompression.

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
  it if the client disconnects; a cold Opus request is that same live stream piped through ffmpeg
  as it downloads (`webui._opus_live_generator`: a feeder thread owns the source, 100 ms Ogg pages,
  first audio 0.26 s at 512 KB/s where it used to wait for the whole FLAC);
  `api/media.py::_ensure_deezer_archived` calls `ensure_archived` outright; podcast episodes archive
  on first play too). An archive is TAGGED BEFORE IT IS PUBLISHED (`archive._tag_archive`): tagging
  rewrites the file in place, and a published file is being served;
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

**Response time is measured, on a library the size real ones reach** (`tools/perf_api.py`: 8 000
tracks, a 4 000-track playlist, 4 000 favourites, sixty playlists, Deezer off so the answer is this
server's own work). Four rules came out of it, each with its number:

- **A big list is read as TUPLES** (`webui._db_track_rows`, reached through `_db_tracks` whenever it
  is handed a query). Three quarters of a 4 000-track list's time was Peewee building a Track, an
  Album and an Artist per row — three UUIDs and a datetime parsed, a setattr per column — for
  `_db_track` to flatten straight back into a dict. Selecting exactly the columns the JSON carries,
  with the UUIDs read as text (`_raw`: a CAST, spelled CHAR on MySQL) and the credits read through a
  subquery on the list's own selection instead of ten 400-parameter IN lists: favourites **405 → 99
  ms**, a 4 000-track playlist **447 → ~110 ms**, byte for byte the same answer
  (`tests/test_webui_lists.py` compares the two paths on every shape a row takes). A query with a
  LIMIT keeps the id lists — MySQL refuses LIMIT inside IN.
- **Nothing is counted per row.** `/me/playlists` asked two statements per playlist (122 for sixty,
  90 ms) and is four in all (24 ms); `/me/favorite-ids` hydrated every starred row twice to read one
  id (314 ms) and is one two-column query (19 ms); an artist's album grid and the podcast list counted
  per album / per show and are one grouped query each; the mix fallback no longer lazy-loads each
  row's album and artist (`pl.get_tracks()`). The tests pin statement counts, not times.
- **Every JSON GET carries a validator** (`web.py#_validate`: a weak ETag over the body and
  `private, no-cache`). The web app repaints a list from its offline copy and asks again on every
  visit, and the answer is usually identical — 2 MB of JSON and 30 ms of gzip to say nothing changed.
  Now the browser revalidates on its own and an unchanged list is an empty 304.
- **The SPA's own files go out precompressed.** They are sent as files (passthrough), which the
  on-the-fly gzip never touched: the main bundle went out as 460 kB. The build writes a brotli and a
  gzip copy of every text and wasm file that compresses (`vite.config.js#precompress`) and `spa.py`
  serves the smallest one the client accepts (`Vary: Accept-Encoding`, the type still the file's):
  main bundle **460 → 132 kB**, the analyser **219 → 71 kB**, the app core **63 → 19 kB**.

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

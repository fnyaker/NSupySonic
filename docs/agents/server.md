# Server architecture: Deezer, archive, resilience, background work

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).


**The frontier (detachment, lots A-I).** Deezer is a supplier of SOUND and of catalogue FACTS, nothing
else. An archived track is a file like an upload: identity (UUID of the row), cover, tempo, genre,
gain, lyrics, neighbours, radio and home are all this server's own, from the database and the disk.
Nothing the user does writes to the Deezer account (no star, playlist, listen or position is
mirrored; there is no option for it), and nothing reads the account except the ONE-OFF import in
Réglages → Compte Deezer (`importer.import_account`: playlists and favourites, added, never removed).
`tests/test_detach_guard.py` enforces it: a spy client, every `/api` route visited, and an `ALLOWED`
list of the calls that fetch sound or catalogue facts — adding a Deezer call means adding it there.
What stays on Deezer on purpose is listed in `docs/detachement-deezer.md` (D18).

Three code layers, from low to high:

1. **`deezerpy/`** — the vendored Deezer client (based on RemixDev's deezer-py). Two transports
   with deliberate reliability roles (learned the hard way; do not "simplify" back to one):
   - `api.py` — **public `api.deezer.com`**. Used for **search**, the **catalogue charts**
     (Explore) and **artist pages**. Stable, typed, returns image URLs.
   - `gw.py` — **private gateway `gw-light.php`**. Used for album/playlist/show pages, the track
     records, track and artist radio seeds, the one-off account import and stream tokens.
   - **Gotcha — full tracklists:** album/playlist *page* calls only return the first ~10–40 tracks.
     Always fetch the full list via `get_album_tracks` (`song.getListByAlbum` nb:-1) /
     `get_playlist_tracks` (`playlist.getSongs` nb:-1).

2. **`supysonic/deezer/`** — the proxy logic:
   - `provider.py` — ARL login + stream decryption; the single object the rest of the app talks to.
   - `archive.py` — `ensure_archived` (first-play fetch → Blowfish-CBC decrypt → tag → store under
     `archive_dir`) and import helpers.
   - `library.py` — DB upsert + deterministic archive paths. `ids.py` — deterministic `uuid5` IDs
     from Deezer IDs (plus nullable `deezer_id` columns on Track/Album/Artist/Playlist).
   - `importer.py` — the one-off account import (`import_account`) and the scheduled refresh of
     subscribed podcasts (`sync`); writes straight to the DB and never to Deezer. The playlists the
     old nightly sync wrote ("Deezer · Flow", smart tracklists, "Nouveautés en vrac") are ordinary
     playlists now: kept, never refreshed or purged.
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
- **Reaching Deezer again is the SERVER's job, never the client's.** A page only Deezer has, asked
  while Deezer does not answer, is a 503 marked `X-NS-Error: deezer-unreachable` (`_deezer_missing` /
  `_deezer_unreachable`, with `retry_in`); the proxy switched off is `deezer-disabled`. `lib/api.js`
  reads the header as final and never retries it (an unmarked 503 — a restart — still is): the
  server's calls already retry inside their budget and the breaker probes once its cooldown is over,
  so three client retries only fetched the same instant refusal ~3 s later. Deezer ANSWERING that a
  thing is not there stays a 404. The screens say "Deezer est injoignable" (`LoadFailed.svelte`),
  never "introuvable", and only the person's "Réessayer" asks again.
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

**Decrypting a stream** (`provider.decrypt_blocks` / `iter_decrypted`). Deezer encrypts the 2048-byte
blocks at FILE offsets 0, 6144, 12288… — every third one, each its own CBC chain (IV `00..07`), never
a short last block. The body is re-cut into those blocks by byte count, whatever pieces the network
delivers it in: a chunked response arrives in HTTP chunks of any size (`iter_content(2048)` caps a
piece, it never fills one), and counting pieces — which the code did until a test ran it over a real
connection — decrypted every chunked response into noise. One ECB cipher per stream with the chain
applied by hand, not a CBC cipher per block: re-running Blowfish's key schedule 6800 times was 70% of
the cost (0.44 → 0.16 s of CPU per 40 MB FLAC, same bytes). **Nothing that does not open like audio
is archived**: the first decrypted bytes must be `fLaC`, `ID3` or an MPEG frame sync
(`looks_like_audio`), an empty body is an error, and `download_to` removes its `.part` whatever
stopped it. An archive is forever — a file on disk is what "archived" means — so noise kept there
would never be fetched, or play, again. `/api/stream` reads the first block before answering, so
that refusal is its 502 rather than a response dying half-sent. Podcast episodes get the same
guarantee the other way round: their hosts serve every kind of audio, so `iter_episode` refuses what
is certainly NOT audio — markup or JSON (an error page or a consent wall answered with a 200), or an
empty body (`looks_like_a_page`) — instead of listing formats it would one day be wrong about, and
`download_episode_to` drops its partial too.

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
its localStorage copy newest-wins (`webapp/src/lib/podcastProgress.js`); nothing is sent to Deezer.

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

**YouTube is a FALLBACK, never a second catalogue** (`supysonic/deezer/youtube.py`,
`supysonic/webui/youtube.py`, `webapp/src/lib/youtube.js`; optional extra `supysonic[youtube]`:
`ytmusicapi` + `yt-dlp` + `yt-dlp-ejs`, with Deno in the image for yt-dlp's challenge solver). It
is reached in exactly two ways, both a person asking: the search screen's **YouTube** box (unticked
by default, asked on Enter or when ticked — never per keystroke) and the replacement sheet's
*Chercher aussi sur YouTube*. Every rule is about calling YouTube as little as possible:
- **Search is ONE request** to YouTube Music's API (`ytmusicapi`, `filter="songs"`: title, artists,
  album, duration, square art; ~0.9 s), kept a day per query, empty answers too. yt-dlp never
  searches.
- **A hit costs nothing until it is played.** It is served under the UUID its row WILL have
  (`ids.youtube_track_uuid(video_id)`) and its metadata is remembered (`remember`/`recall`: memory
  + the disk cache), so starring it, adding it to a playlist or choosing it as a replacement
  creates the row from the search's own answer (`webui/youtube.materialize`, reached from
  `/stream`, `/favorite`, `_resolve_tracks`, `availability._resolve_local`) — no second request.
  An id whose hit is forgotten is simply unknown.
- **The audio is fetched once, on the first PLAY** (`ensure_archived`: one extraction + one
  download, ~2 s for five minutes, serialized per video, two at a time), staged in
  `archive_dir/.youtube-staging` (the local scanner skips dot-directories) and published under
  `archive_dir/YouTube/<artist>/<album>/<title> [<id>].opus` with tags, cover and a `.json`
  sidecar. A prefetch (`X-NS-Background`) never fetches; nothing bulk-archives it; the cleanup
  never deletes it (it only considers `deezer_id` rows). Subsonic's `stream` goes through the same
  call (`api/media._ensure_youtube_archived`).
- **The original stream is kept, never re-encoded**: Opus ~130-160 kbit/s (format 251) remuxed to
  Ogg with `-c copy` (AAC/m4a only when YouTube has no Opus). `/stream` serves the file as is unless
  the client asks for LESS than it holds (`TRANSCODE_MARGIN`), and the player shows the real rate
  (`SourceBadge.svelte`: "YT 133k" beside a FLAC or Opus 320 chip; read once from `/probe`).
- A row is `deezer_id NULL` + `youtube_id` set, so it is NOT an upload: `scan_local` never prunes
  it, `/me/local` and the local search skip it until it is archived, the probe answers "unknown"
  without asking anyone, and `verify_gone` only accepts YouTube's own verdict. Its artist/album
  carry no id in the API (no page to open: empty ids are "not a link" to the SPA).
- **Failing is not a verdict, and a refusal is left alone**: only YouTube answering that a video is
  gone (`YoutubeUnavailable`) marks a track unavailable; a network failure holds YouTube off for a
  minute and a refusal (429, "confirm you're not a bot") for fifteen (`held`), during which nothing
  is asked. The admin switch (Réglages → *Source de secours : YouTube*, `Meta yt.enabled`) turns
  it off for everyone; what is archived keeps playing. `tests/test_youtube.py` counts the requests.

**Importing a shared playlist** (`supysonic/linkimport.py` reads the link, `webui/playlist_import.py`
matches and keeps it, `routes/Import.svelte`; reached from a link pasted into the search box and from
the library). Deezer, Spotify (its public embed page), YouTube (`ytmusicapi`) and Apple Music (the
share page's own JSON): no account, no token. **The pasted text is only ever parsed** — every request
goes to a fixed host with a validated id, and a short link's redirect is followed by hand, each hop
required to stay on the same service. Each line is matched library first (on disk: free, and it
never vanishes), then Deezer (the ISRC when given, else a search), then YouTube (a YouTube link's own
video, or one search) — by the replacement sheet's own `match_score`, or `closeness` ≥ `PLAUSIBLE`
with the artist credited (`sure: false`, listed under "À vérifier"); anything less stays unmatched,
since a wrong song is worse than a hole. A worker job (4 searches in flight), polled; the result is
TEMPORARY (process memory, 3 h) and plays as it is. *Enregistrer* (admin) makes a LOCAL playlist —
not created on the Deezer account — and queues its tracks for archiving.

**One rule for "is it the same recording" and one scale for quality** (multi-provider lot C, `supysonic/matching.py`,
`supysonic/providers/quality.py`). `match_score`, `closeness`, `_core_title`, `PLAUSIBLE` moved out of
`webui/availability.py` unchanged (it and `playlist_import` re-import the same objects) and gained
`same_recording(a, b)` -> `sure|maybe|no` (equal ISRC, else core title + main artist + length within 3 s + same
version words; a cut's label such as "Radio Edit" is `maybe`, never `sure`) and `match_key` (one dict pass to group a
list; confirm a collision with `same_recording`). `quality.py` notes an offer or an archived file's header (mutagen,
nothing decoded) as `Quality(cls, effective_kbps)`: 50 hires, 40 lossless, 30 from 192 effective kbit/s, 20 from 96, 10
below; the effective rate applies the codec factor (Opus x1.5, AAC x1.3, Vorbis x1.2, MP3 x1). Pure functions,
no schema, nothing on a route's path; `tests/test_multi_c.py` pins the table.

**Unavailable means BOTH sources are gone** — not "Deezer dropped it". `DELETE /api/track/<id>` is
the third answer next to replace-and-upload, and `availability.verify_gone` re-checks *at the moment
of deletion*: a file on disk → refuse (and clear the verdict); Deezer still resolves → refuse; an
inconclusive network answer → refuse. Only `TrackUnavailable` with no file, or a local upload whose
file is gone, authorises it. Scoped like a replacement (own playlists/favourites; an admin also drops
the row, `recursive=True`); nothing is mirrored to Deezer.

**The "Indisponibles" list is built for clearing out** (`components/UnavailableList.svelte`,
`lib/replace.js`). Tick several (shift-click for a range) and `POST /api/tracks/delete` (≤ 200 ids)
deletes them in ONE job that runs `verify_gone` per track in the worker (a Deezer call each, never
in the request thread) and reports `deleted` / `kept: [{id, reason}]`: a selection is no way round
the re-check. On a desktop each row also shows up to two ONE-CLICK stand-ins,
`/replace/candidates/<id>?best=2` → `match_score`: same title once brackets and " - …" are set
aside, the same main artist, no version word the dead track did not have (remix, live, edit,
acoustic…), a length within 15 s; never YouTube. Anything less sure stays behind "Autres choix" (the
sheet, where it can be auditioned). Fetched only for rows near the viewport, two at a time. The
candidates also search the local library by TITLE (artist checked): the `"<artist> <title>"` query
is one LIKE per field and never found the copy you already had. The query drops "(Remastered…)" /
" - Radio Edit" (`_core_title`), the sheet has a search box (`q`, ≤ 200 chars), and **YouTube is
asked on its own when Deezer finds nothing** (`youtube_auto`) — "nothing" meaning nothing that LOOKS
like the song (`closeness` ≥ `PLAUSIBLE`: the artist's other songs come back for any query naming
them, and used to block it), and for a typed query nothing at all. Five songs: ranked by
`closeness` to the dead track, or in YouTube's own order for a typed query (what was typed is what
they must be close to). The inline `?best=` falls back to YouTube the same way, through
`match_score` — which tolerates a CUT's label (edit, extended, club, dub) when the length agrees to
3 s: YouTube Music calls Stromae's 3:27 album take "Alors on danse (Radio Edit)". Checked against the
real YouTube Music on five real dead-track shapes; the two it still refuses are other cuts.

**The audio auto-match** (`deezer/audiomatch.py` = the ears, `deezer/automatch.py` = which
candidates and in what order, `webui/automatch.py` = when, and applying it). A dead track has no audio
left anywhere but the 30 s preview Deezer's public API may still serve for it, so that is the ONLY
reference (the user's choice: no ISRC shortcut; no preview → left for a person). Candidates pass a
metadata gate first (same core title, same main artist, ±20 s), then: files on disk; Deezer (its
preview, then — if that did not overlap — its whole stream, decrypted straight into ffmpeg, never
archived); YouTube only when Deezer had nothing, at most 2 downloads, staged and deleted unless the
candidate wins (then `ensure_archived(produced=)` publishes that very file). ≥ `THRESHOLD` (0.99)
replaces everywhere with the admin's scope (`availability.replace_everywhere`, the same code as a
person's replacement) WITHOUT asking — so the panel always lists what it replaced, with the score.
What 0.99 means is measured on real ffmpeg (`tests/test_audiomatch.py`): the same master as FLAC,
Opus 128 or −6 dB reads 0.9991-0.9999, a remaster 0.992 (same performance: accepted), the same
arrangement re-performed with 10 ms of timing drift 0.981, the instrumental 0.74. Two things made
those numbers: aligning to the SAMPLE after the hop-grid search (0.984 → 0.9999 on the same master)
and a 40 dB floor (at 60, Opus's noise fill in near-empty bands read 0.985). No BLAS (band means by
cumulative sum): its threads would escape the worker's `renice`. Runs on the EVENT
(`library.UNAVAILABLE_HOOKS`, first verdict only — a weekly re-confirmation is not news; one worker,
bounded queue; under `app.testing` nothing starts, tests call `drain`) and on the admin's button
(`/api/automatch/run`, progress, causes tallied, stopped — not failed — when Deezer is unreachable).
Switch `Meta dz.automatch`, ON by default; nothing runs without numpy + ffmpeg.

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
  page). An artist is OFF by default (`on_fav_artist`: starring one is how you follow it), and then
  **means the whole discography**: `_archive_discography` walks Deezer's `all` tab
  (official releases + "more", not the guest appearances), fed release by release so the first album
  downloads while the rest is still being listed, and deduplicated across editions;
- *adding tracks to a playlist* or creating one (`/api/playlists`, `/api/playlist/<id>/tracks`, and
  Subsonic's `createPlaylist`/`updatePlaylist`);
- *subscribing to a show* (`/api/podcasts` POST → `backfill.archive_show`, every episode) — **only
  when that show's own switch is on**. `PodcastChannel.auto_archive` ("Archiver automatiquement les
  nouveaux épisodes", on the show's page, admin; `POST /api/podcast/<id>/auto_archive`) is the ONE
  authority over what the archive keeps of a show: `archive_show`, the sweep's `collect` and the
  Subsonic `refreshPodcasts` all read it. The `on_podcast` rule only picks its value for a NEW
  subscription, so the page never shows a switch that something else overrides. Turning it on queues
  what the show is missing (BULK, one at a time); the page then re-reads the show every 6 s while the
  count moves and stops after ~30 s without progress or when hidden. Migration 20261029 set every
  existing show ON: before it, the sweep archived every show whole, and an upgrade must not quietly stop.

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
- **Bandwidth on the device** (`lib/netyield.js`, `YieldGate.kt`). A playlist downloading on a
  phone took the link from the track the person had just pressed (four FLACs at full speed against
  one stream: measured on a shared 256 kbit/s link, the track took 30 s to start against 7 s idle).
  The playing element holds the link while it plays from the network with under 15 s in hand
  (released at 30 s, or once the file is all in; every `makeEl` element is watched, so crossfades
  and fresh elements count), and so does the preload of the NEXT track; while held, a download does
  not start, and one in progress steps aside — a resumable body (length known, `Accept-Ranges`) is
  aborted and picked up with a `Range` at the same byte, a live transcode is read at a 4 KB/s
  trickle (the receive window holds the server to it, and the connection never idles into a
  proxy's 60 s send timeout). A dropped connection resumes too (3 times). The app's own downloads
  hear it as a LEASE (`NSNative.offYield(ms)`, 45 s renewed on the element's events, which keep
  coming in a hidden page; capped at 60 s natively, so a dead page cannot stop them). Same idea as
  Media3's `PriorityTaskManager` and Chromium's `ResourceScheduler`. `node test/download/run.mjs`:
  6.1 s to start with eight downloading, 0 stalls, every download finished once paused.
- **Artwork** (`lib/coverqueue.js`): six covers in flight (three at most for covers not on screen
  yet), each freed slot going to whichever waiting cover is closest to the viewport — sideways too,
  for a shelf — with the scroll direction counted as closer. A cover more than two screens away is
  not fetched until a scroll brings it near, and a turn that has not settled in 4 s gives its slot
  back. It used to admit anything that had waited 8 s, and `Cover.svelte` asked for every card's
  1000px copy on mount, outside the queue: opening *Nouveautés* (300 cards) put 311 requests in
  flight and the covers scrolled to waited minutes on a phone's link. The hi-res copy is now asked
  only once the base art is drawn, and only where the tile is drawn larger than 500 device pixels.
  Art that costs no request (above the fold, or already on the device) never queues.

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

**Gain and lyrics no longer come from Deezer.** `Track.gain` is the measured loudness
(`analysis.apply_measured_gain`, `gain = lufs + GAIN_FROM_LUFS_OFFSET`; `/api/gain`, `/api/gains` read the
database only and take UUIDs or Deezer ids; `regain_from_analyses` re-derives it from stored analyses without
ffmpeg at the start of a backfill). Lyrics are LRCLIB only (`lyrics.ensure_lyrics`, hits more than 3 s off the
track's duration refused, synced replaces plain, `facts.lyrics_tried` in the sidecar stops repeat searches;
the route searches after answering). Shared building blocks: `library.update_track_facts` (sidecar `facts`),
`supysonic/libjob.py` (resumable library job), `supysonic/filetags.py` (facts read from file tags).

**Local play counts.** `/api/listen` writes `Track.play_count` / `last_play` (≥20 s counts, a skip
doesn't). Before that only Subsonic's `scrobble` did, so a library played entirely through the web
app looked untouched — and the cleanup decides what to drop from exactly this data.

**Recommendations, the radio, the Flow and the releases** (`supysonic/listening.py`, `supysonic/mix.py`,
`supysonic/radio.py`, `supysonic/discover.py`, `supysonic/releases.py`, `webui/discover.py`; design and sources in
`/mnt/project-files/algos/refonte-decouverte.md`). Every screen READS the database: no click asks a provider.
- **Taste is PER PERSON** (`listen_event`, schema `20261026`): every track change the player reports (and Subsonic's
  scrobble) is one row, judged by published rules — a listen is half the track or 240 s (Last.fm), a skip is under
  30 s, a track of 30 s or less is never a listen. A title's weight is ACT-R's base-level activation
  `sum((hours+1)^-0.5)` (Reiter-Haas et al. 2021); a title skipped twice and never heard is rejected. The shared
  `Track.play_count` only fills a new person's profile, faded out over their first 200 events.
- **One assembler** (`mix.assemble`): membership is a Gumbel-top-k draw proportional to the score under the artist
  cap (3 per list, LB Radio), then the ORDER is a windowed multiplicative MMR `rel*(1-(1-lam)*sim)`, lam 0.5, over
  the last 5 with a 0.75 fade (sim: `track_neighbor`, same album 0.8, same style 0.3), no artist within 3 positions.
  Membership and order are separate on purpose: an MMR choosing members pulls in an unrelated cluster for being
  different.
- **The radio is anchored** (`radio.build`, `POST /api/radio/next`): every refill scores from the ORIGINAL seed
  (weight 1) plus the session — positives at most 0.6 in all, fading 0.8 a step, skips -0.5 each (Pereira et al.
  2019) — so it never drifts track by track. Pool: the seed's neighbours, two hops through its top 8 (x0.6, never
  overriding a skip), then same artist / style. A softmax at T 0.04 on the similarity before the draw. The player
  sends what is queued, heard and skipped (`Player.svelte#nextBatch`, also the end-of-queue autoplay).
- **The Flow** keeps the distance model and the slider (`tests/test_discover.py` pins the mean distance MONOTONE in
  the level); known titles come from the top 600 by activation (heard in the last 3 h: x0.25), the genre pool is
  sampled from random keyset starts, refills post the queue and the session's skips (a skipped artist halved).
- **"Je n'aime pas"** (`supysonic/dislikes.py`, `track_dislike`, schema `20261031`, `POST /api/dislike`) is about
  RECOMMENDATIONS only (Deezer's "Ne pas recommander", Spotify's taste-profile exclusion): the title, its other rows
  (`match_key`) and the neighbours at >= 0.9 among the first 3 of EITHER list leave the radios, the Flow and the
  genre mixes; its first 20 neighbours are pushed by RANK (x0.3 for the nearest up to x1 at rank 20 — by rank
  because stored scores sit at 0.9 throughout a dense genre, measured in the test graph). A radio seeded on a
  disliked title still plays; albums, playlists and search never filter. In a generated queue the playing title is
  skipped at once. A third title of one artist offers muting it (`artist_hint`). Cached 120 s per person, one
  statement when the list is empty (the profile bound went 10 -> 11).
- **Releases** follow favourites AND each person's most-listened artists (`rel.listened`, 30 by default, Réglages
  -> Compte; the shared play-count fallback is the admin's only), plus close artists of favourites; compilations
  are dropped and a single later released on an album under the same title shows once. Writes are portable
  upserts — PostgreSQL has no REPLACE, which is what the "Nouveautés" error was. `releases.py` wakes every 15 min,
  asks only the artists due, one request a second, stopping at the first outage (never a verdict). The tables are
  keyed by the PROVIDER's ref (`artist_watch`, `artist_release`, `artist_link`, `artist_top`); catalogue
  suggestions are never downloaded to be proposed.

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

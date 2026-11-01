# Architecture: the three code layers, streaming, stream decryption

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: first orientation; touching deezerpy/, supysonic/deezer/, supysonic/webui/, /api/stream or the Blowfish decrypt.

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

<div align="center">

# NSupySonic

**A fast, modern web player for your Deezer library — backed by a self-hosted
Subsonic server.**

A clean Svelte web player at `/app` for your whole Deezer library — playlists,
favorites, Flow and new releases — built as a snappy alternative to Deezer's own
web UI. Under the hood it's a full Subsonic API server, so the same library also
plays in any Subsonic client. Tracks are fetched in **FLAC**, archived once, and
**transcoded to Opus** on demand.

[![Docker](https://github.com/fnyaker/NSupySonic/actions/workflows/docker.yaml/badge.svg)](https://github.com/fnyaker/NSupySonic/actions/workflows/docker.yaml)
[![Container](https://img.shields.io/badge/ghcr.io-nsupysonic-2496ED?logo=docker&logoColor=white)](https://github.com/fnyaker/NSupySonic/pkgs/container/nsupysonic)
![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)
![License](https://img.shields.io/badge/license-AGPL--3.0-green.svg)
![Subsonic API](https://img.shields.io/badge/Subsonic%20API-1.12.0-orange.svg)

</div>

NSupySonic (**N**yaker's **Supysonic**) is a fork of [supysonic][] wired to
Deezer. The headline is the **web player**: a custom single-page app that makes
your Deezer library feel quick and pleasant to browse — the part most people are
actually here for, since Deezer's own web client is sluggish and clumsy. Because
it's built on a full [Subsonic][] API server, that same library (and any local
files) is also available in any Subsonic app — you get a great browser
experience *and* native mobile/desktop clients, from one server.

> [!NOTE]
> For personal use with your own Deezer account. FLAC requires a Deezer
> HiFi/Premium subscription. Respect Deezer's Terms of Service.

<!--
Screenshots make this README shine — drop a couple of PNGs in docs/ and
reference them here, e.g.:

## Screenshots
![Web player](docs/screenshots/home.png)
![Flow tuner](docs/screenshots/flow.png)
-->

## Features

- **A web player that's actually fast** at `/app` — a custom Svelte single-page
  app: home cards, search, artist / album / playlist pages, a real queue, synced
  lyrics, an immersive full-screen now-playing view with a visualizer, gapless
  quality switching, and Flow. The quick, clean Deezer front-end you wish Deezer
  shipped.
- **Deezer in your Subsonic client too** — your playlists (created *and*
  favorited), favorites, *Nouveautés* / *Découverte*, and charts appear as
  native library entries. Works with any Subsonic app (Symfonium, DSub,
  play:Sub, Tempo, …).
- **Archive once, keep forever** — the first time a track is played it's fetched
  in FLAC from Deezer, decrypted, tagged and stored under `archive_dir`. Every
  later play is served straight from disk.
- **FLAC + Opus, everywhere** — tracks are *always* archived as FLAC and
  transcoded to **Opus (320 / 128 / 64)** on the fly. The web player has a
  quality menu; Subsonic clients get the original FLAC when they request
  lossless, or Opus at the bitrate they ask for.
- **Two-way sync** — Deezer → your library on a schedule; starring a track or
  creating/editing a playlist in your client is mirrored back to your Deezer
  account.
- **Fully automatic** — a full sync runs on startup and then daily (04:00 by
  default). No cron, no manual command.
- **Customizable Flow** — enable or disable genre/style clusters from the web UI
  (Deezer's GraphQL Flow tuner).
- **Hybrid library** — your existing local music sits alongside Deezer; the
  normal supysonic browsing/scanning still works.
- **Download ahead** — pre-archive a whole playlist or album in one click,
  without waiting for playback.

## How it works

Deezer entities are imported as ordinary library rows under a dedicated `Deezer`
root folder, so supysonic's normal browse / search / playlist / star endpoints
work **unchanged**. Only streaming is intercepted: on first play the FLAC is
fetched from Deezer, decrypted (Blowfish-CBC stripe cipher), archived, tagged
and served; lower qualities are produced by the transcoder and cached. Upcoming
tracks of the current album/playlist are pre-fetched in the background.

This means the same data powers your Subsonic client and the web player — there
is no separate "Deezer mode", it's just your library.

## Android app

A native Kotlin app (`android/`) wraps the web player in a fullscreen WebView
and adds what a mobile browser can't provide: a **foreground media service +
MediaSession**, so playback survives long pauses in the background and gets
real lockscreen / notification / Bluetooth controls. On first launch you enter
your server URL, an optional port, and whether to verify the SSL certificate
(untick for self-signed setups).

The APK is built by CI (`android.yaml` workflow) alongside the Docker image:
grab the `nsupysonic-apk` artifact from any run, or the APK attached to
releases on `v*` tags. See [android/README.md](android/README.md) for details
(including stable-signature setup via repo secrets).

## Quick start (Docker)

**Requirements:** Docker + Docker Compose, a Deezer account (HiFi/Premium for
FLAC), and your Deezer `arl` cookie.

```sh
git clone https://github.com/fnyaker/NSupySonic.git
cd NSupySonic
cp .env.example .env
# edit .env: set SUPYSONIC_ADMIN_PASSWORD and DEEZER_ARL
docker compose up -d
```

By default the compose file **pulls the prebuilt multi-arch (amd64 + arm64)
image** `ghcr.io/fnyaker/nsupysonic:latest` from the GitHub Container Registry —
no local build needed. A fresh image is published on every push to `master`;
update with `docker compose pull && docker compose up -d`.

Then open:

- **Web player** — <http://localhost:5722/app>
- **Subsonic API** — point your Subsonic client at <http://localhost:5722/rest>
  and log in with the admin user from your `.env`.

The admin user is created automatically on first boot from the `.env` values. A
first Deezer sync runs about 20 seconds after startup; your playlists, favorites
and new releases appear shortly after.

### Building the image locally instead

To build from source instead of pulling (e.g. to run un-released changes), edit
`docker-compose.yml` — comment out the `image:` line and uncomment `build: .` —
then:

```sh
docker compose up -d --build
```

The build also compiles the Svelte web UI (`webapp/`) and bundles it into the
image, so it needs no extra steps.

### Deploy with Portainer

In Portainer a deployment is a **Stack** (its own compose runner). The image is
public, so there's nothing to authenticate — you don't even need the repo or an
`.env` file. Just paste a stack and set the variables in the UI.

1. **Stacks → Add stack**, give it a name (e.g. `nsupysonic`), and paste this
   into the **Web editor**:

   ```yaml
   services:
     supysonic:
       image: ghcr.io/fnyaker/nsupysonic:latest
       container_name: nsupysonic
       restart: unless-stopped
       ports:
         - "5722:5722"
       environment:
         SUPYSONIC_ADMIN_USER: ${SUPYSONIC_ADMIN_USER:-admin}
         SUPYSONIC_ADMIN_PASSWORD: ${SUPYSONIC_ADMIN_PASSWORD}
         DEEZER_ARL: ${DEEZER_ARL}
         DEEZER_SYNC_USER: ${SUPYSONIC_ADMIN_USER:-admin}
         DEEZER_QUALITY: ${DEEZER_QUALITY:-FLAC}
       volumes:
         - nsupysonic-data:/data
         # Optional existing local library (hybrid with Deezer):
         # - /host/path/to/music:/data/music:ro
   volumes:
     nsupysonic-data:
   ```

2. Under **Environment variables** (still on the Add-stack page), add at least:

   | Name                       | Value                              |
   | -------------------------- | ---------------------------------- |
   | `SUPYSONIC_ADMIN_PASSWORD` | a password you choose              |
   | `DEEZER_ARL`               | your Deezer `arl` cookie (below)   |

   Optionally `SUPYSONIC_ADMIN_USER` (default `admin`) and `DEEZER_QUALITY`.

3. **Deploy the stack.** Portainer pulls the image and starts it. Open
   `http://<host>:5722/app` and log in with the admin user above. To update
   later: open the stack → **Pull and redeploy** (tick *re-pull image*).

> Persistent state (database, caches, the Deezer FLAC archive) lives in the
> named volume `nsupysonic-data` — it survives redeploys. To mount an existing
> music library, uncomment the bind line and point it at a host path.

### Getting your ARL

The ARL is the session cookie that authenticates you with Deezer:

1. Log in at <https://www.deezer.com> in your browser.
2. Open the developer tools → **Application** (or **Storage**) → **Cookies** →
   `https://www.deezer.com`.
3. Copy the value of the cookie named **`arl`** into `DEEZER_ARL` in your `.env`.

> **Treat the ARL like a password.** It grants full access to your Deezer
> account. Never commit it or share it. `.env` and `config/supysonic.conf` are
> gitignored for exactly this reason.

## Configuration

There are two ways to configure the server; pick one.

**1. Environment variables** (simplest — edit `.env`):

| Variable                   | Default    | Description                                            |
| -------------------------- | ---------- | ------------------------------------------------------ |
| `SUPYSONIC_ADMIN_USER`     | `admin`    | Admin/login user, created on first boot.               |
| `SUPYSONIC_ADMIN_PASSWORD` | `changeme` | **Change this.** Admin password.                       |
| `DEEZER_ARL`               | *(empty)*  | Your Deezer ARL cookie. Empty = run without Deezer.    |
| `DEEZER_QUALITY`           | `FLAC`     | Archive quality (`FLAC` recommended; needs HiFi).      |
| `DEEZER_SYNC_AT`           | `04:00`    | Daily auto-sync time (HH:MM).                          |

**2. A mounted config file** (full control — sync options, smart tracklists,
transcoders, Postgres, …): copy `config/supysonic.conf.example` to
`config/supysonic.conf`, edit it, and uncomment the volume line in
`docker-compose.yml`. That file is gitignored because it holds your ARL.

The full set of options (with comments) lives in
[`config.sample`](config.sample) and
[`config/supysonic.conf.example`](config/supysonic.conf.example).

## Streaming quality

The rule: **always archive FLAC, transcode to Opus.** Deezer audio is never
streamed as MP3 directly.

- **Web player** — a quality menu in the player cycles **FLAC · Opus 320 · Opus
  128 · Opus 64**. The archived FLAC is transcoded with `ffmpeg`/`libopus`
  through supysonic's transcode cache (so repeats are cached and seekable).
- **Subsonic clients** — request *lossless* to get the original FLAC, or set a
  max bitrate (e.g. 320 / 128 / 64) to receive Opus at that rate. This is the
  standard `default_transcode_target = opus` + `transcoder_flac_opus` setup,
  already configured in the image.

## Auto-sync

When a `sync_user` is set (the Docker entrypoint sets it to the admin), a full
sync runs **on startup** and then **daily** at `sync_at` (default 04:00) — or
every `sync_interval` minutes if you prefer. It refreshes your playlists,
favorites and the *Nouveautés* / *Découverte* smart-tracklist playlists. No cron
or `supysonic-cli deezer sync` needed.

## Flow customization

Open the web player, go to the home page and click **Personnaliser** on the Flow
card. You get Deezer's genre/style clusters as tiles — enable the ones you want
in your Flow, disable the rest, and save. (Uses Deezer's GraphQL Flow tuner;
requires an account where Flow customization is available.)

## Running without Docker

NSupySonic is a normal Python package.

```sh
pip install .
pip install gunicorn

# create the admin user and (optionally) a local music folder
supysonic-cli user add MyUser -p MyPassword
supysonic-cli user setroles MyUser -A

# add a [deezer] section to your config (see config.sample), then:
supysonic-cli deezer login-test            # check the ARL works
supysonic-cli deezer import <deezer-url>   # import a track / album / playlist
supysonic-cli deezer sync                  # import playlists / favorites / new releases

# build the web UI (optional; the Docker image does this for you)
cd webapp && npm install && npm run build && cd ..

supysonic-server                           # serves on :5722
```

## Development

```sh
# Python tests (no network required)
python -m unittest discover -s tests -t . -p "test_*.py"

# Web UI dev server (hot reload)
cd webapp
npm install
npm run dev
```

The Flask development server is handy for the backend:

```sh
export FLASK_APP="supysonic.web:create_application()"
export FLASK_ENV=development
flask run
```

## Project layout

```
deezerpy/             Deezer client (gateway + public API + GraphQL), based on deezer-py
supysonic/deezer/     The proxy: provider, archive, importer, prefetch, scheduler, push
supysonic/webui/      The custom /api blueprint + the bundled SPA server (/app)
webapp/               The Svelte single-page web player (built into supysonic/webui/dist)
docker/               Entrypoint + baked default config
tools/deezer_explore/ Read-only scripts used to map the Deezer API (captures are gitignored)
```

## Security & privacy

- Your **ARL** lives only in `.env` or `config/supysonic.conf`, both gitignored.
  The Docker build context excludes them too.
- All custom `/api` routes require a logged-in session; session cookies are
  `HttpOnly` + `SameSite=Lax`.
- API exploration captures (`*.har`) contain real session tokens and are
  gitignored — never commit them.
- This is meant for **personal use** with your own account.

## Credits

- [supysonic][] by Louis-Philippe Véronneau / Alban Féron — the Subsonic server
  this is built on (AGPL-3.0).
- [deezer-py][] by RemixDev — the basis for the bundled Deezer client.

## License

Distributed under the terms of the **GNU AGPL-3.0-only** license, inherited from
supysonic. See [LICENSE](LICENSE).

[subsonic]: http://www.subsonic.org/
[supysonic]: https://github.com/spl0k/supysonic
[deezer-py]: https://gitlab.com/RemixDev/deezer-py

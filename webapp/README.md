# NSupySonic — Deezer discovery web UI

A Svelte + Vite single-page app that talks to the Deezer-native JSON backend
(`/api`, see `supysonic/webui/`). It's the "own app" front end: home / Flow /
search / artist / album / playlist / library, with a persistent player and
synchronized lyrics.

## Develop

Run a supysonic server locally (it serves `/api`), then:

```sh
cd webapp
npm install
npm run dev      # http://localhost:5173, proxies /api -> http://localhost:5000
```

Log in with a supysonic user (the same credentials as the Subsonic API).

## Build

```sh
cd webapp
npm install
npm run build    # outputs to ../supysonic/webui/dist
```

The Flask server then serves it at **`/app/`** (e.g. `http://localhost:5000/app/`).
Routing is hash-based, so deep links survive a refresh with no server config.
The Docker image builds this automatically (Node stage), so you don't need Node
installed to deploy.

## Structure

- `src/lib/api.js` — wrapper over the `/api` backend (session cookie, `credentials: include`).
- `src/lib/actions.js` — higher-level actions (favorites sync, radio, play-entity, context-menu builders).
- `src/lib/stores.js` — auth + the global player store (queue/index/playing) plus
  light `currentId`/`playing` derived stores so long lists don't re-render on every
  `timeupdate`; favorites set, toasts, recently-played, context-menu state.
- `src/lib/color.js` — dominant-colour extraction for `GradientHeader`.
- `src/components/` — `Player` (single `<audio>`, Media Session, endless autoplay),
  `NowPlaying` (queue + synced lyrics), `ContextMenu`, `Toasts`, `Skeleton`,
  `Icon` (SVG icon set — **no emoji**), `Card`, `TrackRow`/`TrackList` (windowed
  rendering), `Cover`, `Sidebar`, `MobileNav`, `GradientHeader`.
- `src/routes/*` — pages, wired in `src/App.svelte` via `svelte-spa-router` (hash mode).

## Backend data sources (`supysonic/webui/__init__.py`)

The `/api` endpoints mix two Deezer backends, chosen for reliability:

- **Public API** (`api.deezer.com`, `provider.dz.api`) — **search**, **recommendations**
  (editorial releases + charts) and **artist page / artist radio**. Stable, typed,
  returns ready-to-use image URLs. The private gateway's `pageSearch`/`pageArtist`
  are legacy (the official web app moved to GraphQL), so we avoid them.
- **Private gateway** (`gw-light.php`, `provider.dz.gw`) — **album / playlist / mix
  pages**, **lyrics**, **Flow / track radio**, **favorites & playlist writes**, and
  the actual **stream tokens**. These page methods are still current. Album and
  playlist pages fetch the *full* tracklist via `getSongs`/`getListByAlbum`
  (the `page*` calls only return the first batch).

All endpoints are `@login_required` (session cookie); ids are validated before any
write/stream. Covers/streaming reuse the archive + transcode machinery.

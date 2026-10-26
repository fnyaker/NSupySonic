# Web app: screens, navigation, offline, loading

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).

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

**A show opens by its UUID or by Deezer's id** (`/api/podcast/<x>`, lot D): a catalogue card has no row, and a UUID cannot be turned back into the provider's id, so the page takes both forms; anything else is a 404 (`tests/test_multi_d.py`).

**Export to another service** (`supysonic/services/`, `supysonic/webui/services.py`, the *Service* and *Liste*
tabs of `components/ExportSheet.svelte`, Réglages → Compte → *Services de streaming*; survey in
`docs/playlist-export.md`). Spotify (the operator's own app, PKCE, `POST /me/playlists` + `/items` — the
February 2026 endpoints), YouTube Music (`ytmusicapi` signed in with a tab's pasted headers; searches go
through `deezer/youtube.search` and its holds) and, for the admin, the server's Deezer account as a one-shot
NEW playlist. Apple Music, Tidal & co. have no door without a paid developer programme: the list file (CSV
with ISRC, XSPF, text) is that route. A song is exported only when the service's copy IS the recording (its
id, the ISRC read off disk, then a search judged by `availability.match_score`); nothing is created when
nothing matched or when the service stopped answering. Credentials live in `service_link`, encrypted like
`password_clear`, never lent to a remote session. The Spotify PKCE state is kept server-side, not in the
session: Android opens the consent page in the system browser.

**Navigation, the home and the library** (design and sources: `/mnt/project-files/ui/refonte-navigation.md`).
Four destinations — Accueil, Rechercher, Bibliothèque, Réglages (Material 3 and Apple's tab-bar rules: five or fewer,
one-word labels); podcasts live IN the library. **A title on its own plays and then its radio**
(`actions.playThenRadio`, `TrackList radio`): the queue is that title alone with context `{kind: "radio", id,
artist}` and `Player.svelte#ensureUpcoming` tops it up from `/api/radio/next` at once — no request before the sound;
`artist` lets the server radio on the artist while a catalogue title's row does not exist yet. Inside a collection
(album, playlist, favourites, the Nouveautés page) a tap plays the collection from there. The home is: the Flow (the
discovery level behind one chip), **Nouveautés as TITLES** (one per release, `/api/releases` `tracks`, read from
`artist_release.tracks`, which the releases watcher fills when it finds a release — `releases._fill_tracklists`,
`TRACKLISTS_PER_RUN` a run, an outage leaves it for the next run, Deezer answering "gone" keeps `[]`), the favourite
artists (`/me/artists`: stars + library count + the person's listens, three statements), Pour toi (titles), recently
played shortcuts, mixes. The library is one page of chips (`/library/<chip>`: Titres, Artistes, Albums, Playlists,
Podcasts, Téléchargés, Mes fichiers, Indisponibles), its adding actions one "+" menu. A track row is played by its
title too (the whole row is the target), and without a number the play glyph sits on the cover. Starring an artist
FOLLOWS it; archiving its discography (`on_fav_artist`) is off by default.

**Search leads with the titles** (`routes/Search.svelte`, `lib/searchrank.js`, `components/TopResult.svelte`).
Tabs Tout · Titres · Artistes · Albums · Playlists; there is no Podcasts tab (the user's ask): the shows are mixed
into the albums after the first two, each card saying "Podcast". "Tout" opens on a **best result** only when the query
plainly names it — an artist (or, for the admin, a show) named exactly among the first three, or the first artist
whose name the query starts (three letters at least) — beside the ten titles on a wide screen, above them on a
phone; a title search gets no artist on top. Then the artists, the albums with the shows, the playlists. A title
tapped here plays and then its radio (`TrackList radio`). With Deezer out (or nobody's account serving the search)
the library answers alone: titles, and the artists and albums by NAME that hold a title on disk
(`webui._local_search_entities`, two statements). Each section carries a "Tout afficher" that switches to its tab.

**Réglages is two levels** (`routes/Settings.svelte`): a list of categories (Lecture, Animations, Téléchargements,
Découverte, Sources, Compte, Serveur for an admin, Assistance), each a page — the iOS/Android settings pattern. ONE route
`/settings/:section?`, so switching category updates `params` instead of remounting the page and refetching every card. A
phone shows the list OR a category (back returns to the list, `replace` on a deep link); ≥ 900 px shows a column beside the
open category. A link into a setting names its category (`/settings/sources`, `/settings/account`); old `fx`/`quality`
names are mapped. Benches open the category they test (`#/settings/playback`, `#/settings/downloads`), never bare `#/settings`.

**Long grids grow as they scroll** (`lib/grow.js`: `STEP`, `use:nearEnd` on a sentinel after the last tile;
Library's Artistes, Albums, Playlists). 300 followed artists mounted at once cost 1.2 s of main thread on the
4x-throttled desktop (0.9 s phone) before the chip answered; mounting 36 then the next 36 as the end comes
within 800 px: 0.18 s / 0.11 s (`test/clicks/run.mjs`, *biblio: Artistes*; Albums 0.63 s → 0.06 s). The
observer's ROOT must be the scrolling `<main>`: against the viewport the margin is clipped by `<main>` and the
grid never grows. An observer only reports changes, so after each step it is re-observed (a tall screen
that still shows the sentinel asks for the next step).

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

**The queue is edited in ONE component** (`components/QueueList.svelte`, shared by the desktop side
panel, the full-screen player and the phone's sheet): tap to play, remove, **drag the grip to reorder**,
*Vider la file*. Only what is AFTER the playing track can be moved or removed. The list is windowed, so a
drag never depends on a row being mounted: the target comes from geometry (`VirtualList.indexAt`), the
picture under the finger is a separate floating copy, the pointer is followed on the WINDOW (the row may
leave the DOM while the list scrolls under the finger toward the end of a 4 000-track queue — `autoScroll`,
whose edge zone is capped at a quarter of the list), and `touch-action: none` on the grip alone is what
leaves the rest of the row to the scroller. `player.move(from, to)` carries the playing track's index along
and does NOT bump `seq` (a bump is a deliberate navigation: the audio owner would restart the track); under
shuffle it leaves `_orig` alone. `player.clearUpcoming()` also switches `autoplay` off — a radio refilling the
queue five seconds after it was cleared is the opposite of the request — and a new queue (`playQueue`,
`shufflePlay`) switches it back on. Both are remote commands (`move`, `clear`, read level, validated server-side).

**Sleep timer** (`lib/sleep.js`, `components/SleepButton.svelte`): minutes, or the end of the track. The deadline
is a wall-clock comparison, never ticks counted (a phone on a bedside table is throttled or frozen and must still
end where the clock says). The last 15 s fade through `sleepFade`, a multiplier the audio owner applies ON TOP of
the volume, so the user's own level is never touched and never has to be put back. "End of the track" holds the
crossfade and the silence trim back (`sleepStopsAtTrackEnd`, also in `partyPlan` and `beginCrossfade`) so the file
finishes, then `player.advancePaused()` lines the next track up paused. It fires a PAUSE, not a stop. Not offered
on a remote control: the timer runs where the audio is.

**Podcast speed** (`lib/speed.js`, `components/SpeedButton.svelte`, store `podcast.speeds`, mirrored to remote
controls): per show, applied to BOTH audio elements and as `defaultPlaybackRate` too (`load()` resets the rate to
it on every source), `preservesPitch` on. Music is never touched. Forced to 1 while a listen party is hosted: its
guests schedule the audio in real time, a faster host would leave them further behind every second.

**Explore** (`/api/explore`, `/explore/genre/<id>`, `/explore/countries`, `routes/Explore.svelte`): Deezer's public
API only — the world and per-genre charts, editorial releases, the per-country chart playlists. A screen is several
calls, run side by side; the answer is kept ten minutes but ONLY WHEN COMPLETE (`_explore_cached`): a call that
failed is a hole in the answer, not something to remember. The account owner's (admin) screen, like the home.

**Under the full-screen player** (`components/NowPlayingMore.svelte`), top to bottom: the track's **credits**, the
artist (photo, fans, top titles, similar artists; the public API has no biography, so the card does not pretend to)
and — LAST, because it is the long one — tracks that sound like the playing one (the radio's mix: one call to swap
for our own embeddings later). On the phone a swipe UP is the mirror of the swipe down that dismisses
(`MobileNowPlaying`: `revealMove` / `revealEnd` beside `dismissMove` / `dismissEnd`, from the sheet or forwarded
from the cover; the panel follows the finger and settles open or shut; a swipe down drags it back down from anywhere
on it — the header always, the body once it is scrolled to the top and the finger's first move is down, so a
scroll or a sideways shelf keeps its gesture; a cancelled gesture decides nothing). On the desktop it is the *À propos* tab. Following any link from in there leaves the
player (a `hashchange` listener). Its requests are keyed on the track's id as a STRING: `track` is the store's
object, handed over again on every progress tick, and a reactive statement reading it asked for the credits four
times a second (the browser test counts requests).

**Full credits** (`supysonic/trackcredits.py`, `supysonic/webui/credits.py`, `GET /api/track/<id>/credits`): the
performers are `TrackArtist` rows; everybody else on the sleeve (author, composer, producer, publisher…) is a
`track_credit` row (schema `20261030`): one per person, role and SOURCE — `deezer` (the gateway's
`SNG_CONTRIBUTORS`, stored when a track is archived), `tags` (an upload's composer/lyricist/producer, stored at
import), `musicbrainz` (stored by the enrich queue). Each source is replaced on its own; `merge` keeps Deezer's and the
tags' roles whole and lets MusicBrainz only FILL a role neither named (its lyricist is skipped when Deezer named an
author). The panel reads the database, completes it from the files (sidecar `gw`/`facts`, the upload's tags) and
stores what only the files said; only a track NOT on disk is worth a question to Deezer (kept a day in memory, and
stored when the track is a library row, so it answers with Deezer away). Before this, an archive made before the
sidecar kept `SNG_CONTRIBUTORS` named its main artist and nobody else, forever — what the person reported. The
library already on a server is completed ONCE by `trackcredits.BackfillJob` (`libjob` with a `page_done` hook, run 45 s
after a start until it finishes with Deezer answering; Réglages → Archive → "Crédits des titres" shows it): the disk
first, then Deezer **50 tracks per `song.getListData` call** (falls back to one `song.getData` a track if the list
call ever comes back without credits), each call behind `quiet_wait`, the answer written into the sidecar too; an
outage fails those tracks with "Deezer injoignable (…)" and writes nothing. A name links to the library's artist of
that name (catalogue artists only) or, once credited on 2+ tracks, to `#/credits/<name>` (`routes/Credits.svelte`,
`GET /api/credits/person?name=`: indexed on the folded `name_key`, performer roles left out, `_visible_tracks`); an
artist page grows a "Crédits" tab when `credited` > 0. Every track menu has "Voir les crédits"
(`CreditsSheet.svelte`, same request, kept offline like the panel's). Measured on 8 000 tracks: the panel 8 ms / 6
statements, a 400-title credits page 31 ms / 4 statements. Known roles come in a sleeve's order and French labels
(`ROLES`), an invented role under its own name after them, everything bounded (40 names a role, 160 characters).

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
55 kB chunk and the largest world 25 kB (the microwave, 9 kB gzipped — fetched only when it is on screen).
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
  That source is an OBJECT URL, so the CSP's `img-src` must carry `blob:` (`web.py`,
  `tests/test_security.py`): without it the browser refuses every cached cover, the refusal reads
  exactly like a corrupt file, and the cache "repaired" it by deleting the bytes — which is how a
  phone lost the art of every download. So a CSP refusal is logged as one (`log.js`,
  `securitypolicyviolation`), and a cached cover is only ever dropped once `createImageBitmap` —
  which no CSP governs — confirms the bytes do not decode (`imagebytes.js#blobDecodes`); covers
  the old behaviour deleted are re-fetched in the background (`offline.js#repairMissingCovers`).

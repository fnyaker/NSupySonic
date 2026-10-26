<script>
  import { trackKey } from "../lib/trackkey.js";
  import { onDestroy, onMount } from "svelte";
  import { push, replace } from "svelte-spa-router";
  import { REMOTE, CAN_KEEP, CAN_ADMIN, CAN_BROWSE } from "../lib/remote/mode.js";
  import {
    player,
    favTracks,
    toasts,
    isAdmin,
    syncing,
    downloads,
    openExport,
    resolvedUnavailable,
    unavailableVersion,
    playlists,
    openMenu,
  } from "../lib/stores.js";
  import { userPlaylists, loadMyFavorites, runDeezerSync, upsertPlaylistLocal } from "../lib/actions.js";
  import { listDownloads } from "../lib/offline.js";
  import { api } from "../lib/api.js";
  import { rememberScreen, recallScreen } from "../lib/nav.js";
  import { bytes as fmtBytes } from "../lib/format.js";
  import Card from "../components/Card.svelte";
  import TrackBrowser from "../components/TrackBrowser.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";
  import UnavailableList from "../components/UnavailableList.svelte";
  import ArtistTile from "../components/ArtistTile.svelte";
  import Podcasts from "./Podcasts.svelte";
  import { STEP, nearEnd } from "../lib/grow.js";

  // One library, filtered by chips (Spotify's "Your Library", 2021): what you
  // keep is in one place whatever it is — titles, artists, albums, playlists,
  // podcasts, downloads, your own files. The chip is in the URL
  // (#/library/artists) so the home's "Tout afficher" lands on it and Back
  // returns to it.
  export let params = {};
  const CHIPS = [
    { id: "favorites", label: "Titres" },
    { id: "artists", label: "Artistes" },
    { id: "albums", label: "Albums" },
    { id: "playlists", label: "Playlists", admin: true },
    { id: "podcasts", label: "Podcasts" },
    { id: "downloaded", label: "Téléchargés", local: true },
    { id: "local", label: "Mes fichiers" },
    { id: "gone", label: "Indisponibles" },
  ];
  $: chips = CHIPS.filter((c) => (!c.admin || $isAdmin) && (!c.local || !REMOTE));
  const saved = recallScreen();
  let tab = (CHIPS.some((c) => c.id === params.tab) && params.tab) || saved?.tab || "favorites";
  function choose(id) {
    tab = id;
    replace("/library/" + id);
  }
  // Upload usage/cap for the current user (guests get a per-user quota; admins
  // are unlimited). Null until loaded.
  let usage = null;
  $: usagePct = usage && usage.quota ? Math.min(100, (usage.used / usage.quota) * 100) : 0;
  async function loadUsage() {
    try {
      usage = await api.uploadUsage();
    } catch {
      usage = null;
    }
  }
  // favTracks is a shared cache: instant on revisit, refreshed in background.
  $: favorites = $favTracks;
  // Straight off the shared store: a playlist created from the "add to
  // playlist" sheet (which opens OVER this screen, so nothing here remounts)
  // shows up in this tab the moment it exists.
  $: myPlaylists = $playlists;
  let plQuery = saved?.plQuery ?? "";
  $: rememberScreen({ tab, plQuery, arQuery, arSort });
  $: shownPlaylists = filterPlaylists(myPlaylists, plQuery);
  function filterPlaylists(list, term) {
    if (!list) return null;
    const t = term.trim().toLowerCase();
    if (!t) return list;
    return list.filter((p) => (p.title || "").toLowerCase().includes(t));
  }
  // -- artists and albums you starred -----------------------------------------
  let artists = null;
  let albums = null;
  let arQuery = saved?.arQuery ?? "";
  let arSort = saved?.arSort ?? "plays"; // plays | name | recent
  const AR_SORTS = [
    { id: "plays", label: "Les plus écoutés" },
    { id: "name", label: "A-Z" },
    { id: "recent", label: "Ajoutés récemment" },
  ];
  $: if (tab === "artists" && artists === null) loadArtists();
  $: if (tab === "albums" && albums === null) loadAlbums();
  async function loadArtists() {
    artists = [];
    try {
      await api.swr("/me/artists", (d) => (artists = d.artists || []));
    } catch {
      /* the list stays empty and says so */
    }
  }
  async function loadAlbums() {
    albums = [];
    try {
      await api.swr("/me/albums", (d) => (albums = d.albums || []));
    } catch {
      /* the list stays empty and says so */
    }
  }
  const fold = (x) => (x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  $: shownArtists = (() => {
    if (!artists) return [];
    const t = fold(arQuery.trim());
    const list = t ? artists.filter((a) => fold(a.name).includes(t)) : artists.slice();
    if (arSort === "name") list.sort((a, b) => fold(a.name).localeCompare(fold(b.name), "fr"));
    else if (arSort === "recent") list.sort((a, b) => (b.starred || "").localeCompare(a.starred || ""));
    return list; // "plays" is the server's own order
  })();
  // The grids mount one screenful at a time (lib/grow.js); a new filter or
  // query starts again from the top.
  let arLimit = STEP;
  let alLimit = STEP;
  let plLimit = STEP;
  let arKey, alKey, plKey;
  $: if (arKey !== (arKey = `${tab}\0${arQuery}\0${arSort}`)) arLimit = STEP;
  $: if (alKey !== (alKey = tab)) alLimit = STEP;
  $: if (plKey !== (plKey = `${tab}\0${plQuery}`)) plLimit = STEP;
  const titles = (n) => (n ? `${n} titre${n > 1 ? "s" : ""}` : "Aucun titre gardé");

  let local = null;
  let offline = null;
  // Tracks the server knows can no longer be played. Loaded when the tab is
  // first opened (and refreshed when a replacement lands), not on every page
  // view — it's a rare list, and a query nobody asked for is a query wasted.
  let gone = null;
  let goneLoaded = false;
  $: if (tab === "gone" && !goneLoaded) loadGone();
  async function loadGone() {
    goneLoaded = true;
    try {
      gone = (await api.unavailableTracks()).tracks || [];
    } catch {
      gone = [];
    }
  }
  // Dealing with a track (replaced, deleted, playable again) drops it from the
  // list at once — the server work runs in a worker thread, so refetching here
  // would just re-read the old state and the row would flicker back.
  $: if ($resolvedUnavailable && gone) {
    gone = gone.filter((t) => trackKey(t) !== $resolvedUnavailable);
  }
  // …then the truth, once the server says it's done.
  let seenVersion = 0;
  $: if ($unavailableVersion !== seenVersion) {
    seenVersion = $unavailableVersion;
    if (goneLoaded) loadGone();
  }

  let fileInput;
  let uploading = false;

  onMount(() => {
    loadMyFavorites();
    if ($isAdmin) userPlaylists();
    loadLocal();
    loadUsage();
  });

  // Downloaded tracks come straight from IndexedDB, so this tab works offline.
  // Refreshed whenever the downloaded set changes (add / remove / evict), but
  // COALESCED: downloading a 50-track album flips that store once per track,
  // and every flip used to re-read the entire IndexedDB meta store. The
  // sequence guard stops a slower earlier read from landing on a newer one.
  let offlineSeq = 0;
  let offlineTimer = null;
  $: $downloads, scheduleOffline();
  function scheduleOffline() {
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(loadOffline, 200);
  }
  async function loadOffline() {
    const mine = ++offlineSeq;
    const list = (await listDownloads()).map((m) => m.track).filter(Boolean);
    if (mine === offlineSeq) offline = list;
  }
  onDestroy(() => clearTimeout(offlineTimer));

  function playOffline() {
    if (offline?.length) player.playQueue(offline, 0, { kind: "downloads" });
  }

  async function loadLocal() {
    try {
      local = (await api.myLocal()).tracks || [];
    } catch {
      local = [];
    }
  }

  async function onFiles(e) {
    const files = [...(e.target.files || [])];
    e.target.value = ""; // allow re-selecting the same files later
    if (!files.length) return;
    uploading = true;
    try {
      const r = await api.upload(files);
      if (r.count) toasts.push(`${r.count} fichier(s) importé(s)`);
      if (r.quota_exceeded)
        toasts.push("Quota d'upload atteint : certains fichiers ont été refusés.", "error");
      else if (r.skipped && r.skipped.length)
        toasts.push(`${r.skipped.length} ignoré(s) (format non géré)`, "error");
      await loadLocal();
      await loadUsage();
      choose("local");
    } catch (e) {
      toasts.push(e?.status === 413 ? e.message : "Échec de l'import", "error");
    } finally {
      uploading = false;
    }
  }

  function playFavorites() {
    if (favorites?.length) player.playQueue(favorites, 0, { kind: "favorites" });
  }
  function playLocal() {
    if (local?.length) player.playQueue(local, 0, { kind: "local" });
  }

  // Manual "refresh from Deezer" (shared action), then refresh the playlists.
  async function syncDeezer() {
    if (await runDeezerSync()) userPlaylists(true);
  }

  async function newPlaylist() {
    const title = (window.prompt("Nom de la playlist ?") || "").trim();
    if (!title) return;
    try {
      const r = await api.createPlaylist(title, []);
      if (r?.id) upsertPlaylistLocal({ id: String(r.id), title, deezer_id: r.deezer_id });
      userPlaylists(true);
      if (r?.id) push("/playlist/" + r.id);
    } catch {
      toasts.push("Impossible de créer la playlist", "error");
    }
  }

  // The adding actions are ONE button opening a menu (a toolbar holds
  // actions, the platforms' rule): three pills of labels crowded the title on
  // a phone and read as navigation.
  function addMenu(e) {
    const items = [];
    if (CAN_KEEP && $isAdmin) items.push({ label: "Nouvelle playlist", icon: "plus", action: newPlaylist });
    if (CAN_BROWSE)
      items.push({ label: "Importer une playlist partagée", icon: "link", action: () => push("/import") });
    if (CAN_KEEP) items.push({ label: "Importer des fichiers audio", icon: "upload", action: () => fileInput.click() });
    if ($isAdmin && CAN_ADMIN)
      items.push({ label: "Synchroniser depuis Deezer", icon: "refresh", action: syncDeezer });
    const r = e.currentTarget.getBoundingClientRect();
    openMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.right, clientY: r.bottom + 4 }, items);
  }
</script>

<div class="head">
  <h1>Bibliothèque</h1>
  {#if CAN_KEEP || CAN_BROWSE}
    <button class="add" on:click={addMenu} disabled={uploading || $syncing} aria-label="Ajouter à la bibliothèque" title="Ajouter">
      {#if uploading || $syncing}<span class="spin"><Icon name="refresh" size={20} /></span>{:else}<Icon name="plus" size={22} />{/if}
    </button>
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    accept="audio/*,.flac,.opus,.m4a,.ogg,.wav,.aac,.wma"
    multiple
    on:change={onFiles}
    hidden
  />
</div>

{#if usage && !usage.unlimited && usage.quota}
  <div class="quota">
    <div class="quota-bar"><span style={`width:${usagePct}%`} class:warn={usagePct > 90}></span></div>
    <span class="muted quota-txt">{fmtBytes(usage.used)} / {fmtBytes(usage.quota)} d'espace d'upload utilisé</span>
  </div>
{/if}

<div class="tabs bleed-x" role="tablist" aria-label="Filtrer la bibliothèque">
  {#each chips as c (c.id)}
    <button role="tab" aria-selected={tab === c.id} class:active={tab === c.id} on:click={() => choose(c.id)}>
      {c.label}{#if c.id === "gone" && gone?.length}<span class="badge">{gone.length}</span>{/if}
    </button>
  {/each}
</div>

{#if tab === "favorites"}
  {#if favorites === null}
    <Skeleton kind="list" />
  {:else if !favorites.length}
    <p class="muted hint">Aucun titre favori. Touche le cœur d'un titre pour le garder ici.</p>
  {:else}
    <div class="row fav-head">
      <button class="pill" on:click={playFavorites}><Icon name="play" size={18} /> Tout lire</button>
      <button class="ghost-btn" on:click={() => openExport("favorites", "me", "Favoris")} title="Exporter : vers un service, en ZIP ou en liste">
        <Icon name="archive" size={17} /> Exporter
      </button>
      <span class="muted">{favorites.length} titres</span>
    </div>
    <TrackBrowser tracks={favorites} context={{ kind: "favorites" }} />
  {/if}
{:else if tab === "artists"}
  {#if artists === null || (!artists.length && !arQuery)}
    {#if artists === null}<Skeleton kind="shelf" />{:else}
      <p class="muted hint">Aucun artiste favori. Ouvre la page d'un artiste et touche le cœur pour le suivre : ses nouveautés arriveront sur l'accueil.</p>
    {/if}
  {:else}
    <div class="row tools">
      <div class="pl-search">
        <Icon name="search" size={16} />
        <input placeholder="Rechercher un artiste…" bind:value={arQuery} />
      </div>
      <label class="sort">
        <span class="muted">Trier</span>
        <select bind:value={arSort} aria-label="Trier les artistes">
          {#each AR_SORTS as o}<option value={o.id}>{o.label}</option>{/each}
        </select>
      </label>
      <span class="muted count">{artists.length} artiste{artists.length > 1 ? "s" : ""}</span>
    </div>
    {#if !shownArtists.length}
      <p class="muted hint">Aucun artiste ne correspond à « {arQuery} ».</p>
    {:else}
      <div class="artist-grid">
        {#each shownArtists.slice(0, arLimit) as a (a.id)}<ArtistTile artist={a} detail={titles(a.tracks)} />{/each}
      </div>
      {#if shownArtists.length > arLimit}<div class="grow" use:nearEnd={() => (arLimit += STEP)}></div>{/if}
    {/if}
  {/if}
{:else if tab === "albums"}
  {#if albums === null}
    <Skeleton kind="shelf" />
  {:else if !albums.length}
    <p class="muted hint">Aucun album favori. Touche le cœur sur la page d'un album pour le garder ici.</p>
  {:else}
    <div class="grid">
      {#each albums.slice(0, alLimit) as a (a.id)}<Card item={a} kind="album" />{/each}
    </div>
    {#if albums.length > alLimit}<div class="grow" use:nearEnd={() => (alLimit += STEP)}></div>{/if}
  {/if}
{:else if tab === "podcasts"}
  <Podcasts embedded />
{:else if tab === "playlists"}
  {#if myPlaylists === null}
    <Skeleton kind="shelf" />
  {:else if !myPlaylists.length}
    <p class="muted hint">Aucune playlist.</p>
  {:else}
    <div class="pl-search">
      <Icon name="search" size={16} />
      <input placeholder="Rechercher dans mes playlists…" bind:value={plQuery} />
    </div>
    {#if !shownPlaylists.length}
      <p class="muted hint">Aucune playlist ne correspond à « {plQuery} ».</p>
    {:else}
      <div class="grid">
        {#each shownPlaylists.slice(0, plLimit) as p (p.id)}<Card item={p} kind="playlist" />{/each}
      </div>
      {#if shownPlaylists.length > plLimit}<div class="grow" use:nearEnd={() => (plLimit += STEP)}></div>{/if}
    {/if}
  {/if}
{:else if tab === "downloaded"}
  {#if offline === null}
    <Skeleton kind="list" />
  {:else if !offline.length}
    <p class="muted hint">Aucun titre téléchargé. Utilisez le bouton de téléchargement sur un titre, un album ou une playlist pour les écouter hors-ligne (mode avion).</p>
  {:else}
    <div class="row fav-head">
      <button class="pill" on:click={playOffline}><Icon name="play" size={18} /> Tout lire</button>
      <span class="muted">{offline.length} titres · hors-ligne</span>
    </div>
    <TrackBrowser tracks={offline} context={{ kind: "downloads" }} downloadable={false} />
  {/if}
{:else if tab === "gone"}
  {#if gone === null}
    <Skeleton kind="list" />
  {:else if !gone.length}
    <p class="muted hint">
      Aucun titre indisponible. Quand Deezer retire un titre de son catalogue, il
      apparaît ici pour que vous puissiez lui trouver un remplaçant. Les titres
      que vous avez déjà écoutés sont archivés sur le serveur&nbsp;: ceux-là
      restent lisibles quoi qu'il arrive.
    </p>
  {:else}
    <p class="muted hint gone-hint">
      Ces titres ne peuvent plus être lus. Choisissez un remplaçant&nbsp;: il
      prendra leur place dans toutes vos playlists et vos favoris. Ou cochez
      ceux dont vous ne voulez plus et supprimez-les d'un coup.
    </p>
    <UnavailableList bind:tracks={gone} />
  {/if}
{:else if tab === "local"}
  {#if local === null}
    <Skeleton kind="list" />
  {:else if !local.length}
    <p class="muted hint">Aucun fichier à toi pour l'instant. Touche + en haut, puis « Importer des fichiers audio », pour ajouter ta propre musique (n'importe quel format).</p>
  {:else}
    <div class="row fav-head">
      <button class="pill" on:click={playLocal}><Icon name="play" size={18} /> Tout lire</button>
      <span class="muted">{local.length} fichiers</span>
    </div>
    <TrackBrowser tracks={local} context={{ kind: "local" }} downloadable={false} />
  {/if}
{/if}

<style>
  .grow {
    height: 1px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .quota {
    margin-top: 12px;
  }
  .quota-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .quota-bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.25s ease;
  }
  .quota-bar span.warn {
    background: var(--accent-2);
  }
  .quota-txt {
    display: inline-block;
    margin-top: 5px;
    font-size: 0.8rem;
  }
  /* The tabs scroll on their own rather than wrapping onto a second line: on a
     phone five pills don't fit, and a wrapped row pushes the content down and
     makes the page jump every time the set changes. `flex: none` on the buttons
     is what stops flex from squeezing them into unreadable slivers instead of
     overflowing, and the negative margin lets them run edge to edge while the
     page keeps its padding. */
  .tabs {
    display: flex;
    gap: 8px;
    margin-block: 16px 20px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
    padding-block: 2px;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs button {
    flex: none;
    scroll-snap-align: start;
    white-space: nowrap;
    padding: 8px 16px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text-dim);
    font-weight: 600;
  }
  .tabs button.active {
    background: #fff;
    color: #111;
  }
  .fav-head {
    margin-bottom: 14px;
    gap: 12px 16px;
    flex-wrap: wrap;
  }
  .fav-head > * {
    white-space: nowrap;
  }
  /* -- unavailable tracks ---------------------------------------------- */
  .badge {
    display: inline-block;
    margin-left: 7px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--accent-2);
    color: #fff;
    font-size: 0.72rem;
    font-weight: 800;
    vertical-align: 1px;
  }
  .gone-hint {
    margin-bottom: 14px;
  }
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 15px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .ghost-btn:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .pl-search {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-card);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 10px 14px;
    margin-bottom: 16px;
    max-width: 380px;
    color: var(--text-dim);
  }
  .pl-search:focus-within {
    border-color: var(--accent);
    color: var(--text);
  }
  .pl-search input {
    border: none;
    background: none;
    outline: none;
    color: var(--text);
    width: 100%;
  }
  .hint {
    margin-top: 24px;
  }
  .head h1 {
    margin: 0;
  }
  .add {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    color: var(--text);
    background: var(--bg-card);
    flex: none;
  }
  .add:hover {
    background: var(--bg-hover);
  }
  .add .spin {
    display: grid;
    animation: spin 1s linear infinite;
  }
  .tools {
    gap: 10px 14px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .tools .pl-search {
    margin-bottom: 0;
    flex: 1 1 220px;
  }
  .sort {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.88rem;
  }
  .sort select {
    min-height: 40px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    background: var(--bg-card);
    color: var(--text);
    font: inherit;
  }
  .count {
    font-size: 0.88rem;
  }
  .artist-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 6px;
  }
  @media (max-width: 640px) {
    .artist-grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 2px;
    }
  }
</style>

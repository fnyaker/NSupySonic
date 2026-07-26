<script>
  import { onDestroy, onMount } from "svelte";
  import { player, favTracks, toasts, isAdmin, syncing, downloads } from "../lib/stores.js";
  import { userPlaylists, loadMyFavorites, runDeezerSync } from "../lib/actions.js";
  import { listDownloads } from "../lib/offline.js";
  import { api } from "../lib/api.js";
  import { bytes as fmtBytes } from "../lib/format.js";
  import Card from "../components/Card.svelte";
  import TrackBrowser from "../components/TrackBrowser.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  let tab = "favorites";
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
  let playlists = null;
  let plQuery = "";
  $: shownPlaylists = filterPlaylists(playlists, plQuery);
  function filterPlaylists(list, term) {
    if (!list) return null;
    const t = term.trim().toLowerCase();
    if (!t) return list;
    return list.filter((p) => (p.title || "").toLowerCase().includes(t));
  }
  let local = null;
  let offline = null;

  let fileInput;
  let uploading = false;

  onMount(() => {
    loadMyFavorites();
    if ($isAdmin) userPlaylists().then((p) => (playlists = p));
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
      tab = "local";
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

  // Manual "refresh from Deezer" (shared action), then refresh this page's list.
  async function syncDeezer() {
    if (await runDeezerSync()) playlists = await userPlaylists(true);
  }
</script>

<div class="head">
  <h1>Ma bibliothèque</h1>
  <div class="head-actions">
    {#if $isAdmin}
      <button class="upload" class:spin={$syncing} on:click={syncDeezer} disabled={$syncing} title="Synchroniser depuis Deezer">
        <Icon name="refresh" size={17} /> {$syncing ? "Sync…" : "Synchroniser Deezer"}
      </button>
    {/if}
    <button class="upload" on:click={() => fileInput.click()} disabled={uploading}>
      <Icon name="upload" size={17} /> {uploading ? "Import…" : "Importer des fichiers"}
    </button>
  </div>
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

<div class="tabs">
  <button class:active={tab === "favorites"} on:click={() => (tab = "favorites")}>Titres favoris</button>
  {#if $isAdmin}
    <button class:active={tab === "playlists"} on:click={() => (tab = "playlists")}>Mes playlists</button>
  {/if}
  <button class:active={tab === "downloaded"} on:click={() => (tab = "downloaded")}>Téléchargés</button>
  <button class:active={tab === "local"} on:click={() => (tab = "local")}>Mes fichiers</button>
</div>

{#if tab === "favorites"}
  {#if favorites === null}
    <Skeleton kind="list" />
  {:else if !favorites.length}
    <p class="muted hint">Aucun titre favori. Survolez un titre et cliquez sur le cœur pour l'ajouter.</p>
  {:else}
    <div class="row fav-head">
      <button class="pill" on:click={playFavorites}><Icon name="play" size={18} /> Tout lire</button>
      <span class="muted">{favorites.length} titres</span>
    </div>
    <TrackBrowser tracks={favorites} context={{ kind: "favorites" }} />
  {/if}
{:else if tab === "playlists"}
  {#if playlists === null}
    <Skeleton kind="shelf" />
  {:else if !playlists.length}
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
        {#each shownPlaylists as p (p.id)}<Card item={p} kind="playlist" />{/each}
      </div>
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
{:else if tab === "local"}
  {#if local === null}
    <Skeleton kind="list" />
  {:else if !local.length}
    <p class="muted hint">Aucun fichier local. Cliquez sur « Importer des fichiers » pour ajouter votre propre musique (n'importe quel format).</p>
  {:else}
    <div class="row fav-head">
      <button class="pill" on:click={playLocal}><Icon name="play" size={18} /> Tout lire</button>
      <span class="muted">{local.length} fichiers</span>
    </div>
    <TrackBrowser tracks={local} context={{ kind: "local" }} downloadable={false} />
  {/if}
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .upload {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 9px 15px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .upload.spin :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .upload:hover {
    background: var(--bg-hover);
  }
  .upload:disabled {
    opacity: 0.6;
    cursor: default;
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
  .tabs {
    display: flex;
    gap: 8px;
    margin: 16px 0 20px;
  }
  .tabs button {
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
    gap: 16px;
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
</style>

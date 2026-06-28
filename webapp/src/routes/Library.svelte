<script>
  import { onMount } from "svelte";
  import { player, favTracks, toasts, isAdmin, syncing } from "../lib/stores.js";
  import { userPlaylists, loadMyFavorites, runDeezerSync } from "../lib/actions.js";
  import { api } from "../lib/api.js";
  import Card from "../components/Card.svelte";
  import TrackBrowser from "../components/TrackBrowser.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  let tab = "favorites";
  // favTracks is a shared cache: instant on revisit, refreshed in background.
  $: favorites = $favTracks;
  let playlists = null;
  let local = null;

  let fileInput;
  let uploading = false;

  onMount(() => {
    loadMyFavorites();
    if ($isAdmin) userPlaylists().then((p) => (playlists = p));
    loadLocal();
  });

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
      toasts.push(`${r.count} fichier(s) importé(s)`);
      if (r.skipped && r.skipped.length)
        toasts.push(`${r.skipped.length} ignoré(s) (format non géré)`, "error");
      await loadLocal();
      tab = "local";
    } catch {
      toasts.push("Échec de l'import", "error");
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

<div class="tabs">
  <button class:active={tab === "favorites"} on:click={() => (tab = "favorites")}>Titres favoris</button>
  {#if $isAdmin}
    <button class:active={tab === "playlists"} on:click={() => (tab = "playlists")}>Mes playlists</button>
  {/if}
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
    <div class="grid">
      {#each playlists as p (p.id)}<Card item={p} kind="playlist" />{/each}
    </div>
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
  .hint {
    margin-top: 24px;
  }
</style>

<script>
  import TrackList from "./TrackList.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import { onDestroy } from "svelte";
  import { SORTS, createProjector } from "../lib/tracklist.js";

  export let tracks = [];
  export let context = null;
  export let numbered = true;
  export let showAlbum = true;
  export let showCover = true;
  export let downloadable = true;

  let query = "";
  let sort = "default";
  let dir = 1; // 1 = ascending, -1 = descending
  let dlBusy = false;

  // Search and sort run on the app core's index (lib/tracklist.js): built
  // once per list, so a keystroke on 4 000 favourites is one pass over folded
  // bytes, and "beyonce" finds "Beyoncé".
  const project = createProjector();
  onDestroy(() => project.free());
  $: shown = project(tracks, sort, dir, query);

  async function downloadAll() {
    if (dlBusy) return;
    // Server-side pre-archive is for Deezer tracks (numeric ids). Local/uploaded
    // files (UUID ids) are already on the server's disk, so filter them out —
    // sending them made the server queue nothing and report "0 titres".
    const ids = tracks.map((t) => t.deezer_id).filter((x) => /^\d+$/.test(String(x)));
    if (!ids.length) {
      toasts.push("Rien à archiver (fichiers déjà locaux)");
      return;
    }
    dlBusy = true;
    try {
      const r = await api.download(ids);
      toasts.push(`Téléchargement de ${r.queued} titres lancé`);
    } catch {
      toasts.push("Téléchargement impossible", "error");
    } finally {
      dlBusy = false;
    }
  }
</script>

<div class="toolbar">
  <div class="searchbox">
    <Icon name="search" size={16} />
    <input placeholder="Rechercher dans cette liste…" bind:value={query} />
  </div>
  <div class="spacer"></div>
  <select class="sortsel" bind:value={sort} aria-label="Trier par">
    {#each SORTS as s}<option value={s.key}>{s.label}</option>{/each}
  </select>
  <button class="tb" class:rev={dir === -1} on:click={() => (dir = -dir)} aria-label="Inverser l'ordre" title="Inverser l'ordre">
    <Icon name="sort" size={17} />
  </button>
  {#if downloadable}
    <button class="tb" on:click={downloadAll} disabled={dlBusy} aria-label="Télécharger la liste" title="Télécharger (archiver) toute la liste">
      <Icon name="download" size={17} />
    </button>
  {/if}
</div>

{#if query.trim() && !shown.length}
  <p class="muted empty">Aucun titre ne correspond à « {query} ».</p>
{:else}
  <TrackList tracks={shown} {context} {numbered} {showAlbum} {showCover} />
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0 12px;
  }
  .searchbox {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-card);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 8px 14px;
    color: var(--text-dim);
    max-width: 340px;
    flex: 1;
  }
  .searchbox:focus-within {
    border-color: var(--accent);
    color: var(--text);
  }
  .searchbox input {
    border: none;
    background: none;
    outline: none;
    color: var(--text);
    width: 100%;
  }
  .spacer {
    flex: 1;
  }
  .sortsel {
    background: var(--bg-card);
    color: var(--text);
    border: 1px solid var(--bg-hover);
    border-radius: 8px;
    padding: 8px 10px;
    outline: none;
    cursor: pointer;
  }
  .tb {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 8px;
    background: var(--bg-card);
    color: var(--text-dim);
  }
  .tb:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .tb.rev {
    color: var(--accent);
  }
  .tb:disabled {
    opacity: 0.5;
  }
  .empty {
    margin-top: 18px;
  }
  @media (max-width: 640px) {
    .searchbox {
      max-width: none;
    }
    .spacer {
      display: none;
    }
  }
</style>

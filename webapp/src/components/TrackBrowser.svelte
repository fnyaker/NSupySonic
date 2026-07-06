<script>
  import TrackList from "./TrackList.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";

  export let tracks = [];
  export let context = null;
  export let numbered = true;
  export let showAlbum = true;
  export let showCover = true;
  export let downloadable = true;
  // Progressive loading (set by PagedTrackBrowser). `hasMore` = more blocks to
  // fetch; `onNearEnd` fetches the next block; `onPlayed` fires on play so the
  // parent can extend the queue; `onNeedAll` is called when the user sorts or
  // searches — those need the WHOLE list, so the parent loads every block first.
  export let hasMore = false;
  export let onNearEnd = null;
  export let onPlayed = null;
  export let onNeedAll = null;

  let query = "";
  let sort = "default";
  let dir = 1; // 1 = ascending, -1 = descending
  let dlBusy = false;

  // Sorting / searching only makes sense over the full list — pull every block
  // the moment the user engages either (idempotent on the parent side).
  $: if (onNeedAll && (sort !== "default" || query.trim())) onNeedAll();
  // Only drive block-loading from scroll while showing the natural, unfiltered
  // order; once sorted/searched the parent has (or is) loading everything.
  $: browsing = sort === "default" && !query.trim();

  const SORTS = [
    { key: "default", label: "Ordre d'origine" },
    { key: "title", label: "Titre" },
    { key: "artist", label: "Artiste" },
    { key: "album", label: "Album" },
    { key: "duration", label: "Durée" },
    { key: "added", label: "Date d'ajout" },
  ];
  const lc = (s) => (s || "").toLowerCase();

  $: shown = (() => {
    let list = tracks;
    const q = lc(query.trim());
    if (q)
      list = list.filter(
        (t) =>
          lc(t.title).includes(q) ||
          lc(t.artist?.name).includes(q) ||
          lc(t.album?.title).includes(q)
      );
    if (sort !== "default") {
      const key = {
        title: (t) => lc(t.title),
        artist: (t) => lc(t.artist?.name),
        album: (t) => lc(t.album?.title),
        duration: (t) => t.duration || 0,
        added: (t) => t.added || 0,
      }[sort];
      list = [...list].sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka < kb ? -dir : ka > kb ? dir : 0;
      });
    } else if (dir === -1) {
      list = [...list].reverse();
    }
    return list;
  })();

  async function downloadAll() {
    if (dlBusy) return;
    const ids = tracks.map((t) => t.deezer_id).filter(Boolean);
    if (!ids.length) return;
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
  <TrackList
    tracks={shown}
    {context}
    {numbered}
    {showAlbum}
    {showCover}
    hasMore={browsing && hasMore}
    {onNearEnd}
    {onPlayed}
  />
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

<script>
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

  // Modal (desktop) / bottom-sheet (mobile) to add tracks to a playlist. Search
  // covers both Deezer and the local library (the /search endpoint merges them),
  // so a single box adds either kind. Adds are optimistic via `onadd`.
  export let playlistId;
  export let existingIds = new Set();
  export let onclose = null;
  export let onadd = null; // (track) => void

  let q = "";
  let results = [];
  let loading = false;
  let added = new Set();
  let timer = null;

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(search, 280);
  }

  async function search() {
    const term = q.trim();
    if (!term) {
      results = [];
      return;
    }
    loading = true;
    try {
      const r = await api.search(term);
      results = r.tracks || [];
    } catch {
      results = [];
    } finally {
      loading = false;
    }
  }

  async function add(track) {
    const id = String(track.deezer_id);
    if (added.has(id)) return;
    try {
      await api.addToPlaylist(playlistId, [id]);
      added = new Set(added).add(id);
      onadd?.(track);
      toasts.push("Ajouté à la playlist");
    } catch {
      toasts.push("Échec de l'ajout", "error");
    }
  }

  function isIn(track) {
    const id = String(track.deezer_id);
    return added.has(id) || existingIds.has(id);
  }

  function onKey(e) {
    if (e.key === "Escape") onclose?.();
  }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" on:click={() => onclose?.()}>
  <div class="sheet" on:click|stopPropagation role="dialog" tabindex="-1" aria-label="Ajouter des titres">
    <header>
      <h2>Ajouter des titres</h2>
      <button class="close" on:click={() => onclose?.()} aria-label="Fermer"><Icon name="close" size={20} /></button>
    </header>

    <div class="searchbox">
      <Icon name="search" size={16} />
      <!-- svelte-ignore a11y-autofocus -->
      <input placeholder="Rechercher un titre (Deezer ou local)…" bind:value={q} on:input={onInput} autofocus />
    </div>

    <div class="results">
      {#if loading}
        <p class="muted hint">Recherche…</p>
      {:else if q.trim() && !results.length}
        <p class="muted hint">Aucun résultat pour « {q} ».</p>
      {:else if !q.trim()}
        <p class="muted hint">Tapez pour rechercher dans Deezer et votre bibliothèque locale.</p>
      {/if}

      {#each results as t (t.deezer_id)}
        <div class="res">
          <div class="thumb"><Cover src={t.album?.cover} alt={t.title} size={42} /></div>
          <div class="meta">
            <div class="t">
              {#if t.local}<span class="local" title="Fichier local"><Icon name="cloudOff" size={12} /></span>{/if}
              {t.title}
            </div>
            <div class="sub muted">{t.artist?.name}{t.album?.title ? " · " + t.album.title : ""}</div>
          </div>
          <span class="dur muted">{fmtDuration(t.duration)}</span>
          <button class="add" class:done={isIn(t)} disabled={isIn(t)} on:click={() => add(t)} aria-label="Ajouter">
            <Icon name={isIn(t) ? "check" : "plus"} size={18} />
          </button>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 400;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sheet {
    background: var(--bg-elev);
    width: min(640px, 92vw);
    max-height: 80vh;
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px 10px;
  }
  header h2 {
    font-size: 1.1rem;
  }
  .close {
    color: var(--text-dim);
  }
  .close:hover {
    color: var(--text);
  }
  .searchbox {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-card);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 10px 14px;
    margin: 0 18px 8px;
    color: var(--text-dim);
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
  .results {
    overflow-y: auto;
    padding: 4px 10px 14px;
  }
  .hint {
    padding: 18px;
    text-align: center;
  }
  .res {
    display: grid;
    grid-template-columns: 42px 1fr auto 40px;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 8px;
  }
  .res:hover {
    background: var(--bg-hover);
  }
  .thumb {
    width: 42px;
    flex: none;
  }
  .meta {
    min-width: 0;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .local {
    display: inline-flex;
    vertical-align: -2px;
    color: var(--text-dim);
    margin-right: 3px;
  }
  .sub {
    font-size: 0.82rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dur {
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .add {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--bg-card);
    color: var(--text);
  }
  .add:hover {
    background: var(--accent);
    color: #fff;
  }
  .add.done {
    color: var(--accent);
    background: var(--bg-card);
  }
  @media (max-width: 640px) {
    .backdrop {
      align-items: flex-end;
    }
    .sheet {
      width: 100vw;
      max-height: 88vh;
      border-radius: 16px 16px 0 0;
    }
  }
</style>

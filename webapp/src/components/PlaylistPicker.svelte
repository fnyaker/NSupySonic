<script>
  import { api } from "../lib/api.js";
  import {
    playlistPicker,
    closePlaylistPicker,
    lastPlaylist,
    toasts,
  } from "../lib/stores.js";
  import { userPlaylists, addTrackToPlaylist, invalidatePlaylists } from "../lib/actions.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

  // Modal (desktop) / bottom-sheet (mobile) to pick the playlist a track goes
  // into. Searchable (typing filters by title), last-used playlist pinned on
  // top, and the search text doubles as the name for a brand-new playlist.
  let q = "";
  let playlists = null;
  let busy = false;

  $: track = $playlistPicker?.track || null;
  $: if ($playlistPicker) open();
  async function open() {
    q = "";
    playlists = null;
    playlists = await userPlaylists();
  }

  $: shown = filterList(playlists, q, $lastPlaylist);
  function filterList(list, term, last) {
    if (!list) return null;
    let out = list;
    const t = term.trim().toLowerCase();
    if (t) out = out.filter((p) => (p.title || "").toLowerCase().includes(t));
    // Pin the last-used playlist first — it's the most likely target.
    if (last?.id) {
      const i = out.findIndex((p) => String(p.id) === String(last.id));
      if (i > 0) out = [out[i], ...out.slice(0, i), ...out.slice(i + 1)];
    }
    return out;
  }

  function pick(p) {
    if (!track) return;
    // Optimistic: close instantly, the add runs in the background (a failure
    // shows its own toast from addTrackToPlaylist).
    addTrackToPlaylist(p.id, track.deezer_id, p.title);
    closePlaylistPicker();
  }

  async function createAndAdd() {
    if (busy || !track) return;
    const title = (q.trim() || window.prompt("Nom de la nouvelle playlist ?") || "").trim();
    if (!title) return;
    busy = true;
    try {
      const r = await api.createPlaylist(title, [String(track.deezer_id)]);
      invalidatePlaylists();
      if (r?.id) lastPlaylist.set({ id: String(r.id), title });
      toasts.push(`Ajouté à « ${title} »`);
      closePlaylistPicker();
    } catch {
      toasts.push("Échec de la création de la playlist", "error");
    } finally {
      busy = false;
    }
  }

  function onKey(e) {
    if (e.key === "Escape") closePlaylistPicker();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if $playlistPicker}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="backdrop" on:click={closePlaylistPicker}>
    <div class="sheet" on:click|stopPropagation role="dialog" tabindex="-1" aria-label="Ajouter à une playlist">
      <header>
        <h2>Ajouter à une playlist</h2>
        <button class="close" on:click={closePlaylistPicker} aria-label="Fermer"><Icon name="close" size={20} /></button>
      </header>
      {#if track}
        <p class="which muted">{track.title}{track.artist?.name ? " · " + track.artist.name : ""}</p>
      {/if}

      <div class="searchbox">
        <Icon name="search" size={16} />
        <!-- svelte-ignore a11y-autofocus -->
        <input placeholder="Rechercher une playlist…" bind:value={q} autofocus />
      </div>

      <div class="results">
        <button class="res create" on:click={createAndAdd} disabled={busy}>
          <span class="plus"><Icon name="plus" size={20} /></span>
          <span class="meta"><span class="t">Nouvelle playlist{q.trim() ? ` « ${q.trim()} »` : ""}</span></span>
        </button>

        {#if shown === null}
          <p class="muted hint">Chargement…</p>
        {:else if !shown.length}
          <p class="muted hint">Aucune playlist ne correspond à « {q} ».</p>
        {:else}
          {#each shown as p (p.id)}
            <button class="res" on:click={() => pick(p)} disabled={busy}>
              <span class="thumb"><Cover src={p.cover} alt={p.title} size={42} /></span>
              <span class="meta">
                <span class="t">
                  {p.title}
                  {#if String($lastPlaylist?.id) === String(p.id)}<span class="recent">récente</span>{/if}
                </span>
                <span class="sub muted">{p.nb_tracks ?? 0} titres</span>
              </span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

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
    width: min(480px, 92vw);
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
    padding: 16px 18px 4px;
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
  .which {
    margin: 0 18px 10px;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    grid-template-columns: 42px 1fr;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border-radius: 8px;
    width: 100%;
    text-align: left;
    color: inherit;
    font: inherit;
  }
  .res:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .res:disabled {
    opacity: 0.6;
  }
  .plus {
    width: 42px;
    height: 42px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--bg-card);
    color: var(--text);
  }
  .create:hover:not(:disabled) .plus {
    background: var(--accent);
    color: #fff;
  }
  .thumb {
    width: 42px;
    flex: none;
  }
  .meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .recent {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    background: var(--bg-card);
    border-radius: 4px;
    padding: 2px 5px;
    margin-left: 6px;
    vertical-align: 1px;
  }
  .sub {
    font-size: 0.82rem;
  }
  @media (max-width: 640px) {
    .backdrop {
      align-items: flex-end;
    }
    .sheet {
      width: 100vw;
      max-height: 82vh;
      border-radius: 16px 16px 0 0;
    }
    .res {
      padding: 10px 8px;
    }
  }
</style>

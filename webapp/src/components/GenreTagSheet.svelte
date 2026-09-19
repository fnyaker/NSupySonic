<script>
  // Tag the track that is playing, from the player itself.
  //
  // The studio (routes/Genres.svelte) is where a tagging PASS happens: it brings
  // a candidate to you, you label it, the next one appears. This is the other
  // half of that — the moment when you are already listening to a track and know
  // exactly what it is. Before this, that moment meant leaving the player,
  // finding the track in the studio's candidate list (it may not even be there),
  // and labelling it there. Now it is a button away, from the fullscreen player,
  // while the track is still playing.
  //
  // A tag applied here is not just a label for the studio's NEXT training run:
  // the server treats a hand-applied tag as the authority on the track's genre
  // (see deezer/analysis.py), so it is served to the player immediately and the
  // animation, the readout and the studio all agree from this moment on.
  //
  // Admin-only, like every write in the studio: one library, one model, and two
  // people labelling it would train it against itself. The whole component is
  // inert for anyone else.
  import { fade, scale } from "svelte/transition";
  import { onDestroy } from "svelte";
  import { api } from "../lib/api.js";
  import { genreTagSheet, closeGenreTag, toasts } from "../lib/stores.js";
  import { putAnalysis } from "../lib/analysis.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

  let tags = [];
  let loaded = false;
  let loading = false;
  let busy = 0; // tag id being written, or 0
  let query = "";
  let loadedFor = null;

  $: track = $genreTagSheet?.track || null;
  $: if (track && loadedFor !== track && !loading) load(track);
  $: if (!track) teardown();
  $: shown = filter(tags, query);

  function filter(list, q) {
    const needle = (q || "").trim().toLowerCase();
    if (!needle) return list;
    return list.filter((t) => (t.name || "").toLowerCase().includes(needle));
  }

  async function load(t) {
    loadedFor = t;
    loading = true;
    try {
      // The vocabulary, and which tag this track already wears. Both are cheap
      // reads and both are needed: showing the current one is how you know
      // whether there is anything to do.
      const [status, labelled] = await Promise.all([
        api.genreStatus(),
        api.genreLabelled(),
      ]);
      tags = status?.tags || [];
      const row = (labelled?.labelled || []).find(
        (r) => String(r.deezer_id) === String(t.deezer_id)
      );
      currentTagId = row?.tag?.id ?? null;
    } catch (e) {
      toasts.push(e?.message || "Impossible de lire les genres", "error");
      tags = [];
    } finally {
      loading = false;
      loaded = true;
    }
  }

  let currentTagId = null;

  function teardown() {
    loadedFor = null;
    loaded = false;
    loading = false;
    busy = 0;
    query = "";
    currentTagId = null;
  }
  onDestroy(teardown);

  async function apply(tag) {
    if (busy || !track) return;
    busy = tag?.id || -1;
    // A track's genre is exactly what the analysis serves, so ask the server
    // for the verdict it now holds rather than guessing the shape here: the
    // archetype, the label and the source all come from the same place the
    // player would have read them from anyway.
    try {
      await api.genreLabel(track.deezer_id || track.id, tag ? tag.id : null);
      currentTagId = tag ? tag.id : null;
      toasts.push(
        tag ? `« ${track.title} » étiqueté ${tag.name}` : "Étiquette retirée"
      );
      await refreshVerdict(track);
      closeGenreTag();
    } catch (e) {
      toasts.push(e?.message || "Étiquetage impossible", "error");
      busy = 0;
    }
  }

  // The server has just re-derived the track's verdict with the tag in hand;
  // fetch it and hand it to the player's cache, so the animation adopts the
  // label NOW instead of on the next play (lib/analysis.js broadcasts it).
  async function refreshVerdict(t) {
    const id = String(t.deezer_id || t.id);
    if (!/^\d+$/.test(id)) return;
    try {
      const r = await api.trackAnalysis(id);
      if (r && r.ready) putAnalysis(id, r);
      else putAnalysis(id, null);
    } catch {
      /* the next prime will pick the verdict up; nothing to report */
    }
  }

  function onKey(e) {
    if (e.key === "Escape") closeGenreTag();
  }
</script>

<svelte:window on:keydown={onKey} />

{#if track}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" transition:fade={{ duration: 150 }} on:click|self={closeGenreTag}>
    <div class="sheet" transition:scale={{ duration: 160, start: 0.97 }}>
      <header>
        <div class="thumb">
          <Cover src={track.album?.cover} alt={track.title} size={48} kind="track" fallbackId={track.deezer_id} />
        </div>
        <div class="ttl">
          <h2>Donner un genre</h2>
          <p class="muted">« {track.title} »</p>
        </div>
        <button class="close" on:click={closeGenreTag} aria-label="Fermer">
          <Icon name="close" size={20} />
        </button>
      </header>

      <div class="body">
        {#if loading}
          <p class="muted pad">Chargement des genres…</p>
        {:else if !tags.length}
          <p class="muted pad">
            Aucun genre dans le vocabulaire. Créez-en d'abord dans le studio
            (Bibliothèque&nbsp;→&nbsp;Genres).
          </p>
        {:else}
          <input
            class="q"
            type="text"
            placeholder="Filtrer…"
            bind:value={query}
            autocomplete="off"
          />
          <div class="grid">
            {#each shown as tag (tag.id)}
              <button
                class="chip"
                class:on={String(currentTagId) === String(tag.id)}
                class:busy={busy === tag.id}
                disabled={!!busy}
                style={tag.color ? `--chip:${tag.color}` : ""}
                on:click={() => apply(tag)}>
                {tag.name}
              </button>
            {/each}
            {#if !shown.length}
              <p class="muted pad">Aucun genre ne correspond.</p>
            {/if}
          </div>
        {/if}
      </div>

      <footer>
        {#if currentTagId}
          <button class="clear" disabled={!!busy} on:click={() => apply(null)}>
            Retirer l'étiquette
          </button>
        {/if}
        <p class="muted hint">
          L'étiquette est la référence&nbsp;: elle prime sur l'analyse et sert
          d'exemple d'entraînement pour le modèle.
        </p>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 320;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    padding: 20px;
    backdrop-filter: blur(2px);
  }
  .sheet {
    width: min(520px, 100%);
    max-height: min(78vh, 680px);
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 16px 10px;
  }
  .thumb {
    width: 48px;
    flex: none;
  }
  .ttl {
    min-width: 0;
    flex: 1;
  }
  .ttl h2 {
    margin: 0 0 2px;
    font-size: 1.05rem;
  }
  .ttl p {
    margin: 0;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .close {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: var(--text-dim);
    flex: none;
  }
  .close:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .body {
    overflow-y: auto;
    padding: 0 16px 10px;
    flex: 1;
  }
  .q {
    width: 100%;
    padding: 9px 12px;
    margin-bottom: 10px;
    border-radius: 10px;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    color: var(--text);
  }
  .q:focus {
    outline: none;
    border-color: var(--accent);
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 8px;
  }
  .chip {
    padding: 7px 14px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    background: var(--bg-elev);
    color: var(--text);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .chip:hover {
    border-color: var(--chip, var(--accent));
  }
  .chip.on {
    background: var(--chip, var(--accent));
    border-color: var(--chip, var(--accent));
    color: var(--bg-card);
  }
  .chip.busy {
    opacity: 0.6;
  }
  .pad {
    padding: 16px 4px 20px;
    font-size: 0.9rem;
  }
  footer {
    padding: 10px 16px 16px;
    border-top: 1px solid var(--bg-hover);
  }
  .clear {
    color: var(--text-dim);
    font-size: 0.85rem;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .clear:hover {
    color: var(--text);
  }
  .hint {
    margin: 0;
    font-size: 0.78rem;
    line-height: 1.4;
  }
</style>
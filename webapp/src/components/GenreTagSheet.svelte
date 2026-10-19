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
  import { trackKey, trackRef } from "../lib/trackkey.js";
  import { fade, scale } from "svelte/transition";
  import { onDestroy, tick } from "svelte";
  import { api } from "../lib/api.js";
  import { genreTagSheet, closeGenreTag, toasts } from "../lib/stores.js";
  import { putAnalysis, verdictId } from "../lib/analysis.js";
  import { rankTags, searchTags, noteRecent } from "../lib/genre/rank.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

  let tags = [];
  let counts = {};
  let scores = [];
  let loaded = false;
  let loading = false;
  let busy = 0; // tag id being written, or 0
  let query = "";
  let loadedFor = null;
  let input = null;

  $: track = $genreTagSheet?.track || null;
  $: if (track && loadedFor !== track && !loading) load(track);
  $: if (!track) teardown();
  // The vocabulary in THIS track's order (lib/genre/rank.js): the model's and
  // the prototypes' opinion first, then what the library uses most — never the
  // alphabet, which put the genre you wanted somewhere in a wall of 200 chips.
  $: ranked = rankTags(tags, scores, counts);
  $: shown = query.trim() ? searchTags(ranked, query) : ranked;
  $: scored = ranked.length > 0 && ranked[0].score != null;

  async function load(t) {
    loadedFor = t;
    loading = true;
    try {
      // The vocabulary, and this track's own tag and ranking — one row, not the
      // whole labelled set read to find it.
      const [status, mine] = await Promise.all([
        api.genreStatus(),
        api.genreTrack(trackRef(t)).catch(() => null),
      ]);
      tags = status?.tags || [];
      counts = status?.counts || {};
      scores = mine?.scores || [];
      currentTagId = mine?.tag?.id ?? null;
    } catch (e) {
      toasts.push(e?.message || "Impossible de lire les genres", "error");
      tags = [];
    } finally {
      loading = false;
      loaded = true;
    }
    // A keyboard is there to type with; a phone's would cover half the list.
    await tick();
    if (input && window.matchMedia?.("(pointer: fine)").matches) input.focus();
  }

  let currentTagId = null;

  function teardown() {
    loadedFor = null;
    loaded = false;
    loading = false;
    busy = 0;
    query = "";
    scores = [];
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
      await api.genreLabel(trackRef(track), tag ? tag.id : null);
      currentTagId = tag ? tag.id : null;
      if (tag) noteRecent(tag.id);
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
    const id = verdictId(trackKey(t));
    if (!id) return;
    try {
      const r = await api.trackAnalysis(id);
      if (r && r.ready) putAnalysis(id, r);
      else putAnalysis(id, null);
    } catch {
      /* the next prime will pick the verdict up; nothing to report */
    }
  }

  function onKey(e) {
    if (!track) return;
    if (e.key === "Escape") {
      if (query) query = "";
      else closeGenreTag();
      return;
    }
    // Enter on a focused chip is that chip's own click, not "the first one".
    if (e.key === "Enter" && shown[0] && !busy && e.target?.tagName !== "BUTTON") {
      e.preventDefault();
      apply(shown[0].tag);
      return;
    }
    // 1..9 pick from the ranking — only when the box is empty, since a digit
    // typed into it is part of a name.
    const n = parseInt(e.key, 10);
    if (!query && n >= 1 && n <= 9 && shown[n - 1] && !busy && !(e.metaKey || e.ctrlKey || e.altKey)) {
      e.preventDefault();
      apply(shown[n - 1].tag);
    }
  }
</script>

<svelte:window on:keydown={onKey} />

{#if track}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" transition:fade={{ duration: 150 }} on:click|self={closeGenreTag}>
    <div class="sheet" transition:scale={{ duration: 160, start: 0.97 }}>
      <header>
        <div class="thumb">
          <Cover src={track.album?.cover} alt={track.title} size={48} kind="track" fallbackId={trackRef(track)} />
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
          <div class="q">
            <Icon name="search" size={16} />
            <input
              bind:this={input}
              type="search"
              placeholder="Chercher un genre…"
              bind:value={query}
              autocomplete="off"
              spellcheck="false"
              aria-label="Chercher un genre"
            />
          </div>
          {#if !query}
            <p class="order muted">
              {scored ? "Du plus au moins probable pour ce titre" : "Les plus utilisés d'abord"}
            </p>
          {/if}
          <div class="grid">
            {#each shown as r, i (r.tag.id)}
              <button
                class="chip"
                class:on={String(currentTagId) === String(r.tag.id)}
                class:top={i === 0 && (scored || query)}
                class:busy={busy === r.tag.id}
                disabled={!!busy}
                style={r.tag.color ? `--chip:${r.tag.color}` : ""}
                on:click={() => apply(r.tag)}>
                {#if i < 9 && !query}<kbd>{i + 1}</kbd>{/if}
                <span>{r.tag.name}</span>
                {#if r.score != null && r.score >= 0.01}<small>{Math.round(r.score * 100)} %</small>{/if}
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
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 12px;
    margin-bottom: 8px;
    border-radius: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
  }
  .q:focus-within {
    border-color: var(--accent);
  }
  .q input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    background: none;
    outline: none;
    color: var(--text);
    font-size: 0.95rem;
  }
  .order {
    margin: 0 0 10px;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 38px;
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
  .chip.top:not(.on) {
    border-color: var(--chip, var(--accent));
    background: color-mix(in srgb, var(--chip, var(--accent)) 12%, var(--bg-elev));
  }
  .chip kbd {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 5px;
    padding: 0 5px;
    font: inherit;
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--text-dim);
  }
  .chip.on kbd {
    color: inherit;
  }
  .chip small {
    font-weight: 500;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
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
<script>
  import { onDestroy } from "svelte";
  import { api } from "../lib/api.js";
  import { isAdmin } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import PodcastCard from "../components/PodcastCard.svelte";
  import TrackList from "../components/TrackList.svelte";
  import Skeleton from "../components/Skeleton.svelte";

  export let params = {};

  let q = "";
  let results = { artists: [], albums: [], tracks: [], playlists: [], podcasts: [] };
  let loading = false;
  let tab = "all"; // all | tracks | albums | artists | playlists | podcasts
  let timer;
  let seq = 0;

  // Deep link support (/search/:q from the sidebar).
  //
  // The gate is the last param we APPLIED — never the live input value. This
  // block re-runs whenever anything it reads changes, and `q` is one of those:
  // comparing against `q` meant every keystroke re-ran the block, found the
  // typed text different from the URL term and reset the box back to it. The
  // search field was effectively frozen on the deep-linked query.
  let appliedParam = null;
  $: applyParam(params.q);
  function applyParam(raw) {
    if (raw === undefined || raw === appliedParam) return;
    appliedParam = raw;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw); // a malformed %xx would throw
    } catch {
      /* keep the raw value */
    }
    q = decoded;
    run(q.trim());
  }

  // Live search as you type, debounced. We deliberately do NOT change the route
  // on each keystroke (that would tear down & rebuild this component).
  function onInput() {
    clearTimeout(timer);
    const term = q.trim();
    timer = setTimeout(() => run(term), 280);
  }

  async function run(term) {
    const mine = ++seq;
    if (!term) {
      results = { artists: [], albums: [], tracks: [], playlists: [], podcasts: [] };
      loading = false;
      return;
    }
    loading = true;
    try {
      const r = await api.search(term);
      if (mine !== seq) return; // a newer query already started
      results = { artists: [], albums: [], tracks: [], playlists: [], podcasts: [], ...r };
    } catch {
      if (mine === seq)
        results = { artists: [], albums: [], tracks: [], playlists: [], podcasts: [] };
    } finally {
      if (mine === seq) loading = false;
    }
  }

  onDestroy(() => clearTimeout(timer));

  $: hasResults =
    results.artists?.length ||
    results.albums?.length ||
    results.tracks?.length ||
    results.playlists?.length ||
    (results.podcasts?.length && $isAdmin);
</script>

<div class="bar fade-in">
  <!-- svelte-ignore a11y-autofocus -->
  <input
    placeholder="Artistes, titres, albums, playlists…"
    bind:value={q}
    on:input={onInput}
    autofocus
  />
</div>

{#if q.trim()}
  <div class="tabs">
    <button class:active={tab === "all"} on:click={() => (tab = "all")}>Tout</button>
    <button class:active={tab === "tracks"} on:click={() => (tab = "tracks")}>Titres</button>
    <button class:active={tab === "albums"} on:click={() => (tab = "albums")}>Albums</button>
    <button class:active={tab === "artists"} on:click={() => (tab = "artists")}>Artistes</button>
    <button class:active={tab === "playlists"} on:click={() => (tab = "playlists")}>Playlists</button>
    {#if $isAdmin}
      <button class:active={tab === "podcasts"} on:click={() => (tab = "podcasts")}>Podcasts</button>
    {/if}
  </div>
{/if}

{#if loading}
  <Skeleton kind="shelf" />
  <Skeleton kind="list" />
{:else if !q.trim()}
  <p class="muted hint">Commencez à taper pour rechercher.</p>
{:else if !hasResults}
  <p class="muted hint">Aucun résultat pour « {q} ».</p>
{:else}
  {#if (tab === "all" || tab === "artists") && results.artists?.length}
    <h2>Artistes</h2>
    <div class={tab === "artists" ? "grid" : "shelf"}>
      {#each results.artists as a (a.deezer_id)}<Card item={a} kind="artist" />{/each}
    </div>
  {/if}

  {#if (tab === "all" || tab === "albums") && results.albums?.length}
    <h2>Albums</h2>
    <div class={tab === "albums" ? "grid" : "shelf"}>
      {#each results.albums as a (a.deezer_id)}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if (tab === "all" || tab === "playlists") && results.playlists?.length}
    <h2>Playlists</h2>
    <div class={tab === "playlists" ? "grid" : "shelf"}>
      {#each results.playlists as p (p.deezer_id)}<Card item={p} kind="playlist" />{/each}
    </div>
  {/if}

  {#if (tab === "all" || tab === "tracks") && results.tracks?.length}
    <h2>Titres</h2>
    <TrackList tracks={results.tracks} />
  {/if}

  {#if $isAdmin && (tab === "all" || tab === "podcasts") && results.podcasts?.length}
    <h2>Podcasts</h2>
    <div class={tab === "podcasts" ? "grid" : "shelf"}>
      {#each results.podcasts as p (p.deezer_id)}<PodcastCard item={p} />{/each}
    </div>
  {/if}
{/if}

<style>
  .bar input {
    width: 100%;
    max-width: 560px;
    padding: 14px 18px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: var(--bg-card);
    color: var(--text);
    outline: none;
    font-size: 1.05rem;
  }
  .bar input:focus {
    border-color: var(--accent);
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin: 18px 0 4px;
    flex-wrap: wrap;
  }
  .tabs button {
    padding: 7px 16px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .tabs button.active {
    background: #fff;
    color: #111;
  }
  .hint {
    margin-top: 28px;
  }
</style>

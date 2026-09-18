<script>
  import { onDestroy } from "svelte";
  import { api } from "../lib/api.js";
  import { isAdmin } from "../lib/stores.js";
  import { rememberScreen, recallScreen } from "../lib/nav.js";
  import Card from "../components/Card.svelte";
  import PodcastCard from "../components/PodcastCard.svelte";
  import TrackList from "../components/TrackList.svelte";
  import Skeleton from "../components/Skeleton.svelte";

  export let params = {};

  const EMPTY = { artists: [], albums: [], tracks: [], playlists: [], podcasts: [] };

  // Coming BACK here (from an album you opened out of the results, say) must
  // land you on the screen you left — query, tab, results and all — not on an
  // empty search page. lib/nav.js keys that on the history entry, so a fresh
  // tap on "Rechercher" in the nav still starts clean.
  const saved = recallScreen();

  let q = saved?.q ?? "";
  let results = saved?.results ?? EMPTY;
  let loading = false;
  let tab = saved?.tab ?? "all"; // all | tracks | albums | artists | playlists | podcasts
  let timer;
  let seq = 0;
  // Don't pop the soft keyboard over a restored screen: you came back to read
  // the results, not to retype the query.
  const autofocusBox = !q;

  // Whatever the screen is showing, ready for the next time we come back to it.
  $: rememberScreen({ q, tab, results });

  // Deep link support (/search/:q from the sidebar).
  //
  // The gate is the last param we APPLIED — never the live input value. This
  // block re-runs whenever anything it reads changes, and `q` is one of those:
  // comparing against `q` meant every keystroke re-ran the block, found the
  // typed text different from the URL term and reset the box back to it. The
  // search field was effectively frozen on the deep-linked query.
  //
  // A restored screen has already applied its query: treat the URL term as
  // consumed, or the restore would be overwritten by a redundant refetch.
  let appliedParam = saved ? (params.q ?? null) : null;
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
      results = EMPTY;
      loading = false;
      return;
    }
    loading = true;
    try {
      const r = await api.search(term);
      if (mine !== seq) return; // a newer query already started
      results = { ...EMPTY, ...r };
    } catch {
      if (mine === seq) results = EMPTY;
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

  // "Tout" leads with the titles, because that is what a search is usually for:
  // the top handful, then one row of albums, then one of artists. Ten is the
  // most that still reads as a shortlist on a phone rather than a page you have
  // to scroll past to reach anything else — the rest is one tap away on the
  // Titres tab.
  const TOP_TRACKS = 10;
  $: topTracks =
    tab === "all" ? (results.tracks || []).slice(0, TOP_TRACKS) : results.tracks || [];
  $: moreTracks = Math.max(0, (results.tracks?.length || 0) - TOP_TRACKS);
</script>

<div class="bar fade-in">
  <!-- svelte-ignore a11y-autofocus -->
  <input
    placeholder="Artistes, titres, albums, playlists…"
    bind:value={q}
    on:input={onInput}
    autofocus={autofocusBox}
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
  {#if (tab === "all" || tab === "tracks") && results.tracks?.length}
    <div class="sechead">
      <h2>Titres</h2>
      {#if tab === "all" && moreTracks}
        <button class="seeall" on:click={() => (tab = "tracks")}>
          Tout afficher<span class="count">{results.tracks.length}</span>
        </button>
      {/if}
    </div>
    <TrackList tracks={topTracks} />
  {/if}

  {#if (tab === "all" || tab === "albums") && results.albums?.length}
    <div class="sechead">
      <h2>Albums</h2>
      {#if tab === "all" && results.albums.length > 1}
        <button class="seeall" on:click={() => (tab = "albums")}>Tout afficher</button>
      {/if}
    </div>
    <div class={tab === "albums" ? "grid" : "shelf"}>
      {#each results.albums as a (a.deezer_id)}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if (tab === "all" || tab === "artists") && results.artists?.length}
    <div class="sechead">
      <h2>Artistes</h2>
      {#if tab === "all" && results.artists.length > 1}
        <button class="seeall" on:click={() => (tab = "artists")}>Tout afficher</button>
      {/if}
    </div>
    <div class={tab === "artists" ? "grid" : "shelf"}>
      {#each results.artists as a (a.deezer_id)}<Card item={a} kind="artist" />{/each}
    </div>
  {/if}

  {#if (tab === "all" || tab === "playlists") && results.playlists?.length}
    <div class="sechead">
      <h2>Playlists</h2>
      {#if tab === "all" && results.playlists.length > 1}
        <button class="seeall" on:click={() => (tab = "playlists")}>Tout afficher</button>
      {/if}
    </div>
    <div class={tab === "playlists" ? "grid" : "shelf"}>
      {#each results.playlists as p (p.deezer_id)}<Card item={p} kind="playlist" />{/each}
    </div>
  {/if}

  {#if $isAdmin && (tab === "all" || tab === "podcasts") && results.podcasts?.length}
    <div class="sechead">
      <h2>Podcasts</h2>
      {#if tab === "all" && results.podcasts.length > 1}
        <button class="seeall" on:click={() => (tab = "podcasts")}>Tout afficher</button>
      {/if}
    </div>
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
  /* The section title and its "tout afficher" share a baseline: the link sits
     at the end of the row rather than under the heading, so the eye reads
     "Titres … tout afficher" as one line and the shelves below stay flush. */
  .sechead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }
  .seeall {
    display: inline-flex;
    align-items: baseline;
    gap: 7px;
    flex: none;
    padding: 0;
    color: var(--text-dim);
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .seeall:hover {
    color: var(--text);
  }
  .seeall .count {
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-dim);
    background: var(--bg-card);
    border-radius: 999px;
    padding: 2px 7px;
  }
  .seeall:hover .count {
    color: var(--text);
  }
</style>

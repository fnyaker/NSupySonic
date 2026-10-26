<script>
  import { onDestroy } from "svelte";
  import { api } from "../lib/api.js";
  import { isAdmin } from "../lib/stores.js";
  import { rememberScreen, recallScreen } from "../lib/nav.js";
  import Card from "../components/Card.svelte";
  import PodcastCard from "../components/PodcastCard.svelte";
  import TrackList from "../components/TrackList.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";
  import { youtubeStatus, loadYoutubeStatus } from "../lib/youtube.js";
  import { access } from "../lib/access.js";
  import { playlistLink, importRoute } from "../lib/linkimport.js";
  import { entityRef } from "../lib/entity.js";
  import { topResult, mixPodcasts } from "../lib/searchrank.js";
  import TopResult from "../components/TopResult.svelte";

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
  let tab = saved?.tab ?? "all"; // all | tracks | artists | albums | playlists
  let timer;
  let seq = 0;
  // Don't pop the soft keyboard over a restored screen: you came back to read
  // the results, not to retype the query.
  const autofocusBox = !q;

  // YouTube, the fallback: off unless ticked, on this screen only (a new
  // search starts with it off again). Asked on Enter or when the box is ticked
  // — never per keystroke: every partial word typed would be a request there,
  // and the server keeps each answer a day, so a search repeated costs nothing.
  let yt = saved?.yt ?? false;
  let ytTracks = saved?.ytTracks ?? [];
  let ytFor = saved?.ytFor ?? "";
  let ytLoading = false;
  let ytError = "";
  let ytSeq = 0;
  loadYoutubeStatus();
  $: ytAvailable = !!$youtubeStatus?.enabled && $access.can("youtube", "search");
  $: ytStale = yt && ytAvailable && q.trim() !== ytFor;

  async function runYoutube() {
    const term = q.trim();
    // A pasted playlist link is an import, not something to search YouTube for.
    if (!yt || !ytAvailable || !term || term === ytFor || playlistLink(term)) return;
    const mine = ++ytSeq;
    ytLoading = true;
    ytError = "";
    try {
      const r = await api.youtubeSearch(term);
      if (mine !== ytSeq) return;
      ytTracks = r.tracks || [];
      ytFor = term;
    } catch (e) {
      if (mine !== ytSeq) return;
      ytTracks = [];
      ytError =
        e?.status === 503 ? "YouTube ne répond pas pour le moment." : "La recherche YouTube a échoué.";
    } finally {
      if (mine === ytSeq) ytLoading = false;
    }
  }

  function toggleYoutube() {
    yt = !yt;
    if (yt) runYoutube();
  }

  function onKey(e) {
    if (e.key !== "Enter") return;
    clearTimeout(timer);
    const term = q.trim();
    // Enter is "search now": the regular search at once, YouTube if ticked.
    run(term);
    runYoutube();
    e.currentTarget.blur(); // drop the phone keyboard over the results
  }

  // Whatever the screen is showing, ready for the next time we come back to it.
  $: rememberScreen({ q, tab, results, yt, ytTracks, ytFor });

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
    if (!term || playlistLink(term)) {
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

  // A pasted playlist link is not a search: offer to import it instead.
  $: shared = playlistLink(q);

  // "Tout" leads with what a search is usually for: the artist the query
  // plainly names (only then — lib/searchrank.js), the titles, then the
  // artists, then the albums with the shows mixed in under a small "Podcast"
  // label, then the playlists. Ten titles is the most that still reads as a
  // shortlist on a phone; the rest is one tap away on the Titres tab. An old
  // saved "podcasts" tab lands on the albums, where the shows are now.
  $: if (tab === "podcasts") tab = "albums";
  $: podcasts = $isAdmin ? results.podcasts || [] : [];
  $: top = tab === "all" ? topResult(q, results, $isAdmin) : null;
  $: shelfArtists = (results.artists || []).filter((a) => !(top?.kind === "artist" && a === top.item));
  $: albumsAndShows = mixPodcasts(
    results.albums || [],
    podcasts.filter((p) => !(top?.kind === "podcast" && p === top.item)),
  );

  const TOP_TRACKS = 10;
  $: topTracks =
    tab === "all" ? (results.tracks || []).slice(0, TOP_TRACKS) : results.tracks || [];
  $: moreTracks = Math.max(0, (results.tracks?.length || 0) - TOP_TRACKS);
</script>

<div class="bar fade-in">
  <!-- svelte-ignore a11y-autofocus -->
  <input
    type="search"
    enterkeyhint="search"
    placeholder="Titres, artistes, albums, podcasts…"
    bind:value={q}
    on:input={onInput}
    on:keydown={onKey}
    autofocus={autofocusBox}
  />
  {#if ytAvailable}
    <button
      class="ytbox"
      class:on={yt}
      role="switch"
      aria-checked={yt}
      title="Chercher aussi sur YouTube (en dernier recours)"
      on:click={toggleYoutube}
    >
      <span class="tick" aria-hidden="true">{#if yt}<Icon name="check" size={12} />{/if}</span>
      <Icon name="youtube" size={16} />
      <span>YouTube</span>
    </button>
  {/if}
</div>

{#if shared}
  <a class="shared fade-in" href={importRoute(shared.url)}>
    <span class="s-icon"><Icon name="link" size={20} /></span>
    <span class="s-text">
      <strong>Importer cette playlist {shared.label}</strong>
      <span class="muted">Retrouver ses titres pour l'écouter ici, et la garder si tu veux.</span>
    </span>
  </a>
{/if}

{#if q.trim() && !shared}
  <div class="tabs" role="tablist">
    {#each [["all", "Tout"], ["tracks", "Titres"], ["artists", "Artistes"], ["albums", "Albums"], ["playlists", "Playlists"]] as [id, label]}
      <button role="tab" aria-selected={tab === id} class:active={tab === id} on:click={() => (tab = id)}>{label}</button>
    {/each}
  </div>
{/if}

{#if loading}
  <Skeleton kind="shelf" />
  <Skeleton kind="list" />
{:else if !q.trim()}
  <p class="muted hint">Commencez à taper pour rechercher.</p>
{:else if !hasResults}
  {#if !(yt && ytAvailable) && !shared}
    <p class="muted hint">Aucun résultat pour « {q} ».</p>
  {/if}
{:else}
  <div class="leadwrap"><div class="lead" class:withtop={!!top}>
    {#if top}
      <section class="topcol">
        <h2>Meilleur résultat</h2>
        <TopResult kind={top.kind} item={top.item} />
      </section>
    {/if}
    {#if (tab === "all" || tab === "tracks") && results.tracks?.length}
      <section class="trackcol">
        <div class="sechead">
          <h2>Titres</h2>
          {#if tab === "all" && moreTracks}
            <button class="seeall" on:click={() => (tab = "tracks")}>
              Tout afficher<span class="count">{results.tracks.length}</span>
            </button>
          {/if}
        </div>
        <TrackList tracks={topTracks} radio />
      </section>
    {/if}
  </div></div>
{/if}

{#if !loading && q.trim() && !shared && yt && ytAvailable && (tab === "all" || tab === "tracks")}
  <h2 class="ythead"><Icon name="youtube" size={20} /> Sur YouTube</h2>
  {#if ytTracks.length && !ytStale && !ytLoading}
    <p class="ytnote muted">Archivé à la première écoute, en Opus ~130 kbit/s (le mieux que YouTube propose).</p>
  {/if}
  {#if ytLoading}
    <Skeleton kind="list" />
  {:else if ytStale}
    <button class="ytgo" on:click={runYoutube}>
      <Icon name="search" size={15} /> Chercher « {q.trim()} » sur YouTube
    </button>
  {:else if ytError}
    <p class="muted hint small">{ytError}</p>
  {:else if !ytTracks.length}
    <p class="muted hint small">Rien sur YouTube pour « {ytFor} ».</p>
  {:else}
    <TrackList tracks={ytTracks} />
  {/if}
{/if}

{#if !loading && q.trim() && hasResults}

  {#if (tab === "all" || tab === "artists") && shelfArtists.length}
    <div class="sechead">
      <h2>Artistes</h2>
      {#if tab === "all" && shelfArtists.length > 1}
        <button class="seeall" on:click={() => (tab = "artists")}>Tout afficher</button>
      {/if}
    </div>
    <div class={tab === "artists" ? "grid" : "shelf"}>
      {#each shelfArtists as a (entityRef(a))}<Card item={a} kind="artist" />{/each}
    </div>
  {/if}

  {#if (tab === "all" || tab === "albums") && albumsAndShows.length}
    <div class="sechead">
      <h2>Albums</h2>
      {#if tab === "all" && albumsAndShows.length > 1}
        <button class="seeall" on:click={() => (tab = "albums")}>Tout afficher</button>
      {/if}
    </div>
    <div class={tab === "albums" ? "grid" : "shelf"}>
      {#each albumsAndShows as a ((a.podcast ? "p" : "a") + entityRef(a))}
        {#if a.podcast}<PodcastCard item={a} />{:else}<Card item={a} kind="album" />{/if}
      {/each}
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
      {#each results.playlists as p (entityRef(p))}<Card item={p} kind="playlist" />{/each}
    </div>
  {/if}
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .bar input {
    flex: 1 1 180px;
    min-width: 0;
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
  /* Hide the browser's own clear cross: the box is the same pill everywhere. */
  .bar input::-webkit-search-cancel-button {
    -webkit-appearance: none;
  }
  /* A checkbox you can hit with a thumb, reading as one: a tick, the mark
     and the word, lit when it is on. */
  .ytbox {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: none;
    min-height: 44px;
    padding: 0 16px 0 12px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 700;
    font-size: 0.9rem;
    transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .ytbox:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .ytbox.on {
    color: var(--text);
    border-color: color-mix(in srgb, var(--accent) 70%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .tick {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 1.5px solid currentColor;
    opacity: 0.8;
  }
  .ytbox.on .tick {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    opacity: 1;
  }
  .ythead {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  /* The note sits under the heading, not beside it: beside it, a phone broke
     "Sur YouTube" over two lines to make room. */
  .ytnote {
    margin: 0 0 10px;
    font-size: 0.8rem;
  }
  .ytgo {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 8px;
    padding: 10px 18px;
    border-radius: 999px;
    background: var(--bg-card);
    color: var(--text);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .ytgo:hover {
    background: var(--bg-hover);
  }
  .hint.small {
    margin-top: 6px;
  }
  .shared {
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: 560px;
    margin: 16px 0 4px;
    padding: 14px 18px;
    border-radius: var(--radius);
    background: var(--bg-card);
    color: var(--text);
    text-decoration: none;
  }
  .shared:hover {
    background: var(--bg-hover);
  }
  .s-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
  }
  .s-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
    font-size: 0.9rem;
  }
  /* One row of chips that scrolls sideways on a phone rather than wrapping
     to a second line (Material 3's filter chips). */
  .tabs {
    display: flex;
    gap: 8px;
    margin: 18px -16px 4px;
    padding: 0 16px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs button {
    flex: none;
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
  /* The best result beside the titles where there is room for both (the way
     Spotify and YouTube Music lay it out), above them on a phone. */
  .leadwrap {
    container-type: inline-size;
  }
  .lead.withtop {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 4px 28px;
  }
  @container (min-width: 860px) {
    .lead.withtop {
      grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
      align-items: start;
    }
  }
  .lead section {
    min-width: 0;
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

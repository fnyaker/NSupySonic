<script>
  import { entityRef } from "../lib/entity.js";
  import { api } from "../lib/api.js";
  import { REMOTE, CAN_KEEP, CAN_ADMIN, CAN_BROWSE } from "../lib/remote/mode.js";
  import { player, isAdmin, openGenreBulk } from "../lib/stores.js";
  import { toggleEntityFavorite, entityMeta } from "../lib/actions.js";
  import Cover from "../components/Cover.svelte";
  import Card from "../components/Card.svelte";
  import TrackList from "../components/TrackList.svelte";
  import GradientHeader from "../components/GradientHeader.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import LoadFailed from "../components/LoadFailed.svelte";
  import Icon from "../components/Icon.svelte";
  import { rememberScreen, recallScreen } from "../lib/nav.js";

  export let params = {};

  let id = null;
  let data = null;
  let disco = null;
  // Albums Deezer has and the library does not: null = loading, [] = none (or
  // Deezer unreachable — the library page above is complete on its own).
  let onDeezer = null;
  let deezerDown = false;
  let fav = false;
  let loading = true;
  let loadError = null; // why there is nothing to show (components/LoadFailed)

  // Two views on the artist page: the card-based overview and a flat, full
  // "Titres" list (all of the artist's tracks, loaded lazily on first open).
  let tab = "overview";
  let allTracks = null; // null = not loaded yet, [] = loaded/empty
  let tracksLoading = false;
  // Which tab we were on when we left this history entry. load() clears the tab
  // on every artist change, so it is consumed THERE (on the first load) rather
  // than applied here, where it would be overwritten a moment later.
  let restoredTab = recallScreen()?.tab || null;
  $: rememberScreen({ tab });

  $: if (params.id && params.id !== id) {
    id = params.id;
    load(id);
  }

  // Lazily fetch the full track list the first time the "Titres" tab is opened.
  $: if (tab === "tracks" && allTracks === null && !tracksLoading) loadTracks(id);

  async function loadTracks(artistId) {
    tracksLoading = true;
    try {
      const r = await api.artistTracks(artistId);
      if (artistId === id) allTracks = r.tracks || [];
    } catch {
      if (artistId === id) allTracks = [];
    }
    if (artistId === id) tracksLoading = false;
  }

  function playAllTracks() {
    if (allTracks?.length) player.playQueue(allTracks, 0, { kind: "artist", id });
  }

  // Sequence guard: a delayed earlier response (network / offline retries)
  // must not overwrite the page after a quick navigation to another artist.
  let loadSeq = 0;
  async function load(artistId) {
    const mine = ++loadSeq;
    loading = true;
    loadError = null;
    data = null;
    disco = null;
    onDeezer = null;
    deezerDown = false;
    fav = false;
    tab = restoredTab || "overview";
    restoredTab = null;
    allTracks = null;
    tracksLoading = false;
    try {
      // Cached copy first, fresh one right after — no skeleton on a revisit.
      await api.swr("/artist/" + artistId, (r) => {
        if (mine !== loadSeq) return;
        data = r;
        fav = !!r.artist?.is_favorite; // correct when the source reports it
        loading = false;
      });
      // After the page is on screen: what only Deezer has.
      if (mine === loadSeq && data?.library) loadOnDeezer(artistId, mine);
    } catch (e) {
      if (mine === loadSeq && !data) {
        data = null;
        loadError = e;
      }
    }
    if (mine === loadSeq) loading = false;
    api
      .discography(artistId)
      .then((r) => {
        if (mine === loadSeq) disco = r.discography;
      })
      .catch(() => {
        if (mine === loadSeq) disco = null;
      });
  }

  function loadOnDeezer(artistId, mine) {
    api
      .artistOnDeezer(artistId)
      .then((r) => {
        if (mine === loadSeq) onDeezer = r.albums || [];
      })
      .catch(() => {
        if (mine !== loadSeq) return;
        onDeezer = [];
        deezerDown = true;
      });
  }

  function playTop() {
    if (data?.top?.length) player.playQueue(data.top, 0, { kind: "artist", id });
  }

  async function startRadio() {
    try {
      const r = await api.artistRadio(id);
      player.playQueue(r.tracks, 0, { kind: "artist-radio", id });
    } catch {
      /* ignore */
    }
  }

  async function toggleFav() {
    const next = !fav;
    if (await toggleEntityFavorite("artist", id, next, entityMeta("artist", data?.artist || {}))) fav = next;
  }

  const TYPE_LABEL = { album: "Album", single: "Single", ep: "EP", compile: "Compilation" };
  function releaseSubtitle(r) {
    const type = TYPE_LABEL[r.record_type] || "Sortie";
    return r.year ? `${type} · ${r.year}` : type;
  }

  $: albums = disco?.album || data?.albums || [];
  $: singles = disco?.single || [];
  $: featured = disco?.featured || [];
  // The 5 most recent official releases (backend already sorts `all` by date).
  $: latest = ((disco?.all && disco.all.length ? disco.all : albums) || [])
    .slice(0, 5)
    .map((r) => ({ ...r, subtitle: releaseSubtitle(r) }));
</script>

{#if loading}
  <Skeleton kind="header" />
  <Skeleton kind="list" />
{:else if !data?.artist}
  <LoadFailed error={loadError} notFound="Artiste introuvable." on:retry={() => load(id)} />
{:else}
  <div class="fade-in">
    <GradientHeader cover={data.artist.picture}>
      <div class="art"><Cover src={data.artist.picture} alt={data.artist.name} kind="artist" round eager /></div>
      <div class="meta">
        <span class="kind">Artiste</span>
        <h1>{data.artist.name}</h1>
        {#if data.artist.nb_fan}<span class="muted">{data.artist.nb_fan.toLocaleString("fr-FR")} fans</span>{/if}
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={playTop}><Icon name="play" size={18} /> Lire</button>
      <button class="pill ghost" on:click={startRadio}><Icon name="radio" size={18} /> Radio</button>
      {#if CAN_KEEP}
        <button class="icon-btn" class:on={fav} on:click={toggleFav} aria-label="Suivre"><Icon name={fav ? "heartFilled" : "heart"} size={22} /></button>
      {/if}
      {#if $isAdmin && CAN_KEEP}
        <!-- Every track of this artist the library holds, reviewed first. -->
        <button
          class="icon-btn"
          on:click={() => openGenreBulk({ kind: "artist", artist: id, title: data.artist.name, cover: data.artist.picture })}
          aria-label="Donner un genre à l'artiste"
          title="Donner un genre à tous ses titres de la bibliothèque"><Icon name="tag" size={21} /></button>
      {/if}
    </div>

    <div class="tabs">
      <button class:active={tab === "overview"} on:click={() => (tab = "overview")}>Aperçu</button>
      <button class:active={tab === "tracks"} on:click={() => (tab = "tracks")}>Titres</button>
    </div>

    {#if tab === "tracks"}
      {#if tracksLoading && allTracks === null}
        <Skeleton kind="list" />
      {:else if !allTracks?.length}
        <p class="muted">Aucun titre trouvé pour cet artiste.</p>
      {:else}
        <div class="row tracks-head">
          <button class="pill" on:click={playAllTracks}><Icon name="play" size={18} /> Tout lire</button>
          <span class="muted">{allTracks.length} titres</span>
        </div>
        <TrackList tracks={allTracks} context={{ kind: "artist", id }} numbered />
      {/if}
    {:else}
    {#if latest.length}
      <h2>Dernières sorties</h2>
      <div class="shelf">{#each latest as a (entityRef(a))}<Card item={a} kind="album" />{/each}</div>
    {/if}

    {#if data.top?.length}
      <h2>Titres populaires</h2>
      <TrackList tracks={data.top.slice(0, 10)} numbered showAlbum={false} />
    {/if}

    {#if albums.length}
      <h2>Albums</h2>
      <div class="grid">{#each albums as a (entityRef(a))}<Card item={a} kind="album" />{/each}</div>
    {/if}

    {#if data.library && onDeezer === null}
      <h2>Disponible sur Deezer</h2>
      <Skeleton kind="shelf" count={5} />
    {:else if onDeezer?.length}
      <h2>Disponible sur Deezer</h2>
      <div class="grid">{#each onDeezer as a (entityRef(a))}<Card item={a} kind="album" />{/each}</div>
    {:else if deezerDown}
      <p class="muted down">Deezer est injoignable : le reste du catalogue n'est pas affiché.</p>
    {/if}

    {#if singles.length}
      <h2>Singles &amp; EP</h2>
      <div class="grid">{#each singles as a (entityRef(a))}<Card item={a} kind="album" />{/each}</div>
    {/if}

    {#if featured.length}
      <h2>Apparaît dans</h2>
      <div class="grid">{#each featured as a (entityRef(a))}<Card item={a} kind="album" />{/each}</div>
    {/if}

    {#if data.related?.length}
      <h2>Artistes similaires</h2>
      <div class="shelf">{#each data.related as a (entityRef(a))}<Card item={a} kind="artist" />{/each}</div>
    {/if}

    {#if data.bio}
      <h2>Biographie</h2>
      <p class="bio muted">{data.bio}</p>
    {/if}
    {/if}
  </div>
{/if}

<style>
  .art {
    width: 180px;
    flex: none;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    border-radius: 50%;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .kind {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  h1 {
    font-size: clamp(2rem, 6vw, 3.4rem);
  }
  .actions {
    margin: 16px 0 18px;
    gap: 18px;
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin: 4px 0 20px;
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
  .tracks-head {
    margin-bottom: 14px;
    gap: 16px;
  }
  .icon-btn {
    font-size: 1.4rem;
    color: var(--text-dim);
  }
  .icon-btn:hover {
    color: var(--text);
  }
  .icon-btn.on {
    color: var(--accent-2);
  }
  .down {
    margin: 18px 0 0;
    font-size: 0.9rem;
  }
  .bio {
    line-height: 1.6;
    max-width: 70ch;
    white-space: pre-line;
  }
  @media (max-width: 640px) {
    .art {
      width: 130px;
    }
  }
</style>

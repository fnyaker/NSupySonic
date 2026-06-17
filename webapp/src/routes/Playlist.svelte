<script>
  import { api } from "../lib/api.js";
  import { player, isAdmin } from "../lib/stores.js";
  import { toggleEntityFavorite } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Cover from "../components/Cover.svelte";
  import TrackBrowser from "../components/TrackBrowser.svelte";
  import GradientHeader from "../components/GradientHeader.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  export let params = {};

  let id = null;
  let data = null;
  let fav = false;
  let loading = true;

  $: if (params.id && params.id !== id) {
    id = params.id;
    load(id);
  }

  async function load(plId) {
    loading = true;
    data = null;
    try {
      data = await api.playlist(plId);
      fav = !!data.playlist?.is_favorite;
    } catch {
      data = null;
    }
    loading = false;
  }

  function playAll() {
    if (data?.tracks?.length) player.playQueue(data.tracks, 0, { kind: "playlist", id });
  }
  function shufflePlay() {
    if (data?.tracks?.length) player.shufflePlay(data.tracks, { kind: "playlist", id });
  }

  async function toggleFav() {
    const next = !fav;
    if (await toggleEntityFavorite("playlist", id, next)) fav = next;
  }

  $: total = (data?.tracks || []).reduce((s, t) => s + (t.duration || 0), 0);
</script>

{#if loading}
  <Skeleton kind="header" />
  <Skeleton kind="list" />
{:else if !data?.playlist}
  <p class="muted">Playlist introuvable.</p>
{:else}
  <div class="fade-in">
    <GradientHeader cover={data.playlist.cover}>
      <div class="art"><Cover src={data.playlist.cover} alt={data.playlist.title} /></div>
      <div class="meta">
        <span class="kind">Playlist</span>
        <h1>{data.playlist.title}</h1>
        {#if data.playlist.description}<p class="desc muted">{data.playlist.description}</p>{/if}
        <span class="muted">
          {data.playlist.owner ? data.playlist.owner + " · " : ""}{data.tracks.length} titres · {fmtDuration(total)}
        </span>
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={playAll}><Icon name="play" size={18} /> Lire</button>
      <button class="icon-btn" on:click={shufflePlay} aria-label="Lecture aléatoire"><Icon name="shuffle" size={22} /></button>
      {#if $isAdmin}
        <button class="icon-btn" class:on={fav} on:click={toggleFav} aria-label="Favori"><Icon name={fav ? "heartFilled" : "heart"} size={22} /></button>
      {/if}
    </div>

    <TrackBrowser tracks={data.tracks} context={{ kind: "playlist", id }} />
  </div>
{/if}

<style>
  .art {
    width: 200px;
    flex: none;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    max-width: 60ch;
  }
  .kind {
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  h1 {
    font-size: clamp(1.8rem, 5vw, 3rem);
  }
  .desc {
    margin: 0;
  }
  .actions {
    margin: 16px 0 18px;
    gap: 18px;
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
  @media (max-width: 640px) {
    .art {
      width: 150px;
    }
  }
</style>

<script>
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, toasts, isAdmin } from "../lib/stores.js";
  import { toggleEntityFavorite, downloadTracks } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Cover from "../components/Cover.svelte";
  import TrackList from "../components/TrackList.svelte";
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

  // Sequence guard: navigating quickly between albums must not let an EARLIER
  // response (delayed by the network / offline retries) overwrite the page.
  let loadSeq = 0;
  async function load(albumId) {
    const mine = ++loadSeq;
    loading = true;
    data = null;
    try {
      const r = await api.album(albumId);
      if (mine === loadSeq) {
        data = r;
        fav = !!r.album?.is_favorite; // correct heart state on open
      }
    } catch {
      if (mine === loadSeq) data = null;
    }
    if (mine === loadSeq) loading = false;
  }

  function playAll() {
    if (data?.tracks?.length) player.playQueue(data.tracks, 0, { kind: "album", id });
  }
  function shufflePlay() {
    if (data?.tracks?.length) player.shufflePlay(data.tracks, { kind: "album", id });
  }

  async function toggleFav() {
    const next = !fav;
    if (await toggleEntityFavorite("album", id, next)) fav = next;
  }

  let dlBusy = false;
  async function downloadAll() {
    if (dlBusy || !data?.tracks?.length) return;
    dlBusy = true;
    try {
      await downloadTracks(data.tracks);
    } finally {
      dlBusy = false;
    }
  }

  $: total = (data?.tracks || []).reduce((s, t) => s + (t.duration || 0), 0);
</script>

{#if loading}
  <Skeleton kind="header" />
  <Skeleton kind="list" />
{:else if !data?.album}
  <p class="muted">Album introuvable.</p>
{:else}
  <div class="fade-in">
    <GradientHeader cover={data.album.cover}>
      <div class="art"><Cover src={data.album.cover} alt={data.album.title} kind="album" eager /></div>
      <div class="meta">
        <span class="kind">Album</span>
        <h1>{data.album.title}</h1>
        <div class="sub">
          <button class="artist" on:click={() => data.album.artist && push("/artist/" + data.album.artist.deezer_id)}>
            {data.album.artist?.name}
          </button>
          <span class="muted">
            {#if data.album.year}· {data.album.year} {/if}· {data.tracks.length} titres · {fmtDuration(total)}
          </span>
        </div>
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={() => playAll()}><Icon name="play" size={18} /> Lire</button>
      <button class="icon-btn" on:click={shufflePlay} aria-label="Lecture aléatoire"><Icon name="shuffle" size={22} /></button>
      {#if $isAdmin}
        <button class="icon-btn" class:on={fav} on:click={toggleFav} aria-label="Favori"><Icon name={fav ? "heartFilled" : "heart"} size={22} /></button>
      {/if}
      <button class="icon-btn" on:click={downloadAll} disabled={dlBusy} aria-label="Télécharger l'album" title="Télécharger sur l'appareil (hors-ligne)"><Icon name="download" size={22} /></button>
    </div>

    <TrackList tracks={data.tracks} numbered showAlbum={false} showCover={false} context={{ kind: "album", id }} />
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
  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
  }
  .artist {
    font-weight: 700;
    text-align: left;
  }
  .artist:hover {
    text-decoration: underline;
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

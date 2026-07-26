<script>
  import { api } from "../lib/api.js";
  import { player } from "../lib/stores.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import Cover from "../components/Cover.svelte";
  import TrackBrowser from "../components/TrackBrowser.svelte";
  import GradientHeader from "../components/GradientHeader.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  export let params = {};

  let id = null;
  let data = null;
  let loading = true;

  $: if (params.id && params.id !== id) {
    id = params.id;
    load(id);
  }

  // Sequence guard: a delayed earlier response must not overwrite the page
  // after a quick navigation to another mix.
  let loadSeq = 0;
  async function load(mixId) {
    const mine = ++loadSeq;
    loading = true;
    data = null;
    try {
      const r = await api.smartTracklist(mixId);
      if (mine === loadSeq) data = r;
    } catch {
      if (mine === loadSeq) data = null;
    }
    if (mine === loadSeq) loading = false;
  }

  function playAll() {
    if (data?.tracks?.length) player.playQueue(data.tracks, 0, { kind: "mix", id });
  }
  function shufflePlay() {
    if (data?.tracks?.length) player.shufflePlay(data.tracks, { kind: "mix", id });
  }

  $: total = (data?.tracks || []).reduce((s, t) => s + (t.duration || 0), 0);
</script>

{#if loading}
  <Skeleton kind="header" />
  <Skeleton kind="list" />
{:else if !data?.playlist}
  <p class="muted">Mix introuvable.</p>
{:else}
  <div class="fade-in">
    <GradientHeader cover={data.playlist.cover}>
      <div class="art"><Cover src={data.playlist.cover} alt={data.playlist.title} kind="mix" eager /></div>
      <div class="meta">
        <span class="kind">Mix</span>
        <h1>{data.playlist.title}</h1>
        {#if data.playlist.description}<p class="desc muted">{data.playlist.description}</p>{/if}
        <span class="muted">{data.tracks.length} titres · {fmtDuration(total)}</span>
      </div>
    </GradientHeader>

    <div class="row actions">
      <button class="pill" on:click={playAll}><Icon name="play" size={18} /> Lire</button>
      <button class="icon-btn" on:click={shufflePlay} aria-label="Lecture aléatoire"><Icon name="shuffle" /></button>
    </div>

    <TrackBrowser tracks={data.tracks} context={{ kind: "mix", id }} />
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
  .pill {
    gap: 8px;
  }
  .icon-btn {
    color: var(--text-dim);
  }
  .icon-btn:hover {
    color: var(--text);
  }
  @media (max-width: 640px) {
    .art {
      width: 150px;
    }
  }
</style>

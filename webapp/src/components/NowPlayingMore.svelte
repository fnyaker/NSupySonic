<script>
  import { entityRef, trackEntityRef } from "../lib/entity.js";
  // What lives under the full-screen player: the credits of the track, the
  // artist behind it and — last, because it is the long one — tracks that sound
  // like it. On the phone it is what a swipe up from
  // the player reveals; on the desktop it is a tab beside the queue.
  //
  // The similar tracks are Deezer's own mix for the track (the same call the
  // radio uses) — until we can compute them from our own analysis; the panel
  // only asks for a list of tracks, so that swap is one call.
  import { trackKey, trackRef } from "../lib/trackkey.js";
  import { onMount, onDestroy } from "svelte";
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, immersiveOpen, toasts } from "../lib/stores.js";
  import { compactNumber } from "../lib/format.js";
  import Card from "./Card.svelte";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import TrackCredits from "./TrackCredits.svelte";
  import TrackList from "./TrackList.svelte";

  export let track = null;

  // What the mix and the credits are asked by: the row's id (a request names a
  // track by trackRef). An episode has neither.
  $: id = track && !track.podcast ? trackRef(track) : null;
  $: artistId = track && !track.podcast ? trackEntityRef(track, "artist", track.artist) || null : null;

  let similar = null; // null = loading
  let similarFailed = false;
  let about = null;
  let credits = null; // { credits: [{role, label, people}], info } — null until known
  let seqS = 0;
  let seqA = 0;
  let seqC = 0;
  const memo = new Map(); // track id -> similar tracks, for the moment the panel is reopened

  $: loadSimilar(id);
  $: loadAbout(artistId);
  // A string, on purpose: `track` is the store's object, handed over again on
  // every progress tick, and a reactive statement reading it would ask again
  // four times a second. A string only changes when the track does.
  $: cid = track && !track.podcast ? trackRef(track) : null;
  $: loadCredits(cid);

  // Who wrote it, composed it, produced it. Best-effort: with nothing to show
  // the section is simply not there.
  async function loadCredits(tid) {
    const mine = ++seqC;
    credits = null;
    if (!tid) return;
    try {
      const d = await api.swr("/track/" + tid + "/credits", (c) => {
        if (mine === seqC) credits = c;
      });
      if (mine === seqC) credits = d;
    } catch {
      /* nothing to show */
    }
  }

  async function loadSimilar(tid) {
    const mine = ++seqS;
    similarFailed = false;
    if (!tid) {
      similar = [];
      return;
    }
    if (memo.has(tid)) {
      similar = memo.get(tid);
      return;
    }
    similar = null;
    try {
      const r = await api.trackRadio(tid);
      if (mine !== seqS) return;
      similar = (r.tracks || []).filter((t) => trackKey(t) !== trackKey(track));
      if (similar.length) {
        if (memo.size > 30) memo.clear();
        memo.set(tid, similar);
      }
    } catch {
      if (mine === seqS) {
        similar = [];
        similarFailed = true;
      }
    }
  }

  async function loadAbout(aid) {
    const mine = ++seqA;
    if (!aid) {
      about = null;
      return;
    }
    // The page's copy first (it may be in the offline cache), then the fresh one.
    try {
      await api.swr("/artist/" + aid, (d) => {
        if (mine === seqA) about = d;
      });
    } catch {
      /* the card just does not appear */
    }
  }

  function playAll() {
    if (!similar?.length) return;
    player.playQueue(similar, 0, { kind: "similar", id });
  }
  function queueAll() {
    if (!similar?.length) return;
    player.addToQueue(similar);
  }
  function retry() {
    loadSimilar(id);
  }

  // Following a link from in here (a card, a row's menu) leaves the player.
  const away = () => immersiveOpen.set(false);
  onMount(() => window.addEventListener("hashchange", away));
  onDestroy(() => window.removeEventListener("hashchange", away));

  $: top = about?.top?.slice(0, 5) || [];
  $: related = about?.related || [];
</script>

<div class="more">
  {#if !id && !artistId && !credits?.credits?.length}
    <p class="muted empty">Rien à afficher pour ce titre : les crédits et les titres similaires viennent de Deezer.</p>
  {/if}

  {#if credits && (credits.credits?.length || Object.keys(credits.info || {}).length)}
    <h3 class="first">Crédits</h3>
    <TrackCredits data={credits} />
  {/if}

  {#if about && about.artist}
    <h3 class="sec">À propos de l'artiste</h3>
    <button class="artist" on:click={() => push("/artist/" + entityRef(about.artist))}>
      <span class="pic"><Cover src={about.artist.picture} alt={about.artist.name} kind="artist" round /></span>
      <span class="ameta">
        <span class="aname">{about.artist.name}</span>
        {#if about.artist.nb_fan}<span class="muted">{compactNumber(about.artist.nb_fan)} fans</span>{/if}
      </span>
      <Icon name="chevronRight" size={18} />
    </button>
    {#if top.length}
      <h4>Titres populaires</h4>
      <TrackList tracks={top} numbered showAlbum={false} context={{ kind: "artist", id: entityRef(about.artist) }} />
    {/if}
    {#if related.length}
      <h4>Artistes similaires</h4>
      <div class="shelf">{#each related as a (entityRef(a))}<Card item={a} kind="artist" />{/each}</div>
    {/if}
  {/if}

  {#if id}
    <div class="head sec">
      <h3>Titres similaires</h3>
      {#if similar?.length}
        <div class="acts">
          <button class="pill" on:click={playAll}><Icon name="play" size={15} /> Tout lire</button>
          <button class="ghost" on:click={queueAll} aria-label="Ajouter à la file"><Icon name="queue" size={17} /></button>
        </div>
      {/if}
    </div>
    {#if similar === null}
      <p class="muted status">Recherche de titres qui vont bien avec celui-ci…</p>
    {:else if similar.length}
      <TrackList tracks={similar} numbered context={{ kind: "similar", id }} showAlbum={false} />
    {:else}
      <p class="muted status">
        {similarFailed ? "Deezer ne répond pas pour le moment." : "Aucun titre similaire trouvé."}
        {#if similarFailed}<button class="link" on:click={retry}>Réessayer</button>{/if}
      </p>
    {/if}
  {/if}
</div>

<style>
  .more {
    padding: 4px 0 24px;
    color: #fff;
    /* the credits on the player's dark glass */
    --tc-dim: rgba(255, 255, 255, 0.55);
    --tc-line: rgba(255, 255, 255, 0.12);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }
  h3 {
    margin: 12px 0 8px;
    font-size: 1.05rem;
  }
  .head h3 {
    margin: 0;
  }
  .sec {
    margin-top: 28px;
  }
  .head.sec {
    margin-bottom: 6px;
  }
  h3.first {
    margin-top: 6px;
  }
  h4 {
    margin: 18px 0 8px;
    font-size: 0.78rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.6);
  }
  .acts {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    font-size: 0.82rem;
    font-weight: 700;
    border-radius: 999px;
    color: #fff;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  .ghost {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }
  .status,
  .empty {
    margin: 14px 2px;
    line-height: 1.5;
  }
  .link {
    margin-left: 6px;
    color: var(--accent);
    font-weight: 700;
  }
  .artist {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 10px;
    border-radius: 14px;
    text-align: left;
    color: inherit;
    background: rgba(255, 255, 255, 0.07);
  }
  .artist:hover {
    background: rgba(255, 255, 255, 0.11);
  }
  .pic {
    width: 64px;
    height: 64px;
    flex: none;
  }
  .ameta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .aname {
    font-weight: 800;
    font-size: 1.05rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

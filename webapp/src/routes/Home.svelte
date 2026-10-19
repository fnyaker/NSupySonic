<script>
  import { onMount } from "svelte";
  import { REMOTE, CAN_KEEP, CAN_ADMIN, CAN_BROWSE } from "../lib/remote/mode.js";
  import { api } from "../lib/api.js";
  import { player, recent, isAdmin } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";
  import FlowTuner from "../components/FlowTuner.svelte";

  // The home is the library's own answer (/api/home): no call to Deezer, so
  // it opens as fast as the disk and reads the same offline.
  let mixes = [];
  let shelves = { recent: [], popular: [], forgotten: [] };
  let flowLoading = false;
  let loading = true;
  let tuner = false;

  // An album card opens /album/<id>; until the album screen reads a row's own
  // id, a Deezer album is addressed by its Deezer id and only one without
  // keeps the UUID.
  const cards = (list) =>
    (list || []).map((a) => (a.deezer_id ? { ...a, id: undefined } : a));
  const cardKey = (a) => a.id || a.deezer_id;

  $: greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "Bonne nuit";
    if (h < 12) return "Bonjour";
    if (h < 18) return "Bon après-midi";
    return "Bonsoir";
  })();

  // Recently played, collapsed to unique albums (cards, not a track dump).
  $: recentAlbums = (() => {
    const seen = new Set();
    const out = [];
    for (const t of $recent) {
      const a = t.album;
      if (!a || !a.deezer_id || seen.has(a.deezer_id)) continue;
      seen.add(a.deezer_id);
      out.push({ deezer_id: a.deezer_id, title: a.title, cover: a.cover, artist: t.artist });
      if (out.length >= 12) break;
    }
    return out;
  })();

  function take(d) {
    mixes = d.mixes || [];
    shelves = {
      recent: cards(d.recent),
      popular: cards(d.popular),
      forgotten: cards(d.forgotten),
    };
    loading = false;
  }

  onMount(async () => {
    // Stale-while-revalidate: the shelves paint from the last-seen copy right
    // away and quietly correct themselves.
    try {
      take(await api.swr("/home", take));
    } catch {
      loading = false;
    }
  });

  async function playFlow() {
    flowLoading = true;
    try {
      const r = await api.flow();
      player.playQueue(r.tracks, 0, { kind: "flow" });
    } catch {
      /* ignore */
    } finally {
      flowLoading = false;
    }
  }
</script>

<div class="hero fade-in">
  <div>
    <h1>{greeting}</h1>
    <p class="muted">
      Vos mixes, vos nouveautés et ce que vous aimez réécouter, depuis votre bibliothèque.
    </p>
  </div>
  <div class="flow-actions">
    <button class="pill" on:click={playFlow} disabled={flowLoading}>
      <Icon name="play" size={18} /> Lancer mon Flow
    </button>
    {#if $isAdmin && CAN_KEEP}
      <button class="pill ghost" on:click={() => (tuner = true)}>
        <Icon name="sliders" size={16} /> Personnaliser
      </button>
    {/if}
  </div>
</div>

{#if tuner && $isAdmin && CAN_KEEP}
  <FlowTuner onClose={() => (tuner = false)} />
{/if}

{#if loading}
  <Skeleton kind="shelf" />
  <Skeleton kind="shelf" />
{:else}
  {#if mixes.length}
    <h2>Des mixes créés pour vous</h2>
    <div class="grid">
      {#each mixes as m (m.id)}<Card item={{ ...m, deezer_id: m.id }} kind="mix" />{/each}
    </div>
  {/if}

  {#if shelves.recent.length}
    <h2>Ajoutés récemment</h2>
    <div class="shelf">
      {#each shelves.recent as a (cardKey(a))}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if recentAlbums.length}
    <h2>Écoutés récemment</h2>
    <div class="shelf">
      {#each recentAlbums as a (a.deezer_id)}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if shelves.popular.length}
    <h2>Vos plus écoutés</h2>
    <div class="shelf">
      {#each shelves.popular as a (cardKey(a))}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if shelves.forgotten.length}
    <h2>À réécouter</h2>
    <div class="shelf">
      {#each shelves.forgotten as a (cardKey(a))}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if !mixes.length && !shelves.recent.length && !recentAlbums.length}
    <p class="muted guest-hint">
      Votre bibliothèque est vide pour l'instant : utilisez la recherche pour trouver de la
      musique, puis lancez la lecture. Elle s'ajoutera ici au fil de vos écoutes.
    </p>
  {/if}
{/if}

<style>
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 8px;
  }
  .hero p {
    margin: 0;
  }
  .flow-actions {
    display: flex;
    gap: 10px;
    flex: none;
  }
  .guest-hint {
    margin-top: 28px;
  }
  .pill {
    gap: 8px;
  }
  @media (max-width: 640px) {
    .hero {
      flex-direction: column;
      align-items: flex-start;
    }
    .flow-actions {
      flex-wrap: wrap;
    }
  }
</style>

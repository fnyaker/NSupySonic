<script>
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { entityRef, trackEntityRef } from "../lib/entity.js";
  import { player, recent } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";

  // The home is the library's own answer (/api/home): no call to Deezer, so
  // it opens as fast as the disk and reads the same offline.
  let mixes = [];
  let shelves = { recent: [], popular: [], forgotten: [] };
  let flowLoading = false;
  let loading = true;

  // An album card opens /album/<id>, by the row's own id.
  const cards = (list) => list || [];
  const cardKey = (a) => entityRef(a);

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
      const ref = trackEntityRef(t, "album", a);
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ id: ref, deezer_id: a.deezer_id, title: a.title, cover: a.cover, artist: t.artist });
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
  </div>
</div>

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
      {#each recentAlbums as a (entityRef(a))}<Card item={a} kind="album" />{/each}
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

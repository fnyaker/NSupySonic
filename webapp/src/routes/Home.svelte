<script>
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { player, recent, isAdmin } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";
  import FlowTuner from "../components/FlowTuner.svelte";

  let mixes = [];
  let reco = { albums: [], artists: [], playlists: [] };
  let flowLoading = false;
  let loading = true;
  let tuner = false;

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

  onMount(async () => {
    // Personalized Deezer discovery is the account owner's; guests just browse.
    if (!$isAdmin) {
      loading = false;
      return;
    }
    // Stale-while-revalidate: the home shelves paint from the last-seen copy
    // right away and quietly correct themselves — both of these calls go out to
    // Deezer server-side, so waiting on them is seconds of empty page.
    const [h, r] = await Promise.allSettled([
      api.swr("/home", (d) => {
        mixes = d.mixes || [];
        loading = false;
      }),
      api.swr("/recommendations", (d) => {
        reco = d;
        loading = false;
      }),
    ]);
    if (h.status === "fulfilled") mixes = h.value.mixes || [];
    if (r.status === "fulfilled") reco = r.value;
    loading = false;
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
      {$isAdmin ? "Vos mixes, vos nouveautés et vos recommandations." : "Cherchez un artiste, un album ou un titre pour commencer."}
    </p>
  </div>
  {#if $isAdmin}
    <div class="flow-actions">
      <button class="pill" on:click={playFlow} disabled={flowLoading}>
        <Icon name="play" size={18} /> Lancer mon Flow
      </button>
      <button class="pill ghost" on:click={() => (tuner = true)}>
        <Icon name="sliders" size={16} /> Personnaliser
      </button>
    </div>
  {/if}
</div>

{#if tuner && $isAdmin}
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

  {#if reco.playlists?.length}
    <h2>Playlists pour vous</h2>
    <div class="shelf">
      {#each reco.playlists as p (p.deezer_id)}<Card item={p} kind="playlist" />{/each}
    </div>
  {/if}

  {#if recentAlbums.length}
    <h2>Écoutés récemment</h2>
    <div class="shelf">
      {#each recentAlbums as a (a.deezer_id)}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if reco.albums?.length}
    <h2>Albums pour vous</h2>
    <div class="shelf">
      {#each reco.albums as a (a.deezer_id)}<Card item={a} kind="album" />{/each}
    </div>
  {/if}

  {#if reco.artists?.length}
    <h2>Artistes à découvrir</h2>
    <div class="shelf">
      {#each reco.artists as a (a.deezer_id)}<Card item={a} kind="artist" />{/each}
    </div>
  {/if}

  {#if !$isAdmin && !recentAlbums.length}
    <p class="muted guest-hint">
      Utilisez la recherche pour trouver de la musique, puis lancez la lecture.
      Vos favoris et fichiers importés sont dans « Ma bibliothèque ».
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

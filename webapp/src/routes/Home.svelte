<script>
  import { onMount } from "svelte";
  import { REMOTE, CAN_KEEP, CAN_ADMIN, CAN_BROWSE } from "../lib/remote/mode.js";
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
  // "Pour vous": mixes built from the library's own genre / tempo / artist
  // verdicts and this listener's stars. Different on every visit.
  let forYou = [];
  async function loadForYou() {
    try {
      forYou = (await api.recommendationsLibrary()).mixes || [];
    } catch {
      forYou = [];
    }
  }

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
    loadForYou();
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
      {#if CAN_KEEP}
        <button class="pill ghost" on:click={() => (tuner = true)}>
          <Icon name="sliders" size={16} /> Personnaliser
        </button>
      {/if}
    </div>
  {/if}
</div>

{#if tuner && $isAdmin && CAN_KEEP}
  <FlowTuner onClose={() => (tuner = false)} />
{/if}

{#if loading}
  <Skeleton kind="shelf" />
  <Skeleton kind="shelf" />
{:else}
  {#if forYou.length}
    <h2>Pour vous</h2>
    <div class="foryou">
      {#each forYou as m (m.id)}
        <button class="fy" on:click={() => player.playQueue(m.tracks, 0, { kind: "mix", id: m.id })}>
          <span class="fy-t">{m.title}</span>
          <span class="fy-s">{m.subtitle}</span>
          <span class="fy-p"><Icon name="play" size={16} /></span>
        </button>
      {/each}
    </div>
  {/if}

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
  .foryou { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-bottom: 8px; }
  .fy {
    position: relative; display: grid; align-content: end; gap: 3px; min-height: 120px; padding: 16px;
    border: 0; border-radius: 16px; text-align: left; color: #fff; font: inherit; cursor: pointer;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
  }
  .fy:nth-child(2) { background: linear-gradient(135deg, #0ea5e9, var(--accent)); }
  .fy:nth-child(3) { background: linear-gradient(135deg, #10b981, #0ea5e9); }
  .fy:nth-child(4) { background: linear-gradient(135deg, #f59e0b, var(--accent-2)); }
  .fy-t { font-weight: 800; font-size: 1.1rem; letter-spacing: -0.01em; }
  .fy-s { font-size: 0.8rem; opacity: 0.85; }
  .fy-p { position: absolute; top: 12px; right: 12px; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: rgba(0,0,0,0.3); }

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

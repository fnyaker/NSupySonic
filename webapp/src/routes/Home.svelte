<script>
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { entityRef, trackEntityRef } from "../lib/entity.js";
  import { player, recent } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";
  import TrackList from "../components/TrackList.svelte";
  import DiscoverySlider from "../components/DiscoverySlider.svelte";
  import { discoveryLevel, loadDiscovery, onDiscoverySettled } from "../lib/discovery.js";
  import { get } from "svelte/store";

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

  // "Pour vous": titles, albums and artists at the person's discovery level,
  // and the releases of their favourite artists (and of a few very close to
  // them). Both are the server's reading of the database: no provider is asked.
  let reco = null;
  let recoLoading = false;
  let seed = "";
  let releases = [];
  let unseen = 0;

  async function loadReco(level) {
    recoLoading = true;
    try {
      reco = await api.recommend(level, seed);
    } catch {
      /* the rows simply stay as they were */
    } finally {
      recoLoading = false;
    }
  }

  function refreshReco() {
    seed = String(Date.now() % 1e9);
    loadReco(get(discoveryLevel));
  }

  onMount(() => {
    // Stale-while-revalidate: the shelves paint from the last-seen copy right
    // away and quietly correct themselves.
    api
      .swr("/home", take)
      .then(take)
      .catch(() => (loading = false));
    loadDiscovery().then((lv) => loadReco(lv));
    api
      .swr("/releases", (d) => ((releases = d.releases || []), (unseen = d.unseen || 0)))
      .then((d) => {
        releases = d.releases || [];
        unseen = d.unseen || 0;
      })
      .catch(() => {});
    return onDiscoverySettled((lv) => loadReco(lv));
  });

  async function playFlow() {
    flowLoading = true;
    try {
      const r = await api.flow(get(discoveryLevel));
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
<div class="flow-tune">
  <DiscoverySlider />
</div>

{#if releases.length}
  <div class="row-head">
    <h2>
      Nouveautés
      {#if unseen}<span class="badge" aria-label="{unseen} nouvelles sorties">{unseen}</span>{/if}
    </h2>
    <a class="more" href="#/releases">Tout afficher</a>
  </div>
  <div class="shelf">
    {#each releases.slice(0, 12) as a (a.deezer_id)}<Card item={a} kind="album" />{/each}
  </div>
{/if}

{#if reco && (reco.tracks?.length || reco.albums?.length || reco.artists?.length)}
  <div class="row-head">
    <h2>Pour vous</h2>
    <button class="ghost-btn" on:click={refreshReco} disabled={recoLoading} aria-label="Autres suggestions">
      <Icon name="refresh" size={16} /> Autres suggestions
    </button>
  </div>
  <div class="reco" class:dim={recoLoading}>
    {#if reco.tracks?.length}
      <h3>Titres à découvrir</h3>
      <TrackList tracks={reco.tracks.slice(0, 8)} context={{ kind: "reco" }} />
    {/if}
    {#if reco.albums?.length}
      <h3>Albums pour vous</h3>
      <div class="shelf">
        {#each reco.albums as a (entityRef(a))}<Card item={a} kind="album" />{/each}
      </div>
    {/if}
    {#if reco.artists?.length}
      <h3>Artistes à découvrir</h3>
      <div class="shelf">
        {#each reco.artists as a (entityRef(a))}<Card item={a} kind="artist" />{/each}
      </div>
    {/if}
  </div>
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
  .flow-tune {
    margin: 18px 0 8px;
  }
  .row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .row-head h2 {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .badge {
    min-width: 22px;
    height: 22px;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .more {
    color: var(--text-dim);
    font-size: 0.88rem;
    font-weight: 600;
    padding: 10px 4px;
  }
  .more:hover {
    color: var(--text);
  }
  .ghost-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--bg-hover);
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 600;
  }
  .ghost-btn:disabled {
    opacity: 0.6;
  }
  .reco h3 {
    margin: 18px 0 8px;
    font-size: 1rem;
    color: var(--text-dim);
    font-weight: 600;
  }
  .reco {
    transition: opacity 0.2s ease;
  }
  .reco.dim {
    opacity: 0.55;
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

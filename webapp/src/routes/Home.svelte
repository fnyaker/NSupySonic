<script>
  // The home, rebuilt from the design in /mnt/project-files/ui/refonte-navigation.md.
  //
  // Every row answers "what can I play right now?" in ONE tap: new titles and
  // suggestions are rows of titles (a tap plays that title, then its radio),
  // the artists are portraits that open their page, and only collections
  // (recently played, mixes) are tiles to open. Each section paints from the
  // last copy this device saw, then quietly corrects itself; none waits on a
  // provider (every route here reads the server's database).
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { entityRef, trackEntityRef } from "../lib/entity.js";
  import { player, recent } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import Cover from "../components/Cover.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Icon from "../components/Icon.svelte";
  import TrackList from "../components/TrackList.svelte";
  import ArtistTile from "../components/ArtistTile.svelte";
  import DiscoverySlider from "../components/DiscoverySlider.svelte";
  import { discoveryLevel, loadDiscovery, onDiscoverySettled, stepOf } from "../lib/discovery.js";

  const NEW_ROWS = 6;
  const RECO_ROWS = 6;
  const ARTISTS_SHOWN = 16;

  $: greeting = (() => {
    const h = new Date().getHours();
    if (h < 6) return "Bonne nuit";
    if (h < 12) return "Bonjour";
    if (h < 18) return "Bon après-midi";
    return "Bonsoir";
  })();

  // -- new releases: their TITLES --------------------------------------------
  let newTracks = [];
  let unseen = 0;
  let releasesLoaded = false;
  function takeReleases(d) {
    newTracks = d.tracks || [];
    unseen = d.unseen || 0;
    releasesLoaded = true;
  }
  // On the home, one title per release (its first: the single itself, an
  // album's opener), newest release first: six releases at a glance rather
  // than six titles of the same album. The page behind "Tout afficher" lists
  // every title.
  $: newShown = (() => {
    const seen = new Set();
    const out = [];
    for (const t of newTracks) {
      const r = t.release?.deezer_id || t.album?.deezer_id || t.deezer_id;
      if (seen.has(r)) continue;
      seen.add(r);
      out.push(t);
      if (out.length >= NEW_ROWS) break;
    }
    return out;
  })();
  function playAllNew() {
    if (newTracks.length) player.playQueue(newTracks, 0, { kind: "releases" });
  }

  // -- favourite artists ------------------------------------------------------
  let artists = [];
  let artistsLoaded = false;

  // -- for you ----------------------------------------------------------------
  let reco = null;
  let recoLoading = false;
  async function loadReco(level, seed = "") {
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
    loadReco(get(discoveryLevel), String(Date.now() % 1e9));
  }

  // -- recently played: the collections the last titles came from ------------
  $: recentAlbums = (() => {
    const seen = new Set();
    const out = [];
    for (const t of $recent) {
      const a = t.album;
      const ref = trackEntityRef(t, "album", a);
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, title: a.title, cover: a.cover, artist: t.artist?.name || "", track: t });
      if (out.length >= 8) break;
    }
    return out;
  })();

  // -- mixes ------------------------------------------------------------------
  let mixes = [];
  let homeLoaded = false;

  // The discovery level is set once in a while, not on every visit: the
  // control is one chip that opens it (progressive disclosure, NN/g), not a
  // panel taking the top of the home.
  let tuneOpen = false;
  $: step = stepOf($discoveryLevel);

  let flowLoading = false;
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

  onMount(() => {
    // All four at once, each painting from its cached copy first.
    api
      .swr("/releases", takeReleases)
      .catch(() => (releasesLoaded = true));
    api
      .swr("/me/artists", (d) => ((artists = d.artists || []), (artistsLoaded = true)))
      .catch(() => (artistsLoaded = true));
    api
      .swr("/home", (d) => ((mixes = d.mixes || []), (homeLoaded = true)))
      .catch(() => (homeLoaded = true));
    loadDiscovery().then((lv) => {
      const path = "/recommend?d=" + encodeURIComponent(Number(lv).toFixed(2));
      api.swr(path, (d) => (reco = d)).catch(() => {});
    });
    return onDiscoverySettled((lv) => loadReco(lv));
  });

  $: everythingLoaded = releasesLoaded && artistsLoaded && homeLoaded;
  $: empty =
    everythingLoaded &&
    !newShown.length &&
    !artists.length &&
    !reco?.tracks?.length &&
    !recentAlbums.length &&
    !mixes.length;
</script>

<header class="hero fade-in">
  <h1>{greeting}</h1>
  <div class="flow">
    <button class="pill" on:click={playFlow} disabled={flowLoading}>
      <Icon name="play" size={18} /> Lancer mon Flow
    </button>
    <button
      class="tune"
      class:open={tuneOpen}
      aria-expanded={tuneOpen}
      on:click={() => (tuneOpen = !tuneOpen)}
      title="Régler la découverte du Flow et des suggestions"
    >
      <Icon name="sliders" size={15} /> {step.name}
    </button>
  </div>
</header>
{#if tuneOpen}
  <div class="flow-tune">
    <DiscoverySlider />
  </div>
{/if}

{#if newShown.length}
  <section>
    <div class="row-head">
      <h2>
        Nouveautés
        {#if unseen}<span class="badge" aria-label="{unseen} nouvelles sorties">{unseen}</span>{/if}
      </h2>
      <div class="actions">
        <button class="ghost-btn" on:click={playAllNew} aria-label="Lire toutes les nouveautés">
          <Icon name="play" size={15} /> <span class="lbl">Tout lire</span>
        </button>
        <a class="more" href="#/releases">Tout afficher</a>
      </div>
    </div>
    <TrackList tracks={newShown} radio context={{ kind: "releases" }} />
  </section>
{:else if !releasesLoaded}
  <Skeleton kind="list" />
{/if}

{#if artists.length}
  <section>
    <div class="row-head">
      <h2>Tes artistes</h2>
      <a class="more" href="#/library/artists">Tout afficher</a>
    </div>
    <div class="shelf artists">
      {#each artists.slice(0, ARTISTS_SHOWN) as a (a.id)}<ArtistTile artist={a} />{/each}
    </div>
  </section>
{/if}

{#if reco?.tracks?.length}
  <section>
    <div class="row-head">
      <h2>Pour toi</h2>
      <button class="ghost-btn" on:click={refreshReco} disabled={recoLoading} aria-label="Autres suggestions">
        <Icon name="refresh" size={15} /> Autres suggestions
      </button>
    </div>
    <div class="reco" class:dim={recoLoading}>
      <TrackList tracks={reco.tracks.slice(0, RECO_ROWS)} radio context={{ kind: "reco" }} />
    </div>
  </section>
{/if}

{#if recentAlbums.length}
  <section>
    <h2>Écoutés récemment</h2>
    <div class="shortcuts">
      {#each recentAlbums as a (a.ref)}
        <button class="shortcut" on:click={() => push("/album/" + a.ref)} title={a.title}>
          <span class="sc-cover"><Cover src={a.cover} alt={a.title} kind="album" /></span>
          <span class="sc-txt">
            <span class="sc-title">{a.title}</span>
            <span class="sc-sub muted">{a.artist}</span>
          </span>
        </button>
      {/each}
    </div>
  </section>
{/if}

{#if mixes.length}
  <section>
    <h2>Tes mixes</h2>
    <div class="shelf">
      {#each mixes as m (m.id)}<Card item={{ ...m, deezer_id: m.id }} kind="mix" />{/each}
    </div>
  </section>
{:else if !homeLoaded}
  <Skeleton kind="shelf" />
{/if}

{#if empty}
  <p class="muted guest-hint">
    Ta bibliothèque est vide pour l'instant : cherche un titre ou un artiste et lance la lecture.
    Ajoute des artistes à tes favoris pour voir ici leurs nouveautés.
  </p>
{/if}

<style>
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .hero h1 {
    margin: 0;
  }
  .pill {
    gap: 8px;
  }
  .flow {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .tune {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 44px;
    padding: 0 16px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.88rem;
  }
  .tune:hover,
  .tune.open {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .flow-tune {
    margin: 14px 0 4px;
    display: flex;
    justify-content: flex-end;
  }
  section {
    margin-top: 28px;
  }
  section h2 {
    margin: 0 0 10px;
  }
  .row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }
  .row-head h2 {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
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
    font-size: 0.86rem;
    font-weight: 700;
    padding: 10px 6px;
    white-space: nowrap;
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
    white-space: nowrap;
  }
  .ghost-btn:disabled {
    opacity: 0.6;
  }
  .reco {
    transition: opacity 0.2s ease;
  }
  .reco.dim {
    opacity: 0.55;
  }
  .shelf.artists {
    grid-auto-columns: 132px;
    gap: 6px;
  }
  /* Recently played: compact shortcuts, two columns on a phone, four on a
     desktop — a cover and a name, the whole tile the target. */
  .shortcuts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 8px;
  }
  .shortcut {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 0 12px 0 0;
    border-radius: 8px;
    background: var(--bg-card);
    color: var(--text);
    text-align: left;
    overflow: hidden;
    transition: background 0.12s ease;
  }
  .shortcut:hover,
  .shortcut:focus-visible {
    background: var(--bg-hover);
  }
  .sc-cover {
    flex: none;
    width: 56px;
    height: 56px;
  }
  .sc-txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 2px;
  }
  .sc-title,
  .sc-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sc-title {
    font-weight: 700;
    font-size: 0.9rem;
  }
  .sc-sub {
    font-size: 0.8rem;
  }
  .guest-hint {
    margin-top: 28px;
  }
  @media (max-width: 640px) {
    .actions .ghost-btn {
      padding: 8px 12px;
    }
    .actions .lbl {
      display: none;
    }
    .flow-tune {
      justify-content: stretch;
    }
    .shortcuts {
      grid-template-columns: 1fr 1fr;
    }
    .shortcut {
      gap: 8px;
      padding-right: 8px;
    }
    .sc-cover {
      width: 48px;
      height: 48px;
    }
    .shelf.artists {
      grid-auto-columns: 112px;
    }
  }
</style>

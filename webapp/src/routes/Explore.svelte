<script>
  // Explore: what is charting, by genre and by country, and the new releases —
  // Deezer's shop window, for when you do not know what you want to hear.
  //
  // One component for two routes (`/explore` and `/explore/:genre`), so going
  // from the front page into a genre and back is the same screen changing what
  // it shows — and the back button lands on the page you left, scroll included
  // (lib/nav.js).
  import { push } from "svelte-spa-router";
  import { api } from "../lib/api.js";
  import { player, isAdmin } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import Cover from "../components/Cover.svelte";
  import Icon from "../components/Icon.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import TrackList from "../components/TrackList.svelte";

  export let params = {};

  $: gid = params && params.genre ? String(params.genre) : null;

  let data = null; // null = nothing yet; an object (possibly empty) = an answer
  let countries = [];
  let failed = false;
  let seq = 0;

  $: load(gid);

  function load(id) {
    const mine = ++seq;
    data = null;
    failed = false;
    if (!$isAdmin) {
      data = {};
      return;
    }
    const path = id ? "/explore/genre/" + id : "/explore";
    // Stale-while-revalidate: the last copy paints at once and corrects itself.
    api
      .swr(path, (d) => {
        if (mine === seq) data = d;
      })
      .then(
        (d) => {
          if (mine === seq) data = d;
        },
        () => {
          if (mine === seq && data === null) failed = true;
        }
      );
    if (!id) {
      api
        .swr("/explore/countries", (d) => {
          if (mine === seq) countries = d.playlists || [];
        })
        .catch(() => {});
    }
  }

  $: tracks = (data && data.tracks) || [];
  $: empty =
    data &&
    !tracks.length &&
    !(data.albums || []).length &&
    !(data.artists || []).length &&
    !(data.playlists || []).length &&
    !(data.genres || []).length;

  // A colour per genre, stable across visits: the tiles are the page's palette.
  const hue = (id) => (Number(id) * 47) % 360;

  function playChart(shuffle) {
    if (!tracks.length) return;
    const ctx = { kind: "chart", id: gid || "0", title: gid ? data.genre?.name || "Classement" : "Top mondial" };
    if (shuffle) player.shufflePlay(tracks, ctx);
    else player.playQueue(tracks, 0, ctx);
  }
</script>

{#if gid}
  <button class="back muted" on:click={() => push("/explore")}>
    <Icon name="chevronLeft" size={16} /> Explorer
  </button>
{/if}

<div class="hero fade-in">
  <div>
    <h1>{gid ? data?.genre?.name || "Genre" : "Explorer"}</h1>
    <p class="muted">
      {gid ? "Ce qui monte dans ce genre." : "Les classements, les genres et les nouveautés du moment."}
    </p>
  </div>
  {#if tracks.length}
    <div class="actions">
      <button class="pill" on:click={() => playChart(false)}><Icon name="play" size={18} /> Lire le top {tracks.length}</button>
      <button class="pill ghost" on:click={() => playChart(true)}><Icon name="shuffle" size={16} /> Aléatoire</button>
    </div>
  {/if}
</div>

{#if data === null && !failed}
  <Skeleton kind="shelf" />
  <Skeleton kind="shelf" />
{:else if failed || empty || !$isAdmin}
  <p class="muted note">
    {$isAdmin
      ? "Deezer ne répond pas pour le moment : les classements reviendront dès qu'il sera joignable. Votre bibliothèque téléchargée reste disponible."
      : "Explorer s'appuie sur le compte Deezer de l'administrateur."}
  </p>
{:else}
  {#if !gid && data.genres?.length}
    <h2>Genres</h2>
    <div class="genres">
      {#each data.genres as g (g.deezer_id)}
        <a
          class="tile"
          href={"#/explore/" + g.deezer_id}
          style="--h:{hue(g.deezer_id)}"
          aria-label={g.name}
        >
          <span class="name">{g.name}</span>
          <span class="pic"><Cover src={g.picture} alt="" kind="album" /></span>
        </a>
      {/each}
    </div>
  {/if}

  {#if tracks.length}
    <h2>{gid ? "Top titres" : "Top titres du moment"}</h2>
    <TrackList tracks={gid ? tracks : tracks.slice(0, 10)} numbered context={{ kind: "chart", id: gid || "0" }} />
    {#if !gid && tracks.length > 10}
      <button class="more" on:click={() => playChart(false)}>Lire les {tracks.length} titres</button>
    {/if}
  {/if}

  {#if !gid && data.releases?.length}
    <h2>Nouveautés</h2>
    <div class="shelf">{#each data.releases as a (a.deezer_id)}<Card item={a} kind="album" />{/each}</div>
  {/if}

  {#if data.albums?.length}
    <h2>Albums du moment</h2>
    <div class="shelf">{#each data.albums as a (a.deezer_id)}<Card item={a} kind="album" />{/each}</div>
  {/if}

  {#if data.artists?.length}
    <h2>Artistes en vogue</h2>
    <div class="shelf">{#each data.artists as a (a.deezer_id)}<Card item={a} kind="artist" />{/each}</div>
  {/if}

  {#if data.playlists?.length}
    <h2>Playlists populaires</h2>
    <div class="shelf">{#each data.playlists as p (p.deezer_id)}<Card item={p} kind="playlist" />{/each}</div>
  {/if}

  {#if !gid && countries.length}
    <h2>Classements par pays</h2>
    <div class="shelf">{#each countries as p (p.deezer_id)}<Card item={p} kind="playlist" />{/each}</div>
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
  .actions {
    display: flex;
    gap: 10px;
    flex: none;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0 0 6px -4px;
    padding: 6px 8px;
    border-radius: 999px;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .back:hover {
    color: var(--text);
    background: var(--bg-hover);
  }
  .note {
    margin-top: 28px;
    max-width: 52ch;
    line-height: 1.5;
  }
  .more {
    margin: 10px 0 4px;
    padding: 10px 16px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 0.88rem;
    background: var(--bg-hover);
  }
  .more:hover {
    background: color-mix(in srgb, var(--text) 16%, transparent);
  }

  /* Genre tiles: a colour of their own, the artwork tilted into the corner. */
  .genres {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: 14px;
  }
  .tile {
    position: relative;
    display: block;
    height: 104px;
    overflow: hidden;
    border-radius: 12px;
    padding: 14px;
    color: #fff;
    text-decoration: none;
    background: linear-gradient(135deg, hsl(var(--h) 62% 44%), hsl(calc(var(--h) + 34) 58% 28%));
    transition: transform 0.15s ease, filter 0.15s ease;
  }
  .tile:hover {
    transform: translateY(-2px);
    filter: brightness(1.1);
  }
  .tile:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .name {
    position: relative;
    z-index: 1;
    font-weight: 800;
    font-size: 1.05rem;
    line-height: 1.15;
    max-width: 80%;
    display: block;
    overflow-wrap: break-word;
    hyphens: auto;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.35);
  }
  .pic {
    position: absolute;
    right: -14px;
    bottom: -12px;
    width: 76px;
    height: 76px;
    transform: rotate(22deg);
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  @media (max-width: 640px) {
    .hero {
      flex-direction: column;
      align-items: flex-start;
    }
    .actions {
      flex-wrap: wrap;
    }
    .genres {
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .tile {
      height: 92px;
      padding: 12px;
    }
    .name {
      font-size: 0.98rem;
    }
    .pic {
      width: 64px;
      height: 64px;
    }
  }
</style>

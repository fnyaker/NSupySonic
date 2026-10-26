<script>
  // Everything your artists released lately, as ONE list of titles read like a
  // playlist (newest release first, each release in its own order): a tap
  // plays from that title on, "Tout lire" plays it all. The server keeps it
  // fresh on its own; this page only reads it, and opening it marks
  // everything seen. A release whose titles the server has not read yet is
  // shown as an album to open, under the list.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import { player } from "../lib/stores.js";
  import Card from "../components/Card.svelte";
  import Icon from "../components/Icon.svelte";
  import TrackList from "../components/TrackList.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import BackButton from "../components/BackButton.svelte";

  let items = [];
  let tracks = [];
  let loading = true;

  $: listed = new Set(tracks.map((t) => t.release?.deezer_id).filter(Boolean));
  $: albumsOnly = items.filter((r) => !listed.has(r.deezer_id));

  function card(r) {
    const when = r.released ? new Date(r.released + "T12:00:00") : null;
    const date = when && !isNaN(when) ? when.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : "";
    const kind = r.kind === "single" ? "Single" : r.kind === "ep" ? "EP" : "";
    const who = r.close_to ? `${r.artist.name} · proche de ${r.close_to}` : r.artist.name;
    return { ...r, subtitle: [who, kind, date].filter(Boolean).join(" · ") };
  }

  function take(d) {
    items = d.releases || [];
    tracks = d.tracks || [];
  }

  function playAll() {
    if (tracks.length) player.playQueue(tracks, 0, { kind: "releases" });
  }

  onMount(async () => {
    try {
      const d = await api.swr("/releases", take);
      take(d);
      if (d.unseen) api.releasesSeen().catch(() => {});
    } catch {
      /* an empty page says so below */
    } finally {
      loading = false;
    }
  });
</script>

<BackButton />
<h1>Nouveautés</h1>
<p class="muted lead">
  Les sorties récentes de tes artistes favoris, de ceux que tu écoutes le plus et de quelques
  artistes très proches d'eux.
</p>

{#if loading && !tracks.length && !items.length}
  <Skeleton kind="list" />
{:else if !tracks.length && !items.length}
  <p class="muted empty">
    Rien de neuf pour l'instant. Ajoute des artistes à tes favoris : leurs prochaines sorties
    apparaîtront ici.
  </p>
{:else}
  {#if tracks.length}
    <div class="bar">
      <button class="pill" on:click={playAll}><Icon name="play" size={18} /> Tout lire</button>
      <span class="muted">{tracks.length} titre{tracks.length > 1 ? "s" : ""}</span>
    </div>
    <TrackList {tracks} context={{ kind: "releases" }} />
  {/if}
  {#if albumsOnly.length}
    <h2>{tracks.length ? "Autres sorties" : "Sorties"}</h2>
    <div class="grid">
      {#each albumsOnly as r (r.deezer_id)}
        <div class="cell" class:new={r.new}><Card item={card(r)} kind="album" /></div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .lead {
    margin: 0 0 8px;
    max-width: 640px;
  }
  .empty {
    margin-top: 28px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 18px 0 12px;
  }
  .cell {
    position: relative;
  }
  .cell.new::after {
    content: "Nouveau";
    position: absolute;
    top: 18px;
    left: 18px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 0.7rem;
    font-weight: 700;
    pointer-events: none;
  }
</style>

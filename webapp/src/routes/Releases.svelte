<script>
  // Everything your favourite artists released lately, then the releases of a
  // few artists very close to them. The server keeps the list fresh on its
  // own (every few hours); this page only reads it, and opening it marks
  // everything seen.
  import { onMount } from "svelte";
  import { api } from "../lib/api.js";
  import Card from "../components/Card.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import BackButton from "../components/BackButton.svelte";

  let items = [];
  let loading = true;

  $: mine = items.filter((r) => !r.close_to);
  $: close = items.filter((r) => r.close_to);

  function card(r) {
    const when = r.released ? new Date(r.released + "T12:00:00") : null;
    const date = when && !isNaN(when) ? when.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) : "";
    const kind = r.kind === "single" ? "Single" : r.kind === "ep" ? "EP" : "";
    const who = r.close_to ? `${r.artist.name} · proche de ${r.close_to}` : r.artist.name;
    return { ...r, subtitle: [who, kind, date].filter(Boolean).join(" · ") };
  }

  onMount(async () => {
    try {
      const d = await api.swr("/releases", (x) => (items = x.releases || []));
      items = d.releases || [];
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
  Les sorties récentes de vos artistes favoris et de quelques artistes très proches d'eux,
  vérifiées régulièrement par le serveur.
</p>

{#if loading}
  <Skeleton kind="shelf" />
{:else if !items.length}
  <p class="muted empty">
    Rien de neuf pour l'instant. Ajoutez des artistes à vos favoris : leurs prochaines sorties
    apparaîtront ici.
  </p>
{:else}
  {#if mine.length}
    <h2>Vos artistes</h2>
    <div class="grid">
      {#each mine as r (r.deezer_id)}
        <div class="cell" class:new={r.new}><Card item={card(r)} kind="album" /></div>
      {/each}
    </div>
  {/if}
  {#if close.length}
    <h2>Proches de vos artistes</h2>
    <div class="grid">
      {#each close as r (r.deezer_id)}
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

<script>
  import { onMount } from "svelte";
  import { push } from "svelte-spa-router";
  import {
    downloadQuality,
    downloads,
    downloadsSize,
    toasts,
  } from "../lib/stores.js";
  import { listDownloads, removeTrack, clearAll } from "../lib/offline.js";
  import { bytes as fmtBytes, duration as fmtDuration } from "../lib/format.js";
  import Icon from "../components/Icon.svelte";
  import Cover from "../components/Cover.svelte";

  const QUALITIES = [
    { id: "FLAC", label: "FLAC", hint: "Sans perte — lourd" },
    { id: "OPUS_320", label: "Opus 320", hint: "Haute qualité (recommandé)" },
    { id: "OPUS_256", label: "Opus 256", hint: "Haute qualité" },
    { id: "OPUS_192", label: "Opus 192", hint: "Bon compromis" },
    { id: "OPUS_128", label: "Opus 128", hint: "Standard, léger" },
    { id: "OPUS_64", label: "Opus 64", hint: "Données réduites" },
  ];
  let items = [];
  async function refresh() {
    items = await listDownloads();
  }
  onMount(refresh);
  // Reload the list whenever the downloaded set changes (add / remove / evict).
  $: $downloads, refresh();

  $: qualityLabel = (id) => QUALITIES.find((q) => q.id === id)?.label || id;

  async function remove(id, title) {
    await removeTrack(id);
    toasts.push(`« ${title} » retiré du cache`);
  }
  async function wipe() {
    if (!items.length) return;
    if (!window.confirm("Supprimer tous les titres téléchargés ?")) return;
    await clearAll();
    toasts.push("Cache vidé");
  }
</script>

<div class="head">
  <h1>Réglages</h1>
</div>

<section class="card">
  <h2>Qualité de téléchargement par défaut</h2>
  <p class="muted sub">Utilisée pour les nouveaux téléchargements (modifiable au cas par cas).</p>
  <div class="quality">
    {#each QUALITIES as q}
      <button class="q" class:sel={$downloadQuality === q.id} on:click={() => downloadQuality.set(q.id)}>
        <span class="qn">{q.label}</span>
        <span class="qh muted">{q.hint}</span>
        {#if $downloadQuality === q.id}<span class="tick"><Icon name="check" size={16} /></span>{/if}
      </button>
    {/each}
  </div>
</section>

<section class="card">
  <h2>Stockage des téléchargements</h2>
  <p class="muted sub">Vos téléchargements sont permanents : ils restent disponibles hors-ligne jusqu'à ce que vous les retiriez vous-même. Ce n'est pas un cache — rien n'est supprimé automatiquement.</p>

  <div class="gauge-txt">
    <span><strong>{fmtBytes($downloadsSize)}</strong> utilisés sur cet appareil</span>
    <span class="muted">{items.length} titre{items.length > 1 ? "s" : ""}</span>
  </div>
</section>

<section class="card">
  <div class="dl-head">
    <h2>Titres téléchargés <span class="count muted">({items.length})</span></h2>
    {#if items.length}
      <button class="wipe" on:click={wipe}><Icon name="trash" size={16} /> Tout effacer</button>
    {/if}
  </div>

  {#if !items.length}
    <p class="muted hint">Aucun titre téléchargé. Utilisez le bouton de téléchargement sur un titre, un album ou une playlist pour les rendre disponibles hors-ligne.</p>
  {:else}
    <div class="list">
      {#each items as m (m.id)}
        <div class="row">
          <div class="thumb"><Cover src={m.track?.album?.cover} alt={m.track?.title} size={40} /></div>
          <div class="meta">
            <div class="t">{m.track?.title}</div>
            <div class="a muted">{m.track?.artist?.name}</div>
          </div>
          <span class="q-badge">{qualityLabel(m.quality)}</span>
          <span class="sz muted">{fmtBytes(m.size)}</span>
          <button class="rm" on:click={() => remove(m.id, m.track?.title)} aria-label="Retirer" title="Retirer du cache"><Icon name="trash" size={17} /></button>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .head h1 {
    margin-bottom: 18px;
  }
  .card {
    background: var(--bg-card);
    border-radius: var(--radius);
    padding: 18px 20px;
    margin-bottom: 18px;
  }
  .card h2 {
    font-size: 1.05rem;
  }
  .sub {
    font-size: 0.85rem;
    margin: 4px 0 14px;
  }
  .quality {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
  }
  .q {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--bg-hover);
    background: var(--bg);
    position: relative;
    text-align: left;
  }
  .q.sel {
    border-color: var(--accent);
  }
  .qn {
    font-weight: 700;
  }
  .qh {
    font-size: 0.72rem;
  }
  .tick {
    position: absolute;
    top: 10px;
    right: 10px;
    color: var(--accent);
  }
  .gauge-txt {
    display: flex;
    justify-content: space-between;
    font-size: 0.9rem;
  }
  .dl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .count {
    font-weight: 400;
    font-size: 0.9rem;
  }
  .wipe {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .wipe:hover {
    color: var(--accent-2);
  }
  .hint {
    margin-top: 8px;
  }
  .list {
    display: flex;
    flex-direction: column;
    margin-top: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 40px 1fr auto auto 32px;
    align-items: center;
    gap: 12px;
    padding: 6px 4px;
    border-radius: 8px;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .thumb {
    width: 40px;
  }
  .meta {
    min-width: 0;
  }
  .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .a {
    font-size: 0.82rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .q-badge {
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 6px;
    padding: 2px 7px;
  }
  .sz {
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .rm {
    color: var(--text-dim);
    display: flex;
    justify-content: center;
  }
  .rm:hover {
    color: var(--accent-2);
  }
</style>

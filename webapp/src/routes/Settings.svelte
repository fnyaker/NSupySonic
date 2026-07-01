<script>
  import { onMount } from "svelte";
  import { push } from "svelte-spa-router";
  import {
    downloadQuality,
    downloads,
    downloadsSize,
    playCacheLimit,
    playCacheSize,
    prefetchEnabled,
    toasts,
  } from "../lib/stores.js";
  import { listDownloads, removeTrack, clearAll } from "../lib/offline.js";
  import { clearPlayCache, enforce } from "../lib/playcache.js";
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
  // Size caps for the playback cache (the prefetch buffer, not downloads).
  const CACHE_LIMITS = [
    { v: 256 * 1024 ** 2, label: "256 Mo" },
    { v: 512 * 1024 ** 2, label: "512 Mo" },
    { v: 1 * 1024 ** 3, label: "1 Go" },
    { v: 2 * 1024 ** 3, label: "2 Go" },
    { v: 4 * 1024 ** 3, label: "4 Go" },
  ];

  let items = [];
  async function refresh() {
    items = await listDownloads();
  }
  onMount(refresh);
  // Reload the list whenever the downloaded set changes (add / remove).
  $: $downloads, refresh();

  $: qualityLabel = (id) => QUALITIES.find((q) => q.id === id)?.label || id;
  $: cachePct = $playCacheLimit ? Math.min(100, ($playCacheSize / $playCacheLimit) * 100) : 0;

  function setCacheLimit(v) {
    playCacheLimit.set(v);
    enforce(v); // lowering the cap trims the cache right away
  }
  async function wipeCache() {
    await clearPlayCache();
    toasts.push("Cache de lecture vidé");
  }

  async function remove(id, title) {
    await removeTrack(id);
    toasts.push(`« ${title} » retiré des téléchargements`);
  }
  async function wipe() {
    if (!items.length) return;
    if (!window.confirm("Supprimer tous les titres téléchargés ?")) return;
    await clearAll();
    toasts.push("Téléchargements supprimés");
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
    <h2>Cache de lecture</h2>
    {#if $playCacheSize > 0}
      <button class="wipe" on:click={wipeCache}><Icon name="trash" size={16} /> Vider</button>
    {/if}
  </div>
  <p class="muted sub">Pendant la lecture, le titre suivant est préchargé ici (audio + pochette). La lecture est vérifiée d'abord en local, donc une coupure réseau ne l'interrompt pas. C'est un cache : les plus anciens sont supprimés automatiquement au-delà de la limite.</p>

  <button class="toggle" role="switch" aria-checked={$prefetchEnabled} on:click={() => prefetchEnabled.set(!$prefetchEnabled)}>
    <span class="tg-txt">
      <span class="tg-title">Précharger le titre suivant</span>
      <span class="tg-hint muted">Désactivez pour économiser les données mobiles.</span>
    </span>
    <span class="sw" class:on={$prefetchEnabled}><span class="knob"></span></span>
  </button>

  <div class="gauge">
    <div class="bar"><span style={`width:${cachePct}%`} class:warn={cachePct > 90}></span></div>
    <div class="gauge-txt">
      <span>{fmtBytes($playCacheSize)} en cache</span>
      <span class="muted">limite {fmtBytes($playCacheLimit)}</span>
    </div>
  </div>

  <div class="limits">
    {#each CACHE_LIMITS as l}
      <button class="lim" class:sel={$playCacheLimit === l.v} on:click={() => setCacheLimit(l.v)}>{l.label}</button>
    {/each}
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
  .gauge {
    margin-bottom: 14px;
  }
  .bar {
    height: 8px;
    border-radius: 4px;
    background: var(--bg-hover);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.25s ease;
  }
  .bar span.warn {
    background: var(--accent-2);
  }
  .gauge-txt {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    margin-top: 6px;
  }
  .limits {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .lim {
    padding: 7px 14px;
    border-radius: 999px;
    background: var(--bg);
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .lim.sel {
    background: #fff;
    color: #111;
    border-color: #fff;
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    text-align: left;
    padding: 4px 0 16px;
  }
  .tg-txt {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tg-title {
    font-weight: 600;
  }
  .tg-hint {
    font-size: 0.78rem;
  }
  .sw {
    flex: none;
    width: 44px;
    height: 26px;
    border-radius: 999px;
    background: var(--bg-hover);
    position: relative;
    transition: background 0.15s ease;
  }
  .sw.on {
    background: var(--accent);
  }
  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }
  .sw.on .knob {
    transform: translateX(18px);
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

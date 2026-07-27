<script>
  // Export a whole playlist / album / your favorites as one ZIP, in a format you
  // pick — for a USB stick, another player, a car radio. The server streams the
  // archive, so this is just a normal browser download: it survives leaving the
  // page and shows up in the download manager with real progress.
  import { fade, scale } from "svelte/transition";
  import { api } from "../lib/api.js";
  import { exportSheet, closeExport, toasts } from "../lib/stores.js";
  import { online } from "../lib/net.js";
  import Icon from "./Icon.svelte";

  let formats = [];
  let fmt = null;
  let loading = true;
  let started = false;
  let loadedFor = null;

  $: target = $exportSheet;
  $: if (target && loadedFor !== target) loadFormats(target);
  $: if (!target) started = false;

  async function loadFormats(t) {
    loadedFor = t;
    loading = true;
    started = false;
    try {
      const r = await api.exportFormats();
      formats = r.formats || [];
      // Keep the user's previous pick when the server still offers it.
      if (!fmt || !formats.some((f) => f.id === fmt)) fmt = r.default || formats[0]?.id;
    } catch {
      formats = [];
    }
    loading = false;
  }

  // Navigating to the URL hands the transfer to the browser's own download
  // manager — the right tool for something that can be several GB and take
  // minutes. A fetch+Blob would have to hold the whole archive in memory first.
  function start() {
    if (!fmt || !target) return;
    started = true;
    window.location.href = api.exportUrl(target.kind, target.id, fmt);
    toasts.push("Export lancé — voir les téléchargements du navigateur");
    setTimeout(closeExport, 1200);
  }

  function onKey(e) {
    if (e.key === "Escape") closeExport();
  }

  $: label =
    target?.kind === "album"
      ? "cet album"
      : target?.kind === "favorites"
        ? "vos favoris"
        : target?.kind === "podcast"
          ? "ce podcast"
          : "cette playlist";
</script>

<svelte:window on:keydown={onKey} />

{#if target}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" transition:fade={{ duration: 150 }} on:click|self={closeExport}>
    <div class="sheet" transition:scale={{ duration: 160, start: 0.97 }}>
      <header>
        <div class="ttl">
          <h2>Exporter</h2>
          <p class="muted">
            Télécharger {label} en un fichier ZIP{target.title ? ` — « ${target.title} »` : ""}.
          </p>
        </div>
        <button class="close" on:click={closeExport} aria-label="Fermer"><Icon name="close" size={20} /></button>
      </header>

      {#if loading}
        <p class="muted pad">Chargement des formats…</p>
      {:else if !formats.length}
        <p class="muted pad">Aucun format d'export disponible sur ce serveur.</p>
      {:else}
        <div class="fmts">
          {#each formats as f (f.id)}
            <button class="fmt" class:sel={fmt === f.id} on:click={() => (fmt = f.id)}>
              <span class="fname">{f.label}</span>
              <span class="fext muted">.{f.ext}</span>
              {#if fmt === f.id}<span class="tick"><Icon name="check" size={15} /></span>{/if}
            </button>
          {/each}
        </div>
        <p class="muted note">
          <Icon name="download" size={14} />
          Le ZIP contient un fichier par titre (numérotés, « Artiste - Titre ») et
          une playlist .m3u. Les titres pas encore archivés sont récupérés au
          passage, donc un gros export peut prendre un moment — le téléchargement
          démarre immédiatement et se poursuit en arrière-plan.
        </p>
      {/if}

      <footer>
        <button class="ghost" on:click={closeExport}>Annuler</button>
        <button class="pill" on:click={start} disabled={!fmt || loading || started || !$online}>
          <Icon name="download" size={17} />
          {started ? "Démarré…" : "Télécharger le ZIP"}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    z-index: 300;
    padding: 20px;
  }
  .sheet {
    background: var(--bg-elev);
    border-radius: 16px;
    width: min(460px, 100%);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 20px 12px;
  }
  .ttl h2 {
    margin: 0;
    font-size: 1.15rem;
  }
  .ttl p {
    margin: 4px 0 0;
    font-size: 0.85rem;
  }
  .close {
    flex: none;
    color: var(--text-dim);
  }
  .close:hover {
    color: var(--text);
  }
  .pad {
    padding: 8px 20px 20px;
  }
  .fmts {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 14px;
    overflow-y: auto;
  }
  .fmt {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: var(--bg);
    color: var(--text);
  }
  .fmt:hover {
    background: var(--bg-hover);
  }
  .fmt.sel {
    border-color: var(--accent);
    background: var(--bg-hover);
  }
  .fname {
    font-weight: 600;
  }
  .fext {
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
  }
  .tick {
    margin-left: auto;
    color: var(--accent);
    display: flex;
  }
  .note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.78rem;
    line-height: 1.45;
    margin: 14px 20px 0;
  }
  .note :global(svg) {
    flex: none;
    margin-top: 2px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 10px;
    padding: 16px 20px;
    margin-top: 6px;
    border-top: 1px solid var(--bg-hover);
  }
  .ghost {
    color: var(--text-dim);
    padding: 8px 12px;
  }
  .ghost:hover {
    color: var(--text);
  }
  .pill {
    gap: 8px;
  }
  .pill:disabled {
    opacity: 0.5;
    cursor: default;
    transform: none;
  }
</style>

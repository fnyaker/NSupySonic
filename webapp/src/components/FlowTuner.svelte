<script>
  import { onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { api } from "../lib/api.js";
  import { toasts } from "../lib/stores.js";
  import Icon from "./Icon.svelte";
  import Cover from "./Cover.svelte";

  export let onClose = () => {};

  let clusters = [];
  let available = true;
  let loading = true;
  let saving = false;

  $: onCount = clusters.filter((c) => c.enabled).length;

  onMount(async () => {
    try {
      const r = await api.flowClusters();
      available = r.available;
      clusters = r.clusters || [];
    } catch {
      available = false;
    }
    loading = false;
  });

  function toggle(c) {
    c.enabled = !c.enabled;
    clusters = clusters; // trigger reactivity
  }

  function setAll(value) {
    clusters = clusters.map((c) => ({ ...c, enabled: value }));
  }

  async function save() {
    saving = true;
    try {
      await api.setFlowClusters(clusters.map((c) => ({ id: c.id, enabled: c.enabled })));
      toasts.push("Flow personnalisé mis à jour");
      onClose();
    } catch {
      toasts.push("Échec de la personnalisation", "error");
    } finally {
      saving = false;
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="overlay" transition:fade={{ duration: 150 }} on:click|self={onClose}>
  <div class="modal" transition:scale={{ duration: 150, start: 0.96 }}>
    <header>
      <h2>Personnaliser mon Flow</h2>
      <button class="close" on:click={onClose} aria-label="Fermer"><Icon name="close" size={20} /></button>
    </header>

    {#if loading}
      <p class="muted pad">Chargement…</p>
    {:else if !available || !clusters.length}
      <p class="muted pad">La personnalisation du Flow n'est pas disponible pour ce compte.</p>
    {:else}
      <div class="sub">
        <p class="muted">Choisissez les styles à entendre dans votre Flow — {onCount}/{clusters.length} activés.</p>
        <div class="bulk">
          <button on:click={() => setAll(true)}>Tout activer</button>
          <button on:click={() => setAll(false)}>Tout désactiver</button>
        </div>
      </div>
      <div class="grid">
        {#each clusters as c (c.id)}
          <button class="cl" class:on={c.enabled} on:click={() => toggle(c)} title={c.title}>
            <div class="tile">
              <!-- Through Cover.svelte so a flaky CDN gets the same retry +
                   placeholder treatment as everywhere else (a bare <img> just
                   painted the browser's broken-image glyph). -->
              <div class="cv"><Cover src={c.cover} alt="" kind="mix" /></div>
              <span class="check" aria-hidden="true"><Icon name="check" size={15} /></span>
              <span class="name">{c.title}</span>
            </div>
          </button>
        {/each}
      </div>
      <footer>
        <button class="pill ghost" on:click={onClose}>Annuler</button>
        <button class="pill" on:click={save} disabled={saving}>{saving ? "…" : "Enregistrer"}</button>
      </footer>
    {/if}
  </div>
</div>

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
  .modal {
    background: var(--bg-elev);
    border-radius: 16px;
    width: min(720px, 100%);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px;
  }
  header h2 {
    margin: 0;
    font-size: 1.25rem;
  }
  .close {
    color: var(--text-dim);
  }
  .close:hover {
    color: var(--text);
  }
  .sub {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0 20px 14px;
  }
  .sub p {
    margin: 0;
  }
  .bulk {
    display: flex;
    gap: 8px;
    flex: none;
  }
  .bulk button {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 999px;
    padding: 5px 11px;
    white-space: nowrap;
  }
  .bulk button:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .pad {
    padding: 24px 20px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 12px;
    overflow-y: auto;
    padding: 0 20px 8px;
  }
  .cl {
    display: block;
    width: 100%;
  }
  .tile {
    position: relative;
    aspect-ratio: 1 / 1;
    width: 100%;
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-hover);
    transition:
      transform 0.12s ease,
      box-shadow 0.15s ease,
      filter 0.15s ease;
  }
  .tile .cv {
    position: absolute;
    inset: 0;
  }
  .tile::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      to top,
      rgba(0, 0, 0, 0.85) 0%,
      rgba(0, 0, 0, 0.2) 45%,
      rgba(0, 0, 0, 0) 75%
    );
  }
  .name {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 8px;
    z-index: 1;
    font-weight: 800;
    font-size: 0.92rem;
    line-height: 1.15;
    color: #fff;
    text-align: left;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
  }
  .check {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: #fff;
    opacity: 0;
    transform: scale(0.5);
    transition:
      opacity 0.12s ease,
      transform 0.12s ease;
  }
  .cl.on .check {
    opacity: 1;
    transform: scale(1);
  }
  .cl:hover .tile {
    transform: translateY(-2px);
  }
  .cl.on .tile {
    box-shadow: 0 0 0 3px var(--accent);
  }
  .cl:not(.on) .tile {
    filter: grayscale(0.75) brightness(0.55);
  }
  .cl:not(.on):hover .tile {
    filter: grayscale(0.35) brightness(0.8);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 16px 20px;
    border-top: 1px solid var(--bg-hover);
  }
</style>

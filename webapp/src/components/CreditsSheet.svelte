<script>
  // "Crédits du titre", from any track's menu: who wrote, composed, produced
  // it, over the current screen. The same answer as the full-screen player's
  // panel (one request, kept on the device, painted from the copy first).
  import { fade, scale } from "svelte/transition";
  import { onDestroy, onMount } from "svelte";
  import { trackKey, trackRef } from "../lib/trackkey.js";
  import { api } from "../lib/api.js";
  import { creditsSheet, closeCredits } from "../lib/stores.js";
  import { artistLine } from "../lib/format.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import TrackCredits from "./TrackCredits.svelte";

  let track = null;
  let key = null;
  let data = null;
  let failed = false;
  let seq = 0;

  $: if ($creditsSheet && trackKey($creditsSheet.track) !== key) load($creditsSheet.track);
  $: if (!$creditsSheet) {
    track = null;
    key = null;
  }

  async function load(t) {
    const mine = ++seq;
    track = t;
    key = trackKey(t);
    data = null;
    failed = false;
    try {
      const d = await api.swr("/track/" + trackRef(t) + "/credits", (c) => {
        if (mine === seq) data = c;
      });
      if (mine === seq) data = d;
    } catch {
      if (mine === seq && !data) failed = true;
    }
  }

  function retry() {
    if (track) {
      key = null;
      load(track);
    }
  }

  function onKey(e) {
    if (track && e.key === "Escape") closeCredits();
  }

  // A name is a link to another screen: following it closes the sheet.
  onMount(() => window.addEventListener("hashchange", closeCredits));
  onDestroy(() => window.removeEventListener("hashchange", closeCredits));

  $: empty = data && !data.credits?.length && !Object.keys(data.info || {}).length;
</script>

<svelte:window on:keydown={onKey} />

{#if track}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="overlay" transition:fade={{ duration: 150 }} on:click|self={closeCredits}>
    <div class="sheet" role="dialog" aria-label="Crédits du titre" transition:scale={{ duration: 160, start: 0.97 }}>
      <header>
        <div class="thumb">
          <Cover src={track.album?.cover} alt={track.title} size={48} kind="track" fallbackId={trackRef(track)} />
        </div>
        <div class="ttl">
          <h2>{track.title}</h2>
          <p class="muted">{artistLine(track)}</p>
        </div>
        <button class="close" on:click={closeCredits} aria-label="Fermer">
          <Icon name="close" size={20} />
        </button>
      </header>
      <div class="body">
        <h3>Crédits</h3>
        {#if data && !empty}
          <TrackCredits {data} />
        {:else if empty}
          <p class="muted state">Aucun crédit connu pour ce titre.</p>
        {:else if failed}
          <p class="muted state">
            Les crédits n'ont pas pu être chargés.
            <button class="link" on:click={retry}>Réessayer</button>
          </p>
        {:else}
          <div class="skel" aria-hidden="true">
            {#each [0, 1, 2, 3] as i (i)}<div class="srow"><i></i><i></i></div>{/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 320;
    background: rgba(0, 0, 0, 0.6);
    display: grid;
    place-items: center;
    padding: 20px;
    backdrop-filter: blur(2px);
  }
  .sheet {
    width: min(520px, 100%);
    max-height: min(78vh, 680px);
    display: flex;
    flex-direction: column;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 16px 6px;
  }
  .thumb {
    width: 48px;
    flex: none;
  }
  .ttl {
    min-width: 0;
    flex: 1;
  }
  .ttl h2 {
    margin: 0 0 2px;
    font-size: 1.05rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ttl p {
    margin: 0;
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .close {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    color: var(--text-dim);
    flex: none;
  }
  .close:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .body {
    overflow-y: auto;
    padding: 4px 16px 18px;
    flex: 1;
  }
  h3 {
    margin: 8px 0 4px;
    font-size: 0.78rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .state {
    margin: 14px 2px;
    line-height: 1.5;
  }
  .link {
    margin-left: 6px;
    color: var(--accent);
    font-weight: 700;
  }
  .srow {
    display: grid;
    grid-template-columns: minmax(96px, 34%) 1fr;
    gap: 12px;
    padding: 12px 2px;
  }
  .srow i {
    display: block;
    height: 12px;
    border-radius: 6px;
    background: var(--bg-hover);
  }
  .srow i:first-child {
    width: 60%;
  }
  @media (max-width: 560px) {
    .overlay {
      place-items: end stretch;
      padding: 0;
    }
    .sheet {
      width: 100%;
      max-height: 82vh;
      border-radius: 18px 18px 0 0;
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
</style>

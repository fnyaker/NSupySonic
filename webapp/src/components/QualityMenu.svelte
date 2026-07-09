<script>
  // Compact streaming-quality picker (button + drop-up). Used in the immersive
  // now-playing views, where the old segmented FLAC/320/128/64 strip was too big.
  import { quality } from "../lib/stores.js";
  import Icon from "./Icon.svelte";

  const QUALITIES = ["FLAC", "OPUS_320", "OPUS_256", "OPUS_192", "OPUS_128", "OPUS_64"];
  const LABEL = {
    FLAC: "FLAC",
    OPUS_320: "Opus 320",
    OPUS_256: "Opus 256",
    OPUS_192: "Opus 192",
    OPUS_128: "Opus 128",
    OPUS_64: "Opus 64",
  };
  const SHORT = { FLAC: "FLAC", OPUS_320: "320", OPUS_256: "256", OPUS_192: "192", OPUS_128: "128", OPUS_64: "64" };

  let open = false;
  function pick(q) {
    quality.set(q);
    open = false;
  }
</script>

<svelte:window on:click={() => (open = false)} />

<div class="qm">
  <button
    class="trigger"
    class:hifi={$quality === "FLAC"}
    class:open
    on:click|stopPropagation={() => (open = !open)}
    aria-haspopup="listbox"
    aria-expanded={open}
    title="Qualité de streaming"
  >
    <span>{SHORT[$quality]}</span>
    <Icon name="chevronUp" size={12} />
  </button>
  {#if open}
    <ul class="menu" role="listbox">
      {#each QUALITIES as q}
        <li>
          <button role="option" aria-selected={$quality === q} class:sel={$quality === q} on:click|stopPropagation={() => pick(q)}>
            <span>{LABEL[q]}</span>
            {#if $quality === q}<Icon name="check" size={15} />{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .qm {
    position: relative;
  }
  .trigger {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 0.74rem;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: rgba(255, 255, 255, 0.8);
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 7px 12px;
  }
  .trigger:hover {
    color: #fff;
  }
  .trigger.hifi {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .trigger :global(svg) {
    transition: transform 0.15s ease;
  }
  .trigger.open :global(svg) {
    transform: rotate(180deg);
  }
  .menu {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    min-width: 170px;
    list-style: none;
    margin: 0;
    padding: 6px;
    background: #282433;
    border: 1px solid #3a3448;
    border-radius: 10px;
    box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
    z-index: 5;
  }
  .menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    border-radius: 7px;
    font-size: 0.85rem;
    color: #fff;
    text-align: left;
  }
  .menu button:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .menu button.sel {
    color: var(--accent);
  }

  /* Roomier options on touch screens so the right quality is easy to hit in a
     hurry — bigger rows and a wider panel, without changing the trigger size. */
  @media (max-width: 640px) {
    .menu {
      min-width: 210px;
      padding: 8px;
    }
    .menu button {
      padding: 13px 14px;
      font-size: 0.95rem;
      border-radius: 9px;
    }
  }
</style>

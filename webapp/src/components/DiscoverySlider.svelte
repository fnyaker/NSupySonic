<script>
  // How far from what you already play the Flow reaches. A continuous value
  // with four named steps under it; a tap on a step name lands on it. The
  // value is the person's, kept by the server (lib/discovery.js).
  import { onMount } from "svelte";
  import { discoveryLevel, loadDiscovery, setDiscovery, stepOf, STEPS } from "../lib/discovery.js";

  export let compact = false;
  // Inside a card that already says what it is: no panel, no heading of its own.
  export let bare = false;

  onMount(() => {
    loadDiscovery();
  });

  $: step = stepOf($discoveryLevel);
  $: pct = Math.round($discoveryLevel * 100);
</script>

<div class="disc" class:compact class:bare style="--p: {pct}%">
  <div class="head">
    <span class="label">{bare ? "Niveau" : "Découverte"}</span>
    <span class="step">{step.name}</span>
  </div>
  <input
    type="range"
    min="0"
    max="1"
    step="0.01"
    value={$discoveryLevel}
    aria-label="Niveau de découverte du Flow"
    aria-valuetext={step.name}
    on:input={(e) => setDiscovery(+e.target.value)}
  />
  <div class="ticks">
    {#each STEPS as s, i}
      <button
        class:on={step === s}
        on:click={() => setDiscovery(i === 0 ? 0 : s.from + 0.125)}
        type="button">{s.name}</button
      >
    {/each}
  </div>
  {#if !compact}<p class="hint muted">{step.hint}</p>{/if}
</div>

<style>
  .disc {
    width: 100%;
    max-width: 420px;
    padding: 12px 16px 10px;
    border-radius: 14px;
    background: var(--bg-card);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .label {
    font-size: 0.78rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
    font-weight: 600;
  }
  .step {
    font-weight: 700;
    font-size: 0.95rem;
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 32px; /* the touch target; the track itself is drawn thin */
    margin: 4px 0 0;
    background: transparent;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent) 0, var(--accent-2) var(--p), var(--bg-hover) var(--p));
  }
  input[type="range"]::-moz-range-track {
    height: 6px;
    border-radius: 999px;
    background: var(--bg-hover);
  }
  input[type="range"]::-moz-range-progress {
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 22px;
    height: 22px;
    margin-top: -8px;
    border-radius: 50%;
    background: #fff;
    border: 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  }
  input[type="range"]::-moz-range-thumb {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    border: 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
  }
  input[type="range"]:focus-visible {
    outline: none;
  }
  input[type="range"]:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 0 0 4px rgba(162, 56, 255, 0.45);
  }
  .ticks {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    margin: 0 -6px;
  }
  .ticks button {
    min-height: 36px;
    padding: 6px 4px;
    font-size: 0.78rem;
    color: var(--text-dim);
    border-radius: 8px;
    text-align: center;
  }
  .ticks button:first-child {
    text-align: left;
    padding-left: 6px;
  }
  .ticks button:last-child {
    text-align: right;
    padding-right: 6px;
  }
  .ticks button:hover {
    color: var(--text);
  }
  .ticks button.on {
    color: var(--text);
    font-weight: 700;
  }
  .hint {
    margin: 2px 0 0;
    font-size: 0.82rem;
    min-height: 1.2em;
  }
  .bare {
    max-width: 520px;
    padding: 4px 0 0;
    background: none;
  }
  .compact {
    padding: 10px 14px 6px;
  }
</style>

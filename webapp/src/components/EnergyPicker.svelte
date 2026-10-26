<script>
  // The Flow's starting energy, in notches (Deezer's Flow moods are chosen the
  // same way, before the Flow starts: arXiv 2207.11229). One tap; the choice
  // is the person's, kept by the server and on the device (lib/flow.js).
  import { onMount } from "svelte";
  import { ENERGY_STEPS, startEnergy, setStartEnergy } from "../lib/flow.js";

  let row;
  // On a phone the row scrolls: the chosen notch is brought into view.
  onMount(() => {
    const on = row && row.querySelector("button.on");
    if (on && on.offsetLeft + on.offsetWidth > row.clientWidth) row.scrollLeft = on.offsetLeft - 16;
  });

  // The level each notch draws as bars (Libre: none).
  const BARS = [0, 1, 2, 3, 4, 5];
</script>

<div class="energy" bind:this={row} role="radiogroup" aria-label="Énergie du Flow">
  {#each ENERGY_STEPS as s, i}
    <button
      type="button"
      role="radio"
      aria-checked={$startEnergy === s.value}
      class:on={$startEnergy === s.value}
      title={s.hint}
      on:click={() => setStartEnergy(s.value)}
    >
      {#if BARS[i]}
        <span class="bars" aria-hidden="true">
          {#each [1, 2, 3, 4, 5] as b}<i class:lit={b <= BARS[i]} style="height: {4 + b * 2}px"></i>{/each}
        </span>
      {/if}
      {s.name}
    </button>
  {/each}
</div>

<style>
  .energy {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 2px 0;
    /* the row runs to the screen's edge on a phone, not into a hard cut */
    mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent);
  }
  .energy::-webkit-scrollbar {
    display: none;
  }
  button {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 15px;
    border-radius: 999px;
    border: 1px solid var(--bg-hover);
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.86rem;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  button:last-child {
    margin-right: 24px;
  }
  button:hover {
    color: var(--text);
    border-color: var(--text-dim);
  }
  button.on {
    background: var(--text);
    border-color: var(--text);
    color: var(--bg, #0b0a10);
  }
  .bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
  }
  .bars i {
    width: 3px;
    border-radius: 1px;
    background: currentColor;
    opacity: 0.25;
  }
  .bars i.lit {
    opacity: 1;
  }
</style>

<script>
  import { tick } from "svelte";
  import { trackLyrics, activeLyricIndex } from "../lib/lyrics.js";
  import { followScroll } from "../lib/scroll.js";

  $: lyrics = $trackLyrics;
  $: activeIdx = $activeLyricIndex;

  let box;
  let firstFollow = true;
  // Keep the active synced line in view as playback advances (centred-ish so
  // the upcoming lines are visible below). Jump without animation the first
  // time (on open), then smoothly afterwards.
  $: follow(activeIdx);
  async function follow(i) {
    if (i < 0 || !box) return;
    await tick();
    const el = box.querySelector("li.active");
    if (!el) return;
    followScroll(box, el, { ratio: 0.42, smooth: !firstFollow });
    firstFollow = false;
  }
  // Reset the "instant first jump" when the track (lyrics) changes.
  $: lyrics, (firstFollow = true);
</script>

<div class="lyrics" bind:this={box}>
  {#if !lyrics}
    <p class="muted">Paroles indisponibles.</p>
  {:else if lyrics.synced && lyrics.synced.length}
    <ul class="synced">
      {#each lyrics.synced as line, i}
        <li class:active={i === activeIdx}>{line.text || "• • •"}</li>
      {/each}
    </ul>
  {:else}
    <pre class="plain">{lyrics.text}</pre>
  {/if}
</div>

<style>
  .lyrics {
    height: 100%;
    overflow-y: auto;
    padding: 8px 4px;
  }
  .synced {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .synced li {
    color: var(--text-dim);
    font-size: 1.1rem;
    font-weight: 600;
    transition: color 0.2s;
  }
  .synced li.active {
    color: var(--text);
    font-size: 1.3rem;
  }
  .plain {
    white-space: pre-wrap;
    font-family: inherit;
    color: var(--text-dim);
    line-height: 1.6;
  }
</style>

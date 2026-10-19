<script>
  // What a YouTube track REALLY plays at, next to the quality chip, when the
  // chip asks for more than YouTube has (FLAC, Opus 320…). The chip stays the
  // setting; this says the truth about the one track that cannot honour it.
  import { trackKey } from "../lib/trackkey.js";
  import { current, player, quality } from "../lib/stores.js";
  import { isYoutube, realBitrate, realBitrateBadge } from "../lib/youtube.js";

  export let tone = "bar"; // bar | immersive

  let real = 0;
  // Keyed on the id as a STRING: `current` is handed over again on every
  // progress tick, and a statement reading the object would ask on each one.
  $: id = $current && isYoutube($current) ? trackKey($current) : null;
  // Asked once the audio is running: the first play is what archives the
  // file, so before that there is nothing to measure.
  $: playing = !!id && $player.currentTime > 0.5;
  let askedFor = null;
  $: if (id !== askedFor) {
    real = 0;
    if (!id) askedFor = null;
  }
  $: if (playing && askedFor !== id) {
    askedFor = id;
    const mine = id;
    realBitrate($current).then((k) => {
      if (mine === askedFor) real = k;
    });
  }
  $: badge = id ? realBitrateBadge($current, $quality, real) : null;
</script>

{#if badge}
  <span class="src" class:immersive={tone === "immersive"} title={badge.title}>{badge.short}</span>
{/if}

<style>
  .src {
    display: inline-flex;
    align-items: center;
    flex: none;
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.03em;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    padding: 5px 8px;
    border-radius: 999px;
    color: var(--text-dim);
    border: 1px solid color-mix(in srgb, var(--text-dim) 45%, transparent);
    white-space: nowrap;
    cursor: help;
  }
  .src.immersive {
    color: rgba(255, 255, 255, 0.72);
    border-color: rgba(255, 255, 255, 0.28);
  }
</style>

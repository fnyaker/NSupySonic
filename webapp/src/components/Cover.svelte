<script>
  import { afterUpdate } from "svelte";
  import Icon from "./Icon.svelte";
  import { loResCover, coverKey, baseCover } from "../lib/format.js";
  import { offlineCovers } from "../lib/stores.js";
  export let src = null;
  export let alt = "";
  export let round = false;
  export let size = null; // optional fixed px size

  let loaded = false;
  let failed = false;
  let usingBlob = false;
  let usingBase = false;
  let img;
  // Render the remote URL normally (fast, browser/SW-cached) — the downloaded
  // cover blob is only a FALLBACK for when the remote fails to load (airplane
  // mode). This keeps covers showing online while still working offline.
  $: blob = src ? $offlineCovers[coverKey(src)] : null;
  // The base-size (500px) URL of the same art. The full-screen views request a
  // hi-res URL that was never fetched online (not HTTP-cached), so offline it
  // can't load; the 500px cover shown everywhere else usually IS cached, so we
  // fall back to it when there's no downloaded blob. Same URL for base art -> null.
  $: base = baseCover(src);
  $: shown = usingBlob && blob ? blob : usingBase && base ? base : src;
  // A few-KB downscaled version of the same cover, shown blurred underneath
  // until the full-size art finishes loading (null for a local blob / non-Deezer).
  $: low = loResCover(shown);
  // Reset the fade + fallback state when the source changes (recycled rows, or
  // an offline↔online swap).
  $: src, ((loaded = false), (failed = false), (usingBlob = false), (usingBase = false));
  // …but if the new image is already cached, mark it loaded before the browser
  // paints, so swapping to an already-seen cover doesn't flash (no re-fade).
  afterUpdate(() => {
    if (!loaded && img && img.complete && img.naturalWidth > 0) loaded = true;
  });

  // The image failed to load: step through the fallback chain — the downloaded
  // blob (offline), then the base-size cover (HTTP-cached from elsewhere), and
  // only then the placeholder — never leave a broken image.
  function onError() {
    if (!usingBlob && blob) {
      usingBlob = true;
      loaded = false;
    } else if (!usingBase && base && base !== src) {
      usingBase = true;
      loaded = false;
    } else {
      failed = true;
    }
  }
</script>

<div
  class="cover"
  class:round
  style={size ? `width:${size}px;height:${size}px` : ""}
>
  {#if shown && !failed}
    {#if low && !loaded}
      <img class="low" src={low} alt="" aria-hidden="true" decoding="async" />
    {/if}
    <img
      bind:this={img}
      src={shown}
      {alt}
      loading="lazy"
      decoding="async"
      class:loaded
      on:load={() => (loaded = true)}
      on:error={onError}
    />
  {:else}
    <div class="ph"><Icon name="music" size={28} /></div>
  {/if}
</div>

<style>
  .cover {
    position: relative;
    aspect-ratio: 1 / 1;
    width: 100%;
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--bg-hover);
  }
  .cover.round {
    border-radius: 50%;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* the full-size art fades in over the low-res placeholder */
  img:not(.low) {
    position: relative;
    z-index: 1;
    opacity: 0;
    transition: opacity 0.35s ease;
  }
  img.loaded {
    opacity: 1;
  }
  /* instant low-quality placeholder, slightly blurred + scaled to hide its edges */
  img.low {
    position: absolute;
    inset: 0;
    filter: blur(8px);
    transform: scale(1.08);
  }
  .ph {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    font-size: 2rem;
    color: var(--text-dim);
  }
</style>

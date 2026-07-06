<script>
  import { afterUpdate, onDestroy } from "svelte";
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
  let img;
  // Progressive hi-res: when `src` asks for more than the canonical 500px (the
  // full-screen views do), we render the 500px IMMEDIATELY — it's the exact URL
  // the lists already fetched, so it comes straight from the HTTP cache — and
  // preload the hi-res in the background, swapping it in only once it's fully
  // decoded. Deezer generates the big sizes on the fly, which can be slow or
  // hang outright, so the hi-res may only ever *improve* the picture — never
  // delay or blank it.
  let hiUrl = null; // decoded hi-res upgrade (only when src is a hi-res URL)
  let hiLoader = null; // in-flight preloader, cancelled on src change
  let stallTimer = null;
  // Transient CDN failures: retry the base art a couple of times (delayed,
  // cache-busted) before giving up on it — the Deezer image CDN drops requests
  // often enough that a single failed fetch used to blank covers for good.
  let retries = 0;
  let retryTimer = null;

  // Downloaded/cached cover blob for this art (any resolution) — the offline
  // fallback when the network URL fails or stalls.
  $: blob = src ? $offlineCovers[coverKey(src)] : null;
  // What actually renders: offline blob (fallback) > decoded hi-res > base art.
  // `retries` is passed explicitly so Svelte re-runs this when a retry fires.
  $: shown = usingBlob && blob ? blob : hiUrl || bust(baseCover(src), retries);
  // A cache-busted variant of a failed URL, so the retry is a real re-fetch
  // instead of the browser replaying its cached failure. No-op on blob: URLs.
  function bust(u, n) {
    if (!n || !u || u.startsWith("blob:")) return u;
    return u + (u.includes("?") ? "&" : "?") + "r=" + n;
  }
  // A few-KB downscaled version of the same cover, shown blurred underneath
  // until the full-size art finishes loading (null for a local blob / non-Deezer).
  $: low = loResCover(shown);
  $: onSrcChange(src);

  // Reset the fade + fallback state when the source changes (recycled rows, or
  // an offline↔online swap), and arm the progressive upgrade / stall watchdog.
  function onSrcChange(s) {
    loaded = false;
    failed = false;
    usingBlob = false;
    hiUrl = null;
    retries = 0;
    clearTimeout(retryTimer);
    retryTimer = null;
    cancelHi();
    clearTimeout(stallTimer);
    stallTimer = null;
    if (!s) return;
    if (baseCover(s) !== s) preloadHi(s);
    // A dead-network fetch can hang without ever firing load OR error, leaving
    // the art blank forever. If a downloaded blob exists, fall back to it.
    stallTimer = setTimeout(() => {
      if (!loaded && !usingBlob && blob) {
        usingBlob = true;
        loaded = false;
      }
    }, 5000);
  }

  function preloadHi(url) {
    const im = new Image();
    im.decoding = "async";
    hiLoader = im;
    im.onload = () => {
      if (hiLoader !== im) return; // superseded by a newer src
      hiLoader = null;
      // decode() before swapping so the upgrade paints in one clean frame.
      const apply = () => {
        if (src === url) hiUrl = url;
      };
      if (im.decode) im.decode().then(apply, apply);
      else apply();
    };
    im.onerror = () => {
      if (hiLoader === im) hiLoader = null; // hi-res unavailable — keep the base
    };
    im.src = url;
  }
  function cancelHi() {
    if (hiLoader) {
      hiLoader.onload = null;
      hiLoader.onerror = null;
      hiLoader.src = ""; // abort the in-flight fetch
      hiLoader = null;
    }
  }
  onDestroy(() => {
    cancelHi();
    clearTimeout(stallTimer);
    clearTimeout(retryTimer);
  });

  // …but if the new image is already cached, mark it loaded before the browser
  // paints, so swapping to an already-seen cover doesn't flash (no re-fade).
  afterUpdate(() => {
    if (!loaded && img && img.complete && img.naturalWidth > 0) loaded = true;
  });

  // The image failed to load: step through the fallback chain — drop a failed
  // hi-res back to the base, retry the base a couple of times (transient CDN
  // failure), then the downloaded blob (offline), and only then the
  // placeholder — never leave a broken image.
  function onError() {
    if (hiUrl) {
      hiUrl = null;
    } else if (!usingBlob && retries < 2 && navigator.onLine !== false) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retries += 1; // bumps `shown` to a cache-busted URL -> new attempt
      }, 500 * (retries + 1));
    } else if (!usingBlob && blob) {
      usingBlob = true;
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

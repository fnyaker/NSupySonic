<script>
  import { afterUpdate, onDestroy } from "svelte";
  import Icon from "./Icon.svelte";
  import { loResCover, coverKey, baseCover } from "../lib/format.js";
  import { offlineCovers } from "../lib/stores.js";
  import { online } from "../lib/net.js";
  import { api } from "../lib/api.js";
  export let src = null;
  export let alt = "";
  export let round = false;
  export let size = null; // optional fixed px size
  // What this art represents, so a missing cover falls back to a MEANINGFUL
  // glyph (a person for an artist, a mic for a podcast…) instead of always a
  // music note. See PLACEHOLDER below.
  export let kind = "album"; // album | track | artist | playlist | mix | podcast
  // Optional TRACK/episode id (numeric Deezer id or a local UUID) whose art the
  // server can serve same-origin from `/api/cover/<id>` — it proxies + caches
  // the art on disk, so it works when the Deezer image CDN doesn't. Used as the
  // last network fallback before the placeholder. MUST be a track/episode id or
  // a local entity UUID: a numeric *album* id would resolve to the wrong thing.
  export let fallbackId = null;
  // Above-the-fold art (page headers, the now-playing views): load it eagerly at
  // high priority instead of lazily — it's the first thing the eye lands on.
  export let eager = false;

  let loaded = false;
  let failed = false;
  let usingBlob = false;
  let usingProxy = false;
  let lowFailed = false;
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
  // Same-origin, server-cached copy of this track's art (see `fallbackId`).
  $: proxyUrl = fallbackId ? api.coverUrl(fallbackId) : null;
  // What actually renders, best-first: offline blob > server proxy > decoded
  // hi-res > base art. `retries` is passed explicitly so Svelte re-runs this
  // when a retry fires.
  $: shown =
    usingBlob && blob
      ? blob
      : usingProxy && proxyUrl
        ? proxyUrl
        : hiUrl || bust(baseCover(src), retries);
  // A cache-busted variant of a failed URL, so the retry is a real re-fetch
  // instead of the browser replaying its cached failure. No-op on blob: URLs.
  function bust(u, n) {
    if (!n || !u || u.startsWith("blob:")) return u;
    return u + (u.includes("?") ? "&" : "?") + "r=" + n;
  }
  // A few-KB downscaled version of the same cover, shown blurred underneath
  // until the full-size art finishes loading. Derived from the CANONICAL url
  // (not from `shown`), so a retry's cache-buster doesn't re-download it and a
  // local blob / proxy fallback simply skips it.
  $: low = usingBlob || usingProxy || lowFailed ? null : loResCover(baseCover(src));
  $: onSrcChange(src);
  // A cover that gave up while the network was down must not stay a placeholder
  // for the rest of the session: the moment connectivity returns, start the
  // fallback chain over from the top.
  $: onConnectivity($online);

  // Reset the fade + fallback state when the source changes (recycled rows, or
  // an offline↔online swap), and arm the progressive upgrade / stall watchdog.
  function onSrcChange(s) {
    loaded = false;
    failed = false;
    usingBlob = false;
    usingProxy = false;
    lowFailed = false;
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
    // the art blank forever. Step to the next source in the chain instead.
    stallTimer = setTimeout(() => {
      if (loaded || usingBlob || usingProxy) return;
      if (blob) usingBlob = true;
      else if (proxyUrl) usingProxy = true;
      else return;
      loaded = false;
    }, 5000);
  }

  let wasOnline = true;
  function onConnectivity(up) {
    const recovered = up && !wasOnline;
    wasOnline = up;
    // Only worth redoing when we actually gave up on (or fell back from) the
    // network art — a happily displayed cover is left alone.
    if (recovered && src && (failed || usingProxy || retries)) onSrcChange(src);
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

  // …but if the new image is already cached, mark it loaded before it paints,
  // so swapping to an already-seen cover doesn't flash (no re-fade). Checked a
  // microtask later AND against currentSrc: right after a src change,
  // `complete`/`naturalWidth` still describe the PREVIOUS image (the spec only
  // updates the image data at the next stable state), so the old check marked
  // the outgoing cover as loaded — leaving the previous track's art displayed,
  // indefinitely when the new fetch stalled.
  afterUpdate(() => {
    if (loaded || !img) return;
    const want = shown;
    queueMicrotask(() => {
      if (
        !loaded &&
        img &&
        shown === want &&
        img.complete &&
        img.naturalWidth > 0 &&
        sameSrc(img.currentSrc, want)
      )
        loaded = true;
    });
  });
  function sameSrc(cur, want) {
    if (!cur || !want) return false;
    try {
      return cur === new URL(want, window.location.href).href;
    } catch {
      return cur === want;
    }
  }

  // The image failed to load: step through the fallback chain — drop a failed
  // hi-res back to the base, retry the base a couple of times (transient CDN
  // failure), then the downloaded blob (offline), then the server-side cached
  // proxy, and only then the placeholder — never leave a broken image.
  function onError() {
    if (hiUrl) {
      hiUrl = null;
    } else if (
      !usingBlob &&
      !usingProxy &&
      retries < 2 &&
      navigator.onLine !== false
    ) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retries += 1; // bumps `shown` to a cache-busted URL -> new attempt
      }, 500 * (retries + 1));
    } else if (!usingBlob && blob) {
      usingBlob = true;
      loaded = false;
    } else if (!usingProxy && proxyUrl) {
      // Same-origin, server-cached art: works when the Deezer CDN doesn't.
      usingProxy = true;
      usingBlob = false;
      loaded = false;
    } else {
      failed = true;
    }
  }

  // Missing art gets a glyph that says what the thing IS, not a generic note.
  const PLACEHOLDER = {
    artist: "user",
    podcast: "mic",
    playlist: "library",
    mix: "radio",
    album: "music",
    track: "music",
  };
  $: phIcon = PLACEHOLDER[kind] || "music";
</script>

<div
  class="cover"
  class:round
  style={size ? `width:${size}px;height:${size}px` : ""}
>
  {#if shown && !failed}
    {#if low && !loaded}
      <img
        class="low"
        src={low}
        alt=""
        aria-hidden="true"
        decoding="async"
        fetchpriority="low"
        on:error={() => (lowFailed = true)}
      />
    {/if}
    <!-- Thumbnails are explicitly LOW priority. On a slow link twenty 500px
         covers are the best part of a megabyte, and at the browser's default
         "auto" they queue ahead of — and delay — the very API call that
         produces the list they belong to. Low keeps them strictly in the
         background: the list lands first and the art fills in behind it. The
         above-the-fold art (`eager`) is the one thing that stays high. -->
    <img
      bind:this={img}
      src={shown}
      {alt}
      loading={eager ? "eager" : "lazy"}
      fetchpriority={eager ? "high" : "low"}
      decoding="async"
      class:loaded
      on:load={() => (loaded = true)}
      on:error={onError}
    />
  {:else}
    <!-- Named only when there's something to say; an unnamed role="img" is
         worse for a screen reader than a decorative, hidden tile. -->
    {#if alt}
      <div class="ph" role="img" aria-label={alt}><Icon name={phIcon} size={24} /></div>
    {:else}
      <div class="ph" aria-hidden="true"><Icon name={phIcon} size={24} /></div>
    {/if}
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
  /* Default art. Deliberately not a flat grey square: a soft tinted tile with a
     glyph that SCALES with the tile, so it reads as considered at 40px in a
     track row and at 400px in the full-screen player alike. */
  .ph {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    background:
      radial-gradient(115% 115% at 28% 0%, rgba(162, 56, 255, 0.22), transparent 62%),
      linear-gradient(155deg, var(--bg-hover), var(--bg-card));
    color: var(--text-dim);
  }
  .ph :global(svg) {
    width: 36%;
    height: 36%;
    min-width: 13px;
    min-height: 13px;
    max-width: 64px;
    max-height: 64px;
    stroke-width: 1.5;
    opacity: 0.6;
  }
</style>

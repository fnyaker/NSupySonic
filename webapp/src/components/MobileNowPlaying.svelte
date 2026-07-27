<script>
  // Mobile now-playing. The cover carousel is a native CSS scroll-snap strip
  // (smooth, momentum, no transform math): three slots [prev, current, next],
  // current centred, neighbours peeking. When the user settles on a neighbour we
  // advance the queue and re-centre, so the cover they swiped to stays put.
  import { tick, onMount, onDestroy } from "svelte";
  import { push } from "svelte-spa-router";
  import { fade } from "svelte/transition";
  import {
    player,
    current,
    playing,
    favorites,
    immersiveOpen,
    seekTo,
    buffered,
    openMenu,
    offlineCovers,
    openShare,
  } from "../lib/stores.js";
  import { toggleFavorite, buildTrackMenu } from "../lib/actions.js";
  import { addMarkerAt } from "../lib/markers.js";
  import { duration as fmtDuration, hiResCover, resolveCover, cssUrl } from "../lib/format.js";
  import { playbackLabel, playbackBusy } from "../lib/playback.js";
  import { createVisualizer, requestAnalyser } from "../lib/visualizer.js";
  import { currentLyricLine } from "../lib/lyrics.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import QualityMenu from "./QualityMenu.svelte";
  import VirtualList from "./VirtualList.svelte";

  let showQueue = false;

  function trackMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!$current) return;
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    openMenu(coords, buildTrackMenu($current, go));
  }

  // -- bar visualizer (same renderer as desktop) ----------------------------
  // Only animate while the page is actually visible: on mobile, burning rAF
  // frames behind a locked screen / backgrounded PWA wastes battery.
  let viz;
  let rafId = null;
  const drawBars = createVisualizer();
  function startViz() {
    if (rafId || (typeof document !== "undefined" && document.hidden)) return;
    requestAnalyser(); // wire Web Audio in now that the visualizer is on screen
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      drawBars(viz);
    };
    loop();
  }
  function stopViz() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function onVisibility() {
    document.hidden ? stopViz() : startViz();
  }
  onMount(() => {
    startViz();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopViz();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  // Background crossfade: each new cover is PRELOADED first and only stacked
  // once decoded, ON TOP of the previous one (which stays fully opaque) — then
  // the covered layers are dropped after the fade. Preloading matters: stacking
  // a still-loading URL and dropping the old layer on a fixed timer used to
  // blank the backdrop on slow networks. Resolved through the offline cache so
  // the background also shows in airplane mode.
  let bgLayers = [];
  let bgN = 0;
  let bgTimer;
  let bgLoader = null;
  let bgRetryTimer = null;
  $: setBg(resolveCover($offlineCovers, $current?.album?.cover) || "");
  function setBg(url, attempt = 0) {
    if (!url) return; // no art: keep the previous backdrop rather than blanking
    const top = bgLayers[bgLayers.length - 1];
    if (top && (top.url || top.src) === url) return;
    if (bgLoader && bgLoader.__url === url && !attempt) return; // already preloading it
    if (bgLoader) {
      bgLoader.onload = bgLoader.onerror = null;
      bgLoader.src = "";
    }
    clearTimeout(bgRetryTimer);
    // Retries re-fetch under a cache-busted URL so the browser doesn't just
    // replay the failed attempt from its cache.
    const fetchSrc =
      attempt && !url.startsWith("blob:")
        ? url + (url.includes("?") ? "&" : "?") + "r=" + attempt
        : url;
    const im = new Image();
    im.__url = url;
    bgLoader = im;
    im.onload = () => {
      if (bgLoader !== im) return; // a newer cover superseded this one
      bgLoader = null;
      pushBgLayer(fetchSrc, url);
    };
    im.onerror = () => {
      if (bgLoader !== im) return;
      bgLoader = null;
      // One delayed retry (the image CDN fails transiently); after that the
      // previous backdrop simply stays up.
      if (attempt < 1)
        bgRetryTimer = setTimeout(() => setBg(url, attempt + 1), 1500);
    };
    im.src = fetchSrc;
  }
  function pushBgLayer(src, url) {
    const id = ++bgN;
    // Keep at most ONE layer under the incoming one — that's all that shows
    // through while the new art fades in. The stack used to grow until 420ms of
    // quiet finally arrived, so skipping through a dozen tracks left a dozen
    // full-screen `blur(60px)` layers composited on top of each other, which is
    // enough on its own to drag the whole view to a crawl.
    bgLayers = [...bgLayers.slice(-1), { id, src, url }];
    // Drop the covered-up layer once the fade-in has finished.
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => (bgLayers = bgLayers.filter((l) => l.id === id)), 420);
  }

  $: q = $player.queue;
  $: idx = $player.index;
  $: prevT = idx > 0 ? q[idx - 1] : null;
  $: nextT = idx >= 0 && idx < q.length - 1 ? q[idx + 1] : null;
  $: fav = $current && $favorites.has(String($current.deezer_id));
  $: progress = $player.duration ? ($player.currentTime / $player.duration) * 100 : 0;
  $: bufferedPct = $player.duration
    ? Math.min(100, Math.max(progress, ($buffered / $player.duration) * 100))
    : 0;
  $: repeatIcon = $player.repeat === "one" ? "repeat1" : "repeat";

  // Keep the playing track in view when the queue sheet is open (first quarter
  // on open, then follow as it advances).
  let queueVL;
  let firstQueueFollow = true;
  $: followQueue(showQueue, idx);
  async function followQueue() {
    if (!showQueue || idx < 0) return;
    await tick();
    // The queue is windowed, so the playing row may not be in the DOM — scroll
    // by index instead of querying for it.
    queueVL?.scrollToIndex(idx, { ratio: 0.25, smooth: !firstQueueFollow });
    firstQueueFollow = false;
  }
  $: if (!showQueue) firstQueueFollow = true;

  function close() {
    immersiveOpen.set(false);
  }

  // -- swipe-down to dismiss -------------------------------------------------
  // Drag the whole sheet down with the finger; release past a threshold closes
  // it. Ignore gestures that start on the cover carousel, the sliders or the
  // queue sheet so we don't fight their own horizontal/scroll behaviour.
  let dragY = 0;
  let dragging = false;
  let dragArmed = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragAxis = null;
  function onTouchStart(e) {
    if (e.touches.length !== 1 || showQueue) {
      dragArmed = false;
      return;
    }
    const t = e.target;
    if (t.closest(".scroller") || t.closest("input") || t.closest(".sheet")) {
      dragArmed = false;
      return;
    }
    dragArmed = true;
    dragAxis = null;
    dragStartX = e.touches[0].clientX;
    dragStartY = e.touches[0].clientY;
  }
  function onTouchMove(e) {
    if (!dragArmed) return;
    const dx = e.touches[0].clientX - dragStartX;
    const dy = e.touches[0].clientY - dragStartY;
    if (dragAxis === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8))
      dragAxis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    if (dragAxis === "y" && dy > 0) {
      // cancel the browser's native pull-to-refresh while we drag to dismiss
      if (e.cancelable) e.preventDefault();
      dragging = true;
      dragY = dy;
    }
  }
  function onTouchEnd() {
    if (!dragArmed) return;
    dragArmed = false;
    dragAxis = null;
    if (dragging && dragY > 110) {
      close(); // fade out from the dragged position; component unmounts
      dragging = false;
      return;
    }
    dragging = false; // snap back
    dragY = 0;
  }

  function go(p) {
    close();
    push(p);
  }
  function seek(e) {
    const t = +e.target.value;
    player.setProgress(t, $player.duration);
    seekTo.set(t);
  }

  // -- cover carousel (native scroll-snap) ----------------------------------
  // [prev?, current, next?] keyed by queue position + track id: the position
  // keeps the key STABLE as the window slides (advancing reuses each cover's
  // DOM node — no reload, no fade flash) and the composite stays unique even
  // when the same track appears twice in a row in the queue (a duplicate id
  // alone would crash the keyed each). We then re-centre on the reused current
  // node, which cancels the reorder -> seamless, glitch-free.
  $: slots = (() => {
    const s = [];
    if (idx < 0) return s;
    for (const i of [idx - 1, idx, idx + 1]) {
      if (i >= 0 && i < q.length) s.push({ track: q[i], key: i + ":" + q[i].deezer_id });
    }
    return s;
  })();
  $: curSlot = idx > 0 ? 1 : 0; // index of the current cover within `slots`

  let scroller;
  let recentering = false;
  let settleTimer;
  let swipeAdvance = false; // the queue change came from a finger swipe
  const GAP = 14;

  function elCenterLeft(el) {
    return el.offsetLeft - (scroller.clientWidth - el.clientWidth) / 2;
  }
  // Hold the "this scroll is ours, not the user's" flag for `ms`. It MUST be a
  // single tracked timer: the three call sites each used to fire their own
  // untracked setTimeout, so two overlapping re-centres (tapping next twice
  // quickly) let the first one clear the flag while the second was still
  // animating. onSettled then ran mid-animation, measured a transient scroll
  // position and fired a bogus player.jump() — the carousel skipping a track on
  // its own.
  let recenterTimer = null;
  function holdRecenter(ms) {
    recentering = true;
    clearTimeout(recenterTimer);
    recenterTimer = setTimeout(() => {
      recenterTimer = null;
      recentering = false;
    }, ms);
  }
  function centerCurrent() {
    if (!scroller) return;
    const el = scroller.children[curSlot];
    if (!el) return;
    holdRecenter(60);
    scroller.scrollTo({ left: elCenterLeft(el), behavior: "instant" });
    clearTimeout(settleTimer);
  }
  // Slide the new current in from the side (used for button / auto advance, so
  // they get the same motion as a swipe instead of teleporting).
  function slideToCurrent(dir) {
    if (!scroller) return;
    const el = scroller.children[curSlot];
    if (!el) {
      return;
    }
    const center = elCenterLeft(el);
    const step = el.clientWidth + GAP;
    holdRecenter(420);
    scroller.scrollTo({ left: center - step * dir, behavior: "instant" });
    requestAnimationFrame(() => {
      scroller.scrollTo({ left: center, behavior: "smooth" });
      clearTimeout(settleTimer);
      holdRecenter(420); // re-arm from the start of the SMOOTH scroll
    });
  }
  // `scrollend` fires exactly when the scroll settles — INCLUDING the browser's
  // own snap animation — which is precisely when a swipe should commit. The old
  // 110 ms guess after the last scroll event fired while the snap was still
  // animating, so it measured a position that wasn't final yet and then had to
  // correct itself: that double-take is what made the swipe feel unsettled.
  // Fall back to the timer where the event isn't supported (Safari < 18.2).
  const HAS_SCROLLEND = typeof window !== "undefined" && "onscrollend" in window;
  function onScroll() {
    if (recentering || HAS_SCROLLEND) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(onSettled, 110);
  }
  function onScrollEnd() {
    if (recentering) return;
    clearTimeout(settleTimer);
    settleTimer = null;
    onSettled();
  }
  function onSettled() {
    if (recentering || !scroller) return;
    const center = scroller.scrollLeft + scroller.clientWidth / 2;
    const slides = scroller.children;
    let nearest = curSlot,
      best = Infinity;
    for (let i = 0; i < slides.length; i++) {
      const c = slides[i].offsetLeft + slides[i].clientWidth / 2;
      const d = Math.abs(c - center);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest < curSlot && prevT) {
      swipeAdvance = true;
      // Go to the adjacent track unconditionally — NOT player.prev(), whose
      // "restart current if >3s" semantics (right for the button) would replay
      // the same track while the carousel has already moved to the prev cover.
      player.jump(idx - 1);
    } else if (nearest > curSlot && nextT) {
      swipeAdvance = true;
      player.jump(idx + 1);
    } else {
      // stayed on the current cover — proximity may leave it a little off, so
      // ease it back to centre (smoothly, no jerk) only if it actually drifted.
      const el = scroller.children[curSlot];
      if (el) {
        const want = elCenterLeft(el);
        if (Math.abs(scroller.scrollLeft - want) > 6) {
          holdRecenter(380);
          scroller.scrollTo({ left: want, behavior: "smooth" });
        }
      }
    }
  }

  // React to a track change: a swipe is already in place (seamless re-centre);
  // a button press or auto-advance slides the new cover in.
  let lastId = null;
  let prevIdx = -1;
  // Re-run on a change to the current track OR its index. Toggling shuffle
  // reorders the queue and moves the current track to index 0 WITHOUT changing
  // its id — keying on the id alone (the old code) left the carousel aligned to
  // the OLD slot, and the stale scroll position then made onSettled fire a bogus
  // swipe-advance (the "enabling shuffle skips to the next song" bug). Handling
  // the reindex re-centres instead.
  $: if (scroller && idx >= 0 && $current) recenter($current.deezer_id, idx);
  async function recenter(id, index) {
    const idChanged = id !== lastId;
    const idxChanged = index !== prevIdx;
    if (!idChanged && !idxChanged) return;
    const first = lastId === null;
    const dir = index >= prevIdx ? 1 : -1;
    lastId = id;
    prevIdx = index;
    const wasSwipe = swipeAdvance;
    swipeAdvance = false;
    await tick();
    // Open, a finger swipe, or a same-track reindex (shuffle/reorder) -> just
    // snap to centre. A real track change (button / auto-advance) slides in.
    if (first || wasSwipe || !idChanged) centerCurrent();
    else slideToCurrent(dir);
  }
  onDestroy(() => {
    clearTimeout(settleTimer);
    clearTimeout(recenterTimer);
    clearTimeout(bgRetryTimer);
    clearTimeout(bgTimer);
    if (bgLoader) {
      bgLoader.onload = bgLoader.onerror = null;
      bgLoader.src = "";
      bgLoader = null;
    }
  });
</script>

<!-- The touch handlers implement swipe-down-to-dismiss on the whole sheet — a
     purely gestural affordance (the close button is the accessible path). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="m"
  class:dragging
  style={`transform:translateY(${dragY}px)`}
  on:touchstart|passive={onTouchStart}
  on:touchmove={onTouchMove}
  on:touchend={onTouchEnd}
  transition:fade={{ duration: 140 }}
>
  {#each bgLayers as layer (layer.id)}
    <div class="bg" style={`background-image:${cssUrl(layer.src)}`} in:fade={{ duration: 350 }}></div>
  {/each}
  <div class="scrim"></div>

  <header>
    <button class="ic" on:click={close} aria-label="Réduire"><Icon name="chevronDown" size={26} /></button>
    <span class="ctx">{$player.context?.kind === "flow" ? "Flow" : "En lecture"}</span>
    <button class="ic" on:click={() => (showQueue = true)} aria-label="File d'attente"><Icon name="queue" size={22} /></button>
  </header>

  <div class="body">
    <div class="cur-lyric" aria-hidden="true">
      {#if $currentLyricLine}
        {#key $currentLyricLine}
          <span in:fade={{ duration: 220 }}>{$currentLyricLine}</span>
        {/key}
      {/if}
    </div>

    <div
      class="scroller"
      bind:this={scroller}
      on:scroll|passive={onScroll}
      on:scrollend={onScrollEnd}
    >
      {#each slots as s (s.key)}
        <div class="slide"><Cover src={hiResCover(s.track.album?.cover, 1000)} alt={s.track.title} kind={s.track.podcast ? "podcast" : "album"} fallbackId={s.track.deezer_id} eager /></div>
      {/each}
    </div>

    <div class="info">
      <div class="txt">
        <button class="t" on:click={() => $current.album && go("/album/" + $current.album.deezer_id)}>{$current.title}</button>
        <button class="a" class:status={$playbackLabel} on:click={() => !$playbackLabel && $current.artist && go("/artist/" + $current.artist.deezer_id)}>{$playbackLabel || $current.artist?.name}</button>
      </div>
      <button class="fav" class:on={fav} on:click={() => toggleFavorite($current)} aria-label="Favori">
        <Icon name={fav ? "heartFilled" : "heart"} size={24} />
      </button>
    </div>

    <div class="seek">
      <span class="time">{fmtDuration($player.currentTime)}</span>
      <input type="range" min="0" max={$player.duration || 0} value={$player.currentTime} on:input={seek} style={`--p:${progress}%; --b:${bufferedPct}%`} />
      <span class="time">{fmtDuration($player.duration)}</span>
    </div>

    <div class="controls">
      <button class="sm" class:on={$player.shuffle} on:click={() => player.toggleShuffle()} aria-label="Aléatoire"><Icon name="shuffle" size={22} /></button>
      <button on:click={() => player.prev()} aria-label="Précédent"><Icon name="prev" size={30} /></button>
      <button class="pp" class:busy={$playbackBusy} on:click={() => player.toggle()} aria-label="Lecture/Pause"><Icon name={$playing ? "pause" : "play"} size={28} /></button>
      <button on:click={() => player.next()} aria-label="Suivant"><Icon name="next" size={30} /></button>
      <button class="sm" class:on={$player.repeat !== "off"} on:click={() => player.cycleRepeat()} aria-label="Répéter"><Icon name={repeatIcon} size={22} /></button>
    </div>

    <canvas class="viz" bind:this={viz} aria-hidden="true"></canvas>

    <div class="footer">
      <button class="sm more" on:click={trackMenu} aria-label="Plus d'options"><Icon name="moreVertical" size={22} /></button>
      {#if $current.podcast}
        <button
          class="sm"
          on:click={() => addMarkerAt($current, $player.currentTime)}
          aria-label="Marquer cette position"
        >
          <Icon name="bookmarkPlus" size={21} />
        </button>
      {/if}
      <button class="sm" on:click={() => openShare($current)} aria-label="Partager"><Icon name="share" size={20} /></button>
      <span class="grow"></span>
      <QualityMenu />
    </div>
  </div>

  {#if showQueue}
    <div class="sheet" transition:fade={{ duration: 120 }}>
      <div class="sheet-h">
        <span>File d'attente</span>
        <button class="ic" on:click={() => (showQueue = false)} aria-label="Fermer"><Icon name="chevronDown" size={22} /></button>
      </div>
      <div class="queue">
        <VirtualList items={q} bind:this={queueVL} let:item let:index>
          <div class="qitem" class:now={index === idx} class:past={index < idx}>
            <button on:click={() => { player.jump(index); showQueue = false; }}>
              <Cover src={item.album?.cover} alt="" size={42} kind="track" fallbackId={item.deezer_id} />
              <span class="qm"><span class="qt">{item.title}</span><span class="qa">{item.artist?.name}</span></span>
            </button>
          </div>
        </VirtualList>
      </div>
    </div>
  {/if}
</div>

<style>
  .m {
    position: fixed;
    inset: 0;
    z-index: 200;
    color: #fff;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #0b0910; /* opaque base: the page behind never shows through */
    transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .m.dragging {
    transition: none; /* follow the finger 1:1 while dragging */
  }
  .bg {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    filter: blur(60px) saturate(1.4) brightness(0.55);
    transform: scale(1.3);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(8, 6, 12, 0.4) 0%, rgba(8, 6, 12, 0.85) 100%);
  }
  header,
  .body {
    position: relative;
    z-index: 1;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    flex: none;
  }
  .ctx {
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.7);
  }
  .ic {
    color: rgba(255, 255, 255, 0.85);
    display: grid;
    place-items: center;
  }

  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    min-height: 0;
  }

  /* current synced lyric line, above the cover carousel (up to 3 lines) */
  .cur-lyric {
    min-height: 26px;
    margin: 0 22px 2px;
    /* grid stack: crossfading lines share one cell so the box grows to fit
       the tallest line instead of clipping long lyrics to a single row */
    display: grid;
    justify-items: center;
    align-items: center;
  }
  .cur-lyric span {
    grid-area: 1 / 1;
    text-align: center;
    font-size: 1.02rem;
    line-height: 1.3;
    font-weight: 800;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    overflow: hidden;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }

  /* native scroll-snap cover carousel */
  .scroller {
    display: flex;
    gap: 14px;
    overflow-x: auto;
    /* MANDATORY, not proximity. With proximity the browser often doesn't snap
       at all: the fling just stops wherever momentum ran out, and our own timer
       then had to notice and animate the cover back into place — a visible
       second movement after the finger had left, which is what made the swipe
       feel loose. Mandatory hands the settle to the browser's native snap
       animation, so the cover lands where the finger aimed, in one motion.
       `scroll-snap-stop: always` on the slides keeps a hard fling to one track
       at a time instead of shooting past to the far edge. */
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 10px 7.5%;
    overscroll-behavior-x: contain;
    /* Claim the horizontal axis outright. Without this the browser spends the
       first few pixels of every drag deciding whether the gesture is meant for
       this scroller or the sheet behind it, which reads as the swipe hesitating
       before it starts. The sheet's swipe-down-to-dismiss already ignores
       gestures that begin on the carousel, so there's nothing to give up. */
    touch-action: pan-x;
  }
  .scroller::-webkit-scrollbar {
    display: none;
  }
  .slide {
    flex: 0 0 85%;
    scroll-snap-align: center;
    scroll-snap-stop: always;
    aspect-ratio: 1 / 1;
  }
  .slide :global(.cover) {
    box-shadow: 0 22px 55px rgba(0, 0, 0, 0.5);
  }

  .info {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px 22px 4px;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .t {
    font-size: 1.35rem;
    font-weight: 800;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .a {
    font-size: 1rem;
    text-align: left;
    color: rgba(255, 255, 255, 0.75);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fav {
    color: rgba(255, 255, 255, 0.8);
    flex: none;
  }
  .fav.on {
    color: var(--accent-2);
  }

  .seek {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 22px;
  }
  .time {
    font-size: 0.72rem;
    color: rgba(255, 255, 255, 0.7);
    width: 38px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    height: 5px;
    border-radius: 3px;
    flex: 1;
    background: linear-gradient(90deg, #fff var(--p, 0%), rgba(255, 255, 255, 0.25) var(--p, 0%));
  }
  /* Buffered region as a lighter fill behind the played part. */
  .seek input[type="range"] {
    background: linear-gradient(
      90deg,
      #fff var(--p, 0%),
      rgba(255, 255, 255, 0.5) var(--p, 0%),
      rgba(255, 255, 255, 0.5) var(--b, 0%),
      rgba(255, 255, 255, 0.25) var(--b, 0%)
    );
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #fff;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 26px;
    padding: 8px 0 4px;
  }
  .controls button {
    color: #fff;
  }
  .controls .sm {
    color: rgba(255, 255, 255, 0.7);
  }
  .controls .sm.on {
    color: var(--accent);
  }
  .controls .pp {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: #fff;
    color: #111;
    display: grid;
    place-items: center;
    position: relative;
  }
  .controls .pp.busy::after {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--accent);
    animation: pp-spin 0.8s linear infinite;
  }
  @keyframes pp-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .a.status {
    color: var(--accent) !important;
  }

  .viz {
    width: 100%;
    height: 40px;
    opacity: 0.9;
    padding: 0 22px;
    box-sizing: border-box;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 22px 26px;
  }
  .footer .sm {
    color: rgba(255, 255, 255, 0.7);
  }
  .footer .grow {
    flex: 1;
  }

  /* queue bottom sheet */
  .sheet {
    position: absolute;
    inset: 0;
    z-index: 3;
    background: rgba(16, 12, 22, 0.97);
    backdrop-filter: blur(16px);
    display: flex;
    flex-direction: column;
  }
  .sheet-h {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    font-weight: 700;
    color: #fff;
  }
  .queue {
    margin: 0;
    padding: 0 10px 24px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .qitem button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px;
    border-radius: 8px;
    text-align: left;
    color: #fff;
  }
  .qitem.now .qt {
    color: var(--accent);
  }
  .qitem.past {
    opacity: 0.5;
  }
  .qm {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .qt,
  .qa {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qt {
    font-weight: 600;
    font-size: 0.92rem;
  }
  .qa {
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.6);
  }
</style>

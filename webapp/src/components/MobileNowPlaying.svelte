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
    openMenu,
  } from "../lib/stores.js";
  import { toggleFavorite, buildTrackMenu, userPlaylists } from "../lib/actions.js";
  import { duration as fmtDuration, hiResCover } from "../lib/format.js";
  import { createVisualizer } from "../lib/visualizer.js";
  import { currentLyricLine } from "../lib/lyrics.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import QualityMenu from "./QualityMenu.svelte";

  let showQueue = false;

  async function trackMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!$current) return;
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    await userPlaylists();
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

  // Background crossfade: each new cover is stacked ON TOP of the previous one
  // (which stays fully opaque) and fades in, then the old layers are dropped.
  // No opacity dip -> the page behind never shows through.
  let bgLayers = [];
  let bgN = 0;
  let bgTimer;
  $: setBg($current?.album?.cover || "");
  function setBg(url) {
    const top = bgLayers[bgLayers.length - 1];
    if (top && top.src === url) return;
    const id = ++bgN;
    bgLayers = [...bgLayers, { id, src: url }];
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => (bgLayers = bgLayers.filter((l) => l.id === id)), 420);
  }

  $: q = $player.queue;
  $: idx = $player.index;
  $: prevT = idx > 0 ? q[idx - 1] : null;
  $: nextT = idx >= 0 && idx < q.length - 1 ? q[idx + 1] : null;
  $: fav = $current && $favorites.has(String($current.deezer_id));
  $: progress = $player.duration ? ($player.currentTime / $player.duration) * 100 : 0;
  $: repeatIcon = $player.repeat === "one" ? "repeat1" : "repeat";

  function close() {
    immersiveOpen.set(false);
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
  // [prev?, current, next?] keyed by track id, so advancing the queue REUSES
  // each cover's DOM node (no reload, no fade flash). We then re-centre on the
  // reused current node, which cancels the reorder -> seamless, glitch-free.
  $: slots = (() => {
    const s = [];
    if (idx > 0) s.push(q[idx - 1]);
    if (idx >= 0) s.push(q[idx]);
    if (idx >= 0 && idx < q.length - 1) s.push(q[idx + 1]);
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
  function centerCurrent() {
    if (!scroller) return;
    const el = scroller.children[curSlot];
    if (!el) return;
    recentering = true;
    scroller.scrollTo({ left: elCenterLeft(el), behavior: "instant" });
    clearTimeout(settleTimer);
    setTimeout(() => (recentering = false), 60);
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
    recentering = true;
    scroller.scrollTo({ left: center - step * dir, behavior: "instant" });
    requestAnimationFrame(() => {
      scroller.scrollTo({ left: center, behavior: "smooth" });
      clearTimeout(settleTimer);
      setTimeout(() => (recentering = false), 420);
    });
  }
  function onScroll() {
    if (recentering) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(onSettled, 110);
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
      player.prev();
    } else if (nearest > curSlot && nextT) {
      swipeAdvance = true;
      player.next();
    } else {
      // stayed on the current cover — proximity may leave it a little off, so
      // ease it back to centre (smoothly, no jerk) only if it actually drifted.
      const el = scroller.children[curSlot];
      if (el) {
        const want = elCenterLeft(el);
        if (Math.abs(scroller.scrollLeft - want) > 6) {
          recentering = true;
          scroller.scrollTo({ left: want, behavior: "smooth" });
          setTimeout(() => (recentering = false), 380);
        }
      }
    }
  }

  // React to a track change: a swipe is already in place (seamless re-centre);
  // a button press or auto-advance slides the new cover in.
  let lastId = null;
  let prevIdx = -1;
  $: if ($current && scroller) recenter($current.deezer_id);
  async function recenter(id) {
    if (id === lastId) return;
    const first = lastId === null;
    lastId = id;
    const dir = idx >= prevIdx ? 1 : -1;
    prevIdx = idx;
    const wasSwipe = swipeAdvance;
    swipeAdvance = false;
    await tick();
    if (first || wasSwipe) centerCurrent(); // open / swipe -> no extra motion
    else slideToCurrent(dir); // button / auto-advance -> slide in
  }
  onDestroy(() => {
    clearTimeout(settleTimer);
    clearTimeout(bgTimer);
  });
</script>

<div class="m" transition:fade={{ duration: 140 }}>
  {#each bgLayers as layer (layer.id)}
    <div class="bg" style={`background-image:url(${layer.src})`} in:fade={{ duration: 350 }}></div>
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

    <div class="scroller" bind:this={scroller} on:scroll|passive={onScroll}>
      {#each slots as s (s.deezer_id)}
        <div class="slide"><Cover src={hiResCover(s.album?.cover, 1000)} alt={s.title} /></div>
      {/each}
    </div>

    <div class="info">
      <div class="txt">
        <button class="t" on:click={() => $current.album && go("/album/" + $current.album.deezer_id)}>{$current.title}</button>
        <button class="a" on:click={() => $current.artist && go("/artist/" + $current.artist.deezer_id)}>{$current.artist?.name}</button>
      </div>
      <button class="fav" class:on={fav} on:click={() => toggleFavorite($current)} aria-label="Favori">
        <Icon name={fav ? "heartFilled" : "heart"} size={24} />
      </button>
    </div>

    <div class="seek">
      <span class="time">{fmtDuration($player.currentTime)}</span>
      <input type="range" min="0" max={$player.duration || 0} value={$player.currentTime} on:input={seek} style={`--p:${progress}%`} />
      <span class="time">{fmtDuration($player.duration)}</span>
    </div>

    <div class="controls">
      <button class="sm" class:on={$player.shuffle} on:click={() => player.toggleShuffle()} aria-label="Aléatoire"><Icon name="shuffle" size={22} /></button>
      <button on:click={() => player.prev()} aria-label="Précédent"><Icon name="prev" size={30} /></button>
      <button class="pp" on:click={() => player.toggle()} aria-label="Lecture/Pause"><Icon name={$playing ? "pause" : "play"} size={28} /></button>
      <button on:click={() => player.next()} aria-label="Suivant"><Icon name="next" size={30} /></button>
      <button class="sm" class:on={$player.repeat !== "off"} on:click={() => player.cycleRepeat()} aria-label="Répéter"><Icon name={repeatIcon} size={22} /></button>
    </div>

    <canvas class="viz" bind:this={viz} aria-hidden="true"></canvas>

    <div class="footer">
      <button class="sm more" on:click={trackMenu} aria-label="Plus d'options"><Icon name="moreVertical" size={22} /></button>
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
      <ol class="queue">
        {#each q as t, i (t.deezer_id + ":" + i)}
          <li class:now={i === idx} class:past={i < idx}>
            <button on:click={() => { player.jump(i); showQueue = false; }}>
              <Cover src={t.album?.cover} alt="" size={42} />
              <span class="qm"><span class="qt">{t.title}</span><span class="qa">{t.artist?.name}</span></span>
            </button>
          </li>
        {/each}
      </ol>
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

  /* current synced lyric line, above the cover carousel */
  .cur-lyric {
    position: relative;
    min-height: 26px;
    margin: 0 22px 2px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cur-lyric span {
    position: absolute;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 1.02rem;
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    /* proximity (not mandatory) keeps the fling's inertia and only eases into
       the snap near the end, instead of braking abruptly on finger-up */
    scroll-snap-type: x proximity;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 10px 7.5%;
    overscroll-behavior-x: contain;
  }
  .scroller::-webkit-scrollbar {
    display: none;
  }
  .slide {
    flex: 0 0 85%;
    scroll-snap-align: center;
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
    list-style: none;
    margin: 0;
    padding: 0 10px 24px;
    overflow-y: auto;
  }
  .queue li button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px;
    border-radius: 8px;
    text-align: left;
    color: #fff;
  }
  .queue li.now .qt {
    color: var(--accent);
  }
  .queue li.past {
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

<script>
  // Desktop now-playing: two panes — a large cover with controls and a bar
  // visualizer on the left, the up-next queue / lyrics on the right.
  import { onDestroy, tick } from "svelte";
  import { push } from "svelte-spa-router";
  import { fade } from "svelte/transition";
  import { followScroll } from "../lib/scroll.js";
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
  } from "../lib/stores.js";
  import { toggleFavorite, buildTrackMenu, userPlaylists } from "../lib/actions.js";
  import { duration as fmtDuration, hiResCover, resolveCover } from "../lib/format.js";

  // Background art resolves through the offline cache so it shows in airplane
  // mode (CSS backgrounds can't fall back via Cover.svelte).
  $: bgSrc = resolveCover($offlineCovers, $current?.album?.cover) || "";
  import { createVisualizer, requestAnalyser } from "../lib/visualizer.js";
  import { currentLyricLine } from "../lib/lyrics.js";
  import Cover from "./Cover.svelte";
  import Lyrics from "./Lyrics.svelte";
  import Icon from "./Icon.svelte";
  import QualityMenu from "./QualityMenu.svelte";

  let tab = "queue";

  async function trackMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!$current) return;
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    await userPlaylists();
    openMenu(coords, buildTrackMenu($current, go));
  }

  $: q = $player.queue;
  $: idx = $player.index;

  // Keep the playing track in view in the queue list (first quarter): jump
  // instantly when the queue tab (re)opens, then follow smoothly as it plays.
  let queueBox;
  let firstQueueFollow = true;
  $: followQueue(tab, idx, $immersiveOpen);
  async function followQueue() {
    if (tab !== "queue" || !$immersiveOpen || idx < 0) return;
    await tick();
    const el = queueBox?.querySelector("li.now");
    if (!el) return;
    followScroll(queueBox, el, { ratio: 0.25, smooth: !firstQueueFollow });
    firstQueueFollow = false;
  }
  $: if (tab !== "queue" || !$immersiveOpen) firstQueueFollow = true;

  $: fav = $current && $favorites.has(String($current.deezer_id));
  $: progress = $player.duration ? ($player.currentTime / $player.duration) * 100 : 0;
  $: bufferedPct = $player.duration
    ? Math.min(100, Math.max(progress, ($buffered / $player.duration) * 100))
    : 0;
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

  // -- bar visualizer --------------------------------------------------------
  let canvas;
  let rafId = null;
  const drawBars = createVisualizer();

  function draw() {
    rafId = requestAnimationFrame(draw);
    drawBars(canvas);
  }
  function start() {
    if (rafId || (typeof document !== "undefined" && document.hidden)) return;
    requestAnalyser(); // wire Web Audio in now that the visualizer is on screen
    draw();
  }
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function onVisibility() {
    document.hidden ? stop() : start();
  }
  $: if ($immersiveOpen) start();
  else stop();
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", onVisibility);
  onDestroy(() => {
    stop();
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisibility);
  });
</script>

<div class="d" transition:fade={{ duration: 150 }}>
  <div class="bg" style={`background-image:url(${bgSrc})`}></div>
  <div class="scrim"></div>

  <header>
    <button class="ic" on:click={close} aria-label="Réduire"><Icon name="chevronDown" size={26} /></button>
    <span class="ctx">{$player.context?.kind === "flow" ? "Flow" : "En lecture"}</span>
    <span class="spacer"></span>
  </header>

  <div class="stage">
    <section class="main">
      <div class="cur-lyric" aria-hidden="true">
        {#if $currentLyricLine}
          {#key $currentLyricLine}
            <span in:fade={{ duration: 220 }}>{$currentLyricLine}</span>
          {/key}
        {/if}
      </div>

      <div class="cover">
        <div class="glow" style={`background-image:url(${bgSrc})`}></div>
        {#key $current.deezer_id}
          <div class="cover-fade" in:fade={{ duration: 260 }} out:fade={{ duration: 260 }}>
            <Cover src={hiResCover($current.album?.cover, 1500)} alt={$current.title} />
          </div>
        {/key}
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
        <input type="range" min="0" max={$player.duration || 0} value={$player.currentTime} on:input={seek} style={`--p:${progress}%; --b:${bufferedPct}%`} />
        <span class="time">{fmtDuration($player.duration)}</span>
      </div>

      <div class="controls">
        <button class="sm" class:on={$player.shuffle} on:click={() => player.toggleShuffle()} aria-label="Aléatoire"><Icon name="shuffle" size={22} /></button>
        <button on:click={() => player.prev()} aria-label="Précédent"><Icon name="prev" size={30} /></button>
        <button class="pp" on:click={() => player.toggle()} aria-label="Lecture/Pause"><Icon name={$playing ? "pause" : "play"} size={28} /></button>
        <button on:click={() => player.next()} aria-label="Suivant"><Icon name="next" size={30} /></button>
        <button class="sm" class:on={$player.repeat !== "off"} on:click={() => player.cycleRepeat()} aria-label="Répéter"><Icon name={repeatIcon} size={22} /></button>
      </div>

      <canvas class="viz" bind:this={canvas} aria-hidden="true"></canvas>

      <div class="footer">
        <div class="left">
          <div class="vol">
            <button class="sm" on:click={() => player.toggleMute()} aria-label="Muet"><Icon name={$player.muted || $player.volume === 0 ? "mute" : "volume"} size={19} /></button>
            <input class="vol-range" type="range" min="0" max="1" step="0.01" value={$player.muted ? 0 : $player.volume} on:input={(e) => player.setVolume(+e.target.value)} style={`--p:${($player.muted ? 0 : $player.volume) * 100}%`} aria-label="Volume" />
          </div>
        </div>
        <div class="right">
          <button class="sm" on:click={trackMenu} aria-label="Plus d'options"><Icon name="moreVertical" size={20} /></button>
          <QualityMenu />
        </div>
      </div>
    </section>

    <aside class="side">
      <div class="tabs">
        <button class:active={tab === "queue"} on:click={() => (tab = "queue")}>File d'attente</button>
        <button class:active={tab === "lyrics"} on:click={() => (tab = "lyrics")}>Paroles</button>
      </div>
      <div class="side-body" bind:this={queueBox}>
        {#if tab === "queue"}
          <ol class="queue">
            {#each q as t, i (t.deezer_id + ":" + i)}
              <li class:now={i === idx} class:past={i < idx}>
                <button on:click={() => player.jump(i)}>
                  <Cover src={t.album?.cover} alt="" size={42} />
                  <span class="qm"><span class="qt">{t.title}</span><span class="qa">{t.artist?.name}</span></span>
                  <span class="qd">{fmtDuration(t.duration)}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <Lyrics />
        {/if}
      </div>
    </aside>
  </div>
</div>

<style>
  .d {
    position: fixed;
    inset: 0;
    z-index: 200;
    color: #fff;
    overflow: hidden;
    /* Opaque base under the blurred cover art: on a skip the new art needs a
       moment to load, and the .bg layer is transparent until it does — without
       this base the semi-transparent scrim would let the page behind show
       through. Matches the mobile full-screen player. */
    background: #0b0910;
  }
  .bg {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    filter: blur(64px) saturate(1.5) brightness(0.62);
    transform: scale(1.25);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 85% 75% at 50% 45%, transparent 0%, rgba(8, 6, 12, 0.55) 100%),
      linear-gradient(180deg, rgba(8, 6, 12, 0.18) 0%, rgba(8, 6, 12, 0.5) 100%);
  }
  header,
  .stage {
    position: relative;
    z-index: 1;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
  }
  .ctx {
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.7);
  }
  .spacer {
    width: 26px;
  }
  .ic {
    color: rgba(255, 255, 255, 0.85);
    display: grid;
    place-items: center;
  }

  .stage {
    height: calc(100% - 64px);
    display: flex;
    align-items: stretch;
    gap: 28px;
    padding: 0 24px 28px;
    max-width: 1240px;
    margin: 0 auto;
  }
  .main {
    flex: 1;
    min-width: 0;
    max-width: 520px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 22px;
  }

  .cover {
    position: relative;
    width: min(46vh, 100%);
    aspect-ratio: 1 / 1;
    margin: 0 auto;
  }
  .glow {
    position: absolute;
    inset: -6%;
    background-size: cover;
    background-position: center;
    filter: blur(40px) saturate(1.6);
    opacity: 0.7;
    border-radius: 28%;
    z-index: -1;
  }
  /* keyed crossfade: old + new overlap during the transition */
  .cover-fade {
    position: absolute;
    inset: 0;
  }
  .cover :global(.cover) {
    box-shadow: 0 30px 70px rgba(0, 0, 0, 0.55);
  }

  /* current synced lyric line, above the cover (up to 3 lines) */
  .cur-lyric {
    min-height: 30px;
    /* grid stack: the crossfading lines share one cell, so the box grows to
       fit the tallest line instead of clipping long ones to a single row */
    display: grid;
    justify-items: center;
    align-items: center;
  }
  .cur-lyric span {
    grid-area: 1 / 1;
    text-align: center;
    font-size: 1.1rem;
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

  .info {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .t {
    font-size: 1.5rem;
    font-weight: 800;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .a {
    font-size: 1.05rem;
    text-align: left;
    color: rgba(255, 255, 255, 0.75);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t:hover,
  .a:hover {
    text-decoration: underline;
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
  /* Seek bar only (not volume): show the buffered region as a lighter fill. */
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
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 26px;
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
  .controls .pp:hover {
    transform: scale(1.05);
  }

  .viz {
    width: 100%;
    height: 48px;
    opacity: 0.9;
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
  }
  .footer .left {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .footer .sm {
    color: rgba(255, 255, 255, 0.7);
  }
  .footer .sm:hover {
    color: #fff;
  }
  .vol {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .vol-range {
    width: 110px;
    flex: none;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .side {
    width: 360px;
    flex: none;
    display: flex;
    flex-direction: column;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    overflow: hidden;
  }
  .tabs {
    display: flex;
    gap: 6px;
    padding: 12px 12px 6px;
  }
  .tabs button {
    padding: 7px 12px;
    border-radius: 999px;
    color: rgba(255, 255, 255, 0.7);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .tabs button.active {
    background: rgba(255, 255, 255, 0.16);
    color: #fff;
  }
  .side-body {
    flex: 1;
    overflow-y: auto;
    padding: 6px 10px 14px;
  }
  .queue {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .queue li button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px;
    border-radius: 8px;
    text-align: left;
    color: #fff;
  }
  .queue li button:hover {
    background: rgba(255, 255, 255, 0.08);
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
    flex: 1;
  }
  .qt,
  .qa {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qt {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .qa {
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.6);
  }
  .qd {
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.6);
    font-variant-numeric: tabular-nums;
  }

  /* Short viewports: the cover already scales with vh, but the fixed-height
     rows below it (controls, visualizer, quality/volume footer) can still
     overflow and get clipped. Degrade gracefully — drop the visualizer first,
     then tighten spacing — so the footer is never the thing that disappears. */
  @media (max-height: 780px) {
    .main {
      gap: 16px;
      justify-content: center;
    }
    .viz {
      display: none;
    }
  }
  @media (max-height: 660px) {
    .stage {
      padding: 0 24px 18px;
    }
    .main {
      gap: 12px;
    }
    .cover {
      width: min(34vh, 100%);
    }
    .t {
      font-size: 1.3rem;
    }
    .controls {
      gap: 20px;
    }
    .controls .pp {
      width: 56px;
      height: 56px;
    }
  }
  @media (max-height: 560px) {
    .stage {
      padding: 0 24px 14px;
    }
    .main {
      gap: 8px;
    }
    .cover {
      width: min(26vh, 100%);
    }
  }
</style>

<script>
  // Canvas host for the animation scenes.
  //
  // It owns four things the scenes should not have to care about: the canvas
  // and its device-pixel backing, the render loop and its frame-rate ceiling,
  // the palette, and the quality governor that steps the scene down a tier if a
  // device cannot keep up.
  //
  // ANALYSIS AND RENDERING ARE SEPARATE RATES on purpose. The engine ticks at
  // ~94 Hz off the audio thread and every tick calls scene.update() — that is
  // where a beat or an onset is caught, and dropping one because a frame was
  // busy would mean a missed flash. Painting happens on rAF, capped by the
  // user's setting. A scene therefore never misses an event and never paints
  // more often than the screen (or the user) wants.
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { current, offlineCovers } from "../lib/stores.js";
  import { resolveCover } from "../lib/format.js";
  import { dominantColor } from "../lib/color.js";
  import { api } from "../lib/api.js";
  import { subscribeFrames } from "../lib/audio/engine.js";
  import { createScene, levelFor } from "../lib/viz/index.js";
  import { createPalette } from "../lib/viz/palette.js";
  import { resolveTier, tierPreset, createGovernor } from "../lib/viz/quality.js";

  export let mode = "bars";
  export let quality = "auto";
  export let palette = "cover";
  export let intensity = 0.7;
  export let fps = 60;
  export let layout = "strip"; // bars: "strip" (centred) | "full" (grounded)
  export let active = true;
  // Playback stopped. The scene rides out a short fade and then stops entirely
  // — no rendering, no analysis — rather than sitting frozen on its last frame,
  // which is both ugly and a needless drain while nothing is playing.
  export let paused = false;
  // The projector window is fed by the bridge instead of subscribing to the
  // engine itself (there is no audio in that tab to analyse).
  export let external = false;
  export let coverRgb = null;

  let canvas;
  let box;
  let g = null;
  let scene = null;
  let pal = createPalette(palette);
  let tier = resolveTier(quality);
  let preset = tierPreset(tier);
  let governor = null;
  let unsub = null;
  let raf = 0;
  let ro = null;
  let cssW = 0;
  let cssH = 0;
  let lastPaint = 0;
  let reduced = false;
  let dimmed = false;
  let idle = false;
  let idleTimer = null;
  const FADE_MS = 600;

  // A 4K projector at devicePixelRatio 2 is 33 million pixels a frame; nothing
  // draws that in 16 ms and nobody can see the difference on a beamer. Cap the
  // total and let the backing store be coarser than the display when it has to.
  const MAX_PIXELS = 1920 * 1080 * 2.2;

  // The projector window has no analysis engine of its own, so a pushed frame
  // has to drive the palette as well as the scene.
  export function pushFrame(f) {
    if (!scene || !active) return;
    pal.update(f, f.dt);
    scene.update(f, f.dt);
  }

  function buildScene() {
    scene = createScene(mode, { preset, layout, intensity, reducedMotion: reduced });
    if (scene && cssW) scene.resize(cssW, cssH, preset);
  }

  function sizeCanvas() {
    if (!canvas || !box) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    cssW = w;
    cssH = h;
    let dpr = Math.min(window.devicePixelRatio || 1, preset.dpr);
    const px = w * h * dpr * dpr;
    if (px > MAX_PIXELS) dpr = Math.max(0.6, Math.sqrt(MAX_PIXELS / (w * h)));
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    g = canvas.getContext("2d", { alpha: true });
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A scene keeps trails by washing over the previous frame, so a resize —
    // which clears the backing store — has to start from a clean state rather
    // than from whatever garbage the new dimensions left.
    g.clearRect(0, 0, w, h);
    scene?.resize(w, h, preset);
  }

  function startLoop() {
    if (!raf) raf = requestAnimationFrame(paint);
  }
  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function paint(now) {
    raf = 0;
    if (idle) return;
    raf = requestAnimationFrame(paint);
    if (!scene || !g || !cssW) return;
    if (fps > 0) {
      // Allow a couple of ms of slack: at a 60 cap on a 60 Hz display, an exact
      // comparison drops every other frame whenever a vsync runs 0.1 ms early.
      if (now - lastPaint < 1000 / fps - 2) return;
    }
    lastPaint = now;
    const t0 = performance.now();
    scene.draw(g, cssW, cssH, pal.out);
    governor?.sample(performance.now() - t0, fps > 0 ? 1000 / fps : 16.7);
  }

  function onTier(next) {
    tier = next;
    preset = tierPreset(next);
    buildScene();
    sizeCanvas();
  }

  function attach() {
    if (unsub || idle || external || !active || mode === "off") return;
    unsub = subscribeFrames((f) => {
      pal.update(f, f.dt);
      scene?.update(f, f.dt);
    }, levelFor(mode));
  }
  function detach() {
    unsub?.();
    unsub = null;
  }

  // Keep drawing through the fade so the scene winds down instead of freezing,
  // then stop everything once it is invisible.
  function applyPaused(p, a) {
    clearTimeout(idleTimer);
    if (p || !a) {
      dimmed = true;
      idleTimer = setTimeout(goIdle, FADE_MS + 80);
    } else {
      dimmed = false;
      if (idle) {
        idle = false;
        startLoop();
      }
      attach();
    }
  }
  function goIdle() {
    idle = true;
    detach();
    stopLoop();
    // Leave nothing behind: a resume fades IN over a blank canvas rather than
    // over the last frame of the previous session.
    if (g && cssW) g.clearRect(0, 0, cssW, cssH);
  }

  onMount(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced = mq.matches;
    const onMq = () => {
      reduced = mq.matches;
      buildScene();
    };
    mq.addEventListener("change", onMq);
    governor = createGovernor(tier, onTier);
    buildScene();
    sizeCanvas();
    ro = new ResizeObserver(sizeCanvas);
    ro.observe(box);
    startLoop();
    return () => {
      mq.removeEventListener("change", onMq);
    };
  });

  onDestroy(() => {
    detach();
    clearTimeout(idleTimer);
    stopLoop();
    ro?.disconnect();
  });

  // Rebuild only for the three things that change a scene's SHAPE. Intensity
  // is pushed into the live scene instead: rebuilding on it would reset every
  // particle and envelope, which is exactly the frame the user is looking at
  // while they drag the slider in the settings preview.
  let builtKey = "";
  let lastQuality = null;
  $: rebuildIfNeeded(mode, quality, layout);
  function rebuildIfNeeded(m, q, l) {
    const key = `${m}|${q}|${l}`;
    if (key === builtKey) return;
    builtKey = key;
    // Re-resolve the tier only when the SETTING changed. Re-resolving on every
    // rebuild would undo the governor: it lowers the tier after a device fails
    // to keep up, and `auto` would resolve straight back to the optimistic
    // guess the next time the mode changed.
    if (q !== lastQuality) {
      lastQuality = q;
      tier = resolveTier(q);
      preset = tierPreset(tier);
      governor?.reset(tier);
    }
    buildScene();
    sizeCanvas();
    detach();
    attach();
  }
  $: scene?.setOptions?.({ intensity, reducedMotion: reduced });
  $: pal.setMode(palette);
  $: applyPaused(paused, active);

  // Cover colour. The projector is handed one over the bridge (the playing tab
  // has it cached already); everywhere else we resolve it from the track.
  $: if (coverRgb) pal.setCover(coverRgb);
  $: if (!external && !coverRgb && $current) loadCover($current);
  async function loadCover(t) {
    const url =
      resolveCover(get(offlineCovers), t.album?.cover) ||
      (t.deezer_id ? api.coverUrl(t.deezer_id) : "");
    if (!url) return;
    try {
      pal.setCover(await dominantColor(url));
    } catch {
      /* the palette keeps whatever it had */
    }
  }
</script>

<div class="viz-host" bind:this={box} class:hidden={mode === "off"}>
  <canvas bind:this={canvas} class:dim={dimmed} aria-hidden="true"></canvas>
</div>

<style>
  .viz-host {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .viz-host.hidden {
    display: none;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    opacity: 1;
    transition: opacity 0.6s ease;
  }
  canvas.dim {
    opacity: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    canvas {
      transition-duration: 0.2s;
    }
  }
</style>

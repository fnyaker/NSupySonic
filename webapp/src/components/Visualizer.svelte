<script>
  // Canvas host for the animation scenes.
  //
  // It owns five things the scenes should not have to care about: the canvas
  // and its device-pixel backing, the render loop and its frame-rate ceiling,
  // the palette, the quality governor that steps the scene down a tier if a
  // device cannot keep up, and the POST PASS — the bloom, fringe and grain that
  // turn what a scene drew into something that looks lit rather than inked
  // (lib/viz/post.js).
  //
  // The post pass is a SECOND, SMALL canvas over the first rather than a
  // composite onto it. Measured, the composite build cost 45 ms a frame against
  // 0.26 ms for the scene — all of it full-frame canvas traffic, none of it the
  // blur — and it would also have fed the bloom back into the trail the scene
  // washes over. See lib/viz/post.js.
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
  import { createGeometry } from "../lib/viz/geometry.js";
  import { createPalette } from "../lib/viz/palette.js";
  import { resolveTier, tierPreset, createGovernor } from "../lib/viz/quality.js";
  import { createPost, grainDataUrl, withPostGain, POST } from "../lib/viz/post.js";

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
  // The artwork, when there is one in front of the canvas. Scenes route their
  // best material around whatever box this element occupies instead of putting
  // it behind the cover — see lib/viz/geometry.js. It is an ELEMENT rather than
  // a set of numbers because the cover is 72vw on a phone, min(46vh, 100%) on a
  // desktop and absent on the projector, and none of that belongs in a scene.
  export let occluder = null;
  // "box" uses the element's own rectangle (the desktop cover already is the
  // artwork); "square" takes the largest centred square inside it, which is
  // what the mobile cover carousel actually shows.
  export let occluderShape = "box";

  let canvas;
  let box;
  let g = null;
  let bloomCanvas;
  let grainUrl = "";
  const post = createPost();
  let posting = false;
  // The pass can decide on its own that this device cannot afford it (see
  // post.js): that drops the two layers and leaves the scene exactly as it was,
  // rather than stepping the whole tier down and taking the particles with it.
  post.onDisabled = () => {
    posting = false;
    // The scene was built dimmed on the understanding that a halo would make
    // up the difference. With the halo gone it has to be rebuilt at full
    // strength, or the picture simply stays too dark.
    preset = tierPreset(tier);
    buildScene();
    sizeCanvas();
  };
  let scene = null;
  let pal = createPalette(palette);
  let tier = resolveTier(quality);
  // Dimmed by what the bloom will hand back — see SCENE_GAIN in post.js. The
  // scene has to be built knowing this, because a world reads `preset.glow`
  // once, when it is made.
  let preset = withPostGain(tierPreset(tier), tier);
  let governor = null;
  let unsub = null;
  let raf = 0;
  let ro = null;
  let cssW = 0;
  let cssH = 0;
  let lastPaint = 0;
  const geometry = createGeometry();
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
    scene.update(f, f.dt, geometry.out);
  }

  // The scene MODULE is fetched on demand (lib/viz/index.js), so building one
  // is asynchronous and the mode can change again while it is in flight. A
  // token per build is what keeps a late arrival from replacing a newer scene:
  // switching modes twice quickly used to be a race with no referee.
  let sceneToken = 0;
  function buildScene() {
    const token = ++sceneToken;
    const wanted = mode;
    const p = createScene(wanted, { preset, layout, intensity, reducedMotion: reduced });
    if (!p) {
      scene = null;
      return;
    }
    p.then((built) => {
      // Stale: a newer build started, or the component went away.
      if (token !== sceneToken || !built) return;
      scene = built;
      if (cssW) scene.resize(cssW, cssH, preset, geometry.out);
      scene.setOptions?.({ intensity, reducedMotion: reduced });
    }).catch(() => {
      // The chunk could not be fetched (offline mid-deploy, a failed update).
      // Leave the canvas empty rather than throwing: the next mode change, or
      // the next launch, tries again.
      if (token === sceneToken) scene = null;
    });
  }

  // The artwork's box, in canvas coordinates. Measured rather than assumed, and
  // only when the layout moves — `getBoundingClientRect` on two elements is
  // nothing once per resize and would be a real cost once per frame.
  function measureOccluder() {
    if (!box) return null;
    if (!occluder || typeof occluder.getBoundingClientRect !== "function") return null;
    const r = occluder.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    let { width, height } = r;
    let x = r.left - b.left;
    let y = r.top - b.top;
    if (occluderShape === "square") {
      const side = Math.min(width, height);
      x += (width - side) / 2;
      y += (height - side) / 2;
      width = height = side;
    }
    return { x, y, w: width, h: height };
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
    posting = post.resize(canvas, bloomCanvas, pw, ph, tier);
    ensureGrain();
    // A scene keeps trails by washing over the previous frame, so a resize —
    // which clears the backing store — has to start from a clean state rather
    // than from whatever garbage the new dimensions left.
    g.clearRect(0, 0, w, h);
    post.clear();
    geometry.set(w, h, measureOccluder());
    scene?.resize(w, h, preset, geometry.out);
  }

  // Built once per session, on the first tier that asks for it: it is a 96 px
  // PNG, and re-encoding it on every resize would be pure waste.
  function ensureGrain() {
    if (grainUrl || !posting || !POST[tier]?.grain) return;
    try {
      grainUrl = grainDataUrl();
    } catch {
      grainUrl = ""; // a canvas that will not export is not worth a broken layer
    }
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
    scene.draw(g, cssW, cssH, pal.out, geometry.out);
    post.run();
    // The post pass is inside the measured cost on purpose: if a device cannot
    // afford the bloom, dropping a tier is exactly the right answer and the
    // next tier down asks for less of it.
    governor?.sample(performance.now() - t0, fps > 0 ? 1000 / fps : 16.7);
  }

  function onTier(next) {
    tier = next;
    preset = withPostGain(tierPreset(next), next);
    buildScene();
    sizeCanvas();
  }

  function attach() {
    if (unsub || idle || external || !active || mode === "off") return;
    unsub = subscribeFrames((f) => {
      pal.update(f, f.dt);
      scene?.update(f, f.dt, geometry.out);
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
    // over the last frame of the previous session. Both buffers — the scene
    // keeps its trail in its own, and that is what the next frame would wash
    // over and bring back.
    if (g && cssW) {
      g.clearRect(0, 0, cssW, cssH);
      post.clear();
    }
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
    // Invalidate any scene still being fetched, so it cannot arrive after the
    // component has gone and hold the whole module graph alive.
    sceneToken++;
    scene = null;
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
  // The player binds its cover after this component has mounted, so the
  // occluder arrives late; and it changes size with the viewport, which the
  // observer catches. One owner for the subscription, here, rather than a
  // second one in onMount that would have to agree with it.
  let watched = null;
  $: if (ro && occluder !== watched) {
    if (watched) ro.unobserve(watched);
    watched = occluder;
    if (watched) ro.observe(watched);
    sizeCanvas();
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
  <!-- The bloom, drawn at a fifth of the size and stretched by the compositor.
       Hidden rather than unmounted when the tier has no post, so a tier change
       does not have to rebuild the element it is about to write to. -->
  <canvas
    bind:this={bloomCanvas}
    class="bloom"
    class:dim={dimmed}
    class:off={!posting}
    aria-hidden="true"
  ></canvas>
  {#if posting && grainUrl}
    <div class="grain" class:dim={dimmed} style="background-image:url({grainUrl})"></div>
  {/if}
</div>

<style>
  .viz-host {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    /* The bloom blends with the scene under it and with nothing else on the
       page: without this, `mix-blend-mode` would reach through to whatever the
       player happens to be sitting on. */
    isolation: isolate;
  }
  .viz-host.hidden {
    display: none;
  }
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    opacity: 1;
    transition: opacity 0.6s ease;
  }
  canvas.dim,
  .grain.dim {
    opacity: 0;
  }
  /* The bloom is a fifth of the frame, stretched back over it. The browser's
     own scaling is a smooth interpolation, which is why a 3 px blur down there
     arrives as a soft 15 px halo up here — the upscale is part of the effect,
     not a compromise for it. `screen` rather than `plus-lighter` because it is
     supported everywhere and over a dark scene the two are near enough. */
  canvas.bloom {
    mix-blend-mode: screen;
    will-change: transform;
  }
  canvas.bloom.off {
    display: none;
  }
  /* Grain, as a tiled layer the compositor owns. It is nudged by a fraction of
     a tile on a slow loop: static grain reads as a dirty lens, moving grain
     reads as film, and a transform is the one animation that costs the main
     thread nothing. */
  .grain {
    position: absolute;
    inset: -96px;
    background-repeat: repeat;
    mix-blend-mode: screen;
    opacity: 0.05;
    pointer-events: none;
    animation: grain-drift 0.6s steps(6, end) infinite;
    transition: opacity 0.6s ease;
    will-change: transform;
  }
  @keyframes grain-drift {
    0% { transform: translate3d(0, 0, 0); }
    20% { transform: translate3d(-13px, 7px, 0); }
    40% { transform: translate3d(9px, -11px, 0); }
    60% { transform: translate3d(-5px, -6px, 0); }
    80% { transform: translate3d(11px, 4px, 0); }
    100% { transform: translate3d(0, 0, 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    canvas {
      transition-duration: 0.2s;
    }
    /* A field of noise jumping six times a second is exactly what this setting
       exists to stop. The texture stays; the movement goes. */
    .grain {
      animation: none;
    }
  }
</style>

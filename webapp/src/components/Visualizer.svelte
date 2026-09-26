<script>
  // Canvas host for the animation scenes.
  //
  // It owns what the scenes should not have to care about: the canvases and
  // their device-pixel backing, the render loop and its frame-rate ceiling, the
  // palette, the WebGL renderer, the quality governor, and — for the two canvas
  // scenes only — the 2D post pass.
  //
  // TWO KINDS OF SCENE, TWO CANVASES. Every full-screen mode except the
  // oscilloscope is drawn by the WebGL2 engine (lib/viz/scenes/gl.js), which
  // does its own bloom, tone map and grain on the GPU. The oscilloscope draws
  // the samples themselves on a 2D canvas, and a device with no WebGL2 gets the
  // spectrum on a 2D canvas instead of any GL scene. A canvas can only ever
  // have ONE context type, so there are two elements and the scene's `kind`
  // decides which one is shown. The WebGL renderer belongs to its canvas, not
  // to the scene: a mode change or a tier change rebuilds the scene and keeps
  // every shader already compiled.
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
  import { resolveCover, loResCover } from "../lib/format.js";
  import { dominantColor } from "../lib/color.js";
  import { api } from "../lib/api.js";
  import { subscribeFrames } from "../lib/audio/engine.js";
  import { createScene, createFallback, levelFor, needsWave } from "../lib/viz/index.js";
  import { createGeometry } from "../lib/viz/geometry.js";
  import { createPalette } from "../lib/viz/palette.js";
  import { resolveTier, tierPreset, createGovernor, TIERS } from "../lib/viz/quality.js";
  import { createPost, grainDataUrl, withPostGain, POST } from "../lib/viz/post.js";

  export let mode = "bars";
  export let quality = "auto";
  export let palette = "cover";
  export let intensity = 0.7;
  export let fps = 60;
  export let layout = "strip"; // bars: "strip" (transparent, in the player) | "full"
  export let active = true;
  // Playback stopped. The scene rides out a short fade and then stops entirely
  // — no rendering, no analysis — rather than sitting frozen on its last frame,
  // which is both ugly and a needless drain while nothing is playing.
  export let paused = false;
  // The projector window is fed by the bridge instead of subscribing to the
  // engine itself (there is no audio in that tab to analyse).
  export let external = false;
  export let coverRgb = null;
  // The projector is told the artwork's URL over the bridge; everywhere else it
  // is resolved from the playing track.
  export let coverUrl = "";
  // The artwork, when there is one in front of the canvas. Scenes route their
  // best material around whatever box this element occupies instead of putting
  // it behind the cover — see lib/viz/geometry.js.
  export let occluder = null;
  // "box" uses the element's own rectangle (the desktop cover already is the
  // artwork); "square" takes the largest centred square inside it, which is
  // what the mobile cover carousel actually shows.
  export let occluderShape = "box";
  // The oscilloscope's own two settings.
  export let scopeOrientation = "horizontal";
  export let scopeColour = "duo";
  // The smart engine's world ("auto" = the genre decides) and the flash policy.
  export let world = "auto";
  export let flash = "soft";

  let canvas; // 2D
  let glCanvas; // WebGL2
  let box;
  let g = null;
  let bloomCanvas;
  let grainUrl = "";
  const post = createPost();
  let posting = false;
  let renderer = null;
  let glFailed = false;
  let kind = "2d";
  // The 2D pass can decide on its own that this device cannot afford it (see
  // post.js): that drops the two layers and leaves the scene exactly as it was,
  // rather than stepping the whole tier down and taking the particles with it.
  post.onDisabled = () => {
    posting = false;
    preset = tierPreset(tier);
    buildScene();
    sizeCanvas();
  };
  let scene = null;
  let pal = createPalette(palette);
  let tier = resolveTier(quality);
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
  let starved = 0;
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

  // The GL renderer, built on first use and kept for the life of the canvas.
  // Null — for good — on a device with no WebGL2. Built through the scene so
  // the engine stays in the scene's chunk (see scenes/gl.js#makeRenderer).
  function ensureRenderer(built) {
    if (renderer || glFailed || !glCanvas) return renderer;
    renderer = built.makeRenderer(glCanvas, {
      // A lost context draws nothing until it is restored; the scene keeps
      // reading the music meanwhile and resumes on the restored one.
      onRestored: () => {
        sizeCanvas();
        if (scene?.kind === "gl") scene.attach(renderer);
      },
    });
    if (!renderer) glFailed = true;
    return renderer;
  }

  function sceneOpts() {
    return {
      preset,
      layout,
      intensity,
      reducedMotion: reduced,
      orientation: scopeOrientation,
      colour: scopeColour,
      world,
      flash,
      fps,
    };
  }

  // The scene MODULE is fetched on demand (lib/viz/index.js), so building one
  // is asynchronous and the mode can change again while it is in flight. A
  // token per build is what keeps a late arrival from replacing a newer scene.
  let sceneToken = 0;
  function buildScene() {
    const token = ++sceneToken;
    const p = createScene(mode, sceneOpts());
    if (!p) {
      replaceScene(null);
      return;
    }
    p.then(async (built) => {
      if (token !== sceneToken || !built) return;
      if (built.kind === "gl") {
        const r = ensureRenderer(built);
        if (!r) {
          // No WebGL2 here: the mode's canvas version (the scope, or the
          // spectrum bars for every other mode), rather than nothing.
          built.dispose?.();
          const fb = await createFallback(mode, sceneOpts()).catch(() => null);
          if (token !== sceneToken) return;
          replaceScene(fb);
          return;
        }
        built.attach(r);
      }
      replaceScene(built);
    }).catch(() => {
      // The chunk could not be fetched (offline mid-deploy, a failed update).
      // Leave the canvas empty rather than throwing: the next mode change, or
      // the next launch, tries again.
      if (token === sceneToken) replaceScene(null);
    });
  }

  function replaceScene(next) {
    if (scene && scene !== next) scene.dispose?.();
    scene = next;
    kind = next?.kind === "gl" ? "gl" : "2d";
    if (!next) return;
    sizeCanvas();
    next.setOptions?.(sceneOptions());
    if (next.kind === "gl" && lastCoverUrl) next.setCover?.(lastCoverUrl);
  }

  // The artwork's box, in canvas coordinates. Measured rather than assumed, and
  // only when the layout moves.
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
    if (!box) return;
    const w = box.clientWidth;
    const h = box.clientHeight;
    if (!w || !h) return;
    cssW = w;
    cssH = h;
    let dpr = Math.min(window.devicePixelRatio || 1, preset.dpr);
    const px = w * h * dpr * dpr;
    if (px > MAX_PIXELS) dpr = Math.max(0.6, Math.sqrt(MAX_PIXELS / (w * h)));
    geometry.set(w, h, measureOccluder());
    if (kind === "gl") {
      // The GL scene sizes its own canvas (and its render targets, at whatever
      // scale the dynamic-resolution governor has settled on).
      posting = false;
      scene?.resize(w, h, preset, geometry.out, dpr);
      return;
    }
    if (!canvas) return;
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
    // which clears the backing store — has to start from a clean state.
    g.clearRect(0, 0, w, h);
    post.clear();
    scene?.resize(w, h, preset, geometry.out);
  }

  // Built once per session, on the first tier that asks for it.
  function ensureGrain() {
    if (grainUrl || !posting || !POST[tier]?.grain) return;
    try {
      grainUrl = grainDataUrl();
    } catch {
      grainUrl = "";
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
    if (!scene || !cssW) return;
    if (fps > 0) {
      // Allow a couple of ms of slack: at a 60 cap on a 60 Hz display, an exact
      // comparison drops every other frame whenever a vsync runs 0.1 ms early.
      if (now - lastPaint < 1000 / fps - 2) return;
    }
    lastPaint = now;
    if (kind === "gl") {
      scene.draw(null, cssW, cssH, pal.out, geometry.out);
      // The GL scene steers its own resolution; only when it has run out of
      // room to (pinned at its floor and still missing frames) does the whole
      // tier step down.
      if (scene.starved) {
        if (++starved > 240) {
          starved = 0;
          const i = TIERS.indexOf(tier);
          if (i > 0) onTier(TIERS[i - 1]);
        }
      } else starved = 0;
      return;
    }
    if (!g) return;
    const t0 = performance.now();
    scene.draw(g, cssW, cssH, pal.out, geometry.out);
    post.run();
    governor?.sample(performance.now() - t0, fps > 0 ? 1000 / fps : 16.7);
  }

  function onTier(next) {
    tier = next;
    preset = withPostGain(tierPreset(next), next);
    governor?.reset(next);
    buildScene();
    detach();
    attach();
  }

  function attach() {
    if (unsub || idle || external || !active || mode === "off") return;
    unsub = subscribeFrames(
      (f) => {
        pal.update(f, f.dt);
        scene?.update(f, f.dt, geometry.out);
      },
      levelFor(mode),
      // The raw per-channel samples, for the scope and for nothing else.
      { wave: needsWave(mode) ? preset.scope?.buffer || 4096 : 0 }
    );
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
    if (g && cssW) {
      g.clearRect(0, 0, cssW, cssH);
      post.clear();
    }
    renderer?.clear();
  }

  onMount(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced = mq.matches;
    const onMq = () => {
      reduced = mq.matches;
      scene?.setOptions?.(sceneOptions());
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
    scene?.dispose?.();
    scene = null;
    renderer?.dispose();
    renderer = null;
  });

  // Rebuild only for the things that change a scene's SHAPE. Intensity, the
  // pinned world and the flash policy are pushed into the live scene instead:
  // rebuilding would reset every envelope, which is exactly the frame the user
  // is looking at while they drag a slider in the settings preview.
  let builtKey = "";
  let lastQuality = null;
  $: rebuildIfNeeded(mode, quality, layout);
  function rebuildIfNeeded(m, q, l) {
    const key = `${m}|${q}|${l}`;
    if (key === builtKey) return;
    builtKey = key;
    // Re-resolve the tier only when the SETTING changed. Re-resolving on every
    // rebuild would undo the governor.
    if (q !== lastQuality) {
      lastQuality = q;
      tier = resolveTier(q);
      preset = withPostGain(tierPreset(tier), tier);
      governor?.reset(tier);
    }
    buildScene();
    detach();
    attach();
  }
  // The player binds its cover after this component has mounted, so the
  // occluder arrives late; and it changes size with the viewport, which the
  // observer catches.
  let watched = null;
  $: if (ro && occluder !== watched) {
    if (watched) ro.unobserve(watched);
    watched = occluder;
    if (watched) ro.observe(watched);
    sizeCanvas();
  }
  function sceneOptions() {
    return {
      intensity,
      reducedMotion: reduced,
      orientation: scopeOrientation,
      colour: scopeColour,
      world,
      flash,
      fps,
    };
  }
  $: applyOptions(intensity, reduced, scopeOrientation, scopeColour, world, flash, fps);
  function applyOptions() {
    scene?.setOptions?.(sceneOptions());
  }
  $: pal.setMode(palette);
  $: applyPaused(paused, active);

  // The artwork: its dominant colour for the palette, and — for the worlds
  // that draw WITH it — a small copy as a texture. The projector is handed
  // both over the bridge; everywhere else they are resolved from the track.
  let lastCoverUrl = "";
  function useCover(url) {
    if (!url || url === lastCoverUrl) return;
    lastCoverUrl = url;
    if (scene?.kind === "gl") scene.setCover?.(url);
  }
  $: if (coverRgb) pal.setCover(coverRgb);
  $: if (coverUrl) useCover(loResCover(coverUrl, 256) || coverUrl);
  $: if (!external && !coverRgb && $current) loadCover($current);
  async function loadCover(t) {
    const url =
      resolveCover(get(offlineCovers), t.album?.cover) ||
      (t.deezer_id ? api.coverUrl(t.deezer_id) : "");
    if (!url) return;
    useCover(loResCover(url, 256) || url);
    try {
      pal.setCover(await dominantColor(url));
    } catch {
      /* the palette keeps whatever it had */
    }
  }
</script>

<div class="viz-host" bind:this={box} class:hidden={mode === "off"}>
  <canvas bind:this={canvas} class:dim={dimmed} class:off={kind !== "2d"} aria-hidden="true"></canvas>
  <canvas bind:this={glCanvas} class:dim={dimmed} class:off={kind !== "gl"} aria-hidden="true"></canvas>
  <!-- The 2D scenes' bloom, drawn at a fifth of the size and stretched by the
       compositor. The GL scenes do their own, on the GPU. -->
  <canvas
    bind:this={bloomCanvas}
    class="bloom"
    class:dim={dimmed}
    class:off={!posting || kind !== "2d"}
    aria-hidden="true"
  ></canvas>
  {#if posting && grainUrl && kind === "2d"}
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
  canvas.off {
    display: none;
  }
  canvas.dim,
  .grain.dim {
    opacity: 0;
  }
  /* The 2D bloom is a fifth of the frame, stretched back over it. */
  canvas.bloom {
    mix-blend-mode: screen;
    will-change: transform;
  }
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
    .grain {
      animation: none;
    }
  }
</style>

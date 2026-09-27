// The GL scene: the musical reading, turned into what the worlds draw with.
//
// Every full-screen mode is this one object with a different POLICY for which
// world is on screen:
//
//   smart     the genre decides (the classifier's family, or a tag, resolved
//             through lib/viz/skins.js), unless the user pinned a world;
//   pulse     always the `pulse` world;
//   aurora    always the `aurora` world;
//   bars      the `spectrum` world, full-screen or as the transparent strip.
//
// TWO RATES, AND WHY. `update` runs on every analysis frame (~94 Hz, off the
// audio thread): that is where the music is read, so no kick is ever missed
// because a frame was busy. `draw` runs at the display's rate under the user's
// cap: that is where every moving thing ADVANCES, by the time that actually
// passed between two pictures. The old canvas scenes integrated their motion in
// `update`, so on the projector — fed at 45 Hz and painted at 60 — one frame in
// four repeated the last one's state, which is judder you can see on a slow
// pan. Here the clocks are extrapolated to the instant of the draw and the
// envelopes are computed from event STAMPS at that instant, so motion is as
// smooth at 45 Hz of analysis as at 94.
//
// NOTHING HARD-SWITCHES. A change of genre builds the new world (its module is
// fetched on demand and its program compiled, in parallel where the driver can)
// and only when it is READY does the dissolve start — the old world keeps
// playing meanwhile, so a first visit to a world is never a black frame. The
// dissolve lasts one bar and burns the new picture through the old one from the
// middle out (gl/postfx.js#DISSOLVE_FS).
//
// FLASHES ARE THE ENGINE'S, NOT THE WORLDS'. A world asks for one; this file
// decides whether it happens. At most three a second whatever the music does —
// the WCAG general-flash threshold, and the line above which a strobe on a
// projector in a room full of people is a medical risk rather than a style —
// scaled by the user's setting, and none at all under prefers-reduced-motion.
//
// The one exception is "unleashed", which the settings only offer behind a
// photosensitivity warning the user has to accept. It is a different POLICY,
// not a brighter "full": the worlds only ask for a flash on a drop, which is
// once a minute, so lifting the cap alone would change nothing. Here the
// engine itself runs the strobe a lighting desk would — every main kick of a
// drop, a harder one on a big kick, the snares of a build accelerating into
// it — up to ten a second (past that, flashes with this decay merge into one
// continuous light and stop reading as flashes at all). prefers-reduced-motion
// still wins: an operating-system setting is the stronger signal, and it may
// well be the person the warning is about who set it.
//
// THE ARITHMETIC IS RUST (webapp/rhythm/src/viz_scene.rs, through
// lib/viz/core.js#SceneCore): the musical reading every world is timed by, the
// spectrum's max-hold and release, the band shares, the history row, the
// clocks extrapolated to the instant of the picture and the uniform block,
// packed at glsl.js's own offsets. This file keeps the POLICY — which world,
// the dissolve, the flashes, the resolution — and the drivers and the WebGL
// calls. The JavaScript the Rust replaced is kept as test/reference/gl.js, and
// test/vizcore.test.mjs holds the two to the same block, picture by picture.

import { bindMusical } from "../musical.js";
import {
  MUSIC_FLOATS,
  MUSIC_OFFSET as O,
  worldFragment,
  particleVertex,
  particleFragment,
  FULLSCREEN_VS,
} from "../gl/glsl.js";
import { createRenderer } from "../gl/renderer.js";
import { loadWorld, hasWorld } from "../worlds/index.js";
import { skinFor, skinId } from "../skins.js";
import { clamp } from "../util.js";
import { SceneCore, SCENE_FLAGS, vizCore } from "../core.js";

// The WCAG 2.x general flash threshold: no more than three flashes in any one
// second. Enforced as a minimum interval between flash ONSETS.
export const FLASH_MIN_INTERVAL = 1 / 3;
// ...and the unleashed strobe's: ten a second.
export const STROBE_MIN_INTERVAL = 1 / 10;
// A flash's own decay, in SECONDS on purpose — how long a flash stays on the
// retina is physiology, not music.
const FLASH_DECAY = 0.09;
const FLASH_GAIN = { off: 0, soft: 0.4, full: 1, unleashed: 1.25 };
// The dissolve between two worlds: one bar, within reason.
const DISSOLVE_MIN = 0.9;
const DISSOLVE_MAX = 3.2;
// The first world fades up from black over this many beats.
const FIRST_FADE_BEATS = 2;
const TIERS = ["low", "medium", "high", "ultra"];

function sameOrigin(u) {
  if (!u || u.startsWith("blob:") || u.startsWith("data:")) return true;
  try {
    return new URL(u, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
}

export function createGLScene(opts = {}) {
  const o = {
    preset: opts.preset || {},
    intensity: opts.intensity ?? 0.7,
    reducedMotion: !!opts.reducedMotion,
    // The mode's own world (pulse / aurora / spectrum), or null for smart.
    fixed: opts.fixed || null,
    // The user's pinned world for smart mode, or "auto".
    world: opts.world || "auto",
    layout: opts.layout || "full",
    flash: opts.flash || "soft",
    fps: opts.fps ?? 60,
    // The oscilloscope's two settings, read live by its driver.
    orientation: opts.orientation || "horizontal",
    colour: opts.colour || "duo",
  };
  // Injectable, so the render bench can run the scene on a simulated clock and
  // photograph an exact instant of an exact bar.
  const clock =
    opts.now ||
    (() => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000);

  let renderer = null;
  // The arithmetic's own state lives in the core; `m` is the reading every
  // driver is handed, refreshed in place after each analysis frame.
  const core = opts.core || vizCore();
  if (!core) throw new Error("gl: the animation core is not loaded");
  const sc = new SceneCore(core, O, MUSIC_FLOATS);
  const { m, write: readFrame, pull } = bindMusical(sc);
  const P = sc.L.pack;
  const Q = sc.L.prep;
  // What the last `prepare` said, for the grade and the drivers.
  let dynSmooth = 1;

  // --- worlds -----------------------------------------------------------------
  let cur = null; // on screen
  let prev = null; // leaving, during a dissolve
  let pending = null; // loading or compiling
  let dissolve = 1;
  let dissolveLen = 2;
  let seed = 0;
  let firstFade = 0;
  let wantKey = "";

  // --- timing -------------------------------------------------------------------
  let lastDrawAt = 0;
  let clockSeconds = 0;
  // Extrapolated at draw time.
  let beatsNow = 0;
  let barsNow = 0;
  let phrasesNow = 0;

  // --- flash ----------------------------------------------------------------------
  let flash = 0;
  let lastFlashAt = -1e9;

  // --- geometry -------------------------------------------------------------------
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let geomRef = null;

  // --- dynamic resolution ---------------------------------------------------------
  // The strip is a 40 px band under the player's controls. At full resolution
  // it costs less than a full-screen world at its floor, and its capsules are
  // a few pixels wide: at a governed scale the upscale smears every edge into
  // the next, which is exactly the soft, dated look it must not have.
  let gqFor = null;
  let gqStrip = null;
  const gq = () => {
    const g = o.preset.gl || {};
    if (o.layout !== "strip") return g;
    if (gqFor !== g) {
      gqFor = g;
      gqStrip = { ...g, scale: 1, min: 1, max: 1 };
    }
    return gqStrip;
  };
  let scale = 1;
  let scaleAt = 0;
  let starved = false;
  const intervals = new Float32Array(32);
  // The median is read from a sorted COPY, made in place: without a GPU timer
  // (Firefox and Safari have none) this runs on every picture, and
  // `Array.from(...).sort(cmp)` there was the most expensive line of the draw.
  const sortedIntervals = new Float32Array(32);
  let intervalN = 0;

  // What a driver is handed each frame, allocated once. `spec` is the smoothed
  // spectrum (128 bins, 0..1) for the worlds that do per-band work on the CPU —
  // a view on the core's memory, re-read every picture.
  const clocks = {
    beats: 0, bars: 0, phrases: 0, dt: 0, aspect: 16 / 9, spec: sc.specSmooth(), pitch: 0.5, melody: 0,
    hole: [0, 0, 0, 0],
    // The frame in CSS pixels, for a driver that sizes something in pixels
    // (the scope puts one column of its trace on each).
    width: 0, height: 0,
  };

  // --- the artwork ------------------------------------------------------------------
  let coverUrl = "";
  let coverImg = null;

  function now() {
    return clock();
  }

  function requestFlash(power) {
    const g = o.reducedMotion ? 0 : FLASH_GAIN[o.flash] ?? FLASH_GAIN.soft;
    if (g <= 0 || !(power > 0)) return;
    const gap = o.flash === "unleashed" ? STROBE_MIN_INTERVAL : FLASH_MIN_INTERVAL;
    if (clockSeconds - lastFlashAt < gap) return;
    lastFlashAt = clockSeconds;
    flash = Math.max(flash, clamp(power, 0, 1) * g);
  }

  // The unleashed strobe (see the header). Read off the event STAMPS at the
  // render clock, like a driver's, so an event that lived for one analysis
  // frame between two pictures is still seen exactly once.
  let seenMain = m.stamp.main;
  let seenSnare = m.stamp.snare;
  let seenDrop = m.stamp.drop;
  function strobe() {
    const st = m.stamp;
    const main = st.main !== seenMain;
    const snare = st.snare !== seenSnare;
    const drop = st.drop !== seenDrop;
    seenMain = st.main;
    seenSnare = st.snare;
    seenDrop = st.drop;
    if (o.flash !== "unleashed" || o.reducedMotion) return;
    const p = strobePower(m, main, snare, drop);
    if (p > 0) requestFlash(p);
  }

  // --- stages ---------------------------------------------------------------------
  // A stage is one world instance: its module, its program, its target, its
  // driver. Two genres that share a world are two stages sharing a PROGRAM
  // (the cache key is the world id), so the second one costs no compile.
  function makeStage(key, worldId, skin) {
    const st = {
      key,
      worldId,
      skin,
      def: null,
      driver: null,
      prog: null,
      parts: null,
      target: null,
      params: null,
      packed: new Float32Array(16),
      state: new Float32Array(8),
      ev: new Float32Array(32),
      // A world's own CPU-side data (see `data` in its definition): the texture
      // it lives in, the array its driver points `src` at, and whether that
      // changed since the last upload.
      data: null,
      dead: false,
      failed: false,
      // What this picture's uniform setter reads (see `drawStage`).
      share: 0,
      energy: 1,
      speed: 1,
      fill: null,
    };
    // The setter drawWorld is handed, and the views it uploads, built once:
    // per picture there is nothing to allocate, only three numbers to set.
    const p0 = st.packed.subarray(0, 4);
    const p1 = st.packed.subarray(4, 8);
    const p2 = st.packed.subarray(8, 12);
    const p3 = st.packed.subarray(12, 16);
    const s0 = st.state.subarray(0, 4);
    const s1 = st.state.subarray(4, 8);
    st.fill = (h) => {
      h.f("uFade", st.share);
      h.f("uEnergy", st.energy);
      h.f("uSpeed", st.speed);
      h.v4a("uP0", p0);
      h.v4a("uP1", p1);
      h.v4a("uP2", p2);
      h.v4a("uP3", p3);
      h.v4a("uS0", s0);
      h.v4a("uS1", s1);
      h.v4a("uEv", st.ev);
    };
    loadWorld(worldId)
      .then((def) => {
        if (st.dead) return;
        st.def = def;
        if (renderer) build(st);
      })
      .catch(() => {
        st.failed = true;
      });
    return st;
  }

  function build(st) {
    const def = st.def;
    if (!def || !renderer || st.prog) return;
    const names = Object.keys(def.params || {});
    const params = { ...(def.params || {}) };
    const sp = st.skin?.p || {};
    for (const k of names) if (Number.isFinite(sp[k])) params[k] = sp[k];
    st.params = params;
    for (let i = 0; i < 16; i++) st.packed[i] = i < names.length ? +params[names[i]] || 0 : 0;
    const defines = paramDefines(names);
    st.prog = renderer.program(
      "w:" + def.id,
      FULLSCREEN_VS,
      worldFragment(def.fragment, def.uses || [], defines)
    );
    if (def.particles) {
      const pdef = def.particles;
      st.parts = {
        h: renderer.program(
          "p:" + def.id,
          particleVertex(pdef.vertex, pdef.uses || [], defines),
          particleFragment(pdef.fragment, pdef.uses || [], defines)
        ),
        count: 0,
        max: typeof pdef.count === "function" ? pdef.count(o.preset, params) : pdef.count || 0,
        // `exact`: every instance is a piece of one thing (the scope's trace),
        // so the tier's particle share does not apply. `max`: blend by MAX.
        exact: !!pdef.exact,
        blendMax: !!pdef.blendMax,
      };
    }
    st.target = renderer.worldTarget(!!def.feedback);
    if (def.data) st.data = { tex: renderer.dataTexture(def.data.width, def.data.height), src: null, dirty: false };
    st.driver = def.create
      ? def.create({
          params,
          preset: o.preset,
          skin: st.skin,
          opts: o,
          flash: requestFlash,
          state: st.state,
          ev: st.ev,
          data: st.data,
          core: vizCore(),
        })
      : null;
  }

  function disposeStage(st) {
    if (!st) return;
    st.dead = true;
    st.target?.dispose();
    st.target = null;
    st.data?.tex.dispose();
    st.data = null;
    st.driver?.dispose?.();
  }

  function ready(st) {
    return !!(st && st.def && st.prog && st.prog.ready && st.target && (!st.parts || st.parts.h.ready || st.parts.h.failed));
  }

  // Which world, dressed how, for this frame's reading. The policy lives here
  // and nowhere else.
  function resolve(style) {
    if (o.fixed) return { key: "@" + o.fixed, world: o.fixed, skin: { world: o.fixed, p: {} } };
    const family = style?.dominant || "";
    const arche = style?.archetype || "";
    const id = skinId(family, arche) || "@" + (arche || "none");
    const skin = skinFor(family, arche);
    if (o.world && o.world !== "auto" && hasWorld(o.world)) {
      // Pinned: the user's world, still dressed in the genre's colours (and in
      // its parameters too when the genre happens to live on that world).
      const own = skin.world === o.world;
      return {
        key: `${id}>${o.world}`,
        world: o.world,
        skin: { ...skin, world: o.world, p: own ? skin.p : {} },
      };
    }
    return { key: id, world: skin.world, skin };
  }

  // The last reading `want` resolved, so a frame that names the same genre as
  // the one before — nearly all of them — costs four comparisons and no
  // allocation.
  let seenFixed = null;
  let seenWorld = null;
  let seenFamily = null;
  let seenArche = null;
  function want(style) {
    const family = style?.dominant || "";
    const arche = style?.archetype || "";
    if (wantKey && o.fixed === seenFixed && o.world === seenWorld && family === seenFamily && arche === seenArche) return;
    seenFixed = o.fixed;
    seenWorld = o.world;
    seenFamily = family;
    seenArche = arche;
    const r = resolve(style);
    if (r.key === wantKey) return;
    wantKey = r.key;
    if (cur && cur.key === r.key) {
      if (pending) disposeStage(pending);
      pending = null;
      return;
    }
    if (pending && pending.key === r.key) return;
    if (pending) disposeStage(pending);
    pending = makeStage(r.key, r.world, r.skin);
  }

  // A pending world that is ready becomes the current one; the old one leaves
  // through the dissolve. A second change while the first is still dissolving
  // drops the one that was leaving: three worlds on screen is a mess, and it
  // is also three times the work.
  function promote() {
    if (!pending || pending.failed) {
      if (pending?.failed) {
        disposeStage(pending);
        pending = null;
      }
      return;
    }
    if (renderer && pending.def && !pending.prog) build(pending);
    if (!ready(pending)) {
      if (pending.prog?.failed) {
        disposeStage(pending);
        pending = null;
      }
      return;
    }
    if (!cur) {
      cur = pending;
      pending = null;
      firstFade = 0;
      dissolve = 1;
      return;
    }
    if (prev) disposeStage(prev);
    prev = cur;
    cur = pending;
    pending = null;
    dissolve = 0;
    dissolveLen = clamp(m.bar, DISSOLVE_MIN, DISSOLVE_MAX);
    seed = (seed + 7.31) % 100;
  }

  // --- reading the analysis ---------------------------------------------------------
  function update(frame, dt) {
    if (!sc.h) return;
    // The frame into the core: the reading's input, the bands (resampled and
    // MAX-HELD there until the next picture, so a transient that lives for
    // one analysis frame between two pictures still reaches the screen), the
    // chroma and the melody.
    readFrame(frame);
    const b = frame.bands;
    let n = 0;
    if (b && b.length) {
      n = Math.min(b.length, sc.maxBands);
      const bands = sc.bands();
      if (n === b.length) bands.set(b);
      else for (let i = 0; i < n; i++) bands[i] = b[i];
    }
    const f = frame.features;
    let flags = 0;
    let pitch = 0;
    let melody = 0;
    let dyn = 1;
    if (f) {
      flags = SCENE_FLAGS.features;
      const c = f.chroma;
      if (c) {
        flags |= SCENE_FLAGS.chroma;
        const ch = sc.chroma();
        for (let i = 0; i < 12; i++) ch[i] = c[i];
      }
      if (f.melodyPitch != null) {
        flags |= SCENE_FLAGS.pitch;
        pitch = f.melodyPitch;
      }
      if (f.melody != null) {
        flags |= SCENE_FLAGS.melody;
        melody = f.melody;
      }
      if (f.dynamics != null) {
        flags |= SCENE_FLAGS.dynamics;
        dyn = f.dynamics;
      }
    }
    sc.update(dt, now(), n, flags, pitch, melody, dyn);
    pull();
    // A driver that reads the analysis itself, at its own rate — the scope,
    // whose trace is the samples of this frame.
    if (cur?.driver?.hear) cur.driver.hear(frame, dt);
    if (prev?.driver?.hear) prev.driver.hear(frame, dt);
    want(frame.style);
  }

  // --- drawing ------------------------------------------------------------------------
  function env(stamp, decay) {
    const s = beatsNow - stamp;
    return s < 0 ? 0 : Math.exp(-s / decay);
  }

  // The uniform block: what only the page knows goes into the core, which
  // packs everything (viz_scene.rs#pack) at glsl.js's offsets.
  function pack(pal, geom) {
    const p = sc.packIn();
    p[P.P_FLASH] = flash;
    const pp = P.P_PAL;
    p[pp] = pal.low ?? 280;
    p[pp + 1] = pal.mid ?? 300;
    p[pp + 2] = pal.high ?? 320;
    p[pp + 3] = pal.hue ?? 280;
    p[pp + 4] = pal.sat ?? 0.8;
    p[pp + 5] = pal.light ?? 0.58;
    p[pp + 6] = pal.spread ?? 70;
    p[P.P_CSS_W] = cssW;
    p[P.P_CSS_H] = cssH;
    p[P.P_DPR] = dpr;
    p[P.P_SCALE] = scale;
    // The artwork's OWN box (ahw/ahh around hx/hy), not the frame-centred one
    // geometry.js grows for the canvas scenes' polar primitives: the mobile
    // cover sits above the middle, and the grown box centred every world 7% of
    // the frame below it.
    const ahw = geom?.ahw ?? geom?.hw ?? 0;
    const ahh = geom?.ahh ?? geom?.hh ?? 0;
    const ph = P.P_HOLE;
    if (geom && geom.hole > 0 && ahw > 0) {
      p[ph] = 1;
      p[ph + 1] = geom.hx ?? geom.cx;
      p[ph + 2] = geom.hy ?? geom.cy;
      p[ph + 3] = ahw;
      p[ph + 4] = ahh;
      p[ph + 5] = geom.afloorY ?? geom.floorY;
      p[P.P_HOLE_RATIO] = geom.hole;
    } else p[ph] = 0;
    p[P.P_INTENSITY] = o.intensity;
    p[P.P_REDUCED] = o.reducedMotion ? 1 : 0;
    p[P.P_STRIP] = o.layout === "strip" ? 1 : 0;
    const q = gq();
    p[P.P_STEPS] = q.steps ?? 1;
    p[P.P_PARTICLES] = q.particles ?? 1;
    p[P.P_TIER] = Math.max(0, TIERS.indexOf(o.preset.tier));
    sc.pack();
    // The same geometry for the drivers, which place things clear of it.
    const block = sc.block();
    for (let i = 0; i < 4; i++) clocks.hole[i] = block[O.uHole + i];
  }

  // Resolution follows the GPU, within the tier's bounds. With a timer query
  // the measurement is the GPU's own; without one it is the interval between
  // paints against the budget, which is coarser (vsync quantises it) but says
  // the same thing when it says anything: frames are being missed.
  function govern(t, rdt) {
    const q = gq();
    const lo = q.min ?? 0.5;
    const hi = q.max ?? 1;
    if (!(scale >= lo && scale <= hi)) scale = clamp(q.scale ?? 1, lo, hi);
    const budget = 1 / (o.fps > 0 ? o.fps : 60);
    intervals[intervalN++ % intervals.length] = rdt;
    if (t - scaleAt < 1.2 || intervalN < intervals.length) return;
    let load;
    const gpu = renderer.gpuMs;
    if (gpu > 0) load = gpu / 1000 / budget;
    else {
      sortedIntervals.set(intervals);
      sortedIntervals.sort();
      load = sortedIntervals[sortedIntervals.length >> 1] / budget;
    }
    let next = scale;
    const over = load > (gpu > 0 ? 0.85 : 1.3);
    // Out of room: already at the tier's floor and still missing frames. The
    // host reads this and steps the whole tier down.
    starved = over && scale <= lo + 1e-3;
    if (over) next = scale * 0.85;
    else if (load < (gpu > 0 ? 0.45 : 1.08)) next = scale * 1.06;
    next = clamp(next, lo, hi);
    if (Math.abs(next - scale) / scale > 0.04) {
      scale = next;
      scaleAt = t;
      applySize();
    }
  }

  function applySize() {
    if (!renderer || !cssW) return;
    renderer.setSize(cssW * dpr, cssH * dpr, scale, gq().bloom ?? 6);
  }

  const NO_LOOK = Object.freeze({});
  function lookOf(st) {
    return st?.def?.look || NO_LOOK;
  }
  // One grade parameter, blended from the leaving world's to the arriving one's.
  function mixLook(lp, lc, k, key, dflt) {
    const a = lp[key] ?? dflt;
    return a + ((lc[key] ?? dflt) - a) * k;
  }

  const look = {
    exposure: 1,
    bloom: 1,
    threshold: 0.9,
    knee: 0.6,
    ca: 0,
    grain: 0,
    saturation: 1.15,
    lift: 0,
    transparent: false,
    time: 0,
  };

  function draw(_g, w, h, pal, geom) {
    if (!renderer || renderer.lost) return;
    if (w && h && (w !== cssW || h !== cssH)) {
      cssW = w;
      cssH = h;
      applySize();
    }
    const t = now();
    const rdt = lastDrawAt ? clamp(t - lastDrawAt, 0.001, 0.25) : 1 / 60;
    lastDrawAt = t;
    clockSeconds += rdt;

    promote();
    if (!cur) {
      renderer.clear();
      return;
    }
    if (prev) {
      dissolve = Math.min(1, dissolve + rdt / dissolveLen);
      if (dissolve >= 1) {
        disposeStage(prev);
        prev = null;
      }
    }
    firstFade = Math.min(1, firstFade + rdt / (m.beat * FIRST_FADE_BEATS));
    flash *= Math.exp(-rdt / FLASH_DECAY);

    // The clocks extrapolated to the instant of this picture (never more than
    // a quarter of a second past the last analysis frame: past that the
    // analysis has stopped and the picture should settle rather than run on a
    // guess), the dynamics gate, the spectrum — a fast attack and a release in
    // beats, so the bars fall at a musical speed, beside the raw peak for
    // worlds that want the transient itself — and the history row, one per
    // sixteenth note: viz_scene.rs#prepare.
    const row = sc.prepare(t, rdt) ? sc.hist() : null;
    const q0 = sc.prep();
    beatsNow = q0[Q.Q_BEATS];
    barsNow = q0[Q.Q_BARS];
    phrasesNow = q0[Q.Q_PHRASES];
    dynSmooth = q0[Q.Q_DYN];

    // The drivers advance on the RENDER clock.
    clocks.beats = beatsNow;
    clocks.bars = barsNow;
    clocks.phrases = phrasesNow;
    clocks.dt = rdt;
    clocks.aspect = cssH ? cssW / cssH : 16 / 9;
    clocks.width = cssW;
    clocks.height = cssH;
    clocks.spec = sc.specSmooth();
    // The melody, for the worlds that draw the tune itself (a staircase that
    // climbs with the arpeggio): its pitch 0..1 and how present it is.
    clocks.pitch = q0[Q.Q_PITCH];
    clocks.melody = q0[Q.Q_MELODY];
    if (prev?.driver?.step) prev.driver.step(rdt, m, clocks);
    if (cur.driver?.step) cur.driver.step(rdt, m, clocks);
    strobe();

    govern(t, rdt);
    pack(pal, geom || geomRef);
    if (!renderer.beginFrame(sc.block(), sc.spec(), row)) return;

    const q = gq();
    const arriving = prev ? dissolve : 1;
    if (prev) drawStage(prev, 1 - arriving);
    drawStage(cur, arriving);

    // The grade, blended between the two worlds while they dissolve.
    const lc = lookOf(cur);
    const lp = prev ? lookOf(prev) : lc;
    const k = prev ? dissolve : 1;
    look.exposure = mixLook(lp, lc, k, "exposure", 1) * (prev ? 1 : firstFade);
    look.bloom = mixLook(lp, lc, k, "bloom", 1) * (q.bloomK ?? 1);
    look.threshold = mixLook(lp, lc, k, "threshold", 0.9);
    look.knee = mixLook(lp, lc, k, "knee", 0.6);
    look.saturation = mixLook(lp, lc, k, "saturation", 1.15);
    // The fringe is an IMPACT, not a finish: nothing at rest, a split for an
    // instant on a big kick or a drop — the lens being hit. It used to sit at
    // a hair all the time, and a permanent red/cyan edge on every thin line
    // is the single cheapest-looking thing a render can do.
    const hitCA = Math.max(env(m.stamp.big, 0.5), env(m.stamp.drop, 1.5));
    look.ca = (q.ca ?? 0) * (mixLook(lp, lc, k, "ca", 1) * (0.007 * hitCA * (o.reducedMotion ? 0 : 1)));
    look.grain = (q.grain ?? 0) * mixLook(lp, lc, k, "grain", 1);
    look.lift = flash * 0.35;
    look.transparent = o.layout === "strip";
    look.time = clockSeconds;
    renderer.present(prev ? prev.target : null, cur.target, dissolve, seed, look);
  }

  function drawStage(st, share) {
    if (!st.target) return;
    if (st.parts) st.parts.count = st.parts.exact ? st.parts.max : Math.max(0, Math.round(st.parts.max * (gq().particles ?? 1)));
    if (st.data && st.data.dirty && st.data.src) {
      st.data.tex.upload(st.data.src);
      st.data.dirty = false;
    }
    st.share = share;
    st.energy = (st.skin?.energy ?? 1) * (0.35 + 0.65 * dynSmooth);
    st.speed = st.skin?.speed ?? 1;
    renderer.drawWorld(st.prog, st.target, st.fill, st.parts, st.data?.tex);
  }

  // --- the host's API ---------------------------------------------------------------
  function attach(r) {
    renderer = r;
    if (!r) return false;
    for (const st of [cur, prev, pending]) if (st?.def && !st.prog) build(st);
    applySize();
    if (coverImg) renderer.setCover(coverImg);
    return true;
  }

  function resize(w, h, preset, geom, pixelRatio = 1) {
    cssW = w;
    cssH = h;
    geomRef = geom;
    if (preset) o.preset = preset;
    dpr = pixelRatio || 1;
    scale = clamp(gq().scale ?? 1, gq().min ?? 0.5, gq().max ?? 1);
    intervalN = 0;
    applySize();
  }

  function setOptions(next = {}) {
    if (next.intensity != null) o.intensity = next.intensity;
    if (next.reducedMotion != null) o.reducedMotion = !!next.reducedMotion;
    if (next.flash) o.flash = next.flash;
    if (next.fps != null) o.fps = next.fps;
    if (next.orientation) o.orientation = next.orientation;
    if (next.colour) o.colour = next.colour;
    if (next.world && next.world !== o.world) {
      o.world = next.world;
      wantKey = ""; // re-resolve on the next analysis frame
    }
  }

  // The artwork, for the worlds that draw WITH it. Loaded small (it is a
  // texture, not a picture: 256 px is more than any of them samples) and only
  // uploaded once decoded.
  function setCover(url) {
    if (!url || url === coverUrl || typeof Image === "undefined") return;
    coverUrl = url;
    const img = new Image();
    if (!sameOrigin(url)) img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      if (coverUrl !== url) return;
      coverImg = img;
      renderer?.setCover(img);
    };
    img.onerror = () => {};
    img.src = url;
  }

  function dispose() {
    for (const st of [cur, prev, pending]) disposeStage(st);
    cur = prev = pending = null;
    renderer = null;
    sc.free();
  }

  return {
    kind: "gl",
    // The renderer is built through the scene rather than imported by the host:
    // the host (Visualizer.svelte) is in the main bundle, and a static import
    // there put the whole GL engine on every launch, animations on or off.
    makeRenderer: (canvas, callbacks) => createRenderer(canvas, callbacks),
    attach,
    resize,
    update,
    draw,
    setOptions,
    setCover,
    dispose,
    /** For the tests and the settings readout. */
    get world() {
      return cur?.worldId || pending?.worldId || "";
    },
    get skin() {
      return (cur || pending)?.key || "";
    },
    get leaving() {
      return prev?.worldId || null;
    },
    get pendingWorld() {
      return pending?.worldId || null;
    },
    get musical() {
      return m;
    },
    get scale() {
      return scale;
    },
    get starved() {
      return starved;
    },
    get flash() {
      return flash;
    },
  };
}

// The unleashed strobe's decision for one frame: how hard a flash the events
// that just happened are worth, 0 for none. Pure, so it can be pinned without a
// GPU; the rate cap is applied after it, by requestFlash.
export function strobePower(m, main, snare, drop) {
  if (drop) return 1;
  // The peak of the track: just after a drop, or anywhere the music is driving
  // hard — never in a breakdown, where a strobe on a lone kick is an
  // interruption rather than an accent.
  const peak = Math.max(m.dropped, clamp((m.drive - 0.5) / 0.3, 0, 1)) * (1 - m.breakdown);
  if (main && peak > 0.15) {
    const p = m.bigKick ? 0.95 : 0.4 + 0.35 * clamp(m.mainPower, 0, 1);
    return p * (0.55 + 0.45 * peak);
  }
  // A build's snares speed up into the drop, and so does the strobe.
  if (snare && m.build > 0.35) return 0.2 + 0.5 * m.build;
  return 0;
}

// `#define P_SIDES uP0.x` and so on, in the order the world declared its
// parameters, so the GLSL reads its knobs by name and the packing lives in one
// place.
export function paramDefines(names) {
  const comp = ["x", "y", "z", "w"];
  let s = "";
  names.slice(0, 16).forEach((n, i) => {
    s += `#define P_${n.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()} uP${i >> 2}.${comp[i & 3]}\n`;
  });
  return s;
}

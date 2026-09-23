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

import { createMusical } from "../musical.js";
import {
  MUSIC_FLOATS,
  MUSIC_OFFSET as O,
  worldFragment,
  particleVertex,
  particleFragment,
  FULLSCREEN_VS,
} from "../gl/glsl.js";
import { SPEC_W, createRenderer } from "../gl/renderer.js";
import { loadWorld, hasWorld } from "../worlds/index.js";
import { skinFor, skinId } from "../skins.js";
import { approach, clamp } from "../util.js";

// The WCAG 2.x general flash threshold: no more than three flashes in any one
// second. Enforced as a minimum interval between flash ONSETS.
const FLASH_MIN_INTERVAL = 1 / 3;
// A flash's own decay, in SECONDS on purpose — how long a flash stays on the
// retina is physiology, not music.
const FLASH_DECAY = 0.09;
const FLASH_GAIN = { off: 0, soft: 0.4, full: 1 };
// The dissolve between two worlds: one bar, within reason.
const DISSOLVE_MIN = 0.9;
const DISSOLVE_MAX = 3.2;
// The first world fades up from black over this many beats.
const FIRST_FADE_BEATS = 2;
// Spectrum history: one row per sixteenth note, so the history texture scrolls
// with the music rather than with the frame rate.
const HIST_PER_BEAT = 4;
// How far past the last analysis frame the clocks may be extrapolated. Past
// this, the analysis has stopped (a paused track, a closed projector link) and
// the picture should settle rather than keep running on a guess.
const EXTRAPOLATE_MAX = 0.25;

const BANDS = ["sub", "bass", "lowMid", "mid", "high", "air"];

// sRGB -> linear, and HSL -> linear RGB, allocation-free.
function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hslLinear(hDeg, s, l, out, at) {
  const h = ((((hDeg % 360) + 360) % 360) / 360) * 6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) [r, g] = [c, x];
  else if (h < 2) [r, g] = [x, c];
  else if (h < 3) [g, b] = [c, x];
  else if (h < 4) [g, b] = [x, c];
  else if (h < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  const m = l - c / 2;
  r = toLinear(r + m);
  g = toLinear(g + m);
  b = toLinear(b + m);
  out[at] = r;
  out[at + 1] = g;
  out[at + 2] = b;
}
// Scale a colour so its luminance lands in a band: a pale sleeve and a dark
// one then expose the same, and a world's light constants mean one thing
// whatever the artwork. Clamped, so a near-black colour is not boosted into
// mush and a near-white one keeps some of its brightness.
function normalise(out, at, target, lo = 0.5, hi = 3.5) {
  const y = 0.2126 * out[at] + 0.7152 * out[at + 1] + 0.0722 * out[at + 2];
  const k = clamp(target / Math.max(1e-4, y), lo, hi);
  out[at] *= k;
  out[at + 1] *= k;
  out[at + 2] *= k;
}

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
  };
  // Injectable, so the render bench can run the scene on a simulated clock and
  // photograph an exact instant of an exact bar.
  const clock =
    opts.now ||
    (() => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000);

  let renderer = null;
  const m = createMusical();
  const block = new Float32Array(MUSIC_FLOATS);
  const spec = new Uint8Array(SPEC_W * 2);
  const specSmooth = new Float32Array(SPEC_W);
  const specFast = new Float32Array(SPEC_W);
  const histRow = new Uint8Array(SPEC_W);
  let histDue = 0;
  const bandShare = new Float32Array(6);
  const bandSmooth = new Float32Array(6);
  let chroma = null;
  let pitch = 0.5;
  let melody = 0;
  let dyn = 1;
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
  let lastUpdateAt = 0;
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
  const gq = () => o.preset.gl || {};
  let scale = 1;
  let scaleAt = 0;
  let starved = false;
  const intervals = new Float32Array(32);
  let intervalN = 0;

  // What a driver is handed each frame, allocated once. `spec` is the smoothed
  // spectrum (128 bins, 0..1) for the worlds that do per-band work on the CPU.
  const clocks = { beats: 0, bars: 0, phrases: 0, dt: 0, aspect: 16 / 9, spec: specSmooth, pitch: 0.5, melody: 0, hole: [0, 0, 0, 0] };

  // --- the artwork ------------------------------------------------------------------
  let coverUrl = "";
  let coverImg = null;

  function now() {
    return clock();
  }

  function requestFlash(power) {
    const g = o.reducedMotion ? 0 : FLASH_GAIN[o.flash] ?? FLASH_GAIN.soft;
    if (g <= 0 || !(power > 0)) return;
    if (clockSeconds - lastFlashAt < FLASH_MIN_INTERVAL) return;
    lastFlashAt = clockSeconds;
    flash = Math.max(flash, clamp(power, 0, 1) * g);
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
      dead: false,
      failed: false,
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
      };
    }
    st.target = renderer.worldTarget(!!def.feedback);
    st.driver = def.create
      ? def.create({
          params,
          preset: o.preset,
          skin: st.skin,
          opts: o,
          flash: requestFlash,
          state: st.state,
          ev: st.ev,
        })
      : null;
  }

  function disposeStage(st) {
    if (!st) return;
    st.dead = true;
    st.target?.dispose();
    st.target = null;
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

  function want(style) {
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
    m.update(frame, dt);
    lastUpdateAt = now();
    const b = frame.bands;
    if (b && b.length) {
      // Resampled onto the texture's 128 texels, and MAX-HELD until the next
      // draw: a transient that lives for one analysis frame between two
      // pictures must still reach the screen.
      const n = b.length;
      for (let i = 0; i < SPEC_W; i++) {
        const x = (i / (SPEC_W - 1)) * (n - 1);
        const j = Math.floor(x);
        const f = x - j;
        const v = b[j] + ((b[Math.min(n - 1, j + 1)] || 0) - b[j]) * f;
        if (v > specFast[i]) specFast[i] = v;
      }
    }
    const e = frame.energy;
    if (e) {
      const total = e.sub + e.bass + e.lowMid + e.mid + e.high + e.air + 1e-12;
      for (let i = 0; i < 6; i++) {
        const share = clamp((e[BANDS[i]] / total) * 3, 0, 1);
        if (share > bandShare[i]) bandShare[i] = share;
      }
    }
    const f = frame.features;
    if (f) {
      chroma = f.chroma || chroma;
      pitch = f.melodyPitch ?? pitch;
      melody = f.melody ?? melody;
      dyn = f.dynamics ?? 1;
    }
    want(frame.style);
  }

  // --- drawing ------------------------------------------------------------------------
  function extrapolate(t) {
    const ahead = clamp(t - lastUpdateAt, 0, EXTRAPOLATE_MAX);
    beatsNow = m.beats + ahead / m.beat;
    barsNow = m.bars + ahead / m.bar;
    phrasesNow = m.phrases + ahead / m.phrase;
    return ahead;
  }

  function put(slot, x, y, z, w, idx = 0) {
    const at = O[slot] + idx * 4;
    block[at] = x;
    block[at + 1] = y;
    block[at + 2] = z;
    block[at + 3] = w;
  }

  function env(stamp, decay) {
    const s = beatsNow - stamp;
    return s < 0 ? 0 : Math.exp(-s / decay);
  }

  function pack(pal, geom, ahead) {
    const bpb = m.beatsPerBar;
    put("uClock", beatsNow, barsNow, phrasesNow, m.beat);
    put(
      "uPhase",
      beatsNow - Math.floor(beatsNow),
      (m.barPhase + ahead / m.bar) % 1,
      (m.phrasePhase + ahead / m.phrase) % 1,
      m.locked ? m.bpm / 100 : 0
    );
    const st = m.stamp;
    put("uHit", env(st.kick, 0.35), env(st.main, 0.5), env(st.big, 1), env(st.snare, 0.4));
    put("uHit2", env(st.hat, 0.2), env(st.note, 0.5), env(st.chord, 1.5), flash);
    put("uFlow", m.drive, m.weight, m.air, m.tension);
    put("uMood", m.calm, m.level, dynSmooth, m.attack);
    put("uArc", m.dropped, m.build, m.breakdown, m.roll);
    put("uLookA", m.motion, m.density, m.punch, m.smooth);
    put("uLookB", m.warm, m.melodic, m.chaos, m.rollDiv / 16);
    put("uBandA", bandSmooth[0], bandSmooth[1], bandSmooth[2], bandSmooth[3]);
    put("uBandB", bandSmooth[4], bandSmooth[5], pitch, melody);
    for (let i = 0; i < 3; i++) {
      const c = chroma;
      put("uChroma", c ? c[i * 4] : 0, c ? c[i * 4 + 1] : 0, c ? c[i * 4 + 2] : 0, c ? c[i * 4 + 3] : 0, i);
    }
    put("uCount", m.beatIndex, m.count.bar, m.count.kick, m.count.drop);
    put(
      "uSince",
      Math.min(999, beatsNow - st.kick),
      Math.min(999, beatsNow - st.main),
      Math.min(999, beatsNow - st.snare),
      Math.min(999, beatsNow - st.drop)
    );
    // The palette.
    const sat = clamp(pal.sat ?? 0.8, 0, 1);
    const light = clamp(pal.light ?? 0.58, 0.2, 0.8);
    hslLinear(pal.low ?? 280, sat, light, block, O.uPalLow);
    normalise(block, O.uPalLow, 0.2);
    hslLinear(pal.mid ?? 300, sat, light, block, O.uPalMid);
    normalise(block, O.uPalMid, 0.24);
    hslLinear(pal.high ?? 320, sat, Math.min(0.85, light + 0.08), block, O.uPalHigh);
    normalise(block, O.uPalHigh, 0.3);
    hslLinear((pal.hue ?? 280) + 180, sat, light, block, O.uPalAcc);
    normalise(block, O.uPalAcc, 0.24);
    hslLinear((pal.hue ?? 280) - 14, sat * 0.55, 0.06, block, O.uPalBg);
    block[O.uPalLow + 3] = sat;
    block[O.uPalMid + 3] = light;
    block[O.uPalHigh + 3] = ((((pal.hue ?? 280) % 360) + 360) % 360) / 360;
    block[O.uPalAcc + 3] = (pal.spread ?? 70) / 360;
    // The frame, in p-space (y up, one unit = half the height).
    const w = cssW || 1;
    const h = cssH || 1;
    put("uFrame", w * dpr, h * dpr, w / h, 2 / (h * dpr * scale));
    const hh = h / 2;
    if (geom && geom.hole > 0 && geom.hw > 0) {
      put("uHole", (geom.cx - w / 2) / hh, -(geom.cy - h / 2) / hh, geom.hw / hh, geom.hh / hh);
      put("uHoleR", (Math.min(geom.hw, geom.hh) / hh) * 0.08, geom.hole, -(geom.floorY - h / 2) / hh, 0);
    } else {
      put("uHole", 0, 0, 0, 0);
      put("uHoleR", 0, 0, -1 / 3, 0);
    }
    // The same geometry for the drivers, which place things clear of it.
    for (let i = 0; i < 4; i++) clocks.hole[i] = block[O.uHole + i];
    put("uCtl", o.intensity, o.reducedMotion ? 1 : 0, o.layout === "strip" ? 1 : 0, 0);
    const q = gq();
    const tiers = ["low", "medium", "high", "ultra"];
    put("uQual", q.steps ?? 1, q.particles ?? 1, Math.max(0, tiers.indexOf(o.preset.tier)), scale);
  }

  function fillFor(st, share) {
    const gate = 0.35 + 0.65 * dynSmooth;
    const energy = (st.skin?.energy ?? 1) * gate;
    const speed = st.skin?.speed ?? 1;
    return (h) => {
      h.f("uFade", share);
      h.f("uEnergy", energy);
      h.f("uSpeed", speed);
      h.v4a("uP0", st.packed.subarray(0, 4));
      h.v4a("uP1", st.packed.subarray(4, 8));
      h.v4a("uP2", st.packed.subarray(8, 12));
      h.v4a("uP3", st.packed.subarray(12, 16));
      h.v4a("uS0", st.state.subarray(0, 4));
      h.v4a("uS1", st.state.subarray(4, 8));
      h.v4a("uEv", st.ev);
    };
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
      const sorted = Array.from(intervals).sort((a, b) => a - b);
      load = sorted[sorted.length >> 1] / budget;
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

  function lookOf(st) {
    const l = st?.def?.look || {};
    return l;
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
    const ahead = extrapolate(t);

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
    dynSmooth = approach(dynSmooth, dyn, 0.15, rdt);

    // The spectrum: a fast attack and a release in beats, so the bars fall at
    // a musical speed; the fast row keeps the raw peak for worlds that want
    // the transient itself.
    const rel = Math.exp(-rdt / Math.max(0.05, m.beat * 0.35));
    for (let i = 0; i < SPEC_W; i++) {
      const v = specFast[i];
      specSmooth[i] = v > specSmooth[i] ? specSmooth[i] + (v - specSmooth[i]) * 0.65 : v + (specSmooth[i] - v) * rel;
      spec[i] = clamp(specSmooth[i], 0, 1) * 255;
      spec[SPEC_W + i] = clamp(v, 0, 1) * 255;
      specFast[i] = v * 0.4;
    }
    for (let i = 0; i < 6; i++) {
      bandSmooth[i] = approach(bandSmooth[i], bandShare[i], m.beat * 0.2, rdt);
      bandShare[i] *= 0.5;
    }
    let row = null;
    if (beatsNow >= histDue) {
      histDue = Math.max(histDue + 1 / HIST_PER_BEAT, beatsNow - 1);
      for (let i = 0; i < SPEC_W; i++) histRow[i] = spec[i];
      row = histRow;
    }

    // The drivers advance on the RENDER clock.
    clocks.beats = beatsNow;
    clocks.bars = barsNow;
    clocks.phrases = phrasesNow;
    clocks.dt = rdt;
    clocks.aspect = cssH ? cssW / cssH : 16 / 9;
    // The melody, for the worlds that draw the tune itself (a staircase that
    // climbs with the arpeggio): its pitch 0..1 and how present it is.
    clocks.pitch = pitch;
    clocks.melody = melody;
    if (prev?.driver?.step) prev.driver.step(rdt, m, clocks);
    if (cur.driver?.step) cur.driver.step(rdt, m, clocks);

    govern(t, rdt);
    pack(pal, geom || geomRef, ahead);
    if (!renderer.beginFrame(block, spec, row)) return;

    const q = gq();
    const arriving = prev ? dissolve : 1;
    if (prev) drawStage(prev, 1 - arriving);
    drawStage(cur, arriving);

    // The grade, blended between the two worlds while they dissolve.
    const lc = lookOf(cur);
    const lp = prev ? lookOf(prev) : lc;
    const k = prev ? dissolve : 1;
    const mix = (key, dflt) => (lp[key] ?? dflt) + ((lc[key] ?? dflt) - (lp[key] ?? dflt)) * k;
    look.exposure = mix("exposure", 1) * (prev ? 1 : firstFade);
    look.bloom = mix("bloom", 1) * (q.bloomK ?? 1);
    look.threshold = mix("threshold", 0.9);
    look.knee = mix("knee", 0.6);
    look.saturation = mix("saturation", 1.15);
    // The fringe breathes on an impact: a hair at rest, a visible split for an
    // instant on a big kick or a drop — the lens being hit.
    const hitCA = Math.max(env(m.stamp.big, 0.5), env(m.stamp.drop, 1.5));
    look.ca = (q.ca ?? 0) * (mix("ca", 1) * (0.0025 + 0.01 * hitCA * (o.reducedMotion ? 0 : 1)));
    look.grain = (q.grain ?? 0) * mix("grain", 1);
    look.lift = flash * 0.35;
    look.transparent = o.layout === "strip";
    look.time = clockSeconds;
    renderer.present(prev ? prev.target : null, cur.target, dissolve, seed, look);
  }

  function drawStage(st, share) {
    if (!st.target) return;
    if (st.parts) st.parts.count = Math.max(0, Math.round(st.parts.max * (gq().particles ?? 1)));
    renderer.drawWorld(st.prog, st.target, fillFor(st, share), st.parts);
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

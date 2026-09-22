// The oscilloscope: the signal itself, one trace per channel.
//
// Every other scene in here draws something ABOUT the music — a spectrum, a
// beat grid, a genre's world. This one draws the music, and that changes what
// "good" means: a scope is only worth looking at if it is STABLE and HONEST.
// Four things carry that, and each of them is the difference between an
// instrument and a squiggle.
//
//  1. IT IS TRIGGERED, like a real scope. Drawing the newest N samples every
//     frame makes the waveform slide sideways at the difference between the
//     frame rate and whatever the music's period happens to be — unreadable
//     within a second. So each frame looks BACKWARDS for the last rising zero
//     crossing and starts the window there: the wave then stands still and the
//     eye can actually read it. Measured on a sustained tone, the trace moves
//     0.007 px a frame triggered against 86.5 px free-running.
//  2. THE TRIGGER IS LOW-PASSED, and that is what makes it lock to the music
//     rather than to the cymbals. The raw signal's zero crossings on a bright
//     master are dominated by the top end, which has no stable period at all;
//     a one-pole filter at TRIG_HZ leaves the bass and the kick, which do. It
//     is the same idea as a scope's HF-reject trigger coupling, and without it
//     the trace jitters on exactly the music this player exists for.
//  3. ONE TIMEBASE FOR BOTH CHANNELS. The trigger runs on the mono sum and the
//     offset it finds is applied to BOTH traces, because the whole point of two
//     traces is reading one against the other — a hard-panned stab, a mono bass
//     under a stereo lead, a phase problem. Two independent triggers would slide
//     the channels against each other and destroy the only thing they are there
//     to show.
//  4. THE TAP IS PER CHANNEL, which the rest of the engine's analysers cannot
//     give: an AnalyserNode downmixes to mono before it measures anything, so
//     "one scope per channel" needed its own ChannelSplitter (lib/audio/graph.js
//     #requestScope). A mono track is up-mixed rather than left with a dead
//     second output, so it shows two identical traces — which is what a real
//     scope with both probes on one signal shows.
//
// PRECISION IS THE QUALITY SETTING, and the timebase deliberately is not: the
// window below is a fixed slice of TIME at every tier, because showing eight
// times as much waveform at ultra would not be more precision, it would be a
// different (and unreadable) picture. What the tier moves is how faithfully
// that same slice is drawn — see `scope` in lib/viz/quality.js.

import { approach, clamp, envelope, hsl } from "../util.js";

// The timebase: how much time one lane shows, end to end. ~42 ms is a shade
// over two cycles of a 50 Hz bass and about forty of a 1 kHz lead — dense
// enough to look like music, open enough to read a kick's shape.
const WINDOW_MS = 42;
// How far back the trigger may hunt for its edge is the TIER's (quality.js
// #SCOPE.search), bounded by whatever room the analyser's buffer actually
// leaves above the window. This is the fallback for a preset without one.
const SEARCH_MS = 40;
// The trigger's coupling filter. Low enough to be deaf to hats and air, high
// enough to follow a kick's pitch sweep rather than lagging behind it.
const TRIG_HZ = 320;
// How far the trigger signal must fall back before another rising edge counts —
// a Schmitt gate, as a share of the trigger signal's own weight, so it scales
// with the material instead of being a number that suits one master.
const TRIG_HYST = 0.12;
const TRIG_FLOOR = 0.002; // ...and an absolute floor, for near-silence

// The phosphor. Expressed as a TIME CONSTANT and converted per frame, so the
// trail lasts as long at a 30 fps cap as at 144 — the alternative is a
// persistence that changes character with a setting that has nothing to do
// with it.
const PERSIST = 0.07;

// The trace is redrawn in the same place every frame (that is what triggering
// buys), so additive strokes ACCUMULATE: the steady state is alpha/wash. Both
// are therefore expressed as the steady state they are aiming at and multiplied
// by the wash — which is what keeps the picture's exposure identical whatever
// the frame cap, instead of dimming as the cap comes down.
//
// AND THE CORE DOES NOT SCALE WITH `preset.glow`, which is the one place this
// scene parts company with the others. Their `glow` is a brightness ladder
// across the tiers (0.45 at low against 1.25 at ultra) because what it scales
// is atmosphere — a bloom, a wash, a field. Here it would scale the SIGNAL, and
// a scope whose trace is half as bright on a phone is not a cheaper scope, it
// is a broken one: rendered at 0.45 the beam was very nearly invisible. So
// `glow` is read as the HALO budget it really is — the part the post pass then
// duplicates anyway — and the beam itself is the same at every tier. The tier
// changes how PRECISE the trace is, never whether you can see it.
const CORE_BRIGHT = 1.25; // clips to a white-hot beam, as a beam should
const BODY_BRIGHT = 0.45;
const HALO_BRIGHT = 0.2;

// Full scale stops short of the graticule, so a limitered master reads as
// "nearly at the top" rather than as a signal pinned against the border.
const DEFLECT = 0.88;

// The auto-range. A scope has a volts/div knob; this is the auto version of it,
// and it deliberately COMPRESSES rather than normalises: raising a quiet
// passage to full height would throw away the one thing a waveform is best at
// showing. At 0.6 a passage 20 dB down draws at 40% of the loud part's height
// instead of at 10% — visibly quieter, never a dead line.
//
// THE REFERENCE IS DELIBERATELY NOT THE PEAK. It used to be a peak envelope
// with a long release, and on anything with transients in it that is a scale
// set by the loudest instant and held there: measured on a kick every half
// second over a quiet lead, the reference sat near 0.85 while most windows
// held 0.09, and the trace drew at six per cent of its lane — technically
// honest, unreadable in practice. A SLOW ATTACK is what fixes it, with the
// existing envelope rather than a new statistic: a 0.15 s kick can only pull a
// 0.35 s attack part of the way up, so the reference lands near the level the
// music actually spends its time at and the transients clip to the rails,
// which is exactly what a scope does and what they should look like.
const AGC_TARGET = 0.8;
const AGC_SOFT = 0.6;
const AGC_MIN = 0.8;
const AGC_MAX = 8;
const AGC_FLOOR = 0.02;
const AGC_ATTACK = 0.35;
const AGC_RELEASE = 0.9;

// A tier that somehow arrives without a scope block still has to draw.
const FALLBACK = {
  buffer: 4096, search: SEARCH_MS, points: 512,
  exact: false, fine: false, interp: false, divisions: 6, passes: 2,
};

export const SCOPE_ORIENTATIONS = [
  { id: "horizontal", label: "Horizontal", hint: "Deux bandes, l'une sous l'autre." },
  { id: "vertical", label: "Vertical", hint: "Deux colonnes, côte à côte." },
];

export const SCOPE_COLOURS = [
  { id: "duo", label: "Deux teintes", hint: "Gauche et droite aux deux extrémités de la palette." },
  { id: "mono", label: "Une teinte", hint: "Les deux voies sur la couleur de base." },
  { id: "sweep", label: "Dégradé", hint: "La teinte parcourt la trace, comme les barres." },
];

const ORIENTATIONS = new Set(SCOPE_ORIENTATIONS.map((o) => o.id));
const COLOURS = new Set(SCOPE_COLOURS.map((c) => c.id));

/** One sample, read at a fractional position. */
function lerpSample(buf, p, n) {
  if (p <= 0) return buf[0];
  if (p >= n - 1) return buf[n - 1];
  const i = p | 0;
  const f = p - i;
  return buf[i] + (buf[i + 1] - buf[i]) * f;
}

export function createScopeScene(opts = {}) {
  const preset = opts.preset || {};
  const sc = preset.scope || FALLBACK;
  // `glow` is read as a HALO weight and floored: at `low` there is no post pass
  // at all (POST.low is null), so the scene's own halo is the only one there
  // will be, and the tier's 0.45 left the beam with no light around it
  // whatever. Ultra still gets the richest halo; low still gets one.
  const glow = clamp(preset.glow ?? 1, 0.7, 1.4);
  let intensity = clamp(opts.intensity ?? 0.7, 0, 1);
  let orientation = ORIENTATIONS.has(opts.orientation) ? opts.orientation : "horizontal";
  let tint = COLOURS.has(opts.colour) ? opts.colour : "duo";

  // Per-column min/max, one pair per channel. Sized on resize, never per frame.
  let cols = 0;
  let loA = null;
  let hiA = null;
  let loB = null;
  let hiB = null;
  // Where each lane is and which way it runs. See `layout`.
  let lanes = null;
  let coreW = 1.4;

  let gain = 1;
  let peakEnv = 0.3;
  let trigEnv = 0.05;
  let locked = 0;
  let signal = false; // a tap is actually feeding us samples
  let lastDraw = 0;
  let lastSize = null;

  function setOptions(o = {}) {
    if (typeof o.intensity === "number") intensity = clamp(o.intensity, 0, 1);
    if (ORIENTATIONS.has(o.orientation) && o.orientation !== orientation) {
      orientation = o.orientation;
      // The lanes are a function of the orientation, so they have to be rebuilt
      // — but only the layout: the samples, the trigger lock and the auto-range
      // all still hold, and resetting them would make flipping the orientation
      // cost a second of re-converging for nothing.
      if (lastSize) layout(lastSize[0], lastSize[1], lastSize[2]);
    }
    if (COLOURS.has(o.colour)) tint = o.colour;
  }

  /**
   * Where the two traces go.
   *
   * Horizontal: two bands stacked. Vertical: two columns side by side. With
   * artwork in the way they take the free strips AROUND it — the same answer
   * aurora gives its ribbons, and for the same reason: in the full-screen
   * player a trace through the middle of the frame is a trace behind the cover.
   * The geometry layer already caps how much of an axis the artwork may eat, so
   * there is always a band left; a thin one simply gets a short lane rather
   * than a fallback that would draw where nobody can see it.
   */
  function layout(w, h, geom) {
    lastSize = [w, h, geom];
    const horiz = orientation === "horizontal";
    const hole = geom && geom.hole > 0;
    let a;
    let b;
    if (horiz) {
      const top = hole ? Math.max(0, geom.cy - geom.hh) : h / 2;
      const bot = hole ? Math.min(h, geom.cy + geom.hh) : h / 2;
      a = { x: 0, y: 0, w, h: top };
      b = { x: 0, y: bot, w, h: h - bot };
    } else {
      const left = hole ? Math.max(0, geom.cx - geom.hw) : w / 2;
      const right = hole ? Math.min(w, geom.cx + geom.hw) : w / 2;
      a = { x: 0, y: 0, w: left, h };
      b = { x: right, y: 0, w: w - right, h };
    }
    lanes = [a, b].map((r) => {
      const short = Math.min(r.w, r.h);
      // Never more than a third of the short side: a lane a few pixels tall
      // would otherwise invert its own inside and draw back to front.
      const pad = Math.min(clamp(short * 0.09, 4, 26), short * 0.35);
      // origin sits at (time 0, zero volts); `along` spans the timebase and
      // `across` reaches the graticule's own edge, so a signal is plotted at
      // v in [-1, 1] and the border is exactly v = ±1.
      const inX = r.w - 2 * pad;
      const inY = r.h - 2 * pad;
      return horiz
        ? {
            horiz: true,
            ox: r.x + pad, oy: r.y + r.h / 2,
            ax: inX, ay: 0,
            vx: 0, vy: -inY / 2,
            len: inX, span: inY / 2,
          }
        : {
            horiz: false,
            ox: r.x + r.w / 2, oy: r.y + pad,
            ax: 0, ay: inY,
            vx: inX / 2, vy: 0,
            len: inY, span: inX / 2,
          };
    });
    // One column per CSS pixel of timebase is as precise as the display can
    // ever be; the tier's ceiling is what takes it below that.
    const len = Math.max(lanes[0].len, lanes[1].len);
    const want = clamp(Math.round(len), 32, sc.points);
    // THE BEAM GETS WIDER AS THE COLUMNS GET COARSER, which is not a cosmetic
    // choice: a stroke of a given alpha laid along 256 long diagonal segments
    // puts far less ink on any one pixel than the same stroke laid along 1548
    // short ones, so a low tier drew a trace that was there and could not be
    // seen. Widening it by the square root of the ratio restores the density —
    // and a coarse trace SHOULD read as a fatter, softer beam, which is
    // precisely what a scope with less resolution looks like.
    const coarse = clamp(Math.sqrt(len / Math.max(1, want)), 1, 2.2);
    coreW = clamp(Math.min(lanes[0].span, lanes[1].span) * 0.02, 1, 2.6) * coarse;
    if (want === cols) return;
    cols = want;
    loA = new Float32Array(cols);
    hiA = new Float32Array(cols);
    loB = new Float32Array(cols);
    hiB = new Float32Array(cols);
  }

  function resize(w, h, _preset, geom) {
    if (!w || !h) return;
    layout(w, h, geom);
  }

  /**
   * Reduce one channel's window to `cols` columns, and return its true peak.
   *
   * `exact` is a real DSO's answer: every column carries the MIN and the MAX of
   * the samples that land in it, so nothing between two vertices is invented.
   * Without it the window is decimated peak-preserving (the sample furthest
   * from zero in each group wins), which keeps the envelope honest and the
   * shape simplified — the same reasoning as groupBands taking the peak rather
   * than the mean. Either way the maximum over the columns IS the window's true
   * peak, so the auto-range does not change with the tier.
   */
  function reduce(buf, size, base, lo, hi, win) {
    const step = win / cols;
    const exact = sc.exact;
    const interp = sc.interp;
    const fine = sc.fine;
    let peak = 0;
    for (let c = 0; c < cols; c++) {
      const p0 = base + c * step;
      const p1 = p0 + step;
      let i0 = Math.ceil(p0);
      let i1 = Math.floor(p1);
      if (i0 < 0) i0 = 0;
      if (i1 > size - 1) i1 = size - 1;
      let a;
      let b;
      if (i1 < i0) {
        // Finer than the samples themselves: one reading at the column's
        // centre. Interpolated at the tier that can afford it, which is what
        // turns a stair-step into a resampled curve.
        const mid = (p0 + p1) * 0.5;
        const v = interp ? lerpSample(buf, mid, size) : buf[clamp(Math.round(mid), 0, size - 1)];
        a = b = v;
      } else if (exact) {
        a = b = buf[i0];
        for (let i = i0 + 1; i <= i1; i++) {
          const v = buf[i];
          if (v < a) a = v;
          if (v > b) b = v;
        }
        if (fine) {
          // THE COLUMN'S INTERVAL IS FRACTIONAL AND ITS ENDS ARE PART OF IT.
          // Taking only the whole samples inside it is what silently threw the
          // sub-sample trigger away again: `base` carries a fraction, `ceil`
          // rounds it off, and the trace went back to moving a whole sample at
          // a time. Reading the two ends by interpolation is what makes the
          // fractional trigger show up on screen — and it also closes the
          // hairline gap between one column and the next, since a column's
          // last point is now exactly the next one's first. Measured on a
          // steady tone, this is the whole of the difference between the tiers
          // that interpolate the trigger and the tiers that do not: 1.03 px of
          // frame-to-frame drift against 0.007 px.
          const e0 = lerpSample(buf, p0, size);
          const e1 = lerpSample(buf, p1, size);
          if (e0 < a) a = e0;
          if (e0 > b) b = e0;
          if (e1 < a) a = e1;
          if (e1 > b) b = e1;
        }
      } else {
        let best = buf[i0];
        let bestAbs = best < 0 ? -best : best;
        for (let i = i0 + 1; i <= i1; i++) {
          const v = buf[i];
          const m = v < 0 ? -v : v;
          if (m > bestAbs) {
            bestAbs = m;
            best = v;
          }
        }
        a = b = best;
      }
      lo[c] = a;
      hi[c] = b;
      const m = Math.max(a < 0 ? -a : a, b < 0 ? -b : b);
      if (m > peak) peak = m;
    }
    return peak;
  }

  function flatten() {
    if (!cols || !signal) return;
    signal = false;
    loA.fill(0);
    hiA.fill(0);
    loB.fill(0);
    hiB.fill(0);
  }

  function update(frame, dt) {
    if (!cols) return;
    const wv = frame.wave;
    if (!wv || !wv.size || !wv.left) {
      // No tap: the graph is not built yet, or this is an older projector feed.
      // A scope with no probe on it shows a flat line, which is the truth.
      flatten();
      locked = approach(locked, 0, 0.4, dt);
      return;
    }
    const { left, right, size, sampleRate } = wv;
    const sr = sampleRate || 48000;
    const win = Math.min(size - 2, Math.max(64, Math.round((sr * WINDOW_MS) / 1000)));
    const lastStart = size - win - 1;
    const search = Math.min(lastStart, Math.round((sr * (sc.search || SEARCH_MS)) / 1000));
    const from = Math.max(1, lastStart - search);

    // --- the trigger --------------------------------------------------------
    // One forward pass: filter and test in the same loop, keeping the LATEST
    // valid edge so the window shown is the freshest one that is also stable.
    // Measured at ~6k samples of search and 94 analysis frames a second this is
    // about half a million multiply-adds a second — well under the cost of the
    // spectrum pass it rides alongside.
    const k = 1 - Math.exp((-2 * Math.PI * TRIG_HZ) / sr);
    const hyst = Math.max(TRIG_FLOOR, trigEnv * TRIG_HYST);
    let y = 0;
    let prev = 0;
    let armed = false;
    let hit = -1;
    let frac = 0;
    let tpeak = 0;
    for (let i = from; i <= lastStart; i++) {
      prev = y;
      y += k * ((left[i] + right[i]) * 0.5 - y);
      const m = y < 0 ? -y : y;
      if (m > tpeak) tpeak = m;
      if (y < -hyst) armed = true;
      else if (armed && y >= 0 && prev < 0) {
        hit = i - 1;
        // Sub-sample interpolation: one sample at 48 kHz is ~0.95 px of
        // horizontal jitter on a 1920-wide lane, which reads as a shimmer
        // along the whole trace. This is what removes it.
        frac = sc.fine && y !== prev ? clamp(-prev / (y - prev), 0, 1) : 0;
        armed = false;
      }
    }
    trigEnv = envelope(trigEnv, tpeak, dt, 0.08, 1.2);
    const base = hit >= 0 ? hit + frac : lastStart;
    locked = approach(locked, hit >= 0 ? 1 : 0, hit >= 0 ? 0.12 : 0.5, dt);

    // --- the two windows ----------------------------------------------------
    signal = true;
    const pa = reduce(left, size, base, loA, hiA, win);
    const pb = reduce(right, size, base, loB, hiB, win);

    // --- the auto-range -----------------------------------------------------
    // Shared between the channels on purpose: two independent ranges would
    // hide the very thing a stereo scope is for, which is that one side is
    // louder than the other.
    peakEnv = envelope(peakEnv, Math.max(pa, pb), dt, AGC_ATTACK, AGC_RELEASE);
    const want = clamp(
      Math.pow(AGC_TARGET / Math.max(AGC_FLOOR, peakEnv), AGC_SOFT),
      AGC_MIN,
      AGC_MAX
    );
    gain = approach(gain, want, 0.35, dt);
  }

  // --- drawing ---------------------------------------------------------------

  function strokeLane(g, lane, lo, hi, scale, style, width, alpha) {
    const { ox, oy, ax, ay, vx, vy } = lane;
    g.strokeStyle = style;
    g.lineWidth = width;
    g.globalAlpha = alpha;
    g.beginPath();
    for (let c = 0; c < cols; c++) {
      const t = c / (cols - 1 || 1);
      const bx = ox + ax * t;
      const by = oy + ay * t;
      const a = clamp(hi[c] * scale, -1, 1);
      const b = clamp(lo[c] * scale, -1, 1);
      // Max then min, column after column: with one sample per column this is
      // an ordinary polyline, and where a column holds several it draws their
      // true vertical extent — which is exactly the classic scope look, dense
      // where the signal is moving fast and thin where it is not.
      if (c === 0) g.moveTo(bx + vx * a, by + vy * a);
      else g.lineTo(bx + vx * a, by + vy * a);
      if (b !== a) g.lineTo(bx + vx * b, by + vy * b);
    }
    g.stroke();
    g.globalAlpha = 1;
  }

  function graticule(g, lane, pal, a) {
    const { ox, oy, ax, ay, vx, vy } = lane;
    const line = (t0, v0, t1, v1) => {
      g.beginPath();
      g.moveTo(ox + ax * t0 + vx * v0, oy + ay * t0 + vy * v0);
      g.lineTo(ox + ax * t1 + vx * v1, oy + ay * t1 + vy * v1);
      g.stroke();
    };
    g.lineWidth = 1;
    // The frame, then the halves, then the divisions — three weights, so it
    // reads as a scale rather than as graph paper.
    g.strokeStyle = hsl(pal.hue, pal.sat * 0.5, 0.62, a * 0.75);
    g.beginPath();
    g.moveTo(ox + vx, oy + vy);
    g.lineTo(ox + ax + vx, oy + ay + vy);
    g.lineTo(ox + ax - vx, oy + ay - vy);
    g.lineTo(ox - vx, oy - vy);
    g.closePath();
    g.stroke();

    g.strokeStyle = hsl(pal.hue, pal.sat * 0.45, 0.58, a * 0.42);
    line(0, 0.5, 1, 0.5);
    line(0, -0.5, 1, -0.5);
    for (let d = 1; d < sc.divisions; d++) {
      const t = d / sc.divisions;
      line(t, -1, t, 1);
    }
    // The zero line, brightest of the three: it is the one the eye reads the
    // wave against.
    g.strokeStyle = hsl(pal.hue, pal.sat * 0.6, 0.7, a);
    line(0, 0, 1, 0);
  }

  // The trigger marker a scope puts at the edge of its screen, on the trigger
  // level. It fades with the lock, so "the trace stands still because it is
  // triggered" and "it slides because nothing in this passage triggers" are
  // told apart at a glance instead of being a mystery. It sits in the lane's
  // own margin, outside the graticule, exactly where the bezel one does.
  function marker(g, lane, pal, a) {
    if (a <= 0.02) return;
    const s = clamp(lane.span * 0.07, 3.5, 9);
    const { ox, oy } = lane;
    g.fillStyle = hsl(pal.hue + 18, 0.5, 0.8, a);
    g.beginPath();
    if (lane.horiz) {
      g.moveTo(ox - s * 1.4, oy - s);
      g.lineTo(ox - s * 1.4, oy + s);
    } else {
      g.moveTo(ox - s, oy - s * 1.4);
      g.lineTo(ox + s, oy - s * 1.4);
    }
    g.lineTo(ox, oy);
    g.closePath();
    g.fill();
  }

  // Which trace is which. Two unlabelled waveforms are a decoration; "G" and
  // "D" on them is an instrument.
  function label(g, lane, text, pal, a) {
    const size = clamp(Math.min(lane.span, lane.len) * 0.16, 9, 15);
    g.font = `600 ${size.toFixed(1)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = "left";
    g.textBaseline = "top";
    g.fillStyle = hsl(pal.hue, pal.sat * 0.4, 0.78, a);
    // Just inside the graticule's leading corner, whichever way the lane runs.
    const x = lane.ox + (lane.horiz ? lane.len * 0.01 : -lane.span * 0.88);
    const y = lane.horiz ? lane.oy - lane.span * 0.9 : lane.oy + lane.len * 0.01;
    g.fillText(text, x, y);
  }

  function hueFor(ch, pal) {
    if (tint === "mono") return pal.hue;
    return ch === 0 ? pal.low : pal.high;
  }

  function strokeStyleFor(g, lane, ch, pal, light, alpha) {
    if (tint !== "sweep") return hsl(hueFor(ch, pal), pal.sat, light, alpha);
    // The palette walked along the trace, exactly as the bars walk it across
    // their strip: same colour language, so picking "Spectre" or "Pochette"
    // means the same thing here as it does there.
    const { ox, oy, ax, ay } = lane;
    const grad = g.createLinearGradient(ox, oy, ox + ax, oy + ay);
    grad.addColorStop(0, hsl(pal.low, pal.sat, light, alpha));
    grad.addColorStop(0.5, hsl(pal.mid, pal.sat, light, alpha));
    grad.addColorStop(1, hsl(pal.high, pal.sat, light, alpha));
    return grad;
  }

  function draw(g, w, h, pal) {
    if (!cols || !lanes || !w || !h) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    const pdt = lastDraw ? Math.min(0.25, Math.max(0.001, now - lastDraw)) : 1 / 60;
    lastDraw = now;
    // The phosphor, as a time constant rather than a per-frame alpha.
    const wash = 1 - Math.exp(-pdt / PERSIST);

    g.globalCompositeOperation = "source-over";
    g.fillStyle = hsl(pal.hue - 12, pal.sat * 0.45, 0.045, wash);
    g.fillRect(0, 0, w, h);

    const scale = gain * DEFLECT * (0.55 + intensity * 0.45);
    for (let ch = 0; ch < 2; ch++) {
      const lane = lanes[ch];
      if (!(lane.len > 2) || !(lane.span > 1)) continue;
      // The instrument's own face is not light either: a graticule you can
      // read on a desktop and cannot on a phone is the same fault as the beam.
      graticule(g, lane, pal, wash * 2.1);
      marker(g, lane, pal, wash * 1.6 * locked);
      label(g, lane, ch === 0 ? "G" : "D", pal, wash * 1.4);
    }

    g.globalCompositeOperation = "lighter";
    g.lineJoin = "round";
    g.lineCap = "round";
    for (let ch = 0; ch < 2; ch++) {
      const lane = lanes[ch];
      if (!(lane.len > 2) || !(lane.span > 1)) continue;
      const lo = ch === 0 ? loA : loB;
      const hi = ch === 0 ? hiA : hiB;
      // The halo is what makes a one-pixel stroke read as light rather than as
      // ink; the post pass then widens it further. Three passes at the tiers
      // that can afford it, two where they cannot — the core is never the one
      // dropped.
      strokeLane(g, lane, lo, hi, scale,
        strokeStyleFor(g, lane, ch, pal, 0.5, 1), coreW * 5.5, wash * HALO_BRIGHT * glow);
      if (sc.passes > 2)
        strokeLane(g, lane, lo, hi, scale,
          strokeStyleFor(g, lane, ch, pal, 0.62, 1), coreW * 2.3, wash * BODY_BRIGHT * glow);
      strokeLane(g, lane, lo, hi, scale,
        strokeStyleFor(g, lane, ch, pal, 0.88, 1), coreW, wash * CORE_BRIGHT);
    }
    g.globalCompositeOperation = "source-over";
  }

  return {
    resize,
    update,
    draw,
    setOptions,
    get cols() {
      return cols;
    },
    get gain() {
      return gain;
    },
    get locked() {
      return locked;
    },
  };
}

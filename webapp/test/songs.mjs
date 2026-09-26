// WHOLE TRACKS, ARRANGED, WITH THE ANSWER KEY.
//
// test/synth.mjs builds the instruments; this file builds the RECORDS. The
// difference matters because what a rhythm analyser gets wrong on real music
// is almost never a single sound — it is the arrangement around it:
//
//   an intro with no kick, where a tracker has to not invent a tempo;
//   a build whose snares accelerate from quarters to thirty-seconds;
//   the beat of silence producers leave right before a hardcore drop;
//   a breakdown with no drums at all, sixteen bars long, and the drop after it
//     landing exactly on the grid the kick left;
//   a reverse bass or a rolling psy bass on the OFFBEAT, low and loud;
//   a backbeat, a half-time groove, a breakbeat, a swing ride cymbal;
//   a live drummer drifting a percent either side of the click;
//   vocals and a piano that attack like drums and are not drums.
//
// Every record here is built the way the genre is produced — the bus
// structure, the sidechain that ducks the bass under the kick, a reverb send, a
// mastering limiter at the end of the chain — and every one carries its ground
// truth: every beat (including the ones the kick sits out), every downbeat,
// every kick, and where each section starts and stops.
//
// MAINTAINING THIS: the rule is the one test/synth.mjs states. If a record
// breaks the analyser, the first question is whether anyone would make that
// record. The material is never softened to make a score go up.

import {
  SR,
  KICKS,
  renderKick,
  renderScreech,
  renderReverseBass,
  renderHat,
  renderPad,
  limit,
  shape,
  seedNoise,
  noise,
} from "./synth.mjs";

export { SR };

// --- a private, seeded random stream for the ARRANGEMENT (fills, humanise) ---
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- filters -------------------------------------------------------------------
// RBJ biquads, the textbook ones. `set` recomputes the coefficients, which is
// what a sweep does every few samples.
function biquad(type, f, q = 0.707) {
  let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  function set(freq, qq = q) {
    const w = (2 * Math.PI * Math.min(freq, SR * 0.45)) / SR;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const al = sw / (2 * qq);
    let n0, n1, n2;
    if (type === "lp") {
      n0 = (1 - cw) / 2; n1 = 1 - cw; n2 = (1 - cw) / 2;
    } else if (type === "hp") {
      n0 = (1 + cw) / 2; n1 = -(1 + cw); n2 = (1 + cw) / 2;
    } else {
      // band-pass, constant 0 dB peak gain
      n0 = al; n1 = 0; n2 = -al;
    }
    const d0 = 1 + al;
    b0 = n0 / d0; b1 = n1 / d0; b2 = n2 / d0;
    a1 = (-2 * cw) / d0; a2 = (1 - al) / d0;
  }
  set(f, q);
  return {
    set,
    run(x) {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    },
  };
}

const idx = (t) => Math.round(t * SR);
const TAU = Math.PI * 2;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// --- drums -----------------------------------------------------------------------

/** A snare: a tuned shell (two modes, pitch falling) under the wires (noise). */
function renderSnare(bus, at, { gain = 0.42, tone = 190, body = 0.55, snap = 0.9, decay = 0.15, hp = 1400 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * Math.max(decay * 3, 0.2));
  const f1 = biquad("hp", hp, 0.7);
  const f2 = biquad("lp", 9000, 0.7);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    const drop = 1 - 0.12 * Math.min(1, t / 0.03);
    p1 += (TAU * tone * drop) / SR;
    p2 += (TAU * tone * 1.52 * drop) / SR;
    const shell = (Math.sin(p1) + 0.6 * Math.sin(p2)) * Math.exp(-t / 0.07) * body;
    const wires = f2.run(f1.run(noise())) * Math.exp(-t / decay) * snap;
    const atk = Math.min(1, i / 24);
    bus[j] += (shell + wires) * gain * atk;
  }
}

/** A clap: four hands a few milliseconds apart, then the room. */
function renderClap(bus, at, { gain = 0.45 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * 0.3);
  const bp = biquad("bp", 1300, 0.9);
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    let env = 0;
    for (let k = 0; k < 4; k++) {
      const d = t - k * 0.009;
      if (d >= 0) env = Math.max(env, Math.exp(-d / 0.004) * (k === 3 ? 1 : 0.7));
    }
    env += 0.35 * Math.exp(-Math.max(0, t - 0.027) / 0.09) * (t > 0.027 ? 1 : 0);
    bus[j] += bp.run(noise()) * env * gain * 2.2;
  }
}

/** A crash: bright noise and clangorous partials, ringing for seconds. */
function renderCrash(bus, at, { gain = 0.16, len = 1.8 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * len);
  const hp = biquad("hp", 3500, 0.6);
  const parts = [3150, 4420, 5310, 6870, 8120];
  const ph = new Float64Array(parts.length);
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    let m = 0;
    for (let k = 0; k < parts.length; k++) {
      ph[k] += (TAU * parts[k]) / SR;
      m += Math.sign(Math.sin(ph[k]));
    }
    const env = Math.exp(-t / (len * 0.35)) * Math.min(1, i / 30);
    bus[j] += hp.run(noise() * 0.8 + m * 0.08) * env * gain;
  }
}

/** A ride: the ping of the stick on a bell of inharmonic partials. */
function renderRide(bus, at, { gain = 0.1 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * 0.9);
  const parts = [2950, 3710, 4800, 5620, 7230, 8810];
  const ph = new Float64Array(parts.length);
  const hp = biquad("hp", 4000, 0.7);
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    let m = 0;
    for (let k = 0; k < parts.length; k++) {
      ph[k] += (TAU * parts[k]) / SR;
      m += Math.sin(ph[k]) / (1 + k * 0.3);
    }
    const ping = hp.run(noise()) * Math.exp(-t / 0.012) * 0.8;
    bus[j] += (m * 0.25 * Math.exp(-t / 0.4) + ping) * gain;
  }
}

/** A tom, for fills. */
function renderTom(bus, at, { gain = 0.4, f = 110 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * 0.35);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    p += (TAU * f * (1 - 0.3 * Math.min(1, t / 0.2))) / SR;
    bus[j] += Math.sin(p) * Math.exp(-t / 0.12) * gain * Math.min(1, i / 20);
  }
}

// --- bass ---------------------------------------------------------------------------

/**
 * A bass note. `wave` is the oscillator, `cutoff` the filter the note opens
 * through (with an envelope), `detune` > 0 makes it a reese, `lfo` (Hz) makes
 * it a wobble. `glide` slides in from that many semitones below.
 */
function renderBass(bus, at, len, f, o = {}) {
  const {
    wave = "saw", cutoff = 700, env = 1.5, reso = 1.2, drive = 1.4, gain = 0.32,
    detune = 0, lfo = 0, lfoDepth = 0.8, glide = 0, sub = 0.35, release = 0.03,
  } = o;
  const s = idx(at);
  const n = Math.round(SR * (len + release));
  const lp = biquad("lp", cutoff, reso);
  let p1 = 0.13;
  let p2 = 0.51;
  let ps = 0;
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    const g = glide ? Math.pow(2, (-glide * Math.max(0, 1 - t / 0.06)) / 12) : 1;
    const fr = f * g;
    p1 += fr / SR;
    p2 += (fr * (1 + detune)) / SR;
    ps += (TAU * fr) / SR;
    p1 -= Math.floor(p1);
    p2 -= Math.floor(p2);
    let x;
    if (wave === "sine") x = Math.sin(TAU * p1);
    else if (wave === "square") x = p1 < 0.5 ? 1 : -1;
    else x = 2 * p1 - 1;
    if (detune) x = 0.5 * (x + (2 * p2 - 1));
    if (i % 16 === 0) {
      let c = cutoff * (1 + env * Math.exp(-t / 0.08));
      if (lfo) c *= Math.pow(8, lfoDepth * (0.5 - 0.5 * Math.cos(TAU * lfo * t)) - lfoDepth * 0.5);
      lp.set(Math.max(60, c), reso);
    }
    let y = lp.run(x) + Math.sin(ps) * sub;
    y = shape(y, drive);
    const a = Math.min(1, i / 48);
    const r = t > len ? Math.max(0, 1 - (t - len) / release) : 1;
    bus[j] += y * gain * a * r;
  }
}

/** An 808: a sine with a pitch glide, saturated, ringing for as long as asked. */
function render808(bus, at, len, f, { gain = 0.55, glideFrom = 0, drive = 2 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * len);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    const k = glideFrom ? Math.min(1, t / 0.09) : 1;
    const fr = glideFrom ? glideFrom + (f - glideFrom) * k : f * (1 + 1.5 * Math.exp(-t / 0.012));
    p += (TAU * fr) / SR;
    const env = Math.exp(-t / (len * 0.6)) * Math.min(1, i / 30) * Math.min(1, (n - i) / 400);
    bus[j] += shape(Math.sin(p) * 1.2, drive) * env * gain;
  }
}

// --- harmony and melody -----------------------------------------------------------------

/** A supersaw note: detuned saws through a low-pass, with vibrato. */
function renderLead(bus, at, len, f, o = {}) {
  const { voices = 5, spread = 0.012, cutoff = 3200, gain = 0.12, drive = 1.2, vibrato = 0, attack = 0.006, release = 0.08, hp = 180 } = o;
  const s = idx(at);
  const n = Math.round(SR * (len + release));
  const ph = new Float64Array(voices);
  for (let k = 0; k < voices; k++) ph[k] = (k * 0.371) % 1;
  const lp = biquad("lp", cutoff, 0.8);
  const hpf = biquad("hp", hp, 0.7);
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    const vib = vibrato ? 1 + 0.008 * vibrato * Math.sin(TAU * 5.5 * t) * Math.min(1, t / 0.3) : 1;
    let x = 0;
    for (let k = 0; k < voices; k++) {
      const d = 1 + spread * (k / Math.max(1, voices - 1) - 0.5) * 2;
      ph[k] += (f * d * vib) / SR;
      ph[k] -= Math.floor(ph[k]);
      x += 2 * ph[k] - 1;
    }
    x /= voices;
    const a = Math.min(1, t / attack);
    const r = t > len ? Math.max(0, 1 - (t - len) / release) : 1;
    bus[j] += shape(hpf.run(lp.run(x)), drive) * gain * a * r;
  }
}

/** A piano note: struck partials, slightly stretched, the high ones dying first. */
function renderPiano(bus, at, f, { gain = 0.2, len = 1.4, vel = 1 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * len);
  const H = 10;
  const B = 0.00035;
  const fr = new Float64Array(H);
  const am = new Float64Array(H);
  const tau = new Float64Array(H);
  const ph = new Float64Array(H);
  for (let h = 1; h <= H; h++) {
    fr[h - 1] = f * h * Math.sqrt(1 + B * h * h);
    am[h - 1] = Math.pow(h, -1.1) * (h === 1 ? 1 : 0.8 * vel);
    tau[h - 1] = (len * 0.45) / (1 + 0.45 * (h - 1));
  }
  const thump = biquad("lp", 900, 0.7);
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    let x = 0;
    for (let h = 0; h < H; h++) {
      if (fr[h] > SR * 0.45) continue;
      ph[h] += (TAU * fr[h]) / SR;
      x += Math.sin(ph[h]) * am[h] * Math.exp(-t / tau[h]);
    }
    x += thump.run(noise()) * Math.exp(-t / 0.008) * 0.6;
    bus[j] += x * gain * vel * Math.min(1, i / 60) * Math.min(1, (n - i) / 600);
  }
}

/** A distorted guitar power chord: root, fifth, octave, into an amp. */
function renderGuitar(bus, at, len, f, { gain = 0.14, palm = false } = {}) {
  const s = idx(at);
  const n = Math.round(SR * (len + 0.03));
  const ph = [0, 0.3, 0.6];
  const mul = [1, 1.498, 2];
  const lp = biquad("lp", palm ? 1100 : 3400, 0.9);
  const hp = biquad("hp", 90, 0.7);
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    let x = 0;
    for (let k = 0; k < 3; k++) {
      ph[k] += (f * mul[k]) / SR;
      ph[k] -= Math.floor(ph[k]);
      x += 2 * ph[k] - 1;
    }
    const env = palm ? Math.exp(-t / 0.09) : Math.exp(-t / 1.5);
    const r = t > len ? Math.max(0, 1 - (t - len) / 0.03) : 1;
    bus[j] += lp.run(hp.run(shape(x * 0.6, 9))) * env * gain * r * Math.min(1, i / 40);
  }
}

// Formants (F1, F2, F3) of five vowels, from the textbook tables.
const VOWELS = {
  a: [800, 1150, 2900],
  e: [400, 1700, 2600],
  i: [300, 2300, 3000],
  o: [450, 800, 2830],
  u: [325, 700, 2530],
};

/**
 * One sung syllable: a glottal buzz through three formant resonators, with a
 * consonant's noise on the front and the vibrato a held note grows.
 */
function renderSyllable(bus, at, len, f, vowel = "a", { gain = 0.16, consonant = 0.5 } = {}) {
  const s = idx(at);
  const n = Math.round(SR * (len + 0.06));
  const [F1, F2, F3] = VOWELS[vowel] || VOWELS.a;
  const r1 = biquad("bp", F1, 6);
  const r2 = biquad("bp", F2, 8);
  const r3 = biquad("bp", F3, 10);
  const cons = biquad("hp", 3500, 0.7);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const j = s + i;
    if (j < 0 || j >= bus.length) continue;
    const t = i / SR;
    const vib = 1 + 0.012 * Math.sin(TAU * 5.3 * t) * Math.min(1, Math.max(0, t - 0.15) / 0.2);
    p += (f * vib) / SR;
    p -= Math.floor(p);
    // A glottal pulse: a sharp closure once a period.
    const src = p < 0.6 ? Math.sin((Math.PI * p) / 0.6) : 0;
    const y = r1.run(src) * 1.0 + r2.run(src) * 0.6 + r3.run(src) * 0.3;
    const a = Math.min(1, t / 0.025);
    const r = t > len ? Math.max(0, 1 - (t - len) / 0.06) : 1;
    const c = t < 0.03 ? cons.run(noise()) * (1 - t / 0.03) * consonant : 0;
    bus[j] += (y * 3 + c) * gain * a * r;
  }
}

/** A riser: noise through a band-pass sweeping up, and a tone sweeping with it. */
function renderRiser(bus, from, to, { gain = 0.18 } = {}) {
  const a = idx(from);
  const b = idx(to);
  const bp = biquad("bp", 400, 2.5);
  let p = 0;
  for (let j = Math.max(0, a); j < Math.min(b, bus.length); j++) {
    const k = (j - a) / Math.max(1, b - a);
    if ((j - a) % 32 === 0) bp.set(400 * Math.pow(22, k), 2.5);
    p += (TAU * 200 * Math.pow(10, k)) / SR;
    bus[j] += (bp.run(noise()) * 1.8 + Math.sin(p) * 0.15) * gain * k * k;
  }
}

// --- the mix -----------------------------------------------------------------------------

/** A Schroeder reverb: four combs into two all-passes. Returns the wet signal. */
function reverb(input, { room = 0.78, damp = 0.35, mix = 0.25 } = {}) {
  const out = new Float32Array(input.length);
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => ({
    buf: new Float32Array(Math.round(d * SR)),
    i: 0,
    lp: 0,
  }));
  const aps = [0.005, 0.0017].map((d) => ({ buf: new Float32Array(Math.round(d * SR)), i: 0 }));
  for (let j = 0; j < input.length; j++) {
    const x = input[j];
    let y = 0;
    for (const c of combs) {
      const d = c.buf[c.i];
      c.lp = d * (1 - damp) + c.lp * damp;
      c.buf[c.i] = x + c.lp * room;
      c.i = (c.i + 1) % c.buf.length;
      y += d;
    }
    y *= 0.25;
    for (const a of aps) {
      const d = a.buf[a.i];
      const v = y + d * 0.5;
      a.buf[a.i] = v;
      a.i = (a.i + 1) % a.buf.length;
      y = d - v * 0.5;
    }
    out[j] = y * mix;
  }
  return out;
}

/** Sidechain: the bus ducks under every kick and swells back. */
function sidechain(bus, kicks, { depth = 0.75, release = 0.16 } = {}) {
  if (!kicks.length) return;
  const sorted = [...kicks].sort((a, b) => a - b);
  let k = 0;
  let last = -1e9;
  for (let j = 0; j < bus.length; j++) {
    const t = j / SR;
    while (k < sorted.length && sorted[k] <= t) last = sorted[k++];
    const since = t - last;
    const g = 1 - depth * (since < 0.004 ? since / 0.004 : Math.exp(-(since - 0.004) / release));
    bus[j] *= since >= 0 ? g : 1;
  }
}

// --- the arranger -------------------------------------------------------------------------

/**
 * Render one song. `def` is a record from SONGS below. Returns the PCM and the
 * ground truth:
 *   beats / downbeats   every one, including the beats the kick sits out
 *   kicks               every kick onset; mainKicks: the ones on a beat
 *   sections            [{type, from, to}], in seconds
 *   drops               the moments the arrangement comes back
 */
export function renderSong(def) {
  const r = mulberry(def.seed || 7);
  seedNoise(def.seed || 7);
  const meter = def.meter || 4;
  const bars = def.sections.reduce((a, s) => a + s.bars, 0);
  const nBeats = bars * meter;
  // The beat grid, with a drummer's drift where the genre is played live.
  const beatT = new Float64Array(nBeats + 2);
  const P = 60 / def.bpm;
  let t = def.lead ?? 0.35;
  let drift = 0;
  for (let b = 0; b < beatT.length; b++) {
    beatT[b] = t;
    if (def.drift) drift = Math.max(-def.drift, Math.min(def.drift, drift * 0.96 + gauss(r) * def.drift * 0.25));
    const rub = def.rubato ? def.rubato * Math.sin((b / meter / 4) * Math.PI) : 0;
    t += P * (1 + drift + rub);
  }
  const seconds = beatT[nBeats] + 1.2;
  const len = Math.round(seconds * SR);
  const drums = new Float32Array(len);
  const bass = new Float32Array(len);
  const music = new Float32Array(len);
  const vox = new Float32Array(len);
  const send = new Float32Array(len);

  const at = (beat) => {
    const b = Math.floor(beat);
    const f = beat - b;
    const i = Math.max(0, Math.min(beatT.length - 2, b));
    return beatT[i] + (beatT[i + 1] - beatT[i]) * f;
  };
  const human = def.human || 0; // ms
  const jit = () => (human ? gauss(r) * human * 0.001 : 0);

  const truth = {
    id: def.id,
    genre: def.genre,
    bpm: def.bpm,
    meter,
    beats: [],
    downbeats: [],
    kicks: [],
    mainKicks: [],
    sections: [],
    drops: [],
    seconds,
  };
  for (let b = 0; b < nBeats; b++) {
    truth.beats.push(beatT[b]);
    if (b % meter === 0) truth.downbeats.push(beatT[b]);
  }

  // The kick designs are the synth's; genres that need another get it here.
  const kickOpt = { ...(KICKS[def.kick] || KICKS[def.genre] || KICKS.techno), ...(def.kickOpt || {}) };
  const kick = (beat, o = {}) => {
    const tt = at(beat) + jit();
    const onBeat = Math.abs(beat - Math.round(beat)) < 0.02;
    truth.kicks.push(tt);
    if (onBeat) truth.mainKicks.push(tt);
    // A roll's notes are shortened to fit their subdivision, as producers do.
    const room = (o.room ?? 1) * P;
    const lenMs = Math.min(kickOpt.lenMs ?? 300, room * 1000 * 0.92);
    renderKick(drums, tt, {
      ...kickOpt,
      lenMs,
      sweepMs: Math.min(kickOpt.sweepMs ?? 90, lenMs * 0.4),
      gain: (kickOpt.gain ?? 0.7) * (o.vel ?? 1) * (1 - (def.velJitter || 0) * r()),
    });
  };
  const snare = (beat, o = {}) => renderSnare(drums, at(beat) + jit(), { ...(def.snare || {}), ...o });
  const clap = (beat, o = {}) => renderClap(drums, at(beat) + jit(), o);
  const hat = (beat, o = {}) => renderHat(drums, at(beat) + jit(), { gain: 0.1 * (o.vel ?? 1) * (def.hatGain ?? 1), lenMs: o.open ? 170 : 35 });
  const crash = (beat) => renderCrash(drums, at(beat) + jit());
  const ride = (beat, v = 1) => renderRide(drums, at(beat) + jit(), { gain: 0.1 * v });
  const tom = (beat, f) => renderTom(drums, at(beat) + jit(), { f });

  // Harmony: a four-chord loop, one chord a bar, as MIDI roots.
  const prog = def.prog || [57, 53, 60, 55];
  const scale = [0, 2, 3, 5, 7, 8, 10];

  let bar0 = 0;
  const ctx = { r, at, kick, snare, clap, hat, crash, ride, tom, P, meter, prog, scale, midi };
  for (let si = 0; si < def.sections.length; si++) {
    const sec = def.sections[si];
    const from = at(bar0 * meter);
    const to = at((bar0 + sec.bars) * meter);
    truth.sections.push({ type: sec.type, from, to });
    const prev = def.sections[si - 1];
    if (sec.type === "drop" && prev && prev.type !== "drop") truth.drops.push(from);
    for (let br = 0; br < sec.bars; br++) {
      const bar = bar0 + br;
      const chord = prog[bar % prog.length];
      for (let bi = 0; bi < meter; bi++) {
        const beat = bar * meter + bi;
        def.groove({ ...ctx, sec, bar, br, bi, beat, chord, last: br === sec.bars - 1 });
      }
      // The sustained layers, a bar at a time.
      if (sec.pad) renderPad(music, idx(at(bar * meter)), idx(at((bar + 1) * meter)), { f: midi(chord + 12), gain: 0.07 * sec.pad });
      if (sec.bass && def.bassLine)
        def.bassLine({ ...ctx, sec, bar, br, chord, bassBus: bass, renderBass, render808, at });
      if (sec.lead && def.leadLine)
        def.leadLine({ ...ctx, sec, bar, br, chord, bus: music, renderLead, renderPiano, renderScreech, renderGuitar, at });
      if (sec.vocal) singBar(vox, ctx, bar, chord, sec.vocal, def.rap);
      if (sec.piano) pianoBar(music, ctx, bar, chord, sec.piano, def.pianoStyle);
      if (sec.guitar) guitarBar(music, ctx, bar, chord, sec);
    }
    if (sec.riser) renderRiser(music, from, to, { gain: 0.16 * sec.riser });
    if (sec.rbass) renderReverseBass(bass, truth.kicks.filter((k) => k >= from - 0.01 && k < to), { f: 58, gain: 0.45 });
    if (sec.gapBefore) {
      // THE BEAT OF SILENCE BEFORE THE DROP: everything cut for the last beats
      // of this section. It is a mix move, so it applies to every bus.
      const g0 = idx(at((bar0 + sec.bars) * meter - sec.gapBefore));
      const g1 = idx(to);
      for (const bus of [drums, bass, music, vox]) for (let j = g0; j < g1 && j < len; j++) bus[j] *= 0.02;
    }
    bar0 += sec.bars;
  }

  // The mix: sidechain the melodic buses under the kick, a reverb send, sum.
  if (def.sidechain !== false) {
    sidechain(bass, truth.kicks, { depth: def.duck ?? 0.8, release: Math.min(0.2, P * 0.45) });
    sidechain(music, truth.kicks, { depth: (def.duck ?? 0.8) * 0.6, release: Math.min(0.25, P * 0.55) });
  }
  for (let j = 0; j < len; j++) send[j] = music[j] * 0.6 + vox[j] * 0.5 + drums[j] * (def.drumVerb ?? 0.05);
  const wet = reverb(send, { mix: def.verb ?? 0.22 });
  const mix = new Float32Array(len);
  const gd = def.mixDrums ?? 1;
  const gb = def.mixBass ?? 1;
  const gm = def.mixMusic ?? 1;
  for (let j = 0; j < len; j++) mix[j] = drums[j] * gd + bass[j] * gb + music[j] * gm + vox[j] + wet[j] + noise() * 1e-4;
  const pcm = limit(mix, { ceil: 0.95, releaseMs: def.limiterRelease ?? 140 });
  truth.kicks.sort((a, b) => a - b);
  truth.mainKicks.sort((a, b) => a - b);
  return { pcm, truth };
}

// A sung line: syllables on the eighths, a melody around the chord.
function singBar(bus, ctx, bar, chord, amount, rap) {
  const { at, meter, r } = ctx;
  const vowels = "aeiou";
  const steps = rap ? meter * 4 : meter * 2;
  for (let k = 0; k < steps; k++) {
    if (r() < (rap ? 0.25 : 0.3)) continue;
    const beat = bar * meter + (k * meter) / steps + (rap ? (r() - 0.5) * 0.08 : 0);
    const len = ((meter / steps) * ctx.P) * (rap ? 0.6 : 0.9);
    const note = chord + 12 + [0, 3, 7, 10, 12][Math.floor(r() * 5)];
    renderSyllable(bus, at(beat), len, midi(note), vowels[Math.floor(r() * 5)], { gain: 0.14 * amount, consonant: rap ? 0.9 : 0.5 });
  }
}

// A piano part: 'block' chords on the beat, 'ragtime' oom-pah, 'arp' eighths,
// 'rubato' free melody.
function pianoBar(bus, ctx, bar, chord, amount, style = "block") {
  const { at, meter, r } = ctx;
  const g = 0.2 * amount;
  const triad = [0, 3, 7];
  if (style === "ragtime") {
    for (let bi = 0; bi < meter; bi++) {
      const beat = bar * meter + bi;
      if (bi % 2 === 0) renderPiano(bus, at(beat), midi(chord - 12), { gain: g * 1.1, len: 0.5 });
      else for (const iv of triad) renderPiano(bus, at(beat), midi(chord + iv), { gain: g * 0.6, len: 0.35 });
      // The right hand, syncopated.
      if (r() < 0.8) renderPiano(bus, at(beat + (r() < 0.5 ? 0 : 0.5)), midi(chord + 12 + [0, 4, 7, 12][Math.floor(r() * 4)]), { gain: g * 0.7, len: 0.4 });
    }
    return;
  }
  if (style === "arp") {
    for (let k = 0; k < meter * 2; k++) {
      const beat = bar * meter + k / 2;
      renderPiano(bus, at(beat), midi(chord + 12 + [0, 3, 7, 12][k % 4]), { gain: g * 0.7, len: 0.6 });
    }
    return;
  }
  if (style === "rubato") {
    let beat = bar * meter;
    while (beat < (bar + 1) * meter) {
      renderPiano(bus, at(beat), midi(chord + 12 + [0, 2, 3, 5, 7, 8, 10, 12][Math.floor(r() * 8)]), { gain: g * (0.5 + 0.5 * r()), len: 1.2 });
      beat += [0.5, 1, 1, 1.5][Math.floor(r() * 4)];
    }
    renderPiano(bus, at(bar * meter), midi(chord - 12), { gain: g, len: 2.5 });
    return;
  }
  for (let bi = 0; bi < meter; bi++) {
    const beat = bar * meter + bi;
    for (const iv of triad) renderPiano(bus, at(beat), midi(chord + iv), { gain: g * 0.55, len: 0.9 });
  }
}

// A guitar part: eighth-note chugs, the downbeat let ring.
function guitarBar(bus, ctx, bar, chord, sec) {
  const { at, meter } = ctx;
  for (let k = 0; k < meter * 2; k++) {
    const beat = bar * meter + k / 2;
    const palm = sec.guitar === "chug" && k % 2 === 1;
    renderGuitar(bus, at(beat), ctx.P * 0.48, midi(chord - 12), { gain: 0.12, palm });
  }
}

// --- the arrangements ------------------------------------------------------------------------
//
// The EDM form most of this catalogue is written in, and the one a drop
// detector has to read: intro, build, drop, breakdown, build, drop.
function edm({ intro = 4, build = 4, drop = 8, breakdown = 4, gap = 0, riser = 1 } = {}) {
  return [
    { type: "intro", bars: intro, kick: true, hats: 1, bass: true },
    { type: "build", bars: build, roll: true, riser, pad: 0.6, lead: "filtered", gapBefore: gap },
    { type: "drop", bars: drop, kick: true, hats: 1, bass: true, lead: true, snare: true, crash: true },
    { type: "breakdown", bars: breakdown, pad: 1, lead: "soft", vocal: 0.8 },
    { type: "build", bars: build, roll: true, riser, pad: 0.8, gapBefore: gap },
    { type: "drop", bars: drop, kick: true, hats: 1, bass: true, lead: true, snare: true, crash: true },
  ];
}

// The snare roll of a build: quarters, then eighths, sixteenths, thirty-seconds,
// getting louder — the single most recognisable sound in the genre.
function buildRoll(c, { useKick = false } = {}) {
  const { sec, br, bi, beat } = c;
  const prog = br / sec.bars;
  const div = prog < 0.25 ? 1 : prog < 0.5 ? 2 : prog < 0.75 ? 4 : 8;
  for (let k = 0; k < div; k++) {
    const v = 0.35 + 0.65 * (br + (bi + k / div) / c.meter) / sec.bars;
    if (useKick) c.kick(beat + k / div, { room: 1 / div, vel: 0.5 + 0.5 * v });
    else c.snare(beat + k / div, { gain: 0.32 * v });
  }
}

// A drum fill into the next section, on the toms.
function fill(c) {
  const { beat, bi, meter } = c;
  if (bi === meter - 1) for (let k = 0; k < 4; k++) c.tom(beat + k / 4, 180 - k * 25);
}

// Hard dance: a kick on every beat, the lead screaming in the drop.
function hardGroove(c, { rolls = null, screech = true } = {}) {
  const { sec, beat, bi, br } = c;
  if (sec.roll) return buildRoll(c, { useKick: !!sec.kickRoll });
  if (sec.kick) {
    const offs = rolls ? rolls(beat, br, sec) : [0];
    for (const o of offs) c.kick(beat + o, { room: offs.length > 1 ? offs[1] - offs[0] : 1 });
  }
  if (sec.crash && br === 0 && bi === 0) c.crash(beat);
  if (sec.hats) c.hat(beat + 0.5, { vel: 0.8 });
  if (sec.snare && bi % 2 === 1) c.clap(beat, { gain: 0.3 });
  void screech;
}

function hardLead(opts = {}) {
  return (c) => {
    const { sec, bar, chord, bus, at, meter } = c;
    const mel = [0, 3, 7, 5, 3, 7, 10, 7];
    for (let k = 0; k < meter * 2; k++) {
      const beat = bar * meter + k / 2;
      const n = chord + 24 + mel[(bar * 8 + k) % mel.length];
      if (sec.lead === "filtered") c.renderLead(bus, at(beat), c.P * 0.45, midi(n), { cutoff: 600 + 3000 * (c.br / c.sec.bars), gain: 0.07 });
      else if (sec.lead === "soft") c.renderLead(bus, at(beat), c.P * 0.9, midi(n), { gain: 0.08, vibrato: 1 });
      else if (opts.screech && k % 2 === 1) c.renderScreech(bus, at(beat), { f: midi(n), lenMs: c.P * 400, gain: 0.35, ...opts.screech });
      else if (!opts.screech) c.renderLead(bus, at(beat), c.P * 0.45, midi(n), { gain: 0.1, drive: opts.drive ?? 2 });
    }
  };
}

function offbeatBass({ wave = "saw", cutoff = 500 } = {}) {
  return (c) => {
    const { bar, chord, meter } = c;
    for (let bi = 0; bi < meter; bi++)
      c.renderBass(c.bassBus, c.at(bar * meter + bi + 0.5), c.P * 0.4, midi(chord - 24), { wave, cutoff, gain: 0.3 });
  };
}

// --- the catalogue ----------------------------------------------------------------------------

export const SONGS = [
  // === the hard end =====================================================================
  {
    id: "hardstyle-150",
    genre: "hardstyle",
    bpm: 150,
    kick: "hardstyle",
    sections: edm({ gap: 1 }).map((s) => (s.type === "drop" ? { ...s, rbass: true, bass: false } : s)),
    groove: (c) => hardGroove(c),
    leadLine: hardLead({ screech: { hpHz: 180 } }),
  },
  {
    id: "rawstyle-155",
    genre: "rawstyle",
    bpm: 155,
    kick: "rawstyle",
    kickOpt: { f0: 210, f1: 52, sweepMs: 50, lenMs: 380, drive: 20, click: 0.45, gain: 0.8, saw: 0.35, sawDrive: 14 },
    sections: edm({ gap: 1 }),
    groove: (c) => hardGroove(c),
    leadLine: hardLead({ screech: { hpHz: 220, drive: 9 } }),
  },
  {
    id: "frenchcore-200",
    genre: "frenchcore",
    bpm: 200,
    kick: "frenchcore",
    velJitter: 0.25,
    sections: edm({ intro: 4, build: 4, drop: 8, breakdown: 8, gap: 1 }).map((s) =>
      s.type === "build" ? { ...s, kickRoll: true } : s.type === "breakdown" ? { ...s, piano: 1, vocal: 0 } : s
    ),
    groove: (c) =>
      hardGroove(c, { rolls: (beat, br) => (br % 4 === 3 && beat % 4 === 3 ? [0, 1 / 3, 2 / 3] : [0]) }),
    leadLine: hardLead({ drive: 3 }),
    pianoStyle: "arp",
  },
  {
    id: "uptempo-220",
    genre: "uptempo",
    bpm: 220,
    kick: "uptempo",
    velJitter: 0.3,
    sections: edm({ intro: 4, build: 4, drop: 12, breakdown: 4, gap: 2 }).map((s) => (s.type === "build" ? { ...s, kickRoll: true } : s)),
    groove: (c) =>
      hardGroove(c, {
        rolls: (beat) => {
          const p = beat % 8;
          if (p === 3) return [0, 0.5];
          if (p === 7) return [0, 0.25, 0.5, 0.75];
          return [0];
        },
      }),
    leadLine: hardLead({ screech: { hpHz: 250, drive: 10, bend: 2 } }),
  },
  {
    id: "zaag-190",
    genre: "zaag",
    bpm: 190,
    kick: "zaag",
    sections: edm({ gap: 1 }),
    groove: (c) => hardGroove(c),
    leadLine: (c) => {
      // The saw lead: a detuned, driven saw stack, sliding.
      const { bar, chord, meter, sec } = c;
      if (sec.lead === "filtered" || sec.lead === "soft") return hardLead({})(c);
      for (let k = 0; k < meter; k++)
        c.renderLead(c.bus, c.at(bar * meter + k), c.P * 0.95, midi(chord + 12 + (k % 2) * 7), { voices: 7, spread: 0.03, drive: 6, gain: 0.12, cutoff: 5000 });
    },
  },
  {
    id: "krach-210",
    genre: "krach",
    bpm: 210,
    kick: "krach",
    kickOpt: { f0: 240, f1: 48, sweepMs: 40, lenMs: 320, drive: 34, click: 0.7, gain: 0.85, saw: 0.8, sawDrive: 22 },
    sections: edm({ gap: 1 }),
    groove: (c) => hardGroove(c, { rolls: (beat) => (beat % 16 === 15 ? [0, 0.25, 0.5, 0.75] : [0]) }),
    leadLine: hardLead({ screech: { hpHz: 300, drive: 14, bend: 2.4 } }),
  },
  {
    id: "gabber-185",
    genre: "gabber",
    bpm: 185,
    kick: "gabber",
    sections: edm({ breakdown: 4 }),
    groove: (c) => hardGroove(c),
    leadLine: hardLead({ screech: { hpHz: 200 } }),
  },
  {
    id: "speedcore-280",
    genre: "speedcore",
    bpm: 280,
    kick: "speedcore",
    sections: edm({ intro: 4, build: 4, drop: 12, breakdown: 4 }),
    groove: (c) => hardGroove(c),
    leadLine: hardLead({ screech: { hpHz: 300, drive: 12 } }),
  },
  // === techno, house, trance ===============================================================
  {
    id: "techno-132",
    genre: "techno",
    bpm: 132,
    kick: "techno",
    sections: edm({ intro: 8, build: 4, drop: 16, breakdown: 8 }).map((s) => ({ ...s, vocal: 0 })),
    groove: (c) => {
      const { sec, beat, bi, br } = c;
      if (sec.roll) return buildRoll(c);
      if (sec.kick) c.kick(beat);
      if (sec.hats) {
        c.hat(beat + 0.5, { open: true, vel: 0.9 });
        c.hat(beat + 0.25, { vel: 0.4 });
        c.hat(beat + 0.75, { vel: 0.4 });
      }
      if (sec.snare && bi % 2 === 1) c.clap(beat);
      if (sec.crash && br === 0 && bi === 0) c.crash(beat);
    },
    bassLine: (c) => {
      // A rumble: the kick's own tail, reverbed and filtered, on the offbeats.
      const { bar, chord, meter } = c;
      for (let bi = 0; bi < meter; bi++)
        c.renderBass(c.bassBus, c.at(bar * meter + bi + 0.5), c.P * 0.35, midi(chord - 24), { wave: "sine", cutoff: 200, gain: 0.25 });
    },
    leadLine: (c) => {
      const { bar, meter, chord } = c;
      for (let k = 0; k < meter * 4; k += 3) c.renderLead(c.bus, c.at(bar * meter + k / 4), c.P * 0.2, midi(chord + 12), { gain: 0.06, voices: 2, cutoff: 1800 });
    },
  },
  {
    id: "house-124",
    genre: "house",
    bpm: 124,
    kick: "house",
    kickOpt: { f0: 120, f1: 50, sweepMs: 30, lenMs: 230, drive: 2.2, click: 0.16, gain: 0.66 },
    sections: [
      { type: "intro", bars: 8, kick: true, hats: 1 },
      { type: "verse", bars: 8, kick: true, hats: 1, bass: true, piano: 0.8, vocal: 0.9, snare: true },
      { type: "breakdown", bars: 4, pad: 1, vocal: 1, piano: 0.6 },
      { type: "drop", bars: 16, kick: true, hats: 1, bass: true, piano: 1, vocal: 0.7, snare: true, crash: true },
    ],
    groove: (c) => {
      const { sec, beat, bi, br } = c;
      if (sec.kick) c.kick(beat);
      if (sec.hats) {
        c.hat(beat + 0.5, { open: true, vel: 0.8 });
        c.hat(beat + 0.25 + 0.03, { vel: 0.35 });
        c.hat(beat + 0.75 + 0.03, { vel: 0.35 });
      }
      if (sec.snare && bi % 2 === 1) c.clap(beat);
      if (sec.crash && br === 0 && bi === 0) c.crash(beat);
    },
    bassLine: offbeatBass({ wave: "saw", cutoff: 380 }),
    prog: [57, 60, 62, 55],
    pianoStyle: "block",
  },
  {
    id: "trance-138",
    genre: "trance",
    bpm: 138,
    kick: "techno",
    kickOpt: { f0: 130, f1: 48, sweepMs: 35, lenMs: 200, drive: 3, click: 0.22, gain: 0.66 },
    sections: edm({ intro: 8, build: 8, drop: 16, breakdown: 8 }),
    groove: (c) => {
      const { sec, beat, bi, br } = c;
      if (sec.roll) return buildRoll(c);
      if (sec.kick) c.kick(beat);
      if (sec.hats) c.hat(beat + 0.5, { open: true });
      if (sec.snare && bi % 2 === 1) c.clap(beat, { gain: 0.3 });
      if (sec.crash && br === 0 && bi === 0) c.crash(beat);
    },
    bassLine: (c) => {
      // The rolling trance bass: three sixteenths after each kick.
      const { bar, chord, meter } = c;
      for (let bi = 0; bi < meter; bi++)
        for (const o of [0.25, 0.5, 0.75])
          c.renderBass(c.bassBus, c.at(bar * meter + bi + o), c.P * 0.2, midi(chord - 24), { cutoff: 600, gain: 0.26 });
    },
    leadLine: (c) => {
      const { bar, chord, meter, sec } = c;
      const mel = [12, 15, 19, 17, 15, 12, 10, 12];
      for (let k = 0; k < meter * 2; k++)
        c.renderLead(c.bus, c.at(bar * meter + k / 2), c.P * 0.45, midi(chord + mel[(bar * 8 + k) % 8]), {
          gain: sec.lead === "soft" ? 0.07 : 0.1,
          cutoff: sec.lead === "filtered" ? 700 + 3500 * (c.br / sec.bars) : 5000,
          voices: 7,
          spread: 0.02,
        });
    },
  },
  {
    id: "psytrance-145",
    genre: "psytrance",
    bpm: 145,
    kick: "techno",
    kickOpt: { f0: 150, f1: 52, sweepMs: 22, lenMs: 120, drive: 3, click: 0.3, gain: 0.7 },
    sections: edm({ intro: 8, build: 4, drop: 16, breakdown: 4 }).map((s) => ({ ...s, vocal: 0 })),
    groove: (c) => {
      const { sec, beat } = c;
      if (sec.roll) return buildRoll(c);
      if (sec.kick) c.kick(beat);
      if (sec.hats) {
        c.hat(beat + 0.5, { open: true, vel: 0.7 });
        for (const o of [0.25, 0.75]) c.hat(beat + o, { vel: 0.5 });
      }
    },
    bassLine: (c) => {
      // KBBB: the kick, then three bass notes on the sixteenths.
      const { bar, chord, meter } = c;
      for (let bi = 0; bi < meter; bi++)
        for (const o of [0.25, 0.5, 0.75])
          c.renderBass(c.bassBus, c.at(bar * meter + bi + o), c.P * 0.18, midi(chord - 24), { cutoff: 900, env: 3, gain: 0.34, drive: 2 });
    },
    leadLine: (c) => {
      const { bar, chord, meter } = c;
      for (let k = 0; k < meter * 4; k++)
        if ((k * 7) % 5 < 3) c.renderLead(c.bus, c.at(bar * meter + k / 4), c.P * 0.2, midi(chord + 24 + (k % 3) * 5), { gain: 0.07, voices: 3, cutoff: 2500 + 2000 * Math.sin(k) });
    },
    duck: 0.3,
  },
  // === bass & breaks =======================================================================
  {
    id: "dnb-174",
    genre: "dnb",
    bpm: 174,
    kick: "techno",
    kickOpt: { f0: 140, f1: 50, sweepMs: 25, lenMs: 170, drive: 3, click: 0.35, gain: 0.7 },
    snare: { tone: 210, gain: 0.5, decay: 0.12 },
    sections: [
      { type: "intro", bars: 4, hats: 1, pad: 0.6 },
      { type: "build", bars: 4, roll: true, riser: 1, pad: 0.6 },
      { type: "drop", bars: 16, kick: true, snare: true, hats: 1, bass: true, crash: true },
      { type: "breakdown", bars: 4, pad: 1, vocal: 0.7 },
      { type: "drop", bars: 8, kick: true, snare: true, hats: 1, bass: true, crash: true },
    ],
    groove: (c) => {
      const { sec, beat, bi, br, bar } = c;
      if (sec.roll) return buildRoll(c);
      // Two-step: kick on 1 and on the "and" of 3, snare on 2 and 4.
      if (sec.kick) {
        if (bi === 0) c.kick(beat);
        if (bi === 2) c.kick(beat + 0.5);
      }
      if (sec.snare && bi % 2 === 1) c.snare(beat);
      if (sec.hats) for (const o of [0, 0.5]) c.hat(beat + o, { vel: o ? 0.5 : 0.7 });
      if (sec.crash && br === 0 && bi === 0) c.crash(beat);
      void bar;
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      c.renderBass(c.bassBus, c.at(bar * meter), c.P * 3.8, midi(chord - 24), { detune: 0.012, cutoff: 500, env: 0.5, gain: 0.3, drive: 2.5 });
    },
    sidechain: false,
  },
  {
    id: "dubstep-140",
    genre: "dubstep",
    bpm: 140,
    kick: "techno",
    kickOpt: { f0: 160, f1: 48, sweepMs: 30, lenMs: 220, drive: 4, click: 0.3, gain: 0.75 },
    snare: { tone: 200, gain: 0.55, decay: 0.2 },
    sections: [
      { type: "intro", bars: 4, pad: 0.8, hats: 1 },
      { type: "build", bars: 4, roll: true, riser: 1, pad: 0.8 },
      { type: "drop", bars: 8, kick: true, snare: true, hats: 1, bass: true, crash: true },
      { type: "breakdown", bars: 4, pad: 1, vocal: 0.8 },
      { type: "build", bars: 4, roll: true, riser: 1 },
      { type: "drop", bars: 8, kick: true, snare: true, hats: 1, bass: true, crash: true },
    ],
    groove: (c) => {
      const { sec, beat, bi, br } = c;
      if (sec.roll) return buildRoll(c);
      // Half time: the kick on 1, the snare on 3.
      if (sec.kick && bi === 0) c.kick(beat);
      if (sec.kick && bi === 1 && br % 2 === 1) c.kick(beat + 0.5, { vel: 0.8 });
      if (sec.snare && bi === 2) c.snare(beat);
      if (sec.hats) c.hat(beat + 0.5, { vel: 0.5 });
      if (sec.crash && br === 0 && bi === 0) c.crash(beat);
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      c.renderBass(c.bassBus, c.at(bar * meter), c.P * 1.9, midi(chord - 24), { wave: "saw", cutoff: 300, lfo: 140 / 60 * 2, lfoDepth: 1, gain: 0.34, drive: 3 });
      c.renderBass(c.bassBus, c.at(bar * meter + 2), c.P * 1.9, midi(chord - 24), { wave: "square", cutoff: 300, lfo: 140 / 60 * 4, lfoDepth: 1, gain: 0.34, drive: 3 });
    },
  },
  {
    id: "trap-140",
    genre: "trap",
    bpm: 140,
    kick: "trap",
    snare: { tone: 220, gain: 0.5, decay: 0.18 },
    sections: [
      { type: "intro", bars: 4, pad: 0.7, piano: 0.6 },
      { type: "verse", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 1, piano: 0.5 },
      { type: "drop", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 0.8, pad: 0.6 },
      { type: "break", bars: 2, pad: 1, vocal: 1 },
      { type: "drop", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 0.8 },
    ],
    rap: true,
    pianoStyle: "arp",
    groove: (c) => {
      const { sec, beat, bi, br, r } = c;
      if (sec.kick && (bi === 0 || (bi === 1 && br % 2 === 0))) {
        c.kick(beat + (bi === 1 ? 0.75 : 0));
      }
      if (sec.snare && bi === 2) c.clap(beat);
      if (sec.hats) {
        const roll = r() < 0.18;
        const div = roll ? 6 : 2;
        for (let k = 0; k < div; k++) c.hat(beat + k / div, { vel: 0.5 + (k === 0 ? 0.3 : 0) });
      }
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      c.render808(c.bassBus, c.at(bar * meter), c.P * 1.6, midi(chord - 24), { gain: 0.5 });
      c.render808(c.bassBus, c.at(bar * meter + 2.5), c.P * 1.2, midi(chord - 22), { gain: 0.45, glideFrom: midi(chord - 29) });
    },
    sidechain: false,
  },
  // === urban, pop, rock ====================================================================
  {
    id: "boombap-90",
    genre: "hiphop",
    bpm: 90,
    kick: "techno",
    kickOpt: { f0: 95, f1: 50, sweepMs: 30, lenMs: 260, drive: 2, click: 0.28, gain: 0.72 },
    snare: { tone: 180, gain: 0.55, decay: 0.16 },
    human: 6,
    sections: [
      { type: "intro", bars: 2, piano: 0.8 },
      { type: "verse", bars: 12, kick: true, snare: true, hats: 1, bass: true, vocal: 1, piano: 0.7 },
      { type: "chorus", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 0.9, piano: 0.9 },
    ],
    rap: true,
    pianoStyle: "block",
    groove: (c) => {
      const { sec, beat, bi } = c;
      if (sec.kick) {
        if (bi === 0) c.kick(beat);
        if (bi === 1) c.kick(beat + 0.5, { vel: 0.8 });
        if (bi === 2) c.kick(beat + 0.25 + 0.5, { vel: 0.7 });
      }
      if (sec.snare && bi % 2 === 1) c.snare(beat);
      if (sec.hats) for (const o of [0, 0.5 + 0.08]) c.hat(beat + o, { vel: o ? 0.45 : 0.65 });
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      c.renderBass(c.bassBus, c.at(bar * meter), c.P * 1.4, midi(chord - 24), { wave: "sine", cutoff: 250, gain: 0.3 });
      c.renderBass(c.bassBus, c.at(bar * meter + 2.75), c.P * 0.9, midi(chord - 24), { wave: "sine", cutoff: 250, gain: 0.26 });
    },
    sidechain: false,
  },
  {
    id: "pop-112",
    genre: "pop",
    bpm: 112,
    kick: "techno",
    kickOpt: { f0: 100, f1: 50, sweepMs: 25, lenMs: 220, drive: 2, click: 0.22, gain: 0.66 },
    sections: [
      { type: "intro", bars: 4, piano: 1 },
      { type: "verse", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 1, piano: 0.7 },
      { type: "chorus", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 1, piano: 0.9, pad: 0.7, crash: true },
      { type: "break", bars: 4, piano: 1, vocal: 0.8 },
      { type: "chorus", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 1, piano: 0.9, pad: 0.7, crash: true },
    ],
    groove: (c) => {
      const { sec, beat, bi, br } = c;
      if (sec.kick && (bi === 0 || bi === 2)) c.kick(beat);
      if (sec.kick && bi === 2 && br % 2) c.kick(beat + 0.5, { vel: 0.7 });
      if (sec.snare && bi % 2 === 1) c.snare(beat);
      if (sec.hats) for (const o of [0, 0.5]) c.hat(beat + o, { vel: o ? 0.4 : 0.6 });
      if (sec.crash && br === 0 && bi === 0) c.crash(beat);
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      for (let bi = 0; bi < meter; bi += 2) c.renderBass(c.bassBus, c.at(bar * meter + bi), c.P * 1.8, midi(chord - 24), { wave: "square", cutoff: 400, gain: 0.25 });
    },
    sidechain: false,
    prog: [60, 55, 57, 53],
  },
  {
    id: "rock-138",
    genre: "rock",
    bpm: 138,
    kick: "techno",
    kickOpt: { f0: 95, f1: 55, sweepMs: 20, lenMs: 170, drive: 1.6, click: 0.35, gain: 0.7 },
    snare: { tone: 200, gain: 0.55, decay: 0.17 },
    human: 9,
    drift: 0.015,
    velJitter: 0.2,
    sections: [
      { type: "intro", bars: 4, guitar: "ring" },
      { type: "verse", bars: 8, kick: true, snare: true, hats: 1, bass: true, guitar: "chug", vocal: 0.8 },
      { type: "chorus", bars: 8, kick: true, snare: true, ride: true, bass: true, guitar: "ring", vocal: 1, crash: true },
      { type: "verse", bars: 8, kick: true, snare: true, hats: 1, bass: true, guitar: "chug", vocal: 0.8 },
      { type: "chorus", bars: 8, kick: true, snare: true, ride: true, bass: true, guitar: "ring", vocal: 1, crash: true },
    ],
    groove: (c) => {
      const { sec, beat, bi, br } = c;
      if (sec.kick && (bi === 0 || bi === 2)) c.kick(beat);
      if (sec.kick && bi === 2 && br % 2) c.kick(beat + 0.5, { vel: 0.8 });
      if (sec.snare && bi % 2 === 1) c.snare(beat);
      if (sec.hats) for (const o of [0, 0.5]) c.hat(beat + o, { vel: o ? 0.5 : 0.7 });
      if (sec.ride) for (const o of [0, 0.5]) c.ride(beat + o, o ? 0.6 : 1);
      if (sec.crash && br === 0 && bi === 0) c.crash(beat);
      if (sec.kick && br === c.sec.bars - 1) fill(c);
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      for (let k = 0; k < meter * 2; k++) c.renderBass(c.bassBus, c.at(bar * meter + k / 2), c.P * 0.45, midi(chord - 24), { cutoff: 700, gain: 0.22 });
    },
    sidechain: false,
    prog: [52, 52, 55, 57],
  },
  {
    id: "metal-180",
    genre: "metal",
    bpm: 180,
    kick: "techno",
    kickOpt: { f0: 110, f1: 60, sweepMs: 12, lenMs: 90, drive: 2, click: 0.55, gain: 0.62 },
    snare: { tone: 220, gain: 0.6, decay: 0.15 },
    human: 5,
    sections: [
      { type: "intro", bars: 4, guitar: "ring", kick: true, snare: true, crash: true },
      { type: "verse", bars: 8, kick: "double", snare: true, guitar: "chug", bass: true },
      { type: "chorus", bars: 8, kick: true, snare: true, ride: true, guitar: "ring", bass: true, vocal: 0.8, crash: true },
      { type: "verse", bars: 8, kick: "double", snare: true, guitar: "chug", bass: true },
    ],
    groove: (c) => {
      const { sec, beat, bi, br } = c;
      if (sec.kick === "double") for (let k = 0; k < 4; k++) c.kick(beat + k / 4, { room: 0.25, vel: 0.8 });
      else if (sec.kick && (bi === 0 || bi === 2)) c.kick(beat);
      if (sec.snare && bi % 2 === 1) c.snare(beat);
      if (sec.ride) for (const o of [0, 0.5]) c.ride(beat + o);
      if (sec.crash && bi === 0 && br % 2 === 0) c.crash(beat);
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      for (let k = 0; k < meter * 2; k++) c.renderBass(c.bassBus, c.at(bar * meter + k / 2), c.P * 0.45, midi(chord - 24), { cutoff: 600, gain: 0.2 });
    },
    sidechain: false,
    prog: [52, 53, 52, 50],
  },
  {
    id: "reggaeton-95",
    genre: "reggaeton",
    bpm: 95,
    kick: "techno",
    kickOpt: { f0: 110, f1: 50, sweepMs: 25, lenMs: 220, drive: 2.5, click: 0.25, gain: 0.7 },
    snare: { tone: 230, gain: 0.45, decay: 0.12 },
    sections: [
      { type: "intro", bars: 4, pad: 0.8, vocal: 0.6 },
      { type: "verse", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 1 },
      { type: "chorus", bars: 8, kick: true, snare: true, hats: 1, bass: true, vocal: 1, pad: 0.8 },
    ],
    groove: (c) => {
      const { sec, beat } = c;
      // Dembow: boom . . ch  boom . ch .
      if (sec.kick) c.kick(beat);
      if (sec.snare) {
        const b = beat % 2;
        if (b === 0) c.snare(beat + 0.75, { gain: 0.35 });
        else c.snare(beat + 0.5, { gain: 0.35 });
      }
      if (sec.hats) c.hat(beat + 0.5, { vel: 0.4 });
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      for (let bi = 0; bi < meter; bi++) c.renderBass(c.bassBus, c.at(bar * meter + bi), c.P * 0.7, midi(chord - 24), { wave: "sine", cutoff: 300, gain: 0.28 });
    },
    sidechain: false,
  },
  {
    id: "reggae-76",
    genre: "reggae",
    bpm: 76,
    kick: "techno",
    kickOpt: { f0: 90, f1: 52, sweepMs: 25, lenMs: 250, drive: 1.4, click: 0.2, gain: 0.66 },
    human: 7,
    sections: [
      { type: "intro", bars: 2, lead: true },
      { type: "verse", bars: 12, kick: true, snare: true, hats: 1, bass: true, lead: true, vocal: 0.8 },
    ],
    groove: (c) => {
      const { sec, beat, bi } = c;
      // One drop: the kick and the rim on beat 3, nothing on 1.
      if (sec.kick && bi === 2) c.kick(beat);
      if (sec.snare && bi === 2) c.snare(beat, { gain: 0.35, tone: 320, decay: 0.06 });
      if (sec.hats) for (const o of [0, 0.5 + 0.1]) c.hat(beat + o, { vel: 0.45 });
    },
    leadLine: (c) => {
      // The skank: a short chord on every offbeat.
      const { bar, chord, meter } = c;
      for (let bi = 0; bi < meter; bi++) for (const iv of [0, 4, 7]) c.renderPiano(c.bus, c.at(bar * meter + bi + 0.5), midi(chord + 12 + iv), { gain: 0.12, len: 0.18 });
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      for (const o of [0, 1.5, 2.5, 3]) c.renderBass(c.bassBus, c.at(bar * meter + o), c.P * 0.8, midi(chord - 24), { wave: "sine", cutoff: 220, gain: 0.34 });
    },
    sidechain: false,
  },
  // === acoustic, calm, no drums ==============================================================
  {
    id: "jazz-swing-160",
    genre: "jazz",
    bpm: 160,
    human: 8,
    drift: 0.02,
    sections: [
      { type: "intro", bars: 4, piano: 0.8, ride: true },
      { type: "verse", bars: 16, ride: true, bass: true, piano: 0.8 },
      { type: "verse", bars: 8, ride: true, bass: true, piano: 1, snare: true },
    ],
    pianoStyle: "block",
    groove: (c) => {
      const { sec, beat, bi, r } = c;
      if (sec.ride) {
        c.ride(beat, 0.9);
        // Spang-a-lang: the swung skip note before beats 2 and 4.
        if (bi % 2 === 1) c.ride(beat + 2 / 3, 0.55);
        if (bi % 2 === 1) c.hat(beat, { vel: 0.5 });
      }
      if (sec.snare && r() < 0.25) c.snare(beat + (r() < 0.5 ? 2 / 3 : 0), { gain: 0.18 });
    },
    bassLine: (c) => {
      // Walking bass: a note on every beat.
      const { bar, chord, meter, r } = c;
      for (let bi = 0; bi < meter; bi++) c.renderBass(c.bassBus, c.at(bar * meter + bi), c.P * 0.9, midi(chord - 24 + [0, 2, 4, 5, 7][Math.floor(r() * 5)]), { wave: "sine", cutoff: 400, env: 1.5, gain: 0.3, drive: 1.1 });
    },
    sidechain: false,
    prog: [62, 55, 60, 57],
  },
  {
    id: "ragtime-piano-96",
    genre: "piano",
    bpm: 96,
    human: 6,
    drift: 0.01,
    sections: [{ type: "verse", bars: 20, piano: 1 }],
    pianoStyle: "ragtime",
    groove: () => {},
    sidechain: false,
    prog: [60, 60, 55, 60, 65, 65, 60, 55],
  },
  {
    id: "classical-rubato",
    genre: "classical",
    bpm: 72,
    rubato: 0.12,
    human: 20,
    sections: [{ type: "verse", bars: 12, piano: 1, pad: 0.4 }],
    pianoStyle: "rubato",
    groove: () => {},
    sidechain: false,
    noBeat: true,
  },
  {
    id: "ambient-pads",
    genre: "ambient",
    bpm: 60,
    sections: [{ type: "verse", bars: 10, pad: 1.4 }],
    groove: () => {},
    sidechain: false,
    noBeat: true,
    verb: 0.4,
  },
  {
    id: "waltz-3-4-160",
    genre: "pop",
    bpm: 160,
    meter: 3,
    human: 4,
    kick: "techno",
    kickOpt: { f0: 100, f1: 50, sweepMs: 25, lenMs: 200, drive: 2, click: 0.2, gain: 0.64 },
    sections: [
      { type: "intro", bars: 4, piano: 1 },
      { type: "verse", bars: 16, kick: true, snare: true, bass: true, piano: 0.8, vocal: 0.8 },
    ],
    groove: (c) => {
      const { sec, beat, bi } = c;
      if (sec.kick && bi === 0) c.kick(beat);
      if (sec.snare && bi > 0) c.hat(beat, { vel: 0.6, open: true });
    },
    bassLine: (c) => {
      const { bar, chord, meter } = c;
      c.renderBass(c.bassBus, c.at(bar * meter), c.P * 0.9, midi(chord - 24), { wave: "sine", cutoff: 300, gain: 0.3 });
    },
    pianoStyle: "block",
    sidechain: false,
  },
];

export const SONG_BY_ID = new Map(SONGS.map((s) => [s.id, s]));

// Kicks the catalogue needs that the synth does not define.
Object.assign(KICKS, {
  house: KICKS.house || { f0: 120, f1: 50, sweepMs: 30, lenMs: 230, drive: 2.2, click: 0.16, gain: 0.66 },
  rawstyle: KICKS.rawstyle || { f0: 210, f1: 52, sweepMs: 50, lenMs: 380, drive: 20, click: 0.45, gain: 0.8, saw: 0.35, sawDrive: 14 },
  krach: KICKS.krach || { f0: 240, f1: 48, sweepMs: 40, lenMs: 320, drive: 34, click: 0.7, gain: 0.85, saw: 0.8, sawDrive: 22 },
});

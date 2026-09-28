// How a track is BUILT, summarised for the genre head.
//
// The frozen extractor hears timbre well and tempo poorly, and it was trained
// on Discogs' styles — which have no Pieep and no Deutscher Krach. What tells
// those apart is what the live analyser already reads, kick by kick: where the
// kick's pitch starts, the piep on its attack, how long it rings, the rolls,
// the saw buzz, whether every beat carries a kick (rhythm/src/style.rs
// F_KF0..F_FOUR and the kick-shape weights). A ConstructionMeter averages those
// over the part of a track where the groove is IN, and the summary travels to
// the server (`POST /api/analysis/<id>/live`), where the head reads it next to
// the embedding and the served tempo (supysonic/deezer/construction.py).
//
// Two feeders, one meter: the player's engine while a track plays with the
// analysis at the "smart" level (it costs thirteen additions a frame), and the
// studio's own measuring pass over tagged tracks nobody has played that way.

import { RULE_FEATURES } from "../audio/style.js";

/** The descriptors summarised, in the order the head reads them. */
export const CONSTRUCTION = [
  "kickF0", "piep", "tail", "lead", "buzz", "screech", "offbeat", "density", "roll", "four",
  "kSoft", "kHard", "kIndus",
];

// Where each sits in the analyser's `styleFeat` block.
const SLOT = CONSTRUCTION.map((k) => RULE_FEATURES.indexOf(k));

/** A summary needs this much groove (~20 s at 94 frames a second). */
export const MIN_FRAMES = 1900;
// Loud enough to be the drop or a verse, not a breakdown or an intro, whose
// descriptors say what a quiet passage sounds like rather than the genre.
const DYN_MIN = 0.6;

export class ConstructionMeter {
  constructor() {
    this.sums = new Float64Array(CONSTRUCTION.length);
    this.n = 0;
  }

  reset() {
    this.sums.fill(0);
    this.n = 0;
  }

  /**
   * One analysis frame, as the analyser laid it out: `buf` the frame, `I` the
   * field offsets by name (rhythm_layout). Only frames with the grid locked,
   * the level up and the style classifier running (styleFeat present) count.
   */
  add(buf, I) {
    if (I.styleFeat == null || I.locked == null || I.dynamics == null) return;
    if (!(buf[I.locked] > 0) || buf[I.dynamics] < DYN_MIN) return;
    const o = I.styleFeat;
    for (let i = 0; i < SLOT.length; i++) {
      const v = buf[o + SLOT[i]];
      if (!Number.isFinite(v)) return;
    }
    for (let i = 0; i < SLOT.length; i++) this.sums[i] += buf[o + SLOT[i]];
    this.n++;
  }

  /** `{ n, features: {name: mean} }`, or null below MIN_FRAMES. */
  summary() {
    if (this.n < MIN_FRAMES) return null;
    const features = {};
    for (let i = 0; i < CONSTRUCTION.length; i++) features[CONSTRUCTION[i]] = +(this.sums[i] / this.n).toFixed(5);
    return { n: this.n, features };
  }
}

// --- as the head's inputs -------------------------------------------------------
//
// What goes into the head next to the embedding: the served tempo (as log2 of
// bpm/120, so an octave is one unit) and the construction descriptors, each
// standardised over the training set, clipped to ±4, scaled to sit beside the
// embedding's own components, plus ONE flag for "no construction summary" (a
// missing summary is centred to zero, and the flag lets the head tell zero from
// absent). The server reproduces this exactly from `metrics.inputs`
// (supysonic/deezer/genre.py#assemble).

export const EXTRAS = ["tempo", ...CONSTRUCTION];

/**
 * The raw extras for one track, from the embeddings endpoint's `extras` entry
 * (`{bpm, live}`): an array of EXTRAS.length numbers, NaN where absent.
 */
export function rawExtras(entry) {
  const out = new Float64Array(EXTRAS.length).fill(NaN);
  const bpm = +entry?.bpm;
  if (bpm > 20 && bpm < 400) out[0] = Math.log2(bpm / 120);
  const live = entry?.live;
  if (live && typeof live === "object")
    for (let i = 0; i < CONSTRUCTION.length; i++) {
      const v = +live[CONSTRUCTION[i]];
      if (Number.isFinite(v)) out[i + 1] = v;
    }
  return out;
}

/**
 * Standardisation over a training set: `rows` are rawExtras arrays. Returns
 * `{ mean, std }` (a feature nobody has gets mean 0, std 1).
 */
export function fitScaler(rows) {
  const k = EXTRAS.length;
  const mean = new Array(k).fill(0);
  const std = new Array(k).fill(1);
  for (let j = 0; j < k; j++) {
    let n = 0;
    let s = 0;
    for (const r of rows) if (Number.isFinite(r[j])) (s += r[j]), n++;
    if (!n) continue;
    const m = s / n;
    let v = 0;
    for (const r of rows) if (Number.isFinite(r[j])) v += (r[j] - m) ** 2;
    mean[j] = +m.toFixed(6);
    std[j] = +Math.max(1e-3, Math.sqrt(v / n)).toFixed(6);
  }
  return { mean, std };
}

/**
 * The extras block for one track: EXTRAS.length standardised values then the
 * missing-summary flag, all multiplied by `scale`.
 */
export function extrasBlock(raw, scaler, scale) {
  const k = EXTRAS.length;
  const out = new Float32Array(k + 1);
  let liveMissing = true;
  for (let j = 0; j < k; j++) {
    const v = raw[j];
    if (!Number.isFinite(v)) continue;
    if (j > 0) liveMissing = false;
    const z = Math.max(-4, Math.min(4, (v - scaler.mean[j]) / scaler.std[j]));
    out[j] = z * scale;
  }
  out[k] = liveMissing ? scale : 0;
  return out;
}

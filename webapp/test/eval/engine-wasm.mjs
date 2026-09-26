// The Rust analyser, driven exactly as the AudioWorklet drives it: mono PCM in,
// frames out, the served verdict applied when it would land.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Rhythm } from "../../src/lib/audio/rhythm-core.js";
import { familyTable, tempoRangeFor } from "../../src/lib/audio/style.js";

const here = dirname(fileURLToPath(import.meta.url));
// A fresh cargo build wins over the committed binary, so the eval always
// measures the source being edited.
const BUILT = join(here, "../../rhythm/target/wasm32-unknown-unknown/release/rhythm.wasm");
const SHIPPED = join(here, "../../src/lib/audio/rhythm.wasm");
let bytes = null;
export function wasmBytes() {
  if (!bytes) bytes = readFileSync(process.env.RHYTHM_WASM || (existsSync(BUILT) ? BUILT : SHIPPED));
  return bytes;
}

export default {
  name: "wasm",
  async run(pcm, sr, { seed = 0, seedAt = 4, genre = "", chunk = 4096, onFrame = null } = {}) {
    const r = await Rhythm.fromBytes(wasmBytes(), sr);
    r.loadFamilies(familyTable());
    r.setLevel(2);
    const F = r.layout.fields;
    const at = (name) => F[name][0];
    const I = {
      frame: at("frame"), beat: at("beat"), downbeat: at("downbeat"), locked: at("locked"), bpm: at("bpm"),
      conf: at("confidence"), kickHit: at("kickHit"), main: at("mainKick"), drop: at("drop"),
      breakdown: at("breakdown"), build: at("build"),
    };
    const hopS = r.hop / sr;
    const rec = { beats: [], downbeats: [], kicks: [], mains: [], drops: [], bpm: [], breakdown: [], build: [], dt: hopS };
    let applied = false;
    let locked = 0;
    let conf = 0;
    let frames = 0;
    for (let i = 0; i < pcm.length; i += chunk) {
      const t0 = i / sr;
      if (!applied && (seed || genre) && t0 >= (seed ? seedAt : 0)) {
        applied = true;
        const range = genre ? tempoRangeFor(genre) : null;
        if (range) r.setRange(range[0], range[1]);
        r.setLiveRange(!genre);
        if (seed) r.seed(seed, genre ? 0.9 : 0.7);
      }
      const n = r.push(pcm.subarray(i, Math.min(pcm.length, i + chunk)));
      for (let k = 0; k < n; k++) {
        const fr = r.frame(k);
        const t = fr[I.frame] * hopS;
        if (fr[I.beat]) {
          rec.beats.push(t);
          if (fr[I.downbeat]) rec.downbeats.push(t);
        }
        if (fr[I.kickHit]) rec.kicks.push(t);
        if (fr[I.main]) rec.mains.push(t);
        if (fr[I.drop]) rec.drops.push(t);
        if (fr[I.locked]) rec.bpm.push([t, fr[I.bpm]]);
        rec.breakdown.push(fr[I.breakdown]);
        rec.build.push(fr[I.build]);
        locked += fr[I.locked] ? 1 : 0;
        conf += fr[I.locked] ? fr[I.conf] : 0;
        frames++;
        if (onFrame) onFrame(t, fr, F);
      }
    }
    rec.lockedShare = locked / Math.max(1, frames);
    rec.confMean = conf / Math.max(1, frames);
    return rec;
  },
};

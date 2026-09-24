// The JavaScript analysis chain as lib/audio/engine.js ran it before the Rust
// analyser replaced it: 2048-point spectra -> features.js -> tempo.js ->
// pattern.js, with style.js feeding the tempo range the way the engine did.
// Kept only as the baseline the eval compares against.

import { analyse, DT } from "../synth.mjs";
import { buildEnergyPlan, readEnergy, ENERGY_BANDS } from "../../src/lib/audio/spectrum.js";
import { createFeatureExtractor } from "../../src/lib/audio/features.js";
import { createBeatTracker } from "../../src/lib/audio/tempo.js";
import { createPattern } from "../../src/lib/audio/pattern.js";
import { createStyleClassifier, tempoRangeFor } from "../../src/lib/audio/style.js";

export default {
  name: "js",
  async run(pcm, sr, { seed = 0, seedAt = 4, genre = "" } = {}) {
    const spectra = analyse(pcm);
    const fx = createFeatureExtractor({ sampleRate: sr, fftHi: 2048, floorDb: -96 });
    const tr = createBeatTracker();
    const pat = createPattern();
    const cls = createStyleClassifier();
    const plan = buildEnergyPlan({ sampleRate: sr, fftLo: 2048, fftHi: 2048 });
    const eDb = new Float32Array(ENERGY_BANDS.length);
    const energy = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
    const rec = { beats: [], downbeats: [], kicks: [], mains: [], drops: [], bpm: [], breakdown: [], build: [], dt: DT };
    let verdict = null;
    let rangeFrom = "";
    const applyRange = (name) => {
      if (!name || name === rangeFrom) return;
      const r = tempoRangeFor(name);
      if (!r) return;
      rangeFrom = name;
      tr.setTempoRange(r[0], r[1]);
    };
    let locked = 0;
    let conf = 0;
    const shim = { features: null, beat: null };
    for (let i = 0; i < spectra.length; i++) {
      const t = spectra.at(i);
      if (!verdict && (seed || genre) && t >= (seed ? seedAt : 0)) {
        verdict = { bpm: seed, style: genre };
        applyRange(genre);
        if (seed) tr.seed(seed, 0.9);
      }
      readEnergy(plan, spectra[i], spectra[i], eDb, -96);
      for (let k = 0; k < ENERGY_BANDS.length; k++) energy[ENERGY_BANDS[k][0]] = Math.pow(10, eDb[k] / 10);
      const f = fx.process(spectra[i], DT);
      const b = tr.process(f.flux, f.lowFlux, DT);
      shim.features = f;
      shim.beat = b;
      const p = pat.update(shim, DT);
      const live = cls.process(f, b, energy, t, DT);
      if (!verdict && live && live.confidence > 0.5) applyRange(live.dominant);
      if (b.beat && b.locked) {
        rec.beats.push(t);
        if (b.downbeat) rec.downbeats.push(t);
      }
      if (f.kickHit) rec.kicks.push(t);
      if (p.mainKick) rec.mains.push(t);
      if (p.drop) rec.drops.push(t);
      if (b.locked) rec.bpm.push([t, b.bpm]);
      rec.breakdown.push(p.breakdown);
      rec.build.push(p.build);
      locked += b.locked ? 1 : 0;
      conf += b.locked ? b.confidence : 0;
    }
    rec.lockedShare = locked / spectra.length;
    rec.confMean = conf / spectra.length;
    return rec;
  },
};

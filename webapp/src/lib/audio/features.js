// Per-frame descriptors of what the music is doing right now.
//
// Everything here is derived from the two analysers in graph.js and is cheap
// enough to run on every analysis tick (~90 Hz) on a phone: a few passes over
// the 1024-bin fast spectrum, no allocation after construction.
//
// The descriptors are the ones that actually separate musical situations, and
// each is here because something downstream needs it:
//
//   level / peak / crest  how loud, and how peaky — a limitered hardcore master
//                         and a live string quartet differ enormously here.
//   flux                  positive spectral change: the onset detection
//                         function the beat tracker runs on.
//   lowFlux               the same, restricted to sub+bass, which is what a
//                         kick actually is.
//   centroid              brightness. Separates a cello from a hi-hat pattern.
//   flatness              tonal (low) vs noisy/distorted (high). This is the
//                         single most useful axis for telling a string section
//                         from a distorted guitar wall or an industrial kick.
//   rolloff               where the top of the spectrum sits.
//   percussivity          flux relative to level: sustained bowing barely moves
//                         it, a drum pattern pins it.
//   vocalMod              syllabic-rate (3-9 Hz) modulation of the mid band —
//                         a decent, cheap proxy for "someone is singing".
//
// Adaptive whitening (Stowell & Plumbley) is applied before the flux sums: each
// bin is divided by its own slowly-decaying running maximum, so a quiet intro
// and a loud drop produce onsets of comparable size and the beat tracker does
// not need its threshold re-tuned every thirty seconds.

const LN10_20 = Math.LN10 / 20;
const dbToMag = (db) => Math.exp(db * LN10_20);

export function createFeatureExtractor({ sampleRate, fftHi, floorDb = -100 }) {
  const nHi = fftHi / 2;
  const nyquist = sampleRate / 2;
  const hzPerBin = nyquist / nHi;

  const mag = new Float32Array(nHi);
  const white = new Float32Array(nHi);
  const prev = new Float32Array(nHi);
  const peakEnv = new Float32Array(nHi).fill(1e-4); // whitening running max

  // Bin ranges used by the sums below.
  const b = (hz) => Math.max(0, Math.min(nHi - 1, Math.round(hz / hzPerBin)));
  const LOW0 = b(25);
  const LOW1 = b(180); // kick territory
  const MIDF0 = b(180);
  const MIDF1 = b(2000); // snares, claps, guitars, most of a voice
  const HIF0 = b(2000); // hats, cymbals, "pieep" leads, sibilance
  const MID0 = b(250);
  const MID1 = b(3500); // where voices and lead instruments live
  const TOP = b(16000);

  // Envelope followers for the modulation ("is someone singing?") estimate.
  let midFast = 0;
  let midSlow = 0;
  let modAvg = 0;
  // Smoothed outputs. Most consumers want a stable reading, not a raw frame.
  let sLevel = 0;
  let sCentroid = 0;
  let sFlatness = 0;
  let sPerc = 0;
  let sRolloff = 0;

  const out = {
    level: 0, // 0..1, perceptual-ish
    levelDb: floorDb,
    peak: 0,
    crest: 0,
    flux: 0,
    lowFlux: 0,
    midFlux: 0,
    highFlux: 0,
    centroid: 0, // Hz
    centroidN: 0, // 0..1, log-mapped over 40 Hz..16 kHz
    flatness: 0, // 0..1
    rolloff: 0, // Hz
    rolloffN: 0,
    percussivity: 0,
    vocalMod: 0,
    silent: true,
  };

  const CENT_LO = Math.log(40);
  const CENT_SPAN = Math.log(16000) - CENT_LO;

  function process(hiData, dt) {
    // dB → linear magnitude, once, for the whole usable spectrum.
    let sum = 0;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i <= TOP; i++) {
      const db = hiData[i] > floorDb ? hiData[i] : floorDb;
      const m = dbToMag(db);
      mag[i] = m;
      sum += m;
      sumSq += m * m;
      if (m > peak) peak = m;
    }
    const n = TOP + 1;
    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);
    out.peak = peak;
    out.crest = rms > 1e-6 ? peak / rms : 0;

    // Level: RMS of the spectrum, in dB, mapped to 0..1 over a 70 dB window.
    // The window is what makes the reading usable as a visual amplitude —
    // absolute dBFS spends most of its range on silence nobody can hear.
    const rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : floorDb;
    out.levelDb = rmsDb;
    const lvl = Math.max(0, Math.min(1, (rmsDb + 78) / 70));
    sLevel = lvl > sLevel ? lvl * 0.5 + sLevel * 0.5 : lvl * 0.12 + sLevel * 0.88;
    out.level = sLevel;
    out.silent = rmsDb < floorDb + 12;

    // Adaptive whitening + spectral flux. The running max decays slowly, so a
    // section that gets quieter recovers its onset sensitivity within a second
    // or two instead of going numb for the rest of the track.
    const decay = Math.pow(0.9994, Math.max(1, dt * 1000) / 10);
    let flux = 0;
    let lowFlux = 0;
    let midFlux = 0;
    let highFlux = 0;
    for (let i = 0; i <= TOP; i++) {
      const m = mag[i];
      let p = peakEnv[i] * decay;
      if (m > p) p = m;
      if (p < 1e-5) p = 1e-5;
      peakEnv[i] = p;
      const w = m / p;
      white[i] = w;
      const d = w - prev[i];
      if (d > 0) {
        flux += d;
        if (i >= LOW0 && i <= LOW1) lowFlux += d;
        else if (i >= MIDF0 && i < MIDF1) midFlux += d;
        else if (i >= HIF0) highFlux += d;
      }
      prev[i] = w;
    }
    out.flux = flux / n;
    out.lowFlux = lowFlux / Math.max(1, LOW1 - LOW0 + 1);
    out.midFlux = midFlux / Math.max(1, MIDF1 - MIDF0);
    out.highFlux = highFlux / Math.max(1, TOP - HIF0 + 1);

    // Centroid and spread over the whole usable spectrum.
    let wsum = 0;
    let msum = 0;
    for (let i = 1; i <= TOP; i++) {
      wsum += mag[i] * i;
      msum += mag[i];
    }
    const centroidBin = msum > 1e-6 ? wsum / msum : 0;
    const centroid = centroidBin * hzPerBin;
    sCentroid = centroid * 0.1 + sCentroid * 0.9;
    out.centroid = sCentroid;
    out.centroidN = Math.max(
      0,
      Math.min(1, (Math.log(Math.max(40, sCentroid)) - CENT_LO) / CENT_SPAN)
    );

    // Flatness = geometric mean / arithmetic mean, over the band where "tonal
    // vs noisy" is actually informative. Summing logs rather than multiplying
    // keeps it from underflowing to zero across a thousand bins.
    let logSum = 0;
    let arith = 0;
    let cnt = 0;
    for (let i = MID0; i <= MID1; i++) {
      const m = mag[i] > 1e-7 ? mag[i] : 1e-7;
      logSum += Math.log(m);
      arith += m;
      cnt++;
    }
    const geo = cnt ? Math.exp(logSum / cnt) : 0;
    const ari = cnt ? arith / cnt : 0;
    const flat = ari > 1e-7 ? Math.max(0, Math.min(1, geo / ari)) : 0;
    sFlatness = flat * 0.06 + sFlatness * 0.94;
    out.flatness = sFlatness;

    // 85% spectral rolloff.
    const target = msum * 0.85;
    let acc = 0;
    let rb = TOP;
    for (let i = 1; i <= TOP; i++) {
      acc += mag[i];
      if (acc >= target) {
        rb = i;
        break;
      }
    }
    const rolloff = rb * hzPerBin;
    sRolloff = rolloff * 0.08 + sRolloff * 0.92;
    out.rolloff = sRolloff;
    out.rolloffN = Math.max(
      0,
      Math.min(1, (Math.log(Math.max(40, sRolloff)) - CENT_LO) / CENT_SPAN)
    );

    // Percussivity: how much of the signal is change rather than sustain.
    const perc = Math.max(0, Math.min(1, out.flux / (0.02 + out.level * 0.08)));
    sPerc = perc > sPerc ? perc * 0.35 + sPerc * 0.65 : perc * 0.06 + sPerc * 0.94;
    out.percussivity = sPerc;

    // Syllabic modulation of the mid band. Two envelope followers on the same
    // energy — one tracking ~8 Hz, one ~1 Hz — and the normalized distance
    // between them is how strongly that band pulses at speech/singing rate.
    let midE = 0;
    for (let i = MID0; i <= MID1; i++) midE += mag[i];
    midE /= Math.max(1, MID1 - MID0 + 1);
    const aFast = 1 - Math.exp(-dt / 0.045);
    const aSlow = 1 - Math.exp(-dt / 0.9);
    midFast += (midE - midFast) * aFast;
    midSlow += (midE - midSlow) * aSlow;
    const modRaw = midSlow > 1e-6 ? Math.abs(midFast - midSlow) / midSlow : 0;
    modAvg += (Math.min(1.5, modRaw) - modAvg) * (1 - Math.exp(-dt / 1.6));
    // Real singing modulates, but so does a hi-hat: require some tonality
    // before calling it a voice.
    out.vocalMod = Math.max(0, Math.min(1, modAvg * 1.6 * (1 - out.flatness * 1.4)));

    return out;
  }

  function reset() {
    prev.fill(0);
    peakEnv.fill(1e-4);
    midFast = midSlow = modAvg = 0;
    sLevel = sCentroid = sFlatness = sPerc = sRolloff = 0;
  }

  return { process, reset, out };
}

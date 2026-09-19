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
//                         kick actually is. Body plus, when a body is present,
//                         the beater's click — see below.
//   kick                  lowFlux normalised against its own recent peak, so it
//                         reads the same on a quiet master as on a loud one.
//                         This is what the scenes draw.
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

// Mean magnitude over a bin range — one pass, no allocation, same as the band
// sums above but usable from anywhere in the frame.
function bandMean(mag, lo, hi) {
  let s = 0;
  for (let i = lo; i <= hi; i++) s += mag[i];
  return s / Math.max(1, hi - lo + 1);
}

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
  const LOW1 = b(180); // kick territory: an 808's sub through a hardstyle punch
  const CLICK0 = b(1500); // the beater's click on a sampled kick
  const CLICK1 = b(7000);
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
  // Kick detection, in the MAGNITUDE domain. See the "kick" note above.
  let kickFast = 0; // the kick band, fast attack
  let kickSlow = 0; // ...and what it has been doing lately
  let clickFast = 0; // the click band, fast attack
  let clickSlow = 0;
  let kickRef = 0; // running strength of a "typical" kick, for normalisation
  let kickPrimed = false; // envelopes anchored on the first frame, not on zero
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
    kick: 0, // 0..1, how hard the kick is hitting right now
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

    // --- the kick, in the magnitude domain -----------------------------------
    //
    // Whitened flux is the right signal for the BEAT TRACKER — it is a
    // difference between two frames, and the beat is where the differences are
    // — but it makes a poor KICK DETECTOR for three concrete reasons:
    //
    //  - it is a first-order difference, and the analyser window (2048 samples,
    //    ~42 ms) spreads a kick's attack over several frames. A 50 Hz kick does
    //    not even complete three cycles in that window, so what should be one
    //    onset arrives as a gentle rise over two or three frames, and the flux
    //    per frame is a fraction of the band's level.
    //  - the whitening denominator is a running max with a half-life measured in
    //    tens of seconds. After the loudest passage of a track, every bin in the
    //    kick band is compressed toward that old maximum, and a later kick that
    //    is still perfectly audible moves the ratio by very little.
    //  - being a difference, its scale is arbitrary: a scene reading it has to
    //    pick a magic multiplier and hopes it holds across a library whose
    //    masters differ by 12 dB.
    //
    // So the kick is read from the raw magnitudes instead, as the ratio between
    // a FAST and a SLOW envelope of the kick band. A sustained note — the 808
    // under a rap track, the bassline under a techno one — drives both envelopes
    // to the same place whatever its level, so the ratio sits at 1 and nothing
    // fires. A kick on top of it lifts the fast envelope and leaves the slow one
    // behind, and that transient is the hit. The reading is a dimensionless
    // ratio, so it means the same thing on a loud master and a quiet one, which
    // is what makes it usable across a whole library.
    const kickLo = Math.max(1e-9, bandMean(mag, LOW0, LOW1));
    const clickLo = Math.max(1e-9, bandMean(mag, CLICK0, CLICK1));
    // ~3 ms attack (the fastest a kick's leading edge moves), ~90 ms release —
    // faster than any sustained bass note can be, slower than the noise between
    // samples of one. `dt` is clamped because a stalled tab hands us a giant
    // step, and an envelope that jumps to the new level on one frame measures
    // nothing.
    const dtc = Math.min(Math.max(dt, 1 / 400), 0.02);
    const kAtk = 1 - Math.exp(-dtc / 0.003);
    const kRel = 1 - Math.exp(-dtc / 0.09);
    if (!kickPrimed) {
      // Start the envelopes AT the level of the first frame. Starting them at
      // zero would make the very first frame of any track a rise from nothing,
      // which is a kick that never happened — and a scene told to flash on it
      // flashes once per track for no reason.
      kickPrimed = true;
      kickFast = kickSlow = kickLo;
      clickFast = clickSlow = clickLo;
    }
    kickFast += (kickLo - kickFast) * kAtk;
    kickSlow += (kickLo - kickSlow) * kRel;
    clickFast += (clickLo - clickFast) * kAtk;
    clickSlow += (clickLo - clickSlow) * kRel;

    // Body and click are not rivals: a rap kick is pure body, a hardstyle kick
    // is a click wired to a punch. Either can carry a hit, so the detector
    // takes the stronger of the two and the beat tracker gets both.
    const bodyRise = kickSlow > 1e-9 ? kickFast / kickSlow - 1 : 0;
    const clickRise = clickSlow > 1e-9 ? clickFast / clickSlow - 1 : 0;
    const rise = Math.max(bodyRise, clickRise * 0.6);
    const lowKick = Math.max(bodyRise, 0);
    // How large the rise is compared to the rises this track usually produces.
    // A ratio is scale-free, so a quiet kick on a quiet master has to move as
    // far to fire as a loud one — which is exactly what makes this usable
    // across a library instead of only on the loudest records.
    kickRef = Math.max(rise, kickRef * 0.995);
    const norm = kickRef > 0.02 ? rise / kickRef : 0;
    const kickNow = Math.max(0, Math.min(1, norm * 1.35));
    // Fast attack, slow release: an onset is one frame, and a scene that reads
    // this on a single frame flickers. Held long enough to be a visible pulse.
    out.kick = kickNow > out.kick ? kickNow : out.kick * Math.max(0, 1 - dtc / 0.16);
    // The beat tracker wants the same evidence in the shape it already consumes:
    // a signal whose peaks sit where the kicks are, pre-whitened, so nothing
    // downstream has to change. It straddles the whitening boundary on purpose —
    // raw for the bass, whitened for the click — which is the split that makes
    // it work on both techno and rap: each half carries the half of the kick the
    // other one's normalisation has trouble with.
    out.lowFlux = lowFlux / Math.max(1, LOW1 - LOW0 + 1) + 0.09 * lowKick;

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
    kickFast = kickSlow = clickFast = clickSlow = kickRef = 0;
    kickPrimed = false;
    out.kick = 0;
    sLevel = sCentroid = sFlatness = sPerc = sRolloff = 0;
  }

  return { process, reset, out };
}

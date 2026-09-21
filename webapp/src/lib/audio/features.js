// Per-frame descriptors of what the music is doing right now.
//
// Everything here is derived from the two analysers in graph.js and is cheap
// enough to run on every analysis tick (~90 Hz) on a phone: a few passes over
// the 1024-bin fast spectrum, no allocation after construction.
//
// THREE IDEAS GOVERN THIS FILE, and each replaced something that was wrong.
//
// 1. THE ONSET FUNCTION IS SUPERFLUX, IN THE LOG DOMAIN.
//    Plain spectral flux fires on vibrato, on a tremolo pad, on any sustained
//    note whose partials wobble — the frame-to-frame difference is positive
//    every time a partial drifts into the next bin, and there are hundreds of
//    partials. Böck & Widmer's fix (DAFx-13) is to compare against a version of
//    the earlier frame that has been MAXIMUM-FILTERED across frequency: a
//    partial that merely moved is covered by its own neighbour's maximum and
//    contributes nothing, while a genuine attack — energy appearing where there
//    was none — still stands out. It removes most false positives on melodic
//    material at no cost worth measuring.
//
//    The comparison is against the frame ~20 ms back, not the previous one: the
//    analyser window is 2048 samples (~46 ms), so consecutive frames overlap
//    almost entirely and their difference is mostly window smear. The history
//    is indexed by TIME rather than by frame count, because this engine's clock
//    is not guaranteed regular.
//
// 2. LEVEL IS INFORMATION, AND THE OLD CODE THREW IT AWAY.
//    Adaptive whitening divides every bin by its own running maximum, which
//    makes a whisper and a wall of sound produce the same numbers — by design.
//    That is right for a beat tracker, which only cares WHERE the peaks are,
//    and completely wrong for an animation, which is asked to be calm when the
//    music is calm. A breakdown drove the old normalisers down within a second
//    or two and then every small movement read as a full-strength hit, which is
//    exactly the "quiet passages look frantic" complaint.
//
//    So there are two readings now. The tracker gets the raw onset function.
//    Everything a scene draws is multiplied by `dynamics`: how loud this moment
//    is against the loudest the track has recently been. A breakdown sits near
//    zero and the animation settles, on its own, with no scene knowing why.
//
// 3. THERE IS A MELODY IN THERE TOO.
//    Splitting the spectrum into what PERSISTS (a held note, a pad, a voice)
//    and what APPEARS (a drum) costs one exponential average per bin, and the
//    persistent half is what the chroma, the tonal clarity and the harmonic
//    change below are measured on. Without it every scene could only ever
//    follow the drums.
//
// The descriptors, and who needs them:
//
//   level / peak / crest  how loud, and how peaky — a limitered hardcore master
//                         and a live string quartet differ enormously here.
//   dynamics              this moment against the track's own loud reference.
//                         THE gate: everything visual is scaled by it.
//   flux                  the SuperFlux onset function. What the beat tracker
//                         runs on, ungated.
//   lowFlux               the same, restricted to sub+bass, which is what a
//                         kick actually is.
//   kick                  how hard the kick is hitting right now, 0..1, gated.
//                         This is what the scenes draw.
//   centroid              brightness. Separates a cello from a hi-hat pattern.
//   flatness              tonal (low) vs noisy/distorted (high). The single
//                         most useful axis for telling a string section from a
//                         distorted guitar wall or an industrial kick.
//   rolloff               where the top of the spectrum sits.
//   percussivity          flux relative to level: sustained bowing barely moves
//                         it, a drum pattern pins it.
//   vocalMod              syllabic-rate (3-9 Hz) modulation of the mid band —
//                         a decent, cheap proxy for "someone is singing".
//   chroma / tonal /      the melodic channel: which pitch classes are
//   melody / chord        sounding, how clearly, how high, and how fast the
//                         harmony is moving.

const LN10_20 = Math.LN10 / 20;
const dbToMag = (db) => Math.exp(db * LN10_20);

// Compression for the onset function. SuperFlux takes log10(1 + C·x); C sets
// where the curve bends. Bin magnitudes here run from about 1e-4 to 1e-1, and
// 1000 puts the useful part of that range across a decade of output instead of
// squashing it against zero.
const LOG_C = 1000;
// How far back the onset function compares. The analyser window is ~46 ms, so
// consecutive frames overlap almost completely and their difference is window
// smear rather than music.
const ODF_LAG = 0.022;
const HIST = 8; // frames of log-spectrum kept for that lookback
// How far below the track's own loud reference counts as silence, visually.
// Eighteen decibels is about the range between a breakdown and its drop.
const DYN_RANGE_DB = 18;
// The shortest gap between two kicks we will believe. 300 BPM sixteenths are
// 50 ms apart, so this refuses nothing musical and refuses every ring-out.
const KICK_REFRACTORY = 0.055;

const PITCH_CLASSES = 12;

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
  const logMag = new Float32Array(nHi);
  // Ring of recent log-spectra, with the time each was taken, for the lag.
  const hist = [];
  for (let i = 0; i < HIST; i++) hist.push({ t: -1, buf: new Float32Array(nHi) });
  let histHead = 0;
  let clock = 0;

  // The sustained part of the spectrum: an exponential average per bin. A held
  // note keeps its bins near their own average; a drum spikes far above it.
  const tonal = new Float32Array(nHi);
  const harm = new Float32Array(nHi); // the sustained half of this frame
  const cumul = new Float32Array(nHi + 1); // prefix sums of `harm`, for the envelope
  const chroma = new Float32Array(PITCH_CLASSES);
  const chromaSmooth = new Float32Array(PITCH_CLASSES);
  const chromaRef = new Float32Array(PITCH_CLASSES); // half a second ago
  let chromaRefAt = 0;

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
  // The melodic window. Below 60 Hz there is no melody, only the bass drum;
  // above 4 kHz there are only harmonics of things already counted.
  const MEL0 = Math.max(1, b(60));
  const MEL1 = b(4000);

  // bin → pitch class, precomputed once. -1 for bins outside the melodic band.
  const pitchOf = new Int8Array(nHi).fill(-1);
  // ...and how many bins landed on each class. An FFT is linear in frequency
  // and pitch is logarithmic, so one semitone at 3 kHz covers twenty times the
  // bins it covers at 150 Hz. Without dividing by this, a flat spectrum — noise,
  // a cymbal, a distorted wall — comes out with a strongly peaked chroma and
  // reads as a clear melody, which is precisely backwards.
  const classBins = new Float32Array(PITCH_CLASSES);
  for (let i = MEL0; i <= MEL1; i++) {
    const hz = i * hzPerBin;
    if (hz < 20) continue;
    // 69 = A4 = 440 Hz, the MIDI convention; the pitch class is that mod 12.
    const midi = 69 + 12 * Math.log2(hz / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    pitchOf[i] = pc;
    classBins[pc] += 1;
  }
  for (let k = 0; k < PITCH_CLASSES; k++) if (classBins[k] < 1) classBins[k] = 1;

  let midFast = 0;
  let midSlow = 0;
  let modAvg = 0;
  let kickFast = 0;
  let kickSlow = 0;
  let clickFast = 0;
  let clickSlow = 0;
  let kickRef = 0;
  let kickPrimed = false;
  let lastKickAt = -1;
  let sLevel = 0;
  let sCentroid = 0;
  let sFlatness = 0;
  let sPerc = 0;
  let sRolloff = 0;
  let loudRef = floorDb; // the loudest this track has recently been, in dB
  let sDynamics = 0;
  let sTonal = 0;
  let sMelody = 0;
  let sChord = 0;
  let melPitch = 0;

  const out = {
    level: 0, // 0..1, perceptual-ish
    levelDb: floorDb,
    peak: 0,
    crest: 0,
    // 0..1: this moment against the track's own recent loud reference. The gate
    // every visual reading is scaled by, and the reason a breakdown is calm.
    dynamics: 0,
    loudRefDb: floorDb,
    flux: 0, // SuperFlux ODF, ungated — the beat tracker's input
    lowFlux: 0,
    midFlux: 0, // gated: scenes draw these
    highFlux: 0,
    kick: 0, // 0..1, how hard the kick is hitting right now (gated)
    kickHit: false, // true only on the frame a kick is accepted
    centroid: 0, // Hz
    centroidN: 0, // 0..1, log-mapped over 40 Hz..16 kHz
    flatness: 0, // 0..1
    rolloff: 0, // Hz
    rolloffN: 0,
    percussivity: 0,
    vocalMod: 0,
    // -- the melodic channel --------------------------------------------
    chroma, // 12 pitch classes, 0..1, normalised to the strongest
    tonal: 0, // 0..1, how much of the sound is sustained rather than struck
    melody: 0, // 0..1, how clearly one pitch class dominates
    melodyPitch: 0, // 0..1, where the sustained energy sits (log 60 Hz..4 kHz)
    melodyFlux: 0, // note attacks that are not drums (gated)
    chordChange: 0, // 0..1, how fast the harmony is moving
    silent: true,
  };

  const CENT_LO = Math.log(40);
  const CENT_SPAN = Math.log(16000) - CENT_LO;
  const MEL_LO = Math.log(60);
  const MEL_SPAN = Math.log(4000) - MEL_LO;

  // The log-spectrum from `lag` seconds ago, or null before there is one.
  function pastFrame(lag) {
    let best = null;
    let bestErr = Infinity;
    for (let i = 0; i < HIST; i++) {
      const h = hist[i];
      if (h.t < 0) continue;
      const age = clock - h.t;
      if (age < lag * 0.5) continue; // too recent to be a comparison at all
      const err = Math.abs(age - lag);
      if (err < bestErr) {
        bestErr = err;
        best = h;
      }
    }
    return best;
  }

  function process(hiData, dt) {
    if (!(dt > 0)) dt = 1 / 60;
    clock += dt;

    // dB → linear magnitude, and its log-compressed twin, once.
    let sum = 0;
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i <= TOP; i++) {
      const db = hiData[i] > floorDb ? hiData[i] : floorDb;
      const m = dbToMag(db);
      mag[i] = m;
      logMag[i] = Math.log10(1 + LOG_C * m);
      sum += m;
      sumSq += m * m;
      if (m > peak) peak = m;
    }
    const n = TOP + 1;
    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);
    out.peak = peak;
    out.crest = rms > 1e-6 ? peak / rms : 0;
    void mean;

    // Level: RMS of the spectrum, in dB, mapped to 0..1 over a 70 dB window.
    const rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : floorDb;
    out.levelDb = rmsDb;
    const lvl = Math.max(0, Math.min(1, (rmsDb + 78) / 70));
    sLevel = lvl > sLevel ? lvl * 0.5 + sLevel * 0.5 : lvl * 0.12 + sLevel * 0.88;
    out.level = sLevel;
    out.silent = rmsDb < floorDb + 12;

    // --- the dynamics gate ---------------------------------------------------
    // `loudRef` follows the music up quickly and comes down very slowly, so it
    // ends up sitting at "how loud this track gets". Everything visual is then
    // scaled by how close the present moment is to that. This is the whole
    // answer to a breakdown looking like a drop: it is not a threshold anyone
    // tuned, it is the music being quieter than itself.
    if (rmsDb > loudRef) loudRef += (rmsDb - loudRef) * (1 - Math.exp(-dt / 0.4));
    else loudRef += (rmsDb - loudRef) * (1 - Math.exp(-dt / 25));
    out.loudRefDb = loudRef;
    const dyn = Math.max(0, Math.min(1, (rmsDb - (loudRef - DYN_RANGE_DB)) / DYN_RANGE_DB));
    // Asymmetric: open promptly when the music comes back (a drop must not
    // arrive half-lit), close gently so a bar's rest does not blink the scene.
    sDynamics =
      dyn > sDynamics
        ? sDynamics + (dyn - sDynamics) * (1 - Math.exp(-dt / 0.06))
        : sDynamics + (dyn - sDynamics) * (1 - Math.exp(-dt / 0.45));
    out.dynamics = sDynamics;

    // --- SuperFlux onset function -------------------------------------------
    const past = pastFrame(ODF_LAG);
    let flux = 0;
    let lowFlux = 0;
    let midFlux = 0;
    let highFlux = 0;
    if (past) {
      const p = past.buf;
      for (let i = 0; i <= TOP; i++) {
        // Maximum over three neighbouring bins of the earlier frame. A partial
        // that merely drifted is covered by its own neighbour and contributes
        // nothing; energy appearing where there was none still does.
        let ref = p[i];
        if (i > 0 && p[i - 1] > ref) ref = p[i - 1];
        if (i < TOP && p[i + 1] > ref) ref = p[i + 1];
        const d = logMag[i] - ref;
        if (d > 0) {
          flux += d;
          if (i >= LOW0 && i <= LOW1) lowFlux += d;
          else if (i >= MIDF0 && i < MIDF1) midFlux += d;
          else if (i >= HIF0) highFlux += d;
        }
      }
    }
    out.flux = flux / n;
    const lowOdf = lowFlux / Math.max(1, LOW1 - LOW0 + 1);
    // Scenes see the gated versions; the tracker sees `flux` and `lowFlux` raw.
    out.midFlux = (midFlux / Math.max(1, MIDF1 - MIDF0)) * sDynamics;
    out.highFlux = (highFlux / Math.max(1, TOP - HIF0 + 1)) * sDynamics;

    // Store this frame for the lookback.
    hist[histHead].t = clock;
    hist[histHead].buf.set(logMag.subarray(0, nHi));
    histHead = (histHead + 1) % HIST;

    // --- the kick, in the magnitude domain -----------------------------------
    //
    // The onset function is the right signal for the BEAT TRACKER — it is a
    // difference, and the beat is where the differences are — but it makes a
    // poor KICK DETECTOR: the analyser window spreads a kick's attack over
    // several frames, and a 50 Hz kick does not complete three cycles inside
    // it, so one onset arrives as a gentle rise.
    //
    // So the kick is read from the raw magnitudes, as the ratio between a FAST
    // and a SLOW envelope of the kick band. A sustained note — the 808 under a
    // rap track, the bassline under a techno one — drives both envelopes to the
    // same place whatever its level, so the ratio sits at 1 and nothing fires.
    // A kick on top of it lifts the fast envelope and leaves the slow one
    // behind, and that transient is the hit.
    const kickLo = Math.max(1e-9, bandMean(mag, LOW0, LOW1));
    const clickLo = Math.max(1e-9, bandMean(mag, CLICK0, CLICK1));
    const dtc = Math.min(Math.max(dt, 1 / 400), 0.02);
    const kAtk = 1 - Math.exp(-dtc / 0.003);
    const kRel = 1 - Math.exp(-dtc / 0.09);
    if (!kickPrimed) {
      // Start the envelopes AT the level of the first frame: starting them at
      // zero makes the first frame of any track a rise from nothing, which is a
      // kick that never happened.
      kickPrimed = true;
      kickFast = kickSlow = kickLo;
      clickFast = clickSlow = clickLo;
    }
    kickFast += (kickLo - kickFast) * kAtk;
    kickSlow += (kickLo - kickSlow) * kRel;
    clickFast += (clickLo - clickFast) * kAtk;
    clickSlow += (clickLo - clickSlow) * kRel;

    // Body and click are not rivals: a rap kick is pure body, a hardstyle kick
    // is a click wired to a punch. Either can carry a hit.
    const bodyRise = kickSlow > 1e-9 ? kickFast / kickSlow - 1 : 0;
    const clickRise = clickSlow > 1e-9 ? clickFast / clickSlow - 1 : 0;
    const rise = Math.max(bodyRise, clickRise * 0.6);
    const lowKick = Math.max(bodyRise, 0);
    // How large the rise is against the rises this track usually produces. The
    // decay here is deliberately SLOW — the old one halved in a second and a
    // half, so a breakdown erased the reference and the first small movement
    // afterwards read as a full kick. Eight seconds keeps the reference from
    // the music either side of the quiet part, which is what it is for.
    kickRef = Math.max(rise, kickRef * Math.exp(-dtc / 11.5));
    const norm = kickRef > 0.02 ? rise / kickRef : 0;
    let kickNow = Math.max(0, Math.min(1, norm * 1.35));
    // Two gates the old detector had neither of. A hit inside the refractory
    // window is the same kick ringing out, and a hit while the music is
    // eighteen decibels down is not a kick at all.
    out.kickHit = false;
    if (kickNow > 0.45) {
      if (clock - lastKickAt < KICK_REFRACTORY) kickNow = Math.min(kickNow, out.kick);
      else {
        lastKickAt = clock;
        out.kickHit = sDynamics > 0.12;
      }
    }
    kickNow *= sDynamics;
    // Fast attack, slow release: an onset is one frame, and a scene reading it
    // on a single frame flickers.
    out.kick = kickNow > out.kick ? kickNow : out.kick * Math.max(0, 1 - dtc / 0.16);
    // The beat tracker wants the same evidence in the shape it consumes, and
    // UNGATED: the grid must survive a breakdown even when the animation does
    // not. It straddles the two domains on purpose — SuperFlux for the onset,
    // raw magnitude for the body — which is the split that makes it work on
    // both techno and rap.
    out.lowFlux = lowOdf + 0.09 * lowKick;

    // --- sustained vs struck, and the melody in the sustained half -----------
    // One exponential average per bin. A quarter of a second is long enough
    // that a drum is entirely above it and short enough that a chord change is
    // not smeared into the next one.
    const tAlpha = 1 - Math.exp(-dt / 0.25);
    let tonalSum = 0;
    let totalSum = 0;
    cumul[0] = 0;
    for (let i = 0; i <= TOP; i++) {
      const m = mag[i];
      tonal[i] += (m - tonal[i]) * tAlpha;
      // What PERSISTS is the harmonic part; a transient towers over its own
      // average and is clipped away by the min.
      const h = m < tonal[i] ? m : tonal[i];
      harm[i] = h;
      cumul[i + 1] = cumul[i] + h;
      tonalSum += h;
      totalSum += m;
    }
    out.tonal = (sTonal += ((totalSum > 1e-9 ? tonalSum / totalSum : 0) - sTonal) * 0.05);

    // What enters the chroma is how far a bin stands ABOVE ITS OWN
    // NEIGHBOURHOOD, not how much energy it holds. Raw energy gave a tilted
    // spectrum — which is what noise, a cymbal and a distorted wall all are —
    // a strongly peaked chroma, so noise read as a clear melody: exactly
    // backwards. A partial towers over the third of an octave around it;
    // noise, by definition, does not. The window is geometric (a third of an
    // octave at every frequency, not a fixed number of bins) and the prefix
    // sums above make each one an O(1) lookup.
    chroma.fill(0);
    let melWeighted = 0;
    let melEnergy = 0;
    for (let i = MEL0; i <= MEL1; i++) {
      const pc = pitchOf[i];
      if (pc < 0) continue;
      const lo = Math.max(1, Math.floor(i / 1.26));
      const hi = Math.min(TOP, Math.ceil(i * 1.26));
      const env = (cumul[hi + 1] - cumul[lo]) / Math.max(1, hi - lo + 1);
      const peakiness = harm[i] - env;
      if (peakiness > 0) chroma[pc] += peakiness;
      melWeighted += harm[i] * i;
      melEnergy += harm[i];
    }

    // How much of the band's energy is in peaks at all. This has to be asked
    // BEFORE the shape is, because normalising a vector of almost-zeros by its
    // own maximum turns rounding error into a confident melody — which is how
    // noise came back reading 1.00.
    let cSum = 0;
    for (let k = 0; k < PITCH_CLASSES; k++) cSum += chroma[k];
    const salience = melEnergy > 1e-9 ? cSum / melEnergy : 0;

    // Per-class bin count next (see `classBins`), then normalised to its own
    // strongest class so the vector says WHICH pitches are sounding rather than
    // how loud they are.
    let cMax = 0;
    let cAvgRaw = 0;
    for (let k = 0; k < PITCH_CLASSES; k++) {
      chroma[k] /= classBins[k];
      if (chroma[k] > cMax) cMax = chroma[k];
      cAvgRaw += chroma[k];
    }
    if (cMax > 1e-9) for (let k = 0; k < PITCH_CLASSES; k++) chroma[k] /= cMax;
    else chroma.fill(0);
    // Tonal clarity: one pitch class standing clear of the average means a note
    // is being played; twelve equal classes mean noise, or a cymbal.
    const cAvg = cMax > 1e-9 ? cAvgRaw / (PITCH_CLASSES * cMax) : 1;
    const clarity = Math.max(0, Math.min(1, (1 - cAvg) * 1.6));
    const strength = Math.max(0, Math.min(1, salience * 9));
    sMelody += (clarity * strength * Math.min(1, out.tonal * 2.2) - sMelody) * 0.06;
    out.melody = sMelody;

    // Where the sustained energy sits, which is roughly where the melody is.
    if (melEnergy > 1e-9) {
      const hz = Math.max(60, (melWeighted / melEnergy) * hzPerBin);
      const p = Math.max(0, Math.min(1, (Math.log(hz) - MEL_LO) / MEL_SPAN));
      melPitch += (p - melPitch) * 0.08;
    }
    out.melodyPitch = melPitch;

    // Harmony moving: the chroma now against the chroma half a second ago. A
    // held chord scores zero however loud it is; a progression scores on every
    // change, and a key change scores hard.
    const cAlpha = 1 - Math.exp(-dt / 0.35);
    let dist = 0;
    if (chromaRefAt <= 0) {
      // Anchor BOTH on the first frame. An all-zero reference — or a smoothed
      // vector still climbing out of zero — made the first half-second of every
      // track read as a key change.
      chromaRefAt = clock;
      chromaSmooth.set(chroma);
      chromaRef.set(chroma);
    }
    for (let k = 0; k < PITCH_CLASSES; k++) {
      chromaSmooth[k] += (chroma[k] - chromaSmooth[k]) * cAlpha;
      dist += Math.abs(chromaSmooth[k] - chromaRef[k]);
    }
    if (clock - chromaRefAt > 0.5) {
      chromaRefAt = clock;
      chromaRef.set(chromaSmooth);
    }
    sChord += (Math.min(1, dist / 4) - sChord) * 0.1;
    out.chordChange = sChord * sDynamics;

    // Note attacks that are NOT drums: the onset function restricted to the
    // melodic band and weighted by how tonal the moment is.
    out.melodyFlux =
      (midFlux / Math.max(1, MIDF1 - MIDF0)) * Math.min(1, out.tonal * 2) * sDynamics;

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
    // Calibrated against the synthetic material in test/audio.test.mjs: a
    // four-on-the-floor pins this near 1, a sustained pad leaves it near 0.
    const perc = Math.max(0, Math.min(1, out.flux / (0.0015 + out.level * 0.007)));
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
    for (const h of hist) {
      h.t = -1;
      h.buf.fill(0);
    }
    histHead = 0;
    clock = 0;
    tonal.fill(0);
    chroma.fill(0);
    chromaSmooth.fill(0);
    chromaRef.fill(0);
    chromaRefAt = 0;
    midFast = midSlow = modAvg = 0;
    kickFast = kickSlow = clickFast = clickSlow = kickRef = 0;
    kickPrimed = false;
    lastKickAt = -1;
    out.kick = 0;
    out.kickHit = false;
    sLevel = sCentroid = sFlatness = sPerc = sRolloff = 0;
    loudRef = floorDb;
    sDynamics = sTonal = sMelody = sChord = melPitch = 0;
    out.dynamics = 0;
    out.tonal = out.melody = out.melodyPitch = out.melodyFlux = out.chordChange = 0;
  }

  return { process, reset, out };
}

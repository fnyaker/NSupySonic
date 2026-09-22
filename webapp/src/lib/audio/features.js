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
// 50 ms apart, so this refuses nothing musical. It is a floor under the
// hysteresis below, not the mechanism: a 300 ms hardcore tail and a 60 ms roll
// sit on the same side of any fixed window, so a window alone cannot separate
// them.
const KICK_REFRACTORY = 0.048;
// How far back every witness below is compared. Long enough to clear the
// analyser's own ~46 ms window smear without reaching into the previous
// sixteenth at 250 BPM (60 ms).
const ATTACK_LAG = 0.026;
const ATK_HIST = 14; // frames kept for those lookbacks
// SOMETHING HAS TO HAVE BEEN STRUCK, and what says so is the beater. Every true
// kick measured on real audio reaches about 1 here by construction (the scale
// is this track's own kicks); a bass note swelling back between them reaches
// 0.14, because a note that fades in has no transient at all to put up there.
const STRIKE_MIN = 0.4;
// ...and it has to have struck LOW: either the bottom gained this much energy,
// or — when the bottom is already full — the fundamental restarted high with a
// beater on it, both at least RESTART_MIN.
const LOW_STRONG = 0.8;
const RESTART_MIN = 0.28;
// The one kick with no beater on it at all: a pure sine sub, an 808. It is the
// only thing that may convict itself, and its bar is set well above what this
// track's own kicks put down there so a bass note swelling in cannot reach it.
const SUB_ALONE = 1.6;
// Floors under the adaptive scales, in their own units. They are what stops a
// track with no kick in it from normalising its own fluctuation into one, and
// every one of them is set from the SMALLEST step a real kick was measured to
// make — below that figure the scale would be dividing by the material's own
// noise.
//
// They were too low and it showed on the one material that has nothing to
// divide by: a pad of three detuned saws, alone in the mix, which is an ambient
// track. Its partials beat against each other several times a second, so the
// bottom two octaves wobble by 4.6 dB and the beater band by 2.1 — and with
// floors of 4.5 and 4 those read as a full sub witness (1.02) and half a beater
// (0.52), enough to hold `kick` at the cap for the length of the track. A real
// kick's beater step measured 5.7 dB at the very least (a rap 808 with barely
// any beater on it) and 15-30 dB everywhere else.
const MIN_LIFT_DB = 4.5;
const MIN_PITCH_OCT = 0.1;
// Percussivity's scale: flux per unit level, across the gap between a pad
// (0.006) and a four-on-the-floor (0.040-0.047), both measured on real audio.
// The level floor is only there so silence cannot divide by zero.
const PERC_LO = 0.008;
const PERC_HI = 0.035;
const PERC_MIN_LEVEL = 1e-4;
// HOW EMPTY THE KICK REGION HAS TO BE BEFORE ITS CENTROID STOPS MEANING
// ANYTHING. The other three witnesses are STEPS in decibels: they measure
// themselves and read zero when nothing is there. The pitch witness is a
// SHAPE, and the shape of the noise floor is noise — it wanders by a third of
// an octave from frame to frame, which normalises into a witness of 0.6 on a
// track whose kicks (a techno kick, whose centroid actually moves DOWN as the
// bottom fills) never produce one at all.
//
// That is what convicted a closed hi-hat. Measured on real audio, techno with
// hats on every offbeat fired 2.00 times per kick, the extra one landing on the
// hat — which is 4-16 kHz noise with a 24 dB/octave skirt, so it puts nothing
// whatsoever in the kick region. It did not need to: at the offbeat the
// previous kick's 160 ms tail is long gone, the region is 56 dB below where
// this track's kicks put it, and the detector was reading the centroid of
// silence.
//
// Every true kick measured through the restart path sits within 15 dB of its
// own track's region level (zaag 14.7, speedcore 11.9, uptempo 9.8, hardstyle
// 3.8). So: full credit to 20 dB down, nothing at all by 36 dB down.
const REG_VOICED_DB = 20;
const REG_MUTE_DB = 36;
const MIN_CLICK_DB = 6;
// The sub's own floor, higher than the lift's, because the sub is the one
// witness allowed to convict alone (SUB_ALONE) and so the one that must never
// be reading a wobble. Anything that actually strikes the bottom two octaves
// steps them by far more than a pad beating against itself: a rap 808 measured
// 60 dB, a techno kick 59.
const MIN_SUB_DB = 9;
// A witness at or above this is testifying; two of them is what separates a
// kick from a bright transient that merely happens to be loud.
const WITNESS = 0.22;
// How far the eight bands' steps may spread before they stop looking like one
// gain change. Five decibels: a limiter's own bands track each other to a
// fraction of one, and any instrument spreads them far wider.
const CM_SPREAD_DB = 5;
// The Schmitt trigger. `ON` accepts a hit, `OFF` re-arms it.
const KICK_ON = 0.52;
const KICK_OFF = 0.18;
// How long a witness's scale remembers. Long on purpose: the old reference
// halved in a second and a half, so a breakdown erased it and the first small
// movement afterwards read as a full-strength kick.
const SCALE_TAU = 9;
// ...and how slowly it rises. A pulse lasts about three frames, so at this rate
// one event moves the scale by a tenth of the gap and it takes a bar of them to
// re-scale the track. That asymmetry is the whole robustness of it.
const SCALE_UP = 0.4;

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
  // THE KICK REGION, which is not the same thing as the kick band. A hardcore,
  // frenchcore or uptempo kick's fundamental STARTS at 190-260 Hz and sweeps
  // down into the band over the next fifty milliseconds; measured on synthetic
  // uptempo, the 25-180 Hz band is 6 dB DOWN at the attack and only peaks a
  // fifth of a beat later. Anything that wants to know when the kick landed has
  // to look where the kick starts.
  const REG0 = b(28);
  const REG1 = b(420);
  const CLICK0 = b(1500); // the beater's click on a sampled kick
  const CLICK1 = b(7000);
  // Eight roughly-octave bands spanning the audible range, for the common-mode
  // estimate below. Their edges are not critical; having several of them that
  // no single instrument can occupy at once is.
  const CM_HZ = [30, 80, 160, 320, 700, 1500, 3500, 8000, 16000];
  const CM_N = CM_HZ.length - 1;
  const cmLo = new Int32Array(CM_N);
  const cmHi = new Int32Array(CM_N);
  for (let j = 0; j < CM_N; j++) {
    cmLo[j] = b(CM_HZ[j]);
    cmHi[j] = Math.max(cmLo[j], b(CM_HZ[j + 1]) - 1);
  }
  const cmNow = new Float64Array(CM_N);
  const cmStep = new Float64Array(CM_N);
  const cmSum = new Float64Array(CM_N);
  // bin → band, so the eight sums ride along inside the loop that already
  // touches every bin instead of costing a second pass over the spectrum.
  const cmOf = new Int8Array(nHi).fill(-1);
  for (let j = 0; j < CM_N; j++) for (let i = cmLo[j]; i <= cmHi[j]; i++) cmOf[i] = j;
  const cmWidth = new Float64Array(CM_N);
  for (let j = 0; j < CM_N; j++) cmWidth[j] = cmHi[j] - cmLo[j] + 1;
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

  // log2(frequency) per bin, so the kick region's centroid is measured in
  // OCTAVES — a pitch move means the same thing at 40 Hz and at 400.
  const log2Hz = new Float32Array(nHi);
  for (let i = 1; i < nHi; i++) log2Hz[i] = Math.log2(i * hzPerBin);
  // PER OCTAVE, NOT PER BIN. The kick region spans nearly four octaves (28 to
  // 420 Hz) and an FFT is linear, so a plain mean over its bins gives 210-420 Hz
  // half the vote and 28-56 Hz a twenty-eighth of it — the top of the region,
  // where the kick barely lives, outweighing the bottom, where it does.
  //
  // Measured: a 700 Hz hoover, correctly low-cut, whose only residue in the
  // region is the 250-420 Hz part sitting above the corner, moved the region's
  // plain mean by 15 dB on a bar with no kick in it at all, and was convicted.
  // Weighting each bin by 1/f makes every octave count the same, which is both
  // how the ear reads it and what the witness is actually asking about.
  const regWt = new Float32Array(nHi);
  let regWtSum = 0;
  for (let i = REG0; i <= REG1; i++) {
    regWt[i] = 1 / i;
    regWtSum += regWt[i];
  }

  let midFast = 0;
  let midSlow = 0;
  let modAvg = 0;
  // The three witnesses' recent history, for the lookback below. Parallel typed
  // arrays rather than an array of objects: this runs on every frame of every
  // track and allocates nothing after construction.
  const atkT = new Float64Array(ATK_HIST).fill(-1);
  const atkReg = new Float64Array(ATK_HIST); // kick-region level, dB
  const atkCent = new Float64Array(ATK_HIST); // its centroid, octaves
  const atkClick = new Float64Array(ATK_HIST); // beater band, dB
  const atkBands = new Float64Array(ATK_HIST * 8); // per-band levels, dB
  let atkHead = 0;
  let liftRef = 0;
  let pitchRef = 0;
  let regTop = -200;
  let clickRef = 0;
  let subRef = 0;
  let kickPrimed = false;
  let kickArmed = true;
  let lastKickAt = -1;
  let lastKickStrength = 0;
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
    kickStrength: 0, // how hard the LAST accepted kick hit, held until the next
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
    cmSum.fill(0);
    for (let i = 0; i <= TOP; i++) {
      const db = hiData[i] > floorDb ? hiData[i] : floorDb;
      const m = dbToMag(db);
      mag[i] = m;
      logMag[i] = Math.log10(1 + LOG_C * m);
      sum += m;
      sumSq += m * m;
      if (m > peak) peak = m;
      const bj = cmOf[i];
      if (bj >= 0) cmSum[bj] += m;
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

    // --- the kick: THREE WITNESSES, none of which is the level ---------------
    //
    // The onset function is the right signal for the BEAT TRACKER — it is a
    // difference, and the beat is where the differences are — but it makes a
    // poor KICK DETECTOR: the analyser window spreads a kick's attack over
    // several frames, and a 50 Hz kick does not complete three cycles inside
    // it, so one onset arrives as a gentle rise.
    //
    // THE PREVIOUS DETECTOR RATIOED TWO ENVELOPES of the 25-180 Hz band — a
    // 3 ms attack against a 90 ms release — and it fails on exactly the music
    // this player is pointed at. Measured through the full chain on synthetic
    // hardcore (test/audio.test.mjs pins every figure):
    //
    //   techno 128            1.94 hits per kick — a phantom 64 ms after each
    //   frenchcore 200        2.08 per kick — the tail re-triggering itself
    //   uptempo 240           0.40 per kick — SIXTY PER CENT MISSED
    //   frenchcore + screech  3.74 per kick — a lead read as a kick
    //
    // Two assumptions produced all four, and both are wrong for this music.
    //
    // FIRST, IT ASSUMED THE KICK IS IN THE KICK BAND WHEN IT LANDS. A hardcore,
    // frenchcore or uptempo kick is a pitched sine driven into a distortion
    // chain, and it STARTS at 190-260 Hz and sweeps down over the next fifty
    // milliseconds. Measured on synthetic uptempo, the 25-180 Hz band is 4-6 dB
    // DOWN at the attack — the fundamental is not in it yet — and does not peak
    // until a fifth of a beat later, by which time it is indistinguishable from
    // the previous kick's tail. That is the sixty per cent.
    //
    // SECOND, IT ASSUMED THE LEVEL MEANS SOMETHING. These masters are limitered
    // flat: when a transient arrives the limiter pulls the whole mix down to
    // hold the ceiling, so the loudest moment in the music can read as a DROP
    // in every band at once. A detector built on "did it get louder" is reading
    // the limiter, not the kick.
    //
    // So nothing here is a level. Three witnesses, each a step over the same
    // short lag, each scale-free, each normalised against how big a step THIS
    // track's kicks actually make:
    //
    //   lift   the kick region's energy step, in dB. The whole story for a
    //          techno or house kick landing in a quiet bar, and near useless
    //          under a limiter.
    //   pitch  the region's spectral centroid stepping UP, in octaves. This is
    //          the fundamental restarting high, and it is the one thing a tail
    //          can never counterfeit: a tail sweeps DOWN, always.
    //   click  the beater band's step, in dB.
    //   sub    the step of the bottom two octaves alone. A pure sub kick — an
    //          808, a sine bass drum — has no beater and no pitch movement at
    //          all, so the three above leave it with one witness, and one is
    //          never enough. Nothing but a drum or a bass note steps down
    //          there, and a bass note that arrives without an attack (a reverse
    //          bass, a fade-in) does not step.
    //
    // A kick is the best-supported COMBINATION, not any one of them. A kick
    // over silence brings all three; a frenchcore kick over its own tail brings
    // pitch and click; a hi-hat or a screech brings click alone — which is why
    // a second witness is required to reach full strength. The old detector let
    // the click testify by itself, and that is the 3.74.
    const kickLo = Math.max(1e-9, bandMean(mag, LOW0, LOW1));
    const clickLo = Math.max(1e-9, bandMean(mag, CLICK0, CLICK1));
    const dtc = Math.min(Math.max(dt, 1 / 400), 0.02);
    let regSum = 0;
    let regW = 0;
    for (let i = REG0; i <= REG1; i++) {
      const m = mag[i] * regWt[i];
      regSum += m;
      regW += m * log2Hz[i];
    }
    for (let j = 0; j < CM_N; j++)
      cmNow[j] = 20 * Math.log10(Math.max(1e-9, cmSum[j] / cmWidth[j]));
    const regDb = 20 * Math.log10(Math.max(1e-9, regSum / regWtSum));
    const regCent = regSum > 1e-12 ? regW / regSum : log2Hz[REG0];
    const clickDb = 20 * Math.log10(clickLo);
    if (!kickPrimed) {
      // Prime AT the first frame: starting from zero makes the first frame of
      // any track a rise from nothing, which is a kick that never happened.
      kickPrimed = true;
      for (let i = 0; i < ATK_HIST; i++) {
        atkT[i] = -1;
        atkReg[i] = regDb;
        atkCent[i] = regCent;
        atkClick[i] = clickDb;
        for (let j = 0; j < CM_N; j++) atkBands[i * 8 + j] = cmNow[j];
      }
    }
    // The frame ~ATTACK_LAG back, by TIME — this engine's clock is not regular
    // and a frame count would make the lag drift with the frame rate.
    let ref = atkHead;
    let refErr = Infinity;
    for (let i = 0; i < ATK_HIST; i++) {
      if (atkT[i] < 0) continue;
      const age = clock - atkT[i];
      if (age >= ATTACK_LAG * 0.55) {
        const e2 = Math.abs(age - ATTACK_LAG);
        if (e2 < refErr) {
          refErr = e2;
          ref = i;
        }
      }
    }
    // COMMON MODE OUT. A limiter releasing after a loud stab lifts every band
    // together over its hundred-odd milliseconds, and to a detector reading
    // levels that is indistinguishable from something arriving — measured, a
    // frenchcore track with an eighth-note lead over it fired twice per kick,
    // 150 ms late, every one of the extras being the limiter letting go. A
    // scalar gain change moves every band by the same number of decibels, so
    // subtracting the whole mix's own step removes it exactly and leaves what
    // is DIFFERENTIAL: energy moving between bands, which is the only thing an
    // instrument can do. The centroid needs no such correction — a gain change
    // cannot move it at all, which is what makes it the honest witness here.
    // THE MEDIAN of the eight bands' own steps, not the whole mix's.
    //
    // The mix's step is the obvious estimator and it is wrong in the one case
    // that matters: a kick IS a broadband transient, so it moves the whole
    // mix's level, and subtracting that from each witness is the kick
    // suppressing its own evidence. Measured on an idealised kick whose beater
    // click stood 66 dB clear of everything else, the whole-mix estimate put
    // the common mode at 60 dB and the detector saw nothing at all.
    //
    // A median across bands has exactly the property wanted: an instrument
    // occupies a few bands, so its own step never reaches the middle of the
    // sorted list and the median stays near zero; a limiter's gain change moves
    // every band by the same number of decibels, so the median IS that change.
    //
    // Only ever subtracted when it is POSITIVE. A limiter letting go lifts
    // everything and has to come out; a mix getting quieter must not be ADDED
    // back in, or the end of a kick in a sparse arrangement reads as an attack
    // — measured, subtracting it signed took techno from 1.00 hits per kick to
    // 2.46, every extra one landing 160 ms late, on the decay.
    for (let j = 0; j < CM_N; j++) cmStep[j] = cmNow[j] - atkBands[ref * 8 + j];
    // Insertion sort: eight elements, on the stack, every frame.
    for (let j = 1; j < CM_N; j++) {
      const v = cmStep[j];
      let k = j - 1;
      while (k >= 0 && cmStep[k] > v) {
        cmStep[k + 1] = cmStep[k];
        k--;
      }
      cmStep[k + 1] = v;
    }
    // ...and it is only believed when the bands AGREE. A median alone is not
    // enough: a kick is broadband, so it can move five of the eight bands and
    // drag the median with it — measured on an idealised kick with a very loud
    // beater, the median read 7 dB and cancelled the kick's own 7.4 dB lift to
    // nothing. What a limiter does that no instrument does is move every band
    // by the SAME number of decibels, so the spread across the bands is the
    // test: tight, and this is a gain change to be removed; wide, and it is
    // music, which must be left alone.
    const median = (cmStep[(CM_N >> 1) - 1] + cmStep[CM_N >> 1]) / 2;
    const spread = cmStep[CM_N - 2] - cmStep[1];
    const uniform = Math.max(0, 1 - spread / CM_SPREAD_DB);
    const common = Math.max(0, median) * uniform;
    // The two lowest bands together: the SUB. Taken from `cmNow` and the
    // history directly, before the sort below scrambles `cmStep`.
    const subStepDb =
      (cmNow[0] - atkBands[ref * 8] + (cmNow[1] - atkBands[ref * 8 + 1])) / 2 - common;
    const liftDb = regDb - atkReg[ref] - common;
    const pitchOct = regCent - atkCent[ref];
    const clickStepDb = clickDb - atkClick[ref] - common;
    atkT[atkHead] = clock;
    atkReg[atkHead] = regDb;
    atkCent[atkHead] = regCent;
    atkClick[atkHead] = clickDb;
    for (let j = 0; j < CM_N; j++) atkBands[atkHead * 8 + j] = cmNow[j];
    atkHead = (atkHead + 1) % ATK_HIST;

    // How big a step this track's kicks actually make, per witness, so a soft
    // acoustic kit and a clipped hardcore kick both reach 1 at full strength.
    //
    // NOT a running maximum, which is what this was and which one exceptional
    // event owns for the next ten seconds. A roll's notes are SHORTENED to fit
    // their subdivision, so they sweep faster and step further than the track's
    // ordinary kicks; with a max, one bar of sixteenths raised the bar for the
    // whole phrase and the plain four-on-the-floor after it fell under the
    // threshold — measured, that took uptempo from 1.00 hits per kick to 0.27.
    // Rising slowly and falling slowly asks for a CONSENSUS instead: it takes
    // several events of a new size to move the scale, and a single outlier
    // moves it by a tenth of the difference.
    const upA = 1 - Math.exp(-dtc / SCALE_UP);
    const dnA = 1 - Math.exp(-dtc / SCALE_TAU);
    liftRef += (liftDb - liftRef) * (liftDb > liftRef ? upA : dnA);
    pitchRef += (pitchOct - pitchRef) * (pitchOct > pitchRef ? upA : dnA);
    clickRef += (clickStepDb - clickRef) * (clickStepDb > clickRef ? upA : dnA);
    subRef += (subStepDb - subRef) * (subStepDb > subRef ? upA : dnA);
    // How loud this track's kick region gets — same slow consensus as the
    // witness scales, so one quiet bar cannot make the rest of the track look
    // empty and one loud stab cannot make it look full.
    if (regTop < -150) regTop = regDb;
    regTop += (regDb - regTop) * (regDb > regTop ? upA : dnA);
    const voiced = Math.max(
      0,
      Math.min(1, (REG_MUTE_DB - (regTop - regDb)) / (REG_MUTE_DB - REG_VOICED_DB)),
    );
    const wLift = Math.max(0, liftDb) / Math.max(MIN_LIFT_DB, liftRef);
    // Gated on there being something down there to have a pitch. This is the
    // only witness that needs it: the other three read a step and a step over
    // nothing is nothing.
    const wPitch = (voiced * Math.max(0, pitchOct)) / Math.max(MIN_PITCH_OCT, pitchRef);
    const wClick = Math.max(0, clickStepDb) / Math.max(MIN_CLICK_DB, clickRef);
    const wSub = Math.max(0, subStepDb) / Math.max(MIN_SUB_DB, subRef);
    let votes = 0;
    if (wLift >= WITNESS) votes++;
    if (wPitch >= WITNESS) votes++;
    if (wClick >= WITNESS) votes++;
    // The sub's bar is higher than the others'. It is here to rescue the one
    // kick the other three cannot see — a pure sine sub with no beater and no
    // pitch movement — not to be a routine fourth vote: a swept hardcore kick
    // fills the sub on its way down and would otherwise be convicted twice.
    if (wSub >= WITNESS * 1.8) votes++;
    // The strongest witness carries it; a second one confirms it. One witness
    // alone is held below the trigger however loud it is, which is what a hat,
    // a clap and a screech are.
    // The strength comes from the first three. The sub witness only ever votes
    // — for the kick it exists for it is measuring the same step `lift` is.
    let best = wLift;
    if (wPitch > best) best = wPitch;
    if (wClick > best) best = wClick;
    // One witness is CAPPED below the trigger rather than merely scaled down: a
    // hi-hat can be several times louder than any kick in the track and would
    // clip its way back over the threshold on the strength of that alone. It
    // still moves `kick`, because a loud hat is a real event a scene may draw —
    // it just cannot be called a kick.
    // WHAT A KICK'S EVIDENCE LOOKS LIKE DEPENDS ON WHAT IS ALREADY SOUNDING,
    // and that is the thing a flat count of witnesses cannot express. Measured
    // on real audio, true kicks fall into two quite different shapes:
    //
    //   over a QUIET low end, the energy arrives: lift and sub both large, and
    //   the region's centroid actually moves DOWN as the bottom fills, so the
    //   pitch witness reads nothing at all (0.06 on an isolated uptempo kick);
    //   over a SATURATED one — which in this music is most of them, because the
    //   previous kick's tail is still sounding — no energy arrives anywhere:
    //   lift and sub read 0.00, and all that is left is the fundamental
    //   restarting high and the beater (pitch 0.67, click 0.46).
    //
    // A rule that demands the first shape misses every kick of the second, and
    // that is exactly what happened: a gate on "where did the new energy go"
    // threw away HALF the kicks of an off-beat uptempo pattern, the hardest and
    // most characteristic case there is.
    //
    // The false classes each miss a different half, which is what makes them
    // separable at all — every figure below is measured on real audio:
    //
    //   a hi-hat          click 1.90 and pitch 0.61, but lift 0.13, sub 0.00.
    //                     Bright, and it puts nothing at the bottom. Its pitch
    //                     witness is an artefact and is gone already: see
    //                     `voiced` above.
    //   a reverse bass    lift 0.54 and sub 0.78, but click 0.14 — it swells at
    //                     the bottom over a tenth of a second and never strikes
    //   a 320 Hz stab     pitch 1.00 and click 0.95, lift 0.23, sub 0.00 — it
    //                     restarts high because it IS high, and it has an
    //                     attack, so it is numerically a saturated-low-end kick
    //
    // So: something must have STRUCK — which is the beater, and only the
    // beater, because that is the witness a note swelling in cannot produce —
    // and it must have struck LOW, either by putting energy down there or, when
    // there is no room left, by restarting the fundamental with that beater on
    // it. The exception is the kick that has no beater at all: an 808, a sine
    // bass drum. It convicts itself on the sub alone, at a bar set high enough
    // (SUB_ALONE) that a bass note fading in cannot reach it.
    //
    // The third line is the limit this detector has, stated rather than papered
    // over: a lead whose residue lands in the kick's region, restarting high
    // with an attack on it, is not separable from a kick on one frame's
    // evidence. It is separated one layer up, where the GRID is known —
    // pattern.js scores 0.99 on exactly that case. See test/audio.test.mjs.
    const lowSide = wLift > wSub ? wLift : wSub;
    const struck = wClick >= STRIKE_MIN;
    const low = lowSide >= LOW_STRONG || (wPitch >= RESTART_MIN && wClick >= RESTART_MIN);
    let kickNow =
      (struck && low) || wSub >= SUB_ALONE
        ? Math.max(0, Math.min(votes >= 2 ? 1 : KICK_ON * 0.9, best))
        : 0;

    // A SCHMITT TRIGGER, not a refractory window alone. A fixed window cannot
    // cover a 300 ms hardcore tail without also refusing a 1/16 roll at 250 BPM
    // (60 ms apart) — the two are on the same side of any threshold. Hysteresis
    // asks the right question instead: the evidence has to fall back through a
    // release level before another attack counts, so one kick's own decay can
    // never fire twice however long it takes, while a genuinely new attack on
    // top of a tail does, because it is a fresh step.
    out.kickHit = false;
    if (kickArmed) {
      if (kickNow > KICK_ON && clock - lastKickAt >= KICK_REFRACTORY) {
        kickArmed = false;
        lastKickAt = clock;
        lastKickStrength = kickNow;
        out.kickHit = sDynamics > 0.12;
      }
    } else if (kickNow < KICK_OFF) {
      kickArmed = true;
    }
    if (!out.kickHit && !kickArmed) kickNow = Math.min(kickNow, lastKickStrength);
    kickNow *= sDynamics;
    // Fast attack, slow release: an onset is one frame, and a scene reading it
    // on a single frame flickers.
    out.kick = kickNow > out.kick ? kickNow : out.kick * Math.max(0, 1 - dtc / 0.16);
    // How hard the last accepted kick hit, held flat until the next one. A
    // scene asking "was that a big one" must not read the decaying envelope,
    // which says more about when it looked than about the kick.
    out.kickStrength = lastKickStrength;
    // The beat tracker wants the same evidence in the shape it consumes, and
    // UNGATED: the grid must survive a breakdown even when the animation does
    // not. It straddles the two domains on purpose — SuperFlux for the onset,
    // the kick region's own step for the body — which is the split that makes
    // it work on both techno and rap.
    out.lowFlux = lowOdf + 0.0025 * Math.max(0, liftDb);
    void kickLo;

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

    // Percussivity: how much of the signal is CHANGE rather than sustain, which
    // is flux against level and nothing else.
    //
    // It used to be `flux / (0.0015 + level * 0.007)`, and that additive
    // constant was the whole scale at any realistic level: it made anything
    // with a flux above about 0.0015 read as substantially percussive however
    // sustained it was. Calibrated, as its own comment admitted, against a
    // DRAWN pad whose spectrum was byte-for-byte the same every frame — so the
    // numerator really was zero and any formula passed.
    //
    // On a real pad it does not work: three detuned saws beat against each
    // other several times a second, and measured, an ambient pad alone in the
    // mix read 0.60 percussive against frenchcore's 0.62. The classifier is
    // handed this as a feature, so ambient and hardcore were arriving at it
    // indistinguishable on the one axis that should separate them outright.
    //
    // The ratio itself separates them by a factor of seven — a pad sits at
    // 0.006 and a four-on-the-floor at 0.040-0.047 — so the scale is set across
    // that gap instead. Measured after: a pad means 0.03 and peaks at 0.16, a
    // beat means 0.45-0.58 and peaks at 0.84-0.95.
    const pRatio = out.flux / Math.max(PERC_MIN_LEVEL, out.level);
    const perc = Math.max(0, Math.min(1, (pRatio - PERC_LO) / (PERC_HI - PERC_LO)));
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
    atkT.fill(-1);
    atkReg.fill(0);
    atkCent.fill(0);
    atkClick.fill(0);
    atkBands.fill(0);
    atkHead = 0;
    liftRef = pitchRef = clickRef = subRef = 0;
    kickPrimed = false;
    kickArmed = true;
    lastKickAt = -1;
    lastKickStrength = 0;
    out.kick = 0;
    out.kickHit = false;
    out.kickStrength = 0;
    sLevel = sCentroid = sFlatness = sPerc = sRolloff = 0;
    loudRef = floorDb;
    sDynamics = sTonal = sMelody = sChord = melPitch = 0;
    out.dynamics = 0;
    out.tonal = out.melody = out.melodyPitch = out.melodyFlux = out.chordChange = 0;
  }

  return { process, reset, out };
}

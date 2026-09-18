// Real-time tempo, beat and downbeat tracking.
//
// Shape of the thing, and why:
//
//  1. The onset detection function (ODF) — the whitened spectral flux from
//     features.js — is resampled onto a FIXED 100 Hz grid. The analysis clock
//     is not perfectly regular (a rAF fallback drifts, a busy frame is late),
//     and every lag→BPM conversion below assumes a constant sample rate, so
//     landing the ODF on a fixed grid first is what keeps the tempo honest.
//
//  2. Tempo comes from an autocorrelation of ~8 s of that grid, summed over
//     harmonically related lags. The search runs from 55 to 300 BPM because
//     this player is expected to be pointed at frenchcore and uptempo as well
//     as at pop. Three details in there are not decoration:
//
//     - the ODF is SMOOTHED (~20 ms) before the autocorrelation. A tempo whose
//       period is not a whole number of 10 ms slots — 174 BPM is 34.5 of them —
//       lands its onsets alternately on two neighbouring slots, so the
//       correlation at the true lag only ever catches half of them while the
//       one at double the lag catches all of them. Widening each onset past the
//       quantisation error is what stops the fundamental being thrown away.
//     - every candidate is divided by the SAME harmonic weight. Dividing by the
//       number of harmonics that happened to fall inside the search range gave
//       slow candidates a free pass — their harmonics were off the end of the
//       range, so nothing diluted them — and that alone made every track above
//       170 BPM track at exactly half speed.
//     - the preference for a "normal" tempo is a PLATEAU (90-200 BPM) with a
//       roll-off outside, not a bell centred on 120. A bell centred on pop
//       tempo quietly halves everything this player is most likely to be
//       pointed at.
//
//  3. The octave is then arbitrated by the BASS. Autocorrelation genuinely
//     cannot separate "a beat every P" from "a beat every 2P" — both are true
//     of the same signal — so something else has to decide, and the kick is the
//     right witness: an offbeat hi-hat lives in the treble and cannot fool it,
//     while a four-on-the-floor is unmistakable in it. Folding the sub+bass
//     onset function over the candidate period answers two questions: does the
//     bass fill the gap between candidate beats (then the period is half of
//     what we picked), and does it skip every other one (then it is double)?
//
//  4. Phase comes from folding the ODF over the winning period and picking the
//     offset with the most energy, then a phase-locked loop keeps a continuous
//     beat phase running between those estimates and nudges it toward strong
//     onsets.
//
//     The PLL is what makes this usable for animation: once locked, beats are
//     PREDICTED rather than detected, so a scene can be exactly on the beat (or
//     deliberately ahead of it) instead of always a detector's latency late.
//     Detection latency only ever matters for the first few seconds of a track
//     and for music with no steady pulse at all.
//
//  5. Downbeats are tracked by scoring bass energy per beat position modulo 4
//     and modulo 3, so a waltz does not get forced into four.

export const ODF_HZ = 100; // fixed analysis grid
const ODF_LEN = 800; // 8 s of history
const MIN_BPM = 55;
const MAX_BPM = 300;
const EST_EVERY = 0.25; // seconds between full tempo estimates
// How many harmonics of a candidate lag are summed. Three is enough to tell a
// pulse from its sub-harmonic and keeps the autocorrelation range — and so the
// cost — down.
const HARMONICS = 3;
// Onset smoothing, in grid slots (10 ms each). Two slots of sigma is ~20 ms:
// wide enough to swallow the grid's own quantisation error at any tempo in
// range, narrow enough that two hits 60 ms apart are still two hits.
const ODF_SIGMA = 2;

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}
const SMOOTH = gaussKernel(ODF_SIGMA);
const SMOOTH_R = (SMOOTH.length - 1) / 2;

const lagToBpm = (lag) => (60 * ODF_HZ) / lag;
const bpmToLag = (bpm) => (60 * ODF_HZ) / bpm;

export function createBeatTracker() {
  const odf = new Float32Array(ODF_LEN); // ring buffer, whitened flux
  const odfLow = new Float32Array(ODF_LEN); // same, sub+bass only (kicks)
  let head = 0; // next slot to write
  let filled = 0;

  // Accumulators for the current 10 ms slot.
  let slotAcc = 0;
  let slotLowAcc = 0;
  let slotTime = 0; // seconds accumulated into the current slot

  // The tracker's own clock, accumulated from the dt it is handed rather than
  // read off the wall. Everything here is expressed against the ODF grid, which
  // is built from the same dt, so sharing one time base is what keeps the
  // estimate cadence and the onset spacing consistent with it — and it makes
  // the tracker drivable from anything that can produce frames, including a
  // test that runs twenty seconds of audio in a millisecond.
  let clock = 0;
  let lastEst = -1e9;
  let period = bpmToLag(120) / ODF_HZ; // seconds per beat
  let bpm = 0;
  let confidence = 0;
  let phase = 0; // 0..1 inside the current beat
  let beatIndex = 0;
  let beatsPerBar = 4;
  let barPos = 0;
  let locked = false;
  let kickPulse = 0; // 0..1, how strictly the bass hits the beat grid

  // Per-beat-position bass scores, for the downbeat.
  const barScore4 = new Float32Array(4);
  const barScore3 = new Float32Array(3);
  let beatEnergy = 0;

  // Peak-picking state for the raw (unpredicted) onset stream.
  let odfMean = 0;
  let odfVar = 0;
  let lastOnsetAt = -1;
  let sinceBeat = 0;

  const LAG_MIN = Math.floor(bpmToLag(MAX_BPM));
  const LAG_MAX = Math.ceil(bpmToLag(MIN_BPM));
  // The autocorrelation is needed past the candidate range, up to the highest
  // harmonic any candidate sums — otherwise a candidate near LAG_MAX would be
  // scored on fewer harmonics than one near LAG_MIN, which is precisely the
  // bias that used to halve every fast track. Bounded so the longest lag still
  // has a few seconds of overlap to correlate over.
  const ACF_MAX = Math.min(ODF_LEN - 200, LAG_MAX * HARMONICS);
  let HARM_W = 1;
  for (let h = 2; h <= HARMONICS; h++) HARM_W += 1 / h;
  const acf = new Float32Array(ACF_MAX + 2);
  // Folds run at up to twice the candidate period (the octave check).
  const fold = new Float32Array(LAG_MAX * 2 + 4);
  // The ring buffer flattened oldest→newest and smoothed, rebuilt once per
  // estimate. Flattening it here also takes the ring's modulo arithmetic out of
  // the autocorrelation's inner loop, which is where all the time goes.
  const work = new Float32Array(ODF_LEN);
  const workLow = new Float32Array(ODF_LEN);
  let workN = 0;

  const out = {
    bpm: 0,
    confidence: 0,
    phase: 0, // 0..1 within the beat
    beat: false, // true on the frame a beat lands
    beatIndex: 0,
    barPos: 0, // which beat of the bar (0 = downbeat)
    beatsPerBar: 4,
    downbeat: false,
    onset: 0, // strength of a raw onset this frame, 0 when none
    // How concentrated the bass onsets are on the beat grid. A four-on-the-floor
    // pins this near 1; a rock kit, which puts its kick wherever the song wants
    // it, sits much lower. It is the cleanest single axis for telling "machine"
    // rhythm from "played" rhythm, so the classifier leans on it heavily.
    kickPulse: 0,
    sinceBeat: 0, // seconds since the last beat
    period: 0.5,
    locked: false,
  };

  function push(v, low) {
    odf[head] = v;
    odfLow[head] = low;
    head = (head + 1) % ODF_LEN;
    if (filled < ODF_LEN) filled++;
  }

  // Flatten the ring oldest→newest and smooth it. Both halves of the estimate
  // (the autocorrelation and the folds) read these.
  function fillWork() {
    const n = filled;
    workN = n;
    const base = head - n + ODF_LEN * 2;
    for (let i = 0; i < n; i++) {
      const j = (base + i) % ODF_LEN;
      work[i] = odf[j];
      workLow[i] = odfLow[j];
    }
    smoothInto(work, n);
    smoothInto(workLow, n);
  }

  const smoothTmp = new Float32Array(ODF_LEN);
  function smoothInto(buf, n) {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -SMOOTH_R; j <= SMOOTH_R; j++) {
        const x = i + j;
        if (x >= 0 && x < n) s += buf[x] * SMOOTH[j + SMOOTH_R];
      }
      smoothTmp[i] = s;
    }
    buf.set(smoothTmp.subarray(0, n));
  }

  function estimate() {
    const n = filled;
    if (n < ODF_HZ * 3) return; // under 3 s of history: nothing to say yet
    fillWork();

    // Mean-remove, so the autocorrelation measures periodicity rather than the
    // DC level (a loud passage would otherwise correlate with everything).
    let mean = 0;
    for (let i = 0; i < n; i++) mean += work[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const d = work[i] - mean;
      energy += d * d;
    }
    if (energy < 1e-9) {
      confidence *= 0.7;
      return;
    }

    const lagMax = Math.min(ACF_MAX, LAG_MAX);
    for (let lag = LAG_MIN; lag <= ACF_MAX; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += (work[i] - mean) * (work[i - lag] - mean);
      acf[lag] = s / energy;
    }

    // Harmonic summation, every candidate divided by the SAME weight (see the
    // file header): a harmonic that falls outside the computed range counts as
    // no support, not as one fewer thing to divide by.
    let best = -1;
    let bestLag = 0;
    let second = -1;
    for (let lag = LAG_MIN; lag <= lagMax; lag++) {
      let s = acf[lag];
      for (let h = 2; h <= HARMONICS; h++) {
        const l = lag * h;
        if (l > ACF_MAX) break;
        s += acf[l] / h;
      }
      s /= HARM_W;
      s *= tempoPrior(lagToBpm(lag));
      if (s > best) {
        second = best;
        best = s;
        bestLag = lag;
      } else if (s > second) second = s;
    }
    if (!bestLag) return;

    // Parabolic interpolation around the winning lag: the grid is 10 ms, which
    // at 175 BPM is a whole BPM of quantisation — enough for the phase to drift
    // visibly across a bar. Interpolating recovers sub-slot precision.
    const y1 = acf[bestLag];
    const y0 = bestLag - 1 >= LAG_MIN ? acf[bestLag - 1] : y1;
    const y2 = bestLag + 1 <= ACF_MAX ? acf[bestLag + 1] : y1;
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    let lagF = bestLag + Math.max(-0.5, Math.min(0.5, shift));
    lagF = correctOctave(lagF);
    const newPeriod = lagF / ODF_HZ;

    // Confidence: how far the winner stands above the runner-up, scaled by the
    // absolute correlation. Both matter — a clear winner over a flat field is
    // still meaningless if nothing correlates at all.
    const margin = second > 0 ? Math.max(0, (best - second) / (best + 1e-6)) : 1;
    const conf = Math.max(0, Math.min(1, best * 2.2)) * (0.35 + 0.65 * margin);
    confidence = confidence * 0.55 + conf * 0.45;

    // Adopt a new tempo carefully. A small change is a refinement of the same
    // pulse and is eased in; a jump is a different pulse and is only taken when
    // the evidence is clear, otherwise a single ambiguous bar re-times the whole
    // animation. An exact half/double is treated as a refinement of the same
    // grid, so switching octave never resets the phase.
    const ratio = newPeriod / period;
    if (!locked && confidence > 0.25) {
      period = newPeriod;
      locked = true;
      phaseFromFold();
    } else if (ratio > 0.94 && ratio < 1.06) {
      period = period * 0.75 + newPeriod * 0.25;
    } else if (confidence > 0.42) {
      period = newPeriod;
      phaseFromFold();
    }
    bpm = 60 / period;
    if (confidence < 0.12) locked = false;
    measureKickPulse();
  }

  // A plateau across the tempi a beat grid is normally written in, rolling off
  // outside it. Deliberately not a bell on 120: the roll-off is what keeps a
  // 300 BPM reading from being invented out of noise, and a bell would instead
  // spend its slope halving the genres this player exists for.
  const PRIOR_LO = 90;
  const PRIOR_HI = 200;
  const PRIOR_SIGMA = 0.55;
  function tempoPrior(b) {
    let d = 0;
    if (b < PRIOR_LO) d = Math.log(b / PRIOR_LO);
    else if (b > PRIOR_HI) d = Math.log(b / PRIOR_HI);
    else return 1;
    return Math.exp(-(d * d) / (2 * PRIOR_SIGMA * PRIOR_SIGMA));
  }

  // Fold the BASS onset function at `p` slots and return how strong the
  // half-period position is relative to the strongest one. ~1 means the bass
  // hits twice per period; ~0 means it hits once.
  function foldHalfRatio(p) {
    const P = Math.max(2, Math.min(fold.length - 1, Math.round(p)));
    const n = workN;
    fold.fill(0, 0, P);
    let total = 0;
    for (let i = 0; i < n; i++) {
      fold[i % P] += workLow[i];
      total += workLow[i];
    }
    if (total < 1e-5) return -1; // no bass to ask
    const w = Math.max(1, Math.round(0.03 * ODF_HZ));
    const around = (c) => {
      let s = 0;
      for (let j = -w; j <= w; j++) s += fold[(((c + j) % P) + P) % P];
      return s;
    };
    let p0 = 0;
    for (let k = 1; k < P; k++) if (fold[k] > fold[p0]) p0 = k;
    const a = around(p0);
    const b = around(p0 + Math.round(P / 2));
    return a > 1e-6 ? b / a : 0;
  }

  // Decide the metrical level from the bass (see the file header). At most one
  // step in either direction, and only when the bass has an opinion at all —
  // a solo violin has no kick to ask, and its grid is left where it is.
  function correctOctave(lagF) {
    const dbl = foldHalfRatio(lagF * 2);
    if (dbl >= 0 && dbl < 0.35 && lagF * 2 <= LAG_MAX) return lagF * 2;
    const half = foldHalfRatio(lagF);
    if (half >= 0.72 && lagF / 2 >= LAG_MIN) return lagF / 2;
    return lagF;
  }

  // Fold the ODF over the current period and take the offset carrying the most
  // energy as the beat. Runs only when the tempo itself moved — between those
  // moments the PLL owns the phase.
  function phaseFromFold() {
    const n = workN;
    if (!n) return;
    const P = Math.max(2, Math.min(fold.length - 1, Math.round(period * ODF_HZ)));
    fold.fill(0, 0, P);
    // Weight recent history more: the phase we want is the one that is true
    // NOW, not the average of the last eight seconds.
    for (let i = 0; i < n; i++) {
      const w = 0.35 + 0.65 * (i / n);
      fold[i % P] += (work[i] + workLow[i] * 0.6) * w;
    }
    let best = -1;
    let bestK = 0;
    for (let k = 0; k < P; k++) {
      // Smooth over ±1 slot so a beat landing between grid points still wins.
      const s = fold[(k - 1 + P) % P] * 0.5 + fold[k] + fold[(k + 1) % P] * 0.5;
      if (s > best) {
        best = s;
        bestK = k;
      }
    }
    // `bestK` is the slot index (mod P) a beat falls on; the newest sample sits
    // at index n-1, so the phase now is how far past that beat we are.
    const posNow = (n - 1) % P;
    phase = ((posNow - bestK + P) % P) / P;
  }

  // Fold the BASS onset function over the current period: if most of its energy
  // lands on one offset, the bass is on a grid.
  function measureKickPulse() {
    const n = workN;
    const P = Math.max(2, Math.min(fold.length - 1, Math.round(period * ODF_HZ)));
    if (n < P * 2) return;
    fold.fill(0, 0, P);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const v = workLow[i];
      fold[i % P] += v;
      total += v;
    }
    if (total < 1e-6) {
      kickPulse *= 0.8;
      return;
    }
    // Energy inside a window around the best offset, as a share of all of it,
    // with the window's own share of the period subtracted so the reading means
    // the same thing at every tempo. The window can never be narrower than the
    // smoothing kernel that widened these onsets in the first place: a window
    // tighter than the blur would count a perfectly gridded bass as scattered,
    // and it would do so worst at high tempo — exactly the genres whose grid is
    // strictest.
    let best = 0;
    const w = Math.max(SMOOTH_R, Math.round(P * 0.05));
    for (let k = 0; k < P; k++) {
      let s2 = 0;
      for (let j = -w; j <= w; j++) s2 += fold[(((k + j) % P) + P) % P];
      if (s2 > best) best = s2;
    }
    const share = best / total;
    const baseline = Math.min(1, (2 * w + 1) / P);
    const norm = Math.max(0, (share - baseline) / Math.max(1e-6, 1 - baseline));
    kickPulse = kickPulse * 0.7 + Math.min(1, norm * 1.25) * 0.3;
  }

  // Score bar positions from the bass energy collected during each beat.
  function scoreBar() {
    const p4 = beatIndex % 4;
    const p3 = beatIndex % 3;
    for (let i = 0; i < 4; i++) barScore4[i] *= 0.97;
    for (let i = 0; i < 3; i++) barScore3[i] *= 0.97;
    barScore4[p4] += beatEnergy;
    barScore3[p3] += beatEnergy;
    beatEnergy = 0;

    const pick = (arr) => {
      let bi = 0;
      let bv = -1;
      let sum = 0;
      for (let i = 0; i < arr.length; i++) {
        sum += arr[i];
        if (arr[i] > bv) {
          bv = arr[i];
          bi = i;
        }
      }
      const mean = sum / arr.length;
      return { i: bi, contrast: mean > 1e-6 ? (bv - mean) / mean : 0 };
    };
    const a = pick(barScore4);
    const b = pick(barScore3);
    // Four unless three is clearly a better fit — most music is in four, and
    // flip-flopping between metres looks like a bug on screen.
    if (b.contrast > a.contrast * 1.35 && b.contrast > 0.25) {
      beatsPerBar = 3;
      barPos = (beatIndex - b.i + 3) % 3;
    } else {
      beatsPerBar = 4;
      barPos = (beatIndex - a.i + 4) % 4;
    }
  }

  /**
   * Feed one analysis frame.
   * @param {number} flux      whitened full-band spectral flux
   * @param {number} lowFlux   whitened sub+bass flux (the kick)
   * @param {number} dt        seconds since the previous frame
   */
  function process(flux, lowFlux, dt) {
    out.beat = false;
    out.downbeat = false;
    out.onset = 0;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 0.25); // a stalled tab must not teleport the phase
    clock += dt;

    // --- resample onto the fixed grid ---------------------------------------
    slotAcc = Math.max(slotAcc, flux);
    slotLowAcc = Math.max(slotLowAcc, lowFlux);
    slotTime += dt;
    const slot = 1 / ODF_HZ;
    while (slotTime >= slot) {
      push(slotAcc, slotLowAcc);
      slotTime -= slot;
      // Carry the peak into the next slot only if the frame straddled it; a
      // fresh slot otherwise starts empty so a long frame cannot smear one
      // onset across three grid points.
      slotAcc = slotTime > 0 ? flux : 0;
      slotLowAcc = slotTime > 0 ? lowFlux : 0;
    }

    // --- raw onset stream (used even with no stable tempo) ------------------
    const d = flux - odfMean;
    odfMean += d * 0.02;
    odfVar += (d * d - odfVar) * 0.02;
    const sd = Math.sqrt(Math.max(odfVar, 1e-12));
    const thresh = odfMean + sd * 1.6;
    if (flux > thresh && clock - lastOnsetAt > 0.055) {
      lastOnsetAt = clock;
      out.onset = Math.max(0, Math.min(1, (flux - thresh) / (sd * 3 + 1e-9)));
    }
    beatEnergy += lowFlux;

    // --- tempo ---------------------------------------------------------------
    if (clock - lastEst > EST_EVERY) {
      lastEst = clock;
      estimate();
    }

    // --- phase-locked loop ---------------------------------------------------
    sinceBeat += dt;
    phase += dt / period;
    if (locked && out.onset > 0.25) {
      // Signed distance from the nearest beat, in beats: negative = the onset
      // arrived early, positive = late.
      let err = phase % 1;
      if (err > 0.5) err -= 1;
      // Only correct when the onset is plausibly THE beat rather than an
      // off-beat hit, and correct gently — the tempo estimate, not the PLL, is
      // what should be making large moves.
      if (Math.abs(err) < 0.28) {
        const k = 0.18 * Math.min(1, out.onset * 1.5);
        phase -= err * k;
        period *= 1 + err * k * 0.06;
        period = Math.max(60 / MAX_BPM, Math.min(60 / MIN_BPM, period));
      }
    }
    if (phase >= 1) {
      phase -= Math.floor(phase);
      beatIndex++;
      sinceBeat = 0;
      out.beat = true;
      scoreBar();
      out.downbeat = barPos === 0;
    }

    out.bpm = locked ? bpm : 0;
    out.confidence = confidence;
    out.phase = phase;
    out.beatIndex = beatIndex;
    out.barPos = barPos;
    out.beatsPerBar = beatsPerBar;
    out.kickPulse = kickPulse;
    out.sinceBeat = sinceBeat;
    out.period = period;
    out.locked = locked;
    return out;
  }

  /**
   * Start from a tempo somebody already measured over the whole track.
   *
   * This is what a served BPM buys: the search does not have to converge. The
   * period is set, the grid is declared locked, and the only thing left to find
   * is the PHASE — which is genuinely per-moment and stays the live tracker's
   * job. A later estimate can still move it (the adopt rules below apply
   * normally), so a wrong figure is corrected rather than obeyed for ever.
   */
  function seed(seedBpm, seedConfidence = 0.9) {
    const b = +seedBpm;
    if (!Number.isFinite(b) || b < MIN_BPM || b > MAX_BPM) return false;
    period = 60 / b;
    bpm = b;
    confidence = Math.max(confidence, Math.min(1, +seedConfidence || 0.9));
    locked = true;
    // The phase is unknown until the first fold, so leave it where it is: the
    // PLL pulls it onto the beat within a bar or two, and phaseFromFold
    // corrects it outright at the next estimate.
    lastEst = -1e9;
    // Publish straight away rather than waiting for the next frame: a caller
    // that seeds and then reads is entitled to see what it just set, and the
    // whole point of seeding is that the answer is available immediately.
    out.bpm = bpm;
    out.confidence = confidence;
    out.period = period;
    out.locked = true;
    return true;
  }

  function reset() {
    odf.fill(0);
    odfLow.fill(0);
    head = 0;
    filled = 0;
    slotAcc = slotLowAcc = slotTime = 0;
    clock = 0;
    lastEst = -1e9;
    period = bpmToLag(120) / ODF_HZ;
    bpm = 0;
    confidence = 0;
    phase = 0;
    beatIndex = 0;
    beatsPerBar = 4;
    barPos = 0;
    locked = false;
    kickPulse = 0;
    barScore4.fill(0);
    barScore3.fill(0);
    beatEnergy = 0;
    odfMean = 0;
    odfVar = 0;
    sinceBeat = 0;
  }

  return { process, reset, seed, out };
}

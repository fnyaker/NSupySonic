// Real-time tempo, beat and downbeat tracking.
//
// Shape of the thing, and why:
//
//  1. THE ONSET FUNCTION IS CONDITIONED BEFORE ANYTHING READS IT. What arrives
//     from features.js is the raw SuperFlux value — the right signal, on the
//     wrong scale. Two things are done to it here, and both exist because of
//     what they stop:
//
//     - a LOCAL MEAN (~120 ms) is subtracted and the result half-wave
//       rectified. A riser, a filter sweep, a reverb wash, a long noise build:
//       all of them raise the flux CONTINUOUSLY for seconds, and a continuous
//       rise is not a beat. Subtracting the local mean removes exactly that
//       component — the mean climbs with the sweep, so the difference stays
//       flat — while a transient, which beats its own local mean by
//       definition, comes through untouched.
//     - the result is then expressed in units of the track's OWN average onset
//       and CLIPPED. One enormous FX hit — a reverse crash, a bitcrushed stab —
//       used to be worth twenty kicks inside an eight-second autocorrelation
//       and re-timed the whole grid on its own; clipped, it is worth about one
//       and a quarter. The clip is deliberately far above an ordinary onset
//       (25× the average frame), because the point is to bound the outlier,
//       NOT to flatten a kick and a hi-hat onto the same value: do that and the
//       sixteenths carry as much of the autocorrelation as the beat does, which
//       is its own way of losing the tempo.
//
//     Whitening like this would be wrong for an animation — a whisper and a
//     wall of sound must not draw the same — which is precisely why it lives
//     HERE and not in features.js. The tracker only cares where the peaks are.
//
//  2. The ODF is resampled onto a FIXED 100 Hz grid. The analysis clock is not
//     perfectly regular (a rAF fallback drifts, a busy frame is late), and
//     every lag→BPM conversion below assumes a constant sample rate.
//
//  3. Tempo comes from an autocorrelation of ~8 s of that grid, summed over
//     harmonically related lags — and then AVERAGED OVER TIME. That average is
//     the single biggest reason the reading is steady: one estimate is a
//     snapshot of eight seconds and an FX bar can dominate it, while the
//     running tempogram (~2 s of estimates, i.e. tens of seconds of music)
//     cannot be moved by one bar of anything. Three details in the
//     autocorrelation itself are not decoration:
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
//  4. A shortlist of candidates is then scored on how well the ODF actually
//     FOLDS onto each one's grid (`gridQuality`). Autocorrelation answers "is
//     there a repeat at this lag", which a double-speed candidate satisfies
//     just as well as the true one; folding answers "and does the music land on
//     that grid, or on half of it", which it does not. The on-grid share is
//     normalised by the share a window that size would capture from noise, so
//     the number means the same thing at every tempo — and a candidate whose
//     grid is half empty scores visibly worse than the one whose grid is full.
//
//  5. The octave is then arbitrated by the BASS. Autocorrelation genuinely
//     cannot separate "a beat every P" from "a beat every 2P" — both are true
//     of the same signal — so something else has to decide, and the kick is the
//     right witness: an offbeat hi-hat lives in the treble and cannot fool it,
//     while a four-on-the-floor is unmistakable in it. Folding the sub+bass
//     onset function over the candidate period answers two questions: does the
//     bass fill the gap between candidate beats (then the period is half of
//     what we picked), and does it skip every other one (then it is double)?
//
//     That answer is a graded VOTE held over several estimates, with a dead
//     band and a cooldown, not a per-estimate threshold. A ratio hovering
//     either side of a hard threshold used to flip the grid four times a
//     second — which is what "the BPM goes from 120 to 250 and back" is made
//     of. Inside the dead band the grid stays on the metrical level it is
//     already on, whatever the fresh autocorrelation happens to prefer.
//
//  6. NOTHING MOVES THE GRID WITHOUT PERSISTENCE. A candidate that is neither
//     the current tempo nor an octave of it has to win several consecutive
//     estimates before it is adopted, and the incumbent carries a bonus while
//     it is being challenged. Music changes tempo about as often as it changes
//     key; a tracker that can be re-timed by one ambiguous bar is wrong far
//     more often than the music is.
//
//  7. Phase comes from folding the ODF over the winning period and picking the
//     offset with the most energy, then a phase-locked loop keeps a continuous
//     beat phase running between those estimates and nudges it toward strong
//     onsets.
//
//     The PLL is what makes this usable for animation: once locked, beats are
//     PREDICTED rather than detected, so a scene can be exactly on the beat (or
//     deliberately ahead of it) instead of always a detector's latency late.
//
//  8. Downbeats are tracked by scoring bass energy per beat position modulo 4
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
// The default tempo plateau, used until something tells the tracker what kind
// of music this is. See `setTempoRange`.
const DEFAULT_PRIOR_LO = 90;
const DEFAULT_PRIOR_HI = 200;
const PRIOR_SIGMA = 0.42;

// --- ODF conditioning -------------------------------------------------------
// The local mean a transient has to beat. Long enough to cover a kick and its
// ring-out, short enough that it cannot follow the onsets themselves.
const MEAN_TAU = 0.12;
// ...and the same window expressed in beats, which is what actually governs it
// above ~200 BPM. Whichever is longer wins.
const MEAN_BEATS = 1.5;
// The track's own onset scale. Seconds, so it spans bars rather than beats: a
// scale that followed the beat would flatten the beat.
const SCALE_TAU = 2.5;
// Where the clip lands, in multiples of that scale. High enough that a kick is
// never clipped on ordinary material and low enough that a one-off FX hit is.
const SCALE_CLIP = 25;

// --- decision memory --------------------------------------------------------
// Time constant of the running tempogram, in seconds of estimates.
const TG_TAU = 2.0;
const TG_ALPHA = 1 - Math.exp(-EST_EVERY / TG_TAU);
// How much the tempo the grid is already on is favoured over a challenger.
const INCUMBENT = 0.35;
// ...and how much a tempo somebody measured over the whole track is. Bigger,
// because it is a better measurement than any eight-second window — but still
// beatable, so a wrong figure is corrected rather than obeyed for ever.
const SEED_BONUS = 0.7;
const SEED_OCTAVE = 0.22;
// The confidence a grid keeps while it agrees with a seed. Enough to stay
// locked and to keep the readout honest, low enough that a scene reading
// confidence still knows this is not a strongly self-evident pulse.
const SEED_FLOOR = 0.45;
// The width, in log-lag, of those two bonuses. 6% is about a beat of drift
// across a bar, which is the point at which two readings stop being the same
// tempo measured twice.
const BUMP_W = 0.06;
// Consecutive estimates a genuinely different tempo must win before it is
// adopted. Five at 4 Hz is a bar and a quarter at 150 BPM.
const CHALLENGE_NEEDED = 5;
// The octave vote: how fast it moves, where it fires, and how long it then
// refuses to be asked again.
const OCT_SMOOTH = 0.3;
const OCT_ON = 0.55;
const OCT_COOLDOWN = 2.5;
// How much better the music has to fit a NEIGHBOURING metrical level before
// that counts as evidence, and over what span the vote ramps up. A level that
// merely ties is no reason to move; one that fits half again as well is.
const LEVEL_EDGE = 1.15;
const LEVEL_SPAN = 0.3;
// ...and how much worse a level has to fit before the fold is not allowed to
// vote for it at all. Below this ratio the fold is reading something other
// than the metre.
const LEVEL_VETO = 0.85;
// How long the music has to contradict the seed's metrical level, at full
// strength, before the anchor itself is moved an octave. Twenty seconds is
// several phrases: long enough that no breakdown, fill or intro can spend it,
// short enough that a track published at half its tempo is right for most of
// its length.
const SEED_DOUBT = 20;
// The width, in octaves, of the seed's own plausibility bell. Narrow: the
// point of a whole-track measurement is that it settles the metrical level, so
// half of it and twice it must both be strongly disfavoured.
const SEED_SIGMA = 0.18;
// What a level the seed says nothing about is still worth, as a fraction of the
// ordinary prior. Ten per cent: enough that an octave of the seed is strongly
// disfavoured, far enough above zero that the music can still be heard there.
const SEED_FLOOR_W = 0.1;
// The smallest gap, in grid slots, between two candidates that count as
// different peaks. The ODF is smoothed over ~2 slots, so anything closer is the
// same peak measured twice.
const PEAK_SLOTS = 4;
// How far the PLL's phase may sit from the fold's before it is challenged, and
// how many consecutive estimates that has to hold.
//
// Deliberately WIDE. The PLL owns small errors and corrects them continuously;
// this exists for the one thing it cannot fix by itself, which is sitting on
// the wrong PART of the beat. Set it to the detector's own latency instead and
// it fires on ordinary drift: measured on material with a human feel it snapped
// the grid every second or so and cost a fifth of the main kicks it had just
// been fixed to find.
const PHASE_TOL = 0.19;
const PHASE_DOUBT = 4;
// How many candidates are folded. The autocorrelation's shortlist is short:
// past the fifth peak nothing is a plausible tempo.
const SHORTLIST = 5;

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

// 1 when the ratio is 1, falling off over BUMP_W in log space. Used for every
// "is this the same tempo as that one" question in the file.
function bump(ratio) {
  if (!(ratio > 0)) return 0;
  const d = Math.log(ratio) / BUMP_W;
  return d * d > 18 ? 0 : Math.exp(-0.5 * d * d);
}
// Soft ramps, so the octave evidence is graded rather than a threshold.
const rampUp = (x, t, w) => Math.max(0, Math.min(1, (x - t) / w));
const rampDown = (x, t, w) => Math.max(0, Math.min(1, (t - x) / w));

export function createBeatTracker() {
  const odf = new Float32Array(ODF_LEN); // ring buffer, conditioned flux
  const odfLow = new Float32Array(ODF_LEN); // same, sub+bass only (kicks)
  let head = 0; // next slot to write
  let filled = 0;

  // Accumulators for the current 10 ms slot.
  let slotAcc = 0;
  let slotLowAcc = 0;
  let slotTime = 0; // seconds accumulated into the current slot

  // ODF conditioning state (see the header).
  let fluxMean = 0;
  let lowMean = 0;
  let fluxScale = 0;
  let lowScale = 0;
  // How densely this track normally fires onsets. Up in a few seconds, down
  // over half a minute — the same asymmetry as the loudness reference in
  // features.js, and for the same reason: it has to describe the track, not
  // the bar. Read by `estimate` to tell a quiet window from a busy one.
  let activity = 0;

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

  // Decision memory.
  let estCount = 0;
  let octVote = 0;
  let lastOctAt = -1e9;
  let phaseDoubt = 0; // consecutive estimates the fold has disagreed with the PLL
  let challenger = 0; // lag the challenger is arguing for, 0 when none
  let challengeCount = 0;
  let seedLag = 0; // a tempo measured over the whole track, if there is one
  // Seconds the music has spent contradicting the seed's metrical level at full
  // strength. See `octBar`.
  let seedDoubt = 0;

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
  // The running tempogram: the harmonic-summed correlation per candidate lag,
  // averaged across estimates. This is the memory that makes the reading hold
  // through a bar of anything.
  const tg = new Float32Array(LAG_MAX + 2);
  const cand = new Float32Array(LAG_MAX + 2);
  // Folds run at up to twice the candidate period (the octave check).
  const fold = new Float32Array(LAG_MAX * 2 + 4);
  // The ring buffer flattened oldest→newest and smoothed, rebuilt once per
  // estimate. Flattening it here also takes the ring's modulo arithmetic out of
  // the autocorrelation's inner loop, which is where all the time goes.
  const work = new Float32Array(ODF_LEN);
  const workLow = new Float32Array(ODF_LEN);
  const dev = new Float32Array(ODF_LEN); // work, mean removed
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

  // A PLATEAU across the tempi a beat grid is normally written in, rolling off
  // outside it. Deliberately not a bell on 120: the roll-off is what keeps a
  // 300 BPM reading from being invented out of noise, and a bell would instead
  // spend its slope halving the genres this player exists for.
  //
  // Its EDGES MOVE WITH THE GENRE, which is the one thing a fixed prior cannot
  // do and the reason a fixed one cannot serve both halves of this library. A
  // hardcore track at 250 BPM and a house track at 125 are the same reading
  // twice over as far as an autocorrelation is concerned, and no amount of
  // signal processing separates them — what separates them is knowing which
  // kind of record is playing, which the engine does know (the server measured
  // the track, or the live classifier named a family). Published work on
  // exactly this problem reaches the same conclusion: octave errors in
  // electronic music come down by feeding the style estimate back into the
  // tempo prior. `setTempoRange` is that feedback, and it is the ONLY thing in
  // this file that another module gets to move.
  let priorLo = DEFAULT_PRIOR_LO;
  let priorHi = DEFAULT_PRIOR_HI;
  function tempoPrior(b) {
    let d = 0;
    if (b < priorLo) d = Math.log(b / priorLo);
    else if (b > priorHi) d = Math.log(b / priorHi);
    else return 1;
    return Math.exp(-(d * d) / (2 * PRIOR_SIGMA * PRIOR_SIGMA));
  }

  /**
   * How plausible a METRICAL LEVEL is, before the music is consulted.
   *
   * When something has measured the whole track, that is the answer and the
   * prior steps aside: an eight-second window deciding it disagrees with a
   * measurement made over four minutes is the single most common way this
   * tracker used to be wrong, and it is what "it overwrites the tempo the
   * server sent with nothing" means. The seed stays BEATABLE — the bell is
   * finite and the music's own fit is multiplied through it — so a wrong figure
   * is still corrected rather than obeyed for ever.
   */
  function levelPrior(lag) {
    const base = tempoPrior(lagToBpm(lag));
    if (seedLag <= 0) return base;
    // A NARROW bell over a FLOOR, not a broad bell on its own. A broad one
    // behaves badly exactly when the seed is wrong: seeded at 117 on a 175 BPM
    // track, half of 175 sits closer to the seed in log-tempo than 175 does, so
    // the bell quietly recommends 87.5 — the tracker then obeys a figure that
    // is wrong in a way the music never suggested. Narrow, the seed says
    // something strong about its own neighbourhood and nothing at all about
    // anywhere else, and where it says nothing the ordinary prior and the music
    // decide between them. That is what makes it an anchor rather than a fog.
    const d = Math.log2(lag / seedLag);
    return Math.max(base * SEED_FLOOR_W, Math.exp(-(d * d) / (2 * SEED_SIGMA * SEED_SIGMA)));
  }

  // Everything that is known about a candidate BEFORE the music is consulted:
  // the tempo prior, the tempo somebody already measured over the whole track,
  // and the one the grid is currently running on.
  function weightFor(lag) {
    // The ORDINARY prior here, not the seed-anchored one. The two questions are
    // different and want different amounts of the seed in them: which metrical
    // LEVEL the grid runs at is genuinely ambiguous in the signal, so a
    // whole-track measurement should all but settle it (`levelPrior`, used by
    // everything octave-related below); which TEMPO it is is not ambiguous, and
    // a served figure that is simply wrong — 117 on a 175 BPM track — has to be
    // overruled by the music rather than obeyed. Putting the seed bell in here
    // as well made a wrong figure unbeatable, which is the opposite failure to
    // the one all this exists to fix and just as bad.
    let w = tempoPrior(lagToBpm(lag));
    if (seedLag > 0) {
      w *=
        1 +
        SEED_BONUS * bump(lag / seedLag) +
        SEED_OCTAVE * (bump(lag / (seedLag * 2)) + bump(lag / (seedLag * 0.5)));
    }
    if (locked) w *= 1 + INCUMBENT * bump(lag / (period * ODF_HZ));
    return w;
  }

  /**
   * How well the music fits a metrical level, on the same terms `estimate`
   * judges a candidate by: how much the tempogram supports it, how cleanly the
   * onsets fold onto it, and how plausible a tempo it is.
   *
   * This exists because the octave question used to be decided ENTIRELY by
   * folding the bass, and folding cannot separate "a kick every beat with an
   * offbeat hat" from "a kick and a snare alternating on the beat" — the fold
   * looks identical and the right answers are an octave apart. Measured on
   * synthetic techno with a prominent offbeat hat, the tempogram named 128 BPM
   * clearly (0.540 against 0.312 for 256) on every single estimate, and the
   * grid sat at 256 for the whole track anyway: `correctOctave` re-expressed
   * each correct estimate at the level the grid was already on, so the reading
   * that knew the answer was the one being discarded. Asking the tempogram
   * directly is the other half of the vote, and it is the recommendation the
   * literature gives for octave errors — score the level, its half and its
   * double against the onset envelope, and keep the best fit.
   */
  function levelScore(lag) {
    const l = Math.round(lag);
    if (l < LAG_MIN || l > LAG_MAX) return 0;
    return Math.max(0, tg[l]) * (0.45 + 0.55 * gridQuality(l)) * levelPrior(l);
  }

  // How well the ODF folds onto a grid of period `p`: the share of its energy
  // landing in one window per cycle, with the share a window that size would
  // capture from noise subtracted, so the number means the same at every tempo.
  // A candidate at twice the true tempo keeps all the onsets but doubles the
  // number of windows it needs to hold them, and scores worse for it.
  function gridQuality(p) {
    const P = Math.max(2, Math.min(fold.length - 1, Math.round(p)));
    const n = workN;
    if (n < P * 3) return 0.3; // too few cycles in the window to judge
    fold.fill(0, 0, P);
    let total = 0;
    for (let i = 0; i < n; i++) {
      fold[i % P] += work[i];
      total += work[i];
    }
    if (total < 1e-6) return 0;
    const w = Math.max(SMOOTH_R, Math.round(P * 0.04));
    let best = 0;
    for (let k = 0; k < P; k++) {
      let s = 0;
      for (let j = -w; j <= w; j++) s += fold[(((k + j) % P) + P) % P];
      if (s > best) best = s;
    }
    const share = best / total;
    const baseline = Math.min(1, (2 * w + 1) / P);
    return Math.max(0, (share - baseline) / Math.max(1e-6, 1 - baseline));
  }

  // Fold an onset function at `p` slots and return how strong the half-period
  // position is relative to the strongest one. ~1 means it hits twice per
  // period; ~0 means it hits once.
  //
  // `full` picks which evidence is folded, and the two questions want different
  // witnesses. To go FASTER — "the beat is really half this" — only the bass
  // can answer: an offbeat hi-hat is not a beat and must not be allowed to
  // double the tempo. To go SLOWER — "nothing at all happens in between" — the
  // bass alone is not enough, because a half-time kick with the snare on the
  // backbeat leaves the bass empty there while the music very clearly is not.
  // Asking the full band for that one is what stops a 140 BPM track with a kick
  // every other beat from being reported at 70.
  function foldHalfRatio(p, full = false) {
    const P = Math.max(2, Math.min(fold.length - 1, Math.round(p)));
    const n = workN;
    const src = full ? work : workLow;
    fold.fill(0, 0, P);
    let total = 0;
    for (let i = 0; i < n; i++) {
      fold[i % P] += src[i];
      total += src[i];
    }
    if (total < 1e-5) return -1; // nothing to ask
    const w = Math.max(1, Math.round(0.03 * ODF_HZ));
    const around = (c) => {
      let s = 0;
      for (let j = -w; j <= w; j++) s += fold[(((c + j) % P) + P) % P];
      return s;
    };
    let p0 = 0;
    for (let k = 1; k < P; k++) if (fold[k] > fold[p0]) p0 = k;
    // The quietest window in the fold is the noise bed every other window also
    // carries, and it has to come out of both sides of the ratio. Eight seconds
    // of history is a dozen cycles, so the bed is a dozen frames of floor in
    // EVERY window — enough to read a hi-hat at a fifth of the kick as two
    // fifths of it, which is the difference between doubling the tempo and not.
    let floorW = Infinity;
    for (let k = 0; k < P; k++) {
      const s2 = around(k);
      if (s2 < floorW) floorW = s2;
    }
    const a = around(p0) - floorW;
    const b = around(p0 + Math.round(P / 2)) - floorW;
    return a > 1e-6 ? Math.max(0, b) / a : 0;
  }

  // Which way the bass thinks the metrical level should move, as a graded vote
  // in -1..+1: positive says the grid is running at twice the rate the kick is
  // (halve the tempo, double the lag), negative says the opposite.
  function octaveEvidence(lagF) {
    // TWO WITNESSES, and the second one has a veto.
    //
    // The fold asks a local question — is there anything at the halfway point,
    // in the bass or across the band — and it is fooled whenever one beat of
    // the bar is simply louder than the others, which in this music is most of
    // them. Measured on synthetic uptempo with rolls on the last beat of every
    // other bar, the fold voted steadily to HALVE a perfectly correct 240 BPM
    // grid, purely because the rolled beat outweighed the plain ones and so
    // became the fold's reference peak.
    //
    // The score asks a global one — does the music actually fit that level
    // better, on the same terms `estimate` judges every candidate by. It cannot
    // be fooled that way, because a level that catches every onset in one
    // window per cycle scores high however unevenly they are weighted.
    //
    // So the fold PROPOSES and the score DISPOSES: a fold vote toward a level
    // the score says is measurably worse is suppressed outright, while the
    // score can move the grid on its own. That asymmetry is deliberate — the
    // score is the objective the whole estimate is built on, and the fold is a
    // heuristic about where the bass lands.
    const here = levelScore(lagF);
    const rSlow = lagF * 2 <= LAG_MAX && here > 1e-9 ? levelScore(lagF * 2) / here : 0;
    const rFast = lagF / 2 >= LAG_MIN && here > 1e-9 ? levelScore(lagF / 2) / here : 0;
    let v = 0;
    if (lagF * 2 <= LAG_MAX) {
      const dbl = foldHalfRatio(lagF * 2, true);
      // Folding at twice this lag does NOT show two comparable peaks → nothing
      // at all happens halfway → the beat is the slower one.
      if (dbl >= 0) v += rampDown(dbl, 0.45, 0.22) * (1 - rampDown(rSlow, LEVEL_VETO, 0.25));
      v += rampUp(rSlow, LEVEL_EDGE, LEVEL_SPAN);
    }
    if (lagF / 2 >= LAG_MIN) {
      const half = foldHalfRatio(lagF);
      // Folding at this lag shows the bass hitting halfway through as hard as
      // on the beat → the beat is the faster one.
      if (half >= 0) v -= rampUp(half, 0.72, 0.22) * (1 - rampDown(rFast, LEVEL_VETO, 0.25));
      v -= rampUp(rFast, LEVEL_EDGE, LEVEL_SPAN);
    }
    return Math.max(-1, Math.min(1, v));
  }

  // Decide the metrical level from the bass (see the file header). The vote is
  // smoothed and has a dead band: inside it the grid stays on whatever level it
  // is already on, which is what stops a borderline reading from flipping the
  // tempo four times a second.
  //
  // The question is asked about the level THE GRID IS ON, not about whatever
  // the fresh autocorrelation happened to peak at — those are the same grid an
  // octave apart, and asking about the wrong one is how a tracker that locked
  // onto the eighth-note grid in its first three seconds used to stay there for
  // the rest of the track: every later estimate found the right lag and the
  // dead band quietly folded it back.
  /**
   * How strong the vote has to be to move the grid from one level to another.
   *
   * Symmetric thresholds are what let a locked, correct grid be talked out of
   * itself. Moving TOWARD the level a whole-track measurement named should be
   * easy; moving AWAY from it can be put beyond the vote's reach entirely —
   * the bar is allowed to exceed 1 and the vote is clamped to it, so no amount
   * of eight-second evidence can re-level a grid the server anchored.
   *
   * That is not the same as making the seed unfalsifiable. The vote saturating
   * against the bar is itself recorded (`seedDoubt` below), and a seed the
   * music has contradicted at full strength for twenty seconds is moved to the
   * level the music insists on — it stays an anchor, at the octave it should
   * have named. A published tempo that is half the real one, which is common
   * enough in this catalogue for exactly the genres this file exists for, is
   * therefore corrected, but by the track rather than by one window of it.
   */
  function octBar(from, to) {
    const g = levelPrior(to) / Math.max(1e-9, levelPrior(from));
    return Math.max(0.3, Math.min(2.5, OCT_ON * Math.pow(g, -0.35)));
  }

  function correctOctave(lagF) {
    const ref = locked ? period * ODF_HZ : lagF;
    octVote += (octaveEvidence(ref) - octVote) * OCT_SMOOTH;
    const cooled = clock - lastOctAt > OCT_COOLDOWN;
    let level = ref;
    let moved = false;
    if (cooled && octVote > octBar(ref, ref * 2) && ref * 2 <= LAG_MAX) {
      level = ref * 2;
      moved = true;
    } else if (cooled && octVote < -octBar(ref, ref / 2) && ref / 2 >= LAG_MIN) {
      level = ref / 2;
      moved = true;
    }
    if (moved) {
      lastOctAt = clock;
      octVote = 0;
    } else if (seedLag > 0) {
      // Held back by the bar rather than by the music: remember for how long,
      // and move the anchor if the music never lets up.
      const wantSlow = octVote > OCT_ON && ref * 2 <= LAG_MAX;
      const wantFast = octVote < -OCT_ON && ref / 2 >= LAG_MIN;
      if (wantSlow || wantFast) {
        seedDoubt += EST_EVERY;
        if (seedDoubt >= SEED_DOUBT) {
          seedLag = wantSlow ? seedLag * 2 : seedLag / 2;
          seedDoubt = 0;
          octVote = 0;
        }
      } else if (seedDoubt > 0) {
        seedDoubt = Math.max(0, seedDoubt - EST_EVERY * 2);
      }
    }
    if (!locked) return level;
    // Express the fresh estimate on the level we settled on, whenever it is an
    // octave of it — that keeps the sub-slot precision the interpolation just
    // won. A candidate that is neither the level nor an octave of it is a
    // different tempo, and the adoption rules decide what to do with it.
    const r = lagF / level;
    if (r > 1.88 && r < 2.12) return lagF / 2;
    if (r > 0.47 && r < 0.53) return lagF * 2;
    if (r > 0.94 && r < 1.06) return lagF;
    return moved ? level : lagF;
  }

  function estimate() {
    const n = filled;
    if (n < ODF_HZ * 3) return; // under 3 s of history: nothing to say yet
    fillWork();

    // A BREAKDOWN IS NOT A TEMPO CHANGE. With no drums in it the last seconds
    // carry no onsets, the autocorrelation is reading a pad and whatever noise
    // is left, and its answer is worth nothing — but it used to be adopted
    // anyway, which is where a 128 BPM track spent four bars at 64 and then at
    // 255. So when the recent history is far emptier than the window it sits
    // in, the grid coasts: the tempo the music had before the breakdown is a
    // much better guess than anything measurable during it.
    let recent = 0;
    const rN = Math.min(n, Math.round(ODF_HZ * 1.5));
    for (let i = n - rN; i < n; i++) recent += work[i];
    recent /= rN;
    let overall = 0;
    for (let i = 0; i < n; i++) overall += work[i];
    overall /= n;
    // Both ends of it. Going INTO the quiet part the last seconds are emptier
    // than the window; coming OUT of it the window itself is mostly quiet and
    // the correlation is being computed over six seconds of nothing and two of
    // music, which is just as worthless. `activity` is the density this track
    // runs at (up in a few seconds, down over half a minute), so the second
    // test knows what a full window is supposed to look like.
    if (locked && (recent < overall * 0.35 || overall < activity * 0.45)) {
      confidence *= 0.97;
      return;
    }

    // Mean-remove, so the autocorrelation measures periodicity rather than the
    // DC level (a loud passage would otherwise correlate with everything).
    let mean = 0;
    for (let i = 0; i < n; i++) mean += work[i];
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const d = work[i] - mean;
      dev[i] = d;
      energy += d * d;
    }
    if (energy < 1e-9) {
      confidence *= 0.7;
      return;
    }

    for (let lag = LAG_MIN; lag <= ACF_MAX; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += dev[i] * dev[i - lag];
      acf[lag] = s / energy;
    }

    // Harmonic summation, every candidate divided by the SAME weight (see the
    // file header): a harmonic that falls outside the computed range counts as
    // no support, not as one fewer thing to divide by. The result is folded
    // into the running tempogram rather than used on its own — the first few
    // estimates weigh heavily so a track still locks within a few seconds.
    const a = Math.max(TG_ALPHA, 1 / ++estCount);
    for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
      let s = acf[lag];
      for (let h = 2; h <= HARMONICS; h++) {
        const l = lag * h;
        if (l > ACF_MAX) break;
        s += acf[l] / h;
      }
      s /= HARM_W;
      tg[lag] += (s - tg[lag]) * a;
    }

    // Score every candidate, then shortlist the peaks and ask the music.
    let bestLag = 0;
    let bestScore = -1;
    for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
      const s = tg[lag] * weightFor(lag);
      cand[lag] = s;
      if (s > bestScore) {
        bestScore = s;
        bestLag = lag;
      }
    }
    if (!bestLag) return;

    // Local maxima, strongest first, and never two readings of the same peak.
    const list = [];
    for (let lag = LAG_MIN + 1; lag < LAG_MAX; lag++) {
      if (cand[lag] >= cand[lag - 1] && cand[lag] > cand[lag + 1]) list.push(lag);
    }
    list.sort((x, y) => cand[y] - cand[x]);
    const shortlist = [];
    for (const lag of list) {
      if (shortlist.length >= SHORTLIST) break;
      // Two separations, and the second one only matters at the top of the
      // range. A 6% log distance is four whole slots at 120 BPM and barely one
      // and a half at 240, so up there the shoulder of a peak was being
      // shortlisted as a rival to the peak itself — which does not change which
      // tempo wins, but does collapse the confidence margin, and confidence
      // falling under the floor is what UNLOCKS the grid. Measured on
      // synthetic uptempo it unlocked a correct, seeded 240 BPM grid after ten
      // seconds and re-locked it at a quarter of the tempo.
      if (shortlist.some((l) => Math.abs(Math.log(lag / l)) < BUMP_W || Math.abs(lag - l) < PEAK_SLOTS))
        continue;
      shortlist.push(lag);
    }
    if (!shortlist.length) shortlist.push(bestLag);

    // The fold is what separates a real beat grid from a lag that merely
    // correlates. Weighted rather than decisive: the autocorrelation is still
    // the measurement, this is how much the music agrees with it.
    let winner = shortlist[0];
    let winnerScore = -1;
    let runnerUp = -1;
    for (const lag of shortlist) {
      const s = cand[lag] * (0.45 + 0.55 * gridQuality(lag));
      if (s > winnerScore) {
        runnerUp = winnerScore;
        winnerScore = s;
        winner = lag;
      } else if (s > runnerUp) runnerUp = s;
    }

    // Parabolic interpolation around the winning lag: the grid is 10 ms, which
    // at 175 BPM is a whole BPM of quantisation — enough for the phase to drift
    // visibly across a bar. Interpolating recovers sub-slot precision.
    const y1 = tg[winner];
    const y0 = winner - 1 >= LAG_MIN ? tg[winner - 1] : y1;
    const y2 = winner + 1 <= LAG_MAX ? tg[winner + 1] : y1;
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    let lagF = winner + Math.max(-0.5, Math.min(0.5, shift));
    lagF = correctOctave(lagF);
    const newPeriod = lagF / ODF_HZ;

    // Confidence: how far the winner stands above the best candidate that is
    // NOT a reading of the same peak, scaled by the absolute correlation. Both
    // matter — a clear winner over a flat field is still meaningless if nothing
    // correlates at all. The raw tempogram value is used rather than the
    // weighted score, so a prior bonus can never inflate the reading.
    const margin = runnerUp > 0 ? Math.max(0, (winnerScore - runnerUp) / (winnerScore + 1e-6)) : 1;
    const conf = Math.max(0, Math.min(1, tg[winner] * 2.2)) * (0.35 + 0.65 * margin);
    confidence = confidence * 0.55 + conf * 0.45;
    // A WHOLE-TRACK MEASUREMENT IS A REASON TO STAY LOCKED. Confidence is read
    // from eight seconds of autocorrelation, and there is material whose
    // autocorrelation at its own beat is genuinely poor for eight seconds at a
    // time — rolls, a half-time passage, a bar of one held note. On such a
    // track a grid sitting exactly on the server's figure used to lose
    // confidence estimate by estimate until it fell through the floor,
    // UNLOCK, and re-lock somewhere else entirely, with the winner having been
    // correct on every single estimate along the way. So while the grid agrees
    // with the seed, the seed floors the confidence: nothing about the music
    // has contradicted it, and the tracker is not entitled to forget a better
    // measurement than the one it can make.
    if (seedLag > 0 && Math.abs(Math.log(period * ODF_HZ / seedLag)) < BUMP_W)
      confidence = Math.max(confidence, SEED_FLOOR);

    // Adopt a new tempo carefully. A small change is a refinement of the same
    // pulse and is eased in; an octave is the same grid at another metrical
    // level and is taken outright, keeping the phase; anything else is a
    // DIFFERENT tempo and has to win several estimates in a row before it
    // re-times the animation, because music changes tempo far less often than
    // an eight-second window changes its mind.
    const ratio = newPeriod / period;
    if (!locked) {
      if (confidence > 0.25) {
        period = newPeriod;
        locked = true;
        challenger = 0;
        challengeCount = 0;
        phaseFromFold();
      }
    } else if (ratio > 0.94 && ratio < 1.06) {
      period = period * 0.75 + newPeriod * 0.25;
      challenger = 0;
      challengeCount = 0;
    } else if (Math.abs(Math.abs(Math.log2(ratio)) - 1) < 0.08) {
      // Exactly half or exactly double — ONE octave, not any power of two: the
      // same beats, counted differently. Take it without resetting the phase,
      // since the grid does not move, only its name. Anything further than an
      // octave away is a different tempo and goes through the challenger below,
      // however tidy the ratio looks.
      period = newPeriod;
      challenger = 0;
      challengeCount = 0;
    } else if (challenger && Math.abs(Math.log(lagF / challenger)) < BUMP_W) {
      challengeCount++;
      if (challengeCount >= CHALLENGE_NEEDED && confidence > 0.42) {
        period = newPeriod;
        challenger = 0;
        challengeCount = 0;
        phaseFromFold();
      }
    } else {
      challenger = lagF;
      challengeCount = 1;
    }
    bpm = 60 / period;
    if (confidence < 0.12) locked = false;
    if (locked) auditPhase();
    measureKickPulse();
  }

  /**
   * IS THE GRID ON THE RIGHT HALF OF THE BEAT?
   *
   * The PLL owns the phase between tempo estimates, and it is pulled by any
   * onset it believes — so on material with a loud offbeat it can settle a half
   * beat out and STAY there, because `phaseFromFold` only ever ran when the
   * tempo itself moved. Measured on real audio, techno with an ordinary offbeat
   * hi-hat locked the right tempo with its kicks landing at phase 0.45, and a
   * trap track at 0.60: every animation firing on the beat was firing on the
   * offbeat, for the whole track, with the readout saying the tempo was right.
   *
   * So the fold — which weighs the BASS heavily, and the bass is where the beat
   * is in every genre this player is pointed at — audits the PLL rather than
   * merely initialising it. A disagreement has to persist: three consecutive
   * estimates is most of a bar, long enough that one syncopated phrase cannot
   * move the grid and short enough that nobody watches a whole track off-beat.
   */
  function auditPhase() {
    const want = phaseFromFold(false);
    if (want < 0) return;
    let err = (phase % 1) - want;
    if (err > 0.5) err -= 1;
    if (err < -0.5) err += 1;
    if (Math.abs(err) < PHASE_TOL) {
      phaseDoubt = 0;
      return;
    }
    if (++phaseDoubt >= PHASE_DOUBT) {
      phaseDoubt = 0;
      // Move the grid, not the beat counter: the downbeat is scored separately
      // and re-finds itself from the bass within a bar.
      phase = want;
    }
  }

  // Fold the ODF over the current period and take the offset carrying the most
  // energy as the beat. Runs only when the tempo itself moved — between those
  // moments the PLL owns the phase.
  /**
   * Where the beat is, from folding the onset function over the current period.
   *
   * `apply` false MEASURES it without moving the grid, which is what lets the
   * phase be audited every estimate instead of only when the tempo changes.
   */
  function phaseFromFold(apply = true) {
    const n = workN;
    if (!n) return -1;
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
    const want = ((posNow - bestK + P) % P) / P;
    if (apply) phase = want;
    return want;
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
   * @param {number} flux      SuperFlux full-band onset function, ungated
   * @param {number} lowFlux   kick evidence: sub+bass flux with the
   *                           magnitude-domain kick transient mixed in. See
   *                           features.js — the flux alone goes blind on a
   *                           track whose low end never stops (an 808 under
   *                           rap), which is the case the mix fixes.
   * @param {number} dt        seconds since the previous frame
   */
  function process(flux, lowFlux, dt) {
    out.beat = false;
    out.downbeat = false;
    out.onset = 0;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 0.25); // a stalled tab must not teleport the phase
    clock += dt;

    // --- condition the onset function ---------------------------------------
    // Local mean out, then compressed against the track's own onset scale. See
    // the file header: this is what makes a riser stop being a beat and an FX
    // explosion stop being twenty of them.
    // THE LOCAL MEAN'S WINDOW HAS TO BE LONGER THAN A BEAT, and a fixed 120 ms
    // is not, once the music goes past about 200 BPM. At 240 BPM the beat is
    // 250 ms, so a mean with a 120 ms time constant tracks the beat itself and
    // subtracts most of it: measured on synthetic uptempo, the running
    // tempogram at the TRUE lag fell from 0.364 to 0.084 as the estimators
    // converged, the confidence fell with it, and the grid unlocked after ten
    // seconds and re-locked a quarter of the tempo away. The reading was right
    // the whole time and the tracker threw it away for lack of confidence.
    //
    // So it scales with the grid: a window over a beat long cannot follow the
    // beat, and at any tempo it is still far shorter than the risers, sweeps
    // and reverb washes it exists to remove, which last seconds.
    const meanTau = Math.max(MEAN_TAU, MEAN_BEATS * period);
    const aMean = 1 - Math.exp(-dt / meanTau);
    const aScale = 1 - Math.exp(-dt / SCALE_TAU);
    fluxMean += (flux - fluxMean) * aMean;
    lowMean += (lowFlux - lowMean) * aMean;
    const dFlux = flux > fluxMean ? flux - fluxMean : 0;
    const dLow = lowFlux > lowMean ? lowFlux - lowMean : 0;
    fluxScale += (dFlux - fluxScale) * aScale;
    lowScale += (dLow - lowScale) * aScale;
    const cFlux = Math.min(SCALE_CLIP, dFlux / (fluxScale + 1e-9)) / SCALE_CLIP;
    const cLow = Math.min(SCALE_CLIP, dLow / (lowScale + 1e-9)) / SCALE_CLIP;
    // The grid the autocorrelation runs on leans on the BASS. Every genre this
    // player is pointed at puts its beat there, and the treble is where the
    // effects, the reverb tails and the offbeat hats live — which is exactly
    // the material that used to move the reading.
    const cMix = Math.min(1, cFlux + cLow * 0.8);
    activity += (cMix - activity) * (1 - Math.exp(-dt / (cMix > activity ? 3 : 30)));

    // --- resample onto the fixed grid ---------------------------------------
    slotAcc = Math.max(slotAcc, cMix);
    slotLowAcc = Math.max(slotLowAcc, cLow);
    slotTime += dt;
    const slot = 1 / ODF_HZ;
    while (slotTime >= slot) {
      push(slotAcc, slotLowAcc);
      slotTime -= slot;
      // Carry the peak into the next slot only if the frame straddled it; a
      // fresh slot otherwise starts empty so a long frame cannot smear one
      // onset across three grid points.
      slotAcc = slotTime > 0 ? cMix : 0;
      slotLowAcc = slotTime > 0 ? cLow : 0;
    }

    // --- raw onset stream (used even with no stable tempo) ------------------
    const d = cFlux - odfMean;
    odfMean += d * 0.02;
    odfVar += (d * d - odfVar) * 0.02;
    const sd = Math.sqrt(Math.max(odfVar, 1e-12));
    const thresh = odfMean + sd * 1.6;
    if (cFlux > thresh && clock - lastOnsetAt > 0.055) {
      lastOnsetAt = clock;
      out.onset = Math.max(0, Math.min(1, (cFlux - thresh) / (sd * 3 + 1e-9)));
    }
    beatEnergy += cLow;

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
   * job.
   *
   * It also stays in play afterwards, as a PRIOR on every later estimate (see
   * `weightFor`): a figure measured over the whole piece beats anything an
   * eight-second window can say, so a moment of ambiguity resolves back to it
   * instead of wandering off. It is a bonus, not a veto — sustained, confident
   * evidence to the contrary still wins, so a wrong figure is corrected rather
   * than obeyed for ever.
   */
  /**
   * Hand the tracker a tempo somebody measured over the WHOLE track.
   *
   * This may be called at any time, including in the middle of a locked grid,
   * and that is a deliberate change from how it used to work. The engine only
   * seeded an unlocked tracker, on the reasoning that re-seeding a locked grid
   * would make the animation jump for no accuracy gain. Both halves of that
   * were wrong. The verdict arrives over the network, behind the audio in the
   * request ladder, so by the time it lands the grid has been locked for
   * seconds — on three seconds of whatever the intro happened to be. And the
   * gain is not small: measured on synthetic uptempo with the kick moving onto
   * the offbeat, seeding at t=0 gave 220 BPM and seeding at t=4 s gave 110, for
   * the whole track, because the seed was simply discarded. "It tries to
   * overwrite the tempo the server sent it with nothing" is this line.
   *
   * What it does depends on where the grid already is:
   *   - within 6% of the seed → nothing to move, just record the anchor;
   *   - within 6% of an OCTAVE of it → the same grid counted differently, so
   *     the level moves and the PHASE IS KEPT (the beats do not shift, only
   *     their name), which is why this cannot make the animation jump;
   *   - anywhere else → the seed becomes a standing prior and the ordinary
   *     adoption rules decide, so a wrong figure is still beatable.
   */
  function seed(seedBpm, seedConfidence = 0.9) {
    const b = +seedBpm;
    if (!Number.isFinite(b) || b < MIN_BPM || b > MAX_BPM) return false;
    const conf = Math.min(1, +seedConfidence || 0.9);
    seedLag = bpmToLag(b);
    seedDoubt = 0;
    if (locked) {
      const near = Math.abs(Math.log2((60 / b) / period));
      // On the seed, or one or two octaves off it: the same grid counted
      // differently, so take the seed's level. (Two, because a grid that ended
      // up on the BAR rather than the beat is exactly as recoverable as one on
      // the half-beat, and just as common on material with rolls in it.)
      // Further than that and the seed is only a prior — it has already been
      // recorded above, and `weightFor`, `levelPrior` and the octave vote all
      // read it from there.
      if (near < 0.09 || Math.abs(near - 1) < 0.09 || Math.abs(near - 2) < 0.09) {
        period = 60 / b;
        bpm = b;
        confidence = Math.max(confidence, conf);
        challenger = 0;
        challengeCount = 0;
        // Moving the LEVEL does not move the beats, so the phase stays as it
        // is; re-folding here would throw away a lock the PLL has been holding.
        out.bpm = bpm;
        out.confidence = confidence;
        out.period = period;
      }
      return true;
    }
    period = 60 / b;
    bpm = b;
    confidence = Math.max(confidence, conf);
    locked = true;
    challenger = 0;
    challengeCount = 0;
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

  /**
   * Tell the tracker what kind of record this is, as the tempo range the genre
   * is written in. Everything in this file that has to choose between a tempo
   * and half of it consults it.
   *
   * This is the ONE thing another module gets to move, and it is here because
   * the octave question is not answerable from the signal alone — a 250 BPM
   * uptempo track and a 125 BPM house track produce the same autocorrelation,
   * and which one it is depends on which record is playing. The engine knows
   * that (the server measured the track, or the live classifier named a
   * family), so it can say. Published work on tempo octave errors in
   * electronic music reaches the same place: feed the style estimate back into
   * the tempo prior.
   *
   * Called with nothing, it restores the default plateau. It never moves the
   * grid on its own — it changes what the NEXT estimate finds plausible, so a
   * genre arriving mid-track cannot make the animation jump.
   */
  function setTempoRange(lo, hi) {
    const a = +lo;
    const b = +hi;
    if (!(a > 0) || !(b > a)) {
      priorLo = DEFAULT_PRIOR_LO;
      priorHi = DEFAULT_PRIOR_HI;
      return;
    }
    priorLo = Math.max(MIN_BPM, Math.min(a, MAX_BPM));
    priorHi = Math.max(priorLo + 1, Math.min(b, MAX_BPM));
  }

  function reset() {
    odf.fill(0);
    odfLow.fill(0);
    tg.fill(0);
    head = 0;
    filled = 0;
    slotAcc = slotLowAcc = slotTime = 0;
    fluxMean = lowMean = fluxScale = lowScale = 0;
    activity = 0;
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
    estCount = 0;
    octVote = 0;
    lastOctAt = -1e9;
    challenger = 0;
    challengeCount = 0;
    phaseDoubt = 0;
    seedLag = 0;
    seedDoubt = 0;
    // The range is NOT reset: it describes the track about to play, and the
    // engine sets it at the track change, which may be before or after this.
    barScore4.fill(0);
    barScore3.fill(0);
    beatEnergy = 0;
    odfMean = 0;
    odfVar = 0;
    sinceBeat = 0;
  }

  /**
   * Whether the grid is currently saying something. The engine uses this to
   * decide whether a served tempo is worth seeding: before a lock there is
   * nothing to disturb, after one the live figure is already a measurement of
   * the same thing and re-seeding would only make the animation jump.
   */
  function isLocked() {
    return locked;
  }

  return { process, reset, seed, setTempoRange, isLocked, out };
}

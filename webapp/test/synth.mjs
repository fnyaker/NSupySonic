// REAL AUDIO, REAL FFT. A test bench for the analysis chain that starts from
// samples instead of from a picture of a spectrum.
//
// WHY THIS REPLACED THE PREVIOUS GENERATOR. That one drew spectra by hand: it
// placed a bin per harmonic at a level I had chosen (`-8.5 * log10(h)`, a
// number with no source but me), summed them, and handed the result to
// features.js. Everything about it was a theory of what a kick looks like, and
// a detector tuned against it is tuned against my theory. Worse, it could not
// contain the things that actually break detectors, because those things are
// not in a list of harmonics:
//
//   SPECTRAL LEAKAGE. A real analyser windows 2048 samples and every partial
//   smears across its neighbours. A hand-placed bin does not, so every partial
//   was artificially isolated and every measurement artificially clean.
//   PHASE. Two sounds at the same frequency add or cancel depending on where
//   they are in their cycle. Drawn as bins they always add. A kick landing on
//   top of the previous one's tail is exactly that case, and it is the case
//   this whole analyser exists to get right.
//   REAL HARMONICS. A hardcore kick is a sine driven into a distortion chain.
//   Synthesise it that way and the harmonic series is whatever tanh actually
//   produces — including the intermodulation between the body and the tail,
//   which no hand-written rolloff has.
//
// So: oscillators at 48 kHz, a real waveshaper, a real sample-domain limiter
// with lookahead, and a Hann-windowed 2048-point FFT at the analyser's own hop,
// scaled the way `AnalyserNode.getFloatFrequencyData` scales it. What comes out
// is the same kind of array the browser hands the engine, produced the same way.
//
// MAINTAINING THIS: every sound here is built the way a producer builds it, and
// the comments say which production step each line is. If a case fails, the
// first question is whether the material is something anyone would actually
// make — and the second is whether the analyser is wrong. It is not allowed to
// be a third thing: making the material easier until it passes.

export const SR = 48000;
export const FFT_SIZE = 2048; // matches graph.js's fast analyser
export const BINS = FFT_SIZE / 2;
export const FLOOR = -96;
// The engine's analysis tick: an AudioWorklet posting every 4 render quanta at
// 48 kHz, which is 128*4/48000 ≈ 10.67 ms.
export const DT = 512 / SR;

// ---------------------------------------------------------------------------
// FFT — iterative radix-2, in place. Fifty lines, no dependency, and the whole
// point of the file is that the spectrum is computed rather than asserted.
// ---------------------------------------------------------------------------
const REV = new Uint16Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  let r = 0;
  for (let b = 0, n = Math.log2(FFT_SIZE); b < n; b++) r |= ((i >> b) & 1) << (n - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(FFT_SIZE / 2);
const SIN = new Float64Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
  COS[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
  SIN[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
}
// The Hann window the Web Audio analyser applies before its transform.
const WINDOW = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

function fft(re, im) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= FFT_SIZE; len <<= 1) {
    const half = len >> 1;
    const step = FFT_SIZE / len;
    for (let i = 0; i < FFT_SIZE; i += len) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step];
        const s = SIN[k * step];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * PCM → the dB spectra the engine sees, one per analysis tick.
 *
 * Scaled as `AnalyserNode.getFloatFrequencyData` scales it: the magnitude is
 * divided by fftSize before the log, which is why a full-scale sine reads
 * around -6 dB rather than 0 and why the floor here is the -96 the engine uses.
 */
export function analyse(pcm, until = Infinity) {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const hop = Math.round(DT * SR);
  const out = [];
  // WHEN a frame happens, which is not when its window starts. `getFloatFrequency
  // Data` hands back the last `fftSize` samples, so a frame read at time T
  // contains audio from T-42.7 ms to T: its timestamp is the window's END. Label
  // it at the start instead and every event in the bench appears 21 ms early,
  // which is how a detector firing exactly on time came out at "-26 ms" and how
  // a bench can quietly invent latency that is not there.
  out.at = (i) => (i * hop + FFT_SIZE) / SR;
  // AND WHERE IT STOPS. A render carries an extra window of room past the music
  // so the LAST frame has real audio behind it — not so that four more frames
  // can be made out of the silence after it. A window straddling the end of the
  // buffer is a step function, and the FFT of a step is broadband splatter
  // weighted to the bottom: measured, a held pad that simply stopped produced a
  // 20 dB jump at 60-120 Hz in the frame that caught the edge, and the kick
  // detector convicted it — correctly, since acoustically that is a thump. No
  // master ends on a discontinuity, and no browser ever sees one.
  const last = until * SR - FFT_SIZE;
  for (let start = 0; start + FFT_SIZE <= pcm.length && start <= last; start += hop) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = pcm[start + i] * WINDOW[i];
      im[i] = 0;
    }
    fft(re, im);
    const spec = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / FFT_SIZE;
      spec[k] = mag > 1e-9 ? Math.max(FLOOR, 20 * Math.log10(mag)) : FLOOR;
    }
    out.push(spec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources. Every one of these writes SAMPLES, and every one is the production
// recipe for the sound it is named after.
// ---------------------------------------------------------------------------

let rndState = 1;
const rnd = () => ((rndState = (rndState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const noise = () => rnd() * 2 - 1;

/** tanh, which is what every "drive" control in every hard-genre chain is. */
const shape = (x, drive) => Math.tanh(x * drive) / Math.tanh(drive);
/** ...and the clipper after it, which is what makes the top flat. */
const clip = (x, ceil) => (x > ceil ? ceil : x < -ceil ? -ceil : x);

/**
 * A HARD-GENRE KICK, built the way one is built.
 *
 * "Kicks begin with a sustained synthesizer waveform, like a sine, pitched down
 * 2-3 octaves… distortion is applied with maximum pre-gain": a sine whose pitch
 * sweeps from f0 down to f1, driven into a waveshaper until the harmonics reach
 * the top of the spectrum, with a short noise transient on top for the beater.
 *
 * `saw` adds the zaag character — "the attack is made with a sawtooth synth,
 * imitating a metallic, mechanical saw", with a tail that keeps moving in pitch
 * and is a tonal sound in its own right.
 */
function renderKick(buf, at, o) {
  const {
    f0 = 190, f1 = 44, sweepMs = 90, lenMs = 300,
    drive = 14, gain = 0.7, click = 0.45, saw = 0, sawDrive = 8,
    sub = 0.2, subMs = 0,
  } = o;
  const start = Math.round(at * SR);
  const n = Math.round((lenMs / 1000) * SR);
  const sweep = (sweepMs / 1000) * SR;
  let phase = 0;
  let sawPhase = 0;
  for (let i = 0; i < n; i++) {
    const j = start + i;
    if (j < 0 || j >= buf.length) continue;
    const t = i / n;
    // The pitch envelope, exponential — a linear one does not sound like a
    // drum and does not produce the same spectrum on the way down.
    const f = f0 * Math.pow(f1 / f0, Math.min(1, i / sweep));
    phase += (2 * Math.PI * f) / SR;
    // The amplitude envelope. Hardcore kicks barely decay; the clipper flattens
    // the top and what is left is nearly a square wave for most of its length.
    const env = Math.pow(1 - t, 0.55);
    let x = shape(Math.sin(phase), drive) * env;
    if (saw > 0) {
      // The zaag tail: a sawtooth whose pitch falls on its own curve, driven
      // separately, so it beats against the body instead of tracking it.
      const sf = f1 * Math.pow(3.2, 1 - t);
      sawPhase += sf / SR;
      if (sawPhase >= 1) sawPhase -= 1;
      x += shape(2 * sawPhase - 1, sawDrive) * saw * env * 0.6;
    }
    // The beater: a burst of high-passed noise, eight milliseconds of it.
    if (click > 0 && i < SR * 0.008) {
      const k = 1 - i / (SR * 0.008);
      x += noise() * click * k * k;
    }
    buf[j] += clip(x, 1) * gain;
  }
  // THE SUB LAYER, WHICH OUTLASTS THE PUNCH — and the element whose absence
  // made this bench lie about what an empty bar looks like.
  //
  // A hard-genre kick is built in layers: a punch, a body, and a low sine that
  // rings on underneath. It is the layer producers are warned about ("at faster
  // tempos kick tails must remain rhythmically precise, as excessively long
  // sounds overlap and create uncontrolled low-frequency buildup") — the
  // buildup only exists because the layer does.
  //
  // Without it the 28-420 Hz region fell to the analyser's own -96 dB floor
  // between hits, and then ANY arriving sound — a 700 Hz lead with a mix
  // high-pass on it — made a 38 dB step out of digital silence down there. A
  // 38 dB step at the bottom of the spectrum is a kick by any honest reading,
  // so the detector was right and the material was impossible. Real music never
  // offers that step, because the bottom of a real mix is never empty.
  const sn = Math.round(((subMs || lenMs * 2.4) / 1000) * SR);
  let sp = 0;
  for (let i = 0; i < sn; i++) {
    const j = start + i;
    if (j < 0 || j >= buf.length) continue;
    sp += (2 * Math.PI * f1) / SR;
    buf[j] += Math.sin(sp) * gain * sub * Math.pow(10, (-2.5 * i) / sn);
  }
}

/**
 * A SCREECH / HOOVER. Three detuned saws through a moving low-pass and a
 * distortion — the standard hard-dance lead, and the thing most likely to be
 * mistaken for a kick because it is loud, percussive and full of harmonics.
 */
function renderScreech(
  buf,
  at,
  { f = 320, lenMs = 90, gain = 0.5, drive = 6, bend = 1.6, hpHz = 150, hpPoles = 4 } = {},
) {
  const start = Math.round(at * SR);
  const n = Math.round((lenMs / 1000) * SR);
  const ph = [0, 0, 0];
  const det = [0.994, 1, 1.007];
  let lp = 0;
  // THE MIX LOW-CUT, AND ITS ORDER, WHICH IS THE PART THAT ACTUALLY MATTERS.
  //
  // What puts a lead in the kick's register is not its fundamental — a 700 Hz
  // saw has nothing below 700 — it is the FILTER TRANSIENT. The hoover's
  // low-pass opens across the stab, so at the attack it is nearly shut, and a
  // filter driven from rest by a loud saw answers with a broadband thump.
  // Measured here at the attack, with a single-pole cut: 28-60 Hz at -60.7 dB
  // against the lead's own band at -43.8, i.e. seventeen decibels under a sound
  // that has no bottom end at all. That thump is a kick by every measure a
  // detector has, and the detector was quite right to say so.
  //
  // Nobody ships that. Every hard-dance lead is low-cut precisely to leave the
  // bottom to the kick, and a low-cut is not a tilt: twelve decibels an octave
  // is the stock default in every DAW and twenty-four is what this genre
  // actually uses. At four poles the same transient reads -85.9 dB — twenty-
  // five decibels lower — while 250-420 Hz, which sits ABOVE the corner, moves
  // by three. That residue is a real lead in the kick's region and is left
  // exactly where it is: it is the limit this detector genuinely has, and the
  // bench states it rather than filtering it away.
  const hpA = Math.exp((-2 * Math.PI * hpHz) / SR);
  const poles = hpPoles;
  const hpS = new Float64Array(poles);
  const hpP = new Float64Array(poles);
  for (let i = 0; i < n; i++) {
    const j = start + i;
    if (j < 0 || j >= buf.length) continue;
    const t = i / n;
    const freq = f * (1 + t * (bend - 1));
    let x = 0;
    for (let k = 0; k < 3; k++) {
      ph[k] += (freq * det[k]) / SR;
      if (ph[k] >= 1) ph[k] -= 1;
      x += 2 * ph[k] - 1;
    }
    x = shape(x / 3, drive);
    // A one-pole low-pass that opens across the stab: the filter sweep is what
    // makes a hoover a hoover.
    const a = 0.02 + t * 0.5;
    lp += (x - lp) * a;
    let y = lp;
    for (let k = 0; k < poles; k++) { hpS[k] = hpA * (hpS[k] + y - hpP[k]); hpP[k] = y; y = hpS[k]; }
    buf[j] += clip(y, 1) * gain * Math.pow(1 - t, 0.6);
  }
}

/**
 * A REVERSE BASS. Hardstyle's offbeat: not a gated note but a CONTINUOUS one
 * that the kick ducks and that swells back between kicks. "The kick lands on
 * every downbeat, the sub-bass plays on the offbeats in between, and the two
 * are sidechained so they never overlap."
 *
 * Rendered across the whole track, because that is what it is — the thing that
 * must never read as a kick is precisely a sound that never arrives.
 */
function renderReverseBass(buf, ducks, { f = 70, gain = 0.5, riseMs = 130 } = {}) {
  if (!ducks.length) return;
  const rise = (riseMs / 1000) * SR;
  let phase = 0;
  let di = 0;
  let next = Math.round(ducks[0] * SR);
  let since = rise; // fully open before the first kick
  for (let j = 0; j < buf.length; j++) {
    if (j >= next) {
      since = 0;
      di++;
      next = di < ducks.length ? Math.round(ducks[di] * SR) : Infinity;
    }
    phase += (2 * Math.PI * f) / SR;
    // The sidechain envelope: slammed shut, opening over `riseMs`.
    const env = Math.min(1, since / rise);
    buf[j] += Math.sin(phase) * gain * env * env;
    since++;
  }
}

/**
 * A closed hi-hat: noise with a very short decay, high-passed STEEPLY.
 *
 * The steepness is the whole point. A hat is a metal disc and has essentially
 * nothing below a couple of hundred hertz — and a kick detector's hardest job
 * is not being fooled by one, so a hat with low end in it is not a harder test,
 * it is a different instrument. With a single pole (six decibels an octave,
 * sixteen down at 100 Hz from a corner at 600) this "hat" put real energy in
 * the kick's own region, which is a cymbal nobody has ever recorded. Four poles
 * is twenty-four an octave, which is what a hat looks like on an analyser.
 *
 * Making it a real hat did NOT stop it being convicted — it read 1.96
 * detections per kick either way, because the detector was reading the
 * CENTROID of an empty region rather than anything the hat put there. That is
 * the point of fixing the instrument first: it turned a mystery into a stated
 * fault in features.js, which is where the fix belongs.
 */
function renderHat(buf, at, { lenMs = 35, gain = 0.12, poles = 4 } = {}) {
  const start = Math.round(at * SR);
  const n = Math.round((lenMs / 1000) * SR);
  const hp = new Float64Array(poles);
  const prev = new Float64Array(poles);
  for (let i = 0; i < n; i++) {
    const j = start + i;
    if (j < 0 || j >= buf.length) continue;
    let x = noise();
    for (let k = 0; k < poles; k++) {
      const y = 0.92 * (hp[k] + x - prev[k]);
      prev[k] = x;
      hp[k] = y;
      x = y;
    }
    buf[j] += x * gain * Math.pow(1 - i / n, 2);
  }
}

/** A held pad / lead: detuned saws, low-passed. */
function renderPad(buf, from, to, { f = 233, gain = 0.1, hpHz = 120 } = {}) {
  const ph = [0, 0, 0];
  const det = [0.996, 1, 1.005];
  let lp = 0;
  const hpA = Math.exp((-2 * Math.PI * hpHz) / SR);
  let hpS = 0;
  let hpP = 0;
  for (let j = from; j < to && j < buf.length; j++) {
    if (j < 0) continue;
    let x = 0;
    for (let k = 0; k < 3; k++) {
      ph[k] += (f * det[k]) / SR;
      if (ph[k] >= 1) ph[k] -= 1;
      x += 2 * ph[k] - 1;
    }
    lp += (x / 3 - lp) * 0.08;
    hpS = hpA * (hpS + lp - hpP);
    hpP = lp;
    buf[j] += hpS * gain;
  }
}

/**
 * A MASTERING LIMITER, in the sample domain, with lookahead.
 *
 * These records are flat to the ceiling and that is not a detail: it is why the
 * loudest moment in the music can read as a level DROP in every band at once,
 * and it is the single hardest thing the kick detector has to survive. A
 * limiter that is not real does not produce that, and a bench without it is
 * testing the analyser on music nobody masters.
 */
function limit(buf, { ceil = 0.95, lookaheadMs = 2, releaseMs = 140 } = {}) {
  const look = Math.round((lookaheadMs / 1000) * SR);
  const rel = Math.exp(-1 / ((releaseMs / 1000) * SR));
  const out = new Float32Array(buf.length);
  let gain = 1;
  for (let i = 0; i < buf.length; i++) {
    // The peak inside the lookahead window decides the gain NOW, which is what
    // lets a limiter catch a transient instead of clipping it.
    let peak = 0;
    for (let k = 0; k < look; k += 8) {
      const v = Math.abs(buf[Math.min(buf.length - 1, i + k)]);
      if (v > peak) peak = v;
    }
    const want = peak > ceil ? ceil / peak : 1;
    gain = want < gain ? want : want + (gain - want) * rel;
    out[i] = buf[Math.max(0, i - look)] * gain;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/**
 * The kick designs, as parameters of the synthesis above rather than as a
 * drawing of a spectrum. Every figure is from how the genre is actually made:
 * frenchcore's 180-210 BPM kick on every quarter note, uptempo's longer and
 * more distorted one, zaag's sawtooth tail, hardtekk's short saturated stomp.
 */
export const KICKS = {
  techno: { f0: 110, f1: 48, sweepMs: 25, lenMs: 170, drive: 3, click: 0.18, gain: 0.62 },
  hardtekk: { f0: 170, f1: 46, sweepMs: 45, lenMs: 175, drive: 9, click: 0.3, gain: 0.7 },
  hardstyle: { f0: 150, f1: 44, sweepMs: 40, lenMs: 200, drive: 8, click: 0.3, gain: 0.7 },
  gabber: { f0: 200, f1: 52, sweepMs: 60, lenMs: 260, drive: 16, click: 0.4, gain: 0.75 },
  frenchcore: { f0: 190, f1: 44, sweepMs: 95, lenMs: 300, drive: 20, click: 0.45, gain: 0.78 },
  uptempo: { f0: 240, f1: 50, sweepMs: 55, lenMs: 260, drive: 22, click: 0.5, gain: 0.8, saw: 0.5 },
  zaag: { f0: 180, f1: 40, sweepMs: 55, lenMs: 320, drive: 14, click: 0.35, gain: 0.72, saw: 0.9, sawDrive: 12 },
  speedcore: { f0: 260, f1: 55, sweepMs: 35, lenMs: 190, drive: 26, click: 0.55, gain: 0.8 },
  // A rap 808: a long sine with almost no drive and no beater worth the name.
  trap: { f0: 62, f1: 46, sweepMs: 25, lenMs: 520, drive: 1.2, click: 0.06, gain: 0.55 },
};

/** The patterns these genres are written in. */
export const PATTERNS = {
  four: () => [0],
  // "kick kick kick, tac-tac-tac": a triplet roll closing the phrase.
  tripletRoll: (bt) => (bt % 16 === 15 ? [0, 1 / 3, 2 / 3] : [0]),
  // Uptempo: rolls of several lengths, all over.
  uptempo: (bt) => {
    const p = bt % 8;
    if (p === 3) return [0, 0.5];
    if (p === 7) return [0, 1 / 3, 2 / 3];
    return [0];
  },
  // The last bar of every four, in sixteenths.
  heavyRoll: (bt) => (bt % 16 >= 12 ? [0, 0.25, 0.5, 0.75] : [0]),
  // A beat deliberately left empty — completely ordinary in frenchcore.
  skipFourth: (bt) => (bt % 4 === 3 ? [] : [0]),
  // The kick moving onto the offbeat every other beat.
  offKick: (bt) => (bt % 2 ? [0.5] : [0]),
};

/**
 * Render a track to PCM, then to the spectra the engine sees.
 *
 *   kickAt(beat, bar)     offsets within the beat carrying a kick, in beats
 *   screechAt / rbassAt   the lead and the reverse bass, same shape
 *   jitterMs / ampJitter  a person and a groove, not a metronome
 *   intro / breakAt       an arrangement
 */
export function renderTrack({
  bpm,
  seconds = 30,
  kickOpt = {},
  kickAt = PATTERNS.four,
  screechAt = null,
  screechOpt = {},
  rbass = null,
  padGain = 0,
  hats = 0,
  swing = 0,
  jitterMs = 0,
  ampJitter = 0,
  intro = 0,
  breakAt = null,
  noiseFloor = 1e-4,
  ceil = 0.95,
} = {}) {
  rndState = 1;
  const period = 60 / bpm;
  const buf = new Float32Array(Math.round(seconds * SR) + FFT_SIZE);
  const kicks = [];
  const nB = Math.ceil(seconds / period) + 1;

  for (let bt = 0; bt < nB; bt++) {
    const t0 = bt * period;
    const bar = Math.floor(bt / 4);
    const quiet = breakAt && t0 >= breakAt[0] && t0 < breakAt[1];
    if (t0 >= intro && !quiet) {
      const offs = kickAt(bt, bar);
      // No kick outlasts its own slot: "at faster tempos, kick tails must
      // remain rhythmically precise, as excessively long sounds can overlap and
      // create uncontrolled low-frequency buildup". A roll's notes are
      // shortened to fit their subdivision, and so is a plain kick at 250 BPM.
      const sub = period * (offs.length > 1 ? offs[1] - offs[0] : 1);
      const len = Math.min(kickOpt.lenMs ?? 300, sub * 1000 * 0.92);
      for (const off of offs) {
        const at = t0 + off * period + (rnd() - 0.5) * 2 * jitterMs * 0.001;
        kicks.push(at);
        const g = (kickOpt.gain ?? 0.7) * (1 - rnd() * ampJitter);
        renderKick(buf, at, {
          ...kickOpt,
          lenMs: len,
          sweepMs: Math.min(kickOpt.sweepMs ?? 90, len * 0.4),
          gain: g,
        });
      }
    }
    if (screechAt && !quiet)
      for (const off of screechAt(bt, bar))
        renderScreech(buf, t0 + off * period, screechOpt);
    if (hats > 0 && !quiet) {
      const at = t0 + period * (0.5 + swing * 0.5);
      renderHat(buf, at, { gain: 0.12 * hats });
    }
  }

  if (rbass) renderReverseBass(buf, kicks, rbass);
  if (padGain > 0) {
    const notes = [233, 277, 311, 208];
    // ...out to the END OF THE BUFFER, not the end of `seconds`. Every other
    // source here already overruns (a kick's tail, a bar's last hat), because
    // the analyser's last window reaches a whole FFT past the last frame it
    // reports and must find music there.
    for (let bar = 0; bar * period * 4 < seconds + FFT_SIZE / SR; bar++) {
      const from = Math.round(bar * period * 4 * SR);
      const to = Math.round((bar + 1) * period * 4 * SR);
      if (breakAt && bar * period * 4 >= breakAt[0] && bar * period * 4 < breakAt[1]) continue;
      renderPad(buf, from, to, { f: notes[bar % 4], gain: padGain });
    }
  }

  // A breakdown is a mix move, so it happens BEFORE the limiter — which is
  // what makes the limiter let go and the dynamics gate close.
  if (breakAt) {
    const a = Math.round(breakAt[0] * SR);
    const b = Math.round(breakAt[1] * SR);
    for (let j = a; j < b && j < buf.length; j++) buf[j] *= 0.12;
  }
  for (let j = 0; j < buf.length; j++) buf[j] += noise() * noiseFloor;

  const pcm = limit(buf, { ceil });
  return { pcm, kicks: kicks.filter((t) => t < seconds), spectra: analyse(pcm, seconds) };
}

// ---------------------------------------------------------------------------
// The instruments themselves, for test/songs.mjs, which arranges whole tracks
// out of them. Exported rather than duplicated: a second copy of the kick
// would be a second theory of what a kick is.
// ---------------------------------------------------------------------------
export { renderKick, renderScreech, renderReverseBass, renderHat, renderPad, limit, shape, clip };
/** The shared noise source, reseeded so every render is deterministic. */
export function seedNoise(s = 1) {
  rndState = s >>> 0 || 1;
}
export { noise, rnd };

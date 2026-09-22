// A synthetic renderer for hard-genre material, faithful enough to drive the
// real analysis chain end to end: spectra -> features.js -> tempo.js.
//
// WHY THIS EXISTS. The suite used to model a kick as a rectangular boost of the
// 30-150 Hz band with nothing above it, on a track with no mastering, and every
// tempo test drove tempo.js with a hand-written impulse train instead of an
// onset function computed from audio. Both are the happy path, and the analyser
// passed all of it while being badly wrong on the music this player is actually
// pointed at. Measured through the real chain, the old detector fired 1.94
// times per kick on techno, MISSED 60% of uptempo's, and read a screech as a
// kick 3.74 times a beat; the tracker read a 240 BPM track at 60.
//
// What is modelled here, and why each part is load-bearing:
//
//   THE KICK IS A PITCHED SWEEP, not a band. A hardcore, frenchcore or uptempo
//   kick is a sine driven into a distortion chain, starting at 190-260 Hz and
//   sweeping down over the next fifty milliseconds, with harmonics to the top
//   of the spectrum. That is why the 25-180 Hz band is DOWN at the attack.
//
//   THE TAIL IS A TONAL SOUND. Zaag is Dutch for saw and the kick's tail is
//   one: "a complete rhythmic and tonal sound, with the transient, body,
//   distortion and moving tail all contributing to the groove". It keeps the
//   low band busy for most of the beat, which is what defeats any detector
//   built on "did the bass get louder than it was".
//
//   THE MASTER IS LIMITERED. These records are flat to the ceiling, so the
//   loudest moment in the music can read as a level DROP in every band at once.
//   A limiter with a real release is modelled, not a per-frame normaliser —
//   the difference is the whole of the common-mode problem in features.js.
//
//   ROLLS ARE SHORTENED. "At faster tempos, kick tails must remain rhythmically
//   precise, as excessively long sounds can overlap": nobody writes a 280 ms
//   tail into a 250 ms beat, and modelling it that way produces material whose
//   autocorrelation at its own tempo is NEGATIVE.
//
// MAINTAINING THIS: keep it physical. Every knob here corresponds to something
// a producer does, and a test that only passes because the generator is
// unrealistic is worse than no test. If a case fails, ask first whether the
// material is something anyone would actually make.
export const SR = 48000;
export const FFT_HI = 2048;
export const N = FFT_HI / 2;
export const HZ = SR / 2 / N;
export const FLOOR = -96;
export const DT = 1 / 94;

const bin = (hz) => Math.round(hz / HZ);

function tone(acc, hz, db, spread = 1) {
  const b = bin(hz);
  if (b < 1 || b >= N) return;
  const p = Math.pow(10, db / 10);
  for (let d = -spread; d <= spread; d++) {
    const j = b + d;
    if (j > 0 && j < N) acc[j] += p * Math.pow(0.3, Math.abs(d));
  }
}
function band(acc, lo, hi, db) {
  const p = Math.pow(10, db / 10);
  for (let i = bin(lo); i <= Math.min(N - 1, bin(hi)); i++) acc[i] += p;
}

/**
 * A distorted kick at `age` seconds after its attack: a click, a pitched body
 * swept from f0 to f1, harmonics to the top of the spectrum, and — for the
 * zaag/uptempo family — a moving sawtooth TAIL that is a tonal sound in its own
 * right and lasts most of the beat.
 */
function kick(acc, age, o) {
  const { f0 = 190, f1 = 45, sweep = 0.09, tail = 0.3, gain = 0, saw = 0, click = true } = o;
  if (age < 0 || age > tail) return;
  const f = f0 * Math.pow(f1 / f0, Math.min(1, age / sweep));
  const env = gain - 7 * (age / tail) ** 2;
  for (let h = 1; h <= 90; h++) {
    const hz = f * h;
    if (hz > SR / 2) break;
    tone(acc, hz, env - 8.5 * Math.log10(h));
  }
  if (saw > 0) {
    const sf = f1 * Math.pow(3.2, 1 - age / tail);
    for (let h = 1; h <= 60; h++) {
      const hz = sf * h;
      if (hz > SR / 2) break;
      tone(acc, hz, gain - 12 + 10 * Math.log10(saw) - 6 * Math.log10(h));
    }
  }
  if (click && age < 0.012) band(acc, 1800, 11000, gain - 14);
}

/** A screech / hoover stab: loud, broad, rising, and nowhere near the bass. */
function screech(acc, age, { len = 0.08, gain = 0, f = 800 } = {}) {
  if (age < 0 || age > len) return;
  const e = gain - 10 * (age / len);
  for (let h = 1; h <= 50; h++) {
    const hz = f * h * (1 + age * 0.6);
    if (hz > SR / 2) break;
    tone(acc, hz, e - 5 * Math.log10(h));
  }
}

/**
 * A REVERSE BASS — hardstyle and rawstyle's offbeat. A gated bass note in the
 * kick's own register that FADES IN rather than striking, which is exactly why
 * it must never read as a kick: it is the loudest thing between the kicks and
 * it has no attack at all.
 */
function reverseBass(acc, since, { len = 0.12, gain = -4, f = 70, duck = 22 } = {}) {
  // A reverse bass is a CONTINUOUS note that the kick ducks, not a gated one
  // that fades in from silence. The difference matters to a detector: a note
  // that starts has a step at its start, however soft the fade after it, and a
  // step is exactly what a kick is. Modelled as a gate it fired once a beat and
  // the detector was quite right; modelled as the sidechained note it actually
  // is, it does not, because nothing ever arrives.
  if (since < 0) return;
  const e = gain - duck * (1 - Math.min(1, since / len));
  for (let h = 1; h <= 30; h++) tone(acc, f * h, e - 7 * Math.log10(h));
}

/** A held pad / lead: a fixed note, changing once a bar. */
function pad(acc, f, gain) {
  for (let h = 1; h <= 40; h++) tone(acc, f * h, gain - 6.5 * Math.log10(h));
}

/**
 * A MASTERING LIMITER, not a per-frame normaliser. The difference matters: a
 * brick wall applied frame by frame turns the END of any loud sound into an
 * instantaneous several-decibel step in every other band, which no real master
 * does and which a kick detector cannot be asked to ignore. A real limiter
 * grabs in a millisecond and lets go over a tenth of a second.
 */
function makeLimiter(ceilDb, releaseS = 0.14) {
  let gr = 1; // gain reduction, linear
  return (acc, dt) => {
    let s = 0;
    for (let i = 0; i < N; i++) s += acc[i];
    const want = s > 0 ? Math.min(1, Math.pow(10, ceilDb / 10) / s) : 1;
    // Down instantly, up over the release.
    gr = want < gr ? want : gr + (want - gr) * (1 - Math.exp(-dt / releaseS));
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const v = acc[i] * gr;
      a[i] = v > 1e-10 ? Math.max(FLOOR, 10 * Math.log10(v)) : FLOOR;
    }
    return a;
  };
}

let rndState = 1;
const rnd = () => ((rndState = (rndState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/**
 * A track, as a list of 1024-bin dB spectra at DT seconds apart.
 *
 *   kickAt(beat, bar)      offsets within the beat carrying a kick, in beats
 *   screechAt(beat, bar)   the same for the lead
 *   jitterMs / ampJitter   a limiter and a human, not a metronome
 *   intro / breakAt        an arrangement
 */
export function renderTrack({
  bpm,
  seconds = 80,
  kickOpt = {},
  kickAt = () => [0],
  screechAt = null,
  screechOpt = {},
  rbassAt = null,
  rbassOpt = {},
  padGain = null,
  hats = 0,
  swing = 0,
  jitterMs = 0,
  ampJitter = 0,
  intro = 0,
  breakAt = null,
  ceilDb = 6,
  noiseDb = -62,
} = {}) {
  rndState = 1;
  const period = 60 / bpm;
  const nB = Math.ceil(seconds / period) + 2;
  const ks = [];
  const ss = [];
  const rb = [];
  for (let bt = 0; bt < nB; bt++) {
    const t0 = bt * period;
    const bar = Math.floor(bt / 4);
    const quiet = breakAt && t0 >= breakAt[0] && t0 < breakAt[1];
    if (t0 >= intro && !quiet) {
      const offs = kickAt(bt, bar);
      // A roll's notes are SHORTENED to fit their subdivision — "at faster
      // tempos kick tails must remain rhythmically precise, as excessively long
      // sounds overlap and create uncontrolled low-frequency buildup". Rendering
      // a 1/16 roll as four full-length kicks is not what anyone makes.
      // ...and no kick, roll or not, outlasts its own slot. At 240 BPM the beat
      // is 250 ms and nobody writes a 280 ms tail into it.
      const sub = period * (offs.length > 1 ? offs[1] - offs[0] : 1);
      for (const off of offs)
        ks.push({
          t: t0 + off * period + (rnd() - 0.5) * 2 * jitterMs * 0.001,
          g: rnd() * ampJitter,
          tail: Math.min(kickOpt.tail ?? 0.3, sub * 0.92),
        });
    }
    if (screechAt)
      for (const off of screechAt(bt, bar))
        ss.push({ t: t0 + off * period + (rnd() - 0.5) * 2 * jitterMs * 0.001 });
    if (rbassAt && !quiet && t0 >= intro)
      for (const off of rbassAt(bt, bar)) rb.push(t0 + off * period);
  }
  const limiter = makeLimiter(ceilDb);
  const out = [];
  const notes = [233, 277, 311, 208];
  for (let k = 0, n = Math.round(seconds / DT); k < n; k++) {
    const t = k * DT;
    const acc = new Float64Array(N);
    band(acc, 20, SR / 2, noiseDb);
    const quiet = breakAt && t >= breakAt[0] && t < breakAt[1];
    for (const e of ks) {
      const a = t - e.t;
      if (a >= 0 && a < 0.9)
        kick(acc, a, {
          ...kickOpt,
          gain: (kickOpt.gain || 0) - e.g * 8,
          ...(e.tail ? { tail: e.tail, sweep: Math.min(kickOpt.sweep ?? 0.09, e.tail * 0.35) } : null),
        });
    }
    for (const e of ss) {
      const a = t - e.t;
      if (a >= 0 && a < 0.4) screech(acc, a, screechOpt);
    }
    if (rb.length) {
      // How long since the duck released — the note itself never stops.
      let since = -1;
      for (const e of rb) {
        const a = t - e;
        if (a >= 0 && (since < 0 || a < since)) since = a;
      }
      if (since >= 0 && !quiet) reverseBass(acc, since, rbassOpt);
    }
    if (padGain != null) pad(acc, notes[Math.floor(t / (period * 4)) % 4], padGain);
    if (hats > 0 && !quiet) {
      const off = period / 2 + (swing ? (period / 2) * swing : 0);
      const hp = (t - off) % period;
      if (hp >= 0 && hp < 0.03) band(acc, 4000, 16000, -36 + 10 * Math.log10(hats));
    }
    // A breakdown is a dozen decibels down, which is what makes the dynamics
    // gate close. Applied before the limiter, as a mix move would be.
    if (quiet) for (let i = 0; i < N; i++) acc[i] *= 0.06;
    out.push(limiter(acc, DT));
  }
  return out;
}

// --- the patterns these genres are actually written in -----------------------
export const PATTERNS = {
  four: () => [0],
  // "kick kick kick, tac-tac-tac": a triplet roll on the last beat of the phrase
  tripletRoll: (bt) => (bt % 16 === 15 ? [0, 1 / 3, 2 / 3] : [0]),
  // uptempo: rolls all over, of several lengths
  uptempo: (bt) => {
    const p = bt % 8;
    if (p === 3) return [0, 0.5];
    if (p === 7) return [0, 1 / 3, 2 / 3];
    return [0];
  },
  // the last bar of every four, in sixteenths
  heavyRoll: (bt) => (bt % 16 >= 12 ? [0, 0.25, 0.5, 0.75] : [0]),
  // a beat deliberately left empty — completely ordinary in frenchcore
  skipFourth: (bt) => (bt % 4 === 3 ? [] : [0]),
  // the kick moving onto the offbeat every other beat
  offKick: (bt) => (bt % 2 ? [0.5] : [0]),
};

export const KICKS = {
  techno: { f0: 110, f1: 48, sweep: 0.03, tail: 0.16, gain: 0 },
  hardtekk: { f0: 170, f1: 46, sweep: 0.05, tail: 0.17, gain: 1 },
  gabber: { f0: 200, f1: 52, sweep: 0.07, tail: 0.26, gain: 2 },
  frenchcore: { f0: 190, f1: 44, sweep: 0.1, tail: 0.32, gain: 3 },
  uptempo: { f0: 240, f1: 52, sweep: 0.06, tail: 0.28, gain: 3, saw: 0.7 },
  zaag: { f0: 180, f1: 40, sweep: 0.06, tail: 0.36, gain: 2, saw: 1 },
  speedcore: { f0: 260, f1: 55, sweep: 0.04, tail: 0.2, gain: 3 },
  // a rap 808: a sustained note, with the kick landing on top of it
  trap: { f0: 60, f1: 48, sweep: 0.02, tail: 0.5, gain: 0, saw: 0.3 },
};

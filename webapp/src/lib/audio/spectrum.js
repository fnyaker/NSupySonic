// Log-spaced band reader over the two analysers in graph.js.
//
// WHY THIS EXISTS. A single FFT cannot be precise in the bass and fast in the
// treble at once: bin width is sampleRate / fftSize, window length is
// fftSize / sampleRate, and they trade off exactly. The old visualizer picked
// one 512-point FFT — a 93 Hz bin at 48 kHz — and then asked for log-spaced
// bars, so every bar under ~400 Hz floored onto the same two or three bins and
// the low end drew as flat groups of identical bars. That is the artefact this
// module removes.
//
// Two things fix it, and both are needed:
//
//  1. TWO analysers. The low end reads from an 8192-point FFT (5.9 Hz bins —
//     finer than a semitone at 100 Hz) and the rest from a 2048-point one
//     (43 ms window, fast enough that a hi-hat still snaps). 8192 rather than
//     16384 on purpose: 16384 would halve the bin width again, but its 341 ms
//     window smears a kick over a third of a second, and a bass visualizer that
//     cannot show a kick is worse than one that cannot resolve the note.
//
//  2. SUB-BIN INTERPOLATION. Even at 5.9 Hz bins, a log band near 25 Hz is
//     narrower than one bin, so flooring to a bin index still duplicates. Where
//     a band spans less than a bin we interpolate between the two neighbouring
//     bins instead, which is what makes the bottom bars move independently.
//
// The two analysers are blended across a transition region rather than butted
// together: they have different bin widths, so noise-like content reads a few
// dB lower on the finer one and a hard switch would draw a visible step in the
// middle of the spectrum. A smoothstep across 300-600 Hz turns that step into a
// ramp nobody can see.

const BLEND_LO = 300; // below this: purely the fine (low) analyser
const BLEND_HI = 600; // above this: purely the fast (high) analyser

const smoothstep = (t) => t * t * (3 - 2 * t);

// Where a frequency sits, in (fractional) bins, for an analyser of `n` bins
// covering 0..sampleRate/2.
function binAt(hz, n, nyquist) {
  return (hz / nyquist) * n;
}

// Build the read plan for `bands` log-spaced bars. Pure data: no analyser is
// touched here, so a plan can be built once and reused every frame.
export function buildBandPlan({
  bands,
  sampleRate,
  fftLo,
  fftHi,
  fMin = 22,
  fMax = 18000,
}) {
  const nyquist = sampleRate / 2;
  const nLo = fftLo / 2;
  const nHi = fftHi / 2;
  const top = Math.min(fMax, nyquist * 0.92);
  const lowest = Math.max(10, Math.min(fMin, top / 4));
  const plan = new Array(bands);
  const centers = new Float32Array(bands);
  for (let i = 0; i < bands; i++) {
    const f0 = lowest * Math.pow(top / lowest, i / bands);
    const f1 = lowest * Math.pow(top / lowest, (i + 1) / bands);
    const fc = Math.sqrt(f0 * f1); // geometric centre — log spacing's midpoint
    centers[i] = fc;
    const mix =
      fc <= BLEND_LO
        ? 0
        : fc >= BLEND_HI
          ? 1
          : smoothstep((fc - BLEND_LO) / (BLEND_HI - BLEND_LO));
    plan[i] = {
      mix,
      lo: mix < 1 ? binSpec(f0, f1, nLo, nyquist) : null,
      hi: mix > 0 ? binSpec(f0, f1, nHi, nyquist) : null,
    };
  }
  return { plan, centers, bands, sampleRate, fftLo, fftHi };
}

function binSpec(f0, f1, n, nyquist) {
  const a = binAt(f0, n, nyquist);
  const b = binAt(f1, n, nyquist);
  const i0 = Math.floor(a);
  const i1 = Math.floor(b);
  // At least one whole bin inside the band → read those bins. Otherwise the
  // band is narrower than the analyser's resolution and we interpolate at its
  // centre instead of flooring (which is what produced identical bars).
  if (i1 > i0)
    return { i0: Math.max(0, i0), i1: Math.min(n - 1, i1), frac: -1 };
  const f = Math.max(0, Math.min(n - 1.001, (a + b) / 2));
  return { i0: -1, i1: -1, frac: f };
}

function readSpec(data, spec, floorDb) {
  if (spec.frac < 0) {
    // Whole bins: the PEAK, not the mean. A band two bins wide holding one tone
    // reads that tone's real level either way, but the mean halves it — and the
    // spectrum then sags wherever the bands happen to be wide, which is exactly
    // the top of the display.
    let m = floorDb;
    for (let b = spec.i0; b <= spec.i1; b++) {
      const v = data[b];
      if (v > m) m = v;
    }
    return m;
  }
  const i = Math.floor(spec.frac);
  const t = spec.frac - i;
  // Interpolating in dB (not linear magnitude) is deliberate: the display is
  // logarithmic, so a straight line in dB is a straight line on screen.
  const a = data[i] > floorDb ? data[i] : floorDb;
  const b = data[i + 1] > floorDb ? data[i + 1] : floorDb;
  return a + (b - a) * t;
}

// Read one frame into `outDb` (dB) and `out01` (0..1 over [floorDb, ceilDb]).
// `loData` / `hiData` are Float32Arrays already filled by
// getFloatFrequencyData on the matching analyser.
export function readBands(planObj, loData, hiData, outDb, out01, floorDb, ceilDb) {
  const { plan } = planObj;
  const span = ceilDb - floorDb;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    let db;
    if (p.mix <= 0) db = readSpec(loData, p.lo, floorDb);
    else if (p.mix >= 1) db = readSpec(hiData, p.hi, floorDb);
    else {
      const a = readSpec(loData, p.lo, floorDb);
      const b = readSpec(hiData, p.hi, floorDb);
      db = a + (b - a) * p.mix;
    }
    if (!(db > floorDb)) db = floorDb; // also catches -Infinity on silence
    outDb[i] = db;
    out01[i] = Math.max(0, Math.min(1, (db - floorDb) / span));
  }
}

// Coarse energy bands, in Hz, used by the feature extractor and by the scenes
// that want "how much bass is there" rather than a whole spectrum. Deliberately
// six: sub and bass are separate because a kick lives in one and a bassline in
// the other, and telling them apart is what a kick detector needs.
export const ENERGY_BANDS = [
  ["sub", 20, 60],
  ["bass", 60, 160],
  ["lowMid", 160, 500],
  ["mid", 500, 2000],
  ["high", 2000, 6000],
  ["air", 6000, 16000],
];

// Precompute the bin ranges those six bands occupy on each analyser.
export function buildEnergyPlan({ sampleRate, fftLo, fftHi }) {
  const nyquist = sampleRate / 2;
  return ENERGY_BANDS.map(([name, f0, f1]) => {
    const useLo = f1 <= BLEND_HI;
    const n = useLo ? fftLo / 2 : fftHi / 2;
    return {
      name,
      useLo,
      i0: Math.max(0, Math.floor(binAt(f0, n, nyquist))),
      i1: Math.min(n - 1, Math.ceil(binAt(f1, n, nyquist))),
      f0,
      f1,
    };
  });
}

// Mean LINEAR power across a band, in dB. Mean (not peak) here: these feed
// level/energy decisions, where the total content of the band is the question.
export function readEnergy(plan, loData, hiData, out, floorDb) {
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const data = p.useLo ? loData : hiData;
    let sum = 0;
    let n = 0;
    for (let b = p.i0; b <= p.i1; b++) {
      const db = data[b] > floorDb ? data[b] : floorDb;
      sum += Math.pow(10, db / 10);
      n++;
    }
    const mean = n ? sum / n : 0;
    out[i] = mean > 0 ? 10 * Math.log10(mean) : floorDb;
  }
}

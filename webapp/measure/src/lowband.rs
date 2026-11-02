//! The low-band pass of `analysis._measure_tempo`: how often the bass STRIKES (the gate that
//! says "no beat, no tempo") and how concentrated its onsets are on the beat grid (`pulse`).
//! A port of `_low_envelope`, `_attack_rate`, `_smooth`, `_fold_windows`, `_phase_fold` and
//! `_grid_share`, with the decode they read rebuilt in code: ffmpeg's `lowpass=f=170` (one
//! biquad per channel), the mono downmix, the resample to 1 kHz and the unsigned 8-bit
//! quantisation. The resampler is a box average plus a cubic interpolation instead of swr's
//! polyphase filter: after a 170 Hz low-pass the two agree to about a percent, which the
//! gates' margins (40 attacks a minute, measured 0-1 for tones and 99.7 for the sparsest
//! record with a beat) were written to survive; `tests/test_measure.py` measures the gap.

use core::f64::consts::PI;

const OUT_RATE: f64 = 1000.0;
const GAIN: f64 = 1.0;
const ENV_HZ: usize = 100;
const RAW_PER_ENV: usize = (OUT_RATE as usize) / ENV_HZ; // 10
const ATTACK_RISE_DB: f64 = 1.0;
const FOLD_WINDOW: usize = 8 * ENV_HZ;

/// ffmpeg's `lowpass=f=170` (width_type q, width 0.707, 2 poles): an RBJ biquad.
struct Lowpass {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Lowpass {
    fn new(rate: f64) -> Lowpass {
        let w0 = 2.0 * PI * 170.0 / rate;
        let alpha = w0.sin() / (2.0 * 0.707);
        let cs = w0.cos();
        let a0 = 1.0 + alpha;
        Lowpass {
            b: [(1.0 - cs) / 2.0 / a0, (1.0 - cs) / a0, (1.0 - cs) / 2.0 / a0],
            a: [-2.0 * cs / a0, (1.0 - alpha) / a0],
            z: [0.0; 2],
        }
    }
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// Planar channels at `rate` -> the unsigned 8-bit stream at 1 kHz ffmpeg would hand over.
pub fn raw_u8(channels: &[&[f32]], rate: f64) -> Vec<u8> {
    let n = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    if n == 0 {
        return vec![];
    }
    let mut mono = vec![0.0f64; n];
    for ch in channels {
        let mut lp = Lowpass::new(rate);
        for i in 0..n {
            mono[i] += lp.run(ch[i] as f64);
        }
    }
    let inv = 1.0 / channels.len() as f64;
    // box average over one output period, then a cubic through the averages
    let step = rate / OUT_RATE;
    let outs = (n as f64 / step).floor() as usize;
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + mono[i] * inv;
    }
    let boxed = |k: i64| -> f64 {
        let c = (k as f64 + 0.5) * step;
        let a = ((c - step / 2.0).round().max(0.0)) as usize;
        let b = ((c + step / 2.0).round() as usize).min(n);
        if b > a { (prefix[b] - prefix[a]) / (b - a) as f64 } else { 0.0 }
    };
    let mut out = Vec::with_capacity(outs);
    for k in 0..outs as i64 {
        // sample at the output instant: the box centred on it, kept as is (the 170 Hz low-pass
        // already band-limits the signal well under the 500 Hz Nyquist)
        let v = boxed(k);
        let q = (v * GAIN * 128.0).round_ties_even() as i64 + 128;
        out.push(q.clamp(0, 255) as u8);
    }
    out
}

/// `_attack_rate`: how often the low band strikes, per minute.
pub fn attack_rate(raw: &[u8]) -> f64 {
    let sq: Vec<f64> = raw.iter().map(|b| ((*b as f64) - 128.0).powi(2)).collect();
    let w = 30usize;
    if sq.len() < 2 * w + 10 {
        return 0.0;
    }
    let boxcar = |x: &[f64]| -> Vec<f64> {
        let mut acc = vec![0.0; x.len() + 1];
        for i in 0..x.len() {
            acc[i + 1] = acc[i] + x[i];
        }
        (0..=x.len() - w).map(|i| (acc[i + w] - acc[i]) / w as f64).collect()
    };
    let once = boxcar(&sq);
    let twice = boxcar(&once);
    let step = (OUT_RATE as usize) / ENV_HZ;
    let power: Vec<f64> = (0..twice.len()).step_by(step).map(|i| twice[i]).collect();
    let top = power.iter().cloned().fold(0.0f64, f64::max);
    if top <= 0.0 {
        return 0.0;
    }
    let floor = top * 1e-5;
    let db: Vec<f64> = power.iter().map(|p| 10.0 * (p + floor).log10()).collect();
    let live = 10.0 * top.log10() - 40.0;
    let span = 3usize;
    let mut count = 0usize;
    let mut last: i64 = -1_000_000_000;
    for i in span..db.len() {
        if db[i] < live || (i as i64) - last < 10 {
            continue;
        }
        let m = db[i - span..i].iter().cloned().fold(f64::INFINITY, f64::min);
        if db[i] - m >= ATTACK_RISE_DB {
            count += 1;
            last = i as i64;
        }
    }
    count as f64 / (db.len() as f64 / ENV_HZ as f64 / 60.0)
}

/// The 100 Hz onset function of the low band: positive steps of the per-10 ms peak.
pub fn onset_function(raw: &[u8]) -> Vec<f64> {
    let env: Vec<f64> = raw
        .chunks_exact(RAW_PER_ENV)
        .map(|c| {
            let mx = *c.iter().max().unwrap() as f64;
            let mn = *c.iter().min().unwrap() as f64;
            (mx - 128.0).max(128.0 - mn)
        })
        .collect();
    let mut odf = vec![0.0; env.len()];
    for i in 1..env.len() {
        let d = env[i] - env[i - 1];
        if d > 0.0 {
            odf[i] = d;
        }
    }
    odf
}

/// `_smooth`: a Gaussian (sigma 2) over the onset function.
pub fn smooth(xs: &[f64]) -> Vec<f64> {
    let sigma = 2.0f64;
    let r = (sigma * 2.5).ceil().max(1.0) as i64;
    let k: Vec<f64> = (-r..=r).map(|i| (-((i * i) as f64) / (2.0 * sigma * sigma)).exp()).collect();
    let tot: f64 = k.iter().sum();
    let k: Vec<f64> = k.iter().map(|v| v / tot).collect();
    let n = xs.len() as i64;
    (0..n)
        .map(|i| {
            let mut acc = 0.0;
            for j in -r..=r {
                let x = i + j;
                if x >= 0 && x < n {
                    acc += xs[x as usize] * k[(j + r) as usize];
                }
            }
            acc
        })
        .collect()
}

fn fold_windows(n: usize) -> Vec<(usize, usize)> {
    if n <= FOLD_WINDOW {
        return vec![(0, n)];
    }
    let count = (n / FOLD_WINDOW).clamp(1, 12);
    (0..count)
        .map(|i| ((i as f64 * (n - FOLD_WINDOW) as f64 / (count - 1).max(1) as f64) as usize, FOLD_WINDOW))
        .collect()
}

fn phase_fold(odf: &[f64], start: usize, length: usize, period: f64, bins: usize) -> (Vec<f64>, f64) {
    let mut fold = vec![0.0; bins];
    let mut total = 0.0;
    let inv = 1.0 / period;
    for i in start..start + length {
        let v = odf[i];
        let x = (i as f64 * inv) % 1.0;
        fold[((x * bins as f64) as usize) % bins] += v;
        total += v;
    }
    (fold, total)
}

/// `_grid_share`: how concentrated the bass onsets are on the beat grid, 0..1.
pub fn grid_share(odf: &[f64], period: f64) -> f64 {
    let bins = (period.round_ties_even() as usize).max(4);
    let w = ((bins as f64 * 0.05).round_ties_even() as usize).max(2);
    let baseline = ((2 * w + 1) as f64 / bins as f64).min(1.0);
    let (mut num, mut den) = (0.0, 0.0);
    for (start, length) in fold_windows(odf.len()) {
        let (fold, total) = phase_fold(odf, start, length, period, bins);
        if total < 1e-6 {
            continue;
        }
        let mut best = 0.0f64;
        for k in 0..bins {
            let mut s = 0.0;
            for j in -(w as i64)..=(w as i64) {
                s += fold[((k as i64 + j).rem_euclid(bins as i64)) as usize];
            }
            best = best.max(s);
        }
        let share = ((best / total) - baseline) / (1.0 - baseline).max(1e-6) * 1.25;
        num += share.clamp(0.0, 1.0) * total;
        den += total;
    }
    if den > 1e-9 { num / den } else { 0.0 }
}

/// What the tempo gate and the pulse need, from decoded PCM at its own rate.
pub struct LowBand {
    pub attacks: f64,
    odf: Vec<f64>,
}

pub fn analyse(channels: &[&[f32]], rate: f64) -> LowBand {
    let raw = raw_u8(channels, rate);
    LowBand { attacks: attack_rate(&raw), odf: onset_function(&raw) }
}

impl LowBand {
    /// `pulse` for a tempo (0 for a track too short to fold: under eight seconds).
    pub fn grid(&self, bpm: f64) -> f64 {
        let sm = smooth(&self.odf);
        if sm.len() >= 8 * ENV_HZ { grid_share(&sm, 60.0 * ENV_HZ as f64 / bpm) } else { 0.0 }
    }
}

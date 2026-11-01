//! The whole-file beat tracker, a port of `supysonic/deezer/beats.py` (itself a port of
//! Mixxx's default analyser: qm-dsp's DetectionFunction + TempoTrackV2, then Mixxx's
//! BeatUtils; GPL-2.0-or-later, credited there). Same constants, same order of operations,
//! so the tempo the client measures is the tempo the server serves; `tests/test_measure.py`
//! holds the two to each other on real audio.
//!
//! Input is mono f32 at 44.1 kHz, fed in chunks (the onset function is streamed: a two-hour
//! set costs memory for a chunk plus one number per 512 samples).

use crate::fft::Fft;
use core::f64::consts::PI;

pub const SR: f64 = 44100.0;
const STEP: usize = 512;
const WINDOW: usize = 1024;
const DF_HZ: f64 = SR / STEP as f64;
const EPS: f64 = 0.0000008;
const WV_LEN: usize = 128;
const MAX_PHASE_ERROR: f64 = 0.025;
const MAX_PHASE_ERROR_SUM: f64 = 0.1;
const MAX_OUTLIERS: usize = 1;
const MIN_REGION_BEATS: f64 = 16.0;
const MAX_BPM: f64 = 300.0;
const DOUBLE_RATIO: f64 = 0.85;
const DOUBLE_MAX: f64 = 1.3;

// -- 1. the onset detection function ------------------------------------------------------

/// The complex spectral difference, one value per 512-sample step (and, over the kick's
/// bins and the bass's, the same distance for the octave check).
pub struct Onsets {
    fft: Fft,
    win: Vec<f64>,
    buf: Vec<f32>,
    mag1: Vec<f64>,
    ph1: Vec<f64>,
    ph2: Vec<f64>,
    re: Vec<f64>,
    im: Vec<f64>,
    pub df: Vec<f64>,
    pub low: Vec<f64>,
    pub bass: Vec<f64>,
}

impl Onsets {
    pub fn new() -> Onsets {
        let half = WINDOW / 2 + 1;
        Onsets {
            fft: Fft::new(WINDOW),
            // qm-dsp's periodic Hann
            win: (0..WINDOW).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f64 / WINDOW as f64).cos()).collect(),
            // qm-dsp pads half a window before the first sample
            buf: vec![0.0; WINDOW / 2],
            mag1: vec![0.0; half],
            ph1: vec![0.0; half],
            ph2: vec![0.0; half],
            re: vec![0.0; WINDOW],
            im: vec![0.0; WINDOW],
            df: Vec::new(),
            low: Vec::new(),
            bass: Vec::new(),
        }
    }

    pub fn push(&mut self, chunk: &[f32]) {
        self.buf.extend_from_slice(chunk);
        let half = WINDOW / 2 + 1;
        let mut at = 0;
        while self.buf.len() - at >= WINDOW {
            for i in 0..WINDOW {
                self.re[i] = self.buf[at + i] as f64 * self.win[i];
                self.im[i] = 0.0;
            }
            self.fft.transform(&mut self.re, &mut self.im);
            let (mut v, mut lo, mut ba) = (0.0, 0.0, 0.0);
            for k in 0..half {
                let (r, i) = (self.re[k], self.im[k]);
                let mag = (r * r + i * i).sqrt();
                let ph = i.atan2(r);
                // princarg(φ_n - 2φ_{n-1} + φ_{n-2}), numpy's mod with a negative divisor
                let x = ph - 2.0 * self.ph1[k] + self.ph2[k] + PI;
                let d = -2.0 * PI;
                let dev = (x - d * (x / d).floor()) + PI;
                let m1 = self.mag1[k];
                let dist = (m1 * m1 + mag * mag - 2.0 * m1 * mag * dev.cos()).max(0.0).sqrt();
                v += dist;
                if (1..4).contains(&k) {
                    lo += dist;
                }
                if (1..6).contains(&k) {
                    ba += dist;
                }
                self.mag1[k] = mag;
                self.ph2[k] = self.ph1[k];
                self.ph1[k] = ph;
            }
            self.df.push(v);
            self.low.push(lo);
            self.bass.push(ba);
            at += STEP;
        }
        self.buf.drain(..at);
    }
}

// -- 2. the beat period ------------------------------------------------------------------

fn adaptive_threshold(x: &[f64]) -> Vec<f64> {
    let n = x.len();
    let mut c = vec![0.0; n + 1];
    for i in 0..n {
        c[i + 1] = c[i] + x[i];
    }
    (0..n)
        .map(|i| {
            let first = i.saturating_sub(8);
            let last = (i + 7).min(n - 1);
            let mean = (c[last + 1] - c[first]) / (last - first + 1) as f64;
            (x[i] - mean).max(0.0)
        })
        .collect()
}

fn rayleigh(inputtempo: f64) -> Vec<f64> {
    let rayparam = (60.0 * 44100.0 / 512.0) / inputtempo;
    (0..WV_LEN)
        .map(|i| {
            let i = i as f64;
            (i / (rayparam * rayparam)) * (-(i * i) / (2.0 * rayparam * rayparam)).exp()
        })
        .collect()
}

fn comb() -> Vec<(usize, usize, f64)> {
    let mut v = Vec::new();
    for i in 2..WV_LEN {
        for a in 1..5i64 {
            for b in (1 - a)..a {
                v.push((i - 1, (a * i as i64 + b - 1) as usize, 1.0 / (2 * a - 1) as f64));
            }
        }
    }
    v
}

fn rcf(frame: &[f64], wv: &[f64], comb: &[(usize, usize, f64)], fft: &mut Fft) -> Vec<f64> {
    let x = adaptive_threshold(frame);
    let n = x.len();
    let m = 2 * n;
    let mut re = vec![0.0; m];
    let mut im = vec![0.0; m];
    re[..n].copy_from_slice(&x);
    fft.transform(&mut re, &mut im);
    // |F|^2 is real and even: its forward transform is m * the autocorrelation.
    for k in 0..m {
        re[k] = re[k] * re[k] + im[k] * im[k];
        im[k] = 0.0;
    }
    fft.transform(&mut re, &mut im);
    let acf: Vec<f64> = (0..n).map(|k| re[k] / m as f64 / (n - k) as f64).collect();
    let mut out = vec![0.0; WV_LEN];
    for &(row, lag, w) in comb {
        out[row] += acf[lag] * wv[row] * w;
    }
    let mut out = adaptive_threshold(&out);
    for v in out.iter_mut() {
        *v += EPS;
    }
    let s: f64 = out.iter().sum::<f64>() + EPS;
    out.iter().map(|v| v / s).collect()
}

/// TempoTrackV2::calculateBeatPeriod: the beat period (in DF frames) for every 128 frames.
pub fn beat_period(df: &[f64]) -> Vec<i64> {
    let wv = rayleigh(120.0);
    let (winlen, hop) = (512usize, 128i64);
    let n = df.len() as i64;
    let comb = comb();
    let mut fft = Fft::new(2 * winlen);
    let mut cols: Vec<Vec<f64>> = Vec::new();
    let mut i = -(winlen as i64) / 2;
    while i < n - (winlen as i64) / 2 {
        let mut frame = vec![0.0; winlen];
        let k = (-i).max(0);
        let l = (winlen as i64).min(n - i);
        for j in k..l {
            frame[j as usize] = df[(i + j) as usize];
        }
        cols.push(rcf(&frame, &wv, &comb, &mut fft));
        i += hop;
    }
    let mut out = vec![0i64; (n / 128 + 1) as usize];
    let t_len = cols.len();
    if t_len < 2 {
        return out;
    }
    let q = WV_LEN;
    let sigma = 8.0f64;
    let mut tmat = vec![0.0; q * q];
    for a in 20..q - 20 {
        for b in 20..q - 20 {
            let d = b as f64 - a as f64;
            tmat[a * q + b] = (-(d * d) / (2.0 * sigma * sigma)).exp();
        }
    }
    let mut delta = vec![vec![0.0; q]; t_len];
    let mut psi = vec![vec![0usize; q]; t_len];
    for j in 0..q {
        delta[0][j] = wv[j] * cols[0][j];
    }
    let s0: f64 = delta[0].iter().sum::<f64>() + EPS;
    for v in delta[0].iter_mut() {
        *v /= s0;
    }
    for t in 1..t_len {
        let mut cur = vec![0.0; q];
        for j in 0..q {
            // cand[j][i] = delta[t-1][i] * tmat[j][i]; numpy argmax = first maximum
            let (mut bi, mut bv) = (0usize, f64::NEG_INFINITY);
            for i in 0..q {
                let v = delta[t - 1][i] * tmat[j * q + i];
                if v > bv {
                    bv = v;
                    bi = i;
                }
            }
            if bv <= 0.0 {
                psi[t][j] = 0;
                bv = delta[t - 1][0] * tmat[j * q];
            } else {
                psi[t][j] = bi;
            }
            cur[j] = bv * cols[t][j];
        }
        let s: f64 = cur.iter().sum::<f64>() + EPS;
        for v in cur.iter_mut() {
            *v /= s;
        }
        delta[t] = cur;
    }
    let mut path = vec![0usize; t_len];
    let last = &delta[t_len - 1];
    let mx = last.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    path[t_len - 1] = if mx > 0.0 { last.iter().position(|v| *v == mx).unwrap_or(0) } else { 0 };
    for t in (1..t_len - 1).rev() {
        path[t] = psi[t + 1][path[t + 1]];
    }
    path[0] = psi[1][path[1]];
    let m = out.len().min(t_len);
    for t in 0..m {
        out[t] = path[t] as i64;
    }
    out
}

// -- 3. the beats --------------------------------------------------------------------------

/// TempoTrackV2::calculateBeats: beat positions, in DF frames.
pub fn track_beats(df: &[f64], periods: &[i64]) -> Vec<usize> {
    let (alpha, tightness) = (0.9, 4.0);
    let n = df.len();
    if n == 0 || periods.is_empty() {
        return vec![];
    }
    let mut cum = vec![0.0f64; n];
    let mut back = vec![-1i64; n];
    let mut old: Option<i64> = None;
    let mut txwt: Vec<f64> = Vec::new();
    for i in 0..n {
        let period = periods[(i / 128).min(periods.len() - 1)];
        let pmin = -2 * period;
        if old != Some(period) {
            old = Some(period);
            let pmax = if period >= 0 { ((period as f64) / -2.0).trunc() as i64 } else { 0 };
            let len = (pmax - pmin + 1).max(0) as usize;
            let mu = if period != 0 { period as f64 } else { 1.0 };
            let two = (2.0 * mu).round_ties_even();
            txwt = (0..len)
                .map(|j| {
                    let arg = (two - j as f64) / mu;
                    if arg > 0.0 {
                        let t = tightness * arg.ln();
                        (-0.5 * t * t).exp()
                    } else {
                        0.0
                    }
                })
                .collect();
        }
        let lo = i as i64 + pmin;
        let start = (-lo).max(0) as usize;
        let (mut vv, mut xx) = (0.0f64, 0i64);
        if start < txwt.len() {
            let mut best = f64::NEG_INFINITY;
            let mut bk = 0usize;
            let end = (lo + txwt.len() as i64).min(n as i64);
            let seg_len = (end - (lo + start as i64)).max(0) as usize;
            for k in 0..seg_len {
                let sc = txwt[start + k] * cum[(lo + start as i64) as usize + k];
                if sc > best {
                    best = sc;
                    bk = k;
                }
            }
            if seg_len > 0 && best > 0.0 {
                vv = best;
                xx = lo + start as i64 + bk as i64;
            }
        }
        cum[i] = alpha * vv + (1.0 - alpha) * df[i];
        back[i] = xx;
    }
    let last = if periods[periods.len() - 1] != 0 { periods[periods.len() - 1] } else { 1 };
    let tail0 = (n as i64 - last).max(0) as usize;
    let mx = cum[tail0..].iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mut start = if mx > 0.0 { cum[tail0..].iter().position(|v| *v == mx).unwrap_or(0) + tail0 } else { tail0 };
    start = start.min(n - 1);
    let mut beats = vec![start];
    while back[*beats.last().unwrap()] > 0 {
        let b = *beats.last().unwrap();
        if back[b] as usize == b {
            break;
        }
        beats.push(back[b] as usize);
    }
    beats.reverse();
    beats
}

// -- 4. the constant tempo (Mixxx BeatUtils) -----------------------------------------------

fn const_regions(beats: &[f64], sr: f64) -> Vec<(f64, f64)> {
    if beats.len() < 2 {
        return vec![];
    }
    let max_err = MAX_PHASE_ERROR * sr;
    let max_err_sum = MAX_PHASE_ERROR_SUM * sr;
    let (mut left, mut right) = (0usize, beats.len() - 1);
    let mut regions = Vec::new();
    while left < beats.len() - 1 {
        let mean = (beats[right] - beats[left]) / (right - left) as f64;
        let mut outliers = 0usize;
        let mut ironed = beats[left];
        let mut err_sum = 0.0;
        let mut i = left + 1;
        while i <= right {
            ironed += mean;
            let err = ironed - beats[i];
            err_sum += err;
            if err.abs() > max_err {
                outliers += 1;
                if outliers > MAX_OUTLIERS || i == left + 1 {
                    break;
                }
            }
            if err_sum.abs() > max_err_sum {
                break;
            }
            i += 1;
        }
        if i > right {
            let mut border = 0.0;
            if right > left + 2 {
                let first = beats[left + 1] - beats[left];
                let last = beats[right] - beats[right - 1];
                border = (first + last - 2.0 * mean).abs();
            }
            if border < max_err / 2.0 {
                regions.push((beats[left], mean));
                left = right;
                right = beats.len() - 1;
                continue;
            }
        }
        right -= 1;
    }
    regions.push((beats[beats.len() - 1], 0.0));
    regions
}

fn round_bpm(lo: f64, center: f64, hi: f64) -> f64 {
    let tries: [(f64, bool); 5] = [
        (1.0, true),
        (2.0, center < 85.0),
        (2.0 / 3.0, center > 127.0),
        (3.0, true),
        (12.0, true),
    ];
    for (frac, ok) in tries {
        if ok {
            let snap = (center * frac).round_ties_even() / frac;
            if lo < snap && snap < hi {
                return snap;
            }
        }
    }
    center
}

fn const_bpm(regions: &[(f64, f64)], sr: f64) -> Option<(f64, f64)> {
    if regions.len() < 2 {
        return None;
    }
    let err = MAX_PHASE_ERROR * sr;
    let (mut mid, mut longest, mut beat_len) = (0usize, 0.0f64, 0.0f64);
    for i in 0..regions.len() - 1 {
        let length = regions[i + 1].0 - regions[i].0;
        if length > longest {
            longest = length;
            beat_len = regions[i].1;
            mid = i;
        }
    }
    if longest == 0.0 || beat_len <= 0.0 {
        return None;
    }
    let mut nbeats = (longest / beat_len + 0.5).trunc();
    let mut bl_min = beat_len - err / nbeats;
    let mut bl_max = beat_len + err / nbeats;
    let (mut start_i, mut end_i) = (mid, mid);
    let agrees = |i: usize, beat_len: f64| -> Option<(f64, f64)> {
        let length = regions[i + 1].0 - regions[i].0;
        let nb = if regions[i].1 > 0.0 { (length / regions[i].1 + 0.5).trunc() } else { 0.0 };
        if nb < MIN_REGION_BEATS {
            return None;
        }
        let lo = regions[i].1 - err / nb;
        let hi = regions[i].1 + err / nb;
        if !(lo < beat_len && beat_len < hi) {
            return None;
        }
        Some((lo, hi))
    };
    for i in 0..mid {
        let Some(r) = agrees(i, beat_len) else { continue };
        let span = regions[mid + 1].0 - regions[i].0;
        let (lo, hi) = (bl_min.max(r.0), bl_max.min(r.1));
        if (span / lo).round_ties_even() != (span / hi).round_ties_even() {
            continue;
        }
        let nb = (span / hi).round_ties_even();
        let nbl = span / nb;
        if bl_min < nbl && nbl < bl_max {
            beat_len = nbl;
            nbeats = nb;
            bl_min = beat_len - err / nbeats;
            bl_max = beat_len + err / nbeats;
            start_i = i;
            break;
        }
    }
    if regions.len() >= 3 {
        for i in (mid + 1..=regions.len() - 2).rev() {
            let Some(r) = agrees(i, beat_len) else { continue };
            let span = regions[i + 1].0 - regions[start_i].0;
            let (lo, hi) = (bl_min.max(r.0), bl_max.min(r.1));
            if (span / lo).round_ties_even() != (span / hi).round_ties_even() {
                continue;
            }
            let nb = (span / hi).round_ties_even();
            let nbl = span / nb;
            if bl_min < nbl && nbl < bl_max {
                beat_len = nbl;
                nbeats = nb;
                end_i = i;
                break;
            }
        }
    }
    bl_min = beat_len - err / nbeats;
    bl_max = beat_len + err / nbeats;
    let bpm = round_bpm(60.0 * sr / bl_max, 60.0 * sr / beat_len, 60.0 * sr / bl_min);
    let total = regions[regions.len() - 1].0 - regions[0].0;
    let covered = if total > 0.0 { (regions[end_i + 1].0 - regions[start_i].0) / total } else { 0.0 };
    Some((bpm, covered))
}

// -- the whole pass ------------------------------------------------------------------------

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

fn peaks(x: &[f64], pos: &[f64]) -> Vec<f64> {
    let w = 2i64;
    let n = x.len() as i64;
    pos.iter()
        .map(|p| {
            let c = p.round_ties_even() as i64;
            let (a, b) = ((c - w).max(0), (n).min(c + w + 1));
            if a < b { x[a as usize..b as usize].iter().cloned().fold(f64::NEG_INFINITY, f64::max) } else { 0.0 }
        })
        .collect()
}

fn ratio(x: &[f64], on: &[f64], off: &[f64]) -> f64 {
    median(&mut peaks(x, off)) / (median(&mut peaks(x, on)) + 1e-12)
}

fn salience(df: &[f64], ib: &[f64]) -> f64 {
    if ib.len() < 4 {
        return 0.0;
    }
    let mut d: Vec<f64> = ib.windows(2).map(|w| w[1] - w[0]).collect();
    let p = median(&mut d);
    let mut off: Vec<f64> = ib.iter().map(|b| b + p / 4.0).chain(ib.iter().map(|b| b + 3.0 * p / 4.0)).collect();
    off.retain(|o| *o < df.len() as f64 - 1.0);
    median(&mut peaks(df, ib)) / (median(&mut peaks(df, &off)) + 1e-12)
}

#[derive(Debug, Clone, Default)]
pub struct Tempo {
    pub bpm: f64,
    pub confidence: f64,
    pub salience: f64,
    pub doubled: bool,
    pub alternation: f64,
    pub beats: Vec<f64>,
}

fn r3(v: f64) -> f64 {
    (v * 1000.0).round_ties_even() / 1000.0
}

/// `beats.analyse`: None when the file yields too little to track.
pub fn analyse(onsets: &Onsets) -> Option<Tempo> {
    let mut nz = onsets.df.len();
    while nz > 0 && onsets.df[nz - 1] <= 0.0 {
        nz -= 1;
    }
    if nz < 3 {
        return None;
    }
    let df = &onsets.df[2..nz];
    let low = &onsets.low[2..nz];
    let bass = &onsets.bass[2..nz];
    if (df.len() as f64) < DF_HZ * 6.0 {
        return None;
    }
    let periods = beat_period(df);
    let ibeats = track_beats(df, &periods);
    if ibeats.len() < 4 {
        return None;
    }
    let sr = SR;
    let beats: Vec<f64> = ibeats.iter().map(|b| *b as f64 * STEP as f64 + STEP as f64 / 2.0).collect();
    let (mut bpm, covered);
    if (beats.len() as f64) < MIN_REGION_BEATS {
        bpm = 60.0 * (beats.len() - 1) as f64 * sr / (beats[beats.len() - 1] - beats[0]);
        covered = 0.0;
    } else {
        let (b, c) = const_bpm(&const_regions(&beats, sr), sr)?;
        bpm = b;
        covered = c;
    }
    if bpm == 0.0 || !bpm.is_finite() {
        return None;
    }
    let ib: Vec<f64> = ibeats.iter().map(|b| *b as f64).collect();
    let sal = salience(df, &ib);
    let mut alternation = 1.0;
    if ib.len() >= 8 {
        let on = peaks(bass, &ib);
        let mut a: Vec<f64> = on.iter().step_by(2).cloned().collect();
        let mut b: Vec<f64> = on.iter().skip(1).step_by(2).cloned().collect();
        let (ma, mb) = (median(&mut a), median(&mut b));
        let mx = ma.max(mb);
        alternation = if mx > 0.0 { ma.min(mb) / mx } else { 1.0 };
    }
    let mut doubled = false;
    if ib.len() >= 8 && bpm * 2.0 <= MAX_BPM {
        let mids: Vec<f64> = ib.windows(2).map(|w| (w[0] + w[1]) / 2.0).collect();
        let broad = ratio(df, &ib, &mids);
        let kick = ratio(low, &ib, &mids);
        if (DOUBLE_RATIO..=DOUBLE_MAX).contains(&broad) && (DOUBLE_RATIO..=DOUBLE_MAX).contains(&kick) {
            bpm *= 2.0;
            doubled = true;
        }
    }
    Some(Tempo {
        bpm: r3(bpm),
        confidence: r3(covered),
        salience: r3(sal),
        doubled,
        alternation: r3(alternation),
        beats: beats.iter().map(|b| (b / sr * 10000.0).round_ties_even() / 10000.0).collect(),
    })
}

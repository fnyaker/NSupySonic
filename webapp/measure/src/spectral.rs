//! The per-frame spectral descriptors `analysis._spectral` takes from ffmpeg's
//! `aspectralstats`, written out. Definitions and what does NOT match ffmpeg
//! (flatness on band-limited lossy material) are in supysonic/deezer/measure.py.

use crate::fft::Fft;

pub const WIN: usize = 2048;
pub const HOP: usize = 1024;
const BINS: usize = WIN / 2;
const ROLLOFF: f64 = 0.85;

#[derive(Default)]
pub struct Series {
    pub centroid: Vec<f64>,
    pub spread: Vec<f64>,
    pub flatness: Vec<f64>,
    pub rolloff: Vec<f64>,
    pub flux: Vec<f64>,
    pub entropy: Vec<f64>,
}

fn hann() -> Vec<f64> {
    // numpy.hanning(N): symmetric.
    (0..WIN)
        .map(|i| 0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / (WIN as f64 - 1.0)).cos())
        .collect()
}

/// Frames of ONE channel, ffmpeg's framing (the first frame is half silence).
pub fn channel(x: &[f32], rate: f64, out: &mut Series) {
    if x.len() < WIN / 2 {
        return;
    }
    let win = hann();
    let mut fft = Fft::new(WIN);
    let total = HOP + x.len();
    let count = if total >= WIN { (total - WIN) / HOP + 1 } else { 1 };
    let f: Vec<f64> = (0..BINS).map(|k| k as f64 * rate / WIN as f64).collect();
    let mut frame = vec![0.0f64; WIN];
    let mut mag = vec![0.0f64; BINS];
    let mut prev = vec![0.0f64; BINS];
    let log_bins = (BINS as f64).log2();
    for c in 0..count {
        for i in 0..WIN {
            let p = c * HOP + i; // index into [HOP zeros | x]
            let v = if p < HOP { 0.0 } else { x.get(p - HOP).copied().unwrap_or(0.0) as f64 };
            // numpy computes the window product in f32 first; f64 here, same to ~1e-7.
            frame[i] = v * win[i];
        }
        fft.magnitude(&frame, BINS, &mut mag);
        for m in mag.iter_mut() {
            *m /= WIN as f64;
        }
        let sum: f64 = mag.iter().sum();
        if sum <= 0.0 {
            prev.copy_from_slice(&mag);
            continue;
        }
        let centroid: f64 = mag.iter().zip(&f).map(|(m, f)| m * f).sum::<f64>() / sum;
        let var: f64 = mag.iter().zip(&f).map(|(m, f)| m * (f - centroid) * (f - centroid)).sum::<f64>() / sum;
        let flat = (mag.iter().map(|m| (m + 1e-30).ln()).sum::<f64>() / BINS as f64).exp() / (sum / BINS as f64);
        let mut acc = 0.0;
        let mut roll = f[BINS - 1];
        for (k, m) in mag.iter().enumerate() {
            acc += m;
            if acc >= ROLLOFF * sum {
                roll = f[k];
                break;
            }
        }
        let flux = mag.iter().zip(&prev).map(|(a, b)| (a - b) * (a - b)).sum::<f64>().sqrt();
        // ffmpeg's "entropy" is -sum(m * log2 m) over the RAW magnitudes (m = |X| / 2048,
        // NOT divided by their sum) over log2(1024): it exceeds 1 on loud broadband frames.
        // Recovered frame by frame (2e-5) and then on 99 real tracks.
        let ent = -mag.iter().map(|m| if *m > 0.0 { m * m.log2() } else { 0.0 }).sum::<f64>() / log_bins;
        out.centroid.push(centroid);
        out.spread.push(var.sqrt());
        out.flatness.push(flat);
        out.rolloff.push(roll);
        out.flux.push(flux);
        out.entropy.push(ent);
        prev.copy_from_slice(&mag);
    }
}

/// numpy.median.
pub fn median(v: &[f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let n = s.len();
    if n % 2 == 1 { s[n / 2] } else { (s[n / 2 - 1] + s[n / 2]) / 2.0 }
}

/// `analysis._pct`: nearest rank, Python's round-half-even on the index.
pub fn pct(v: &[f64], q: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let x = q * (s.len() - 1) as f64;
    let r = x.round_ties_even();
    s[(r as usize).min(s.len() - 1)]
}

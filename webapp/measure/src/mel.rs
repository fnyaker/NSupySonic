//! The extractor's front-end and aggregation, a port of `supysonic/deezer/embedding.py`
//! (`patch_offsets`, `_log_mel_patches`, `patch_loudness`, `loud_half`, `_aggregate`).
//!
//! The network itself (discogs-effnet, ONNX) runs in the page through onnxruntime-web; what
//! goes in (log-mel patches, MusiCNN's published parametrization: 16 kHz mono, 512-sample Hann,
//! hop 256, 96 Slaney mel bands, log10(10000·x + 1), 128-frame patches) and what comes out
//! (one 1280-d row per patch -> the stored 3840-d vector: mean, spread, loud-half mean) must
//! be bit-for-bit what the server computes, or a head trained on the server's vectors reads
//! the client's as noise. A front-end with the wrong window or scale gives vectors that look
//! healthy and mean nothing: `tests/test_measure.py` holds this to the Python.

use crate::fft::Fft;

pub const SAMPLE_RATE: usize = 16000;
pub const FRAME_SIZE: usize = 512;
pub const HOP_SIZE: usize = 256;
pub const MEL_BANDS: usize = 96;
pub const PATCH_FRAMES: usize = 128;
pub const MAX_PATCHES: usize = 60;
pub const MODEL_DIM: usize = 1280;
pub const PATCH_SAMPLES: usize = (PATCH_FRAMES - 1) * HOP_SIZE + FRAME_SIZE;
const HALF_FLOOR: f64 = 1e-5;

/// Where to cut the patches the track is summarised from (spread over the whole file).
pub fn patch_offsets(n_samples: usize, take: usize) -> Vec<usize> {
    if n_samples < FRAME_SIZE {
        return vec![];
    }
    let total = ((n_samples - FRAME_SIZE) / HOP_SIZE + 1) / PATCH_FRAMES;
    if total < 1 {
        return vec![];
    }
    let take = take.min(total).max(1);
    let last = n_samples.saturating_sub(PATCH_SAMPLES);
    if take == 1 {
        return vec![0];
    }
    let step = (total - 1) as f64 / (take - 1) as f64;
    let mut out: Vec<usize> = Vec::new();
    for i in 0..take {
        let off = last.min(((i as f64 * step).round_ties_even() as usize) * PATCH_FRAMES * HOP_SIZE);
        if out.last().map_or(true, |l| *l != off) {
            out.push(off);
        }
    }
    out
}

fn hz_to_mel(f: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = 6.4f64.ln() / 27.0;
    if f >= min_log_hz { min_log_mel + (f / min_log_hz).ln() / logstep } else { f / f_sp }
}

fn mel_to_hz(m: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = 6.4f64.ln() / 27.0;
    if m >= min_log_mel { min_log_hz * (logstep * (m - min_log_mel)).exp() } else { f_sp * m }
}

/// Slaney-scale triangular mel filters, area-normalised (librosa's `htk=False, norm='slaney'`).
pub fn filterbank() -> Vec<f32> {
    let bins = FRAME_SIZE / 2 + 1;
    let fft_freqs: Vec<f64> = (0..bins).map(|k| k as f64 * (SAMPLE_RATE as f64 / 2.0) / (bins - 1) as f64).collect();
    let (lo, hi) = (hz_to_mel(0.0), hz_to_mel(SAMPLE_RATE as f64 / 2.0));
    let hz_pts: Vec<f64> = (0..MEL_BANDS + 2)
        .map(|i| mel_to_hz(lo + (hi - lo) * i as f64 / (MEL_BANDS + 1) as f64))
        .collect();
    let mut fb = vec![0.0f32; MEL_BANDS * bins];
    for i in 0..MEL_BANDS {
        let d0 = hz_pts[i + 1] - hz_pts[i];
        let d1 = hz_pts[i + 2] - hz_pts[i + 1];
        let enorm = 2.0 / (hz_pts[i + 2] - hz_pts[i]);
        for k in 0..bins {
            let lower = -(hz_pts[i] - fft_freqs[k]) / d0;
            let upper = (hz_pts[i + 2] - fft_freqs[k]) / d1;
            let v = lower.min(upper).max(0.0);
            fb[i * bins + k] = (v as f32) * (enorm as f32);
        }
    }
    fb
}

/// `(patches, 128, 96)` log-mel patches, flat, for the given offsets.
pub fn log_mel_patches(samples: &[f32], offsets: &[usize]) -> Option<Vec<f32>> {
    if offsets.is_empty() {
        return None;
    }
    let bins = FRAME_SIZE / 2 + 1;
    let fb = filterbank();
    let window: Vec<f32> = (0..FRAME_SIZE)
        .map(|i| (0.5 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / FRAME_SIZE as f64).cos()) as f32)
        .collect();
    let mut fft = Fft::new(FRAME_SIZE);
    let mut re = vec![0.0f64; FRAME_SIZE];
    let mut im = vec![0.0f64; FRAME_SIZE];
    let mut out = vec![0.0f32; offsets.len() * PATCH_FRAMES * MEL_BANDS];
    let mut power = vec![0.0f32; bins];
    for (k, off) in offsets.iter().enumerate() {
        if off + PATCH_SAMPLES > samples.len() {
            return None;
        }
        for f in 0..PATCH_FRAMES {
            let seg = &samples[off + f * HOP_SIZE..off + f * HOP_SIZE + FRAME_SIZE];
            for i in 0..FRAME_SIZE {
                re[i] = (seg[i] * window[i]) as f64;
                im[i] = 0.0;
            }
            fft.transform(&mut re, &mut im);
            for b in 0..bins {
                power[b] = (re[b] * re[b] + im[b] * im[b]) as f32;
            }
            let row = (k * PATCH_FRAMES + f) * MEL_BANDS;
            for m in 0..MEL_BANDS {
                let mut acc = 0.0f32;
                let w = &fb[m * bins..(m + 1) * bins];
                for b in 0..bins {
                    acc += power[b] * w[b];
                }
                out[row + m] = (10000.0f64 * acc as f64 + 1.0).log10() as f32;
            }
        }
    }
    Some(out)
}

/// Each patch's RMS level in dB (what picks the loud half).
pub fn patch_loudness(samples: &[f32], offsets: &[usize]) -> Vec<f64> {
    offsets
        .iter()
        .map(|off| {
            let seg = &samples[(*off).min(samples.len())..(off + PATCH_SAMPLES).min(samples.len())];
            let rms = if seg.is_empty() {
                0.0
            } else {
                (seg.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / seg.len() as f64).sqrt()
            };
            20.0 * rms.max(1e-9).log10()
        })
        .collect()
}

/// Indices of the loud half: every patch at or above the upper median level.
pub fn loud_half(loudness: &[f64]) -> Vec<usize> {
    if loudness.is_empty() {
        return vec![];
    }
    let mut ranked = loudness.to_vec();
    ranked.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    let median = ranked[ranked.len() / 2];
    (0..loudness.len()).filter(|i| loudness[*i] >= median).collect()
}

fn norm(v: &[f32]) -> f64 {
    v.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>().sqrt()
}

/// Per-patch embeddings `(n, 1280)` -> the stored 3840-d vector: mean + spread (the v2 vector,
/// L2-normalised halves) then the mean over the loud half at the weight of each v2 half.
pub fn aggregate(rows: &[f32], n: usize, loudness: Option<&[f64]>) -> Option<Vec<f32>> {
    if n == 0 || rows.len() != n * MODEL_DIM {
        return None;
    }
    if let Some(l) = loudness {
        if l.len() != n {
            return None;
        }
    }
    // L2-normalise every patch (float32 like numpy), so a loud patch does not outvote a quiet one
    let mut x = vec![0.0f32; n * MODEL_DIM];
    for i in 0..n {
        let r = &rows[i * MODEL_DIM..(i + 1) * MODEL_DIM];
        let nr = (norm(r) as f32).max(1e-9);
        for j in 0..MODEL_DIM {
            x[i * MODEL_DIM + j] = r[j] / nr;
        }
    }
    let col_mean = |idx: &[usize]| -> Vec<f32> {
        (0..MODEL_DIM)
            .map(|j| (idx.iter().map(|i| x[i * MODEL_DIM + j] as f64).sum::<f64>() / idx.len() as f64) as f32)
            .collect()
    };
    let all: Vec<usize> = (0..n).collect();
    let loud_rows = loudness.map(loud_half).unwrap_or_default();
    let loud = if loud_rows.is_empty() { col_mean(&all) } else { col_mean(&loud_rows) };
    let mean = col_mean(&all);
    let std: Vec<f32> = if n > 1 {
        (0..MODEL_DIM)
            .map(|j| {
                let m = mean[j] as f64;
                ((all.iter().map(|i| { let d = x[i * MODEL_DIM + j] as f64 - m; d * d }).sum::<f64>()) / n as f64).sqrt() as f32
            })
            .collect()
    } else {
        vec![0.0; MODEL_DIM]
    };
    let unit = |h: &[f32]| -> Vec<f32> {
        let nn = norm(h);
        if nn > HALF_FLOOR { h.iter().map(|v| (*v as f64 / nn) as f32).collect() } else { vec![0.0; h.len()] }
    };
    let mut vec2: Vec<f32> = unit(&mean).into_iter().chain(unit(&std)).collect();
    let nv = norm(&vec2);
    if nv > 1e-9 {
        for v in vec2.iter_mut() {
            *v = (*v as f64 / nv) as f32;
        }
    }
    let weight = norm(&vec2[..MODEL_DIM]);
    let nl = norm(&loud);
    let loud: Vec<f32> = if nl > HALF_FLOOR { loud.iter().map(|v| (*v as f64 * (weight / nl)) as f32).collect() } else { vec![0.0; MODEL_DIM] };
    Some(vec2.into_iter().chain(loud).collect())
}

//! The display spectrum: 120 log-spaced bands and six coarse energy bands,
//! read from two spectra — a FAST one (2048 points at the full rate, 43 ms)
//! for everything above ~400 Hz, and a FINE one for the bass.
//!
//! The fine spectrum used to be an 8192-point AnalyserNode. Here it is a
//! 512-point FFT of the signal DECIMATED by 16 behind an 8th-order Butterworth
//! low-pass: the same 5.9 Hz bins and the same 170 ms window, for about a
//! tenth of the arithmetic — the bottom 600 Hz is all that spectrum is ever
//! read for, and there is no reason to transform the other 23 kHz to get it.
//! The low-pass is 60 dB down where aliases could fold into the bins that are
//! read, and 0.002 dB down at the top of them.
//!
//! Everything else is a straight port of lib/audio/spectrum.js: the blend
//! across 300-600 Hz, sub-bin interpolation where a band is narrower than a
//! bin, the peak (not the mean) inside a band, and dB in, 0..1 out.

use crate::util::fast_log10;

pub const BAND_COUNT: usize = 120;
pub const FLOOR_DB: f32 = -96.0;
pub const CEIL_DB: f32 = -14.0;
const BLEND_LO: f32 = 300.0;
const BLEND_HI: f32 = 600.0;

#[derive(Clone, Copy)]
struct BinSpec {
    i0: i32,
    i1: i32,
    frac: f32, // < 0: whole bins i0..=i1, else interpolate at frac
}

#[derive(Clone, Copy)]
struct BandSpec {
    mix: f32,
    lo: BinSpec,
    hi: BinSpec,
}

pub struct BandPlan {
    bands: Vec<BandSpec>,
    pub centers: Vec<f32>,
}

fn smoothstep(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

fn bin_spec(f0: f32, f1: f32, n: usize, hz_per_bin: f32) -> BinSpec {
    let a = f0 / hz_per_bin;
    let b = f1 / hz_per_bin;
    let i0 = a.floor() as i32;
    let i1 = b.floor() as i32;
    if i1 > i0 {
        return BinSpec {
            i0: i0.max(0),
            i1: i1.min(n as i32 - 1),
            frac: -1.0,
        };
    }
    let f = ((a + b) / 2.0).clamp(0.0, n as f32 - 1.001);
    BinSpec { i0: -1, i1: -1, frac: f }
}

impl BandPlan {
    /// `lo_hz` / `hi_hz` are the bin widths of the fine and fast spectra, and
    /// `lo_n` / `hi_n` how many bins each has.
    pub fn new(sr: f32, lo_hz: f32, lo_n: usize, hi_hz: f32, hi_n: usize) -> BandPlan {
        let nyquist = sr / 2.0;
        let top = 18000f32.min(nyquist * 0.92);
        let lowest = 10f32.max(22f32.min(top / 4.0));
        let mut bands = Vec::with_capacity(BAND_COUNT);
        let mut centers = Vec::with_capacity(BAND_COUNT);
        let dummy = BinSpec { i0: -1, i1: -1, frac: 0.0 };
        for i in 0..BAND_COUNT {
            let f0 = lowest * (top / lowest).powf(i as f32 / BAND_COUNT as f32);
            let f1 = lowest * (top / lowest).powf((i + 1) as f32 / BAND_COUNT as f32);
            let fc = (f0 * f1).sqrt();
            centers.push(fc);
            let mix = if fc <= BLEND_LO {
                0.0
            } else if fc >= BLEND_HI {
                1.0
            } else {
                smoothstep((fc - BLEND_LO) / (BLEND_HI - BLEND_LO))
            };
            bands.push(BandSpec {
                mix,
                lo: if mix < 1.0 { bin_spec(f0, f1, lo_n, lo_hz) } else { dummy },
                hi: if mix > 0.0 { bin_spec(f0, f1, hi_n, hi_hz) } else { dummy },
            });
        }
        BandPlan { bands, centers }
    }

    /// dB spectra in, bands out: `out_db` in dB and `out01` over [floor, ceil].
    pub fn read(&self, lo_db: &[f32], hi_db: &[f32], out_db: &mut [f32], out01: &mut [f32]) {
        let span = CEIL_DB - FLOOR_DB;
        for (i, p) in self.bands.iter().enumerate() {
            let db = if p.mix <= 0.0 {
                read_spec(lo_db, &p.lo)
            } else if p.mix >= 1.0 {
                read_spec(hi_db, &p.hi)
            } else {
                let a = read_spec(lo_db, &p.lo);
                let b = read_spec(hi_db, &p.hi);
                a + (b - a) * p.mix
            };
            let db = if db > FLOOR_DB { db } else { FLOOR_DB };
            out_db[i] = db;
            out01[i] = ((db - FLOOR_DB) / span).clamp(0.0, 1.0);
        }
    }
}

fn read_spec(data: &[f32], s: &BinSpec) -> f32 {
    if s.frac < 0.0 {
        let mut m = FLOOR_DB;
        for b in s.i0..=s.i1 {
            let v = data[b as usize];
            if v > m {
                m = v;
            }
        }
        return m;
    }
    let i = s.frac.floor() as usize;
    let t = s.frac - i as f32;
    let a = data[i].max(FLOOR_DB);
    let b = data[i + 1].max(FLOOR_DB);
    a + (b - a) * t
}

/// The six coarse bands, in Hz — spectrum.js's ENERGY_BANDS.
pub const ENERGY_BANDS: [(f32, f32); 6] = [
    (20.0, 60.0),
    (60.0, 160.0),
    (160.0, 500.0),
    (500.0, 2000.0),
    (2000.0, 6000.0),
    (6000.0, 16000.0),
];

pub struct EnergyPlan {
    spec: [(bool, usize, usize); 6],
}

impl EnergyPlan {
    pub fn new(lo_hz: f32, lo_n: usize, hi_hz: f32, hi_n: usize) -> EnergyPlan {
        let mut spec = [(false, 0usize, 0usize); 6];
        for (k, (f0, f1)) in ENERGY_BANDS.iter().enumerate() {
            let use_lo = *f1 <= BLEND_HI;
            let (hz, n) = if use_lo { (lo_hz, lo_n) } else { (hi_hz, hi_n) };
            let i0 = ((f0 / hz).floor() as usize).min(n - 1);
            let i1 = ((f1 / hz).ceil() as usize).min(n - 1);
            spec[k] = (use_lo, i0, i1);
        }
        EnergyPlan { spec }
    }

    /// Mean LINEAR power across each band, in dB and linear, from linear
    /// magnitudes (already floored). Power, not magnitude: 10 log10.
    pub fn read(&self, lo_mag: &[f32], hi_mag: &[f32], out_db: &mut [f32; 6], out_lin: &mut [f32; 6]) {
        for (k, (use_lo, i0, i1)) in self.spec.iter().enumerate() {
            let data = if *use_lo { lo_mag } else { hi_mag };
            let mut sum = 0f32;
            let mut n = 0f32;
            for b in *i0..=*i1 {
                let m = data[b];
                sum += m * m;
                n += 1.0;
            }
            let mean = if n > 0.0 { sum / n } else { 0.0 };
            let db = if mean > 0.0 { 10.0 * fast_log10(mean) } else { FLOOR_DB };
            let db = db.max(FLOOR_DB);
            out_db[k] = db;
            out_lin[k] = 10f32.powf(db / 10.0);
        }
    }
}

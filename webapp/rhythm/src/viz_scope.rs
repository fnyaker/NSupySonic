//! The oscilloscope's arithmetic: the trigger, the reduction of each channel's
//! window to one MIN/MAX pair per column, and the auto-range.
//!
//! This is what `lib/viz/scenes/scope.js` computed in JavaScript on every
//! analysis frame, ported with its rules intact — see that file for WHY each
//! of them is there (a triggered trace stands still, the trigger is low-passed
//! so it locks to the music rather than to the cymbals, one timebase serves
//! both channels, the column ends are fractional so a sub-sample trigger
//! reaches the screen, the auto-range compresses rather than normalises).
//!
//! The positions and the trigger filter are carried in f64 on purpose. The
//! window starts some sixteen thousand samples into a buffer and the trigger's
//! whole point is its FRACTION: in f32 that fraction is a thousandth of a
//! sample at best, which is exactly the jitter it exists to remove. The sample
//! values themselves, and what comes out, are f32 — and they come out bit for
//! bit what the JavaScript produced, which is what the tests hold it to.
//!
//! What it hands back is one interleaved array per channel — `[lo, hi]` per
//! column — laid out so the GL scope can upload it as a two-channel float
//! texture without touching it, and the canvas fallback can read it in place.

use crate::util::MinMax;

/// The timebase: how much time one lane shows, end to end.
const WINDOW_MS: f64 = 42.0;
/// How far back the trigger hunts when the tier does not say.
const SEARCH_MS: f64 = 40.0;
/// The trigger's coupling filter, Hz.
const TRIG_HZ: f64 = 320.0;
/// The Schmitt gate: a share of the trigger signal's own weight, and a floor.
const TRIG_HYST: f64 = 0.12;
const TRIG_FLOOR: f64 = 0.002;
/// The auto-range (see scope.js for the reasoning behind every number).
const AGC_TARGET: f64 = 0.8;
const AGC_SOFT: f64 = 0.6;
const AGC_MIN: f64 = 0.8;
const AGC_MAX: f64 = 8.0;
const AGC_FLOOR: f64 = 0.02;
const AGC_ATTACK: f64 = 0.35;
const AGC_RELEASE: f64 = 0.9;

/// The most columns a lane can have: a 4K beamer gets one per pixel.
pub const MAX_COLS: usize = 4096;
/// Floats in the trace: two channels, `[lo, hi]` per column.
pub const TRACE_LEN: usize = 2 * MAX_COLS * 2;
/// Floats in the state record `state()` returns.
pub const STATE_LEN: usize = 8;

/// min and max by COMPARISON, which is what the JavaScript did (`if (v < a)
/// a = v`). Rust's `f64::min` promises to ignore a NaN and WebAssembly has no
/// instruction that means that, so on wasm every call to it is a call into a
/// libm routine: measured, the nine of them a column made this reduction 2.5x
/// slower in the browser than natively. A sample is never NaN; a comparison
/// is one instruction.
#[inline(always)]
fn lesser(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}
#[inline(always)]
fn greater(a: f64, b: f64) -> f64 {
    if b > a {
        b
    } else {
        a
    }
}

#[inline]
fn approach(v: f64, target: f64, tau: f64, dt: f64) -> f64 {
    v + (target - v) * (1.0 - (-dt / greater(tau, 1e-4)).exp())
}

#[inline]
fn envelope(v: f64, target: f64, dt: f64, attack: f64, release: f64) -> f64 {
    if target > v {
        approach(v, target, attack, dt)
    } else {
        approach(v, target, release, dt)
    }
}

#[derive(Clone, Copy)]
pub struct ScopeCfg {
    pub search_ms: f64,
    pub exact: bool,
    pub fine: bool,
    pub interp: bool,
}

impl Default for ScopeCfg {
    fn default() -> Self {
        ScopeCfg { search_ms: SEARCH_MS, exact: false, fine: false, interp: false }
    }
}

pub struct Scope {
    pub cfg: ScopeCfg,
    cols: usize,
    /// The input: `left` then `right`, `cap` samples each.
    wave: Vec<f32>,
    cap: usize,
    /// The output: channel A's `[lo, hi]` pairs, then channel B's.
    trace: Vec<f32>,
    state: [f32; STATE_LEN],
    gain: f64,
    peak_env: f64,
    trig_env: f64,
    locked: f64,
    signal: bool,
}

impl Scope {
    pub fn new() -> Scope {
        Scope {
            cfg: ScopeCfg::default(),
            cols: 0,
            wave: Vec::new(),
            cap: 0,
            trace: vec![0.0; TRACE_LEN],
            state: [0.0; STATE_LEN],
            gain: 1.0,
            peak_env: 0.3,
            trig_env: 0.05,
            locked: 0.0,
            signal: false,
        }
    }

    pub fn set_cols(&mut self, cols: usize) {
        self.cols = cols.fmin(MAX_COLS);
    }

    /// Where the page writes the two channels: `left` at 0, `right` at `size`.
    pub fn wave_ptr(&mut self, size: usize) -> *mut f32 {
        if size > self.cap {
            self.cap = size;
            self.wave.resize(size * 2, 0.0);
        }
        self.wave.as_mut_ptr()
    }

    pub fn trace_ptr(&self) -> *const f32 {
        self.trace.as_ptr()
    }

    pub fn state_ptr(&mut self) -> *const f32 {
        self.state = [
            self.gain as f32,
            self.locked as f32,
            self.peak_env as f32,
            self.trig_env as f32,
            if self.signal { 1.0 } else { 0.0 },
            self.cols as f32,
            0.0,
            0.0,
        ];
        self.state.as_ptr()
    }

    /// No probe on it: a flat line, which is the truth, and the lock let go.
    pub fn idle(&mut self, dt: f64) {
        if self.cols > 0 && self.signal {
            self.signal = false;
            self.trace.iter_mut().for_each(|v| *v = 0.0);
        }
        if self.cols > 0 {
            self.locked = approach(self.locked, 0.0, 0.4, dt);
        }
    }

    /// One analysis frame: `size` samples per channel at `sr`.
    pub fn update(&mut self, size: usize, sr: f64, dt: f64) {
        if self.cols == 0 || size < 4 || size > self.cap {
            return;
        }
        let sr = if sr > 0.0 { sr } else { 48000.0 };
        let win = lesser((size - 2) as f64, greater(64.0, round_half_up(sr * WINDOW_MS / 1000.0))) as usize;
        let last_start = size - win - 1;
        let search_ms = if self.cfg.search_ms > 0.0 { self.cfg.search_ms } else { SEARCH_MS };
        let search = lesser(last_start as f64, round_half_up(sr * search_ms / 1000.0)) as usize;
        let from = 1usize.fmax(last_start.saturating_sub(search));

        // --- the trigger --------------------------------------------------------
        let (left, right) = self.wave.split_at(self.cap);
        let left = &left[..size];
        let right = &right[..size];
        // The one-pole filter, y += k (x - y), is written as y = a y + k x and
        // advanced TWO samples at a time: y[n+2] = a^2 y[n] + (a k x[n] +
        // k x[n+1]). Nothing about the filter changes; what changes is the
        // chain of operations each sample has to wait for, from a subtract, a
        // multiply and an add per sample to a multiply and an add per PAIR —
        // this loop runs through up to 250 ms of samples ninety-four times a
        // second and was a third of the scope's whole cost. The rounding moves
        // a crossing by about 1e-15 of a sample.
        let k = 1.0 - (-2.0 * core::f64::consts::PI * TRIG_HZ / sr).exp();
        let a1 = 1.0 - k;
        let a2 = a1 * a1;
        let hyst = greater(TRIG_FLOOR, self.trig_env * TRIG_HYST);
        let mut y = 0f64;
        let mut armed = false;
        let mut hit: isize = -1;
        let mut frac = 0f64;
        let mut tpeak = 0f64;
        let fine = self.cfg.fine;
        // One sample of the gate: `prev` is the filter one sample back.
        let mut gate = |i: usize, prev: f64, y: f64| {
            let m = y.abs();
            if m > tpeak {
                tpeak = m;
            }
            if y < -hyst {
                armed = true;
            } else if armed && y >= 0.0 && prev < 0.0 {
                hit = i as isize - 1;
                frac = if fine && y != prev { (-prev / (y - prev)).clamp(0.0, 1.0) } else { 0.0 };
                armed = false;
            }
        };
        let xs = |i: usize| (left[i] as f64 + right[i] as f64) * 0.5;
        let mut i = from;
        while i < last_start {
            let b0 = k * xs(i);
            let b1 = k * xs(i + 1);
            let y1 = a1 * y + b0;
            let y2 = a2 * y + (a1 * b0 + b1);
            gate(i, y, y1);
            gate(i + 1, y1, y2);
            y = y2;
            i += 2;
        }
        if i == last_start {
            let y1 = a1 * y + k * xs(i);
            gate(i, y, y1);
        }
        self.trig_env = envelope(self.trig_env, tpeak, dt, 0.08, 1.2);
        let base = if hit >= 0 { hit as f64 + frac } else { last_start as f64 };
        self.locked = approach(self.locked, if hit >= 0 { 1.0 } else { 0.0 }, if hit >= 0 { 0.12 } else { 0.5 }, dt);

        // --- the two windows ------------------------------------------------------
        self.signal = true;
        let cols = self.cols;
        let (ta, tb) = self.trace.split_at_mut(MAX_COLS * 2);
        let pa = reduce(left, size, base, &mut ta[..cols * 2], cols, win, self.cfg);
        let pb = reduce(right, size, base, &mut tb[..cols * 2], cols, win, self.cfg);

        // --- the auto-range, shared between the channels ------------------------------
        self.peak_env = envelope(self.peak_env, greater(pa, pb), dt, AGC_ATTACK, AGC_RELEASE);
        let want = (AGC_TARGET / greater(AGC_FLOOR, self.peak_env)).powf(AGC_SOFT).clamp(AGC_MIN, AGC_MAX);
        self.gain = approach(self.gain, want, 0.35, dt);
    }
}

impl Default for Scope {
    fn default() -> Self {
        Self::new()
    }
}

/// `buf` read at `p`, whose integer part is already known to be `i`: the
/// interpolation scope.js#lerpSample did, without converting `p` again.
#[inline]
fn lerp_at(buf: &[f32], p: f64, i: usize, n: usize) -> f64 {
    if p <= 0.0 {
        return buf[0] as f64;
    }
    if p >= (n - 1) as f64 {
        return buf[n - 1] as f64;
    }
    let a = buf[i] as f64;
    a + (buf[i + 1] as f64 - a) * (p - i as f64)
}

/// Round half up, as JavaScript's Math.round does, for a non-negative value.
#[inline]
fn round_half_up(x: f64) -> f64 {
    let r = x.floor();
    if x - r >= 0.5 {
        r + 1.0
    } else {
        r
    }
}

/// Reduce one channel's window to `cols` interleaved `[lo, hi]` pairs, and
/// return its true peak. See scope.js#reduce for what `exact`, `fine` and
/// `interp` buy.
///
/// Two things make this cheaper than the per-column arithmetic it replaced,
/// and neither changes the picture. The integer parts of the column edges are
/// not recomputed: a ceil, a floor and three float-to-integer conversions a
/// column were most of the cost (a conversion that must saturate is a dozen
/// instructions, a rounding on an x86 without SSE4.1 is a library call), so an
/// integer cursor walks along with the edges instead. And every edge is READ
/// once: a column's end is the next column's start, so the interpolated value
/// there serves both — the JavaScript computed the two from positions one
/// rounding apart, which moves the trace by about 1e-10 px. The positions
/// advance by `step` rather than being multiplied out, drifting by a few
/// billionths of a sample across a whole lane.
fn reduce(buf: &[f32], size: usize, base: f64, out: &mut [f32], cols: usize, win: usize, cfg: ScopeCfg) -> f64 {
    let step = win as f64 / cols as f64;
    let mut peak = 0f64;
    let last = size - 1;
    // The edge the current column starts at, its integer part, and the value
    // of the signal there.
    let mut p0 = base;
    let mut f0 = greater(base.floor(), 0.0) as usize;
    let mut e0 = lerp_at(buf, p0, f0.fmin(last), size);
    for c in 0..cols {
        let p1 = p0 + step;
        let mut f1 = f0;
        while f1 < last && ((f1 + 1) as f64) <= p1 {
            f1 += 1;
        }
        // The whole samples inside [p0, p1]: from ceil(p0) to floor(p1).
        let i0 = if (f0 as f64) < p0 { f0 + 1 } else { f0 };
        let i1 = f1;
        let e1 = if cfg.fine || cfg.interp { lerp_at(buf, p1, f1, size) } else { 0.0 };
        let (a, b);
        if i1 < i0 {
            let mid = (p0 + p1) * 0.5;
            let v = if cfg.interp {
                lerp_at(buf, mid, (greater(mid.floor(), 0.0) as usize).fmin(last), size)
            } else {
                buf[(round_half_up(mid) as usize).fmin(last)] as f64
            };
            a = v;
            b = v;
        } else if cfg.exact {
            let mut lo = buf[i0];
            let mut hi = lo;
            for &v in &buf[i0 + 1..=i1] {
                if v < lo {
                    lo = v;
                }
                if v > hi {
                    hi = v;
                }
            }
            let (mut la, mut hb) = (lo as f64, hi as f64);
            if cfg.fine {
                la = lesser(lesser(la, e0), e1);
                hb = greater(greater(hb, e0), e1);
            }
            a = la;
            b = hb;
        } else {
            let mut best = buf[i0];
            let mut best_abs = best.abs();
            for &v in &buf[i0 + 1..=i1] {
                let m = v.abs();
                if m > best_abs {
                    best_abs = m;
                    best = v;
                }
            }
            a = best as f64;
            b = best as f64;
        }
        out[c * 2] = a as f32;
        out[c * 2 + 1] = b as f32;
        let m = greater(a.abs(), b.abs());
        if m > peak {
            peak = m;
        }
        p0 = p1;
        f0 = f1;
        e0 = e1;
    }
    peak
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(size: usize, hz: f64, sr: f64, phase: f64) -> Vec<f32> {
        (0..size).map(|i| ((2.0 * core::f64::consts::PI * hz * (i as f64 + phase) / sr).sin() * 0.6) as f32).collect()
    }

    #[test]
    fn a_steady_tone_triggers_and_stands_still() {
        let mut s = Scope::new();
        s.cfg = ScopeCfg { search_ms: 120.0, exact: true, fine: true, interp: false };
        s.set_cols(512);
        let size = 8192;
        let mut first: Option<Vec<f32>> = None;
        let mut worst = 0f32;
        for f in 0..40 {
            // A new window of the same tone, starting somewhere else each frame.
            let w = tone(size, 220.0, 48000.0, f as f64 * 511.3);
            let p = s.wave_ptr(size);
            let buf = unsafe { core::slice::from_raw_parts_mut(p, size * 2) };
            buf[..size].copy_from_slice(&w);
            buf[size..].copy_from_slice(&w);
            s.update(size, 48000.0, 1.0 / 94.0);
            let tr = s.trace[..1024].to_vec();
            if let Some(ref a) = first {
                for (x, y) in a.iter().zip(tr.iter()) {
                    worst = worst.fmax((x - y).abs());
                }
            } else if f > 4 {
                first = Some(tr);
            }
        }
        assert!(s.locked > 0.9, "locked {}", s.locked);
        // Triggered and interpolated, successive windows of one tone draw the
        // same trace to a small fraction of its amplitude.
        assert!(worst < 0.01, "trace moved by {}", worst);
    }
}

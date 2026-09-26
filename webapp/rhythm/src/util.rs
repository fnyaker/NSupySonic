//! Small numeric helpers shared by every stage: a fast logarithm for the
//! per-bin loops, the fuzzy memberships the classifier is written in, and a
//! biquad for the time-domain taps.

/// `max` and `min` WITHOUT a library call, for the hot paths.
///
/// `f32::max` promises to return the other operand when one is NaN, and
/// WebAssembly has no instruction that means that (its `f32.max` propagates
/// the NaN instead), so on wasm every call to it compiles to a call into a
/// libm routine. There were a hundred and fifty of them in this crate, a good
/// share inside per-bin and per-column loops; in the scope's reduction alone
/// nine a column made it 2.5x slower in the browser than natively. These keep
/// Rust's exact semantics — the non-NaN operand wins — with comparisons, which
/// are one instruction each. Implemented for the integers too (as `Ord`), so
/// one spelling serves every call site and the compiler checks each of them.
pub trait MinMax: Sized {
    fn fmax(self, other: Self) -> Self;
    fn fmin(self, other: Self) -> Self;
}

macro_rules! float_minmax {
    ($t:ty) => {
        impl MinMax for $t {
            #[inline(always)]
            fn fmax(self, other: $t) -> $t {
                if self > other {
                    self
                } else if other > self {
                    other
                } else if self != self {
                    other
                } else {
                    self
                }
            }
            #[inline(always)]
            fn fmin(self, other: $t) -> $t {
                if self < other {
                    self
                } else if other < self {
                    other
                } else if self != self {
                    other
                } else {
                    self
                }
            }
        }
    };
}
float_minmax!(f32);
float_minmax!(f64);

macro_rules! int_minmax {
    ($($t:ty),*) => {$(
        impl MinMax for $t {
            #[inline(always)]
            fn fmax(self, other: $t) -> $t {
                Ord::max(self, other)
            }
            #[inline(always)]
            fn fmin(self, other: $t) -> $t {
                Ord::min(self, other)
            }
        }
    )*};
}
int_minmax!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize);

/// `f64::exp` and `f64::powf`, kept OUT OF LINE for the animation core. On
/// wasm they are libm routines compiled into the module, and with LTO every
/// call site got a copy of its own: the musical reading's exponentials and the
/// palette's powers put two routines of several hundred bytes each in a
/// couple of dozen places. A call costs a few nanoseconds; the copies cost a
/// download.
#[inline(never)]
pub fn exp64(x: f64) -> f64 {
    x.exp()
}

#[inline(never)]
pub fn pow64(x: f64, y: f64) -> f64 {
    x.powf(y)
}

/// log2(x) for x > 0, to about 1e-4 — plenty for an onset function or a
/// flatness measure, and several times cheaper than the libm call it
/// replaces in the per-bin loops. Uses the float's own exponent and a
/// minimax polynomial on the mantissa in [1, 2).
#[inline]
pub fn fast_log2(x: f32) -> f32 {
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000);
    // log2(m), m in [1, 2): a degree-5 least-squares fit, 3.2e-5 at worst
    // (two ten-thousandths of a decibel once it becomes 20 log10).
    let p = 4.342_890_8e-2f32;
    let p = p * m - 4.048_671_7e-1;
    let p = p * m + 1.593_901_4;
    let p = p * m - 3.492_494_3;
    let p = p * m + 5.046_876;
    let p = p * m - 2.786_813;
    e as f32 + p
}

pub const LOG10_2: f32 = 0.301_029_99;

#[inline]
pub fn fast_log10(x: f32) -> f32 {
    fast_log2(x) * LOG10_2
}

#[inline]
pub fn clamp(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

#[inline]
pub fn clamp01(x: f32) -> f32 {
    clamp(x, 0.0, 1.0)
}

/// Trapezoid membership with soft shoulders — style.js's `inRange`.
#[inline]
pub fn in_range(x: f32, lo: f32, hi: f32, w: f32) -> f32 {
    let w = if w > 0.0 { w } else { (hi - lo) * 0.45 };
    if x >= lo && x <= hi {
        1.0
    } else if x < lo {
        (1.0 - (lo - x) / w).fmax(0.0)
    } else {
        (1.0 - (x - hi) / w).fmax(0.0)
    }
}

#[inline]
pub fn above(x: f32, t: f32, w: f32) -> f32 {
    clamp01((x - t) / w)
}

#[inline]
pub fn below(x: f32, t: f32, w: f32) -> f32 {
    clamp01((t - x) / w)
}

#[inline]
pub fn alpha(dt: f32, tau: f32) -> f32 {
    if tau <= 0.0 {
        1.0
    } else {
        1.0 - (-dt / tau).exp()
    }
}

/// A transposed direct form II biquad (RBJ cookbook coefficients).
#[derive(Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

#[derive(Clone, Copy)]
pub enum Kind {
    Lowpass,
    Highpass,
}

impl Biquad {
    pub fn new(kind: Kind, freq: f32, q: f32, sr: f32) -> Biquad {
        let w = 2.0 * core::f32::consts::PI * (freq / sr).fmin(0.49);
        let (s, c) = w.sin_cos();
        let al = s / (2.0 * q);
        let (b0, b1, b2) = match kind {
            Kind::Lowpass => ((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0),
            Kind::Highpass => ((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0),
        };
        let a0 = 1.0 + al;
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: -2.0 * c / a0,
            a2: (1.0 - al) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    /// Denormals: a decaying tail on a silent input would otherwise crawl
    /// through subnormal numbers, which is a slow path on most CPUs. Checked
    /// once per block of samples rather than on every one of them — two
    /// branches per sample per section was a tenth of the analyser's time.
    #[inline]
    pub fn flush(&mut self) {
        if self.z1.abs() < 1e-20 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-20 {
            self.z2 = 0.0;
        }
    }

}

/// Butterworth Q values for the sections of an order-`2k` cascade.
pub fn butterworth_qs(sections: usize) -> Vec<f32> {
    let n = 2 * sections;
    (0..sections)
        .map(|k| {
            let theta = core::f32::consts::PI * (2 * k + 1) as f32 / (2 * n) as f32;
            1.0 / (2.0 * theta.cos())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_log2_is_close() {
        let mut worst = 0f32;
        let mut x = 1e-6f32;
        while x < 1e6 {
            let e = (fast_log2(x) - x.log2()).abs();
            if e > worst {
                worst = e;
            }
            x *= 1.013;
        }
        assert!(worst < 6e-5, "worst error {}", worst);
    }

    #[test]
    fn butterworth_qs_match_the_tables() {
        let q = butterworth_qs(2);
        assert!((q[0] - 0.5412).abs() < 1e-3 && (q[1] - 1.3066).abs() < 1e-3, "{:?}", q);
    }
}

//! Small numeric helpers shared by every stage: a fast logarithm for the
//! per-bin loops, the fuzzy memberships the classifier is written in, and a
//! biquad for the time-domain taps.

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
        (1.0 - (lo - x) / w).max(0.0)
    } else {
        (1.0 - (x - hi) / w).max(0.0)
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

/// One step of an exponential approach with time constant `tau` seconds.
#[inline]
pub fn approach(cur: f32, target: f32, tau: f32, dt: f32) -> f32 {
    if tau <= 0.0 {
        return target;
    }
    cur + (target - cur) * (1.0 - (-dt / tau).exp())
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
        let w = 2.0 * core::f32::consts::PI * (freq / sr).min(0.49);
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

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
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

/// A deterministic xorshift PRNG for anything that needs noise.
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng(if seed == 0 { 0x9e37_79b9 } else { seed })
    }
    #[inline]
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x >> 8) as f32 / (1u32 << 24) as f32
    }
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

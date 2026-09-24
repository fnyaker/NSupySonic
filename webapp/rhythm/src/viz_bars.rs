//! The spectrum bars' levelling, for the canvas the bars are drawn on where
//! there is no WebGL2 (see lib/viz/scenes/bars.js for the drawing).
//!
//! The reasoning is bars.js's and is unchanged: one global auto-gain parks the
//! bass at the bottom (the mids and highs carry most of the energy and drive
//! the gain down), so the strip is split into three zones — bass, mid, high —
//! each with its own slow gain, interpolated between the zone centres so there
//! is no seam; then a gamma for contrast, a fast attack and a slower release,
//! and peak caps that fall slowly and faster the higher they are.

use crate::util::MinMax;

pub const MAX_BARS: usize = 256;
/// The analyser's bands, at most.
pub const MAX_BANDS: usize = 256;
const CENTRES: [f64; 3] = [1.0 / 6.0, 0.5, 5.0 / 6.0];

#[inline]
fn approach(v: f64, target: f64, tau: f64, dt: f64) -> f64 {
    v + (target - v) * (1.0 - (-dt / tau.fmax(1e-4)).exp())
}

pub struct Bars {
    n: usize,
    input: Vec<f32>,
    grouped: Vec<f32>,
    /// `smooth` in the first MAX_BARS, `peaks` in the next.
    out: Vec<f32>,
    agc: [f64; 3],
    level: f64,
}

impl Bars {
    pub fn new() -> Bars {
        Bars {
            n: 0,
            input: vec![0.0; MAX_BANDS],
            grouped: vec![0.0; MAX_BARS],
            out: vec![0.0; MAX_BARS * 2],
            agc: [0.15; 3],
            level: 0.0,
        }
    }

    pub fn set_count(&mut self, n: usize) {
        let n = n.fmin(MAX_BARS);
        if n == self.n {
            return;
        }
        self.n = n;
        self.grouped.iter_mut().for_each(|v| *v = 0.0);
        self.out.iter_mut().for_each(|v| *v = 0.0);
    }

    pub fn input_ptr(&mut self) -> *mut f32 {
        self.input.as_mut_ptr()
    }

    pub fn output_ptr(&self) -> *const f32 {
        self.out.as_ptr()
    }

    pub fn level(&self) -> f64 {
        self.level
    }

    fn gain_at(gain: &[f64; 3], t: f64) -> f64 {
        if t <= CENTRES[0] {
            return gain[0];
        }
        if t >= CENTRES[2] {
            return gain[2];
        }
        let z = if t < CENTRES[1] { 0 } else { 1 };
        let f = (t - CENTRES[z]) / (CENTRES[z + 1] - CENTRES[z]);
        gain[z] * (1.0 - f) + gain[z + 1] * f
    }

    /// One update: the first `nbands` of the input are this frame's bands.
    pub fn update(&mut self, nbands: usize, level: f64, dt: f64) {
        let n = self.n;
        if n == 0 {
            return;
        }
        let nb = nbands.fmin(MAX_BANDS);
        // Group the bands into bars by the PEAK of each group (bars.js /
        // util.js#groupBands): a loud partial inside a group should show.
        let per = nb as f64 / n as f64;
        for i in 0..n {
            let a = (i as f64 * per).floor() as usize;
            let b = nb.fmin((a + 1).fmax(((i + 1) as f64 * per).floor() as usize));
            let mut m = 0f32;
            for &x in &self.input[a.fmin(nb)..b] {
                if x > m {
                    m = x;
                }
            }
            self.grouped[i] = m;
        }
        self.level = approach(self.level, level, 0.15, dt);

        let mut sum = [0f64; 3];
        let mut cnt = [0f64; 3];
        let nf = n as f64;
        for i in 0..n {
            let fi = i as f64;
            let z = if fi < nf / 3.0 {
                0
            } else if fi < 2.0 * nf / 3.0 {
                1
            } else {
                2
            };
            sum[z] += self.grouped[i] as f64;
            cnt[z] += 1.0;
        }
        let mut gain = [0f64; 3];
        for z in 0..3 {
            let mean = if cnt[z] > 0.0 { sum[z] / cnt[z] } else { 0.0 };
            self.agc[z] = approach(self.agc[z], mean, 0.9, dt);
            gain[z] = 0.62 / self.agc[z].fmax(0.1);
        }
        let (smooth, peaks) = self.out.split_at_mut(MAX_BARS);
        for i in 0..n {
            let t = i as f64 / nf;
            let mut v = (self.grouped[i] as f64 * Self::gain_at(&gain, t)).fmin(1.0);
            v = v.powf(1.7);
            let s = smooth[i] as f64;
            let s = if v > s { approach(s, v, 0.035, dt) } else { approach(s, v, 0.16, dt) };
            smooth[i] = s as f32;
            let s = smooth[i] as f64;
            let p = peaks[i] as f64;
            peaks[i] = if s > p { smooth[i] } else { s.fmax(p - dt * (0.22 + p * 0.35)) as f32 };
        }
    }
}

impl Default for Bars {
    fn default() -> Self {
        Self::new()
    }
}

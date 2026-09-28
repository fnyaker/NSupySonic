//! mulberry32, the generator the JavaScript trainers used for their
//! projections (`rng()` in train.js and deep.js), so a seed means the same
//! stream on both sides. Everything random here comes from ONE of these, seeded
//! by the page: the folds, every shuffle, every initialisation. A run is
//! therefore reproducible, which the JavaScript's `Math.random()` shuffles never
//! were.

pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng(seed)
    }

    /// Uniform in [0, 1).
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }

    /// Uniform integer in [0, n).
    pub fn below(&mut self, n: usize) -> usize {
        ((self.next() * n as f64) as usize).min(n.saturating_sub(1))
    }

    /// Standard normal, by Box-Muller (as the JavaScript drew it).
    pub fn gauss(&mut self) -> f64 {
        let u = self.next().max(1e-12);
        let v = self.next();
        (-2.0 * u.ln()).sqrt() * (2.0 * core::f64::consts::PI * v).cos()
    }

    /// Fisher-Yates, in place.
    pub fn shuffle<T>(&mut self, v: &mut [T]) {
        let mut i = v.len();
        while i > 1 {
            i -= 1;
            let j = self.below(i + 1);
            v.swap(i, j);
        }
    }
}

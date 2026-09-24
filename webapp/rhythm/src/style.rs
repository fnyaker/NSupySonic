//! What kind of music is this, and what is its kick made of — the engine of
//! lib/audio/style.js's classifier, running on the audio thread.
//!
//! The VOCABULARY stays in JavaScript (style.js `FAMILIES`): ids, labels,
//! archetypes, the seven-number look of each family, its tempo range and its
//! RULE, written as data — a product of fuzzy memberships over the frame's
//! descriptors. The table is handed over once (`load_families`) as a flat
//! float array, so the classifier the UI names and the one that runs are the
//! same table by construction, and adding a family is still one line of JS.
//!
//! The arithmetic is the JavaScript's: a tempo-trust damping, weights smoothed
//! over seconds and all but frozen in a quiet passage (the dynamics squared),
//! archetypes and the look vector pooled from the same weights, and a dominant
//! family that changes name only after leading by 20% for a second and a half.
//! What is gone is the garbage: the old classifier built a descriptor object,
//! a list and a sorted copy of every family, ninety times a second.

use crate::util::{above, below, in_range};

pub const N_FEAT: usize = 19;
// Descriptor slots, in the order style.js's RULE_FEATURES names them.
pub const F_BPM: usize = 0;
pub const F_PULSE: usize = 1;
pub const F_KICKPULSE: usize = 2;
pub const F_FLAT: usize = 3;
pub const F_CENTROID: usize = 4;
pub const F_PERC: usize = 5;
pub const F_VOCAL: usize = 6;
pub const F_CREST: usize = 7;
pub const F_LEVEL: usize = 8;
pub const F_SUB: usize = 9;
pub const F_MID: usize = 10;
pub const F_AIR: usize = 11;
pub const F_KSOFT: usize = 12;
pub const F_KHARD: usize = 13;
pub const F_KINDUS: usize = 14;
pub const F_MELODY: usize = 15;
pub const F_TONAL: usize = 16;
pub const F_CHORD: usize = 17;
pub const F_DYN: usize = 18;

pub const LOOK_N: usize = 7;
pub const ARCH_N: usize = 5;

#[derive(Clone, Copy)]
struct Term {
    op: u8,
    a: usize,
    b: usize,
    p1: f32,
    p2: f32,
    p3: f32,
}

struct Family {
    arch: usize,
    tempo_free: bool,
    look: [f32; LOOK_N],
    range: (f32, f32),
    terms: Vec<Term>,
}

// --- the kick's SHAPE ---------------------------------------------------------
// soft / hard / industrial from attack, decay, click and grit, blended per hit.
pub struct KickShape {
    capturing: bool,
    t0: f64,
    peak_low: f32,
    peak_at: f64,
    peak_high: f32,
    flat_sum: f32,
    flat_n: f32,
    decay_at: f64,
    pub soft: f32,
    pub hard: f32,
    pub indus: f32,
    pub kind: u8,
    pub strength: f32,
    pub attack: f32,
    pub decay: f32,
    pub click: f32,
    pub grit: f32,
    pub hit: bool,
}

impl KickShape {
    fn new() -> KickShape {
        KickShape {
            capturing: false,
            t0: 0.0,
            peak_low: 0.0,
            peak_at: 0.0,
            peak_high: 0.0,
            flat_sum: 0.0,
            flat_n: 0.0,
            decay_at: 0.0,
            soft: 1.0 / 3.0,
            hard: 1.0 / 3.0,
            indus: 1.0 / 3.0,
            kind: 0,
            strength: 0.0,
            attack: 0.0,
            decay: 0.0,
            click: 0.0,
            grit: 0.0,
            hit: false,
        }
    }

    fn reset(&mut self) {
        *self = KickShape::new();
    }

    /// One output frame. `kick_at` is the onset of a confirmed kick in this
    /// frame, if any.
    fn process(&mut self, kick_at: Option<f64>, low_lin: f32, high_lin: f32, flatness: f32, now: f64) {
        self.hit = false;
        if let Some(t) = kick_at {
            if self.capturing {
                self.finish(now);
            }
            self.capturing = true;
            self.t0 = t;
            self.peak_low = low_lin;
            self.peak_at = now;
            self.peak_high = high_lin;
            self.flat_sum = flatness;
            self.flat_n = 1.0;
            self.decay_at = 0.0;
        } else if self.capturing {
            if low_lin > self.peak_low {
                self.peak_low = low_lin;
                self.peak_at = now;
            }
            if high_lin > self.peak_high {
                self.peak_high = high_lin;
            }
            self.flat_sum += flatness;
            self.flat_n += 1.0;
            if self.decay_at == 0.0 && low_lin < self.peak_low * 0.25 && now - self.peak_at > 0.01 {
                self.decay_at = now;
            }
            if now - self.t0 > 0.42 || (self.decay_at > 0.0 && now - self.decay_at > 0.02) {
                self.finish(now);
            }
        }
        let mut best = 0;
        let s = [self.soft, self.hard, self.indus];
        for k in 1..3 {
            if s[k] > s[best] {
                best = k;
            }
        }
        self.kind = best as u8;
    }

    fn finish(&mut self, now: f64) {
        self.capturing = false;
        let attack = ((self.peak_at - self.t0) as f32).max(0.004);
        let end = if self.decay_at > 0.0 { self.decay_at } else { now };
        let decay = (end - self.peak_at) as f32;
        let click = if self.peak_low > 1e-9 { self.peak_high / self.peak_low } else { 0.0 };
        let grit = if self.flat_n > 0.0 { self.flat_sum / self.flat_n } else { 0.0 };
        let soft = below(click, 0.16, 0.16) * below(grit, 0.36, 0.26) * above(decay, 0.06, 0.16);
        let hard = above(click, 0.09, 0.14) * below(attack, 0.05, 0.05) * in_range(grit, 0.16, 0.52, 0.24);
        let indus = above(grit, 0.36, 0.25) * above(click, 0.18, 0.22) * above(decay, 0.05, 0.12);
        let total = soft + hard + indus;
        if total > 1e-6 {
            let k = 0.35;
            self.soft += (soft / total - self.soft) * k;
            self.hard += (hard / total - self.hard) * k;
            self.indus += (indus / total - self.indus) * k;
        }
        self.attack = attack;
        self.decay = decay;
        self.click = click;
        self.grit = grit;
        self.strength = ((1.0 + self.peak_low * 40.0).log10() * 0.6).clamp(0.0, 1.0);
        self.hit = true;
    }
}

pub struct Style {
    families: Vec<Family>,
    weights: Vec<f32>,
    raw: Vec<f32>,
    pub s: [f32; N_FEAT],
    pub arche: [f32; ARCH_N],
    pub look: [f32; LOOK_N],
    pub dominant: i32,
    pending: i32,
    pending_since: f64,
    pub confidence: f32,
    pub top: [(i32, f32); 3],
    pub kick: KickShape,
}

impl Style {
    pub fn new() -> Style {
        Style {
            families: Vec::new(),
            weights: Vec::new(),
            raw: Vec::new(),
            s: [0.0; N_FEAT],
            arche: [0.2; ARCH_N],
            look: [0.5; LOOK_N],
            dominant: -1,
            pending: -1,
            pending_since: 0.0,
            confidence: 0.0,
            top: [(-1, 0.0); 3],
            kick: KickShape::new(),
        }
    }

    /// The family table, flattened by style.js#familyTable:
    ///   [count, then per family: arch, tempoFree, look x7, rangeLo, rangeHi,
    ///    nTerms, then per term: op, a, b, p1, p2, p3]
    pub fn load_families(&mut self, t: &[f32]) -> bool {
        let mut fams = Vec::new();
        let mut i = 0;
        let next = |i: &mut usize| -> Option<f32> {
            let v = t.get(*i).copied();
            *i += 1;
            v
        };
        let count = match next(&mut i) {
            Some(v) if v >= 1.0 && v < 512.0 => v as usize,
            _ => return false,
        };
        for _ in 0..count {
            let arch = next(&mut i).unwrap_or(2.0) as usize;
            let tempo_free = next(&mut i).unwrap_or(0.0) > 0.5;
            let mut look = [0f32; LOOK_N];
            for l in look.iter_mut() {
                *l = next(&mut i).unwrap_or(0.5);
            }
            let lo = next(&mut i).unwrap_or(0.0);
            let hi = next(&mut i).unwrap_or(0.0);
            let n = next(&mut i).unwrap_or(0.0) as usize;
            if n > 32 {
                return false;
            }
            let mut terms = Vec::with_capacity(n);
            for _ in 0..n {
                let op = next(&mut i).unwrap_or(0.0) as u8;
                let a = (next(&mut i).unwrap_or(0.0) as usize).min(N_FEAT - 1);
                let b = (next(&mut i).unwrap_or(0.0) as usize).min(N_FEAT - 1);
                let p1 = next(&mut i).unwrap_or(0.0);
                let p2 = next(&mut i).unwrap_or(0.0);
                let p3 = next(&mut i).unwrap_or(0.0);
                terms.push(Term { op, a, b, p1, p2, p3 });
            }
            if i > t.len() {
                return false;
            }
            fams.push(Family { arch: arch.min(ARCH_N - 1), tempo_free, look, range: (lo, hi), terms });
        }
        self.weights = vec![0.0; fams.len()];
        self.raw = vec![0.0; fams.len()];
        self.families = fams;
        self.reset();
        true
    }

    pub fn reset(&mut self) {
        self.kick.reset();
        self.weights.iter_mut().for_each(|w| *w = 0.0);
        self.dominant = -1;
        self.pending = -1;
        self.confidence = 0.0;
        self.top = [(-1, 0.0); 3];
        self.arche = [0.2; ARCH_N];
    }

    pub fn family_count(&self) -> usize {
        self.families.len()
    }

    pub fn range_of(&self, id: i32) -> Option<(f32, f32)> {
        let f = self.families.get(id as usize)?;
        if f.range.1 > f.range.0 && f.range.0 > 0.0 {
            Some(f.range)
        } else {
            None
        }
    }

    fn eval(&self, f: &Family, tempo_trust: f32) -> f32 {
        let s = &self.s;
        let mut w = 1f32;
        for t in &f.terms {
            let v = match t.op {
                0 => t.p1,
                1 => in_range(s[t.a], t.p1, t.p2, t.p3),
                2 => above(s[t.a], t.p1, t.p2),
                3 => below(s[t.a], t.p1, t.p2),
                4 => s[t.a] * t.p1,
                5 => (s[t.a] * t.p1).max(s[t.b] * t.p2),
                _ => 1.0,
            };
            w *= v;
            if w <= 0.0 {
                return 0.0;
            }
        }
        if !f.tempo_free {
            w *= tempo_trust;
        }
        w.max(0.0)
    }

    /// One output frame. `s` must already hold this frame's descriptors
    /// except the kick-shape slots, which are filled here.
    pub fn process(&mut self, locked: bool, confidence: f32, dyn_: f32, now: f64, dt: f32) {
        self.s[F_KSOFT] = self.kick.soft;
        self.s[F_KHARD] = self.kick.hard;
        self.s[F_KINDUS] = self.kick.indus;
        if self.families.is_empty() {
            return;
        }
        let tempo_trust = if locked { (confidence * 1.6).clamp(0.25, 1.0) } else { 0.0 };
        let mut sum = 0f32;
        for i in 0..self.families.len() {
            let w = self.eval(&self.families[i], tempo_trust);
            self.raw[i] = w;
            sum += w;
        }
        let a = (1.0 - (-dt / 2.5).exp()) * (0.04 + 0.96 * dyn_ * dyn_);
        if sum < 1e-4 {
            for w in self.weights.iter_mut() {
                *w *= 1.0 - a;
            }
        } else {
            for i in 0..self.weights.len() {
                self.weights[i] += (self.raw[i] / sum - self.weights[i]) * a;
            }
        }
        self.arche = [0.0; ARCH_N];
        self.look = [0.0; LOOK_N];
        let mut wsum = 0f32;
        let mut top = [(-1i32, -1f32); 3];
        for (i, f) in self.families.iter().enumerate() {
            let w = self.weights[i];
            if w > top[0].1 {
                top[2] = top[1];
                top[1] = top[0];
                top[0] = (i as i32, w);
            } else if w > top[1].1 {
                top[2] = top[1];
                top[1] = (i as i32, w);
            } else if w > top[2].1 {
                top[2] = (i as i32, w);
            }
            if w <= 0.0 {
                continue;
            }
            self.arche[f.arch] += w;
            for k in 0..LOOK_N {
                self.look[k] += f.look[k] * w;
            }
            wsum += w;
        }
        if wsum > 1e-6 {
            for v in self.arche.iter_mut() {
                *v /= wsum;
            }
            for v in self.look.iter_mut() {
                *v /= wsum;
            }
        } else {
            // Nothing yet: the neutral groove look.
            self.look = self.families.get(0).map(|_| [0.56, 0.58, 0.58, 0.5, 0.5, 0.45, 0.16]).unwrap_or([0.5; LOOK_N]);
            self.arche = [0.0, 0.0, 1.0, 0.0, 0.0];
        }
        self.top = top;
        let (best, best_w) = top[0];
        if self.dominant < 0 {
            self.dominant = best;
        } else if best != self.dominant && best >= 0 {
            let cur = self.weights[self.dominant as usize];
            if best_w > cur * 1.2 {
                if self.pending != best {
                    self.pending = best;
                    self.pending_since = now;
                } else if now - self.pending_since > 1.5 {
                    self.dominant = best;
                    self.pending = -1;
                }
            } else {
                self.pending = -1;
            }
        } else {
            self.pending = -1;
        }
        let t0 = top[0].1.max(0.0);
        let t1 = top[1].1.max(0.0);
        self.confidence = (t0 * 2.4 * (0.45 + 0.55 * if t0 > 1e-6 { (t0 - t1) / t0 } else { 0.0 })).clamp(0.0, 1.0);
    }

    /// Every family's smoothed weight, in table order.
    pub fn weights(&self) -> &[f32] {
        &self.weights
    }

    /// The kick-shape half, per output frame.
    pub fn kick_frame(&mut self, kick_at: Option<f64>, low_lin: f32, high_lin: f32, flatness: f32, now: f64) {
        self.kick.process(kick_at, low_lin, high_lin, flatness, now);
    }
}

impl Default for Style {
    fn default() -> Self {
        Self::new()
    }
}

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
// soft / hard / industrial, blended per kick, from what the kick detector
// (kick.rs) measured on the kick itself — never from the mix around it.
//
// The old reading compared the bottom of the spectrum with the top at the
// kick (a "click" ratio) and its thresholds sat three orders of magnitude
// above anything that ratio ever reached, so on every record of the eval the
// three weights stayed at a third each and every rule written on them (the
// uptempo family multiplies by the industrial weight) was running blind.
// Measured instead, per accepted kick, on the eval's 26 records:
//
//   where the pitch starts   160-200 Hz for rawstyle, frenchcore, uptempo,
//                            krach, gabber and speedcore; 50-100 Hz for
//                            techno, house, trap, pop, rock and metal.
//                            Hardstyle's fast sweep reads 105 Hz on its first
//                            full cycle, but falls by a factor of 1.9 — the
//                            DROP is the other half of "pitched".
//   how noisy the body is    spectral flatness over the three frames after
//                            the onset: 0.55-0.61 for uptempo, zaag and krach
//                            against 0.44-0.48 for rawstyle, frenchcore and
//                            gabber — the distortion that makes a kick
//                            "industrial" rather than merely hard.
//
// Neither number means anything for a soft kick (a hi-hat over it moves the
// flatness), which is why grit only splits the HARD share.
pub struct KickShape {
    capturing: bool,
    t0: f64,
    peak_low: f32,
    peak_at: f64,
    decay_at: f64,
    // The kick being measured: its pitch and how reliable that is, and the
    // flatness of the frames after it.
    f0: f32,
    f1: f32,
    trust: f32,
    flat_sum: f32,
    flat_n: f32,
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

/// What the detector said about one kick (lib.rs `Hit::detail`).
#[derive(Clone, Copy, Default)]
pub struct KickSeen {
    pub t: f64,
    pub strength: f32,
    pub f0: f32,
    pub f1: f32,
    /// 1 = found by its pitch sweep, 2 = by the jump in the bottom octave.
    pub path: f32,
    /// The beater's crack, dB over what preceded it.
    pub click: f32,
}

#[inline]
fn ramp(x: f32, lo: f32, hi: f32) -> f32 {
    ((x - lo) / (hi - lo)).clamp(0.0, 1.0)
}

impl KickShape {
    fn new() -> KickShape {
        KickShape {
            capturing: false,
            t0: 0.0,
            peak_low: 0.0,
            peak_at: 0.0,
            decay_at: 0.0,
            f0: 0.0,
            f1: 0.0,
            trust: 0.0,
            flat_sum: 0.0,
            flat_n: 0.0,
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

    /// One output frame: `kick` is the kick this frame carries, if any.
    fn process(&mut self, kick: Option<KickSeen>, low_lin: f32, flatness: f32, now: f64) {
        self.hit = false;
        if let Some(k) = kick {
            if self.capturing {
                self.finish(now);
            }
            self.capturing = true;
            self.t0 = k.t;
            self.peak_low = low_lin;
            self.peak_at = now;
            self.decay_at = 0.0;
            self.f0 = k.f0;
            self.f1 = k.f1;
            // A pitch read cycle by cycle over a sweep is a measurement; one
            // read after a jump in level is an estimate.
            self.trust = if k.path == 1.0 { 1.0 } else { 0.5 };
            self.flat_sum = 0.0;
            self.flat_n = 0.0;
            self.click = (k.click / 40.0).clamp(0.0, 1.0);
            self.strength = k.strength.clamp(0.0, 1.0);
        } else if self.capturing {
            if low_lin > self.peak_low {
                self.peak_low = low_lin;
                self.peak_at = now;
            }
            if self.flat_n < 3.0 {
                self.flat_sum += flatness;
                self.flat_n += 1.0;
            }
            if self.decay_at == 0.0 && low_lin < self.peak_low * 0.25 && now - self.peak_at > 0.01 {
                self.decay_at = now;
            }
            if now - self.t0 > 0.42 || (self.decay_at > 0.0 && now - self.decay_at > 0.02 && self.flat_n >= 3.0) {
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
        if self.flat_n < 1.0 {
            return;
        }
        self.attack = ((self.peak_at - self.t0) as f32).max(0.004);
        let end = if self.decay_at > 0.0 { self.decay_at } else { now };
        self.decay = (end - self.peak_at) as f32;
        self.grit = self.flat_sum / self.flat_n;
        // Pitched: the sweep starts high, or it starts in the kick range and
        // falls a long way.
        let drop = if self.f1 > 0.0 { self.f0 / self.f1 } else { 1.0 };
        let pitched = ramp(self.f0, 100.0, 160.0).max(ramp(drop, 1.4, 2.0) * ramp(self.f0, 80.0, 110.0));
        let noisy = ramp(self.grit, 0.47, 0.57);
        let soft = 1.0 - pitched;
        let hard = pitched * (1.0 - noisy);
        let indus = pitched * noisy;
        let k = 0.35 * self.trust;
        self.soft += (soft - self.soft) * k;
        self.hard += (hard - self.hard) * k;
        self.indus += (indus - self.indus) * k;
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
            arche: [0.0, 0.0, 1.0, 0.0, 0.0],
            look: [0.56, 0.58, 0.58, 0.5, 0.5, 0.45, 0.16],
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
        // The look and the archetypes are NOT reset: a new track eases the
        // picture from where the last one left it, rather than snapping it to
        // neutral for the length of a dissolve.
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
        let mut arche = [0f32; ARCH_N];
        let mut look = [0f32; LOOK_N];
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
            arche[f.arch] += w;
            for k in 0..LOOK_N {
                look[k] += f.look[k] * w;
            }
            wsum += w;
        }
        // Normalised, the weights of an opinion only just forming are all
        // noise: the first family to clear zero owned the whole look for a
        // frame, and the next one took it over — measured, a single-frame step
        // of 0.22 in the look of an uptempo record. So the neutral groove look
        // is blended out as the evidence (the weights' own total) comes in,
        // and the result is eased over most of a second: a renderer must never
        // see the picture it is blending toward jump.
        const NEUTRAL: [f32; LOOK_N] = [0.56, 0.58, 0.58, 0.5, 0.5, 0.45, 0.16];
        const NEUTRAL_ARCH: [f32; ARCH_N] = [0.0, 0.0, 1.0, 0.0, 0.0];
        let formed = (wsum * 4.0).clamp(0.0, 1.0);
        let norm = if wsum > 1e-6 { 1.0 / wsum } else { 0.0 };
        let a = 1.0 - (-dt / 0.8).exp();
        for k in 0..ARCH_N {
            let target = arche[k] * norm * formed + NEUTRAL_ARCH[k] * (1.0 - formed);
            self.arche[k] += (target - self.arche[k]) * a;
        }
        for k in 0..LOOK_N {
            let target = look[k] * norm * formed + NEUTRAL[k] * (1.0 - formed);
            self.look[k] += (target - self.look[k]) * a;
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
    pub fn kick_frame(&mut self, kick: Option<KickSeen>, low_lin: f32, flatness: f32, now: f64) {
        self.kick.process(kick, low_lin, flatness, now);
    }
}

impl Default for Style {
    fn default() -> Self {
        Self::new()
    }
}

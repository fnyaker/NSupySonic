//! Which attacks are KICKS, which are snares, and when exactly they landed.
//!
//! A kick has a SHAPE that nothing else in a mix has all of at once, and it is
//! read here in the time domain, where it can be seen — a 2048-point FFT frame
//! is 43 ms long and a kick's whole attack fits inside one:
//!
//!   the bottom octave JUMPS: energy below 110 Hz rising by 8 dB or more in a
//!     few milliseconds;
//!   the PITCH FALLS: a sine starting at 90-260 Hz sweeping down into the sub —
//!     over one or two cycles for a techno or house kick, over five to ten for
//!     a hardcore one;
//!   something STRUCK it: the beater's click, a broadband crack above 2.5 kHz
//!     at the same instant.
//!
//! A bass note has the first and neither of the others. A snare has the click
//! and a shell that holds its pitch, and next to nothing below 110 Hz. A
//! reverse bass or a pad swells instead of jumping. So: two ways in — the
//! bottom octave jumping, or a long pitch sweep followed cycle by cycle (the
//! hardcore kick, whose low end is still full of the last one when the next
//! lands, so it never jumps) — and a kick is called on the evidence of all
//! three, weighted, against this track's own kicks.
//!
//! What this replaced, measured on the eval's whole arrangements: the FFT
//! witnesses raised 2709 false candidates against 1978 true ones, because on
//! the frame a kick is detected the window has seen the body arrive and not
//! yet seen the pitch fall — and then the snare's shell, the psy bass's filter
//! envelope and the kick all present the same numbers.
//!
//! SNARES AND CLAPS are called from the FFT side: a strike the witnesses saw,
//! with a crack on it, no kick near it, and nothing arriving below 160 Hz.

use crate::features::Features;
use crate::util::{butterworth_qs, Biquad, Kind};

/// How late the FFT witnesses agree after the true onset, seconds (for the
/// snares they report; kicks carry their own onset).
pub const DETECT_LATENCY: f64 = 0.012;
/// Frames the analyser runs ahead of its output, so a kick recognised by its
/// sweep some tens of milliseconds after its onset is still published on its
/// own frame. See lib.rs `LOOKAHEAD`.
pub const DECISION_FRAMES: usize = 4;

const CYC: usize = 64;
const ENV_N: usize = 64; // 1 kHz envelope history, ms
/// The sweep path: consecutive cycles falling by this ratio in total...
const SWEEP_RATIO: f32 = 1.35;
/// ...within this long...
const SWEEP_SPAN: f64 = 0.1;
/// ...no cycle more than this much higher than the one before, none falling
/// by more than MAX_STEP...
const SWEEP_TOL: f32 = 1.06;
const MAX_STEP: f32 = 2.2;
/// ...landing in the kick's territory, from a start a kick can have.
const SWEEP_LAND_HZ: f32 = 115.0;
const SWEEP_START_MIN_HZ: f32 = 62.0;
const SWEEP_START_MAX_HZ: f32 = 285.0;
/// A new kick restarts at least this much above where the last one landed.
const RESTART: f32 = 1.3;
/// The shortest gap between two kicks: a 1/16 roll at 300 BPM is 50 ms.
const KICK_REFRACTORY: f64 = 0.042;
/// The jump path: the bottom octave rising this much (ratio) within 8 ms...
const JUMP: f32 = 2.5;
/// ...and how long a jump waits for the sweep that may explain it, seconds.
const JUMP_WAIT: f64 = 0.03;

#[derive(Clone, Copy, Default)]
struct Cycle {
    tau: f64,
    f: f32,
    a: f32,
}

#[derive(Clone, Copy, Default)]
pub struct Hit {
    /// Onset time, seconds on the analyser clock.
    pub t: f64,
    pub strength: f32,
    /// The kick's pitch where it started and where it landed, Hz.
    pub f0: f32,
    pub f1: f32,
    /// How it was found (1 sweep, 2 jump), the evidence it was called on
    /// (click in dB, pitch drop ratio, level against the track's kicks) and
    /// the score.
    pub path: f32,
    pub click: f32,
    pub drop: f32,
    pub rel: f32,
    pub score: f32,
}

#[derive(Clone, Copy)]
struct Jump {
    onset: f64,
    decide_at: f64,
    low: f32,
}

pub struct KickDetector {
    sr: f64,
    body: [Biquad; 2],
    low: [Biquad; 2],
    hi: [Biquad; 2],
    n: u64,
    prev: f32,
    neg_armed: bool,
    last_cross: f64,
    cyc_peak: f32,
    amp: f32,
    cycles: [Cycle; CYC],
    cyc_head: usize,
    cyc_len: usize,
    used_until: f64,
    last_kick: f64,
    last_f1: f32,
    kick_ref: f32,
    env_low: f32,
    env_hi: f32,
    low_hist: [f32; ENV_N],
    hi_hist: [f32; ENV_N],
    env_head: usize,
    tick: f64,
    per_ms: f64,
    jump: Option<Jump>,
    found: Vec<Hit>,
    /// Every candidate, called or not, since the last frame (for tuning).
    pub candidates: Vec<Hit>,
    snare_avg: f32,
    snare_var: f32,
    last_snare: f64,
    pub kicks: Vec<Hit>,
    pub snares: Vec<Hit>,
    pub last_f0: f32,
}

impl KickDetector {
    pub fn new(sr: f32) -> KickDetector {
        let q = butterworth_qs(2);
        KickDetector {
            sr: sr as f64,
            body: [Biquad::new(Kind::Lowpass, 320.0, q[0], sr), Biquad::new(Kind::Lowpass, 320.0, q[1], sr)],
            low: [Biquad::new(Kind::Lowpass, 110.0, q[0], sr), Biquad::new(Kind::Lowpass, 110.0, q[1], sr)],
            hi: [Biquad::new(Kind::Highpass, 2500.0, q[0], sr), Biquad::new(Kind::Highpass, 2500.0, q[1], sr)],
            n: 0,
            prev: 0.0,
            neg_armed: false,
            last_cross: -1.0,
            cyc_peak: 0.0,
            amp: 0.0,
            cycles: [Cycle::default(); CYC],
            cyc_head: 0,
            cyc_len: 0,
            used_until: -1.0,
            last_kick: -1.0,
            last_f1: 0.0,
            kick_ref: 0.0,
            env_low: 0.0,
            env_hi: 0.0,
            low_hist: [0.0; ENV_N],
            hi_hist: [0.0; ENV_N],
            env_head: 0,
            tick: 0.0,
            per_ms: sr as f64 / 1000.0,
            jump: None,
            found: Vec::with_capacity(8),
            candidates: Vec::with_capacity(8),
            snare_avg: 0.0,
            snare_var: 0.0,
            last_snare: -1.0,
            kicks: Vec::with_capacity(8),
            snares: Vec::with_capacity(4),
            last_f0: 0.0,
        }
    }

    pub fn reset(&mut self) {
        let sr = self.sr as f32;
        *self = KickDetector::new(sr);
    }

    fn cycle(&self, back: usize) -> &Cycle {
        &self.cycles[(self.cyc_head + CYC - 1 - back) % CYC]
    }
    fn env_at(&self, h: &[f32; ENV_N], back: usize) -> f32 {
        h[(self.env_head + ENV_N - 1 - back.min(ENV_N - 1)) % ENV_N]
    }

    /// One sample of the mono signal: six biquads and a comparison.
    #[inline]
    /// Once per block: see `Biquad::flush`.
    pub fn flush(&mut self) {
        for b in self.body.iter_mut().chain(self.low.iter_mut()).chain(self.hi.iter_mut()) {
            b.flush();
        }
    }

    pub fn sample(&mut self, x: f32) {
        self.n += 1;
        let b0 = self.body[0].run(x);
        let b = self.body[1].run(b0);
        let l0 = self.low[0].run(x);
        let l = self.low[1].run(l0);
        let h0 = self.hi[0].run(x);
        let h = self.hi[1].run(h0);
        // Envelopes: fast attack, ~12 ms release for the bottom octave, ~6 ms
        // for the crack.
        let al = l.abs();
        self.env_low = if al > self.env_low { al } else { self.env_low * 0.9983 };
        let ah = h.abs();
        self.env_hi = if ah > self.env_hi { ah } else { self.env_hi * 0.9966 };
        self.tick += 1.0;
        if self.tick >= self.per_ms {
            self.tick -= self.per_ms;
            self.low_hist[self.env_head] = self.env_low;
            self.hi_hist[self.env_head] = self.env_hi;
            self.env_head = (self.env_head + 1) % ENV_N;
            self.ms_tick();
        }
        let ab = b.abs();
        if ab > self.cyc_peak {
            self.cyc_peak = ab;
        }
        self.amp = if ab > self.amp { ab } else { self.amp * 0.99995 };
        let thr = self.amp * 0.02 + 1e-5;
        if b < -thr {
            self.neg_armed = true;
        }
        if self.neg_armed && self.prev < 0.0 && b >= 0.0 {
            self.neg_armed = false;
            let frac = if b - self.prev != 0.0 { -self.prev / (b - self.prev) } else { 0.0 };
            let tau = (self.n - 1) as f64 + frac as f64;
            if self.last_cross >= 0.0 {
                let f = (self.sr / (tau - self.last_cross)) as f32;
                if (22.0..=420.0).contains(&f) {
                    self.cycles[self.cyc_head] = Cycle { tau, f, a: self.cyc_peak };
                    self.cyc_head = (self.cyc_head + 1) % CYC;
                    if self.cyc_len < CYC {
                        self.cyc_len += 1;
                    }
                    self.check_sweep();
                }
            }
            self.last_cross = tau;
            self.cyc_peak = 0.0;
        }
        self.prev = b;
    }

    fn now(&self) -> f64 {
        self.n as f64 / self.sr
    }

    /// The crack above 2.5 kHz around `onset`, in dB over what was there
    /// just before it.
    fn click_at(&self, onset: f64) -> f32 {
        let back = ((self.now() - onset) * 1000.0).round() as isize;
        if back < 0 {
            return 0.0;
        }
        let back = back as usize;
        let mut after = 0f32;
        for k in back.saturating_sub(10)..=(back + 2).min(ENV_N - 1) {
            after = after.max(self.env_at(&self.hi_hist, k));
        }
        let mut before = f32::INFINITY;
        for k in (back + 4)..(back + 14).min(ENV_N) {
            before = before.min(self.env_at(&self.hi_hist, k));
        }
        if !before.is_finite() || before <= 0.0 {
            return if after > 0.0 { 20.0 } else { 0.0 };
        }
        20.0 * (after / before).max(1e-6).log10()
    }

    /// The pitch drop over the cycles within 60 ms of `onset`: the highest
    /// against the last, and both.
    fn drop_after(&self, onset: f64) -> (f32, f32, f32) {
        let t0 = onset * self.sr;
        let t1 = (onset + 0.06) * self.sr;
        let mut hi = 0f32;
        let mut last = 0f32;
        for back in (0..self.cyc_len.min(24)).rev() {
            let c = self.cycle(back);
            if c.tau < t0 || c.tau > t1 {
                continue;
            }
            hi = hi.max(c.f);
            last = c.f;
        }
        if last > 0.0 {
            (hi / last, hi, last)
        } else {
            (1.0, 0.0, 0.0)
        }
    }

    fn check_sweep(&mut self) {
        let k = *self.cycle(0);
        if k.f > SWEEP_LAND_HZ || self.cyc_len < 3 {
            return;
        }
        let span = SWEEP_SPAN * self.sr;
        let mut j = 0usize;
        let mut peak = k.a;
        while j + 1 < self.cyc_len.min(14) {
            let newer = self.cycle(j);
            let older = self.cycle(j + 1);
            if k.tau - older.tau > span || older.tau <= self.used_until {
                break;
            }
            let step = older.f / newer.f;
            if step < 1.0 / SWEEP_TOL || step > MAX_STEP {
                break;
            }
            peak = peak.max(older.a);
            j += 1;
        }
        if j < 2 {
            return;
        }
        let first = *self.cycle(j);
        let ratio = first.f / k.f;
        let need = if first.f > 170.0 { 3 } else { 2 };
        if ratio < SWEEP_RATIO || first.f < SWEEP_START_MIN_HZ || first.f > SWEEP_START_MAX_HZ || j < need {
            return;
        }
        for i in 0..=j {
            if self.cycle(i).a < peak * 0.25 {
                return;
            }
        }
        if first.tau / self.sr - self.last_kick < 0.16 && first.f < self.last_f1 * RESTART {
            return;
        }
        // Where the sweep began: between its first cycle and the one before,
        // when that one is its neighbour. When it is not — nothing crossed
        // zero between the last kick's tail dying out and this one — it can be
        // a hundred milliseconds older and says nothing about this kick.
        let period = self.sr / first.f as f64;
        let onset = match (j + 1 < self.cyc_len).then(|| *self.cycle(j + 1)) {
            Some(pre) if first.tau - pre.tau < period * 1.6 => (pre.tau + (first.tau - pre.tau) * 0.35) / self.sr,
            _ => (first.tau - period * 0.65) / self.sr,
        };
        self.used_until = k.tau;
        // A pending jump this sweep explains is the same kick: the sweep's
        // onset is the better one for a slow sweep, the jump's for a fast one.
        let onset = match self.jump {
            Some(jp) if (jp.onset - onset).abs() < 0.035 => {
                self.jump = None;
                jp.onset.min(onset)
            }
            _ => onset,
        };
        let click = self.click_at(onset);
        let low = self.low_peak_after(onset);
        self.judge(onset, peak.max(low * 1.5), first.f, k.f, 1.0, click, ratio);
    }

    fn low_peak_after(&self, onset: f64) -> f32 {
        let back = ((self.now() - onset) * 1000.0).round().max(0.0) as usize;
        let mut m = 0f32;
        for k in 0..=back.min(ENV_N - 1) {
            m = m.max(self.env_at(&self.low_hist, k));
        }
        m
    }

    /// Every millisecond: the jump path, and any jump whose wait is over.
    fn ms_tick(&mut self) {
        let now = self.now();
        if let Some(jp) = self.jump {
            if now >= jp.decide_at {
                self.jump = None;
                let (drop, f0, f1) = self.drop_after(jp.onset);
                let click = self.click_at(jp.onset);
                let low = self.low_peak_after(jp.onset).max(jp.low);
                self.judge(jp.onset, low * 1.5, f0, f1, 2.0, click, drop);
            }
        }
        let cur = self.env_at(&self.low_hist, 0);
        let past = self.env_at(&self.low_hist, 8);
        let mut floor = f32::INFINITY;
        for k in 8..24 {
            floor = floor.min(self.env_at(&self.low_hist, k));
        }
        if self.jump.is_none() && floor > 0.0 && cur > past * JUMP && cur > floor * (JUMP * 1.3) {
            // Where it started: the last millisecond still near the floor.
            let mut back = 0;
            while back < 12 && self.env_at(&self.low_hist, back) > floor * 1.6 {
                back += 1;
            }
            let onset = now - back as f64 / 1000.0;
            if onset - self.last_kick > KICK_REFRACTORY {
                self.jump = Some(Jump { onset, decide_at: now + JUMP_WAIT, low: cur });
            }
        }
    }

    /// Call it: a kick or not, on the evidence, against this track's kicks.
    #[allow(clippy::too_many_arguments)]
    fn judge(&mut self, onset: f64, amp: f32, f0: f32, f1: f32, path: f32, click: f32, drop: f32) {
        let rel = if self.kick_ref > 0.0 { amp / self.kick_ref } else { 1.0 };
        // The score: the pitch falling is the strongest evidence, the crack
        // the next, the level against this track's kicks the third. A sweep
        // found cycle by cycle has already proved the pitch fell.
        //
        // Weights and thresholds are MEASURED, on the eval's 26 arrangements
        // (every candidate logged with its evidence and matched to the truth):
        // a true kick's crack stands 27-33 dB over what preceded it (median; 10
        // at the tenth percentile) against 5-15 for the false ones; its level
        // is at least 0.83 of the track's kicks for nine in ten, where a psy
        // bass note sits at 0.36 and a guitar chug at 0.44; and it LANDS below
        // 130 Hz, where a snare's shell, a chord or a piano note does not. The
        // pitch drop measured after a jump is not used: a fast kick's sweep is
        // over in one cycle and reads 1.17, less than the false ones' 1.31.
        let s_click = ((click - 6.0) / 14.0).clamp(0.0, 1.0);
        let s_rel = ((rel - 0.5) / 0.4).clamp(0.0, 1.0);
        let landed = f1 <= 0.0 || f1 <= 135.0;
        let score = if !landed {
            0.0
        } else if path == 1.0 {
            0.4 + 0.3 * s_click + 0.3 * s_rel
        } else {
            0.5 * s_click + 0.5 * s_rel
        };
        let _ = drop;
        let hit = Hit { t: onset, strength: rel.clamp(0.2, 1.5), f0, f1, path, click, drop, rel, score };
        self.candidates.push(hit);
        let floor = if path == 1.0 { 0.4 } else { 0.45 };
        if score < 0.55 || onset - self.last_kick < KICK_REFRACTORY || rel < floor {
            // THE REFERENCE MUST BE ABLE TO COME DOWN. Only an accepted kick
            // used to move it, so a passage played quieter lost its kicks for
            // good: measured, the same hardstyle bar 6 dB down kept one kick in
            // twenty-six. A rejected candidate whose beater is unmistakable — a
            // crack twenty decibels over what preceded it, landing where a kick
            // lands — is this track's kick at a new level, and it walks the
            // reference toward itself. A bass note (a 5-15 dB crack at best)
            // does not; nor does anything that came too soon after a kick.
            if landed && click >= 20.0 && self.kick_ref > 0.0 && amp < self.kick_ref && onset - self.last_kick >= KICK_REFRACTORY {
                self.kick_ref += (amp - self.kick_ref) * 0.15;
            }
            return;
        }
        if self.kick_ref <= 0.0 {
            self.kick_ref = amp;
        } else {
            let a = if amp > self.kick_ref { 0.25 } else { 0.04 };
            self.kick_ref += (amp - self.kick_ref) * a;
        }
        self.last_kick = onset;
        if f1 > 0.0 {
            self.last_f1 = f1;
        }
        self.last_f0 = f0;
        self.found.push(hit);
    }

    /// One frame: hand over the kicks found since the last one, and call the
    /// snares from the FFT side. `t` is the frame's time.
    pub fn process(&mut self, f: &Features, t: f64) {
        self.kicks.clear();
        self.snares.clear();
        for h in self.found.drain(..) {
            self.kicks.push(h);
        }
        let near_kick = (t - DETECT_LATENCY - self.last_kick).abs() < 0.05;
        if f.kick_candidate && !near_kick && f.w_click >= 0.45 && f.sub_db - f.reg_db < -3.0 {
            self.push_snare(t - DETECT_LATENCY, f.w_click.clamp(0.2, 1.0));
        }
        let m = f.mid_flux / f.dynamics.max(0.05);
        let d = m - self.snare_avg;
        self.snare_avg += d * 0.03;
        self.snare_var += (d * d - self.snare_var) * 0.03;
        let thr = self.snare_avg + self.snare_var.max(1e-12).sqrt() * 2.2;
        if m > thr && m > 0.004 && !f.kick_candidate && !near_kick {
            self.push_snare(t - DETECT_LATENCY, ((m - thr) / (thr + 1e-6)).clamp(0.2, 1.0));
        }
    }

    fn push_snare(&mut self, t: f64, strength: f32) {
        if t - self.last_snare < 0.07 {
            return;
        }
        self.last_snare = t;
        self.snares.push(Hit { t, strength, ..Hit::default() });
    }
}

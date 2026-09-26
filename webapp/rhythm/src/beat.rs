//! The beat GRID: where the beats are, which one starts the bar, and where
//! the phrase turns over.
//!
//! tempo.rs says how LONG a beat is. This says WHERE it is, and it replaces a
//! phase-locked loop that was pulled toward "any onset over 0.25" and so sat
//! wherever the loudest offbeat pulled it — the eval measured the old grid
//! +25 ms late on nearly every record and on the OFFBEAT for a whole reggae
//! track. Three ideas instead:
//!
//! 1. THE PHASE IS A MODE, NOT A MEAN. Every recent piece of evidence — a
//!    confirmed kick above all, then bass onsets, then snares and the rest —
//!    is placed on the circle of the current grid (where it falls inside its
//!    beat), weighted by what it is and how old it is, and smoothed into a
//!    density. The grid sits on that density's PEAK. A roll puts its notes at
//!    thirds and quarters of the beat, a psy bass at the three sixteenths, a
//!    hi-hat on the offbeat: none of them can move a mode that every kick
//!    agrees on, where they would all have dragged a mean.
//!
//! 2. THE FINE TIMING IS A FIT. The evidence close to the grid (within an
//!    eighth of a beat) is regressed against its beat numbers — weighted least
//!    squares for the period and the phase at once — and the grid eases toward
//!    the fit over about a beat. That is what follows a drummer drifting a
//!    percent either side of the click, and what keeps a machine grid on the
//!    kick to a millisecond instead of wandering between estimates.
//!
//! 3. ONE COUNTER CARRIES THE BEAT, THE BAR AND THE PHRASE. `beat_index` is
//!    kept congruent with the music: `beat_index % beats_per_bar` IS the bar
//!    position and `beat_index % (4 * beats_per_bar)` the beat inside a
//!    four-bar phrase. When the downbeat estimate or a drop re-anchors the bar,
//!    the counter jumps FORWARD to the right congruence — never back — so every
//!    consumer that already reads the counter (lib/viz/musical.js's phrase
//!    clock, the microwave's cooking timer) lands on the music's own phrases
//!    without knowing anything changed.
//!
//! With no evidence at all — a breakdown, the beat of silence before a drop —
//! nothing moves the grid: it COASTS on the last period, which is what the
//! music does too, and the first kick of the drop finds it where it left it.

use crate::tempo::TempoOut;
use crate::util::MinMax;

pub const KIND_KICK: u8 = 0;
pub const KIND_LOW: u8 = 1;
pub const KIND_FULL: u8 = 2;
pub const KIND_SNARE: u8 = 3;

const EV_CAP: usize = 128;
const BINS: usize = 96;
/// How far back the evidence reaches, in beats (and at least in seconds).
const MEMORY_BEATS: f64 = 8.0;
const MEMORY_MIN_S: f64 = 2.5;
/// The width of one piece of evidence on the circle, in beats.
const KERNEL_W: f64 = 0.04;
/// The fit only believes evidence this close to the grid (beats).
const FIT_TOL: f64 = 0.13;
/// How fast the grid follows the fit: phase and period time constants, beats.
const PHASE_TAU_BEATS: f64 = 0.9;
const PERIOD_TAU_BEATS: f64 = 6.0;
/// A mode this far from the grid, this much stronger, for this many beats,
/// moves the grid onto it outright.
const JUMP_MIN: f64 = 0.2;
const JUMP_RATIO: f32 = 1.6;
const JUMP_BEATS: u32 = 3;

#[derive(Clone, Copy, Default)]
struct Ev {
    t: f64,
    w: f32,
    kind: u8,
}

#[derive(Default, Clone)]
pub struct BeatOut {
    pub bpm: f32,
    pub period: f32,
    pub phase: f32,
    pub beat: bool,
    pub beat_index: f64,
    pub bar_pos: u32,
    pub beats_per_bar: u32,
    pub downbeat: bool,
    pub confidence: f32,
    pub locked: bool,
    pub since_beat: f32,
    /// Bars since the phrase last turned over (a drop, a section edge).
    pub phrase_bar: u32,
    /// How clearly the evidence agrees with the grid, 0..1.
    pub clarity: f32,
    /// Share of the rhythmic evidence sitting on the OFFBEAT, 0..1 — a reverse
    /// bass, an offbeat hat, a skank.
    pub offbeat: f32,
}

/// What the downbeat estimate has heard at each beat.
#[derive(Clone, Copy, Default)]
struct BeatFeat {
    kick: f32,
    snare: f32,
    low: f32,
    chord: f32,
    level: f32,
}

pub struct Grid {
    hop_s: f64,
    ev: [Ev; EV_CAP],
    ev_head: usize,
    ev_len: usize,
    t0: f64,
    p: f64,
    init: bool,
    last_retimed: u32,
    last_leveled: u32,
    locked: bool,
    density: [f32; BINS],
    kernel: [f32; 64],
    clarity: f32,
    jump_count: u32,
    jump_target: f64,
    // Beat NUMBERS: grid beat k (the one at t0 + k·p) is beat number
    // k + idx_off. Every change to t0 or p re-derives idx_off so that the beat
    // nearest now keeps its number (`renumber`) — which is what lets the
    // downbeat evidence, kept per NUMBER, survive every correction the grid
    // makes. (It used to be kept per grid index, and every internal re-basing
    // silently rotated the bar hypotheses under it.)
    idx_off: i64,
    // What the counter SHOWS is the number plus this. It only ever grows, and
    // only moves when the bar or the phrase is re-anchored.
    disp_off: i64,
    // Output side: the last beat number the frames have crossed.
    last_n: i64,
    out_primed: bool,
    last_beat_t: f64,
    // Analysis side: the last beat number closed for the downbeat.
    an_n: i64,
    an_primed: bool,
    cur_chroma: [f32; 12],
    cur_frames: f32,
    cur_level: f32,
    prev_chroma: [f32; 12],
    pending_beat: i64,
    pending_t: f64,
    pending_chroma_change: f32,
    pending_level: f32,
    feats: [BeatFeat; 16],
    score4: [f32; 4],
    score3: [f32; 3],
    meter: u32,
    down_doubt: u32,
    level_avg: f32,
    phrase_start: i64,
    confidence: f32,
    tempo_conf: f32,
    offbeat: f32,
    pub out: BeatOut,
}

#[inline]
fn wrap(x: f64) -> f64 {
    x - (x + 0.5).floor()
}

impl Grid {
    pub fn new(hop_s: f64) -> Grid {
        let mut kernel = [0f32; 64];
        for (i, k) in kernel.iter_mut().enumerate() {
            // Gaussian in bins, kernel[i] for a distance of i/8 bin.
            let d = i as f64 / 8.0 / BINS as f64 / KERNEL_W;
            *k = (-0.5 * d * d).exp() as f32;
        }
        let mut g = Grid {
            hop_s,
            ev: [Ev::default(); EV_CAP],
            ev_head: 0,
            ev_len: 0,
            t0: 0.0,
            p: 0.5,
            init: false,
            last_retimed: 0,
            last_leveled: 0,
            locked: false,
            density: [0.0; BINS],
            kernel,
            clarity: 0.0,
            jump_count: 0,
            jump_target: 0.0,
            idx_off: 0,
            disp_off: 0,
            last_n: 0,
            out_primed: false,
            last_beat_t: 0.0,
            an_n: 0,
            an_primed: false,
            cur_chroma: [0.0; 12],
            cur_frames: 0.0,
            cur_level: 0.0,
            prev_chroma: [0.0; 12],
            pending_beat: i64::MIN,
            pending_t: 0.0,
            pending_chroma_change: 0.0,
            pending_level: 0.0,
            feats: [BeatFeat::default(); 16],
            score4: [0.0; 4],
            score3: [0.0; 3],
            meter: 4,
            down_doubt: 0,
            level_avg: 0.0,
            phrase_start: 0,
            confidence: 0.0,
            tempo_conf: 0.0,
            offbeat: 0.0,
            out: BeatOut::default(),
        };
        g.reset();
        g
    }

    pub fn reset(&mut self) {
        self.ev_head = 0;
        self.ev_len = 0;
        self.init = false;
        self.locked = false;
        self.clarity = 0.0;
        self.jump_count = 0;
        self.idx_off = 0;
        self.disp_off = 0;
        self.last_n = 0;
        self.an_n = 0;
        self.down_doubt = 0;
        self.out_primed = false;
        self.an_primed = false;
        self.cur_chroma = [0.0; 12];
        self.cur_frames = 0.0;
        self.cur_level = 0.0;
        self.prev_chroma = [0.0; 12];
        self.pending_beat = i64::MIN;
        self.feats = [BeatFeat::default(); 16];
        self.score4 = [0.0; 4];
        self.score3 = [0.0; 3];
        self.meter = 4;
        self.level_avg = 0.0;
        self.phrase_start = 0;
        self.confidence = 0.0;
        self.offbeat = 0.0;
        self.out = BeatOut { beats_per_bar: 4, period: 0.5, ..BeatOut::default() };
    }

    /// Evidence of a beat-ish event at time `t` (seconds, analyser clock).
    pub fn add_event(&mut self, t: f64, w: f32, kind: u8) {
        if !(w > 0.0) {
            return;
        }
        self.ev[self.ev_head] = Ev { t, w, kind };
        self.ev_head = (self.ev_head + 1) % EV_CAP;
        if self.ev_len < EV_CAP {
            self.ev_len += 1;
        }
    }

    fn kind_weight(kind: u8) -> f32 {
        match kind {
            KIND_KICK => 1.0,
            KIND_LOW => 0.45,
            KIND_SNARE => 0.4,
            _ => 0.22,
        }
    }

    /// The phase density of the recent evidence on the current grid.
    fn build_density(&mut self, now: f64) -> f32 {
        self.density = [0.0; BINS];
        let mem = (MEMORY_BEATS * self.p).fmax(MEMORY_MIN_S);
        let mut total = 0f32;
        for i in 0..self.ev_len {
            let e = self.ev[(self.ev_head + EV_CAP - 1 - i) % EV_CAP];
            let age = now - e.t;
            if age > mem * 1.5 || age < -0.05 {
                continue;
            }
            let w = e.w * Self::kind_weight(e.kind) * (-age.fmax(0.0) / mem).exp() as f32;
            let psi = wrap((e.t - self.t0) / self.p);
            let pos = (psi + 0.5) * BINS as f64;
            let c = pos.floor() as i64;
            let reach = (KERNEL_W * BINS as f64 * 3.0).ceil() as i64;
            for d in -reach..=reach {
                let b = c + d;
                let dist = ((b as f64 + 0.5) - pos).abs();
                let ki = (dist * 8.0) as usize;
                if ki >= 64 {
                    continue;
                }
                let bi = (((b % BINS as i64) + BINS as i64) % BINS as i64) as usize;
                self.density[bi] += w * self.kernel[ki];
            }
            total += w;
        }
        total
    }

    /// The weighted fit of the grid to the evidence near it: returns the
    /// corrections (phase in beats, relative period change) and how many
    /// beats of spread the fit rests on.
    fn fit(&self, now: f64) -> Option<(f64, f64, f64)> {
        let mem = (MEMORY_BEATS * self.p).fmax(MEMORY_MIN_S);
        let (mut sw, mut sk, mut st, mut skk, mut skt) = (0f64, 0f64, 0f64, 0f64, 0f64);
        let mut kmin = f64::INFINITY;
        let mut kmax = f64::NEG_INFINITY;
        let mut n = 0;
        for i in 0..self.ev_len {
            let e = self.ev[(self.ev_head + EV_CAP - 1 - i) % EV_CAP];
            let age = now - e.t;
            if age > mem || age < -0.05 {
                continue;
            }
            let x = (e.t - self.t0) / self.p;
            let k = x.round();
            let psi = x - k;
            if psi.abs() > FIT_TOL {
                continue;
            }
            // Kicks carry the fit; the rest only where there are no kicks.
            let w = (e.w * Self::kind_weight(e.kind) * Self::kind_weight(e.kind)) as f64 * (-age / mem).exp();
            // Relative time, so the regression is well conditioned.
            let t = e.t - now;
            sw += w;
            sk += w * k;
            st += w * t;
            skk += w * k * k;
            skt += w * k * t;
            kmin = kmin.fmin(k);
            kmax = kmax.fmax(k);
            n += 1;
        }
        if n < 4 || kmax - kmin < 3.0 || sw <= 0.0 {
            return None;
        }
        let den = sw * skk - sk * sk;
        if den.abs() < 1e-9 {
            return None;
        }
        let pf = (sw * skt - sk * st) / den;
        let tf = (st - pf * sk) / sw + now; // time of the grid's beat k = 0
        if !(pf > 0.0) || (pf / self.p - 1.0).abs() > 0.05 {
            return None;
        }
        // Phase error of the current grid against the fit, at `now`, in beats.
        let pos_grid = (now - self.t0) / self.p;
        let pos_fit = (now - tf) / pf;
        let dphase = wrap(pos_grid - pos_fit);
        Some((dphase, pf / self.p - 1.0, kmax - kmin))
    }

    /// Per analysis frame: follow the tempo, place and refine the grid, and
    /// gather what the downbeat needs. `chroma` and `level` are this frame's.
    pub fn update(&mut self, now: f64, dt: f64, tempo: &TempoOut, chroma: &[f32; 12], level: f32) {
        self.tempo_conf = tempo.confidence;
        let (old_t0, old_p, was_init) = (self.t0, self.p, self.init);
        // A new grid (a new tempo, or another level of it) says nothing about
        // where the bar starts: its downbeat evidence starts over.
        let mut new_bar = false;
        if !tempo.locked {
            if self.init && tempo.confidence < 0.08 {
                self.init = false;
                self.locked = false;
            }
            // Coast: an unlocked tempo during a breakdown keeps the grid.
            if !self.init {
                self.locked = false;
                return;
            }
        } else if !self.init || tempo.retimed != self.last_retimed {
            // A new tempo: take its period and find the phase from scratch.
            self.p = tempo.period as f64;
            self.init = true;
            self.last_retimed = tempo.retimed;
            self.last_leveled = tempo.leveled;
            self.t0 = now;
            let total = self.build_density(now);
            if total > 0.0 {
                let (peak, _) = self.peak();
                self.t0 += peak * self.p;
            }
            new_bar = true;
        } else if tempo.leveled != self.last_leveled {
            self.last_leveled = tempo.leveled;
            let r = tempo.octave_ratio as f64;
            if r > 1.5 {
                // The period doubled: keep whichever half of the beats the
                // kicks prefer.
                let old = self.p;
                self.p = tempo.period as f64;
                let a = self.parity_weight(now, self.t0, self.p);
                let b = self.parity_weight(now, self.t0 + old, self.p);
                if b > a {
                    self.t0 += old;
                }
            } else {
                // Halved (or seeded onto another level): every old beat stays.
                self.p = tempo.period as f64;
            }
            new_bar = true;
        } else if ((tempo.period as f64) / self.p - 1.0).abs() > 0.03 {
            // The estimator moved a little further than the fit would: follow,
            // keeping the phase where it is now.
            let pos = (now - self.t0) / self.p;
            self.p = tempo.period as f64;
            self.t0 = now - pos * self.p;
        }
        self.locked = true;

        // --- where the grid should be -------------------------------------
        let total = self.build_density(now);
        let (peak, peak_v) = self.peak();
        let near = self.mass_near(0.0, 0.12);
        let far = self.mass_near(0.5, 0.12);
        let sum: f32 = self.density.iter().sum::<f32>().fmax(1e-9);
        self.clarity = if total > 0.0 { (near / sum).fmin(1.0) } else { self.clarity * 0.995 };
        self.offbeat += ((far / (near + far + 1e-6)) - self.offbeat) * (dt as f32 / 2.0).fmin(1.0);
        if total > 0.0 {
            if peak.abs() > JUMP_MIN && peak_v > self.density_at(0.0) * JUMP_RATIO {
                // A mode well away from the grid and clearly stronger than
                // what sits on it: after a few beats of that, move.
                if self.jump_count == 0 || (peak - self.jump_target).abs() < 0.08 {
                    self.jump_count += 1;
                    self.jump_target = peak;
                } else {
                    self.jump_count = 1;
                    self.jump_target = peak;
                }
                let need = (JUMP_BEATS as f64 * self.p / dt.fmax(1e-3)) as u32;
                if self.jump_count >= need.fmax(1) {
                    self.t0 += peak * self.p;
                    self.jump_count = 0;
                }
            } else {
                self.jump_count = 0;
                if let Some((dphase, dper, _spread)) = self.fit(now) {
                    let a_ph = 1.0 - (-dt / (PHASE_TAU_BEATS * self.p)).exp();
                    let a_pe = 1.0 - (-dt / (PERIOD_TAU_BEATS * self.p)).exp();
                    // The period moves around NOW, so correcting it does not
                    // also move the phase the fit just measured.
                    let pos = (now - self.t0) / self.p;
                    self.p *= 1.0 + dper * a_pe;
                    self.t0 = now - pos * self.p;
                    // dphase > 0: the grid is AHEAD of the fit — move it later.
                    self.t0 += dphase * self.p * a_ph;
                } else if peak.abs() < 0.25 && peak_v > 0.0 {
                    // Too little near the grid to fit: follow the mode gently.
                    let a_ph = 1.0 - (-dt / (PHASE_TAU_BEATS * 2.0 * self.p)).exp();
                    self.t0 += peak * self.p * a_ph;
                }
            }
        }
        // The beats keep their numbers through whatever moved above.
        if was_init {
            if self.t0 != old_t0 || self.p != old_p {
                self.renumber(old_t0, old_p, now);
            }
        } else {
            // A grid starting over after an unlock: its first beat comes after
            // the last one numbered.
            self.idx_off = self.an_n.fmax(self.last_n) + 1 - ((now - self.t0) / self.p).round() as i64;
        }
        if new_bar {
            self.restart_bar();
        }
        // Keep t0 within a few beats of now: the arithmetic stays exact however
        // long it runs, and a period correction barely moves the phase.
        let k = ((now - self.t0) / self.p).floor();
        if k > 4.0 {
            let shift = k - 1.0;
            self.t0 += shift * self.p;
            self.idx_off += shift as i64;
        }

        // --- confidence ----------------------------------------------------
        let c = (tempo.confidence * 1.4).fmin(1.0) * (0.35 + 0.65 * self.clarity);
        self.confidence += (c - self.confidence) * (dt as f32 / 1.5).fmin(1.0);

        // --- what the downbeat needs, one beat at a time ---------------------
        self.gather(now, chroma, level);
    }

    /// Re-derive `idx_off` after the grid moved from (old_t0, old_p): the beat
    /// nearest `now` on the old grid keeps its number on the new one.
    fn renumber(&mut self, old_t0: f64, old_p: f64, now: f64) {
        if !(old_p > 0.0) || !(self.p > 0.0) {
            return;
        }
        let k_old = ((now - old_t0) / old_p).round();
        let n = k_old as i64 + self.idx_off;
        let tb = old_t0 + k_old * old_p;
        let k_new = ((tb - self.t0) / self.p).round() as i64;
        self.idx_off = n - k_new;
    }

    /// Forget the downbeat evidence: the beats it was gathered on are gone.
    fn restart_bar(&mut self) {
        self.an_primed = false;
        self.pending_beat = i64::MIN;
        self.feats = [BeatFeat::default(); 16];
        self.score4 = [0.0; 4];
        self.score3 = [0.0; 3];
        self.down_doubt = 0;
        self.cur_chroma = [0.0; 12];
        self.cur_frames = 0.0;
        self.cur_level = 0.0;
    }

    fn parity_weight(&self, now: f64, t0: f64, p: f64) -> f32 {
        let mut s = 0f32;
        for i in 0..self.ev_len {
            let e = self.ev[(self.ev_head + EV_CAP - 1 - i) % EV_CAP];
            if now - e.t > 6.0 {
                continue;
            }
            let psi = wrap((e.t - t0) / p);
            if psi.abs() < 0.1 {
                s += e.w * Self::kind_weight(e.kind);
            }
        }
        s
    }

    fn peak(&self) -> (f64, f32) {
        let mut bi = 0;
        for i in 1..BINS {
            if self.density[i] > self.density[bi] {
                bi = i;
            }
        }
        let y1 = self.density[bi];
        let y0 = self.density[(bi + BINS - 1) % BINS];
        let y2 = self.density[(bi + 1) % BINS];
        let den = y0 - 2.0 * y1 + y2;
        let sh = if den.abs() > 1e-12 { (0.5 * (y0 - y2) / den).clamp(-0.5, 0.5) } else { 0.0 };
        let pos = (bi as f64 + 0.5 + sh as f64) / BINS as f64 - 0.5;
        (wrap(pos), y1)
    }

    fn density_at(&self, psi: f64) -> f32 {
        let b = (((psi + 0.5) * BINS as f64).floor() as i64).rem_euclid(BINS as i64) as usize;
        self.density[b]
    }

    fn mass_near(&self, psi: f64, half: f64) -> f32 {
        let mut s = 0f32;
        let r = (half * BINS as f64).round() as i64;
        let c = ((psi + 0.5) * BINS as f64).floor() as i64;
        for d in -r..=r {
            s += self.density[(c + d).rem_euclid(BINS as i64) as usize];
        }
        s
    }

    /// Collect per-beat evidence for the bar position on the ANALYSIS side,
    /// and score each beat once enough of what follows it has been heard.
    fn gather(&mut self, now: f64, chroma: &[f32; 12], level: f32) {
        let pos = (now - self.t0) / self.p;
        let idx = pos.floor() as i64 + self.idx_off;
        if !self.an_primed {
            self.an_primed = true;
            self.an_n = idx;
            self.cur_frames = 0.0;
            return;
        }
        for k in 0..12 {
            self.cur_chroma[k] += chroma[k];
        }
        self.cur_level += level;
        self.cur_frames += 1.0;
        if idx > self.an_n {
            // Beat `an_idx + 1` has just begun. Close the interval that ended.
            let n = self.cur_frames.fmax(1.0);
            let mut mean = [0f32; 12];
            let mut dist = 0f32;
            let mut norm = 0f32;
            for k in 0..12 {
                mean[k] = self.cur_chroma[k] / n;
                norm += mean[k];
            }
            if norm > 1e-6 {
                for k in 0..12 {
                    mean[k] /= norm;
                    dist += (mean[k] - self.prev_chroma[k]).abs();
                }
            }
            let lvl = self.cur_level / n;
            self.prev_chroma = mean;
            // Score the PREVIOUS pending beat now that its surroundings are in.
            if self.pending_beat != i64::MIN {
                self.score_beat(now);
            }
            self.pending_beat = idx;
            self.pending_t = self.t0 + (idx - self.idx_off) as f64 * self.p;
            // The harmonic change measured across the boundary INTO this beat.
            self.pending_chroma_change = if norm > 1e-6 { dist } else { 0.0 };
            self.pending_level = lvl;
            self.cur_chroma = [0.0; 12];
            self.cur_level = 0.0;
            self.cur_frames = 0.0;
            self.an_n = idx;
        }
    }

    fn score_beat(&mut self, _now: f64) {
        let b = self.pending_beat;
        let tb = self.pending_t;
        let mut f = BeatFeat { chord: self.pending_chroma_change, level: self.pending_level, ..BeatFeat::default() };
        for i in 0..self.ev_len {
            let e = self.ev[(self.ev_head + EV_CAP - 1 - i) % EV_CAP];
            let d = (e.t - tb) / self.p;
            if d.abs() > 0.12 {
                continue;
            }
            match e.kind {
                KIND_KICK => f.kick = f.kick.fmax(e.w),
                KIND_SNARE => f.snare = f.snare.fmax(e.w),
                KIND_LOW => f.low = f.low.fmax(e.w),
                _ => {}
            }
        }
        self.feats[(b.rem_euclid(16)) as usize] = f;
        // Energy novelty: this beat against the running level.
        let nov = (f.level - self.level_avg).fmax(0.0) / (self.level_avg + 0.05);
        self.level_avg += (f.level - self.level_avg) * 0.15;
        // How much this beat looks like the START of a bar, and like beat 2/4.
        let down = f.chord * 1.4 + f.kick * 0.35 + f.low * 0.25 + nov.fmin(2.0) * 0.8 - f.snare * 0.9;
        let back = f.snare * 1.0 - f.chord * 0.3;
        for i in 0..4 {
            self.score4[i] *= 0.965;
        }
        for i in 0..3 {
            self.score3[i] *= 0.965;
        }
        // Hypothesis o: beats with (b - o) % M == 0 are downbeats.
        for o in 0..4i64 {
            let pos = (b - o).rem_euclid(4);
            let s = match pos {
                0 => down,
                2 => down * 0.25,
                _ => back,
            };
            self.score4[o as usize] += s;
        }
        for o in 0..3i64 {
            let pos = (b - o).rem_euclid(3);
            let s = if pos == 0 { down } else { back * 0.5 - down * 0.2 };
            self.score3[o as usize] += s;
        }
        let (o4, c4) = best_of(&self.score4);
        let (o3, c3) = best_of(&self.score3);
        let want_meter = if c3 > c4 * 1.4 && c3 > 0.5 { 3 } else { 4 };
        if want_meter != self.meter {
            self.meter = want_meter;
        }
        let o = if self.meter == 3 { o3 } else { o4 };
        let m = self.meter as i64;
        // (number + disp_off) % M == 0 at a downbeat, i.e. disp_off = -o mod M.
        let want = (-(o as i64)).rem_euclid(m);
        let have = self.disp_off.rem_euclid(m);
        // The offset currently shown, as a hypothesis index.
        let cur_o = (-have).rem_euclid(m) as usize;
        if want != have {
            let (conf, best, cur) = if self.meter == 3 {
                (c3, self.score3[o], self.score3[cur_o % 3])
            } else {
                (c4, self.score4[o], self.score4[cur_o % 4])
            };
            // A new downbeat has to lead clearly, for two bars running: the
            // bar moving is a jump every bar-level animation shows.
            if conf > 0.5 && best > cur * 1.3 + 0.1 {
                self.down_doubt += 1;
                if self.down_doubt as i64 >= 2 * m {
                    self.disp_off += (want - have).rem_euclid(m);
                    self.down_doubt = 0;
                }
            } else {
                self.down_doubt = 0;
            }
        } else {
            self.down_doubt = 0;
        }
    }

    /// A section boundary (a drop): the beat nearest `t` starts a bar AND a
    /// phrase. The counter jumps forward to match.
    pub fn anchor_phrase(&mut self, t: f64) {
        if !self.init {
            return;
        }
        let n = ((t - self.t0) / self.p).round() as i64 + self.idx_off;
        let m = self.meter as i64;
        let ph = 4 * m;
        let have = (n + self.disp_off).rem_euclid(ph);
        if have != 0 {
            self.disp_off += (ph - have).rem_euclid(ph);
        }
        self.phrase_start = n + self.disp_off;
    }

    /// Fill `out` for the output frame at time `t` (behind the analysis).
    pub fn eval_at(&mut self, t: f64) {
        let o = &mut self.out;
        o.beat = false;
        o.downbeat = false;
        o.clarity = self.clarity;
        o.offbeat = self.offbeat;
        o.beats_per_bar = self.meter;
        if !self.init {
            o.locked = false;
            o.bpm = 0.0;
            o.confidence = self.confidence * 0.5;
            return;
        }
        o.period = self.p as f32;
        let locked = self.locked && self.confidence > 0.12;
        o.locked = locked;
        o.bpm = if locked { (60.0 / self.p) as f32 } else { 0.0 };
        o.confidence = self.confidence;
        let pos = (t + self.hop_s * 0.5 - self.t0) / self.p;
        let n = pos.floor() as i64 + self.idx_off;
        // A beat is the frames crossing the next beat NUMBER, never the
        // counter jumping: a re-anchored bar or phrase moves `disp_off` and
        // fires nothing, and a grid correction keeps every number (see
        // `renumber`), so a beat is neither doubled nor invented by one. The
        // half-beat guard is for the one case left, a correction that moves a
        // beat just crossed to just ahead.
        if !self.out_primed {
            self.out_primed = true;
            self.last_n = n;
        } else if n > self.last_n {
            if locked && t - self.last_beat_t > 0.45 * self.p {
                o.beat = true;
                self.last_beat_t = t;
            }
            self.last_n = n;
        }
        let cur = self.last_n + self.disp_off;
        o.phase = (pos - pos.floor()) as f32;
        o.beat_index = cur as f64;
        let m = self.meter as i64;
        o.bar_pos = cur.rem_euclid(m) as u32;
        o.downbeat = o.beat && o.bar_pos == 0;
        o.since_beat = (t - self.last_beat_t).fmax(0.0) as f32;
        o.phrase_bar = ((cur - self.phrase_start).fmax(0) / m) as u32;
    }

    pub fn period(&self) -> f64 {
        self.p
    }
    pub fn initialised(&self) -> bool {
        self.init
    }
    /// Where `t` falls on the grid, in beats (fraction from the nearest beat
    /// in -0.5..0.5), or None before there is a grid.
    pub fn psi(&self, t: f64) -> Option<f64> {
        if self.init {
            Some(wrap((t - self.t0) / self.p))
        } else {
            None
        }
    }
    /// The grid position (in beats, continuous) of `t`.
    pub fn position(&self, t: f64) -> Option<f64> {
        if self.init {
            Some((t - self.t0) / self.p)
        } else {
            None
        }
    }
}

fn best_of(s: &[f32]) -> (usize, f32) {
    let mut bi = 0;
    let mut sum = 0f32;
    for i in 0..s.len() {
        sum += s[i];
        if s[i] > s[bi] {
            bi = i;
        }
    }
    let mean = sum / s.len() as f32;
    let spread = s.iter().map(|v| (v - mean).abs()).sum::<f32>() / s.len() as f32 + 1e-3;
    (bi, (s[bi] - mean) / spread)
}

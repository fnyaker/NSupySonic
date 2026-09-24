//! The TEMPO: which period the music repeats at, and at which metrical level.
//!
//! This is the estimation half of lib/audio/tempo.js, ported with its
//! measurements intact — an onset function conditioned against its own local
//! mean and clipped at 25x the track's scale, an autocorrelation summed over
//! three harmonics and AVERAGED over time (the running tempogram), a shortlist
//! scored on how well the onsets FOLD onto each candidate's grid, the octave
//! arbitrated by two witnesses (the fold proposes, the level score disposes),
//! nothing moving without persistence, and a breakdown treated as a coast.
//! It found the right tempo on 92% of the eval's frames with nothing known,
//! which is why it is kept.
//!
//! What is NOT here any more is the phase: the phase-locked loop that pulled
//! the grid toward "any onset over 0.25" is gone, replaced by beat.rs, which
//! fits the grid to the kicks themselves. This module hands it a period.
//!
//! And one rule changed, because the eval caught it doing the worst thing it
//! can do. A served tempo used to be an anchor on its OCTAVE as well as its
//! value, and its narrow bell also fed the level score the octave vote is
//! vetoed with — so a figure published at HALF the real tempo (what Deezer
//! publishes for a good share of hardcore) vetoed every vote to correct it,
//! and the whole track ran at half speed: 0% on tempo across the half-seeded
//! catalogue. Now the seed is asymmetric, like the server's own octave check
//! (supysonic/deezer/analysis.py#_reconcile_octave): it still forbids moving
//! to a SLOWER level (a half-time dubstep groove is not 70 BPM because it
//! feels like it), and it no longer forbids moving to a FASTER one when the
//! kicks land on every beat of that faster grid.
//!
//! THE DRUMS HAVE THE LAST WORD ON THE OCTAVE WHEN THEY ARE STEADY. The onset
//! function cannot tell a rolling techno bass on every offbeat from a beat:
//! the kick and the rumble alternate, everything lands on an eighth-note
//! grid, and both the fold and the level score prefer it — measured on the
//! techno record, 264 BPM beat 132 on grid quality 0.73 to 0.28, and the
//! tracker locked there for a minute. What says 132 is the KICKS: the
//! detector finds every one of them and never one on an offbeat. So the
//! kicks and snares the detector confirms are kept, merged when they land
//! together (a clap on a kick is one hit), and when they form a steady pulse
//! at a plausible tempo that pulse is a witness no onset function can be:
//! a grid twice as fast as it is voted down, and a move faster than it is
//! refused. Snares count because the backbeat is part of the pulse — a hip
//! hop groove of kick, snare, kick, snare is a beat per hit, not one per
//! kick — and nothing else does, because an offbeat bass or hat is exactly
//! what must not. "Plausible" is the prior's plateau (or the genre's range),
//! which is what keeps a half-time groove — kick on one, snare on three —
//! from dragging a 140 BPM track to 70.

pub const MIN_BPM: f32 = 55.0;
pub const MAX_BPM: f32 = 300.0;
const HARMONICS: usize = 3;
const ODF_SIGMA: f32 = 2.0;
const DEFAULT_PRIOR_LO: f32 = 90.0;
const DEFAULT_PRIOR_HI: f32 = 200.0;
const PRIOR_SIGMA: f32 = 0.42;
const MEAN_TAU: f32 = 0.12;
const MEAN_BEATS: f32 = 1.5;
const SCALE_TAU: f32 = 2.5;
const SCALE_CLIP: f32 = 25.0;
const TG_TAU: f32 = 2.0;
const INCUMBENT: f32 = 0.35;
const SEED_BONUS: f32 = 0.7;
const SEED_OCTAVE: f32 = 0.22;
const SEED_FLOOR: f32 = 0.45;
const BUMP_W: f32 = 0.06;
const CHALLENGE_NEEDED: u32 = 5;
const OCT_SMOOTH: f32 = 0.3;
const OCT_ON: f32 = 0.55;
const OCT_COOLDOWN: f32 = 2.5;
const LEVEL_EDGE: f32 = 1.15;
const LEVEL_SPAN: f32 = 0.3;
const LEVEL_VETO: f32 = 0.85;
/// Seconds the kicks must insist on a faster level than the seed's before the
/// seed itself is doubled. Short, because the evidence for it is specific:
/// kicks on every beat of the doubled grid, as hard as the ones on the seed's.
const SEED_UP_DOUBT: f32 = 6.0;
const SEED_SIGMA: f32 = 0.18;
const SEED_FLOOR_W: f32 = 0.1;
const PEAK_SLOTS: f32 = 4.0;
const SHORTLIST: usize = 5;
/// The drums' pulse (see the module header): how much of the past it reads,
/// how many intervals it needs, how close an interval must be to count, and
/// how many hits it keeps.
const PULSE_WINDOW: f64 = 8.0;
const PULSE_MIN: usize = 6;
const PULSE_TOL: f64 = 0.07;
const PULSE_KEEP: usize = 64;
/// Two confirmed hits closer than this are one: a clap on a kick.
const PULSE_MERGE: f64 = 0.03;
/// What a steady pulse adds to the vote for its own level — the vote's full
/// scale, so on its own it settles the octave within a few estimates.
const PULSE_VOTE: f32 = 1.0;

#[inline]
fn bump(ratio: f32) -> f32 {
    if !(ratio > 0.0) {
        return 0.0;
    }
    let d = ratio.ln() / BUMP_W;
    if d * d > 18.0 {
        0.0
    } else {
        (-0.5 * d * d).exp()
    }
}
/// Insertion sort, for the pulse's few dozen hits: the standard library's
/// sort is several kilobytes of WebAssembly for a job this small.
fn sort_small(v: &mut [f64]) {
    for i in 1..v.len() {
        let x = v[i];
        let mut j = i;
        while j > 0 && v[j - 1] > x {
            v[j] = v[j - 1];
            j -= 1;
        }
        v[j] = x;
    }
}

#[inline]
fn ramp_up(x: f32, t: f32, w: f32) -> f32 {
    ((x - t) / w).clamp(0.0, 1.0)
}
#[inline]
fn ramp_down(x: f32, t: f32, w: f32) -> f32 {
    ((t - x) / w).clamp(0.0, 1.0)
}

pub struct TempoOut {
    pub bpm: f32,
    pub period: f32,
    pub confidence: f32,
    pub locked: bool,
    pub kick_pulse: f32,
    /// Bumped whenever the period jumped to a different TEMPO (not an octave
    /// of the same one), so the grid knows to re-find its phase.
    pub retimed: u32,
    /// Bumped whenever the metrical level moved by an octave; `octave_ratio`
    /// says which way (2.0 = the period doubled).
    pub leveled: u32,
    pub octave_ratio: f32,
    /// The conditioned onset value of the last frame, 0..1: the mix the
    /// autocorrelation runs on, the full band alone, and the bass alone.
    pub odf: f32,
    pub odf_full: f32,
    pub odf_low: f32,
    pub dbg: [f32; 3],
}

pub struct Tempo {
    fps: f32,
    len: usize,
    odf: Vec<f32>,
    odf_low: Vec<f32>,
    odf_body: Vec<f32>,
    head: usize,
    filled: usize,
    flux_mean: f32,
    low_mean: f32,
    mid_mean: f32,
    flux_scale: f32,
    low_scale: f32,
    mid_scale: f32,
    activity: f32,
    clock: f32,
    last_est: f32,
    est_every: f32,
    period: f32,
    bpm: f32,
    confidence: f32,
    locked: bool,
    kick_pulse: f32,
    hits: [f64; PULSE_KEEP],
    hits_n: usize,
    now_t: f64,
    est_count: u32,
    oct_vote: f32,
    last_oct_at: f32,
    challenger: f32,
    challenge_count: u32,
    seed_lag: f32,
    seed_up: f32,
    prior_lo: f32,
    prior_hi: f32,
    lag_min: usize,
    lag_max: usize,
    acf_max: usize,
    harm_w: f32,
    acf: Vec<f32>,
    tg: Vec<f32>,
    cand: Vec<f32>,
    fold: Vec<f32>,
    work: Vec<f32>,
    work_low: Vec<f32>,
    work_body: Vec<f32>,
    dev: Vec<f32>,
    tmp: Vec<f32>,
    work_n: usize,
    kernel: Vec<f32>,
    list: Vec<usize>,
    shortlist: Vec<usize>,
    pub out: TempoOut,
}

impl Tempo {
    /// `fps` is the analysis frame rate (sample rate / hop).
    pub fn new(fps: f32) -> Tempo {
        let len = (8.0 * fps).round() as usize;
        let lag_min = (60.0 * fps / MAX_BPM).floor() as usize;
        let lag_max = (60.0 * fps / MIN_BPM).ceil() as usize;
        let acf_max = (len - (2.0 * fps) as usize).min(lag_max * HARMONICS);
        let mut harm_w = 1.0;
        for h in 2..=HARMONICS {
            harm_w += 1.0 / h as f32;
        }
        // The smoothing kernel, sigma in slots of 10 ms scaled to this rate.
        let sigma = ODF_SIGMA * fps / 100.0;
        let r = (sigma * 2.5).ceil().max(1.0) as i32;
        let mut kernel = Vec::with_capacity((2 * r + 1) as usize);
        let mut sum = 0.0;
        for i in -r..=r {
            let v = (-(i * i) as f32 / (2.0 * sigma * sigma)).exp();
            kernel.push(v);
            sum += v;
        }
        for v in kernel.iter_mut() {
            *v /= sum;
        }
        let mut t = Tempo {
            fps,
            len,
            odf: vec![0.0; len],
            odf_low: vec![0.0; len],
            odf_body: vec![0.0; len],
            head: 0,
            filled: 0,
            flux_mean: 0.0,
            low_mean: 0.0,
            mid_mean: 0.0,
            flux_scale: 0.0,
            low_scale: 0.0,
            mid_scale: 0.0,
            activity: 0.0,
            clock: 0.0,
            last_est: -1e9,
            est_every: 0.25,
            period: 0.5,
            bpm: 0.0,
            confidence: 0.0,
            locked: false,
            kick_pulse: 0.0,
            hits: [0.0; PULSE_KEEP],
            hits_n: 0,
            now_t: 0.0,
            est_count: 0,
            oct_vote: 0.0,
            last_oct_at: -1e9,
            challenger: 0.0,
            challenge_count: 0,
            seed_lag: 0.0,
            seed_up: 0.0,
            prior_lo: DEFAULT_PRIOR_LO,
            prior_hi: DEFAULT_PRIOR_HI,
            lag_min,
            lag_max,
            acf_max,
            harm_w,
            acf: vec![0.0; acf_max + 2],
            tg: vec![0.0; lag_max + 2],
            cand: vec![0.0; lag_max + 2],
            fold: vec![0.0; lag_max * 2 + 4],
            work: vec![0.0; len],
            work_low: vec![0.0; len],
            work_body: vec![0.0; len],
            dev: vec![0.0; len],
            tmp: vec![0.0; len],
            work_n: 0,
            kernel,
            list: Vec::with_capacity(lag_max),
            shortlist: Vec::with_capacity(SHORTLIST),
            out: TempoOut {
                bpm: 0.0,
                period: 0.5,
                confidence: 0.0,
                locked: false,
                kick_pulse: 0.0,
                retimed: 0,
                leveled: 0,
                octave_ratio: 1.0,
                odf: 0.0,
                odf_full: 0.0,
                odf_low: 0.0,
                dbg: [0.0; 3],
            },
        };
        t.reset();
        t
    }

    pub fn reset(&mut self) {
        self.odf.iter_mut().for_each(|v| *v = 0.0);
        self.odf_low.iter_mut().for_each(|v| *v = 0.0);
        self.odf_body.iter_mut().for_each(|v| *v = 0.0);
        self.tg.iter_mut().for_each(|v| *v = 0.0);
        self.head = 0;
        self.filled = 0;
        self.flux_mean = 0.0;
        self.low_mean = 0.0;
        self.mid_mean = 0.0;
        self.flux_scale = 0.0;
        self.low_scale = 0.0;
        self.mid_scale = 0.0;
        self.activity = 0.0;
        self.clock = 0.0;
        self.last_est = -1e9;
        self.period = 0.5;
        self.bpm = 0.0;
        self.confidence = 0.0;
        self.locked = false;
        self.kick_pulse = 0.0;
        self.hits_n = 0;
        self.est_count = 0;
        self.oct_vote = 0.0;
        self.last_oct_at = -1e9;
        self.challenger = 0.0;
        self.challenge_count = 0;
        self.seed_lag = 0.0;
        self.seed_up = 0.0;
        // The range is NOT reset: it describes the track about to play.
        self.out.bpm = 0.0;
        self.out.confidence = 0.0;
        self.out.locked = false;
        self.out.kick_pulse = 0.0;
    }

    fn lag_to_bpm(&self, lag: f32) -> f32 {
        60.0 * self.fps / lag
    }
    fn bpm_to_lag(&self, bpm: f32) -> f32 {
        60.0 * self.fps / bpm
    }

    fn tempo_prior(&self, b: f32) -> f32 {
        let d = if b < self.prior_lo {
            (b / self.prior_lo).ln()
        } else if b > self.prior_hi {
            (b / self.prior_hi).ln()
        } else {
            return 1.0;
        };
        (-(d * d) / (2.0 * PRIOR_SIGMA * PRIOR_SIGMA)).exp()
    }

    /// How plausible a metrical level is before the music is consulted, with
    /// the seed's narrow bell. `faster_free` drops the bell for levels FASTER
    /// than the seed — see the module header.
    fn level_prior(&self, lag: f32, faster_free: bool) -> f32 {
        let base = self.tempo_prior(self.lag_to_bpm(lag));
        if self.seed_lag <= 0.0 {
            return base;
        }
        if faster_free && lag < self.seed_lag * 0.75 {
            return base;
        }
        let d = (lag / self.seed_lag).log2();
        (base * SEED_FLOOR_W).max((-(d * d) / (2.0 * SEED_SIGMA * SEED_SIGMA)).exp())
    }

    fn weight_for(&self, lag: f32) -> f32 {
        let mut w = self.tempo_prior(self.lag_to_bpm(lag));
        if self.seed_lag > 0.0 {
            w *= 1.0
                + SEED_BONUS * bump(lag / self.seed_lag)
                + SEED_OCTAVE * (bump(lag / (self.seed_lag * 2.0)) + bump(lag / (self.seed_lag * 0.5)));
        }
        if self.locked {
            w *= 1.0 + INCUMBENT * bump(lag / (self.period * self.fps));
        }
        w
    }

    fn level_score(&mut self, lag: f32, faster_free: bool) -> f32 {
        let l = lag.round() as usize;
        if l < self.lag_min || l > self.lag_max {
            return 0.0;
        }
        let gq = self.grid_quality(l as f32);
        self.tg[l].max(0.0) * (0.45 + 0.55 * gq) * self.level_prior(l as f32, faster_free)
    }

    fn grid_quality(&mut self, p: f32) -> f32 {
        let pp = (p.round() as usize).clamp(2, self.fold.len() - 1);
        let n = self.work_n;
        if n < pp * 3 {
            return 0.3;
        }
        let fold = &mut self.fold[..pp];
        fold.iter_mut().for_each(|v| *v = 0.0);
        let mut total = 0.0;
        for i in 0..n {
            fold[i % pp] += self.work[i];
            total += self.work[i];
        }
        if total < 1e-6 {
            return 0.0;
        }
        let r = (self.kernel.len() - 1) / 2;
        let w = r.max((pp as f32 * 0.04).round() as usize) as isize;
        let mut best = 0.0;
        for k in 0..pp as isize {
            let mut s = 0.0;
            for j in -w..=w {
                s += fold[(((k + j) % pp as isize) + pp as isize) as usize % pp];
            }
            if s > best {
                best = s;
            }
        }
        let share = best / total;
        let baseline = ((2 * w + 1) as f32 / pp as f32).min(1.0);
        ((share - baseline) / (1.0 - baseline).max(1e-6)).max(0.0)
    }

    /// How strong the half-period position of a fold is against its peak.
    fn fold_half_ratio(&mut self, p: f32, full: bool) -> f32 {
        let pp = (p.round() as usize).clamp(2, self.fold.len() - 1);
        let n = self.work_n;
        let fold = &mut self.fold[..pp];
        fold.iter_mut().for_each(|v| *v = 0.0);
        let mut total = 0.0;
        {
            let src = if full { &self.work_body } else { &self.work_low };
            for i in 0..n {
                fold[i % pp] += src[i];
                total += src[i];
            }
        }
        if total < 1e-5 {
            return -1.0;
        }
        let w = ((0.03 * self.fps).round() as isize).max(1);
        let around = |fold: &[f32], c: isize| -> f32 {
            let mut s = 0.0;
            for j in -w..=w {
                s += fold[(((c + j) % pp as isize) + pp as isize) as usize % pp];
            }
            s
        };
        let mut p0 = 0usize;
        for k in 1..pp {
            if fold[k] > fold[p0] {
                p0 = k;
            }
        }
        let mut floor_w = f32::INFINITY;
        for k in 0..pp as isize {
            let s2 = around(fold, k);
            if s2 < floor_w {
                floor_w = s2;
            }
        }
        let a = around(fold, p0 as isize) - floor_w;
        let b = around(fold, p0 as isize + (pp as f32 / 2.0).round() as isize) - floor_w;
        if a > 1e-6 {
            b.max(0.0) / a
        } else {
            0.0
        }
    }

    /// A kick or snare the detector confirmed, at `t` (the analyser's clock).
    pub fn note_hit(&mut self, t: f64) {
        self.hits[self.hits_n % PULSE_KEEP] = t;
        self.hits_n += 1;
    }

    /// The drums' pulse as a lag in frames, when the confirmed hits of the last
    /// few seconds are steady and their tempo is a plausible beat. Anything
    /// denser than the pulse more than now and then (a roll, a fill, a
    /// syncopated kick) means there is no single pulse to read, and it says
    /// nothing.
    fn pulse_lag(&self) -> Option<f32> {
        let mut ev = [0f64; PULSE_KEEP];
        let mut n = 0;
        for &t in self.hits.iter().take(self.hits_n.min(PULSE_KEEP)) {
            if t >= self.now_t - PULSE_WINDOW && t <= self.now_t + 0.05 {
                ev[n] = t;
                n += 1;
            }
        }
        if n <= PULSE_MIN {
            return None;
        }
        let ev = &mut ev[..n];
        sort_small(ev);
        let mut m = 0;
        for i in 0..n {
            if m == 0 || ev[i] - ev[m - 1] >= PULSE_MERGE {
                ev[m] = ev[i];
                m += 1;
            }
        }
        if m <= PULSE_MIN {
            return None;
        }
        let k = m - 1;
        let mut ioi = [0f64; PULSE_KEEP];
        for i in 0..k {
            ioi[i] = ev[i + 1] - ev[i];
        }
        let mut sorted = ioi;
        let sorted = &mut sorted[..k];
        sort_small(sorted);
        let med = sorted[k / 2];
        if !(med > 0.0) {
            return None;
        }
        // Each interval is a pulse, a pulse split by one hit between (a stray
        // detection, a ghost note: ONE extra hit, not two short intervals), a
        // pulse with a hit missing, or something else — a roll, a fill, a
        // syncopation — which, if it happens more than now and then, means
        // there is no single pulse here to read.
        let (mut on, mut extra, mut multiple, mut other, mut sum) = (0usize, 0usize, 0usize, 0usize, 0f64);
        let near = |x: f64, k: f64| (x / (med * k) - 1.0).abs() < PULSE_TOL;
        let mut i = 0;
        while i < k {
            let x = ioi[i];
            if near(x, 1.0) {
                on += 1;
                sum += x;
                i += 1;
            } else if x < med && i + 1 < k && near(x + ioi[i + 1], 1.0) {
                on += 1;
                extra += 1;
                sum += x + ioi[i + 1];
                i += 2;
            } else if near(x, 2.0) || near(x, 3.0) {
                // A hit that did not come (or was not heard): the pulse holds.
                multiple += 1;
                i += 1;
            } else {
                other += 1;
                i += 1;
            }
        }
        let units = on + multiple + other;
        if on < PULSE_MIN || extra * 5 > on || other * 10 > units {
            return None;
        }
        let period = sum / on as f64;
        let bpm = 60.0 / period;
        if bpm < self.prior_lo as f64 * 0.97 || bpm > self.prior_hi as f64 * 1.03 {
            return None;
        }
        Some((period * self.fps as f64) as f32)
    }

    fn octave_evidence(&mut self, lag_f: f32) -> f32 {
        let here = self.level_score(lag_f, false);
        let here_free = self.level_score(lag_f, true);
        let r_slow = if lag_f * 2.0 <= self.lag_max as f32 && here > 1e-9 {
            self.level_score(lag_f * 2.0, false) / here
        } else {
            0.0
        };
        // The FASTER level is scored WITHOUT the seed's bell: a figure
        // published at half the tempo must not be able to veto the kicks.
        let r_fast = if lag_f / 2.0 >= self.lag_min as f32 && here_free > 1e-9 {
            self.level_score(lag_f / 2.0, true) / here_free
        } else {
            0.0
        };
        let mut v = 0.0;
        // The drums' pulse, against this level: twice as fast as it (the grid
        // is counting the offbeats too) or the pulse itself (nothing faster).
        let (pulse_slower, pulse_holds) = match self.pulse_lag() {
            Some(pl) => {
                let r = pl / lag_f;
                ((r - 2.0).abs() < 0.14, (r - 1.0).abs() < 0.07)
            }
            None => (false, false),
        };
        #[cfg(feature = "trace")]
        {
            eprintln!("  pulse {:?} slower={} holds={}", self.pulse_lag().map(|l| 60.0 * self.fps / l), pulse_slower, pulse_holds);
            let dbl = if lag_f * 2.0 <= self.lag_max as f32 { self.fold_half_ratio(lag_f * 2.0, true) } else { -9.0 };
            let half = if lag_f / 2.0 >= self.lag_min as f32 { self.fold_half_ratio(lag_f, false) } else { -9.0 };
            eprintln!("  oct lag={:.1} here={:.3} rSlow={:.2} rFast={:.2} dbl={:.2} half={:.2} lagmax={} lagmin={}", lag_f, here, r_slow, r_fast, dbl, half, self.lag_max, self.lag_min);
        }
        if lag_f * 2.0 <= self.lag_max as f32 {
            let dbl = self.fold_half_ratio(lag_f * 2.0, true);
            if dbl >= 0.0 {
                v += ramp_down(dbl, 0.45, 0.22) * (1.0 - ramp_down(r_slow, LEVEL_VETO, 0.25));
            }
            v += ramp_up(r_slow, LEVEL_EDGE, LEVEL_SPAN);
            if pulse_slower {
                v += PULSE_VOTE;
            }
        }
        if lag_f / 2.0 >= self.lag_min as f32 && !pulse_slower && !pulse_holds {
            let half = self.fold_half_ratio(lag_f, false);
            if half >= 0.0 {
                v -= ramp_up(half, 0.72, 0.22) * (1.0 - ramp_down(r_fast, LEVEL_VETO, 0.25));
            }
            v -= ramp_up(r_fast, LEVEL_EDGE, LEVEL_SPAN);
        }
        v.clamp(-1.0, 1.0)
    }

    fn oct_bar(&self, from: f32, to: f32) -> f32 {
        // Moving AWAY from the seed toward a slower level is put beyond reach;
        // moving faster is judged on the ordinary prior (see the header).
        let faster = to < from;
        let g = self.level_prior(to, faster) / self.level_prior(from, faster).max(1e-9);
        (OCT_ON * g.powf(-0.35)).clamp(0.3, 2.5)
    }

    fn correct_octave(&mut self, lag_f: f32) -> (f32, bool) {
        let rf = if self.locked { self.period * self.fps } else { lag_f };
        let ev = self.octave_evidence(rf);
        self.oct_vote += (ev - self.oct_vote) * OCT_SMOOTH;
        let cooled = self.clock - self.last_oct_at > OCT_COOLDOWN;
        let mut level = rf;
        let mut moved = false;
        if cooled && self.oct_vote > self.oct_bar(rf, rf * 2.0) && rf * 2.0 <= self.lag_max as f32 {
            level = rf * 2.0;
            moved = true;
        } else if cooled && self.oct_vote < -self.oct_bar(rf, rf / 2.0) && rf / 2.0 >= self.lag_min as f32 {
            level = rf / 2.0;
            moved = true;
        }
        if moved {
            self.last_oct_at = self.clock;
            self.oct_vote = 0.0;
            // A move to a faster level while seeded means the seed was at
            // half: re-anchor it where the kicks are.
            if self.seed_lag > 0.0 && level < rf * 0.75 && (self.seed_lag / level - 2.0).abs() < 0.2 {
                self.seed_lag /= 2.0;
            }
            self.seed_up = 0.0;
        } else if self.seed_lag > 0.0 {
            let want_fast = self.oct_vote < -OCT_ON && rf / 2.0 >= self.lag_min as f32;
            if want_fast {
                self.seed_up += self.est_every;
                if self.seed_up >= SEED_UP_DOUBT {
                    self.seed_lag /= 2.0;
                    self.seed_up = 0.0;
                    self.oct_vote = 0.0;
                }
            } else if self.seed_up > 0.0 {
                self.seed_up = (self.seed_up - self.est_every * 2.0).max(0.0);
            }
        }
        if !self.locked {
            return (level, moved);
        }
        let r = lag_f / level;
        if r > 1.88 && r < 2.12 {
            return (lag_f / 2.0, moved);
        }
        if r > 0.47 && r < 0.53 {
            return (lag_f * 2.0, moved);
        }
        if r > 0.94 && r < 1.06 {
            return (lag_f, moved);
        }
        (if moved { level } else { lag_f }, moved)
    }

    fn fill_work(&mut self) {
        let n = self.filled;
        self.work_n = n;
        let base = self.head + self.len * 2 - n;
        for i in 0..n {
            let j = (base + i) % self.len;
            self.work[i] = self.odf[j];
            self.work_low[i] = self.odf_low[j];
            self.work_body[i] = self.odf_body[j];
        }
        let k = &self.kernel;
        let r = (k.len() - 1) / 2;
        for which in 0..3 {
            let buf = match which {
                0 => &mut self.work,
                1 => &mut self.work_low,
                _ => &mut self.work_body,
            };
            for i in 0..n {
                let mut s = 0.0;
                let lo = i.saturating_sub(r);
                let hi = (i + r).min(n - 1);
                for x in lo..=hi {
                    s += buf[x] * k[x + r - i];
                }
                self.tmp[i] = s;
            }
            buf[..n].copy_from_slice(&self.tmp[..n]);
        }
    }

    fn estimate(&mut self) {
        let n = self.filled;
        if n < (self.fps * 3.0) as usize {
            return;
        }
        self.fill_work();
        let r_n = n.min((self.fps * 1.5).round() as usize);
        let mut recent = 0.0;
        for i in n - r_n..n {
            recent += self.work[i];
        }
        recent /= r_n as f32;
        let mut overall = 0.0;
        for i in 0..n {
            overall += self.work[i];
        }
        overall /= n as f32;
        self.out.dbg = [recent, overall, self.activity];
        // `activity` is how dense this track's onsets normally are, as a
        // WINDOW mean: up over a few seconds, down over half a minute. It used
        // to be an asymmetric average of the raw onset function itself, which
        // is spiky — a hit every beat and nothing between — so the fast rise
        // caught every spike and the slow fall never caught up: it settled at
        // three times the true density, every window then looked "emptier
        // than this track normally is", and the tempo coasted through entire
        // drops with its confidence decaying 3% an estimate (measured on the
        // eval's techno: 0.66 to 0.01 across one drop).
        let quiet_window = self.activity > 0.0 && overall < self.activity * 0.45;
        let up = overall > self.activity;
        let a = 1.0 - (-self.est_every / if up { 3.0 } else { 30.0 }).exp();
        self.activity += (overall - self.activity) * a;
        if self.locked && (recent < overall * 0.35 || quiet_window) {
            self.confidence *= 0.97;
            return;
        }
        let mut mean = 0.0;
        for i in 0..n {
            mean += self.work[i];
        }
        mean /= n as f32;
        let mut energy = 0.0;
        for i in 0..n {
            let d = self.work[i] - mean;
            self.dev[i] = d;
            energy += d * d;
        }
        if energy < 1e-9 {
            self.confidence *= 0.7;
            return;
        }
        for lag in self.lag_min..=self.acf_max {
            let mut s = 0.0;
            let d = &self.dev;
            for i in lag..n {
                s += d[i] * d[i - lag];
            }
            self.acf[lag] = s / energy;
        }
        self.est_count += 1;
        let tg_alpha = 1.0 - (-self.est_every / TG_TAU).exp();
        let a = tg_alpha.max(1.0 / self.est_count as f32);
        for lag in self.lag_min..=self.lag_max {
            let mut s = self.acf[lag];
            for h in 2..=HARMONICS {
                let l = lag * h;
                if l > self.acf_max {
                    break;
                }
                s += self.acf[l] / h as f32;
            }
            s /= self.harm_w;
            self.tg[lag] += (s - self.tg[lag]) * a;
        }
        let mut best_lag = 0;
        let mut best_score = -1.0;
        for lag in self.lag_min..=self.lag_max {
            let s = self.tg[lag] * self.weight_for(lag as f32);
            self.cand[lag] = s;
            if s > best_score {
                best_score = s;
                best_lag = lag;
            }
        }
        if best_lag == 0 {
            return;
        }
        self.list.clear();
        for lag in self.lag_min + 1..self.lag_max {
            if self.cand[lag] >= self.cand[lag - 1] && self.cand[lag] > self.cand[lag + 1] {
                self.list.push(lag);
            }
        }
        {
            let cand = &self.cand;
            self.list.sort_by(|x, y| cand[*y].partial_cmp(&cand[*x]).unwrap_or(core::cmp::Ordering::Equal));
        }
        self.shortlist.clear();
        let peak_slots = PEAK_SLOTS * self.fps / 100.0;
        for &lag in self.list.iter() {
            if self.shortlist.len() >= SHORTLIST {
                break;
            }
            let dup = self
                .shortlist
                .iter()
                .any(|&l| ((lag as f32 / l as f32).ln()).abs() < BUMP_W || (lag as f32 - l as f32).abs() < peak_slots);
            if !dup {
                self.shortlist.push(lag);
            }
        }
        if self.shortlist.is_empty() {
            self.shortlist.push(best_lag);
        }
        let mut winner = self.shortlist[0];
        let mut winner_score = -1.0;
        let mut runner_up = -1.0;
        for i in 0..self.shortlist.len() {
            let lag = self.shortlist[i];
            let s = self.cand[lag] * (0.45 + 0.55 * self.grid_quality(lag as f32));
            if s > winner_score {
                runner_up = winner_score;
                winner_score = s;
                winner = lag;
            } else if s > runner_up {
                runner_up = s;
            }
        }
        let y1 = self.tg[winner];
        let y0 = if winner > self.lag_min { self.tg[winner - 1] } else { y1 };
        let y2 = if winner < self.lag_max { self.tg[winner + 1] } else { y1 };
        let denom = y0 - 2.0 * y1 + y2;
        let shift = if denom != 0.0 { 0.5 * (y0 - y2) / denom } else { 0.0 };
        let lag_f0 = winner as f32 + shift.clamp(-0.5, 0.5);
        let (lag_f, moved) = self.correct_octave(lag_f0);
        let new_period = lag_f / self.fps;
        #[cfg(feature = "trace")]
        {
            let mut line = format!(
                "t={:.2} locked={} bpm={:.1} conf={:.2} vote={:.2} win={:.1} -> {:.1} |",
                self.clock, self.locked, self.bpm, self.confidence, self.oct_vote,
                60.0 * self.fps / lag_f0, 60.0 * self.fps / lag_f
            );
            for i in 0..self.shortlist.len() {
                let l = self.shortlist[i];
                let gq = self.grid_quality(l as f32);
                line += &format!(" {:.1}:{:.3}/gq{:.2}", 60.0 * self.fps / l as f32, self.cand[l], gq);
            }
            eprintln!("{}", line);
        }

        let margin = if runner_up > 0.0 {
            ((winner_score - runner_up) / (winner_score + 1e-6)).max(0.0)
        } else {
            1.0
        };
        let conf = (self.tg[winner] * 2.2).clamp(0.0, 1.0) * (0.35 + 0.65 * margin);
        self.confidence = self.confidence * 0.55 + conf * 0.45;
        if self.seed_lag > 0.0 && ((self.period * self.fps / self.seed_lag).ln()).abs() < BUMP_W {
            self.confidence = self.confidence.max(SEED_FLOOR);
        }
        let ratio = new_period / self.period;
        if !self.locked {
            if self.confidence > 0.25 {
                self.period = new_period;
                self.locked = true;
                self.challenger = 0.0;
                self.challenge_count = 0;
                self.out.retimed += 1;
            }
        } else if ratio > 0.94 && ratio < 1.06 {
            self.period = self.period * 0.75 + new_period * 0.25;
            self.challenger = 0.0;
            self.challenge_count = 0;
        } else if (ratio.log2().abs() - 1.0).abs() < 0.08 {
            self.out.octave_ratio = if ratio > 1.0 { 2.0 } else { 0.5 };
            self.period = new_period;
            self.challenger = 0.0;
            self.challenge_count = 0;
            self.out.leveled += 1;
        } else if self.challenger > 0.0 && ((lag_f / self.challenger).ln()).abs() < BUMP_W {
            self.challenge_count += 1;
            if self.challenge_count >= CHALLENGE_NEEDED && self.confidence > 0.42 {
                self.period = new_period;
                self.challenger = 0.0;
                self.challenge_count = 0;
                self.out.retimed += 1;
            }
        } else {
            self.challenger = lag_f;
            self.challenge_count = 1;
        }
        let _ = moved;
        self.bpm = 60.0 / self.period;
        if self.confidence < 0.12 {
            self.locked = false;
        }
        self.measure_kick_pulse();
    }

    fn measure_kick_pulse(&mut self) {
        let n = self.work_n;
        let pp = ((self.period * self.fps).round() as usize).clamp(2, self.fold.len() - 1);
        if n < pp * 2 {
            return;
        }
        let fold = &mut self.fold[..pp];
        fold.iter_mut().for_each(|v| *v = 0.0);
        let mut total = 0.0;
        for i in 0..n {
            let v = self.work_low[i];
            fold[i % pp] += v;
            total += v;
        }
        if total < 1e-6 {
            self.kick_pulse *= 0.8;
            return;
        }
        let r = (self.kernel.len() - 1) / 2;
        let w = r.max((pp as f32 * 0.05).round() as usize) as isize;
        let mut best = 0.0;
        for k in 0..pp as isize {
            let mut s2 = 0.0;
            for j in -w..=w {
                s2 += fold[(((k + j) % pp as isize) + pp as isize) as usize % pp];
            }
            if s2 > best {
                best = s2;
            }
        }
        let share = best / total;
        let baseline = ((2 * w + 1) as f32 / pp as f32).min(1.0);
        let norm = ((share - baseline) / (1.0 - baseline).max(1e-6)).max(0.0);
        self.kick_pulse = self.kick_pulse * 0.7 + (norm * 1.25).min(1.0) * 0.3;
    }

    /// Feed one frame: the raw SuperFlux, the low-band evidence, and the
    /// strength of a kick CONFIRMED on this frame (0 when none).
    pub fn process(&mut self, t: f64, flux: f32, low_flux: f32, mid_flux: f32, kick: f32, dt: f32) -> &TempoOut {
        let dt = dt.clamp(1e-4, 0.25);
        self.clock += dt;
        self.now_t = t;
        let mean_tau = MEAN_TAU.max(MEAN_BEATS * self.period);
        let a_mean = 1.0 - (-dt / mean_tau).exp();
        let a_scale = 1.0 - (-dt / SCALE_TAU).exp();
        self.flux_mean += (flux - self.flux_mean) * a_mean;
        self.low_mean += (low_flux - self.low_mean) * a_mean;
        self.mid_mean += (mid_flux - self.mid_mean) * a_mean;
        let d_flux = (flux - self.flux_mean).max(0.0);
        let d_low = (low_flux - self.low_mean).max(0.0);
        let d_mid = (mid_flux - self.mid_mean).max(0.0);
        self.flux_scale += (d_flux - self.flux_scale) * a_scale;
        self.low_scale += (d_low - self.low_scale) * a_scale;
        self.mid_scale += (d_mid - self.mid_scale) * a_scale;
        let c_flux = (d_flux / (self.flux_scale + 1e-9)).min(SCALE_CLIP) / SCALE_CLIP;
        let c_low = (d_low / (self.low_scale + 1e-9)).min(SCALE_CLIP) / SCALE_CLIP;
        // A confirmed kick is the best evidence there is of where the beat is
        // in every genre this player is pointed at; it rides on the bass half.
        let c_low = (c_low + kick * 0.25).min(1.0);
        let c_mix = (c_flux + c_low * 0.8).min(1.0);
        // The BODY of the music — bass and mids, no cymbals — is the witness
        // for "does anything happen between these beats" (see
        // `octave_evidence`): a snare on the backbeat does, a hi-hat does not.
        let c_mid = (d_mid / (self.mid_scale + 1e-9)).min(SCALE_CLIP) / SCALE_CLIP;
        let c_body = (c_low + c_mid * 0.8).min(1.0);
        // One slot per frame: the analysis rate is fixed, so no resampling.
        self.odf[self.head] = c_mix;
        self.odf_low[self.head] = c_low;
        self.odf_body[self.head] = c_body;
        self.head = (self.head + 1) % self.len;
        if self.filled < self.len {
            self.filled += 1;
        }
        self.out.odf = c_mix;
        self.out.odf_full = c_flux;
        self.out.odf_low = c_low;
        if self.clock - self.last_est > self.est_every {
            self.last_est = self.clock;
            self.estimate();
        }
        self.out.bpm = if self.locked { self.bpm } else { 0.0 };
        self.out.period = self.period;
        self.out.confidence = self.confidence;
        self.out.locked = self.locked;
        self.out.kick_pulse = self.kick_pulse;
        &self.out
    }

    /// The grid's own refinement of the period, fed back so the incumbent
    /// bonus and the octave question are asked about the grid actually on
    /// screen. Only small corrections are accepted here.
    pub fn nudge_period(&mut self, period: f32) {
        if self.locked && period > 0.0 && (period / self.period - 1.0).abs() < 0.03 {
            self.period = period;
            self.bpm = 60.0 / period;
        }
    }

    /// Hand the tracker a tempo measured over the whole track — see tempo.js
    /// for what a late seed does. Returns false for a figure out of range.
    pub fn seed(&mut self, seed_bpm: f32, seed_conf: f32) -> bool {
        if !(seed_bpm >= MIN_BPM && seed_bpm <= MAX_BPM) {
            return false;
        }
        let conf = seed_conf.min(1.0).max(0.0);
        let conf = if conf > 0.0 { conf } else { 0.9 };
        self.seed_lag = self.bpm_to_lag(seed_bpm);
        self.seed_up = 0.0;
        if self.locked {
            let near = ((60.0 / seed_bpm) / self.period).log2().abs();
            if near < 0.09 || (near - 1.0).abs() < 0.09 || (near - 2.0).abs() < 0.09 {
                let ratio = (60.0 / seed_bpm) / self.period;
                if near >= 0.09 {
                    self.out.octave_ratio = ratio;
                    self.out.leveled += 1;
                }
                self.period = 60.0 / seed_bpm;
                self.bpm = seed_bpm;
                self.confidence = self.confidence.max(conf);
                self.challenger = 0.0;
                self.challenge_count = 0;
            }
            return true;
        }
        self.period = 60.0 / seed_bpm;
        self.bpm = seed_bpm;
        self.confidence = self.confidence.max(conf);
        self.locked = true;
        self.challenger = 0.0;
        self.challenge_count = 0;
        self.last_est = -1e9;
        self.out.retimed += 1;
        self.out.bpm = self.bpm;
        self.out.period = self.period;
        self.out.confidence = self.confidence;
        self.out.locked = true;
        true
    }

    pub fn set_range(&mut self, lo: f32, hi: f32) {
        if !(lo > 0.0) || !(hi > lo) {
            self.prior_lo = DEFAULT_PRIOR_LO;
            self.prior_hi = DEFAULT_PRIOR_HI;
            return;
        }
        self.prior_lo = lo.clamp(MIN_BPM, MAX_BPM);
        self.prior_hi = hi.clamp(self.prior_lo + 1.0, MAX_BPM);
    }

}

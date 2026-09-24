//! Per-frame descriptors of what the music is doing — a faithful port of
//! lib/audio/features.js, whose comments carry the measurements behind every
//! constant below. The scales are deliberately the SAME as the JavaScript's:
//! the style classifier's thresholds were written against them.
//!
//! One thing changed on the way: this reads LINEAR magnitudes straight off
//! the FFT instead of converting dB back into them (the JavaScript paid an
//! `exp` per bin per frame for that), and its per-bin logarithms are the fast
//! kind. Everything else — SuperFlux against a max-filtered frame 22 ms back,
//! the dynamics gate, the four kick witnesses with the limiter's common mode
//! removed and a Schmitt trigger, the harmonic/percussive split carrying the
//! chroma — is the same arithmetic.

use crate::util::{alpha, fast_log10, fast_log2};

const LOG_C: f32 = 1000.0;
const ODF_LAG: f32 = 0.022;
const HIST: usize = 8;
const DYN_RANGE_DB: f32 = 18.0;
const KICK_REFRACTORY: f32 = 0.048;
const ATTACK_LAG: f32 = 0.026;
const ATK_HIST: usize = 14;
const STRIKE_MIN: f32 = 0.4;
const LOW_STRONG: f32 = 0.8;
const RESTART_MIN: f32 = 0.28;
const SUB_ALONE: f32 = 1.6;
const MIN_LIFT_DB: f32 = 4.5;
const MIN_PITCH_OCT: f32 = 0.1;
const PERC_LO: f32 = 0.008;
const PERC_HI: f32 = 0.035;
const PERC_MIN_LEVEL: f32 = 1e-4;
const REG_VOICED_DB: f32 = 20.0;
const REG_MUTE_DB: f32 = 36.0;
const MIN_CLICK_DB: f32 = 6.0;
const MIN_SUB_DB: f32 = 9.0;
const WITNESS: f32 = 0.22;
const CM_SPREAD_DB: f32 = 5.0;
const KICK_ON: f32 = 0.52;
const KICK_OFF: f32 = 0.18;
const SCALE_TAU: f32 = 9.0;
const SCALE_UP: f32 = 0.4;
const CM_HZ: [f32; 9] = [30.0, 80.0, 160.0, 320.0, 700.0, 1500.0, 3500.0, 8000.0, 16000.0];
const CM_N: usize = 8;

#[derive(Default, Clone)]
pub struct Features {
    pub level: f32,
    pub level_db: f32,
    pub peak: f32,
    pub crest: f32,
    pub dynamics: f32,
    pub loud_ref_db: f32,
    pub flux: f32,
    pub low_flux: f32,
    pub mid_flux: f32,
    /// The mid band's flux NOT gated by the dynamics — what the tempo
    /// estimator reads, like `flux` and `low_flux`.
    pub mid_odf: f32,
    pub high_flux: f32,
    /// The kick envelope scenes draw (0..1, gated by dynamics).
    pub kick: f32,
    /// The raw Schmitt-trigger acceptance on this frame — a CANDIDATE: the
    /// kick detector (kick.rs) confirms it a frame or two later.
    pub kick_candidate: bool,
    pub kick_strength: f32,
    /// The combined evidence before the trigger, and its witnesses.
    pub kick_now: f32,
    pub w_lift: f32,
    pub w_pitch: f32,
    pub w_click: f32,
    pub w_sub: f32,
    /// The kick region's level (dB) and centroid (octaves), and the bottom two
    /// octaves' level — what the confirmation stage follows over time.
    pub reg_db: f32,
    pub reg_cent: f32,
    pub sub_db: f32,
    pub centroid: f32,
    pub centroid_n: f32,
    pub flatness: f32,
    pub rolloff: f32,
    pub rolloff_n: f32,
    pub percussivity: f32,
    pub vocal_mod: f32,
    pub chroma: [f32; 12],
    pub tonal: f32,
    pub melody: f32,
    pub melody_pitch: f32,
    pub melody_flux: f32,
    pub chord_change: f32,
    pub silent: bool,
    /// Sustained (harmonic) energy in the lead register, and how noisy it is:
    /// the raw material of the genre channel (see genre.rs).
    pub harm_mid: f32,
    pub harm_flat: f32,
}

pub struct FeatureExtractor {
    hz_per_bin: f32,
    floor_db: f32,
    mag: Vec<f32>,
    log_mag: Vec<f32>,
    hist: Vec<Vec<f32>>,
    hist_t: [f32; HIST],
    hist_head: usize,
    clock: f32,
    tonal: Vec<f32>,
    harm: Vec<f32>,
    cumul: Vec<f32>,
    chroma_smooth: [f32; 12],
    chroma_ref: [f32; 12],
    chroma_ref_at: f32,
    low0: usize,
    low1: usize,
    reg0: usize,
    reg1: usize,
    click0: usize,
    click1: usize,
    cm_of: Vec<i8>,
    cm_width: [f32; CM_N],
    midf0: usize,
    midf1: usize,
    hif0: usize,
    mid0: usize,
    mid1: usize,
    top: usize,
    mel0: usize,
    mel1: usize,
    pitch_of: Vec<i8>,
    class_bins: [f32; 12],
    log2hz: Vec<f32>,
    reg_wt: Vec<f32>,
    reg_wt_sum: f32,
    // state
    mid_fast: f32,
    mid_slow: f32,
    mod_avg: f32,
    atk_t: [f32; ATK_HIST],
    atk_reg: [f32; ATK_HIST],
    atk_cent: [f32; ATK_HIST],
    atk_click: [f32; ATK_HIST],
    atk_bands: [[f32; CM_N]; ATK_HIST],
    atk_head: usize,
    lift_ref: f32,
    pitch_ref: f32,
    reg_top: f32,
    click_ref: f32,
    sub_ref: f32,
    kick_primed: bool,
    kick_armed: bool,
    last_kick_at: f32,
    last_kick_strength: f32,
    s_level: f32,
    s_centroid: f32,
    s_flatness: f32,
    s_perc: f32,
    s_rolloff: f32,
    loud_ref: f32,
    s_dynamics: f32,
    s_tonal: f32,
    s_melody: f32,
    s_chord: f32,
    mel_pitch: f32,
    pub out: Features,
}

impl FeatureExtractor {
    pub fn new(sr: f32, fft_hi: usize, floor_db: f32) -> FeatureExtractor {
        let n_hi = fft_hi / 2;
        let nyquist = sr / 2.0;
        let hz_per_bin = nyquist / n_hi as f32;
        let b = |hz: f32| -> usize { ((hz / hz_per_bin).round() as i64).clamp(0, n_hi as i64 - 1) as usize };
        let low0 = b(25.0);
        let low1 = b(180.0);
        let reg0 = b(28.0);
        let reg1 = b(420.0);
        let click0 = b(1500.0);
        let click1 = b(7000.0);
        let mut cm_lo = [0usize; CM_N];
        let mut cm_hi = [0usize; CM_N];
        for j in 0..CM_N {
            cm_lo[j] = b(CM_HZ[j]);
            cm_hi[j] = cm_lo[j].max(b(CM_HZ[j + 1]).saturating_sub(1));
        }
        let mut cm_of = vec![-1i8; n_hi];
        let mut cm_width = [0f32; CM_N];
        for j in 0..CM_N {
            for i in cm_lo[j]..=cm_hi[j] {
                cm_of[i] = j as i8;
            }
            cm_width[j] = (cm_hi[j] - cm_lo[j] + 1) as f32;
        }
        let mel0 = b(60.0).max(1);
        let mel1 = b(4000.0);
        let mut pitch_of = vec![-1i8; n_hi];
        let mut class_bins = [0f32; 12];
        for i in mel0..=mel1 {
            let hz = i as f32 * hz_per_bin;
            if hz < 20.0 {
                continue;
            }
            let midi = 69.0 + 12.0 * (hz / 440.0).log2();
            let pc = ((midi.round() as i64 % 12 + 12) % 12) as usize;
            pitch_of[i] = pc as i8;
            class_bins[pc] += 1.0;
        }
        for c in class_bins.iter_mut() {
            if *c < 1.0 {
                *c = 1.0;
            }
        }
        let mut log2hz = vec![0f32; n_hi];
        for (i, v) in log2hz.iter_mut().enumerate().skip(1) {
            *v = (i as f32 * hz_per_bin).log2();
        }
        let mut reg_wt = vec![0f32; n_hi];
        let mut reg_wt_sum = 0f32;
        for i in reg0..=reg1 {
            reg_wt[i] = 1.0 / i.max(1) as f32;
            reg_wt_sum += reg_wt[i];
        }
        let mut fx = FeatureExtractor {
            hz_per_bin,
            floor_db,
            mag: vec![0.0; n_hi],
            log_mag: vec![0.0; n_hi],
            hist: (0..HIST).map(|_| vec![0.0; n_hi]).collect(),
            hist_t: [-1.0; HIST],
            hist_head: 0,
            clock: 0.0,
            tonal: vec![0.0; n_hi],
            harm: vec![0.0; n_hi],
            cumul: vec![0.0; n_hi + 1],
            chroma_smooth: [0.0; 12],
            chroma_ref: [0.0; 12],
            chroma_ref_at: 0.0,
            low0,
            low1,
            reg0,
            reg1,
            click0,
            click1,
            cm_of,
            cm_width,
            midf0: b(180.0),
            midf1: b(2000.0),
            hif0: b(2000.0),
            mid0: b(250.0),
            mid1: b(3500.0),
            top: b(16000.0),
            mel0,
            mel1,
            pitch_of,
            class_bins,
            log2hz,
            reg_wt,
            reg_wt_sum,
            mid_fast: 0.0,
            mid_slow: 0.0,
            mod_avg: 0.0,
            atk_t: [-1.0; ATK_HIST],
            atk_reg: [0.0; ATK_HIST],
            atk_cent: [0.0; ATK_HIST],
            atk_click: [0.0; ATK_HIST],
            atk_bands: [[0.0; CM_N]; ATK_HIST],
            atk_head: 0,
            lift_ref: 0.0,
            pitch_ref: 0.0,
            reg_top: -200.0,
            click_ref: 0.0,
            sub_ref: 0.0,
            kick_primed: false,
            kick_armed: true,
            last_kick_at: -1.0,
            last_kick_strength: 0.0,
            s_level: 0.0,
            s_centroid: 0.0,
            s_flatness: 0.0,
            s_perc: 0.0,
            s_rolloff: 0.0,
            loud_ref: floor_db,
            s_dynamics: 0.0,
            s_tonal: 0.0,
            s_melody: 0.0,
            s_chord: 0.0,
            mel_pitch: 0.0,
            out: Features::default(),
        };
        fx.reset();
        fx
    }

    pub fn reset(&mut self) {
        for h in self.hist.iter_mut() {
            h.iter_mut().for_each(|v| *v = 0.0);
        }
        self.hist_t = [-1.0; HIST];
        self.hist_head = 0;
        self.clock = 0.0;
        self.tonal.iter_mut().for_each(|v| *v = 0.0);
        self.chroma_smooth = [0.0; 12];
        self.chroma_ref = [0.0; 12];
        self.chroma_ref_at = 0.0;
        self.mid_fast = 0.0;
        self.mid_slow = 0.0;
        self.mod_avg = 0.0;
        self.atk_t = [-1.0; ATK_HIST];
        self.atk_head = 0;
        self.lift_ref = 0.0;
        self.pitch_ref = 0.0;
        self.reg_top = -200.0;
        self.click_ref = 0.0;
        self.sub_ref = 0.0;
        self.kick_primed = false;
        self.kick_armed = true;
        self.last_kick_at = -1.0;
        self.last_kick_strength = 0.0;
        self.s_level = 0.0;
        self.s_centroid = 0.0;
        self.s_flatness = 0.0;
        self.s_perc = 0.0;
        self.s_rolloff = 0.0;
        self.loud_ref = self.floor_db;
        self.s_dynamics = 0.0;
        self.s_tonal = 0.0;
        self.s_melody = 0.0;
        self.s_chord = 0.0;
        self.mel_pitch = 0.0;
        let o = &mut self.out;
        *o = Features::default();
        o.level_db = self.floor_db;
        o.loud_ref_db = self.floor_db;
        o.silent = true;
    }

    fn past_frame(&self, lag: f32) -> Option<usize> {
        let mut best = None;
        let mut best_err = f32::INFINITY;
        for i in 0..HIST {
            let t = self.hist_t[i];
            if t < 0.0 {
                continue;
            }
            let age = self.clock - t;
            if age < lag * 0.5 {
                continue;
            }
            let err = (age - lag).abs();
            if err < best_err {
                best_err = err;
                best = Some(i);
            }
        }
        best
    }

    /// One frame of the fast spectrum, as LINEAR magnitudes (|X|/N).
    pub fn process(&mut self, hi_mag: &[f32], dt: f32) -> &Features {
        let dt = if dt > 0.0 { dt } else { 1.0 / 60.0 };
        self.clock += dt;
        let floor_mag = 10f32.powf(self.floor_db / 20.0);
        let top = self.top;
        // The frame ~22 ms back, chosen before this one is stored.
        let past = self.past_frame(ODF_LAG);
        let n = top + 1;

        let mut sum = 0f32;
        let mut sum_sq = 0f32;
        let mut peak = 0f32;
        let mut cm_sum = [0f32; CM_N];
        for i in 0..=top {
            let m = if hi_mag[i] > floor_mag { hi_mag[i] } else { floor_mag };
            self.mag[i] = m;
            self.log_mag[i] = fast_log10(1.0 + LOG_C * m);
            sum += m;
            sum_sq += m * m;
            if m > peak {
                peak = m;
            }
            let bj = self.cm_of[i];
            if bj >= 0 {
                cm_sum[bj as usize] += m;
            }
        }
        let _mean = sum / n as f32;
        let rms = (sum_sq / n as f32).sqrt();
        let o = &mut self.out;
        o.peak = peak;
        o.crest = if rms > 1e-6 { peak / rms } else { 0.0 };
        let rms_db = if rms > 1e-7 { 20.0 * fast_log10(rms) } else { self.floor_db };
        o.level_db = rms_db;
        let lvl = ((rms_db + 78.0) / 70.0).clamp(0.0, 1.0);
        self.s_level = if lvl > self.s_level {
            lvl * 0.5 + self.s_level * 0.5
        } else {
            lvl * 0.12 + self.s_level * 0.88
        };
        o.level = self.s_level;
        o.silent = rms_db < self.floor_db + 12.0;

        // --- the dynamics gate ------------------------------------------------
        if rms_db > self.loud_ref {
            self.loud_ref += (rms_db - self.loud_ref) * alpha(dt, 0.4);
        } else {
            self.loud_ref += (rms_db - self.loud_ref) * alpha(dt, 25.0);
        }
        o.loud_ref_db = self.loud_ref;
        let dyn_ = ((rms_db - (self.loud_ref - DYN_RANGE_DB)) / DYN_RANGE_DB).clamp(0.0, 1.0);
        self.s_dynamics = if dyn_ > self.s_dynamics {
            self.s_dynamics + (dyn_ - self.s_dynamics) * alpha(dt, 0.06)
        } else {
            self.s_dynamics + (dyn_ - self.s_dynamics) * alpha(dt, 0.45)
        };
        o.dynamics = self.s_dynamics;
        let sd = self.s_dynamics;

        // --- SuperFlux -----------------------------------------------------------
        let mut flux = 0f32;
        let mut low_flux = 0f32;
        let mut mid_flux = 0f32;
        let mut high_flux = 0f32;
        if let Some(pi) = past {
            let p = &self.hist[pi];
            for i in 0..=top {
                let mut r = p[i];
                if i > 0 && p[i - 1] > r {
                    r = p[i - 1];
                }
                if i < top && p[i + 1] > r {
                    r = p[i + 1];
                }
                let d = self.log_mag[i] - r;
                if d > 0.0 {
                    flux += d;
                    if i >= self.low0 && i <= self.low1 {
                        low_flux += d;
                    } else if i >= self.midf0 && i < self.midf1 {
                        mid_flux += d;
                    } else if i >= self.hif0 {
                        high_flux += d;
                    }
                }
            }
        }
        o.flux = flux / n as f32;
        let low_odf = low_flux / (self.low1 - self.low0 + 1).max(1) as f32;
        let mid_norm = mid_flux / (self.midf1 - self.midf0).max(1) as f32;
        o.mid_flux = mid_norm * sd;
        o.mid_odf = mid_norm;
        o.high_flux = (high_flux / (top - self.hif0 + 1).max(1) as f32) * sd;

        let head = self.hist_head;
        self.hist_t[head] = self.clock;
        self.hist[head][..n].copy_from_slice(&self.log_mag[..n]);
        self.hist_head = (head + 1) % HIST;

        // --- the kick: four witnesses, none of which is the level --------------
        let click_lo = {
            let mut s = 0f32;
            for i in self.click0..=self.click1 {
                s += self.mag[i];
            }
            (s / (self.click1 - self.click0 + 1) as f32).max(1e-9)
        };
        let dtc = dt.clamp(1.0 / 400.0, 0.02);
        let mut reg_sum = 0f32;
        let mut reg_w = 0f32;
        for i in self.reg0..=self.reg1 {
            let m = self.mag[i] * self.reg_wt[i];
            reg_sum += m;
            reg_w += m * self.log2hz[i];
        }
        let mut cm_now = [0f32; CM_N];
        for j in 0..CM_N {
            cm_now[j] = 20.0 * fast_log10((cm_sum[j] / self.cm_width[j]).max(1e-9));
        }
        let reg_db = 20.0 * fast_log10((reg_sum / self.reg_wt_sum).max(1e-9));
        let reg_cent = if reg_sum > 1e-12 { reg_w / reg_sum } else { self.log2hz[self.reg0] };
        let click_db = 20.0 * fast_log10(click_lo);
        if !self.kick_primed {
            self.kick_primed = true;
            for i in 0..ATK_HIST {
                self.atk_t[i] = -1.0;
                self.atk_reg[i] = reg_db;
                self.atk_cent[i] = reg_cent;
                self.atk_click[i] = click_db;
                self.atk_bands[i] = cm_now;
            }
        }
        let mut rf = self.atk_head;
        let mut ref_err = f32::INFINITY;
        for i in 0..ATK_HIST {
            if self.atk_t[i] < 0.0 {
                continue;
            }
            let age = self.clock - self.atk_t[i];
            if age >= ATTACK_LAG * 0.55 {
                let e2 = (age - ATTACK_LAG).abs();
                if e2 < ref_err {
                    ref_err = e2;
                    rf = i;
                }
            }
        }
        let mut cm_step = [0f32; CM_N];
        for j in 0..CM_N {
            cm_step[j] = cm_now[j] - self.atk_bands[rf][j];
        }
        let sub_raw = (cm_step[0] + cm_step[1]) / 2.0;
        cm_step.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        let median = (cm_step[CM_N / 2 - 1] + cm_step[CM_N / 2]) / 2.0;
        let spread = cm_step[CM_N - 2] - cm_step[1];
        let uniform = (1.0 - spread / CM_SPREAD_DB).max(0.0);
        let common = median.max(0.0) * uniform;
        let sub_step_db = sub_raw - common;
        let lift_db = reg_db - self.atk_reg[rf] - common;
        let pitch_oct = reg_cent - self.atk_cent[rf];
        let click_step_db = click_db - self.atk_click[rf] - common;
        let ah = self.atk_head;
        self.atk_t[ah] = self.clock;
        self.atk_reg[ah] = reg_db;
        self.atk_cent[ah] = reg_cent;
        self.atk_click[ah] = click_db;
        self.atk_bands[ah] = cm_now;
        self.atk_head = (ah + 1) % ATK_HIST;

        let up_a = 1.0 - (-dtc / SCALE_UP).exp();
        let dn_a = 1.0 - (-dtc / SCALE_TAU).exp();
        let adapt = |r: &mut f32, v: f32| {
            *r += (v - *r) * if v > *r { up_a } else { dn_a };
        };
        adapt(&mut self.lift_ref, lift_db);
        adapt(&mut self.pitch_ref, pitch_oct);
        adapt(&mut self.click_ref, click_step_db);
        adapt(&mut self.sub_ref, sub_step_db);
        if self.reg_top < -150.0 {
            self.reg_top = reg_db;
        }
        adapt(&mut self.reg_top, reg_db);
        let voiced = ((REG_MUTE_DB - (self.reg_top - reg_db)) / (REG_MUTE_DB - REG_VOICED_DB)).clamp(0.0, 1.0);
        let w_lift = lift_db.max(0.0) / MIN_LIFT_DB.max(self.lift_ref);
        let w_pitch = (voiced * pitch_oct.max(0.0)) / MIN_PITCH_OCT.max(self.pitch_ref);
        let w_click = click_step_db.max(0.0) / MIN_CLICK_DB.max(self.click_ref);
        let w_sub = sub_step_db.max(0.0) / MIN_SUB_DB.max(self.sub_ref);
        let mut votes = 0;
        if w_lift >= WITNESS {
            votes += 1;
        }
        if w_pitch >= WITNESS {
            votes += 1;
        }
        if w_click >= WITNESS {
            votes += 1;
        }
        if w_sub >= WITNESS * 1.8 {
            votes += 1;
        }
        let mut best = w_lift;
        if w_pitch > best {
            best = w_pitch;
        }
        if w_click > best {
            best = w_click;
        }
        let low_side = if w_lift > w_sub { w_lift } else { w_sub };
        let struck = w_click >= STRIKE_MIN;
        let low = low_side >= LOW_STRONG || (w_pitch >= RESTART_MIN && w_click >= RESTART_MIN);
        let mut kick_now = if (struck && low) || w_sub >= SUB_ALONE {
            best.min(if votes >= 2 { 1.0 } else { KICK_ON * 0.9 }).max(0.0)
        } else {
            0.0
        };
        let o = &mut self.out;
        o.kick_now = kick_now;
        o.w_lift = w_lift;
        o.w_pitch = w_pitch;
        o.w_click = w_click;
        o.w_sub = w_sub;
        o.reg_db = reg_db;
        o.reg_cent = reg_cent;
        o.sub_db = (cm_now[0] + cm_now[1]) * 0.5;
        o.kick_candidate = false;
        if self.kick_armed {
            if kick_now > KICK_ON && self.clock - self.last_kick_at >= KICK_REFRACTORY {
                self.kick_armed = false;
                self.last_kick_at = self.clock;
                self.last_kick_strength = kick_now;
                o.kick_candidate = sd > 0.12;
            }
        } else if kick_now < KICK_OFF {
            self.kick_armed = true;
        }
        if !o.kick_candidate && !self.kick_armed {
            kick_now = kick_now.min(self.last_kick_strength);
        }
        kick_now *= sd;
        o.kick = if kick_now > o.kick { kick_now } else { o.kick * (1.0 - dtc / 0.16).max(0.0) };
        o.kick_strength = self.last_kick_strength;
        o.low_flux = low_odf + 0.0025 * lift_db.max(0.0);

        // --- sustained vs struck, and the melody in the sustained half ------------
        let t_alpha = alpha(dt, 0.25);
        let mut tonal_sum = 0f32;
        let mut total_sum = 0f32;
        self.cumul[0] = 0.0;
        for i in 0..=top {
            let m = self.mag[i];
            self.tonal[i] += (m - self.tonal[i]) * t_alpha;
            let h = if m < self.tonal[i] { m } else { self.tonal[i] };
            self.harm[i] = h;
            self.cumul[i + 1] = self.cumul[i] + h;
            tonal_sum += h;
            total_sum += m;
        }
        let tonal_share = if total_sum > 1e-9 { tonal_sum / total_sum } else { 0.0 };
        self.s_tonal += (tonal_share - self.s_tonal) * 0.05;
        let o = &mut self.out;
        o.tonal = self.s_tonal;

        let mut chroma = [0f32; 12];
        let mut mel_weighted = 0f32;
        let mut mel_energy = 0f32;
        for i in self.mel0..=self.mel1 {
            let pc = self.pitch_of[i];
            if pc < 0 {
                continue;
            }
            let lo = ((i as f32 / 1.26).floor() as usize).max(1);
            let hi = ((i as f32 * 1.26).ceil() as usize).min(top);
            let env = (self.cumul[hi + 1] - self.cumul[lo]) / (hi - lo + 1).max(1) as f32;
            let peakiness = self.harm[i] - env;
            if peakiness > 0.0 {
                chroma[pc as usize] += peakiness;
            }
            mel_weighted += self.harm[i] * i as f32;
            mel_energy += self.harm[i];
        }
        let mut c_sum = 0f32;
        for c in chroma.iter() {
            c_sum += *c;
        }
        let salience = if mel_energy > 1e-9 { c_sum / mel_energy } else { 0.0 };
        let mut c_max = 0f32;
        let mut c_avg_raw = 0f32;
        for k in 0..12 {
            chroma[k] /= self.class_bins[k];
            if chroma[k] > c_max {
                c_max = chroma[k];
            }
            c_avg_raw += chroma[k];
        }
        if c_max > 1e-9 {
            for c in chroma.iter_mut() {
                *c /= c_max;
            }
        } else {
            chroma = [0.0; 12];
        }
        let c_avg = if c_max > 1e-9 { c_avg_raw / (12.0 * c_max) } else { 1.0 };
        let clarity = ((1.0 - c_avg) * 1.6).clamp(0.0, 1.0);
        let strength = (salience * 9.0).clamp(0.0, 1.0);
        self.s_melody += (clarity * strength * (o.tonal * 2.2).min(1.0) - self.s_melody) * 0.06;
        o.melody = self.s_melody;
        if mel_energy > 1e-9 {
            let hz = ((mel_weighted / mel_energy) * self.hz_per_bin).max(60.0);
            let lo = 60f32.ln();
            let span = 4000f32.ln() - lo;
            let p = ((hz.ln() - lo) / span).clamp(0.0, 1.0);
            self.mel_pitch += (p - self.mel_pitch) * 0.08;
        }
        o.melody_pitch = self.mel_pitch;

        let c_alpha = alpha(dt, 0.35);
        if self.chroma_ref_at <= 0.0 {
            self.chroma_ref_at = self.clock;
            self.chroma_smooth = chroma;
            self.chroma_ref = chroma;
        }
        let mut dist = 0f32;
        for k in 0..12 {
            self.chroma_smooth[k] += (chroma[k] - self.chroma_smooth[k]) * c_alpha;
            dist += (self.chroma_smooth[k] - self.chroma_ref[k]).abs();
        }
        if self.clock - self.chroma_ref_at > 0.5 {
            self.chroma_ref_at = self.clock;
            self.chroma_ref = self.chroma_smooth;
        }
        self.s_chord += ((dist / 4.0).min(1.0) - self.s_chord) * 0.1;
        o.chord_change = self.s_chord * sd;
        o.chroma = chroma;
        o.melody_flux = mid_norm * (o.tonal * 2.0).min(1.0) * sd;

        // Centroid.
        let mut wsum = 0f32;
        let mut msum = 0f32;
        for i in 1..=top {
            wsum += self.mag[i] * i as f32;
            msum += self.mag[i];
        }
        let centroid = if msum > 1e-6 { wsum / msum } else { 0.0 } * self.hz_per_bin;
        self.s_centroid = centroid * 0.1 + self.s_centroid * 0.9;
        o.centroid = self.s_centroid;
        let c_lo = 40f32.ln();
        let c_span = 16000f32.ln() - c_lo;
        o.centroid_n = ((self.s_centroid.max(40.0).ln() - c_lo) / c_span).clamp(0.0, 1.0);

        // Flatness over the band where "tonal vs noisy" is informative.
        let mut log_sum = 0f32;
        let mut arith = 0f32;
        let mut cnt = 0f32;
        for i in self.mid0..=self.mid1 {
            let m = if self.mag[i] > 1e-7 { self.mag[i] } else { 1e-7 };
            log_sum += fast_log2(m);
            arith += m;
            cnt += 1.0;
        }
        let geo = if cnt > 0.0 { (log_sum / cnt * core::f32::consts::LN_2).exp() } else { 0.0 };
        let ari = if cnt > 0.0 { arith / cnt } else { 0.0 };
        let flat = if ari > 1e-7 { (geo / ari).clamp(0.0, 1.0) } else { 0.0 };
        self.s_flatness = flat * 0.06 + self.s_flatness * 0.94;
        o.flatness = self.s_flatness;

        // The sustained half's share of the lead register, and its own
        // flatness — a held saw stack is harmonic AND flat, a pad is harmonic
        // and peaked. Read by the genre channel.
        let mut h_log = 0f32;
        let mut h_ari = 0f32;
        let mut h_cnt = 0f32;
        for i in self.mid0..=self.mid1 {
            let h = self.harm[i].max(1e-7);
            h_log += fast_log2(h);
            h_ari += h;
            h_cnt += 1.0;
        }
        o.harm_mid = if h_cnt > 0.0 { h_ari / h_cnt } else { 0.0 };
        let h_geo = if h_cnt > 0.0 { (h_log / h_cnt * core::f32::consts::LN_2).exp() } else { 0.0 };
        o.harm_flat = if h_ari > 1e-7 { (h_geo / (h_ari / h_cnt.max(1.0))).clamp(0.0, 1.0) } else { 0.0 };

        // 85% rolloff.
        let target = msum * 0.85;
        let mut acc = 0f32;
        let mut rb = top;
        for i in 1..=top {
            acc += self.mag[i];
            if acc >= target {
                rb = i;
                break;
            }
        }
        let rolloff = rb as f32 * self.hz_per_bin;
        self.s_rolloff = rolloff * 0.08 + self.s_rolloff * 0.92;
        o.rolloff = self.s_rolloff;
        o.rolloff_n = ((self.s_rolloff.max(40.0).ln() - c_lo) / c_span).clamp(0.0, 1.0);

        // Percussivity: flux against level.
        let p_ratio = o.flux / o.level.max(PERC_MIN_LEVEL);
        let perc = ((p_ratio - PERC_LO) / (PERC_HI - PERC_LO)).clamp(0.0, 1.0);
        self.s_perc = if perc > self.s_perc {
            perc * 0.35 + self.s_perc * 0.65
        } else {
            perc * 0.06 + self.s_perc * 0.94
        };
        o.percussivity = self.s_perc;

        // Syllabic modulation of the mid band.
        let mut mid_e = 0f32;
        for i in self.mid0..=self.mid1 {
            mid_e += self.mag[i];
        }
        mid_e /= (self.mid1 - self.mid0 + 1).max(1) as f32;
        self.mid_fast += (mid_e - self.mid_fast) * alpha(dt, 0.045);
        self.mid_slow += (mid_e - self.mid_slow) * alpha(dt, 0.9);
        let mod_raw = if self.mid_slow > 1e-6 { (self.mid_fast - self.mid_slow).abs() / self.mid_slow } else { 0.0 };
        self.mod_avg += (mod_raw.min(1.5) - self.mod_avg) * alpha(dt, 1.6);
        o.vocal_mod = (self.mod_avg * 1.6 * (1.0 - o.flatness * 1.4)).clamp(0.0, 1.0);

        &self.out
    }

}

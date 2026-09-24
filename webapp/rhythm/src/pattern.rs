//! What the music is DOING: main kick or roll note, and where in the
//! arrangement we are — the reading lib/audio/pattern.js introduced, rebuilt
//! where the eval showed it failing.
//!
//! MAIN KICK OR ROLL keeps pattern.js's rules (on the grid wins over close
//! together; a roll's division is read from the gap), but asks the grid about
//! the kick's own ONSET TIME rather than about whichever frame the detector
//! happened to fire on.
//!
//! THE ARRANGEMENT is a state machine now, because the old reading measured
//! energy against a slow reference and nothing else — and a build is LOUD. On
//! whole records it fired "drop" when the snare roll and the riser came in
//! (every EDM build), not when the drop did: 0 drops found in 2 on almost the
//! whole catalogue, a false one at each build instead, and "build" never rose
//! above 0.2 anywhere. The states:
//!
//!   FULL       the kick is on the grid and the arrangement is in.
//!   BREAKDOWN  the kick has been out for a bar (a track that never had one is
//!              judged on its level instead).
//!   BUILD      something is RISING: onsets per beat accelerating (a snare
//!              roll going quarters -> eighths -> sixteenths, or frenchcore's
//!              kick roll doing the same), the spectrum brightening (a riser, a
//!              filter opening), the level climbing — with the groove not in.
//!   PAUSE      near-silence: the beat producers cut right before a drop. It
//!              is not a breakdown and must not reset anything.
//!
//! A DROP is the first loud main kick after a LULL — at least three and a half
//! beats spent with the kick out or in any of the other three states. It is
//! read off that accumulated lull rather than off the exact transition, which
//! the state machine can make a frame early or late (the groove counts as in
//! for a beat after the build's last kick, the level comes back a frame before
//! the dynamics do): tied to the transition, it found 0 of the 8 drops of the
//! eval's four hardcore records. It anchors the grid's phrase there (beat.rs),
//! so every phrase clock downstream turns over on it.

use crate::util::MinMax;

pub const SEC_UNKNOWN: u8 = 0;
pub const SEC_FULL: u8 = 1;
pub const SEC_BREAKDOWN: u8 = 2;
pub const SEC_BUILD: u8 = 3;
pub const SEC_PAUSE: u8 = 4;

const ON_GRID: f64 = 1.0 / 12.0;
const ON_GRID_MIN: f64 = 0.03;
const ROLL_GAP: f64 = 0.62;
const ROLL_HOLD: f64 = 1.2;
const BIG: f32 = 0.82;
const DROP_HOLD: f64 = 8.0;
const DIVS: [f32; 7] = [2.0, 3.0, 4.0, 6.0, 8.0, 12.0, 16.0];
const HIST: usize = 32;

#[derive(Default, Clone)]
pub struct PatternOut {
    pub kick_hit: bool,
    pub kick_strength: f32,
    pub kick_env: f32,
    pub main_kick: bool,
    pub main_power: f32,
    pub big_kick: bool,
    pub roll_kick: bool,
    pub roll: f32,
    pub roll_div: f32,
    pub roll_notes: f32,
    pub drop: bool,
    pub since_drop: f32,
    pub dropped: f32,
    pub breakdown: f32,
    pub build: f32,
    pub energy: f32,
    pub pause: bool,
    pub section: u8,
    /// Beats until the phrase turns over while a build is running, else -1.
    pub drop_in: f32,
    pub snare_hit: bool,
}

/// One beat's worth of what happened, for the trends.
#[derive(Clone, Copy, Default)]
struct BeatStat {
    onsets: f32,
    kicks: f32,
    level: f32,
    bright: f32,
    low: f32,
}

pub struct FrameIn<'a> {
    pub t: f64,
    pub dt: f64,
    pub kick: Option<(f64, f32)>,
    pub snares: u32,
    pub hat: bool,
    pub psi_kick: Option<f64>,
    pub period: f64,
    pub locked: bool,
    pub beat: bool,
    pub beat_index: f64,
    pub beats_per_bar: u32,
    pub level: f32,
    pub level_db: f32,
    pub loud_ref_db: f32,
    pub dynamics: f32,
    pub percussivity: f32,
    pub centroid_n: f32,
    pub rolloff_n: f32,
    pub low_share: f32,
    /// The highest dynamics reading in the next few frames (the analyser
    /// runs ahead of the output, so a drop's own level is already known).
    pub dyn_ahead: f32,
    /// Notes per second of a kick roll too fast to be separate kicks (see
    /// kick.rs, BUZZ), or 0.
    pub buzz: f32,
    pub _p: core::marker::PhantomData<&'a ()>,
}

pub struct Pattern {
    last_kick: f64,
    last_main: f64,
    main_ref: f32,
    roll_until: f64,
    roll_notes: f32,
    roll_div: f32,
    kick_env: f32,
    main_power: f32,
    energy: f32,
    energy_ref: f32,
    drop_at: f64,
    // sections
    section: u8,
    section_since: f64,
    prev_section: u8,
    prev_len: f64,
    breakdown: f32,
    build: f32,
    build_raw: f32,
    has_kicks: f32,
    hist: [BeatStat; HIST],
    hist_n: usize,
    cur: BeatStat,
    cur_frames: f32,
    last_beat_index: f64,
    clock: f64,
    quiet_since: f64,
    lull: f64,
    heard: f64,
    gap_avg: f32,
    roll_run: f64,
    pub dbg_lull: f64,
    pub out: PatternOut,
}

fn nearest_div(per_beat: f32) -> f32 {
    let mut best = DIVS[0];
    let mut err = f32::INFINITY;
    for &d in DIVS.iter() {
        let e = (per_beat / d).ln().abs();
        if e < err {
            err = e;
            best = d;
        }
    }
    if err < 0.25 {
        best
    } else {
        0.0
    }
}

impl Pattern {
    pub fn new() -> Pattern {
        let mut p = Pattern {
            last_kick: -1e9,
            last_main: -1e9,
            main_ref: 0.0,
            roll_until: -1e9,
            roll_notes: 0.0,
            roll_div: 0.0,
            kick_env: 0.0,
            main_power: 0.0,
            energy: 0.0,
            energy_ref: 0.0,
            drop_at: -1e9,
            section: SEC_UNKNOWN,
            section_since: 0.0,
            prev_section: SEC_UNKNOWN,
            prev_len: 0.0,
            breakdown: 0.0,
            build: 0.0,
            build_raw: 0.0,
            has_kicks: 0.0,
            hist: [BeatStat::default(); HIST],
            hist_n: 0,
            cur: BeatStat::default(),
            cur_frames: 0.0,
            last_beat_index: -1.0,
            clock: 0.0,
            quiet_since: -1.0,
            lull: 0.0,
            heard: 0.0,
            gap_avg: 1.0,
            roll_run: 0.0,
            dbg_lull: 0.0,
            out: PatternOut::default(),
        };
        p.reset();
        p
    }

    pub fn reset(&mut self) {
        self.last_kick = -1e9;
        self.last_main = -1e9;
        self.main_ref = 0.0;
        self.roll_until = -1e9;
        self.roll_notes = 0.0;
        self.roll_div = 0.0;
        self.kick_env = 0.0;
        self.main_power = 0.0;
        self.energy = 0.0;
        self.energy_ref = 0.0;
        self.drop_at = -1e9;
        self.section = SEC_UNKNOWN;
        self.section_since = 0.0;
        self.prev_section = SEC_UNKNOWN;
        self.prev_len = 0.0;
        self.breakdown = 0.0;
        self.build = 0.0;
        self.build_raw = 0.0;
        self.has_kicks = 0.0;
        self.hist = [BeatStat::default(); HIST];
        self.hist_n = 0;
        self.cur = BeatStat::default();
        self.cur_frames = 0.0;
        self.last_beat_index = -1.0;
        self.clock = 0.0;
        self.quiet_since = -1.0;
        self.lull = 0.0;
        self.heard = 0.0;
        self.gap_avg = 1.0;
        self.roll_run = 0.0;
        self.out = PatternOut { since_drop: 999.0, drop_in: -1.0, ..PatternOut::default() };
    }

    fn stat(&self, back: usize) -> Option<&BeatStat> {
        if back >= self.hist_n.fmin(HIST) {
            return None;
        }
        Some(&self.hist[(self.hist_n - 1 - back) % HIST])
    }

    /// Mean of a field over beats [a, b) back from the newest.
    fn mean(&self, a: usize, b: usize, f: fn(&BeatStat) -> f32) -> Option<f32> {
        let mut s = 0.0;
        let mut n = 0.0;
        for k in a..b {
            if let Some(st) = self.stat(k) {
                s += f(st);
                n += 1.0;
            }
        }
        if n > 0.0 {
            Some(s / n)
        } else {
            None
        }
    }

    pub fn update(&mut self, i: &FrameIn) -> (&PatternOut, bool) {
        let dt = if i.dt > 0.0 { i.dt } else { 1.0 / 60.0 };
        self.clock = i.t;
        let mut o = core::mem::take(&mut self.out);
        o.kick_hit = false;
        o.main_kick = false;
        o.big_kick = false;
        o.roll_kick = false;
        o.drop = false;
        o.snare_hit = i.snares > 0;
        let beat = if i.period > 0.15 && i.period < 2.0 { i.period } else { 0.48 };
        let mut anchor = false;

        // --- main kick or roll note ------------------------------------------
        if let Some((kt, power)) = i.kick {
            o.kick_hit = i.dynamics > 0.12;
            o.kick_strength = power;
            self.kick_env = self.kick_env.fmax(power.fmin(1.0) * i.dynamics);
            let gap = kt - self.last_kick;
            let ph = if i.locked { i.psi_kick.map(|p| p.abs()).unwrap_or(0.5) } else { 0.0 };
            let grid = ON_GRID.fmax(ON_GRID_MIN / beat);
            let on_grid = !i.locked || ph <= grid;
            let tight = gap < beat * ROLL_GAP;
            if on_grid && !(tight && ph > grid * 0.5) {
                self.roll_notes = 0.0;
                self.main_ref += (power - self.main_ref) * if power > self.main_ref { 0.12 } else { 0.03 };
                o.main_kick = o.kick_hit;
                self.main_power = power;
                o.big_kick = o.kick_hit && power >= self.main_ref * BIG;
                // How far apart this track's main kicks usually are, in beats:
                // one for four-on-the-floor, two to four for half-time, trap
                // or a breakbeat. A gap longer than two bars is a break, not
                // the pattern.
                let g = ((kt - self.last_main) / beat) as f32;
                if g > 0.4 && g < 8.5 {
                    self.gap_avg += (g.fmin(4.5) - self.gap_avg) * 0.1;
                }
                self.last_main = kt;
            } else if tight {
                let per_beat = (beat / gap.fmax(1e-3)) as f32;
                self.roll_div = nearest_div(per_beat);
                self.roll_notes += 1.0;
                self.roll_until = kt + beat * ROLL_HOLD;
                o.roll_kick = o.kick_hit;
            } else {
                o.roll_kick = o.kick_hit;
                self.roll_until = self.roll_until.fmax(kt + beat * 0.4);
            }
            self.last_kick = kt;
            self.cur.kicks += 1.0;
            self.cur.onsets += 1.0;
        }
        // A buzz has no kicks in it to count — the notes run together — so it
        // is read here as what it is: the densest roll there is, for as long
        // as it sounds.
        if i.buzz > 0.0 {
            let div = nearest_div(i.buzz * beat as f32);
            self.roll_div = if div > 0.0 { div } else { DIVS[DIVS.len() - 1] };
            self.roll_notes = self.roll_notes.fmax(3.0);
            self.roll_until = self.roll_until.fmax(self.clock + beat * ROLL_HOLD);
        }
        o.main_power = self.main_power;
        self.kick_env *= (1.0 - dt as f32 / 0.16).fmax(0.0);
        o.kick_env = self.kick_env;
        if self.clock > self.roll_until {
            self.roll_notes = 0.0;
            self.roll_div = 0.0;
        }
        let roll_left = ((self.roll_until - self.clock).fmax(0.0) / (beat * ROLL_HOLD)) as f32;
        o.roll = (roll_left * (self.roll_notes / 3.0 + 0.34).fmin(1.0)).fmin(1.0);
        o.roll_div = self.roll_div;
        o.roll_notes = self.roll_notes;
        self.cur.onsets += i.snares as f32 + if i.hat { 0.5 } else { 0.0 };

        // --- per-beat bookkeeping --------------------------------------------------
        self.cur.level += i.dynamics;
        self.cur.bright += i.rolloff_n.fmax(i.centroid_n);
        self.cur.low += i.low_share;
        self.cur_frames += 1.0;
        let new_beat = i.beat && i.beat_index != self.last_beat_index;
        if new_beat {
            self.last_beat_index = i.beat_index;
            let n = self.cur_frames.fmax(1.0);
            let st = BeatStat {
                onsets: self.cur.onsets,
                kicks: self.cur.kicks,
                level: self.cur.level / n,
                bright: self.cur.bright / n,
                low: self.cur.low / n,
            };
            self.hist[self.hist_n % HIST] = st;
            self.hist_n += 1;
            self.cur = BeatStat::default();
            self.cur_frames = 0.0;
        }

        // --- the arrangement -------------------------------------------------------
        let now = (i.level * (0.55 + 0.45 * i.percussivity)) * i.dynamics.fmax(0.0);
        self.energy += (now - self.energy) * (1.0 - (-dt / 0.35).exp()) as f32;
        let up = self.energy > self.energy_ref;
        self.energy_ref += (self.energy - self.energy_ref) * (1.0 - (-dt / if up { 3.0 } else { 25.0 }).exp()) as f32;
        let rel = if self.energy_ref > 1e-4 { self.energy / self.energy_ref } else { 1.0 };
        o.energy = rel;

        let kick_out = ((self.clock - self.last_main) / beat) as f32;
        // Does this track have a kick at all? Up when main kicks come
        // regularly, down over half a minute without them.
        // "The kick has been out for a while", in THIS track's terms: a trap
        // kick lands once or twice a bar, and judged by four-on-the-floor
        // every one of its bars was a breakdown and every return a drop
        // (measured: five false drops in one trap record).
        let spacing = self.gap_avg.clamp(1.0, 4.5);
        let kicking = kick_out < 1.6 * spacing;
        self.has_kicks += ((if kicking { 1.0 } else { 0.0 }) - self.has_kicks)
            * (1.0 - (-dt / if kicking { 2.0 } else { 30.0 }).exp()) as f32;
        // A PAUSE is the arrangement cut for at least most of a beat — the
        // beat of silence before a hardcore drop — not the gap between two
        // sparse hits, which an intro can have on every beat.
        if i.level_db < i.loud_ref_db - 24.0 {
            if self.quiet_since < 0.0 {
                self.quiet_since = self.clock;
            }
        } else {
            self.quiet_since = -1.0;
        }
        let gap = self.quiet_since >= 0.0
            && self.clock - self.quiet_since >= (0.6 * beat).fmax(0.15)
            && self.has_kicks > 0.3;

        // BUILD evidence, from the beat history: onsets accelerating, the
        // spectrum brightening, the level climbing — over the last two bars
        // against the two before.
        let mut rising = 0.0f32;
        if self.hist_n >= 8 {
            let d_new = self.mean(0, 4, |s| s.onsets).unwrap_or(0.0);
            let d_old = self.mean(4, 8, |s| s.onsets).unwrap_or(0.0);
            let b_new = self.mean(0, 4, |s| s.bright).unwrap_or(0.0);
            let b_old = self.mean(4, 12, |s| s.bright).unwrap_or(b_new);
            let l_new = self.mean(0, 4, |s| s.level).unwrap_or(0.0);
            let l_old = self.mean(4, 12, |s| s.level).unwrap_or(l_new);
            let acc = if d_old > 0.3 { ((d_new / d_old) - 1.15).clamp(0.0, 1.0) } else if d_new > 1.5 { 0.6 } else { 0.0 };
            let bright = ((b_new - b_old) * 12.0).clamp(0.0, 1.0);
            let louder = ((l_new - l_old) * 4.0).clamp(0.0, 1.0);
            // A dense roll is itself a build even once it has stopped
            // accelerating: two or more hits a beat, the groove out.
            let dense = ((d_new - 1.6) / 2.0).clamp(0.0, 1.0);
            rising = (acc * 0.5 + bright * 0.45 + louder * 0.35 + dense * 0.45).fmin(1.0);
        }
        // The groove being IN cancels a build: a full drop with a busy hat
        // pattern is not a riser.
        // A roll that has run for more than two bars is not a build any more,
        // it is the groove: metal's double kick, a speedcore stream. Read as a
        // build, every chorus after one was a drop.
        if o.roll > 0.3 {
            self.roll_run += dt;
        } else if kick_out > 1.5 * spacing {
            self.roll_run = 0.0;
        }
        let long_roll = self.roll_run > beat * 8.0;
        let rolling = o.roll > 0.3 && !long_roll;
        let groove_in = kick_out < 1.3 * spacing && !rolling;
        let groove_gate = if groove_in { 0.15 } else { 1.0 };
        let raw = rising * groove_gate;
        self.build_raw += (raw - self.build_raw) * (1.0 - (-dt / (beat * 1.5)).exp()) as f32;

        // --- the state machine --------------------------------------------------------
        let prev = self.section;
        let mut next = prev;
        let in_len = self.clock - self.section_since;
        if gap {
            next = SEC_PAUSE;
        } else if self.has_kicks > 0.3 {
            if groove_in && i.dynamics > 0.45 {
                next = SEC_FULL;
            } else if self.build_raw > 0.42 {
                next = SEC_BUILD;
            } else if kick_out > 4.0 * spacing.fmax(1.0).sqrt().fmax(1.0) + (spacing - 1.0) {
                next = if self.build_raw > 0.3 && prev == SEC_BUILD { SEC_BUILD } else { SEC_BREAKDOWN };
            }
        } else {
            // A track with no kick: its arrangement is its level.
            next = if rel < 0.62 { SEC_BREAKDOWN } else if self.build_raw > 0.5 { SEC_BUILD } else { SEC_FULL };
        }
        if next != prev {
            if prev != SEC_PAUSE {
                self.prev_section = prev;
                self.prev_len = in_len;
            }
            self.section = next;
            self.section_since = self.clock;
        }
        // --- the drop -------------------------------------------------------------
        // The lull: time spent with the arrangement out (see the header). A
        // kick roll that has just stopped accelerating into regular main kicks
        // counts, through BUILD, even though the kick never left.
        // A roll is not the groove either: a kick roll into a drop keeps the
        // kick on every beat while it accelerates, and only its rolling
        // stretch tells the build from the drop.
        let out = kick_out > 3.5 + (spacing - 1.0) || self.section != SEC_FULL || rolling;
        if i.level_db > i.loud_ref_db - 40.0 {
            self.heard += dt;
        }
        // It FADES while the groove is in rather than resetting: inside a roll
        // the on-beat notes are main kicks and briefly look like the groove,
        // and a reset on each of them erased the whole build (measured, the
        // lull never exceeded a fifth of a second through uptempo's).
        if out {
            self.lull += dt;
        } else {
            self.lull *= (-dt / (beat * 2.0)).exp();
        }
        self.dbg_lull = self.lull;
        // ...then a main kick, with the level there to back it (the analyser
        // has already heard the next few frames).
        if o.main_kick {
            if self.lull >= (beat * 3.5).fmax(1.2) && i.dyn_ahead > 0.6 && self.clock - self.drop_at > beat * 8.0 && self.heard > 6.0 {
                o.drop = true;
                self.drop_at = self.clock;
                anchor = true;
                if self.section != SEC_FULL {
                    self.prev_section = self.section;
                    self.prev_len = self.clock - self.section_since;
                    self.section = SEC_FULL;
                    self.section_since = self.clock;
                }
            }
            if o.drop {
                self.lull = 0.0;
            }
        }
        let bd_target = if self.section == SEC_BREAKDOWN { 1.0 } else { 0.0 };
        self.breakdown += (bd_target - self.breakdown) * (1.0 - (-dt / 0.6).exp()) as f32;
        let bl_target = if self.section == SEC_BUILD { self.build_raw.fmax(0.45).fmin(1.0) } else { 0.0 };
        self.build += (bl_target - self.build) * (1.0 - (-dt / (beat * 0.8)).exp()) as f32;
        o.breakdown = self.breakdown;
        o.build = self.build;
        o.pause = self.section == SEC_PAUSE;
        o.section = self.section;
        o.since_drop = (self.clock - self.drop_at) as f32;
        o.dropped = (1.0 - (self.clock - self.drop_at) / DROP_HOLD).fmax(0.0) as f32;
        o.drop_in = if self.section == SEC_BUILD {
            let bpb = i.beats_per_bar.fmax(2) as f64;
            let ph = 4.0 * bpb;
            (ph - i.beat_index.rem_euclid(ph)) as f32
        } else {
            -1.0
        };
        self.out = o;
        (&self.out, anchor)
    }
}

impl Default for Pattern {
    fn default() -> Self {
        Self::new()
    }
}

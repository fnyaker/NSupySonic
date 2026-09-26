//! The MUSICAL READING every animation is timed by — lib/viz/musical.js, in
//! Rust. See that file for the vocabulary (a world never says "seconds": it
//! says beats, bars, phrases, and the stamps of events on the beat clock) and
//! for why each rule is there; they are ported here exactly, in f64 like the
//! JavaScript they replace, and test/vizcore.test.mjs holds every field to the
//! JavaScript's own values frame by frame.
//!
//! The clock is the spine: continuous, monotonic, PHASE-LOCKED to the tracker
//! while it holds the grid (a correction is spread over CORRECT_TAU and can
//! slow the clock but never stop it or send it back).

use crate::util::{exp64, MinMax};

const FALLBACK_BPM: f64 = 124.0;
const FALLBACK_BEAT: f64 = 60.0 / FALLBACK_BPM;
const CORRECT_TAU: f64 = 0.12;
const MIN_ADVANCE: f64 = 0.3;
const NEVER: f64 = -1e9;

// The secondary drum events: a spike of a band's flux over a slow average of
// it, with a refractory period in beats.
const SNARE_RISE: f64 = 1.8;
const SNARE_FLOOR: f64 = 0.004;
const SNARE_AVG: f64 = 2.0;
const SNARE_GAP: f64 = 0.42;
const HAT_RISE: f64 = 1.6;
const HAT_FLOOR: f64 = 0.002;
const HAT_AVG: f64 = 1.0;
const HAT_GAP: f64 = 0.2;
const NOTE_RISE: f64 = 1.7;
const NOTE_FLOOR: f64 = 0.002;
const NOTE_AVG: f64 = 2.0;
const NOTE_GAP: f64 = 0.24;
const CHORD_ON: f64 = 0.3;
const CHORD_GAP: f64 = 1.0;

// --- the input: one analysis frame, as the page flattens it -----------------------
//
// Named slots in a flat array, declared once here and read by name on the page
// (`viz_motion_in_layout`), like the analyser's own frame.
macro_rules! slots {
    ($($name:ident = $idx:expr, $len:expr;)*) => {
        $(pub const $name: usize = $idx;)*
        pub const IN_FIELDS: &[(&str, usize, usize)] = &[$((stringify!($name), $idx, $len)),*];
    };
}
slots! {
    I_LOCKED = 0, 1;
    I_PERIOD = 1, 1;
    I_BPB = 2, 1;
    I_BPM = 3, 1;
    I_PHASE = 4, 1;
    I_BEAT_INDEX = 5, 1;
    I_BAR_POS = 6, 1;
    I_BEAT = 7, 1;
    I_DOWNBEAT = 8, 1;
    I_ONSET = 9, 1;
    I_KICK = 10, 1;
    I_KICK_HIT = 11, 1;
    I_LEVEL = 12, 1;
    I_DYNAMICS = 13, 1;
    I_PERCUSSIVITY = 14, 1;
    I_CENTROID_N = 15, 1;
    I_MID_FLUX = 16, 1;
    I_HIGH_FLUX = 17, 1;
    I_MELODY_FLUX = 18, 1;
    I_CHORD_CHANGE = 19, 1;
    I_HAS_PATTERN = 20, 1;
    I_MAIN_KICK = 21, 1;
    I_MAIN_POWER = 22, 1;
    I_BIG_KICK = 23, 1;
    I_ROLL_KICK = 24, 1;
    I_ROLL = 25, 1;
    I_ROLL_DIV = 26, 1;
    I_DROP = 27, 1;
    I_DROPPED = 28, 1;
    I_SINCE_DROP = 29, 1;
    I_BUILD = 30, 1;
    I_BREAKDOWN = 31, 1;
    I_HAS_ENERGY = 32, 1;
    I_ENERGY = 33, 6;
    I_HAS_LOOK = 39, 1;
    I_LOOK = 40, 7;
    I_HAS_GENRE = 47, 1;
    I_GENRE = 48, 8;
    I_HAS_MAIN_POWER = 56, 1;
}
pub const IN_LEN: usize = 57;

// --- the output: the reading, flat --------------------------------------------------
macro_rules! outs {
    ($($name:ident = $idx:expr, $len:expr;)*) => {
        $(pub const $name: usize = $idx;)*
        pub const OUT_FIELDS: &[(&str, usize, usize)] = &[$((stringify!($name), $idx, $len)),*];
    };
}
outs! {
    O_BEAT = 0, 1;
    O_BAR = 1, 1;
    O_PHRASE = 2, 1;
    O_BPB = 3, 1;
    O_BEAT_PHASE = 4, 1;
    O_BAR_PHASE = 5, 1;
    O_PHRASE_PHASE = 6, 1;
    O_BPM = 7, 1;
    O_LOCKED = 8, 1;
    O_BEATS = 9, 1;
    O_BARS = 10, 1;
    O_PHRASES = 11, 1;
    O_ON_BEAT = 12, 1;
    O_ON_BAR = 13, 1;
    O_ON_PHRASE = 14, 1;
    O_BEAT_INDEX = 15, 1;
    O_BAR_INDEX = 16, 1;
    O_KICK = 17, 1;
    O_HIT = 18, 1;
    O_NOTE = 19, 1;
    O_CHORD = 20, 1;
    O_ONSET = 21, 1;
    O_SNARE_HIT = 22, 1;
    O_HAT_HIT = 23, 1;
    O_NOTE_HIT = 24, 1;
    O_STAMP = 25, 11;
    O_COUNT = 36, 6;
    O_MAIN_KICK = 42, 1;
    O_MAIN_POWER = 43, 1;
    O_BIG_KICK = 44, 1;
    O_ROLL_KICK = 45, 1;
    O_ROLL = 46, 1;
    O_ROLL_DIV = 47, 1;
    O_DROP = 48, 1;
    O_DROPPED = 49, 1;
    O_SINCE_DROP = 50, 1;
    O_BUILD = 51, 1;
    O_BREAKDOWN = 52, 1;
    O_DRIVE = 53, 1;
    O_WEIGHT = 54, 1;
    O_AIR = 55, 1;
    O_TENSION = 56, 1;
    O_CALM = 57, 1;
    O_ATTACK = 58, 1;
    O_DYNAMICS = 59, 1;
    O_LEVEL = 60, 1;
    O_LOOK = 61, 7;
    O_GENRE = 68, 8;
}
pub const OUT_LEN: usize = 76;

/// The stamps, in the order of O_STAMP.
pub const S_KICK: usize = 0;
pub const S_MAIN: usize = 1;
pub const S_BIG: usize = 2;
pub const S_ROLL: usize = 3;
pub const S_SNARE: usize = 4;
pub const S_HAT: usize = 5;
pub const S_NOTE: usize = 6;
pub const S_CHORD: usize = 7;
pub const S_DROP: usize = 8;
pub const S_BAR: usize = 9;
pub const S_BEAT: usize = 10;
/// The counts, in the order of O_COUNT.
pub const C_KICK: usize = 0;
pub const C_MAIN: usize = 1;
pub const C_SNARE: usize = 2;
pub const C_DROP: usize = 3;
pub const C_BAR: usize = 4;
pub const C_BEAT: usize = 5;

#[inline]
fn clamp01(v: f64) -> f64 {
    if v < 0.0 {
        0.0
    } else if v > 1.0 {
        1.0
    } else {
        v
    }
}

#[inline]
fn approach(v: f64, target: f64, tau: f64, dt: f64) -> f64 {
    v + (target - v) * (1.0 - exp64(-dt / tau.fmax(1e-4)))
}

#[inline]
fn envelope(v: f64, target: f64, dt: f64, attack: f64, release: f64) -> f64 {
    if target > v {
        approach(v, target, attack, dt)
    } else {
        approach(v, target, release, dt)
    }
}

/// JavaScript's Math.round: half up, toward +infinity.
#[inline]
pub fn js_round(x: f64) -> f64 {
    let r = x.floor();
    if x - r >= 0.5 {
        r + 1.0
    } else {
        r
    }
}

pub struct Motion {
    pub input: [f64; IN_LEN],
    pub out: [f64; OUT_LEN],
    beats: f64,
    bars: f64,
    phrases: f64,
    drive: f64,
    weight: f64,
    air: f64,
    tension: f64,
    calm: f64,
    attack: f64,
    last_beat_index: f64,
    bars_since_kick: f64,
    mid_avg: f64,
    high_avg: f64,
    note_avg: f64,
    chord_was: f64,
}

impl Motion {
    pub fn new() -> Motion {
        let mut m = Motion {
            input: [0.0; IN_LEN],
            out: [0.0; OUT_LEN],
            beats: 0.0,
            bars: 0.0,
            phrases: 0.0,
            drive: 0.3,
            weight: 0.4,
            air: 0.3,
            tension: 0.0,
            calm: 0.5,
            attack: 0.0,
            last_beat_index: -1.0,
            bars_since_kick: 0.0,
            mid_avg: 0.0,
            high_avg: 0.0,
            note_avg: 0.0,
            chord_was: 0.0,
        };
        let o = &mut m.out;
        o[O_BEAT] = FALLBACK_BEAT;
        o[O_BAR] = FALLBACK_BEAT * 4.0;
        o[O_PHRASE] = FALLBACK_BEAT * 16.0;
        o[O_BPB] = 4.0;
        for s in o[O_STAMP..O_STAMP + 11].iter_mut() {
            *s = NEVER;
        }
        o[O_SINCE_DROP] = 999.0;
        o[O_DRIVE] = 0.3;
        o[O_WEIGHT] = 0.4;
        o[O_AIR] = 0.3;
        o[O_CALM] = 0.5;
        o[O_DYNAMICS] = 1.0;
        o[O_LOOK..O_LOOK + 7].copy_from_slice(&[0.6, 0.6, 0.6, 0.5, 0.5, 0.5, 0.4]);
        m
    }

    /// `m.ease`'s step for a time constant of `n_beats`: the share of the
    /// distance covered this frame. Twenty-odd values are eased per frame on
    /// five time constants, so each constant's `exp` is taken once — the
    /// same expression on the same numbers, so the same bits as easing each
    /// value on its own.
    #[inline]
    fn ease_k(&self, n_beats: f64, dt: f64) -> f64 {
        let tau = (n_beats * self.out[O_BEAT]).fmax(0.001);
        1.0 - exp64(-dt / tau.fmax(1e-4))
    }

    pub fn stamp(&self, s: usize) -> f64 {
        self.out[O_STAMP + s]
    }

    pub fn update(&mut self, dt: f64) {
        let i = self.input;
        let b = |k: usize| i[k] != 0.0;

        // --- the grid ------------------------------------------------------------
        let locked = b(I_LOCKED);
        let p = i[I_PERIOD];
        let period = if locked && p > 0.15 && p < 2.0 { p } else { FALLBACK_BEAT };
        let bpb = (if i[I_BPB] != 0.0 { i[I_BPB] } else { 4.0 }).fmax(2.0);
        {
            let o = &mut self.out;
            o[O_BEAT] = period;
            o[O_BAR] = period * bpb;
            o[O_PHRASE] = o[O_BAR] * 4.0;
            o[O_BPB] = bpb;
            o[O_BPM] = i[I_BPM];
            o[O_LOCKED] = if locked { 1.0 } else { 0.0 };
        }
        let prev_phrase_phase = self.out[O_PHRASE_PHASE];
        let beat_phase = clamp01(i[I_PHASE]);
        let idx = i[I_BEAT_INDEX];
        let bar_phase = ((i[I_BAR_POS] + beat_phase) / bpb) % 1.0;
        let phrase_phase = ((((idx % (bpb * 4.0)) + beat_phase) / (bpb * 4.0)) % 1.0 + 1.0) % 1.0;
        let on_beat = b(I_BEAT) && idx != self.last_beat_index;
        if on_beat {
            self.last_beat_index = idx;
        }
        let on_bar = on_beat && b(I_DOWNBEAT);
        let on_phrase = phrase_phase < prev_phrase_phase;

        // --- the clock -----------------------------------------------------------------
        let adv = dt / period;
        let mut next = self.beats + adv;
        if locked {
            let tgt = idx + beat_phase;
            let err = tgt + js_round(next - tgt) - next;
            next += err * (1.0 - exp64(-dt / CORRECT_TAU));
        }
        next = next.fmax(self.beats + adv * MIN_ADVANCE);
        let step = next - self.beats;
        self.beats = next;
        self.bars += step / bpb;
        self.phrases += step / (bpb * 4.0);
        let beats = self.beats;

        let o = &mut self.out;
        o[O_BEAT_PHASE] = beat_phase;
        o[O_BAR_PHASE] = bar_phase;
        o[O_PHRASE_PHASE] = phrase_phase;
        o[O_ON_BEAT] = on_beat as u8 as f64;
        o[O_ON_BAR] = on_bar as u8 as f64;
        o[O_ON_PHRASE] = on_phrase as u8 as f64;
        o[O_BEATS] = beats;
        o[O_BARS] = self.bars;
        o[O_PHRASES] = self.phrases;
        o[O_BEAT_INDEX] = idx;
        if on_beat {
            o[O_STAMP + S_BEAT] = beats;
            o[O_COUNT + C_BEAT] += 1.0;
        }
        if on_bar {
            o[O_STAMP + S_BAR] = beats;
            o[O_COUNT + C_BAR] += 1.0;
            o[O_BAR_INDEX] += 1.0;
        }

        // --- events --------------------------------------------------------------------
        let kick = i[I_KICK];
        let hit = b(I_KICK_HIT);
        o[O_KICK] = kick;
        o[O_HIT] = hit as u8 as f64;
        let pat = b(I_HAS_PATTERN);
        let main_kick = if pat { b(I_MAIN_KICK) } else { hit };
        o[O_MAIN_KICK] = main_kick as u8 as f64;
        o[O_MAIN_POWER] = if pat && b(I_HAS_MAIN_POWER) {
            i[I_MAIN_POWER]
        } else if hit {
            kick
        } else {
            o[O_MAIN_POWER]
        };
        let big = pat && b(I_BIG_KICK);
        let roll_kick = pat && b(I_ROLL_KICK);
        let drop = pat && b(I_DROP);
        o[O_BIG_KICK] = big as u8 as f64;
        o[O_ROLL_KICK] = roll_kick as u8 as f64;
        o[O_ROLL] = if pat { i[I_ROLL] } else { 0.0 };
        o[O_ROLL_DIV] = if pat { i[I_ROLL_DIV] } else { 0.0 };
        o[O_DROP] = drop as u8 as f64;
        o[O_DROPPED] = if pat { i[I_DROPPED] } else { 0.0 };
        o[O_SINCE_DROP] = if pat { i[I_SINCE_DROP] } else { 999.0 };
        o[O_BUILD] = if pat { i[I_BUILD] } else { 0.0 };
        o[O_BREAKDOWN] = if pat { i[I_BREAKDOWN] } else { 0.0 };
        o[O_NOTE] = i[I_MELODY_FLUX];
        o[O_CHORD] = i[I_CHORD_CHANGE];
        o[O_ONSET] = i[I_ONSET];
        if hit {
            o[O_STAMP + S_KICK] = beats;
            o[O_COUNT + C_KICK] += 1.0;
        }
        if main_kick {
            o[O_STAMP + S_MAIN] = beats;
            o[O_COUNT + C_MAIN] += 1.0;
        }
        if big {
            o[O_STAMP + S_BIG] = beats;
        }
        if roll_kick {
            o[O_STAMP + S_ROLL] = beats;
        }
        if drop {
            o[O_STAMP + S_DROP] = beats;
            o[O_COUNT + C_DROP] += 1.0;
        }

        let mid = i[I_MID_FLUX];
        let high = i[I_HIGH_FLUX];
        let nt = i[I_MELODY_FLUX];
        let snare_hit = !hit && mid > SNARE_FLOOR && mid > self.mid_avg * SNARE_RISE && beats - o[O_STAMP + S_SNARE] > SNARE_GAP;
        let hat_hit = high > HAT_FLOOR && high > self.high_avg * HAT_RISE && beats - o[O_STAMP + S_HAT] > HAT_GAP;
        let note_hit = nt > NOTE_FLOOR && nt > self.note_avg * NOTE_RISE && beats - o[O_STAMP + S_NOTE] > NOTE_GAP;
        o[O_SNARE_HIT] = snare_hit as u8 as f64;
        o[O_HAT_HIT] = hat_hit as u8 as f64;
        o[O_NOTE_HIT] = note_hit as u8 as f64;
        if snare_hit {
            o[O_STAMP + S_SNARE] = beats;
            o[O_COUNT + C_SNARE] += 1.0;
        }
        if hat_hit {
            o[O_STAMP + S_HAT] = beats;
        }
        if note_hit {
            o[O_STAMP + S_NOTE] = beats;
        }
        let chord = i[I_CHORD_CHANGE];
        if chord > CHORD_ON && self.chord_was <= CHORD_ON && beats - o[O_STAMP + S_CHORD] > CHORD_GAP {
            o[O_STAMP + S_CHORD] = beats;
        }
        self.chord_was = chord;
        let ease = |v: f64, target: f64, k: f64| v + (target - v) * k;
        self.mid_avg = ease(self.mid_avg, mid, self.ease_k(SNARE_AVG, dt));
        self.high_avg = ease(self.high_avg, high, self.ease_k(HAT_AVG, dt));
        self.note_avg = ease(self.note_avg, nt, self.ease_k(NOTE_AVG, dt));
        // The two constants everything below shares: a beat (the genre
        // channel) and two (weight, air, tension).
        let k1 = self.ease_k(1.0, dt);
        let k2 = self.ease_k(2.0, dt);

        let onset = i[I_ONSET];
        self.attack = envelope(self.attack, clamp01(kick.fmax(onset) * 1.1), dt, period * 0.02, period * 0.25);

        // --- shape ---------------------------------------------------------------------
        let level = i[I_LEVEL];
        let dyn_ = i[I_DYNAMICS];
        let push = clamp01(level * (0.45 + i[I_PERCUSSIVITY] * 0.9) * dyn_ * 1.25);
        self.drive = ease(self.drive, push, self.ease_k(1.5, dt));
        if b(I_HAS_ENERGY) {
            let e = &i[I_ENERGY..I_ENERGY + 6];
            let total = e[0] + e[1] + e[2] + e[3] + e[4] + e[5] + 1e-12;
            self.weight = ease(self.weight, clamp01((e[0] + e[1]) / total * 2.4), k2);
        }
        self.air = ease(self.air, clamp01(i[I_CENTROID_N]), k2);
        if on_bar {
            self.bars_since_kick = if kick > 0.25 { 0.0 } else { self.bars_since_kick + 1.0 };
        }
        let thinning = clamp01(self.bars_since_kick / 3.0);
        let rising = clamp01((level - 0.25) * 1.6) * clamp01(self.air * 1.4);
        let build = if pat { i[I_BUILD] } else { 0.0 };
        self.tension = ease(self.tension, (thinning * rising).fmax(build), k2);
        let quiet = 1.0 - clamp01(self.drive * 1.3);
        self.calm = ease(self.calm, quiet, self.ease_k(if quiet > self.calm { 6.0 } else { 0.4 }, dt));

        let mut look = [0f64; 7];
        look.copy_from_slice(&self.out[O_LOOK..O_LOOK + 7]);
        if b(I_HAS_LOOK) {
            let k3 = self.ease_k(3.0, dt);
            for k in 0..7 {
                look[k] = ease(look[k], i[I_LOOK + k], k3);
            }
        }
        let mut genre = [0f64; 8];
        genre.copy_from_slice(&self.out[O_GENRE..O_GENRE + 8]);
        if b(I_HAS_GENRE) {
            for k in 0..8 {
                genre[k] = ease(genre[k], i[I_GENRE + k], k1);
            }
        }
        let o = &mut self.out;
        o[O_ATTACK] = self.attack;
        o[O_LEVEL] = level;
        o[O_DYNAMICS] = dyn_;
        o[O_DRIVE] = self.drive;
        o[O_WEIGHT] = self.weight;
        o[O_AIR] = self.air;
        o[O_TENSION] = self.tension;
        o[O_CALM] = self.calm;
        o[O_LOOK..O_LOOK + 7].copy_from_slice(&look);
        o[O_GENRE..O_GENRE + 8].copy_from_slice(&genre);
    }
}

impl Default for Motion {
    fn default() -> Self {
        Self::new()
    }
}

/// "name:offset:length;..." for the page, so neither side hard-codes a slot.
pub fn layout_text(fields: &[(&str, usize, usize)]) -> String {
    let mut s = String::new();
    for (name, at, len) in fields {
        s.push_str(name);
        s.push(':');
        s.push_str(&at.to_string());
        s.push(':');
        s.push_str(&len.to_string());
        s.push(';');
    }
    s
}

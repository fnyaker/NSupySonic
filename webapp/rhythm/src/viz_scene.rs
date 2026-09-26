//! The GL scene's arithmetic — what lib/viz/scenes/gl.js computed in
//! JavaScript between the analysis and the shaders, ported exactly: the
//! musical reading (viz_motion.rs), the spectrum resampled onto the texture's
//! 128 texels with a max-hold between pictures, its release in beats, the six
//! band shares, the spectrum history (one row per sixteenth note), and the
//! uniform block every world reads — packed in place, at the offsets the page
//! declares (lib/viz/gl/glsl.js#MUSIC_SLOTS is the one place the layout
//! lives; the page hands its offsets over once, by name).
//!
//! What stays on the page is everything that is not arithmetic: which world,
//! the dissolve, the flash policy, the resolution governor, the WebGL calls
//! and the worlds' drivers. A picture is asked for in two halves —
//! `prepare` (the clocks extrapolated to the instant of the picture, and the
//! spectrum, which the drivers read) and `pack` (the block, once the drivers
//! have run) — and the page uploads the results straight from this memory.
//!
//! Every number is the JavaScript's own arithmetic in the same order, rounded
//! to f32 where the JavaScript stored into a Float32Array, so the block comes
//! out the same to the last bit bar the odd ulp of `exp`/`pow`
//! (test/vizcore.test.mjs holds it to the reference, picture by picture). The
//! one liberty is that the palette is converted to linear light only when it
//! moved: while music plays that is every picture (palette.js drifts the hue
//! with the tempo), but a paused track or a still preview stops paying for it.

use crate::util::{exp64, pow64, MinMax};
use crate::viz_motion::{
    Motion, C_BAR, C_DROP, C_KICK, I_ENERGY, I_HAS_ENERGY, O_AIR, O_ATTACK, O_BAR, O_BARS, O_BAR_PHASE, O_BEAT, O_BEATS,
    O_BEAT_INDEX, O_BPM, O_BREAKDOWN, O_BUILD, O_CALM, O_COUNT, O_DRIVE, O_DROPPED, O_GENRE, O_LEVEL, O_LOCKED,
    O_LOOK, O_PHRASE, O_PHRASES, O_PHRASE_PHASE, O_ROLL, O_ROLL_DIV, O_STAMP, O_TENSION, O_WEIGHT, S_BIG, S_CHORD,
    S_DROP, S_HAT, S_KICK, S_MAIN, S_NOTE, S_SNARE,
};

pub const SPEC_W: usize = 128;
/// Spectrum history: one row per sixteenth note, so the history texture
/// scrolls with the music rather than with the frame rate.
const HIST_PER_BEAT: f64 = 4.0;
/// How far past the last analysis frame the clocks may be extrapolated.
const EXTRAPOLATE_MAX: f64 = 0.25;
pub const MAX_BANDS: usize = 256;
pub const MAX_BLOCK: usize = 512;

/// The block's slots, by the names glsl.js gives them.
pub const SLOTS: &[&str] = &[
    "uClock", "uPhase", "uHit", "uHit2", "uFlow", "uMood", "uArc", "uLookA", "uLookB", "uBandA", "uBandB",
    "uChroma", "uCount", "uSince", "uGenre", "uPalLow", "uPalMid", "uPalHigh", "uPalAcc", "uPalBg", "uFrame",
    "uHole", "uHoleR", "uCtl", "uQual",
];
const U_CLOCK: usize = 0;
const U_PHASE: usize = 1;
const U_HIT: usize = 2;
const U_HIT2: usize = 3;
const U_FLOW: usize = 4;
const U_MOOD: usize = 5;
const U_ARC: usize = 6;
const U_LOOK_A: usize = 7;
const U_LOOK_B: usize = 8;
const U_BAND_A: usize = 9;
const U_BAND_B: usize = 10;
const U_CHROMA: usize = 11;
const U_COUNT: usize = 12;
const U_SINCE: usize = 13;
const U_GENRE: usize = 14;
const U_PAL_LOW: usize = 15;
const U_PAL_MID: usize = 16;
const U_PAL_HIGH: usize = 17;
const U_PAL_ACC: usize = 18;
const U_PAL_BG: usize = 19;
const U_FRAME: usize = 20;
const U_HOLE: usize = 21;
const U_HOLE_R: usize = 22;
const U_CTL: usize = 23;
const U_QUAL: usize = 24;

macro_rules! fields {
    ($list:ident; $($name:ident = $idx:expr, $len:expr;)*) => {
        $(pub const $name: usize = $idx;)*
        pub const $list: &[(&str, usize, usize)] = &[$((stringify!($name), $idx, $len)),*];
    };
}

// What `pack` is told, per picture: what only the page knows.
fields! {
    PACK_FIELDS;
    P_FLASH = 0, 1;
    // The palette as palette.js leaves it: low, mid and high hues, the base
    // hue, saturation, lightness and spread.
    P_PAL = 1, 7;
    P_CSS_W = 8, 1;
    P_CSS_H = 9, 1;
    P_DPR = 10, 1;
    P_SCALE = 11, 1;
    // The artwork: present (0/1), its centre x, y and half extents in CSS px,
    // and the top of the free band under it (CSS y)...
    P_HOLE = 12, 6;
    // ...and how much of the frame it takes.
    P_HOLE_RATIO = 18, 1;
    P_INTENSITY = 19, 1;
    P_REDUCED = 20, 1;
    P_STRIP = 21, 1;
    P_STEPS = 22, 1;
    P_PARTICLES = 23, 1;
    P_TIER = 24, 1;
}
pub const PACK_LEN: usize = 25;

// What `prepare` hands back, per picture.
fields! {
    PREP_FIELDS;
    Q_BEATS = 0, 1;
    Q_BARS = 1, 1;
    Q_PHRASES = 2, 1;
    Q_AHEAD = 3, 1;
    Q_ROW = 4, 1;
    Q_DYN = 5, 1;
    Q_PITCH = 6, 1;
    Q_MELODY = 7, 1;
}
pub const PREP_LEN: usize = 8;

/// `update`'s flags: which parts of the frame's features were there.
pub const F_CHROMA: u32 = 2;
pub const F_PITCH: u32 = 4;
pub const F_MELODY: u32 = 8;
pub const F_DYNAMICS: u32 = 16;
pub const F_FEATURES: u32 = 32;

#[inline]
fn clamp(v: f64, a: f64, b: f64) -> f64 {
    if v < a {
        a
    } else if v > b {
        b
    } else {
        v
    }
}

#[inline]
fn approach(v: f64, target: f64, tau: f64, dt: f64) -> f64 {
    v + (target - v) * (1.0 - exp64(-dt / tau.fmax(1e-4)))
}

#[inline]
fn to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        pow64((c + 0.055) / 1.055, 2.4)
    }
}

/// HSL (degrees, 0..1, 0..1) to linear RGB, as gl.js#hslLinear — rounded to
/// f32 as the JavaScript's store into the block rounded it.
fn hsl_linear(h_deg: f64, s: f64, l: f64) -> [f32; 3] {
    let h = ((h_deg % 360.0 + 360.0) % 360.0) / 360.0 * 6.0;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h % 2.0) - 1.0).abs());
    let (r, g, b) = if h < 1.0 {
        (c, x, 0.0)
    } else if h < 2.0 {
        (x, c, 0.0)
    } else if h < 3.0 {
        (0.0, c, x)
    } else if h < 4.0 {
        (0.0, x, c)
    } else if h < 5.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let m = l - c / 2.0;
    [to_linear(r + m) as f32, to_linear(g + m) as f32, to_linear(b + m) as f32]
}

/// Scale a colour so its luminance lands on `target`, as gl.js#normalise: a
/// pale sleeve and a dark one then expose the same.
fn normalise(c: [f32; 3], target: f64) -> [f32; 3] {
    let y = 0.2126 * c[0] as f64 + 0.7152 * c[1] as f64 + 0.0722 * c[2] as f64;
    let k = clamp(target / y.fmax(1e-4), 0.5, 3.5);
    [(c[0] as f64 * k) as f32, (c[1] as f64 * k) as f32, (c[2] as f64 * k) as f32]
}

pub struct Scene {
    pub m: Motion,
    offsets: [usize; 25],
    block_len: usize,
    pub block: [f32; MAX_BLOCK],
    /// The next update's bands and chroma, written by the page.
    pub bands: [f32; MAX_BANDS],
    pub chroma_in: [f32; 12],
    pub pack_in: [f64; PACK_LEN],
    pub prep: [f64; PREP_LEN],
    /// The two texture rows (released, raw) as bytes, and the history row.
    pub spec: [u8; SPEC_W * 2],
    pub hist_row: [u8; SPEC_W],
    /// The released spectrum, 0..1, for the drivers that read it.
    pub spec_smooth: [f32; SPEC_W],
    spec_fast: [f32; SPEC_W],
    hist_due: f64,
    band_share: [f32; 6],
    band_smooth: [f32; 6],
    chroma: [f32; 12],
    has_chroma: bool,
    pitch: f64,
    melody: f64,
    dyn_: f64,
    dyn_smooth: f64,
    last_update_at: f64,
    pal_key: [f64; 7],
    pal: [[f32; 3]; 5],
}

impl Scene {
    pub fn new() -> Scene {
        Scene {
            m: Motion::new(),
            offsets: [0; 25],
            block_len: 0,
            block: [0.0; MAX_BLOCK],
            bands: [0.0; MAX_BANDS],
            chroma_in: [0.0; 12],
            pack_in: [0.0; PACK_LEN],
            prep: [0.0; PREP_LEN],
            spec: [0; SPEC_W * 2],
            hist_row: [0; SPEC_W],
            spec_smooth: [0.0; SPEC_W],
            spec_fast: [0.0; SPEC_W],
            hist_due: 0.0,
            band_share: [0.0; 6],
            band_smooth: [0.0; 6],
            chroma: [0.0; 12],
            has_chroma: false,
            pitch: 0.5,
            melody: 0.0,
            dyn_: 1.0,
            dyn_smooth: 1.0,
            last_update_at: 0.0,
            pal_key: [f64::NAN; 7],
            pal: [[0.0; 3]; 5],
        }
    }

    /// Where slot `k` (SLOTS order) starts in the block, in floats.
    pub fn set_slot(&mut self, k: usize, offset: usize) {
        if k < self.offsets.len() {
            self.offsets[k] = offset;
        }
    }

    pub fn set_block_len(&mut self, len: usize) {
        self.block_len = len.min(MAX_BLOCK);
    }

    #[inline]
    fn put(&mut self, slot: usize, idx: usize, v: [f64; 4]) {
        let at = self.offsets[slot] + idx * 4;
        if at + 4 <= self.block_len {
            for (k, x) in v.iter().enumerate() {
                self.block[at + k] = *x as f32;
            }
        }
    }

    #[inline]
    fn put3(&mut self, slot: usize, c: [f32; 3], w: Option<f64>) {
        let at = self.offsets[slot];
        if at + 4 <= self.block_len {
            self.block[at..at + 3].copy_from_slice(&c);
            if let Some(w) = w {
                self.block[at + 3] = w as f32;
            }
        }
    }

    /// One analysis frame: the musical reading (its input already written),
    /// then the spectrum and the features the picture needs.
    #[allow(clippy::too_many_arguments)]
    pub fn update(&mut self, dt: f64, now: f64, nbands: usize, flags: u32, pitch: f64, melody: f64, dynamics: f64) {
        self.m.update(dt);
        self.last_update_at = now;
        let n = nbands.min(MAX_BANDS);
        if n > 0 {
            // Resampled onto the texture's 128 texels, and MAX-HELD until the
            // next picture: a transient that lives for one analysis frame
            // between two pictures must still reach the screen.
            for i in 0..SPEC_W {
                let x = (i as f64 / (SPEC_W - 1) as f64) * (n - 1) as f64;
                let j = x.floor() as usize;
                let f = x - j as f64;
                let a = self.bands[j] as f64;
                // `b[min(n - 1, j + 1)] || 0`, NaN included.
                let nb = self.bands[(j + 1).min(n - 1)] as f64;
                let nb = if nb.is_nan() { 0.0 } else { nb };
                let v = a + (nb - a) * f;
                if v > self.spec_fast[i] as f64 {
                    self.spec_fast[i] = v as f32;
                }
            }
        }
        if self.m.input[I_HAS_ENERGY] != 0.0 {
            let e = &self.m.input[I_ENERGY..I_ENERGY + 6];
            let total = e[0] + e[1] + e[2] + e[3] + e[4] + e[5] + 1e-12;
            for i in 0..6 {
                let share = clamp(e[i] / total * 3.0, 0.0, 1.0);
                if share > self.band_share[i] as f64 {
                    self.band_share[i] = share as f32;
                }
            }
        }
        if flags & F_FEATURES != 0 {
            if flags & F_CHROMA != 0 {
                self.chroma = self.chroma_in;
                self.has_chroma = true;
            }
            if flags & F_PITCH != 0 {
                self.pitch = pitch;
            }
            if flags & F_MELODY != 0 {
                self.melody = melody;
            }
            self.dyn_ = if flags & F_DYNAMICS != 0 { dynamics } else { 1.0 };
        }
    }

    /// The first half of a picture at `t`, `rdt` after the last one: the
    /// clocks, the dynamics gate, the spectrum and the history row (in
    /// `hist_row` when one is due, which the return value says).
    pub fn prepare(&mut self, t: f64, rdt: f64) -> bool {
        let o = &self.m.out;
        let ahead = clamp(t - self.last_update_at, 0.0, EXTRAPOLATE_MAX);
        let beats_now = o[O_BEATS] + ahead / o[O_BEAT];
        let bars_now = o[O_BARS] + ahead / o[O_BAR];
        let phrases_now = o[O_PHRASES] + ahead / o[O_PHRASE];
        let beat = o[O_BEAT];
        self.dyn_smooth = approach(self.dyn_smooth, self.dyn_, 0.15, rdt);
        // A fast attack and a release in beats: the bars fall at a musical
        // speed; the raw row keeps the peak for worlds that want the transient.
        let rel = exp64(-rdt / (beat * 0.35).fmax(0.05));
        for i in 0..SPEC_W {
            let v = self.spec_fast[i] as f64;
            let s = self.spec_smooth[i] as f64;
            self.spec_smooth[i] = (if v > s { s + (v - s) * 0.65 } else { v + (s - v) * rel }) as f32;
            self.spec[i] = (clamp(self.spec_smooth[i] as f64, 0.0, 1.0) * 255.0) as u8;
            self.spec[SPEC_W + i] = (clamp(v, 0.0, 1.0) * 255.0) as u8;
            self.spec_fast[i] = (v * 0.4) as f32;
        }
        for i in 0..6 {
            self.band_smooth[i] = approach(self.band_smooth[i] as f64, self.band_share[i] as f64, beat * 0.2, rdt) as f32;
            self.band_share[i] = (self.band_share[i] as f64 * 0.5) as f32;
        }
        let row = beats_now >= self.hist_due;
        if row {
            self.hist_due = (self.hist_due + 1.0 / HIST_PER_BEAT).fmax(beats_now - 1.0);
            self.hist_row.copy_from_slice(&self.spec[..SPEC_W]);
        }
        self.prep = [
            beats_now,
            bars_now,
            phrases_now,
            ahead,
            if row { 1.0 } else { 0.0 },
            self.dyn_smooth,
            self.pitch,
            self.melody,
        ];
        row
    }

    fn palette(&mut self) {
        let mut key = [0f64; 7];
        key.copy_from_slice(&self.pack_in[P_PAL..P_PAL + 7]);
        if key == self.pal_key {
            return;
        }
        let [low, mid, high, hue, sat, light, _spread] = key;
        let sat = clamp(sat, 0.0, 1.0);
        let light = clamp(light, 0.2, 0.8);
        self.pal = [
            normalise(hsl_linear(low, sat, light), 0.2),
            normalise(hsl_linear(mid, sat, light), 0.24),
            normalise(hsl_linear(high, sat, (light + 0.08).fmin(0.85)), 0.3),
            normalise(hsl_linear(hue + 180.0, sat, light), 0.24),
            hsl_linear(hue - 14.0, sat * 0.55, 0.06),
        ];
        self.pal_key = key;
    }

    /// The second half: the uniform block, from what `pack_in` says.
    pub fn pack(&mut self) {
        let [beats_now, bars_now, phrases_now, ahead, _, dyn_smooth, pitch, melody] = self.prep;
        let o = self.m.out;
        let env = |stamp: f64, decay: f64| {
            let s = beats_now - stamp;
            if s < 0.0 {
                0.0
            } else {
                exp64(-s / decay)
            }
        };
        let st = |s: usize| o[O_STAMP + s];
        let p = self.pack_in;
        self.put(U_CLOCK, 0, [beats_now, bars_now, phrases_now, o[O_BEAT]]);
        self.put(
            U_PHASE,
            0,
            [
                beats_now - beats_now.floor(),
                (o[O_BAR_PHASE] + ahead / o[O_BAR]) % 1.0,
                (o[O_PHRASE_PHASE] + ahead / o[O_PHRASE]) % 1.0,
                if o[O_LOCKED] != 0.0 { o[O_BPM] / 100.0 } else { 0.0 },
            ],
        );
        self.put(U_HIT, 0, [env(st(S_KICK), 0.35), env(st(S_MAIN), 0.5), env(st(S_BIG), 1.0), env(st(S_SNARE), 0.4)]);
        self.put(U_HIT2, 0, [env(st(S_HAT), 0.2), env(st(S_NOTE), 0.5), env(st(S_CHORD), 1.5), p[P_FLASH]]);
        self.put(U_FLOW, 0, [o[O_DRIVE], o[O_WEIGHT], o[O_AIR], o[O_TENSION]]);
        self.put(U_MOOD, 0, [o[O_CALM], o[O_LEVEL], dyn_smooth, o[O_ATTACK]]);
        self.put(U_ARC, 0, [o[O_DROPPED], o[O_BUILD], o[O_BREAKDOWN], o[O_ROLL]]);
        self.put(U_LOOK_A, 0, [o[O_LOOK], o[O_LOOK + 1], o[O_LOOK + 2], o[O_LOOK + 3]]);
        self.put(U_LOOK_B, 0, [o[O_LOOK + 4], o[O_LOOK + 5], o[O_LOOK + 6], o[O_ROLL_DIV] / 16.0]);
        let bs = self.band_smooth;
        self.put(U_BAND_A, 0, [bs[0] as f64, bs[1] as f64, bs[2] as f64, bs[3] as f64]);
        self.put(U_BAND_B, 0, [bs[4] as f64, bs[5] as f64, pitch, melody]);
        let c = if self.has_chroma { self.chroma } else { [0.0; 12] };
        for i in 0..3 {
            self.put(U_CHROMA, i, [c[i * 4] as f64, c[i * 4 + 1] as f64, c[i * 4 + 2] as f64, c[i * 4 + 3] as f64]);
        }
        self.put(U_COUNT, 0, [o[O_BEAT_INDEX], o[O_COUNT + C_BAR], o[O_COUNT + C_KICK], o[O_COUNT + C_DROP]]);
        self.put(U_GENRE, 0, [o[O_GENRE], o[O_GENRE + 1], o[O_GENRE + 2], o[O_GENRE + 3]]);
        self.put(U_GENRE, 1, [o[O_GENRE + 4], o[O_GENRE + 5], o[O_GENRE + 6], o[O_GENRE + 7]]);
        self.put(
            U_SINCE,
            0,
            [
                (beats_now - st(S_KICK)).fmin(999.0),
                (beats_now - st(S_MAIN)).fmin(999.0),
                (beats_now - st(S_SNARE)).fmin(999.0),
                (beats_now - st(S_DROP)).fmin(999.0),
            ],
        );
        // The palette, in linear light, converted when it moved.
        self.palette();
        let sat = clamp(p[P_PAL + 4], 0.0, 1.0);
        let light = clamp(p[P_PAL + 5], 0.2, 0.8);
        let hue = p[P_PAL + 3];
        let pal = self.pal;
        self.put3(U_PAL_LOW, pal[0], Some(sat));
        self.put3(U_PAL_MID, pal[1], Some(light));
        self.put3(U_PAL_HIGH, pal[2], Some(((hue % 360.0 + 360.0) % 360.0) / 360.0));
        self.put3(U_PAL_ACC, pal[3], Some(p[P_PAL + 6] / 360.0));
        self.put3(U_PAL_BG, pal[4], None);
        // The frame, in p-space (y up, one unit = half the height). `|| 1`.
        let w = if p[P_CSS_W] != 0.0 && !p[P_CSS_W].is_nan() { p[P_CSS_W] } else { 1.0 };
        let h = if p[P_CSS_H] != 0.0 && !p[P_CSS_H].is_nan() { p[P_CSS_H] } else { 1.0 };
        let dpr = p[P_DPR];
        let scale = p[P_SCALE];
        self.put(U_FRAME, 0, [w * dpr, h * dpr, w / h, 2.0 / (h * dpr * scale)]);
        let hh = h / 2.0;
        let [present, hx, hy, ahw, ahh, fy] = [p[P_HOLE], p[P_HOLE + 1], p[P_HOLE + 2], p[P_HOLE + 3], p[P_HOLE + 4], p[P_HOLE + 5]];
        if present != 0.0 && ahw > 0.0 {
            self.put(U_HOLE, 0, [(hx - w / 2.0) / hh, -(hy - h / 2.0) / hh, ahw / hh, ahh / hh]);
            self.put(U_HOLE_R, 0, [(ahw.fmin(ahh) / hh) * 0.08, p[P_HOLE_RATIO], -(fy - h / 2.0) / hh, 0.0]);
        } else {
            self.put(U_HOLE, 0, [0.0; 4]);
            self.put(U_HOLE_R, 0, [0.0, 0.0, -1.0 / 3.0, 0.0]);
        }
        self.put(U_CTL, 0, [p[P_INTENSITY], p[P_REDUCED], p[P_STRIP], 0.0]);
        self.put(U_QUAL, 0, [p[P_STEPS], p[P_PARTICLES], p[P_TIER], scale]);
    }
}

impl Default for Scene {
    fn default() -> Self {
        Self::new()
    }
}

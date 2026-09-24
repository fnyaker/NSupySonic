//! NSupySonic's rhythm analyser, compiled to WebAssembly and run INSIDE the
//! AudioWorklet that taps the player's output.
//!
//! WHY IT LIVES ON THE AUDIO THREAD. The JavaScript engine read two
//! AnalyserNodes from the main thread, on a clock that was meant to be an
//! AudioWorklet but was loaded from a blob: URL the server's CSP forbids — so
//! in production it ran on requestAnimationFrame, sharing the frame budget
//! with the WebGL render, and every janky frame was a hole in the analysis (a
//! kick that landed inside it was never seen, since an analyser only ever
//! shows its latest window). Here every sample is analysed, in order, whatever
//! the page is doing, and nothing allocates after `rhythm_init`.
//!
//! THE PIPELINE, per hop of 512 samples (~10.7 ms at 48 kHz):
//!
//!   spectra     2048-point FFT at the full rate, 512-point FFT of the signal
//!               decimated by 16 (spectrum.rs) — the AnalyserNodes' two views.
//!   features    level, dynamics, SuperFlux, the kick witnesses, chroma and the
//!               melody (features.rs, the JavaScript's arithmetic).
//!   kick        candidates confirmed or rejected two frames later (kick.rs).
//!   tempo       the period and the metrical level (tempo.rs).
//!   grid        where the beats are, the bar and the phrase (beat.rs).
//!   pattern     main kick or roll, and the arrangement (pattern.rs).
//!   style       the genre family and the kick's shape (style.rs).
//!   genre       the genre channel (genre.rs).
//!
//! THE OUTPUT RUNS `LOOKAHEAD` FRAMES BEHIND THE ANALYSIS. That is what lets a
//! kick be confirmed after its attack and still be published ON the frame it
//! landed on, a drop be checked against the level of the frames after it, and
//! a beat be emitted from a grid that has already seen what follows. The
//! page receives every frame with its sample-exact time and delivers it when
//! that audio reaches the speakers, so the delay costs nothing it can see.

pub mod beat;
mod features;
mod fft;
mod genre;
mod kick;
mod pattern;
mod spectrum;
mod style;
mod tempo;
mod util;

use beat::{Grid, KIND_FULL, KIND_KICK, KIND_LOW, KIND_SNARE};
use features::{FeatureExtractor, Features};
use fft::RealFft;
use genre::Genre;
use kick::KickDetector;
use pattern::{FrameIn, Pattern};
use spectrum::{BandPlan, EnergyPlan, BAND_COUNT, FLOOR_DB};
use style::Style;
use tempo::Tempo;
use util::{fast_log10, Biquad, Kind};

pub const LOOKAHEAD: usize = kick::DECISION_FRAMES;
const FFT_HI: usize = 2048;
const FFT_LO: usize = 512;
const RING: usize = 4096;
const IN_CAP: usize = 16384;
const MAX_OUT: usize = 64;

/// The output frame, self-describing: `name:length` pairs, in order. The page
/// parses this string instead of hard-coding offsets, so the two sides cannot
/// drift apart.
const LAYOUT: &[(&str, usize)] = &[
    ("frame", 1),
    ("bands", BAND_COUNT),
    ("energyDb", 6),
    ("energy", 6),
    ("level", 1),
    ("levelDb", 1),
    ("peak", 1),
    ("crest", 1),
    ("dynamics", 1),
    ("loudRefDb", 1),
    ("flux", 1),
    ("lowFlux", 1),
    ("midFlux", 1),
    ("highFlux", 1),
    ("kick", 1),
    ("kickHit", 1),
    ("kickStrength", 1),
    ("snareHit", 1),
    ("centroid", 1),
    ("centroidN", 1),
    ("flatness", 1),
    ("rolloff", 1),
    ("rolloffN", 1),
    ("percussivity", 1),
    ("vocalMod", 1),
    ("chroma", 12),
    ("tonal", 1),
    ("melody", 1),
    ("melodyPitch", 1),
    ("melodyFlux", 1),
    ("chordChange", 1),
    ("silent", 1),
    ("bpm", 1),
    ("confidence", 1),
    ("phase", 1),
    ("beat", 1),
    ("beatIndex", 1),
    ("barPos", 1),
    ("beatsPerBar", 1),
    ("downbeat", 1),
    ("onset", 1),
    ("kickPulse", 1),
    ("sinceBeat", 1),
    ("period", 1),
    ("locked", 1),
    ("phraseBar", 1),
    ("clarity", 1),
    ("offbeat", 1),
    ("mainKick", 1),
    ("mainPower", 1),
    ("bigKick", 1),
    ("rollKick", 1),
    ("roll", 1),
    ("rollDiv", 1),
    ("rollNotes", 1),
    ("drop", 1),
    ("sinceDrop", 1),
    ("dropped", 1),
    ("breakdown", 1),
    ("build", 1),
    ("energyRel", 1),
    ("pause", 1),
    ("section", 1),
    ("dropIn", 1),
    ("styleDominant", 1),
    ("styleConfidence", 1),
    ("archetypes", 5),
    ("look", 7),
    ("styleTop", 6),
    ("kickType", 1),
    ("kickShapeStrength", 1),
    ("kickAttack", 1),
    ("kickDecay", 1),
    ("kickClick", 1),
    ("kickGrit", 1),
    ("kickShapeHit", 1),
    ("kickSoft", 1),
    ("kickHard", 1),
    ("kickIndus", 1),
    ("genre", genre::N),
    ("debug", 8),
    ("diag", 8),
];

fn layout_len() -> usize {
    LAYOUT.iter().map(|(_, n)| n).sum()
}

fn layout_string() -> String {
    let mut s = String::new();
    for (i, (name, n)) in LAYOUT.iter().enumerate() {
        if i > 0 {
            s.push(';');
        }
        s.push_str(name);
        s.push(':');
        s.push_str(&n.to_string());
    }
    s
}

/// The offset of a named field, resolved at COMPILE time: the writer below
/// runs ninety times a second and must not search a table to find a slot.
const fn offset_of(name: &str) -> usize {
    let mut o = 0;
    let mut i = 0;
    while i < LAYOUT.len() {
        let (n, len) = LAYOUT[i];
        if eq(n.as_bytes(), name.as_bytes()) {
            return o;
        }
        o += len;
        i += 1;
    }
    panic!("no such field in the layout");
}

const fn eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

macro_rules! at {
    ($name:literal) => {{
        const O: usize = offset_of($name);
        O
    }};
}

#[derive(Clone)]
struct Snap {
    frame: u64,
    t: f64,
    bands: [f32; BAND_COUNT],
    energy_db: [f32; 6],
    energy_lin: [f32; 6],
    f: Features,
    c_flux: f32,
    onset: f32,
    debug: [f32; 8],
}

#[derive(Clone, Copy)]
struct Hit {
    t: f64,
    strength: f32,
    snare: bool,
    detail: [f32; 6],
}

/// A level of analysis, as lib/audio/engine.js LEVEL.
pub const LEVEL_SPECTRUM: u32 = 0;
pub const LEVEL_RHYTHM: u32 = 1;
pub const LEVEL_SMART: u32 = 2;

pub struct Analyzer {
    sr: f32,
    hop: usize,
    hop_s: f64,
    ring: Vec<f32>,
    ring_pos: usize,
    hop_fill: usize,
    samples: u64,
    dec: [Biquad; 4],
    dec_factor: usize,
    dec_count: usize,
    dec_ring: Vec<f32>,
    dec_pos: usize,
    fft_hi: RealFft,
    fft_lo: RealFft,
    hi_mag: Vec<f32>,
    lo_mag: Vec<f32>,
    hi_db: Vec<f32>,
    lo_db: Vec<f32>,
    scratch: Vec<f32>,
    bands: BandPlan,
    energy: EnergyPlan,
    fx: FeatureExtractor,
    kick: KickDetector,
    tempo: Tempo,
    grid: Grid,
    pattern: Pattern,
    style: Style,
    genre: Genre,
    snaps: Vec<Snap>,
    frame: u64,
    hits: Vec<Hit>,
    // Raw onset stream (tempo.js's), and the low one, for the grid.
    on_mean: f32,
    on_var: f32,
    on_last: f64,
    low_mean: f32,
    low_var: f32,
    low_last: f64,
    level: u32,
    live_range: bool,
    range_from: i32,
    out: Vec<f32>,
    out_n: usize,
    frame_len: usize,
}

impl Analyzer {
    pub fn new(sr: f32) -> Analyzer {
        let sr = if sr > 8000.0 { sr } else { 48000.0 };
        let hop = if sr > 60000.0 { 1024 } else { 512 };
        let dec_factor = if sr > 60000.0 { 32 } else { 16 };
        let hop_s = hop as f64 / sr as f64;
        let fps = (sr as f64 / hop as f64) as f32;
        let dec_sr = sr / dec_factor as f32;
        let qs = util::butterworth_qs(4);
        let dec = [
            Biquad::new(Kind::Lowpass, 1000.0, qs[0], sr),
            Biquad::new(Kind::Lowpass, 1000.0, qs[1], sr),
            Biquad::new(Kind::Lowpass, 1000.0, qs[2], sr),
            Biquad::new(Kind::Lowpass, 1000.0, qs[3], sr),
        ];
        let hi_hz = sr / FFT_HI as f32;
        let lo_hz = dec_sr / FFT_LO as f32;
        let frame_len = layout_len();
        let mut a = Analyzer {
            sr,
            hop,
            hop_s,
            ring: vec![0.0; RING],
            ring_pos: 0,
            hop_fill: 0,
            samples: 0,
            dec,
            dec_factor,
            dec_count: 0,
            dec_ring: vec![0.0; FFT_LO],
            dec_pos: 0,
            fft_hi: RealFft::new(FFT_HI),
            fft_lo: RealFft::new(FFT_LO),
            hi_mag: vec![0.0; FFT_HI / 2],
            lo_mag: vec![0.0; FFT_LO / 2],
            hi_db: vec![FLOOR_DB; FFT_HI / 2],
            lo_db: vec![FLOOR_DB; FFT_LO / 2],
            scratch: vec![0.0; FFT_HI],
            bands: BandPlan::new(sr, lo_hz, FFT_LO / 2, hi_hz, FFT_HI / 2),
            energy: EnergyPlan::new(lo_hz, FFT_LO / 2, hi_hz, FFT_HI / 2),
            fx: FeatureExtractor::new(sr, FFT_HI, FLOOR_DB),
            kick: KickDetector::new(sr),
            tempo: Tempo::new(fps),
            grid: Grid::new(hop_s),
            pattern: Pattern::new(),
            style: Style::new(),
            genre: Genre::new(),
            snaps: Vec::with_capacity(LOOKAHEAD + 1),
            frame: 0,
            hits: Vec::with_capacity(32),
            on_mean: 0.0,
            on_var: 0.0,
            on_last: -1.0,
            low_mean: 0.0,
            low_var: 0.0,
            low_last: -1.0,
            level: LEVEL_SMART,
            live_range: true,
            range_from: -1,
            out: vec![0.0; frame_len * MAX_OUT],
            out_n: 0,
            frame_len,
        };
        let empty = Snap {
            frame: 0,
            t: 0.0,
            bands: [0.0; BAND_COUNT],
            energy_db: [FLOOR_DB; 6],
            energy_lin: [0.0; 6],
            f: Features::default(),
            c_flux: 0.0,
            onset: 0.0,
            debug: [0.0; 8],
        };
        for _ in 0..=LOOKAHEAD {
            a.snaps.push(empty.clone());
        }
        a
    }

    pub fn reset(&mut self) {
        self.fx.reset();
        self.kick.reset();
        self.tempo.reset();
        self.grid.reset();
        self.pattern.reset();
        self.style.reset();
        self.genre.reset();
        self.hits.clear();
        self.on_mean = 0.0;
        self.on_var = 0.0;
        self.on_last = -1.0;
        self.low_mean = 0.0;
        self.low_var = 0.0;
        self.low_last = -1.0;
        self.range_from = -1;
    }

    pub fn set_level(&mut self, level: u32) {
        let level = level.min(LEVEL_SMART);
        if level > self.level {
            self.reset();
        }
        self.level = level;
    }

    pub fn frame_len(&self) -> usize {
        self.frame_len
    }

    /// Feed mono samples. Returns how many output frames are ready in `out`.
    pub fn push(&mut self, input: &[f32]) -> usize {
        self.out_n = 0;
        for &x0 in input {
            let x = if x0.is_finite() { x0 } else { 0.0 };
            self.kick.sample(x);
            self.ring[self.ring_pos] = x;
            self.ring_pos = (self.ring_pos + 1) % RING;
            let mut y = x;
            for b in self.dec.iter_mut() {
                y = b.run(y);
            }
            self.dec_count += 1;
            if self.dec_count == self.dec_factor {
                self.dec_count = 0;
                self.dec_ring[self.dec_pos] = y;
                self.dec_pos = (self.dec_pos + 1) % FFT_LO;
            }
            self.samples += 1;
            self.hop_fill += 1;
            if self.hop_fill == self.hop {
                self.hop_fill = 0;
                self.analyse();
            }
        }
        self.kick.flush();
        for b in self.dec.iter_mut() {
            b.flush();
        }
        self.out_n
    }

    fn analyse(&mut self) {
        self.frame += 1;
        let n = self.frame;
        let t = self.samples as f64 / self.sr as f64;
        let dt = self.hop_s as f32;

        // --- spectra ------------------------------------------------------------
        {
            let start = (self.ring_pos + RING - FFT_HI) % RING;
            for i in 0..FFT_HI {
                self.scratch[i] = self.ring[(start + i) % RING];
            }
            self.fft_hi.magnitudes(&self.scratch[..FFT_HI], &[], &mut self.hi_mag);
            let (a, b) = self.dec_ring.split_at(self.dec_pos);
            // Oldest first: the part after the write head, then before it.
            let lo_src_a = b;
            let lo_src_b = a;
            self.fft_lo.magnitudes(lo_src_a, lo_src_b, &mut self.lo_mag);
        }
        let floor_mag = 10f32.powf(FLOOR_DB / 20.0);
        for (m, d) in self.hi_mag.iter_mut().zip(self.hi_db.iter_mut()) {
            if *m < floor_mag {
                *m = floor_mag;
            }
            *d = 20.0 * fast_log10(*m);
        }
        for (m, d) in self.lo_mag.iter_mut().zip(self.lo_db.iter_mut()) {
            if *m < floor_mag {
                *m = floor_mag;
            }
            *d = 20.0 * fast_log10(*m);
        }
        let slot = (n as usize) % (LOOKAHEAD + 1);
        {
            let mut bands_db = [0f32; BAND_COUNT];
            let snap = &mut self.snaps[slot];
            self.bands.read(&self.lo_db, &self.hi_db, &mut bands_db, &mut snap.bands);
            self.energy.read(&self.lo_mag, &self.hi_mag, &mut snap.energy_db, &mut snap.energy_lin);
            snap.frame = n;
            snap.t = t;
        }

        // --- features and kicks ----------------------------------------------------
        let f = self.fx.process(&self.hi_mag, dt).clone();
        self.kick.process(&f, t);
        let mut kick_now = 0f32;
        for h in self.kick.kicks.iter() {
            self.hits.push(Hit { t: h.t, strength: h.strength, snare: false, detail: [h.f0, h.f1, h.path, h.click, h.rel, h.score] });
            kick_now = kick_now.max(h.strength.min(1.0));
            if self.level >= LEVEL_RHYTHM {
                self.grid.add_event(h.t, h.strength.clamp(0.3, 1.0), KIND_KICK);
            }
        }
        for h in self.kick.snares.iter() {
            self.hits.push(Hit { t: h.t, strength: h.strength, snare: true, detail: [0.0; 6] });
            if self.level >= LEVEL_RHYTHM {
                self.grid.add_event(h.t, h.strength, KIND_SNARE);
            }
        }
        let mut c_flux = 0.0;
        let mut onset_now = 0f32;
        if self.level >= LEVEL_RHYTHM {
            let tempo = self.tempo.process(f.flux, f.low_flux, f.mid_odf, kick_now, dt);
            let (odf_full, odf_low) = (tempo.odf_full, tempo.odf_low);
            c_flux = odf_full;
            // The raw onset stream (tempo.js's peak picker), which is both
            // engine.js's `beat.onset` and grid evidence where there is no kick.
            let d = odf_full - self.on_mean;
            self.on_mean += d * 0.02;
            self.on_var += (d * d - self.on_var) * 0.02;
            let sd = self.on_var.max(1e-12).sqrt();
            let thr = self.on_mean + sd * 1.6;
            if odf_full > thr && t - self.on_last > 0.055 {
                self.on_last = t;
                let v = ((odf_full - thr) / (sd * 3.0 + 1e-9)).clamp(0.0, 1.0);
                onset_now = v;
                if v > 0.05 {
                    self.grid.add_event(t - kick::DETECT_LATENCY - 0.004, v, KIND_FULL);
                }
            }
            let d = odf_low - self.low_mean;
            self.low_mean += d * 0.02;
            self.low_var += (d * d - self.low_var) * 0.02;
            let sd = self.low_var.max(1e-12).sqrt();
            let thr = self.low_mean + sd * 1.8;
            if odf_low > thr && t - self.low_last > 0.07 {
                self.low_last = t;
                let v = ((odf_low - thr) / (sd * 3.0 + 1e-9)).clamp(0.05, 1.0);
                self.grid.add_event(t - kick::DETECT_LATENCY, v, KIND_LOW);
            }
            let tempo = &self.tempo.out;
            self.grid.update(t, self.hop_s, tempo, &f.chroma, f.level);
            if self.grid.initialised() {
                self.tempo.nudge_period(self.grid.period() as f32);
            }
        }
        {
            let snap = &mut self.snaps[slot];
            snap.f = f;
            snap.c_flux = c_flux;
            snap.onset = onset_now;
            snap.debug = match self.kick.candidates.last() {
                Some(c) => [c.t as f32, c.f0, c.f1, c.path, c.click, c.drop, c.rel, c.score],
                None => [0.0; 8],
            };
            self.kick.candidates.clear();
        }

        // --- the output frame, LOOKAHEAD behind -------------------------------------
        if n > LOOKAHEAD as u64 {
            self.emit(n - LOOKAHEAD as u64);
        }
    }

    fn emit(&mut self, j: u64) {
        if self.out_n >= MAX_OUT {
            return;
        }
        let slot = (j as usize) % (LOOKAHEAD + 1);
        let snap = self.snaps[slot].clone();
        let t = snap.t;
        let dt = self.hop_s;
        let half = self.hop_s * 0.5;
        // The events that belong to this frame (and any that are overdue).
        let mut kick: Option<(f64, f32)> = None;
        let mut kick_detail = [0f32; 6];
        let mut snares = 0u32;
        let mut k = 0;
        while k < self.hits.len() {
            let h = self.hits[k];
            if h.t <= t + half {
                if h.snare {
                    snares += 1;
                } else if kick.map(|(_, s)| h.strength > s).unwrap_or(true) {
                    kick = Some((h.t, h.strength));
                    kick_detail = h.detail;
                }
                self.hits.swap_remove(k);
            } else {
                k += 1;
            }
        }
        let f = &snap.f;
        // How loud the next few frames are against this track's loud level —
        // from the frames' own levels, not the smoothed dynamics, which take
        // longer than the lookahead to rise at the first kick of a drop.
        let mut dyn_ahead = f.dynamics;
        for s in self.snaps.iter() {
            if s.frame >= j {
                let raw = ((s.f.level_db - (s.f.loud_ref_db - 24.0)) / 24.0).clamp(0.0, 1.0);
                dyn_ahead = dyn_ahead.max(s.f.dynamics).max(raw);
            }
        }

        let onset = if self.level >= LEVEL_RHYTHM { snap.onset } else { 0.0 };

        let rhythm = self.level >= LEVEL_RHYTHM;
        if rhythm {
            self.grid.eval_at(t);
        }
        let b = self.grid.out.clone();
        let low_total: f32 = snap.energy_lin.iter().sum::<f32>() + 1e-12;
        let low_share = (snap.energy_lin[0] + snap.energy_lin[1]) / low_total;
        let psi_kick = kick.and_then(|(kt, _)| self.grid.psi(kt));
        let (p, anchor) = {
            let fin = FrameIn {
                t,
                dt,
                kick,
                snares,
                hat: f.high_flux > 0.02,
                psi_kick,
                period: b.period as f64,
                locked: b.locked && rhythm,
                beat: b.beat,
                beat_index: b.beat_index,
                beats_per_bar: b.beats_per_bar,
                level: f.level,
                level_db: f.level_db,
                loud_ref_db: f.loud_ref_db,
                dynamics: f.dynamics,
                percussivity: f.percussivity,
                centroid_n: f.centroid_n,
                rolloff_n: f.rolloff_n,
                low_share,
                dyn_ahead,
                _p: core::marker::PhantomData,
            };
            let (p, a) = self.pattern.update(&fin);
            (p.clone(), a)
        };
        if anchor && rhythm {
            if let Some((kt, _)) = kick {
                self.grid.anchor_phrase(kt);
            }
        }

        // --- style and the genre channel -----------------------------------------------
        if self.level >= LEVEL_SMART {
            let e = &snap.energy_lin;
            let total = e.iter().sum::<f32>() + 1e-12;
            let s = &mut self.style.s;
            s[style::F_BPM] = if b.locked { b.bpm } else { 0.0 };
            s[style::F_PULSE] = b.confidence;
            s[style::F_KICKPULSE] = self.tempo.out.kick_pulse;
            s[style::F_FLAT] = f.flatness;
            s[style::F_CENTROID] = f.centroid_n;
            s[style::F_PERC] = f.percussivity;
            s[style::F_VOCAL] = f.vocal_mod;
            s[style::F_CREST] = f.crest;
            s[style::F_LEVEL] = f.level;
            s[style::F_SUB] = (e[0] + e[1]) / total;
            s[style::F_MID] = (e[2] + e[3]) / total;
            s[style::F_AIR] = (e[4] + e[5]) / total;
            s[style::F_MELODY] = f.melody;
            s[style::F_TONAL] = f.tonal;
            s[style::F_CHORD] = f.chord_change;
            s[style::F_DYN] = f.dynamics;
            let seen = kick.map(|(kt, strength)| style::KickSeen {
                t: kt,
                strength,
                f0: kick_detail[0],
                f1: kick_detail[1],
                path: kick_detail[2],
                click: kick_detail[3],
            });
            self.style.kick_frame(seen, e[0] + e[1], f.flatness, t);
            self.style.process(b.locked, b.confidence, f.dynamics, t, dt as f32);
            // A genre recognised LIVE may only confirm the octave the grid is
            // on, never move it: the classifier's own tempo term reads the
            // tracker's BPM, so a family chosen from a wrong octave would
            // "confirm" that octave and lock it in — measured, uptempo read as
            // generic electronic (100-150) and was halved to 110 for good.
            if self.live_range && self.style.confidence > 0.5 && self.style.dominant >= 0 && self.style.dominant != self.range_from && b.locked {
                if let Some((lo, hi)) = self.style.range_of(self.style.dominant) {
                    if b.bpm >= lo * 0.97 && b.bpm <= hi * 1.03 {
                        self.range_from = self.style.dominant;
                        self.tempo.set_range(lo, hi);
                    }
                }
            }
            self.genre.update(
                dt as f32,
                b.period.max(0.15),
                f.harm_mid,
                f.harm_flat,
                f.melody,
                f.mid_flux,
                kick.is_some() || snares > 0,
                &snap.energy_lin,
                b.offbeat,
                (kick.is_some() as u32 + snares) as f32 + if f.high_flux > 0.02 { 0.5 } else { 0.0 },
                self.style.kick.decay,
                self.style.kick.grit,
                f.dynamics,
            );
        }

        // --- write it -------------------------------------------------------------------
        let base = self.out_n * self.frame_len;
        let o = &mut self.out[base..base + self.frame_len];
        o[at!("frame")] = j as f32;
        o[at!("bands")..at!("bands") + BAND_COUNT].copy_from_slice(&snap.bands);
        o[at!("energyDb")..at!("energyDb") + 6].copy_from_slice(&snap.energy_db);
        o[at!("energy")..at!("energy") + 6].copy_from_slice(&snap.energy_lin);
        o[at!("level")] = f.level;
        o[at!("levelDb")] = f.level_db;
        o[at!("peak")] = f.peak;
        o[at!("crest")] = f.crest;
        o[at!("dynamics")] = f.dynamics;
        o[at!("loudRefDb")] = f.loud_ref_db;
        o[at!("flux")] = f.flux;
        o[at!("lowFlux")] = f.low_flux;
        o[at!("midFlux")] = f.mid_flux;
        o[at!("highFlux")] = f.high_flux;
        o[at!("kick")] = p.kick_env;
        o[at!("kickHit")] = if p.kick_hit { 1.0 } else { 0.0 };
        o[at!("kickStrength")] = p.kick_strength;
        o[at!("snareHit")] = if p.snare_hit { 1.0 } else { 0.0 };
        o[at!("centroid")] = f.centroid;
        o[at!("centroidN")] = f.centroid_n;
        o[at!("flatness")] = f.flatness;
        o[at!("rolloff")] = f.rolloff;
        o[at!("rolloffN")] = f.rolloff_n;
        o[at!("percussivity")] = f.percussivity;
        o[at!("vocalMod")] = f.vocal_mod;
        o[at!("chroma")..at!("chroma") + 12].copy_from_slice(&f.chroma);
        o[at!("tonal")] = f.tonal;
        o[at!("melody")] = f.melody;
        o[at!("melodyPitch")] = f.melody_pitch;
        o[at!("melodyFlux")] = f.melody_flux;
        o[at!("chordChange")] = f.chord_change;
        o[at!("silent")] = if f.silent { 1.0 } else { 0.0 };
        o[at!("bpm")] = if rhythm { b.bpm } else { 0.0 };
        o[at!("confidence")] = if rhythm { b.confidence } else { 0.0 };
        o[at!("phase")] = b.phase;
        o[at!("beat")] = if rhythm && b.beat { 1.0 } else { 0.0 };
        o[at!("beatIndex")] = b.beat_index as f32;
        o[at!("barPos")] = b.bar_pos as f32;
        o[at!("beatsPerBar")] = b.beats_per_bar as f32;
        o[at!("downbeat")] = if rhythm && b.downbeat { 1.0 } else { 0.0 };
        o[at!("onset")] = onset;
        o[at!("kickPulse")] = self.tempo.out.kick_pulse;
        o[at!("sinceBeat")] = b.since_beat;
        o[at!("period")] = b.period;
        o[at!("locked")] = if rhythm && b.locked { 1.0 } else { 0.0 };
        o[at!("phraseBar")] = b.phrase_bar as f32;
        o[at!("clarity")] = b.clarity;
        o[at!("offbeat")] = b.offbeat;
        o[at!("mainKick")] = if p.main_kick { 1.0 } else { 0.0 };
        o[at!("mainPower")] = p.main_power;
        o[at!("bigKick")] = if p.big_kick { 1.0 } else { 0.0 };
        o[at!("rollKick")] = if p.roll_kick { 1.0 } else { 0.0 };
        o[at!("roll")] = p.roll;
        o[at!("rollDiv")] = p.roll_div;
        o[at!("rollNotes")] = p.roll_notes;
        o[at!("drop")] = if p.drop { 1.0 } else { 0.0 };
        o[at!("sinceDrop")] = p.since_drop.min(999.0);
        o[at!("dropped")] = p.dropped;
        o[at!("breakdown")] = p.breakdown;
        o[at!("build")] = p.build;
        o[at!("energyRel")] = p.energy;
        o[at!("pause")] = if p.pause { 1.0 } else { 0.0 };
        o[at!("section")] = p.section as f32;
        o[at!("dropIn")] = p.drop_in;
        let st = &self.style;
        o[at!("styleDominant")] = st.dominant as f32;
        o[at!("styleConfidence")] = st.confidence;
        o[at!("archetypes")..at!("archetypes") + 5].copy_from_slice(&st.arche);
        o[at!("look")..at!("look") + 7].copy_from_slice(&st.look);
        let top = at!("styleTop");
        for (i, (id, w)) in st.top.iter().enumerate() {
            o[top + i * 2] = *id as f32;
            o[top + i * 2 + 1] = *w;
        }
        let ks = &st.kick;
        o[at!("kickType")] = ks.kind as f32;
        o[at!("kickShapeStrength")] = ks.strength;
        o[at!("kickAttack")] = ks.attack;
        o[at!("kickDecay")] = ks.decay;
        o[at!("kickClick")] = ks.click;
        o[at!("kickGrit")] = ks.grit;
        o[at!("kickShapeHit")] = if ks.hit { 1.0 } else { 0.0 };
        o[at!("kickSoft")] = ks.soft;
        o[at!("kickHard")] = ks.hard;
        o[at!("kickIndus")] = ks.indus;
        o[at!("genre")..at!("genre") + genre::N].copy_from_slice(&self.genre.out);
        // The accepted kick's evidence when this frame carries one (onset,
        // f0, f1, path, click dB, level against the track's kicks, score),
        // else the last candidate the detector weighed.
        if let Some((kt, _)) = kick {
            let d = at!("debug");
            o[d] = kt as f32;
            o[d + 1..d + 7].copy_from_slice(&kick_detail);
            o[d + 7] = 1.0;
        } else {
            o[at!("debug")..at!("debug") + 8].copy_from_slice(&snap.debug);
        }
        let dg = at!("diag");
        o[dg] = self.tempo.out.confidence;
        o[dg + 1] = if self.tempo.out.locked { 1.0 } else { 0.0 };
        o[dg + 2] = self.tempo.out.bpm;
        o[dg + 3] = f.level_db;
        o[dg + 4] = f.loud_ref_db;
        o[dg + 5] = self.pattern.dbg_lull as f32;
        o[dg + 6] = dyn_ahead;
        o[dg + 7] = p.roll;
        self.out_n += 1;
    }

    pub fn seed(&mut self, bpm: f32, conf: f32) -> bool {
        self.tempo.seed(bpm, conf)
    }

    pub fn set_range(&mut self, lo: f32, hi: f32) {
        self.tempo.set_range(lo, hi);
    }

    pub fn set_live_range(&mut self, on: bool) {
        self.live_range = on;
        if on {
            self.range_from = -1;
        }
    }

    pub fn load_families(&mut self, t: &[f32]) -> bool {
        self.style.load_families(t)
    }

    pub fn output(&self) -> &[f32] {
        &self.out[..self.out_n * self.frame_len]
    }

    pub fn hop(&self) -> usize {
        self.hop
    }
}

// --- the C ABI the worklet calls ------------------------------------------------------
//
// One analyser per WebAssembly instance, which is one per AudioWorklet node.

struct Global {
    a: Option<Analyzer>,
    input: Vec<f32>,
    fam: Vec<f32>,
    probe: Vec<f32>,
    layout: String,
}

static mut G: Option<Global> = None;

#[allow(static_mut_refs)]
fn g() -> &'static mut Global {
    // SAFETY: WebAssembly here is single-threaded, and every entry point runs
    // to completion before the next one is called.
    unsafe {
        if G.is_none() {
            G = Some(Global { a: None, input: vec![0.0; IN_CAP], fam: Vec::new(), probe: Vec::new(), layout: layout_string() });
        }
        G.as_mut().unwrap()
    }
}

#[no_mangle]
pub extern "C" fn rhythm_init(sr: f32) -> u32 {
    let gl = g();
    gl.a = Some(Analyzer::new(sr));
    1
}

#[no_mangle]
pub extern "C" fn rhythm_input() -> *mut f32 {
    g().input.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn rhythm_input_cap() -> u32 {
    IN_CAP as u32
}

#[no_mangle]
pub extern "C" fn rhythm_process(n: u32) -> u32 {
    let gl = g();
    let n = (n as usize).min(IN_CAP);
    match gl.a.as_mut() {
        Some(a) => a.push(&gl.input[..n]) as u32,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn rhythm_output() -> *const f32 {
    match g().a.as_ref() {
        Some(a) => a.out.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn rhythm_frame_len() -> u32 {
    layout_len() as u32
}

#[no_mangle]
pub extern "C" fn rhythm_layout() -> *const u8 {
    g().layout.as_ptr()
}

#[no_mangle]
pub extern "C" fn rhythm_layout_len() -> u32 {
    g().layout.len() as u32
}

#[no_mangle]
pub extern "C" fn rhythm_hop() -> u32 {
    g().a.as_ref().map(|a| a.hop as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rhythm_lookahead() -> u32 {
    LOOKAHEAD as u32
}

#[no_mangle]
pub extern "C" fn rhythm_seed(bpm: f32, conf: f32) -> u32 {
    g().a.as_mut().map(|a| a.seed(bpm, conf) as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn rhythm_set_range(lo: f32, hi: f32) {
    if let Some(a) = g().a.as_mut() {
        a.set_range(lo, hi);
    }
}

#[no_mangle]
pub extern "C" fn rhythm_set_live_range(on: u32) {
    if let Some(a) = g().a.as_mut() {
        a.set_live_range(on != 0);
    }
}

#[no_mangle]
pub extern "C" fn rhythm_set_level(level: u32) {
    if let Some(a) = g().a.as_mut() {
        a.set_level(level);
    }
}

#[no_mangle]
pub extern "C" fn rhythm_reset() {
    if let Some(a) = g().a.as_mut() {
        a.reset();
    }
}

#[no_mangle]
pub extern "C" fn rhythm_families(n: u32) -> *mut f32 {
    let gl = g();
    gl.fam = vec![0.0; (n as usize).min(1 << 16)];
    gl.fam.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn rhythm_load_families(n: u32) -> u32 {
    let gl = g();
    let n = (n as usize).min(gl.fam.len());
    match gl.a.as_mut() {
        Some(a) => a.load_families(&gl.fam[..n]) as u32,
        None => 0,
    }
}

/// The classifier's working state, for the tests and the eval: the frame's
/// descriptors (style.js RULE_FEATURES order) followed by every family's
/// smoothed weight. Returns how many floats `rhythm_style_probe_ptr` holds.
#[no_mangle]
pub extern "C" fn rhythm_style_probe() -> u32 {
    let gl = g();
    gl.probe.clear();
    if let Some(a) = gl.a.as_ref() {
        gl.probe.extend_from_slice(&a.style.s);
        gl.probe.extend_from_slice(a.style.weights());
    }
    gl.probe.len() as u32
}

#[no_mangle]
pub extern "C" fn rhythm_style_probe_ptr() -> *const f32 {
    g().probe.as_ptr()
}

#[no_mangle]
pub extern "C" fn rhythm_src_hash() -> u32 {
    env!("RHYTHM_SRC_HASH").parse::<u32>().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_is_consistent() {
        let s = layout_string();
        let total: usize = s
            .split(';')
            .map(|p| p.split(':').nth(1).unwrap().parse::<usize>().unwrap())
            .sum();
        assert_eq!(total, layout_len());
    }

    #[test]
    fn silence_produces_frames_and_no_events() {
        let mut a = Analyzer::new(48000.0);
        let x = vec![0f32; 48000];
        let mut frames = 0;
        let mut kicks = 0;
        for chunk in x.chunks(128) {
            let n = a.push(chunk);
            for i in 0..n {
                let o = &a.output()[i * a.frame_len..(i + 1) * a.frame_len];
                if o[at!("kickHit")] > 0.0 {
                    kicks += 1;
                }
            }
            frames += n;
        }
        assert!(frames > 80 && frames < 95, "{}", frames);
        assert_eq!(kicks, 0);
    }
}

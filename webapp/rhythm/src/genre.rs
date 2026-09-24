//! The GENRE CHANNEL: a handful of continuous readings that only some genres
//! are made of, published to every world so each can draw what its genre is
//! actually about. A techno tunnel wants the hats and the groove; a Deutscher
//! Krach microwave wants the BUZZ — a kick so distorted it is a tone — and the
//! screeches; frenchcore wants its lead; hardstyle its offbeat bass.
//!
//!   lead      sustained, PITCHED energy in the lead register (250 Hz-3.5 kHz),
//!             against this track's own level of it: the melody the crowd sings.
//!   buzz      the same sustained energy when it is FLAT — a stack of saws, a
//!             distorted kick's tail, a noise wall: zaag's saw, krach's hum.
//!   screech   an envelope on attacks in the mids that are neither kick nor
//!             snare and carry pitch: hoovers, screeches, stabs.
//!   sub       the bottom two octaves' share of the mix.
//!   offbeat   how much of the rhythmic evidence sits on the offbeat (beat.rs).
//!   density   onsets per beat, smoothed: a roll, a busy hat line.
//!   tail      how long the kick rings, 0..1 over 0..400 ms.
//!   grit      how noisy the kick is (its flatness while it rings).
//!
//! Every one of them is relative to the track's own history, so the same
//! reading means the same thing on a quiet folk record and a limitered wall.

use crate::util::MinMax;

pub const N: usize = 8;

pub struct Genre {
    lead_ref: f32,
    buzz_ref: f32,
    lead: f32,
    buzz: f32,
    screech: f32,
    sub: f32,
    density: f32,
    onset_avg: f32,
    onset_var: f32,
    pub out: [f32; N],
}

impl Genre {
    pub fn new() -> Genre {
        Genre {
            lead_ref: 1e-6,
            buzz_ref: 1e-6,
            lead: 0.0,
            buzz: 0.0,
            screech: 0.0,
            sub: 0.0,
            density: 0.0,
            onset_avg: 0.0,
            onset_var: 0.0,
            out: [0.0; N],
        }
    }

    pub fn reset(&mut self) {
        *self = Genre::new();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update(
        &mut self,
        dt: f32,
        beat: f32,
        harm_mid: f32,
        harm_flat: f32,
        melody: f32,
        mid_flux: f32,
        kick_or_snare: bool,
        energy_lin: &[f32; 6],
        offbeat: f32,
        onsets_this_frame: f32,
        kick_decay: f32,
        kick_grit: f32,
        dynamics: f32,
    ) {
        let dt = dt.fmax(1e-4);
        // The track's own reference for the sustained lead energy: up fast,
        // down over half a minute, like the loudness reference.
        let pitched = harm_mid * (1.0 - harm_flat).fmax(0.0);
        let flat = harm_mid * harm_flat;
        let up = |r: &mut f32, v: f32| {
            let tau = if v > *r { 0.8 } else { 30.0 };
            *r += (v - *r) * (1.0 - (-dt / tau).exp());
            *r = r.fmax(1e-7);
        };
        up(&mut self.lead_ref, pitched);
        up(&mut self.buzz_ref, flat);
        let lead_now = ((pitched / self.lead_ref) * (0.5 + 0.5 * melody)).clamp(0.0, 1.0);
        let buzz_now = ((flat / self.buzz_ref) * harm_flat.powf(0.5) * 1.3).clamp(0.0, 1.0);
        let a = 1.0 - (-dt / (beat * 0.5).fmax(0.05)).exp();
        self.lead += (lead_now * dynamics.fmax(0.2) - self.lead) * a;
        self.buzz += (buzz_now * dynamics.fmax(0.2) - self.buzz) * a;

        // Screeches: a spike of the mid band's flux that is not a drum.
        let d = mid_flux - self.onset_avg;
        self.onset_avg += d * 0.04;
        self.onset_var += (d * d - self.onset_var) * 0.04;
        let thr = self.onset_avg + self.onset_var.fmax(1e-12).sqrt() * 2.0;
        if mid_flux > thr && !kick_or_snare && harm_flat < 0.6 {
            let p = ((mid_flux - thr) / (thr + 1e-6)).clamp(0.3, 1.0);
            self.screech = self.screech.fmax(p);
        }
        self.screech *= (-dt / (beat * 0.25).fmax(0.03)).exp();

        // The bottom two octaves' share of the POWER. The six energies are
        // per-bin means, and the bands are 40 Hz to 10 kHz wide: summed as
        // they are, the sub read 1.0 on every record with a kick, which is to
        // say it read nothing. Weighted by width they are powers, and a mix
        // sits between a third (a pop record) and nine tenths (a hardcore
        // drop) of it down there.
        const WIDTH: [f32; 6] = [40.0, 100.0, 340.0, 1500.0, 4000.0, 10000.0];
        let mut total = 1e-12f32;
        for k in 0..6 {
            total += energy_lin[k] * WIDTH[k];
        }
        let low = energy_lin[0] * WIDTH[0] + energy_lin[1] * WIDTH[1];
        let sub_now = ((low / total - 0.35) / 0.6).clamp(0.0, 1.0);
        self.sub += (sub_now - self.sub) * (1.0 - (-dt / 0.3).exp());

        // Onsets per beat: EVENTS this frame (a kick, a snare, an onset of
        // the whole band), turned into a rate in beats. Counting frames a
        // hat was sounding instead read every hard record at the ceiling.
        let rate = onsets_this_frame / dt * beat;
        self.density += (rate - self.density) * (1.0 - (-dt / (beat * 2.0).fmax(0.2)).exp());

        self.out = [
            self.lead,
            self.buzz,
            self.screech,
            self.sub,
            offbeat.clamp(0.0, 1.0),
            // Four onsets a beat — sixteenths — is a full reading.
            (self.density / 4.0).clamp(0.0, 1.0),
            (kick_decay / 0.4).clamp(0.0, 1.0),
            kick_grit.clamp(0.0, 1.0),
        ];
    }
}

impl Default for Genre {
    fn default() -> Self {
        Self::new()
    }
}

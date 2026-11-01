//! NSupySonic's whole-track measures, for analysis on the client PC.
//!
//! WIP (preparation): the spectral descriptors and loudness are here and agree with
//! ffmpeg's (docs/agents/analysis-genre.md, "Analysis on the client PC"); the beat
//! tracker and the log-mel front-end are not yet. Nothing in the app loads this.

pub mod fft;
pub mod loudness;
pub mod spectral;
pub mod tempo;

/// What `analysis._spectral` returns, from decoded PCM.
#[derive(Debug, Clone, Default)]
pub struct Summary {
    pub centroid: f64,
    pub spread: f64,
    pub flatness: f64,
    pub flatness_hi: f64,
    pub entropy: f64,
    pub rolloff: f64,
    pub flux_peak: f64,
    pub lufs: Option<f64>,
    pub lra: Option<f64>,
    pub frames: usize,
}

pub fn measure(channels: &[&[f32]], rate: f64) -> Option<Summary> {
    let mut s = spectral::Series::default();
    for ch in channels {
        spectral::channel(ch, rate, &mut s);
    }
    if s.centroid.is_empty() {
        return None;
    }
    let mflux = spectral::median(&s.flux);
    let (lufs, lra) = match loudness::measure(channels, rate) {
        Some((i, r)) => (Some(i), Some(r)),
        None => (None, None),
    };
    Some(Summary {
        centroid: spectral::median(&s.centroid),
        spread: spectral::median(&s.spread),
        flatness: spectral::median(&s.flatness),
        flatness_hi: spectral::pct(&s.flatness, 0.9),
        entropy: spectral::median(&s.entropy),
        rolloff: spectral::median(&s.rolloff),
        flux_peak: if mflux > 1e-9 { spectral::pct(&s.flux, 0.9) / mflux } else { 1.0 },
        lufs,
        lra,
        frames: s.centroid.len(),
    })
}

// -- the WebAssembly surface: fill the channel buffers, run, read numbers back --

static mut CH: Vec<Vec<f32>> = Vec::new();
static mut OUT: [f64; 10] = [0.0; 10];
static mut RATE: f64 = 44100.0;

#[no_mangle]
pub extern "C" fn ms_src_hash() -> u32 {
    env!("MEASURE_SRC_HASH").parse().unwrap_or(0)
}

/// Start a measurement of `channels` channels of `n` samples at `rate` Hz.
#[no_mangle]
pub extern "C" fn ms_begin(channels: u32, n: u32, rate: f64) -> u32 {
    if channels == 0 || channels > 8 || n < 2048 || !(8000.0..=192000.0).contains(&rate) {
        return 0;
    }
    #[allow(static_mut_refs)]
    unsafe {
        CH = (0..channels).map(|_| vec![0.0f32; n as usize]).collect();
        RATE = rate;
    }
    1
}

#[no_mangle]
pub extern "C" fn ms_channel(c: u32) -> *mut f32 {
    #[allow(static_mut_refs)]
    unsafe {
        CH.get_mut(c as usize).map_or(core::ptr::null_mut(), |v| v.as_mut_ptr())
    }
}

/// 1 if a summary was produced (then `ms_out(i)` reads it), else 0.
#[no_mangle]
pub extern "C" fn ms_run() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        let refs: Vec<&[f32]> = CH.iter().map(|v| v.as_slice()).collect();
        match measure(&refs, RATE) {
            Some(s) => {
                OUT = [
                    s.centroid, s.spread, s.flatness, s.flatness_hi, s.entropy, s.rolloff,
                    s.flux_peak, s.lufs.unwrap_or(f64::NAN), s.lra.unwrap_or(f64::NAN), s.frames as f64,
                ];
                1
            }
            None => 0,
        }
    }
}

/// 0 centroid, 1 spread, 2 flatness, 3 flatness_hi, 4 entropy, 5 rolloff,
/// 6 flux_peak, 7 lufs (NaN: none), 8 lra (NaN: none), 9 frames.
#[no_mangle]
pub extern "C" fn ms_out(i: u32) -> f64 {
    #[allow(static_mut_refs)]
    unsafe {
        OUT.get(i as usize).copied().unwrap_or(f64::NAN)
    }
}

// -- the tempo, as a stream: begin, push chunks of 44.1 kHz mono, finish, read back ---------

static mut ONSETS: Option<tempo::Onsets> = None;
static mut TEMPO: Option<tempo::Tempo> = None;
static mut CHUNK: Vec<f32> = Vec::new();
/// Most samples one pushed chunk may hold (4 MB): a hostile size is refused, not allocated.
const CHUNK_MAX: u32 = 1 << 20;

#[no_mangle]
pub extern "C" fn tp_begin() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        ONSETS = Some(tempo::Onsets::new());
        TEMPO = None;
    }
    1
}

/// A buffer of `n` samples for the page to fill, then `tp_push`. Null when refused.
#[no_mangle]
pub extern "C" fn tp_chunk(n: u32) -> *mut f32 {
    if n == 0 || n > CHUNK_MAX {
        return core::ptr::null_mut();
    }
    #[allow(static_mut_refs)]
    unsafe {
        CHUNK.resize(n as usize, 0.0);
        CHUNK.as_mut_ptr()
    }
}

/// Feed the chunk; returns the onset frames held so far (0 without a `tp_begin`).
#[no_mangle]
pub extern "C" fn tp_push() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        match ONSETS.as_mut() {
            Some(o) => {
                o.push(&CHUNK);
                o.df.len() as u32
            }
            None => 0,
        }
    }
}

/// 1 when a tempo was found (then `tp_out` / `tp_beat` read it), else 0.
#[no_mangle]
pub extern "C" fn tp_finish() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        TEMPO = ONSETS.as_ref().and_then(tempo::analyse);
        TEMPO.is_some() as u32
    }
}

/// 0 bpm, 1 confidence, 2 salience, 3 doubled (0/1), 4 alternation, 5 number of beats.
#[no_mangle]
pub extern "C" fn tp_out(i: u32) -> f64 {
    #[allow(static_mut_refs)]
    unsafe {
        match TEMPO.as_ref() {
            Some(t) => match i {
                0 => t.bpm,
                1 => t.confidence,
                2 => t.salience,
                3 => t.doubled as u32 as f64,
                4 => t.alternation,
                5 => t.beats.len() as f64,
                _ => f64::NAN,
            },
            None => f64::NAN,
        }
    }
}

/// The i-th beat, in seconds.
#[no_mangle]
pub extern "C" fn tp_beat(i: u32) -> f64 {
    #[allow(static_mut_refs)]
    unsafe {
        TEMPO.as_ref().and_then(|t| t.beats.get(i as usize).copied()).unwrap_or(f64::NAN)
    }
}

//! NSupySonic's whole-track measures, for analysis on the client PC.
//!
//! WIP (preparation): the spectral descriptors and loudness are here and agree with
//! ffmpeg's (docs/agents/analysis-genre.md, "Analysis on the client PC"); the beat
//! tracker and the log-mel front-end are not yet. Nothing in the app loads this.

pub mod fft;
pub mod loudness;
pub mod lowband;
pub mod mel;
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

// -- the extractor's front-end and aggregation (the network runs in the page) ----------------
//
// The page decodes the track to 16 kHz mono, asks `mel_plan(n)` how many patches the extractor
// takes and where, copies each patch's samples into `mel_segment(k)`, calls `mel_run`, feeds
// `mel_patches()` (count x 128 x 96) to the network, writes its rows (count x 1280) into
// `mel_rows()` and reads the stored vector back from `mel_aggregate()` (3840 floats).

static mut MEL_OFFSETS: Vec<usize> = Vec::new();
static mut MEL_SEG: Vec<f32> = Vec::new();
static mut MEL_PATCHES: Vec<f32> = Vec::new();
static mut MEL_LOUD: Vec<f64> = Vec::new();
static mut MEL_ROWS: Vec<f32> = Vec::new();
static mut MEL_VEC: Vec<f32> = Vec::new();
/// Longest track the plan accepts (16 kHz samples): a day of audio is refused, not allocated for.
const MEL_MAX_SAMPLES: u32 = 16000 * 3600 * 4;

/// How many patches a track of `n` samples yields (0: too short or too long).
#[no_mangle]
pub extern "C" fn mel_plan(n: u32) -> u32 {
    if n > MEL_MAX_SAMPLES {
        return 0;
    }
    #[allow(static_mut_refs)]
    unsafe {
        MEL_OFFSETS = mel::patch_offsets(n as usize, mel::MAX_PATCHES);
        let c = MEL_OFFSETS.len();
        MEL_SEG = vec![0.0; c * mel::PATCH_SAMPLES];
        MEL_PATCHES = Vec::new();
        MEL_ROWS = vec![0.0; c * mel::MODEL_DIM];
        c as u32
    }
}

/// Where patch `k` starts in the 16 kHz signal.
#[no_mangle]
pub extern "C" fn mel_offset(k: u32) -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        MEL_OFFSETS.get(k as usize).map_or(0, |o| *o as u32)
    }
}

/// The buffer patch `k`'s `PATCH_SAMPLES` (33024) samples go into.
#[no_mangle]
pub extern "C" fn mel_segment(k: u32) -> *mut f32 {
    #[allow(static_mut_refs)]
    unsafe {
        if (k as usize) < MEL_OFFSETS.len() {
            MEL_SEG.as_mut_ptr().add(k as usize * mel::PATCH_SAMPLES)
        } else {
            core::ptr::null_mut()
        }
    }
}

/// Compute the log-mel patches and the patches' levels. 1 on success.
#[no_mangle]
pub extern "C" fn mel_run() -> u32 {
    #[allow(static_mut_refs)]
    unsafe {
        let c = MEL_OFFSETS.len();
        let compact: Vec<usize> = (0..c).map(|k| k * mel::PATCH_SAMPLES).collect();
        match mel::log_mel_patches(&MEL_SEG, &compact) {
            Some(p) => {
                MEL_LOUD = mel::patch_loudness(&MEL_SEG, &compact);
                MEL_PATCHES = p;
                1
            }
            None => 0,
        }
    }
}

#[no_mangle]
pub extern "C" fn mel_patches() -> *const f32 {
    #[allow(static_mut_refs)]
    unsafe {
        MEL_PATCHES.as_ptr()
    }
}

/// Where the network's rows (count x 1280, one per patch) are written.
#[no_mangle]
pub extern "C" fn mel_rows() -> *mut f32 {
    #[allow(static_mut_refs)]
    unsafe {
        MEL_ROWS.as_mut_ptr()
    }
}

/// The stored vector (3840 floats) from the rows, or null.
#[no_mangle]
pub extern "C" fn mel_aggregate() -> *const f32 {
    #[allow(static_mut_refs)]
    unsafe {
        match mel::aggregate(&MEL_ROWS, MEL_OFFSETS.len(), Some(&MEL_LOUD)) {
            Some(v) => {
                MEL_VEC = v;
                MEL_VEC.as_ptr()
            }
            None => core::ptr::null(),
        }
    }
}

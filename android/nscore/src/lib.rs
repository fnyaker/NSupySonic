//! NSupySonic's native audio core, for the Android app (`android/app`, `NsCore.kt`).
//!
//! Two objects, each a HANDLE the Kotlin side holds (a boxed pointer as a `long`):
//!
//! - an [`Analyser`]: the very `rhythm` crate the web app runs in its AudioWorklet
//!   (`webapp/rhythm`), compiled for the device instead of for WebAssembly — same
//!   source, same frames, so the animations read the same analysis whichever
//!   side ran it;
//! - a [`dsp::Chain`]: the output processing (normalization, fade, EQ, bass).
//!
//! Like the wasm build, nothing is copied across the boundary per call: each
//! object owns its buffers and hands them to Kotlin ONCE as direct ByteBuffers
//! (`jni.rs`); a call then only says how much of them to use.

pub mod dsp;
mod jni;

/// Bumped whenever the JNI surface changes; `NsCore.kt` refuses a library whose
/// number it does not know.
pub const ABI_VERSION: u32 = 1;

/// The analyser plus the two buffers Kotlin reads and writes.
pub struct Analyser {
    pub a: rhythm::Analyzer,
    /// Mono samples Kotlin writes, then `push(n)`.
    pub input: Vec<f32>,
    /// The frames the last push produced, copied out of the analyser so this
    /// buffer's address never moves (handed to Kotlin once).
    pub output: Vec<f32>,
    pub frame_len: usize,
}

/// The largest push, in samples. Matches the worklet's own input capacity.
pub const INPUT_CAP: usize = 16384;

impl Analyser {
    pub fn new(sr: f32) -> Analyser {
        let a = rhythm::Analyzer::new(sr);
        let _ = layout(); // the global the frame length reads, built on this thread first
        let frame_len = rhythm::rhythm_frame_len() as usize;
        let hop = a.hop().max(1);
        Analyser {
            a,
            input: vec![0.0; INPUT_CAP],
            output: vec![0.0; (INPUT_CAP / hop + 2) * frame_len],
            frame_len,
        }
    }

    /// Analyse `input[..n]`; returns how many frames are now in `output`.
    pub fn push(&mut self, n: usize) -> usize {
        let n = n.min(self.input.len());
        let made = self.a.push(&self.input[..n]);
        let src = self.a.output();
        let take = (made * self.frame_len).min(src.len()).min(self.output.len());
        self.output[..take].copy_from_slice(&src[..take]);
        take / self.frame_len.max(1)
    }

    /// `load_families` with the table Kotlin wrote at the start of `input`.
    pub fn load_families(&mut self, n: usize) -> bool {
        let n = n.min(self.input.len());
        let table = self.input[..n].to_vec();
        self.a.load_families(&table)
    }
}

/// The frame layout ("name:len,…"), as the web app's `rhythm_layout` gives it.
pub fn layout() -> &'static str {
    // Read once: the crate's C ABI keeps it in a lazily built global that was
    // written for single-threaded WebAssembly, and JNI calls come from any thread.
    static LAYOUT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LAYOUT.get_or_init(|| {
        let p = rhythm::rhythm_layout();
        let n = rhythm::rhythm_layout_len() as usize;
        if p.is_null() {
            return String::new();
        }
        // SAFETY: rhythm_layout points at its own String of rhythm_layout_len
        // bytes, built once and never mutated.
        let bytes = unsafe { core::slice::from_raw_parts(p, n) };
        String::from_utf8_lossy(bytes).into_owned()
    })
}

/// The analyser sources' hash, the same number `rhythm.wasm` reports.
pub fn src_hash() -> u32 {
    rhythm::rhythm_src_hash()
}

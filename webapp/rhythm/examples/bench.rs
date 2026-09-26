//! Time the analyser natively over a raw mono f32 file (48 kHz), pushed 128
//! samples at a time exactly as the AudioWorklet pushes it.
//! `cargo run --release --example bench -- <file.f32> [families.f32]`
use std::io::Read;
use std::time::Instant;

fn read_f32(path: &str) -> Vec<f32> {
    let mut f = std::fs::File::open(path).expect("file");
    let mut raw = Vec::new();
    f.read_to_end(&mut raw).unwrap();
    raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pcm = read_f32(&args[1]);
    for level in 0..3u32 {
        let mut a = rhythm::Analyzer::new(48000.0);
        if let Some(fam) = args.get(2) {
            let t = read_f32(fam);
            assert!(a.load_families(&t));
        }
        a.set_level(level);
        let t0 = Instant::now();
        let mut frames = 0;
        for chunk in pcm.chunks(128) {
            frames += a.push(chunk);
        }
        let us = t0.elapsed().as_secs_f64() * 1e6;
        println!(
            "level {}: {:.1} us/frame over {} frames ({:.2}% of real time)",
            level,
            us / frames as f64,
            frames,
            us / 1e6 / (pcm.len() as f64 / 48000.0) * 100.0
        );
    }
}

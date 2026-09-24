//! Run the analyser over a raw mono f32 file (48 kHz) — the eval's cache — and
//! print what it decided. `cargo run --release --features trace --example
//! trace -- <file.f32> [families.f32]`.
use std::io::Read;

fn read_f32(path: &str) -> Vec<f32> {
    let mut f = std::fs::File::open(path).expect("file");
    let mut raw = Vec::new();
    f.read_to_end(&mut raw).unwrap();
    raw.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pcm = read_f32(&args[1]);
    let mut a = rhythm::Analyzer::new(48000.0);
    if let Some(fam) = args.get(2) {
        let t = read_f32(fam);
        assert!(a.load_families(&t));
        a.set_level(2);
    }
    for chunk in pcm.chunks(4096) {
        a.push(chunk);
    }
}

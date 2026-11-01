//! `measure RATE CHANNELS < interleaved-f32le` → one JSON line, for the parity tests.
use std::io::Read;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let rate: f64 = a[1].parse().unwrap();
    let ch: usize = a[2].parse().unwrap();
    let mut raw = Vec::new();
    std::io::stdin().read_to_end(&mut raw).unwrap();
    let all: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let planar: Vec<Vec<f32>> = (0..ch).map(|c| all.iter().skip(c).step_by(ch).copied().collect()).collect();
    let refs: Vec<&[f32]> = planar.iter().map(|v| v.as_slice()).collect();
    match measure::measure(&refs, rate) {
        Some(s) => println!(
            "{{\"centroid\":{},\"spread\":{},\"flatness\":{},\"flatness_hi\":{},\"entropy\":{},\"rolloff\":{},\"flux_peak\":{},\"lufs\":{},\"lra\":{},\"frames\":{}}}",
            s.centroid, s.spread, s.flatness, s.flatness_hi, s.entropy, s.rolloff, s.flux_peak,
            s.lufs.map_or("null".into(), |v| v.to_string()), s.lra.map_or("null".into(), |v| v.to_string()), s.frames
        ),
        None => println!("null"),
    }
}

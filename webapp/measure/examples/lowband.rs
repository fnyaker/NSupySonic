//! `lowband BPM < (u32 rate, u32 channels, interleaved f32le)` -> JSON {attacks, grid}.
use std::io::Read;
fn main() {
    let bpm: f64 = std::env::args().nth(1).unwrap().parse().unwrap();
    let mut raw = Vec::new();
    std::io::stdin().read_to_end(&mut raw).unwrap();
    let rate = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64;
    let ch = u32::from_le_bytes([raw[4], raw[5], raw[6], raw[7]]) as usize;
    let all: Vec<f32> = raw[8..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let planar: Vec<Vec<f32>> = (0..ch).map(|c| all.iter().skip(c).step_by(ch).copied().collect()).collect();
    let refs: Vec<&[f32]> = planar.iter().map(|v| v.as_slice()).collect();
    if std::env::args().nth(2).as_deref() == Some("raw") {
        use std::io::Write;
        std::io::stdout().write_all(&measure::lowband::raw_u8(&refs, rate)).unwrap();
        return;
    }
    let lb = measure::lowband::analyse(&refs, rate);
    println!("{{\"attacks\":{},\"grid\":{}}}", lb.attacks, lb.grid(bpm));
}

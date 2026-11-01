//! `tempo < mono-f32le-44100` → one JSON line, for the parity tests.
use std::io::Read;
fn main() {
    let mut raw = Vec::new();
    std::io::stdin().read_to_end(&mut raw).unwrap();
    let all: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let mut on = measure::tempo::Onsets::new();
    for c in all.chunks(512 * 512) {
        on.push(c);
    }
    match measure::tempo::analyse(&on) {
        Some(t) => {
            let beats: Vec<String> = t.beats.iter().map(|b| b.to_string()).collect();
            println!(
                "{{\"bpm\":{},\"confidence\":{},\"salience\":{},\"doubled\":{},\"alternation\":{},\"beats\":[{}]}}",
                t.bpm, t.confidence, t.salience, t.doubled, t.alternation, beats.join(",")
            );
        }
        None => println!("null"),
    }
}

//! `mel < 16 kHz mono f32le` -> binary: u32 count, u32 offsets[count], f32 patches[count*128*96],
//! f32 loudness[count]. `mel aggregate < (u32 n, f32 rows[n*1280], f32 loudness[n])` -> f32[3840].
use std::io::{Read, Write};
fn main() {
    let agg = std::env::args().nth(1).as_deref() == Some("aggregate");
    let mut raw = Vec::new();
    std::io::stdin().read_to_end(&mut raw).unwrap();
    let mut out = std::io::stdout();
    if agg {
        let n = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        let f: Vec<f32> = raw[4..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        let rows = &f[..n * measure::mel::MODEL_DIM];
        let loud: Vec<f64> = f[n * measure::mel::MODEL_DIM..].iter().map(|v| *v as f64).collect();
        let v = measure::mel::aggregate(rows, n, if loud.is_empty() { None } else { Some(&loud) }).unwrap();
        for x in v { out.write_all(&x.to_le_bytes()).unwrap(); }
        return;
    }
    let s: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let offsets = measure::mel::patch_offsets(s.len(), measure::mel::MAX_PATCHES);
    let patches = measure::mel::log_mel_patches(&s, &offsets).unwrap();
    let loud = measure::mel::patch_loudness(&s, &offsets);
    out.write_all(&(offsets.len() as u32).to_le_bytes()).unwrap();
    for o in &offsets { out.write_all(&(*o as u32).to_le_bytes()).unwrap(); }
    for p in &patches { out.write_all(&p.to_le_bytes()).unwrap(); }
    for l in &loud { out.write_all(&(*l as f32).to_le_bytes()).unwrap(); }
}

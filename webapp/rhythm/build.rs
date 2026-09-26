// Stamps a hash of the sources into the binary, so a committed rhythm.wasm
// that no longer matches the Rust next to it is caught by `npm test` instead of
// silently running old code. The same FNV-1a over the same files (sorted by
// name, raw bytes) is recomputed in webapp/test/rhythm.test.mjs.
use std::fs;
use std::path::Path;

fn main() {
    let dir = Path::new("src");
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("src/")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".rs"))
        .collect();
    names.sort();
    let mut h: u32 = 0x811c9dc5;
    for n in &names {
        for b in n.as_bytes() {
            h ^= *b as u32;
            h = h.wrapping_mul(0x01000193);
        }
        let body = fs::read(dir.join(n)).expect("read source");
        for b in body {
            h ^= b as u32;
            h = h.wrapping_mul(0x01000193);
        }
        println!("cargo:rerun-if-changed=src/{}", n);
    }
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rustc-env=RHYTHM_SRC_HASH={}", h);
}

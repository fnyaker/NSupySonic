#!/usr/bin/env node
// Build the genre studio's trainer (webapp/trainer) into the two WebAssembly
// binaries the studio's worker loads, and copy them where Vite picks them up:
//
//   src/lib/genre/trainer.wasm       baseline WebAssembly — runs everywhere
//   src/lib/genre/trainer-simd.wasm  with SIMD128, for every engine that
//                                    validates it; computes the SAME bits
//
// Run by `npm run wasm` with the analyser and the app core. Needs a Rust
// toolchain with the wasm32-unknown-unknown target. Both binaries are
// committed, so building the SPA never needs Rust; the Docker image rebuilds
// them from source, and test/trainer.test.mjs fails if a committed binary no
// longer matches the source it claims to be built from.

import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const genre = join(here, "../src/lib/genre");
const variants = [
  { out: "trainer.wasm", dir: "target", flags: "" },
  { out: "trainer-simd.wasm", dir: "target-simd", flags: "-C target-feature=+simd128" },
];
for (const v of variants) {
  execFileSync(
    "cargo",
    ["build", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", join(here, v.dir)],
    { cwd: here, stdio: "inherit", env: { ...process.env, RUSTFLAGS: v.flags } }
  );
  copyFileSync(join(here, v.dir, "wasm32-unknown-unknown/release/trainer.wasm"), join(genre, v.out));
  console.log(`trainer: ${v.out}`);
}

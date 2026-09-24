#!/usr/bin/env node
// Build the rhythm analyser (webapp/rhythm) into the two WebAssembly binaries
// the app ships, and copy them where Vite picks them up:
//
//   src/lib/audio/rhythm.wasm       baseline WebAssembly — runs everywhere
//   src/lib/audio/rhythm-simd.wasm  with SIMD128 — measured 21% faster (151 ->
//                                   119 us a frame in V8), loaded wherever the
//                                   browser validates a SIMD module
//
// `npm run wasm` from webapp/. Needs a Rust toolchain with the
// wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`).
// Both binaries are committed, like the genre studio's kernel.wasm, so that
// building the SPA never needs Rust; the Docker image rebuilds them from
// source, and test/rhythm.test.mjs fails if a committed binary no longer
// matches the source it claims to be built from.

import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const audio = join(here, "../src/lib/audio");
const variants = [
  { out: "rhythm.wasm", dir: "target", flags: "" },
  { out: "rhythm-simd.wasm", dir: "target-simd", flags: "-C target-feature=+simd128" },
];
for (const v of variants) {
  execFileSync(
    "cargo",
    ["build", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", join(here, v.dir)],
    { cwd: here, stdio: "inherit", env: { ...process.env, RUSTFLAGS: v.flags } }
  );
  copyFileSync(join(here, v.dir, "wasm32-unknown-unknown/release/rhythm.wasm"), join(audio, v.out));
  console.log(`rhythm: ${v.out}`);
}

#!/usr/bin/env node
// Build the app core (webapp/appcore) into the WebAssembly binary the page
// loads, and copy it where Vite picks it up: src/lib/appcore/appcore.wasm.
//
// Run by `npm run wasm` with the rhythm analyser's build. Needs a Rust
// toolchain with the wasm32-unknown-unknown target. The binary is committed
// like the analyser's, so building the SPA never needs Rust; the Docker image
// rebuilds it from source, and test/appcore.test.mjs fails if the committed
// binary no longer matches the source it claims to be built from.
//
// One build, no SIMD variant: nothing in here is a loop SIMD would widen.

import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", join(here, "target")],
  { cwd: here, stdio: "inherit", env: { ...process.env, RUSTFLAGS: "" } }
);
copyFileSync(
  join(here, "target/wasm32-unknown-unknown/release/appcore.wasm"),
  join(here, "../src/lib/appcore/appcore.wasm")
);
console.log("appcore: appcore.wasm");

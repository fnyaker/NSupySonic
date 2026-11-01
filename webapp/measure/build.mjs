#!/usr/bin/env node
// Build the whole-track measures (webapp/measure) into src/lib/measure/measure.wasm.
// WIP: nothing in the app loads it yet (docs/claude/client-analysis.md). The binary
// is committed so building the SPA never needs Rust; test/measure.test.mjs fails if it
// no longer matches the source next to it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../src/lib/measure");
mkdirSync(out, { recursive: true });
execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", join(here, "target")],
  { cwd: here, stdio: "inherit" }
);
copyFileSync(join(here, "target/wasm32-unknown-unknown/release/measure.wasm"), join(out, "measure.wasm"));
console.log("measure: measure.wasm");

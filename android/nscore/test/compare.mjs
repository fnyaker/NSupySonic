// libnscore against rhythm.wasm, frame for frame, on real arranged records.
//
// The analyser on the phone (the rhythm crate compiled for Android, reached over
// JNI) must publish what the web app's AudioWorklet publishes, or an animation
// would read a different track depending on where the sound came from. This
// renders records from webapp/test/songs.mjs, analyses each with the shipped
// rhythm.wasm in Node and with the host build of libnscore through its real JNI
// entry points (NsCoreCheck.java on a desktop JVM), and compares every field of
// every frame.
//
//   cargo build --release && node test/compare.mjs      (from android/nscore)
//
// Needs webapp's npm install (songs.mjs reaches svelte/store through style.js).
// Exact equality is not the contract: the two builds round libm's sin/exp/log
// differently in the last bit, and an analyser is a feedback system. What must
// hold is measured below and asserted: every frame present, the events (beats,
// kicks, drops) on the same frames, and the continuous fields within a bound.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "../../../webapp");
const { Rhythm } = await import(join(web, "src/lib/audio/rhythm-core.js"));
const { familyTable } = await import(join(web, "src/lib/audio/style.js"));
const { SONG_BY_ID } = await import(join(web, "test/songs.mjs"));
const { loadSong } = await import(join(web, "test/eval/rhythm-eval.mjs"));

const SONGS = (process.argv[2] || "techno-132,frenchcore-200,uptempo-220,dnb-174,classical-rubato,ambient-pads").split(",");
const LEVEL = 2;
const lib = join(here, "../target/release");
const work = mkdtempSync(join(tmpdir(), "nscore-"));
const table = familyTable();
writeFileSync(join(work, "fam.f32"), Buffer.from(new Float32Array(table).buffer));

const EVENTS = ["beat", "downbeat", "kickHit", "mainKick", "rollKick", "drop", "onset"];
let failed = false;

for (const id of SONGS) {
  const def = SONG_BY_ID.get(id);
  if (!def) {
    console.error(`unknown record ${id}`);
    failed = true;
    continue;
  }
  const { pcm } = loadSong(def);
  const r = Rhythm.fromModule(new WebAssembly.Module(readFileSync(join(web, "src/lib/audio/rhythm.wasm"))), 48000);
  r.loadFamilies(table);
  r.setLevel(LEVEL);
  const L = r.frameLen;
  const wasm = [];
  for (let i = 0; i < pcm.length; i += 128) {
    const n = r.push(pcm.subarray(i, Math.min(pcm.length, i + 128)));
    for (let k = 0; k < n; k++) wasm.push(Float32Array.from(r.frame(k)));
  }
  writeFileSync(join(work, "pcm.f32"), Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  execFileSync("java", [`-Djava.library.path=${lib}`, join(here, "NsCoreCheck.java"),
    join(work, "pcm.f32"), join(work, "fam.f32"), join(work, "out.f32"), String(LEVEL)], { stdio: ["ignore", "ignore", "inherit"] });
  const raw = readFileSync(join(work, "out.f32"));
  const nat = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

  const fields = r.layout.fields;
  const problems = [];
  if (nat.length !== wasm.length * L) problems.push(`frames: native ${nat.length / L}, wasm ${wasm.length}`);
  let exact = 0;
  let worst = 0;
  let worstName = "";
  const eventDiff = Object.fromEntries(EVENTS.map((e) => [e, 0]));
  const frames = Math.min(wasm.length, nat.length / L);
  for (let f = 0; f < frames; f++) {
    const w = wasm[f];
    const o = f * L;
    let same = true;
    for (let j = 0; j < L; j++) {
      const a = w[j];
      const b = nat[o + j];
      if (Object.is(a, b) || a === b) continue;
      same = false;
      const d = Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
      if (d > worst) {
        worst = d;
        worstName = Object.keys(fields).find((k) => j >= fields[k][0] && j < fields[k][0] + fields[k][1]);
      }
    }
    if (same) exact++;
    for (const e of EVENTS) {
      if (!fields[e]) continue;
      const j = fields[e][0];
      if ((w[j] > 0) !== (nat[o + j] > 0)) eventDiff[e]++;
    }
  }
  const evTotal = Object.values(eventDiff).reduce((a, b) => a + b, 0);
  console.log(`${id}: ${frames} frames, ${((exact / frames) * 100).toFixed(1)}% identical to the bit, ` +
    `worst relative difference ${worst.toExponential(2)} (${worstName || "-"}), events differing: ${evTotal}`);
  // The bounds, set from the measurement above on this machine (x86_64 host
  // build against the shipped wasm): see the header for why not equality.
  // Measured: the worst field (a spectrum band) differs by under 1e-5 of its
  // value on every record, and no event moves a frame.
  if (worst > 1e-3) problems.push(`${worstName} differs by ${worst.toExponential(2)} of its value`);
  if (evTotal > 0) problems.push(`events differ on ${evTotal} frames: ${JSON.stringify(eventDiff)}`);
  if (problems.length) {
    failed = true;
    console.error(`  ${problems.join("\n  ")}`);
  }
}
process.exit(failed ? 1 : 0);

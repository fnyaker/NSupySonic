// The arranged records of test/songs.mjs as 16-bit mono WAV files, with their
// ground truth, for the SERVER's tempo measurement (tools/tempo_eval.py). The
// client's analyser is scored on the same records by rhythm-eval.mjs; this is
// how the whole-file estimator in supysonic/deezer/analysis.py gets the same
// material instead of three sines.
//
//   node test/eval/render-wavs.mjs <out-dir>

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SONGS, SR } from "../songs.mjs";
import { loadSong } from "./rhythm-eval.mjs";

const out = process.argv[2];
if (!out) {
  console.error("usage: node test/eval/render-wavs.mjs <out-dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const truth = {};
for (const def of SONGS) {
  const { pcm } = loadSong(def);
  const n = pcm.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  writeFileSync(join(out, def.id + ".wav"), buf);
  truth[def.id] = { bpm: def.bpm, noBeat: !!def.noBeat, genre: def.genre, meter: def.meter || 4 };
}
writeFileSync(join(out, "truth.json"), JSON.stringify(truth, null, 1));
console.log(`${SONGS.length} records -> ${out}`);

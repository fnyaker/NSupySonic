// How a track is BUILT, as the genre head reads it (lib/genre/construction.js):
// the meter the player and the studio's measurer share, run over arranged
// records through the SHIPPED analyser exactly as measure.worker.js runs it,
// and the extras block the server has to rebuild number for number
// (supysonic/deezer/genre.py#assemble — tests/test_webui.py holds it to the
// same literals).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Rhythm } from "../src/lib/audio/rhythm-core.js";
import { familyTable, RULE_FEATURES } from "../src/lib/audio/style.js";
import {
  CONSTRUCTION,
  ConstructionMeter,
  EXTRAS,
  MIN_FRAMES,
  extrasBlock,
  fitScaler,
  rawExtras,
} from "../src/lib/genre/construction.js";
import { SONG_BY_ID, SR } from "./songs.mjs";
import { loadSong } from "./eval/rhythm-eval.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = readFileSync(join(here, "../src/lib/audio/rhythm.wasm"));

// measure.worker.js, minus the Worker: the served tempo seeds the grid, the
// analyser runs at the smart level, every frame goes to the meter.
const summaries = new Map();
async function measure(id) {
  if (summaries.has(id)) return summaries.get(id);
  const def = SONG_BY_ID.get(id);
  const { pcm } = loadSong(def);
  const r = await Rhythm.fromBytes(WASM, SR);
  r.loadFamilies(familyTable());
  r.setLevel(2);
  r.seed(def.bpm, 0.9);
  const I = {};
  for (const k in r.layout.fields) I[k] = r.layout.fields[k][0];
  const meter = new ConstructionMeter();
  for (let i = 0; i < pcm.length; i += 4096) {
    const n = r.push(pcm.subarray(i, Math.min(pcm.length, i + 4096)));
    for (let k = 0; k < n; k++) meter.add(r.frame(k), I);
  }
  const s = meter.summary();
  summaries.set(id, s);
  return s;
}

test("every descriptor the meter keeps is one the analyser publishes", () => {
  for (const k of CONSTRUCTION) assert.ok(RULE_FEATURES.includes(k), k);
  assert.deepEqual(EXTRAS, ["tempo", ...CONSTRUCTION]);
});

// Measured (shipped binary, seeded with the record's tempo):
//   piep     pieep-170 0.948 | frenchcore 0.102, uptempo 0.040, krach 0.007, techno 0
//   kickF0   techno 63 Hz, dnb 99, pieep 128, uptempo 173, krach 175
//   four     techno 0.94, pieep 0.93, krach 0.95, uptempo 0.90 | dnb 0.33
//   kIndus   uptempo 0.72 | techno 0.01;  kSoft techno 0.98 | uptempo 0.05
test("the piep kick is heard on the pieep record and on no other", async () => {
  const pieep = await measure("pieep-170");
  assert.ok(pieep.features.piep > 0.8, `pieep ${pieep.features.piep}`);
  for (const id of ["krach-205", "uptempo-220", "techno-132", "dnb-174"]) {
    const s = await measure(id);
    assert.ok(s.features.piep < 0.15, `${id} piep ${s.features.piep}`);
  }
});

test("where the kick's pitch starts separates a techno kick from a hard one", async () => {
  const techno = await measure("techno-132");
  assert.ok(techno.features.kickF0 < 80, `techno kickF0 ${techno.features.kickF0}`);
  for (const id of ["uptempo-220", "krach-205"]) {
    const s = await measure(id);
    assert.ok(s.features.kickF0 > 150, `${id} kickF0 ${s.features.kickF0}`);
  }
  const up = await measure("uptempo-220");
  assert.ok(up.features.kIndus > 0.5 && techno.features.kIndus < 0.1, "kick shape");
  assert.ok(techno.features.kSoft > 0.8 && up.features.kSoft < 0.2, "kick shape");
});

test("four on the floor is read as such, a broken beat is not", async () => {
  for (const id of ["techno-132", "pieep-170", "krach-205", "uptempo-220"]) {
    const s = await measure(id);
    assert.ok(s.features.four > 0.85, `${id} four ${s.features.four}`);
  }
  const dnb = await measure("dnb-174");
  assert.ok(dnb.features.four < 0.5, `dnb four ${dnb.features.four}`);
});

test("the meter counts only the groove: locked, loud, finite", () => {
  const I = { locked: 0, dynamics: 1, styleFeat: 2 };
  const buf = new Float32Array(2 + RULE_FEATURES.length);
  const slot = (k) => 2 + RULE_FEATURES.indexOf(k);
  const m = new ConstructionMeter();
  const feed = (locked, dyn, piep, times) => {
    buf[0] = locked;
    buf[1] = dyn;
    buf[slot("piep")] = piep;
    buf[slot("kickF0")] = 200;
    for (let i = 0; i < times; i++) m.add(buf, I);
  };
  feed(1, 1, 0.5, MIN_FRAMES - 1);
  assert.equal(m.summary(), null, "under MIN_FRAMES says nothing");
  feed(0, 1, 9, 500); // grid not locked: an intro
  feed(1, 0.3, 9, 500); // a breakdown
  feed(1, 1, NaN, 500); // a frame that cannot be trusted
  assert.equal(m.n, MIN_FRAMES - 1);
  feed(1, 1, 0.8, 1);
  const s = m.summary();
  assert.equal(s.n, MIN_FRAMES);
  // (0.5 · 1899 + 0.8) / 1900
  assert.equal(s.features.piep, 0.50016);
  assert.equal(s.features.kickF0, 200);
  m.reset();
  assert.equal(m.n, 0);
  assert.equal(m.summary(), null);
  // A layout without the fields (an analyser too old to publish them) is ignored.
  new ConstructionMeter().add(buf, { dynamics: 1 });
});

// The contract with the server. The same inputs and the same numbers are in
// tests/test_webui.py (ConstructionTestCase.test_assemble_matches_the_studio).
const MEAN = [0.3, 150, 0.1, 0.4, 0.2, 0.1, 0.05, 0.3, 0.5, 0.1, 0.6, 0.33, 0.33, 0.33];
const STD = [0.4, 40, 0.2, 0.2, 0.2, 0.1, 0.05, 0.2, 0.3, 0.1, 0.3, 0.2, 0.2, 0.2];

test("the extras block: tempo in octaves, standardised, clipped, flagged", () => {
  const raw = rawExtras({ bpm: 150, live: { kickF0: 180, piep: 0.9, tail: 0.3, four: 0.95, roll: 0.2 } });
  const block = extrasBlock(raw, { mean: MEAN, std: STD }, 0.3);
  const want = [
    0.01644607074558735, 0.22499999403953552, 1.2000000476837158, -0.15000000596046448, 0, 0, 0, 0, 0,
    0.30000001192092896, 0.3499999940395355, 0, 0, 0, 0,
  ];
  assert.deepEqual(Array.from(block), want);
  // piep: (0.9 − 0.1) / 0.2 = 4, the clip's very edge; past it, the clip holds.
  const loud = extrasBlock(rawExtras({ live: { piep: 3, kickF0: -1e6 } }), { mean: MEAN, std: STD }, 0.3);
  assert.equal(loud[2], Math.fround(4 * 0.3));
  assert.equal(loud[1], Math.fround(-4 * 0.3));
  assert.equal(loud[0], 0, "no tempo: centred");

  const bare = extrasBlock(rawExtras({ bpm: 150 }), { mean: MEAN, std: STD }, 0.3);
  const wantBare = [0.01644607074558735, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.30000001192092896];
  assert.deepEqual(Array.from(bare), wantBare, "no summary: centred, and the flag says so");

  // An implausible tempo is absent, not an octave count.
  assert.ok(Number.isNaN(rawExtras({ bpm: 900 })[0]));
  assert.ok(Number.isNaN(rawExtras({ bpm: 0 })[0]));
  assert.equal(rawExtras({ bpm: 240 })[0], 1);
  assert.equal(rawExtras({ bpm: 60 })[0], -1);
});

test("the scaler: over what is present, floored, neutral when nobody has it", () => {
  const rows = [rawExtras({ bpm: 120, live: { piep: 1 } }), rawExtras({ bpm: 240, live: { piep: 1 } }), rawExtras({})];
  const { mean, std } = fitScaler(rows);
  assert.equal(mean[0], 0.5);
  assert.equal(std[0], 0.5);
  const p = EXTRAS.indexOf("piep");
  assert.equal(mean[p], 1);
  assert.equal(std[p], 0.001, "a constant is floored, not divided by zero");
  const k = EXTRAS.indexOf("kickF0");
  assert.equal(mean[k], 0);
  assert.equal(std[k], 1);
});

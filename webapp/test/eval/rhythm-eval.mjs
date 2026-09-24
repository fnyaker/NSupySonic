// How good is the rhythm analysis, on whole records, across genres?
//
//   node test/eval/rhythm-eval.mjs [--only id,id] [--scenario cold,seeded,half,genre]
//                                  [--engine js|wasm|both] [--json out.json]
//
// NOT part of `npm test` — it renders two dozen full tracks and takes minutes.
// It is the instrument the analyser is tuned against: every figure a change
// claims is read off this table, before and after. The records and their
// answer key are test/songs.mjs; the rendered PCM is cached under
// test/eval/.cache (git-ignored) so a second run only pays for the analysis.
//
// SCENARIOS, because the analyser never runs in one situation:
//   cold    nothing is known: no served tempo, no genre. A track nobody has
//           measured, from a server that could not reach Deezer.
//   seeded  the server's figure arrives four seconds in (that is when it lands:
//           it travels behind the audio in the request ladder) with the genre.
//   half    the served figure is HALF the real tempo — what Deezer publishes
//           for a good share of hardcore — and no genre.
//   genre   the genre is known (a tag, the server's style) but no tempo.
//
// METRICS, all standard in the beat-tracking literature except where noted:
//   F70 / F35   beat F-measure at ±70 ms (MIREX) and at ±35 ms — the second is
//               the one an animation needs: 35 ms is about where a flash stops
//               looking like it is ON the beat.
//   off         median signed error of the matched beats, ms (+ = late).
//   tempo       share of scored frames within 4% of the true tempo; `oct` is
//               the share at an octave (x2 or x0.5) instead.
//   lock        seconds until the beats are right and stay right.
//   down        downbeat F-measure, ±70 ms.
//   kick P/R    kick detections against true kicks; main P/R likewise for
//               `mainKick`, which is what most worlds fire on.
//   drop        drops found / drops present, and false drops.
//   brk / bld   mean breakdown / build reading inside the true sections, and
//               (after the slash) in the drops, where it should be ~0.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SONGS, renderSong, SR } from "../songs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const ONLY = opt("only", "")
  .split(",")
  .filter(Boolean);
const SCENARIOS = opt("scenario", "cold,seeded,half,genre").split(",");
const ENGINES = opt("engine", "js") === "both" ? ["js", "wasm"] : [opt("engine", "js")];
const JSON_OUT = opt("json", "");
const SEED_AT = 4;
const SCORE_FROM = 5;

// --- the records, rendered once ------------------------------------------------
const songSrc = readFileSync(join(here, "..", "songs.mjs"), "utf8") + readFileSync(join(here, "..", "synth.mjs"), "utf8");
const songHash = createHash("sha1").update(songSrc).digest("hex").slice(0, 10);

/** Where a record's rendered PCM lives (mono f32, 48 kHz) once loadSong ran. */
export function songFile(def) {
  return join(CACHE, `${def.id}-${songHash}.f32`);
}

export function loadSong(def) {
  mkdirSync(CACHE, { recursive: true });
  const base = join(CACHE, `${def.id}-${songHash}`);
  if (existsSync(base + ".f32") && existsSync(base + ".json")) {
    const raw = readFileSync(base + ".f32");
    const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    return { pcm: new Float32Array(pcm), truth: JSON.parse(readFileSync(base + ".json", "utf8")) };
  }
  const { pcm, truth } = renderSong(def);
  writeFileSync(base + ".f32", Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  writeFileSync(base + ".json", JSON.stringify(truth));
  return { pcm, truth };
}

// --- scoring --------------------------------------------------------------------
function matchEvents(est, ref, tol, from, to) {
  const e = est.filter((t) => t >= from && t <= to);
  const r = ref.filter((t) => t >= from && t <= to);
  const used = new Uint8Array(r.length);
  let tp = 0;
  const errs = [];
  for (const t of e) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < r.length; i++) {
      if (used[i]) continue;
      const d = Math.abs(t - r[i]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0 && bd <= tol) {
      used[best] = 1;
      tp++;
      errs.push(t - r[best]);
    }
  }
  const p = e.length ? tp / e.length : r.length ? 0 : 1;
  const rc = r.length ? tp / r.length : 1;
  const f = p + rc > 0 ? (2 * p * rc) / (p + rc) : 0;
  errs.sort((a, b) => a - b);
  return { p, r: rc, f, n: e.length, ref: r.length, off: errs.length ? errs[errs.length >> 1] * 1000 : NaN };
}

// Seconds until the beat is right and stays right: the first moment after which
// every four-second window scores F35 >= 0.8 (windows with no true beats are
// ignored — a breakdown with the kick out still has beats to predict).
function lockTime(est, ref, end) {
  const step = 0.5;
  let last = 0;
  for (let t = 0; t + 4 <= end; t += step) {
    const m = matchEvents(est, ref, 0.035, t, t + 4);
    if (m.ref > 0 && m.f < 0.8) last = t + 4;
  }
  return last;
}

function sectionMean(series, sections, types, dt) {
  let sum = 0;
  let n = 0;
  for (const s of sections) {
    if (!types.includes(s.type)) continue;
    // Skip the first two seconds of a section: every reading needs a moment.
    const a = Math.floor((s.from + 2) / dt);
    const b = Math.floor(s.to / dt);
    for (let i = a; i < b && i < series.length; i++) {
      sum += series[i];
      n++;
    }
  }
  return n ? sum / n : NaN;
}

export function score(rec, truth) {
  const end = truth.seconds - 1.2;
  const beats70 = matchEvents(rec.beats, truth.beats, 0.07, SCORE_FROM, end);
  const beats35 = matchEvents(rec.beats, truth.beats, 0.035, SCORE_FROM, end);
  const down = matchEvents(rec.downbeats, truth.downbeats, 0.07, SCORE_FROM, end);
  // Kicks: a detection may be up to 30 ms early (the window) or 60 ms late.
  const kick = matchEvents(rec.kicks.map((t) => t - 0.015), truth.kicks, 0.045, SCORE_FROM, end);
  const main = matchEvents(rec.mains.map((t) => t - 0.015), truth.mainKicks, 0.055, SCORE_FROM, end);
  let good = 0;
  let oct = 0;
  let nf = 0;
  for (const [t, bpm] of rec.bpm) {
    if (t < SCORE_FROM + 3) continue;
    nf++;
    const r = bpm / truth.bpm;
    if (Math.abs(r - 1) < 0.04) good++;
    else if (Math.abs(r - 2) < 0.08 || Math.abs(r - 0.5) < 0.02) oct++;
  }
  let dropHit = 0;
  for (const d of truth.drops) if (rec.drops.some((t) => t >= d - 0.3 && t <= d + 60 / truth.bpm * 4)) dropHit++;
  const falseDrops = rec.drops.filter((t) => !truth.drops.some((d) => t >= d - 0.3 && t <= d + 60 / truth.bpm * 4)).length;
  const dt = rec.dt;
  return {
    F70: beats70.f,
    F35: beats35.f,
    off: beats35.off,
    tempo: nf ? good / nf : 0,
    oct: nf ? oct / nf : 0,
    lock: lockTime(rec.beats, truth.beats, end),
    down: down.f,
    kickP: kick.p,
    kickR: kick.r,
    mainP: main.p,
    mainR: main.r,
    drops: `${dropHit}/${truth.drops.length}`,
    falseDrops,
    brk: sectionMean(rec.breakdown, truth.sections, ["breakdown", "break"], dt),
    brkDrop: sectionMean(rec.breakdown, truth.sections, ["drop"], dt),
    bld: sectionMean(rec.build, truth.sections, ["build"], dt),
    bldDrop: sectionMean(rec.build, truth.sections, ["drop"], dt),
    lockedShare: rec.lockedShare,
    confNoBeat: rec.confMean,
  };
}

// --- running an engine ------------------------------------------------------------
async function engineFor(name) {
  if (name === "js") return (await import("./engine-js.mjs")).default;
  return (await import("./engine-wasm.mjs")).default;
}

function scenarioOpts(sc, truth) {
  const genre = truth.genre;
  if (sc === "seeded") return { seed: truth.bpm, seedAt: SEED_AT, genre };
  if (sc === "half") return { seed: truth.bpm / 2, seedAt: SEED_AT };
  if (sc === "genre") return { genre };
  return {};
}

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "  - ");
const pct = (v) => (Number.isFinite(v) ? String(Math.round(v * 100)).padStart(3) : "  -");

async function main() {
  const songs = SONGS.filter((s) => !ONLY.length || ONLY.includes(s.id));
  const results = [];
  for (const engineName of ENGINES) {
    const engine = await engineFor(engineName);
    for (const sc of SCENARIOS) {
      console.log(`\n=== engine ${engineName} · scenario ${sc} ===`);
      console.log(
        "song                  F70 F35  off  tempo oct  lock  down  kickP/R  mainP/R  drops fd   brk/drop   bld/drop"
      );
      const agg = {};
      for (const def of songs) {
        const { pcm, truth } = loadSong(def);
        const t0 = Date.now();
        const rec = await engine.run(pcm, SR, scenarioOpts(sc, truth));
        const ms = Date.now() - t0;
        const s = score(rec, truth);
        results.push({ engine: engineName, scenario: sc, id: def.id, genre: truth.genre, ...s, ms });
        if (def.noBeat) {
          console.log(
            `${def.id.padEnd(20)}  (no beat) locked ${pct(rec.lockedShare)}%  mean conf ${fmt(rec.confMean)}  beats/s ${fmt(rec.beats.length / truth.seconds)}  kicks ${rec.kicks.length}`
          );
          continue;
        }
        for (const k of ["F70", "F35", "tempo", "down", "mainP", "mainR", "kickP", "kickR"]) {
          agg[k] = agg[k] || [];
          if (Number.isFinite(s[k])) agg[k].push(s[k]);
        }
        console.log(
          `${def.id.padEnd(20)} ${pct(s.F70)} ${pct(s.F35)} ${fmt(s.off, 0).padStart(4)}  ${pct(s.tempo)} ${pct(s.oct)}  ${fmt(s.lock, 1).padStart(4)}  ${pct(s.down)}  ${pct(s.kickP)}/${pct(s.kickR)}  ${pct(s.mainP)}/${pct(s.mainR)}  ${s.drops.padStart(4)} ${String(s.falseDrops).padStart(2)}  ${fmt(s.brk)}/${fmt(s.brkDrop)}  ${fmt(s.bld)}/${fmt(s.bldDrop)}   (${ms} ms)`
        );
      }
      const mean = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
      console.log(
        `MEAN                 ${pct(mean(agg.F70))} ${pct(mean(agg.F35))}        ${pct(mean(agg.tempo))}              ${pct(mean(agg.down))}  ${pct(mean(agg.kickP))}/${pct(mean(agg.kickR))}  ${pct(mean(agg.mainP))}/${pct(mean(agg.mainR))}`
      );
    }
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
}

if (process.argv[1] && process.argv[1].endsWith("rhythm-eval.mjs")) main();

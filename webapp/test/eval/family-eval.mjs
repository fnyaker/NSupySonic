// Which genre does the LIVE classifier name, on the arranged records?
//
//   node test/eval/family-eval.mjs                  every record: the family named
//                                                   over the record after 10 s
//   node test/eval/family-eval.mjs --explain <id>   each family's rule on that
//                                                   record, term by term
//   node test/eval/family-eval.mjs --features [ids] the descriptors the rules
//                                                   read, averaged over the drops
//
// NOT part of `npm test`. The analyser runs once per record (the shipped or
// freshly built binary, as the eval picks it) and each frame's descriptors are
// cached under test/eval/.cache; the classifier is then replayed in JavaScript
// from style.js's rules through `ruleWeight` — the evaluator the Rust one is
// held to — with the same smoothing, evidence gate and hysteresis as style.rs.
// Editing a rule costs one replay (seconds), not a re-analysis. The cache key
// includes the rule table, because a confident live family narrows the tempo
// tracker's range and so changes what the descriptors read.
//
// A record counts as right when its own genre (or the family its genre belongs
// to: gabber is hardcore) is the dominant one for most of it.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SONGS, SR } from "../songs.mjs";
import { loadSong } from "./rhythm-eval.mjs";
import engine, { wasmBytes } from "./engine-wasm.mjs";
import * as style from "../../src/lib/audio/style.js";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache");
const { RULE_FEATURES } = style;
const NF = RULE_FEATURES.length;
const FAM = style.familyRules();
const TEMPO_FREE = new Set(["ambient", "strings"]);
const FAMILY_OF = { gabber: ["hardcore"], piano: ["strings", "jazz", "blues"], classical: ["strings"], hiphop: ["hiphop", "rap"], pop: ["pop", "vocalPop"] };
const EVIDENCE_FULL = 0.25; // style.rs
const STRIDE = 4 + NF;

const key = createHash("sha1").update(wasmBytes()).update(JSON.stringify(style.familyTable())).digest("hex").slice(0, 10);

async function series(def) {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, `${def.id}-feat-${key}.f32`);
  if (existsSync(f)) {
    const b = readFileSync(f);
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  }
  const { pcm } = loadSong(def);
  const out = [];
  await engine.run(pcm, SR, {
    onFrame(t, fr, F) {
      const o = F.styleFeat[0];
      out.push(t, fr[F.locked[0]], fr[F.confidence[0]], fr[F.dynamics[0]]);
      for (let i = 0; i < NF; i++) out.push(fr[o + i]);
    },
  });
  const a = Float32Array.from(out);
  writeFileSync(f, Buffer.from(a.buffer));
  return a;
}

function descriptors(a, i, s) {
  for (let k = 0; k < NF; k++) s[RULE_FEATURES[k]] = a[i + 4 + k];
  return s;
}

/** style.rs#process, replayed: the dominant family frame by frame after 10 s. */
function replay(a) {
  const w = new Float64Array(FAM.length);
  let dom = -1;
  let pend = -1;
  let pendSince = 0;
  const count = new Map();
  let n = 0;
  const dt = 512 / SR;
  const s = {};
  for (let i = 0; i < a.length; i += STRIDE) {
    const [t, locked, conf, dyn] = [a[i], a[i + 1], a[i + 2], a[i + 3]];
    descriptors(a, i, s);
    const trust = locked ? Math.min(1, Math.max(0.25, conf * 1.6)) : 0;
    let sum = 0;
    let spec = 0;
    const raw = FAM.map((f) => {
      let v = style.ruleWeight(f.rule, s);
      if (!TEMPO_FREE.has(f.id)) v *= trust;
      sum += v;
      if (f.id !== style.FALLBACK) spec += v;
      return v;
    });
    const a0 = (1 - Math.exp(-dt / 2.5)) * (0.04 + 0.96 * dyn * dyn);
    const al = sum < 1e-4 ? a0 : a0 * Math.max(0.1, Math.min(1, spec / EVIDENCE_FULL));
    for (let k = 0; k < FAM.length; k++) w[k] += ((sum < 1e-4 ? 0 : raw[k] / sum) - w[k]) * al;
    let best = 0;
    for (let k = 1; k < FAM.length; k++) if (w[k] > w[best]) best = k;
    if (dom < 0) dom = best;
    else if (best !== dom && w[best] > w[dom] * 1.2) {
      if (pend !== best) {
        pend = best;
        pendSince = t;
      } else if (t - pendSince > 1.5) {
        dom = best;
        pend = -1;
      }
    } else pend = -1;
    if (t < 10) continue;
    n++;
    count.set(FAM[dom].id, (count.get(FAM[dom].id) || 0) + 1);
  }
  return [...count.entries()].sort((x, y) => y[1] - x[1]).map(([id, c]) => [id, c / n]);
}

async function verdicts() {
  let right = 0;
  for (const def of SONGS) {
    const top = replay(await series(def));
    const ok = (FAMILY_OF[def.genre] || [def.genre]).includes(top[0][0]);
    right += ok;
    console.log(`${ok ? "ok  " : "MISS"} ${def.id.padEnd(18)} ${def.genre.padEnd(10)} ${top.slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}`);
  }
  console.log(`${right}/${SONGS.length} named right`);
}

async function explain(id, top = 8) {
  const def = SONGS.find((x) => x.id === id);
  const a = await series(def);
  const s = {};
  const sums = new Map();
  let n = 0;
  for (let i = 0; i < a.length; i += STRIDE) {
    if (a[i] < 10) continue;
    descriptors(a, i, s);
    const trust = a[i + 1] ? Math.min(1, Math.max(0.25, a[i + 2] * 1.6)) : 0;
    n++;
    for (const f of FAM) {
      const e = sums.get(f.id) || { v: 0, terms: new Array(f.rule.length).fill(0) };
      e.v += style.ruleWeight(f.rule, s) * (TEMPO_FREE.has(f.id) ? 1 : trust);
      f.rule.forEach((t, j) => (e.terms[j] += style.ruleWeight([t], s)));
      sums.set(f.id, e);
    }
  }
  const rows = [...sums.entries()].sort((x, y) => y[1].v - x[1].v).slice(0, top);
  for (const [fid, e] of rows) {
    const f = FAM.find((x) => x.id === fid);
    console.log(`${fid.padEnd(12)} ${(e.v / n).toFixed(3)}   ` + f.rule.map((t, j) => `${t[0]}:${t[1]}=${(e.terms[j] / n).toFixed(2)}`).join("  "));
  }
}

async function features(ids) {
  const show = RULE_FEATURES.filter((k) => !["level", "dyn", "melody", "tonalness", "chord", "centroid"].includes(k));
  console.log("record".padEnd(18) + show.map((k) => k.slice(0, 7).padStart(8)).join(""));
  for (const def of SONGS) {
    if (ids.length && !ids.includes(def.id)) continue;
    const a = await series(def);
    const { truth } = loadSong(def);
    const drops = truth.sections.filter((x) => ["drop", "verse", "chorus"].includes(x.type));
    const inside = (t) => (drops.length ? drops.some((x) => t >= x.from + 2 && t < x.to) : t > 10);
    const sum = new Float64Array(NF);
    let n = 0;
    for (let i = 0; i < a.length; i += STRIDE) {
      if (!inside(a[i])) continue;
      for (let k = 0; k < NF; k++) sum[k] += a[i + 4 + k];
      n++;
    }
    const v = (k) => sum[RULE_FEATURES.indexOf(k)] / Math.max(1, n);
    console.log(def.id.padEnd(18) + show.map((k) => (Math.abs(v(k)) >= 100 ? v(k).toFixed(0) : v(k).toFixed(2)).padStart(8)).join(""));
  }
}

const args = process.argv.slice(2);
if (args[0] === "--explain") await explain(args[1], +(args[2] || 8));
else if (args[0] === "--features") await features((args[1] || "").split(",").filter(Boolean));
else await verdicts();

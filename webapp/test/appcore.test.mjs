// THE APP CORE (webapp/appcore, Rust) against the JavaScript it replaced.
//
// Two halves. The time-sync estimators — the party's clock, the host's line,
// the guest's audio-clock bridge, the output clock — are held to their
// JavaScript oracles (test/reference/sync.js) NUMBER FOR NUMBER, reading for
// reading, on the traces those estimators exist for: a network whose queueing
// is heavy-tailed and asymmetric, a pair of crystals 60 ppm apart, a device
// that slept, a <audio> element read from a jittery timer through seeks and
// stalls, an AudioContext that renders in bursts and steps its mapping. The
// behavioural tests (party.test.mjs, latency.test.mjs) run on the Rust too.
//
// The track index is held to what the lists did — the same rows in the same
// order wherever the old answer was right — and to what they did WRONG: an
// accented capital sorted after "z", and a search typed without accents
// missed every title that had them. And it has to be faster, measured on a
// realistic favourites page, typed into letter by letter.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appCoreFromBytes } from "../src/lib/appcore/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const BYTES = readFileSync(join(here, "../src/lib/appcore/appcore.wasm"));
const core = appCoreFromBytes(BYTES);

let now = 1000; // performance.now(), ms — both sides read the same clock
performance.now = () => now;

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const ref = await import("./reference/sync.js");
const { ClockEstimator, probeSample } = await import("../src/lib/party/clock.js");
const { AnchorFit } = await import("../src/lib/party/anchor.js");
const { makeClockBridge } = await import("../src/lib/party/engine.js");
const L = await import("../src/lib/audio/latency.js");
const { createProjector, fallback } = await import("../src/lib/tracklist.js");

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Equal, or both "no value": the oracles say null where the core says NaN.
function same(a, b, what) {
  if (a == null || b == null) return assert.equal(a ?? null, b ?? null, what);
  assert.ok(a === b, `${what}: ${a} against ${b}`);
}

// --- the binary is the source --------------------------------------------------------------

function sourceHash() {
  const dir = join(here, "../appcore/src");
  const names = readdirSync(dir).filter((n) => n.endsWith(".rs")).sort();
  let h = 0x811c9dc5;
  const eat = (bytes) => {
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  };
  for (const n of names) {
    eat(Buffer.from(n));
    eat(readFileSync(join(dir, n)));
  }
  return h >>> 0;
}

test("the shipped app core is built from the Rust next to it", () => {
  // `>>> 0`: a wasm u32 reaches JavaScript as a signed i32.
  assert.equal(core.x.appcore_src_hash() >>> 0, sourceHash(), "appcore.wasm is stale: run `npm run wasm`");
});

// --- the party clock -------------------------------------------------------------------------

test("clock: the Rust estimator gives the JavaScript's estimate, probe for probe", () => {
  // The probing loop's own rhythm (a burst of twelve 40 ms apart, then one
  // every two seconds), through a network with a long queueing tail on each
  // leg independently, between clocks 60 ppm apart — and in the middle of it
  // the device sleeps and its clock comes back 30 s off. Measured: identical
  // to the bit on all 3 x 400 estimates.
  let compared = 0;
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    const exp = (m) => -Math.log(1 - r()) * m;
    const a = new ref.ClockEstimator();
    const b = new ClockEstimator();
    let local = 5000;
    let step = 0;
    for (let i = 0; i < 400; i++) {
      local += i < 12 ? 40 : 2000;
      if (i === 250) step = 30_000;
      const out = 1.5 + exp(i % 7 === 0 ? 20 : 3);
      const back = 2.5 + exp(3);
      const off = 5000 + 60e-6 * local + step;
      const t1 = local + out + off;
      const t2 = t1 + r() * 0.3;
      const t3 = local + out + back + (t2 - t1);
      const s = probeSample(local, t1, t2, t3);
      a.add(s);
      b.add(s);
      for (const at of [t3, t3 + 700]) {
        const ea = a.estimate(at);
        const eb = b.estimate(at);
        assert.equal(!!eb, !!ea, `seed ${seed} probe ${i}: an estimate on one side only`);
        if (!ea) continue;
        for (const k of ["offset", "rtt", "spread", "n"]) same(eb[k], ea[k], `seed ${seed} probe ${i} ${k}`);
        compared++;
      }
    }
    b.free();
  }
  assert.ok(compared > 2000, `${compared} estimates`);
});

test("clock: the Rust estimator refuses what the JavaScript refused", () => {
  const a = new ref.ClockEstimator();
  const b = new ClockEstimator();
  for (const s of [
    { at: 1, rtt: NaN, offset: 3 },
    { at: 1, rtt: -1, offset: 3 },
    { at: 1, rtt: 4, offset: Infinity },
    null,
  ]) {
    a.add(s);
    b.add(s);
  }
  assert.equal(a.estimate(10), null);
  assert.equal(b.estimate(10), null);
  assert.equal(b.size, 0);
  b.free();
  assert.equal(b.estimate(10), null, "a freed estimator answers nothing");
});

// --- the host's line ---------------------------------------------------------------------------

test("anchor: the Rust line is the JavaScript's, reading for reading", () => {
  // A currentTime that steps per 10 ms callback, read from a 250 ms timer
  // that fires up to 12 ms late; a seek, a stall that cost 300 ms, a restart.
  const r = rng(7);
  const a = new ref.AnchorFit();
  const b = new AnchorFit();
  let pos = 42;
  let t = 5000;
  for (let i = 0; i < 600; i++) {
    const dt = 250 + r() * 12;
    t += dt;
    pos += dt / 1000;
    if (i === 100) pos = 180;
    if (i === 300) pos -= 0.3;
    if (i === 450) pos = 0;
    const reported = Math.floor(pos * 100) / 100;
    assert.equal(b.add(t, reported), a.add(t, reported), `reading ${i}`);
    assert.equal(b.n, a.cs.length);
    same(b.positionAt(t + 5), a.positionAt(t + 5), `reading ${i}`);
    if (i % 97 === 0) {
      a.reset();
      b.reset();
    }
  }
  b.free();
});

// --- a guest's audio clock ------------------------------------------------------------------

// An AudioContext that renders in bursts and whose output mapping steps and
// drifts, as Chromium's does (latency.test.mjs measured and modelled it).
function burstyCtx(d, { timestamps = true } = {}) {
  const OUT = 0.072;
  const BASE = 0.0232;
  const heard = () => now / 1000 + ctx.d;
  const burst = () => Math.floor((heard() + OUT) / BASE);
  const ctx = {
    d,
    state: "running",
    outputLatency: OUT,
    baseLatency: BASE,
    get currentTime() {
      return (burst() + 1) * BASE;
    },
  };
  if (timestamps)
    ctx.getOutputTimestamp = () => {
      const contextTime = burst() * BASE - OUT;
      return { contextTime, performanceTime: (contextTime - ctx.d) * 1000 };
    };
  return ctx;
}

test("bridge: the Rust mapping is the JavaScript's, on the guest's own timers", () => {
  // Sampled every 50 ms for five minutes (the guest's rhythm), through two
  // steps of a whole burst, a single wild reading, a slow drift, and a context
  // with no output timestamp at all. Every answer the scheduler reads is
  // compared after every reading.
  for (const timestamps of [true, false]) {
    const ctx = burstyCtx(-0.4, { timestamps });
    const off = { v: null };
    const a = ref.makeClockBridge(ctx, () => off.v, () => 12, 0.003);
    const b = makeClockBridge(ctx, () => off.v, () => 12, 0.003);
    now = 10_000;
    const r = rng(timestamps ? 5 : 6);
    for (let i = 0; i < 6000; i++) {
      now += 50 + r() * 4;
      if (i === 40) off.v = 1234.5;
      if (i === 1500) ctx.d += 0.0232;
      if (i === 3000) ctx.d -= 0.02;
      if (i > 3500) ctx.d += 2e-7;
      const saved = ctx.d;
      if (i === 2200) ctx.d += 0.5; // one wild reading
      same(b.sample(), a.sample(), `${timestamps} reading ${i}: moved`);
      ctx.d = saved;
      same(b.ready, a.ready, `${timestamps} reading ${i}: ready`);
      same(b.serverNow(), a.serverNow(), `${timestamps} reading ${i}: serverNow`);
      same(b.toCtx(now + 5000), a.toCtx(now + 5000), `${timestamps} reading ${i}: toCtx`);
      same(b.outputLag(), a.outputLag(), `${timestamps} reading ${i}: outputLag`);
    }
    b.free();
  }
});

// --- the output clock -------------------------------------------------------------------------

test("output clock: the Rust median is the JavaScript's, frame for frame", () => {
  // The engine's rhythm — three reads per render, the first seeing a new
  // timestamp — through a step of one burst, a slow drift, a single wild
  // reading, a second context replacing the first, and the lag record read on
  // its own timer. Every output is compared after every read.
  const o = ref.createOutputClock();
  const ctxs = [burstyCtx(-0.3), burstyCtx(0.8, { timestamps: false })];
  let ctx = ctxs[0];
  now = 50_000;
  for (let i = 0; i < 9000; i++) {
    now += 7 + (i % 3);
    if (i === 3000) ctx.d += 0.0232;
    if (i > 4000 && i < 5000) ctx.d += 1e-7;
    if (i === 6000) ctx = ctxs[1];
    const saved = ctx.d;
    if (i === 2000) ctx.d += 0.3;
    L.sampleOutputClock(ctx);
    o.sampleOutputClock(ctx);
    ctx.d = saved;
    if (i % 5 === 0) {
      L.noteContextLag(ctx);
      o.noteContextLag(ctx);
    }
    const where = `read ${i}`;
    same(L.heardContextTime(now), o.heardContextTime(now), `${where}: heard`);
    same(L.outputClockReady(), o.outputClockReady(), `${where}: ready`);
    same(L.outputClockGeneration(), o.outputClockGeneration(), `${where}: generation`);
    same(L.outputLag(ctx), o.outputLag(ctx), `${where}: lag`);
    same(L.contextLagNow(ctx, now), o.contextLagNow(ctx, now), `${where}: lag now`);
  }
});

test("the estimators cost less than the JavaScript they replaced", () => {
  // Measured on this suite's machine (V8, the shipped binary): an estimate of
  // a full 64-probe clock, the host's four readings a second, the guest's
  // twenty bridge readings a second. What the numbers are FOR is the garbage:
  // the JavaScript built 4-6 arrays per call, the Rust builds none.
  const r = rng(3);
  const mk = (E) => {
    const e = new E();
    for (let i = 0; i < 64; i++) e.add(probeSample(i * 2000, i * 2000 + 5000 + r(), i * 2000 + 5000 + r(), i * 2000 + 4 + r() * 3));
    return e;
  };
  const a = mk(ref.ClockEstimator);
  const b = mk(ClockEstimator);
  const time = (fn, n) => {
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < n; i++) fn(i);
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / n);
    }
    return best / 1000; // us
  };
  let sink = 0;
  const js = time((i) => (sink += a.estimate(128_000 + i).offset), 20_000);
  const rs = time((i) => (sink += b.estimate(128_000 + i).offset), 20_000);
  const fa = new ref.AnchorFit();
  const fb = new AnchorFit();
  const jsFit = time((i) => {
    fa.add(i * 250, i * 0.25);
    sink += fa.positionAt(i * 250);
  }, 50_000);
  const rsFit = time((i) => {
    fb.add(i * 250, i * 0.25);
    sink += fb.positionAt(i * 250);
  }, 50_000);
  console.log(`# clock estimate ${js.toFixed(2)} -> ${rs.toFixed(2)} us; anchor add+read ${jsFit.toFixed(2)} -> ${rsFit.toFixed(2)} us (${sink > 0})`);
  assert.ok(rs < js, `the Rust estimate (${rs} us) is not cheaper than the JavaScript (${js} us)`);
  assert.ok(rsFit < jsFit, `the Rust line (${rsFit} us) is not cheaper than the JavaScript (${jsFit} us)`);
  b.free();
  fb.free();
});

// --- the track index -------------------------------------------------------------------------

// A favourites page as a French listener's actually reads: accented names in
// both cases, ligatures, featured artists, the same title by several artists,
// albums missing, durations and dates repeated.
const ARTISTS = [
  "Édith Piaf", "Stromae", "Mylène Farmer", "Céline Dion", "Beyoncé", "Björk", "Sigur Rós", "Motörhead",
  "Zazie", "Angèle", "Orelsan", "Æther", "Œil de Lynx", "Daft Punk", "Justice", "Ninho", "PNL", "Aya Nakamura",
  "Clara Luciani", "Hervé", "Jul", "Damsö", "Ibeyi", "Mötley Crüe", "Dvořák", "Łona", "Straße 7",
];
const WORDS = [
  "Été", "amour", "Nuit", "l'été indien", "Don’t Stop", "ça ira", "Où es-tu", "Cœur", "Étoile", "zéro", "Alors on danse",
  "Papaoutai", "Désenchantée", "À la folie", "encore", "Ève", "Île", "Rêve", "ÉCHO", "façade", "naïf", "Noël", "oui",
];
function library(n, seed = 9) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const main = pick(ARTISTS);
    const feat = r() < 0.2 ? [pick(ARTISTS)] : [];
    const title = `${pick(WORDS)}${r() < 0.5 ? " " + pick(WORDS).toLowerCase() : ""}${r() < 0.1 ? " (feat. " + pick(ARTISTS) + ")" : ""}`;
    out.push({
      deezer_id: String(100000 + i),
      title,
      artist: { name: main },
      artists: [{ name: main, role: "Main" }, ...feat.map((name) => ({ name, role: "Featured" }))],
      album: r() < 0.05 ? null : { title: `${pick(WORDS)} ${Math.floor(r() * 20)}` },
      duration: 60 + Math.floor(r() * 300),
      added: 1_600_000_000 + Math.floor(r() * 200) * 86_400,
    });
  }
  return out;
}

// The model of what the index is meant to do, written the obvious way:
// Unicode's own decomposition, marks stripped, the ligatures spelled out.
const LIG = { œ: "oe", æ: "ae", ß: "ss", ø: "o", ł: "l", đ: "d", þ: "th", ð: "d", ı: "i", "’": "'", "‘": "'" };
const fold = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[œæßøłđþðı’‘]/g, (c) => LIG[c]);
function model(list, sort, dir, query) {
  const q = fold(query.trim());
  const names = (t) => t.artists.map((a) => a.name).join(" ");
  let rows = list.map((t, i) => ({ t, i }));
  if (q) rows = rows.filter(({ t }) => [fold(t.title), fold(names(t)), fold(t.album?.title)].some((f) => f.includes(q)));
  const key = {
    title: (t) => fold(t.title),
    artist: (t) => fold(t.artist?.name),
    album: (t) => fold(t.album?.title),
    duration: (t) => t.duration,
    added: (t) => t.added,
  }[sort];
  if (key)
    rows.sort((a, b) => {
      const ka = key(a.t);
      const kb = key(b.t);
      const c = ka < kb ? -1 : ka > kb ? 1 : 0;
      return (dir === -1 ? -c : c) || a.i - b.i;
    });
  else if (dir === -1) rows.reverse();
  return rows.map((x) => x.t);
}

test("lists: search and sort answer what the model says, on every sort and query", () => {
  const list = library(1500);
  const project = createProjector();
  const queries = ["", "e", "ete", "ÉTÉ", "beyonce", "BJORK", "coeur", "oeil", "strasse", "dont stop", "don't", "feat", "zero 1", "motley crue", "dvorak", "lona", "xyzzy"];
  for (const sort of ["default", "title", "artist", "album", "duration", "added"])
    for (const dir of [1, -1])
      for (const q of queries) {
        const got = project(list, sort, dir, q);
        const want = model(list, sort, dir, q);
        assert.equal(got.length, want.length, `${sort} ${dir} "${q}": ${got.length} rows against ${want.length}`);
        for (let i = 0; i < want.length; i++) assert.equal(got[i], want[i], `${sort} ${dir} "${q}": row ${i}`);
      }
  project.free();
});

test("lists: what the old lists got wrong is right", () => {
  const list = [
    { title: "Zazie", artist: { name: "Z" }, album: { title: "a" } },
    { title: "Été indien", artist: { name: "Joe Dassin" }, album: { title: "b" } },
    { title: "Alors on danse", artist: { name: "Stromae" }, album: { title: "c" } },
    { title: "Halo", artist: { name: "Beyoncé" }, artists: [{ name: "Beyoncé" }], album: { title: "I Am… Sasha Fierce" } },
  ];
  const project = createProjector();
  // The old comparison of UTF-16 units put "Été" after "Zazie".
  assert.deepEqual(project(list, "title", 1, "").map((t) => t.title), ["Alors on danse", "Été indien", "Halo", "Zazie"]);
  // ...and a search typed without the accent found nothing.
  assert.deepEqual(project(list, "default", 1, "beyonce").map((t) => t.title), ["Halo"]);
  assert.deepEqual(project(list, "default", 1, "ete").map((t) => t.title), ["Été indien"]);
  // The plain view is the list itself, untouched.
  assert.equal(project(list, "default", 1, "  "), list);
  project.free();
});

test("lists: a list is indexed once, and a keystroke costs a fraction of what it did", () => {
  // A 4 000-track favourites page, "beyonce" typed one letter at a time, then
  // the sort changed while the query stands, then the query cleared — what a
  // person does. The old path (the fallback, which is the code the lists
  // used to run) against the index, the index's one-off build included.
  const list = library(4000, 21);
  const typed = [];
  for (const w of ["beyonce", "stromae ete"]) for (let i = 1; i <= w.length; i++) typed.push(w.slice(0, i));
  const session = (project) => {
    let n = 0;
    for (const q of typed) n += project(list, "default", 1, q).length;
    for (const sort of ["title", "artist", "album", "added"]) n += project(list, sort, 1, "e").length;
    n += project(list, "title", -1, "").length;
    return n;
  };
  const time = (fn) => {
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = process.hrtime.bigint();
      fn();
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return best;
  };
  // The fallback is the old lists' code, verbatim.
  let jsN = 0;
  const js = time(() => {
    jsN = session((l, s, d, q) => (!q.trim() && s === "default" ? (d === -1 ? l.slice().reverse() : l) : fallback(l, s, d, q.trim())));
  });
  let rsN = 0;
  const rs = time(() => {
    const p = createProjector(); // a fresh index each time: the build is paid for
    rsN = session(p);
    p.free();
  });
  console.log(`# 4000 tracks, ${typed.length} keystrokes + 5 sorts: old lists ${js.toFixed(1)} ms, index ${rs.toFixed(1)} ms (build included)`);
  assert.ok(rsN > 0 && jsN > 0);
  assert.ok(rs < js / 2, `the index (${rs.toFixed(1)} ms) is not clearly faster than the old lists (${js.toFixed(1)} ms)`);
});

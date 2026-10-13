// The studio's ranking of the vocabulary (lib/genre/rank.js) and the
// training's self-checks (lib/genre/health.js), the latter driven through the
// shipped trainer on data built to have exactly the fault each check names.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rankTags, searchTags, fold } from "../src/lib/genre/rank.js";
import { prepare, canGroup, assess, suspects, vectorKey, MIN_EXAMPLES } from "../src/lib/genre/health.js";
import { loadTrainer, trainOn } from "../src/lib/genre/core.js";

const here = dirname(fileURLToPath(import.meta.url));
const X = await loadTrainer(readFileSync(join(here, "../src/lib/genre/trainer-simd.wasm")));

const T = (id, name) => ({ id, name, color: null });
const vocab = [T(1, "Acid"), T(2, "Frenchcore"), T(3, "Uptempo"), T(4, "Hardcore"), T(5, "Écossais"), T(6, "Zaag")];

test("the vocabulary follows the track's scores, then use, never the alphabet", () => {
  const r = rankTags(vocab, [["Uptempo", 0.7, 0.8, 0.4], ["Frenchcore", 0.2, 0.15, 0.35]], { Zaag: 12, Acid: 3 });
  assert.deepEqual(
    r.map((x) => x.tag.name),
    ["Uptempo", "Frenchcore", "Zaag", "Acid", "Écossais", "Hardcore"]
  );
  assert.equal(r[0].head, 0.8);
  assert.equal(r[2].score, null);
});

test("with no opinion at all the most used genres open the list", () => {
  const r = rankTags(vocab, [], { Hardcore: 40, Frenchcore: 9 });
  assert.deepEqual(r.slice(0, 2).map((x) => x.tag.name), ["Hardcore", "Frenchcore"]);
});

test("search folds accents and keeps the rank order inside each tier", () => {
  const r = rankTags(vocab, [["Hardcore", 0.6, 0.6, null], ["Frenchcore", 0.3, 0.3, null]]);
  assert.deepEqual(searchTags(r, "ecos").map((x) => x.tag.name), ["Écossais"]);
  // Both are "core" from the inside; the likelier comes first.
  assert.deepEqual(searchTags(r, "core").map((x) => x.tag.name), ["Hardcore", "Frenchcore"]);
  // A word start beats a match inside a word.
  const r2 = rankTags([T(1, "Hard techno"), T(2, "Techno")], [["Hard techno", 0.9, 0.9, null]]);
  assert.deepEqual(searchTags(r2, "techno").map((x) => x.tag.name), ["Techno", "Hard techno"]);
  assert.equal(fold("Deutscher-Krach "), "deutscher krach");
});

// --- preparation ---------------------------------------------------------------

const row = (label, artist, key) => ({ label, artist, key });

test("a genre under the minimum is left out, and said so", () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(row("A", "a" + (i % 4), i));
  for (let i = 0; i < MIN_EXAMPLES - 1; i++) rows.push(row("B", "b" + i, 100 + i));
  const p = prepare(rows);
  assert.deepEqual(p.excluded, ["B"]);
  assert.equal(p.keep.length, 8);
  assert.match(p.done.join(" "), /B pas encore appris/);
});

test("the same recording twice keeps one copy; tagged two ways, neither", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(row("A", "a" + i, i));
  for (let i = 0; i < 6; i++) rows.push(row("B", "b" + i, 50 + i));
  rows.push(row("A", "a0", 0)); // duplicate, same label
  rows.push(row("B", "x", 3)); // the same sound as an A row, labelled B
  const p = prepare(rows);
  assert.equal(p.conflicts.length, 1);
  assert.ok(!p.keep.includes(3) && !p.keep.includes(13), "both sides of the conflict dropped");
  assert.ok(!p.keep.includes(12), "the second copy dropped");
  assert.match(p.done.join(" "), /1 doublon/);
});

test("one artist cannot make up most of a genre", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row("A", "solo", i));
  for (let i = 0; i < 5; i++) rows.push(row("A", "other" + i, 100 + i));
  for (let i = 0; i < 10; i++) rows.push(row("B", "b" + (i % 5), 200 + i));
  const p = prepare(rows);
  const kept = p.keep.filter((i) => rows[i].artist === "solo").length;
  // 40% of A's 25 tracks, rounded up: 10.
  assert.equal(kept, 10);
  assert.equal(p.capped.A, 10);
  // The newest are the ones kept (rows come newest first).
  assert.deepEqual(p.keep.filter((i) => rows[i].artist === "solo"), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("whole artists are held out only when most genres have two", () => {
  const two = [row("A", "a", 0), row("A", "b", 1), row("B", "c", 2), row("B", "d", 3)];
  assert.equal(canGroup(two, [0, 1, 2, 3]), true);
  const one = [row("A", "a", 0), row("A", "a", 1), row("B", "c", 2), row("B", "d", 3)];
  assert.equal(canGroup(one, [0, 1, 2, 3]), false);
});

test("a vector's key is stable and tells different recordings apart", () => {
  const a = Float32Array.from({ length: 200 }, (_, i) => Math.sin(i));
  const b = a.map((v, i) => (i === 7 ? v + 0.05 : v));
  assert.equal(vectorKey(a), vectorKey(a.slice()));
  assert.notEqual(vectorKey(a), vectorKey(b));
});

// --- the verdict, on real training runs ------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// `per` tracks for each of `c` genres from `artists` artists. Each artist has
// its own offset (its production); `genre` scales how far apart the genres
// themselves are. genre 0 = only the artists separate anything.
function library({ c = 4, per = 24, artists = 4, d = 64, genre = 1, artist = 0.3, noise = 0.3, seed = 1 }) {
  const r = rng(seed);
  const g = () => r() * 2 - 1;
  const centres = Array.from({ length: c }, () => Float32Array.from({ length: d }, g));
  const prod = Array.from({ length: c * artists }, () => Float32Array.from({ length: d }, g));
  const n = c * per;
  const Xs = new Float32Array(n * d);
  const y = new Int32Array(n);
  const groups = new Int32Array(n);
  for (let k = 0; k < c; k++)
    for (let j = 0; j < per; j++) {
      const i = k * per + j;
      const a = k * artists + (j % artists);
      for (let t = 0; t < d; t++) Xs[i * d + t] = genre * centres[k][t] + artist * prod[a][t] + noise * g();
      y[i] = k;
      groups[i] = a;
    }
  return { X: Xs, y, groups, n, d, labels: Array.from({ length: c }, (_, k) => "G" + k) };
}

globalThis.__log = (...a) => process.env.SHOW && console.log(...a);
const run = (data, grouped, mode = "linear", extra = {}) =>
  trainOn(X, { ...data, X: data.X.slice(), y: data.y.slice(), groups: data.groups.slice() }, mode, { seed: 7, grouped, proj: 0, ...extra });

test("separable genres: a good verdict, no gap", () => {
  const data = library({});
  const h = run(data, true);
  __log("separable", h.metrics.fitBalanced, h.metrics.balanced); // measured 1.000 / 1.000
  assert.ok(h.metrics.fitBalanced - h.metrics.balanced < 0.05, `gap ${h.metrics.fitBalanced} - ${h.metrics.balanced}`);
  const v = assess(h.metrics, { stratified: run(data, false).metrics.balanced });
  assert.equal(v.level, "good", JSON.stringify(v));
});

test("genres that are really artists: the artist bias is named", () => {
  // No genre signal at all, strong artist signal: ordinary folds let an
  // artist's other tracks give the answer away; artist folds cannot.
  const data = library({ genre: 0, artist: 1.5, noise: 0.2 });
  const grouped = run(data, true);
  const strat = run(data, false);
  __log("artists", strat.metrics.balanced, grouped.metrics.balanced); // measured 1.000 / 0.177
  assert.ok(strat.metrics.balanced > 0.9, `stratified ${strat.metrics.balanced}`);
  assert.ok(grouped.metrics.balanced < 0.5, `grouped ${grouped.metrics.balanced}`);
  const v = assess(grouped.metrics, { stratified: strat.metrics.balanced });
  assert.ok(v.issues.some((i) => i.code === "artist"), JSON.stringify(v.issues));
  assert.equal(v.level, "poor");
});

test("labels unrelated to the audio: memorising is caught", () => {
  const data = library({ genre: 0, artist: 0, noise: 1, d: 256, per: 12 });
  const r = rng(3);
  for (let i = data.n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [data.y[i], data.y[j]] = [data.y[j], data.y[i]];
  }
  const h = run(data, false, "linear", { epochs: 80 });
  __log("random", h.metrics.fitBalanced, h.metrics.balanced); // measured 1.000 / 0.208 (chance 0.25)
  const v = assess(h.metrics, {});
  assert.ok(v.issues.some((i) => i.code === "overfit"), JSON.stringify(v.issues));
  assert.equal(v.level, "poor");
});

test("a mislabelled track is pointed at", () => {
  const data = library({ noise: 0.2 });
  // Track 5 is a G0 track, labelled G2.
  data.y[5] = 2;
  const h = run(data, false);
  const s = suspects(h.heldProbs, data.y, data.labels);
  // measured: row 5 alone, own label 0.000, G0 1.000
  __log("suspects", s.map((x) => [x.row, x.own.toFixed(3), x.other.toFixed(3)]));
  assert.ok(s.some((x) => x.row === 5 && x.predicted === "G0"), JSON.stringify(s.slice(0, 3)));
  assert.ok(s.length <= 3, `${s.length} flagged — only the planted one should stand out`);
});

test("the verdict says at most three things", () => {
  const m = {
    balanced: 0.5,
    fitBalanced: 1,
    grouped: true,
    perClass: [
      { label: "A", recall: 0.2, artists: 1 },
      { label: "B", recall: 0.3, artists: 3 },
    ],
  };
  const v = assess(m, { stratified: 0.9, suspects: [{}], prep: { conflicts: [[1, 2]], done: [] } });
  assert.equal(v.issues.length, 3);
  assert.ok(v.more >= 2);
  assert.equal(v.issues[0].severity, "bad");
});

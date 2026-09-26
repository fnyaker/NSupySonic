// The served verdict on the FIRST play of a track.
//
// The server measures the archived file, and the first play is what archives
// it, so until then all it can serve is Deezer's published tempo, flagged
// `provisional` (supysonic/deezer/analysis.py#tempo_hints). The rules this pins
// are the ones that decide whether that tempo reaches the tracker at all, and
// whether the measured verdict still replaces it:
//
//   - the published tempo is taken the moment it is served, and announced, so
//     the tracker starts on it mid-track;
//   - the id stays on the poll after that, although the server cannot name it
//     as pending (it does not know the archive is coming), and the measured
//     verdict replaces the provisional one when it lands;
//   - a provisional verdict that is never replaced is KEPT when the polls run
//     out, and a later play asks again, but not more than every ten minutes.
//
// The server here is a script of what the real one answers, poll by poll. Time
// is node's mock clock, so the widening poll delays cost nothing.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

const disk = new Map();
globalThis.localStorage = {
  getItem: (k) => disk.get(k) ?? null,
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: (k) => disk.delete(k),
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { hash: "" } };

// id -> (nth time this id is asked about) -> { verdict?, pending? }
const script = new Map();
const asked = new Map();
globalThis.fetch = async (_url, opts) => {
  const { ids } = JSON.parse(opts.body);
  const analyses = {};
  const pending = [];
  for (const id of ids) {
    const n = asked.get(id) || 0;
    asked.set(id, n + 1);
    const r = script.get(id)?.(n) || {};
    if (r.verdict) analyses[id] = r.verdict;
    if (r.pending) pending.push(id);
  }
  return { ok: true, status: 200, json: async () => ({ analyses, pending }) };
};

mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_780_000_000_000 });
const { knownAnalysis, onAnalysis, primeAnalyses } = await import("../src/lib/analysis.js");

const heard = [];
onAnalysis((id, v) => heard.push([id, v.bpm, !!v.provisional]));

// Let the fetch → json → then chains run between ticks.
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function advance(ms) {
  for (let t = 0; t < ms; t += 250) {
    mock.timers.tick(250);
    await settle();
  }
}

const published = (bpm) => ({ bpm, bpmConfidence: 0.8, bpmSource: "deezer", style: null, provisional: true });
const measured = (bpm, style) => ({ bpm, bpmConfidence: 0.8, bpmSource: "deezer+octave", style, styleLabel: style });

test("a first play gets the published tempo, then the measured verdict replaces it", async () => {
  const id = "3001";
  // Ask 0: nothing yet, the lookup is running. Asks 1-2: the published figure
  // (Deezer lists this frenchcore track at half, as it often does), and the
  // server does NOT list the id as pending — it cannot see the archive
  // coming. Ask 3: the archive landed and was measured.
  script.set(id, (n) =>
    n === 0 ? { pending: true } : n < 3 ? { verdict: published(100) } : { verdict: measured(200, "frenchcore") }
  );
  heard.length = 0;
  primeAnalyses([id]);
  await settle();
  assert.equal(knownAnalysis(id), null, "nothing to serve on the first ask");

  await advance(1500);
  assert.equal(knownAnalysis(id)?.bpm, 100);
  assert.equal(knownAnalysis(id)?.provisional, true);
  assert.deepEqual(heard, [[id, 100, true]], "announced, so the tracker is seeded mid-track");

  // Kept on the poll although the server named nothing pending, until the
  // measured verdict lands — and then no further question is asked about it.
  await advance(3000 + 6000);
  assert.equal(knownAnalysis(id)?.bpm, 200);
  assert.equal(knownAnalysis(id)?.provisional, undefined);
  assert.deepEqual(heard, [[id, 100, true], [id, 200, false]], "an unchanged answer is not re-announced");
  const before = asked.get(id);
  await advance(60000);
  assert.equal(asked.get(id), before, "a measured verdict ends the polling");

  // ...and a later play does not ask about it again.
  primeAnalyses([id]);
  await settle();
  assert.equal(asked.get(id), before);
});

test("a provisional verdict that is never replaced is kept, and re-asked at most every ten minutes", async () => {
  const id = "3002";
  script.set(id, () => ({ verdict: published(140) }));
  heard.length = 0;
  primeAnalyses([id]);
  await settle();
  assert.equal(knownAnalysis(id)?.bpm, 140);

  // The polls run out; the published tempo is not forgotten.
  await advance(1500 + 3000 + 6000 + 12000 + 25000 + 25000);
  const polls = asked.get(id);
  assert.equal(polls, 7, "the first ask and six polls over 72 s, then it stops");
  assert.equal(knownAnalysis(id)?.bpm, 140);
  await advance(60000);
  assert.equal(asked.get(id), polls);

  // A replay inside ten minutes answers from the cache...
  primeAnalyses([id]);
  await settle();
  assert.equal(asked.get(id), polls);
  // ...and one ten minutes after the last provisional answer asks the server
  // again for the measured verdict.
  await advance(10 * 60 * 1000 + 1000);
  primeAnalyses([id]);
  await settle();
  assert.equal(asked.get(id), polls + 1);
  // It is persisted too, so the next session starts on it before any request.
  await advance(6000);
  assert.ok(String(disk.get("audio.analysis")).includes('"3002"'));
});

test("a track with no published tempo and nothing to measure is asked about once", async () => {
  const id = "3003";
  script.set(id, () => ({}));
  primeAnalyses([id]);
  await settle();
  await advance(60000);
  assert.equal(knownAnalysis(id), null);
  primeAnalyses([id]);
  await settle();
  assert.equal(asked.get(id), 1, "a miss is remembered: no poll, no second ask this session");
});

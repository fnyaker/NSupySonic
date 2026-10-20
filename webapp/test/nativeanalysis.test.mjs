// The animations on the Android app's own player (lot N5): the app runs the
// rhythm analyser on the PCM ExoPlayer plays (NativeAnalysis.kt) and posts its
// frames, each stamped with the MEDIA time its audio starts at; the engine
// (lib/audio/engine.js) holds each one until the player's own clock reaches it.
// Here the app is played by the shipped rhythm.wasm itself, on an arranged
// record, batched the way NativeAnalysis.kt batches, running ahead of the clock
// by a sink's buffer — and the engine must hand every frame out on time, read
// the tempo, forget a seek's leftovers, and send the effects to the app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { addEventListener() {}, location: { href: "http://srv/app/", hash: "", origin: "http://srv" } };
globalThis.document = { addEventListener() {}, visibilityState: "visible", hidden: false };
globalThis.location = globalThis.window.location;
globalThis.fetch = async () => new Response("", { status: 404 });
let clock = 1000; // the page's clock, ms
globalThis.performance = { now: () => clock };

// The app: bridge 6, recording what the page sends.
const sent = { analysis: [], fx: [], cmds: [] };
let nextId = 1;
window.NSNative = {
  bridgeVersion: () => 6,
  nativeAudio: () => true,
  naCreate: () => nextId++,
  naCmd: (id, json) => sent.cmds.push({ id, ...JSON.parse(json) }),
  naAnalysisAvailable: () => true,
  naAnalysis: (json) => sent.analysis.push(JSON.parse(json)),
  naFx: (json) => sent.fx.push(JSON.parse(json)),
};

const { get } = await import("svelte/store");
const S = await import("../src/lib/stores.js");
const N = await import("../src/lib/audio/nativeplayer.js");
const E = await import("../src/lib/audio/engine.js");
const { Rhythm } = await import("../src/lib/audio/rhythm-core.js");
const { familyTable } = await import("../src/lib/audio/style.js");
const { SONG_BY_ID, SR } = await import("./songs.mjs");
const { loadSong } = await import("./eval/rhythm-eval.mjs");

const RHYTHM = new WebAssembly.Module(readFileSync(new URL("../src/lib/audio/rhythm.wasm", import.meta.url)));
const tick = () => new Promise((r) => setTimeout(r, 0));
const lastGen = () => {
  for (let i = sent.analysis.length - 1; i >= 0; i--) {
    const m = sent.analysis[i];
    if (m.t === "reset" || m.t === "start") return m.gen;
  }
  return 0;
};

/** NativeAnalysis.kt on a record: frames with their media times, batched. */
function appAnalyser(id, seconds) {
  const { pcm } = loadSong(SONG_BY_ID.get(id));
  const src = pcm.subarray(0, seconds * SR);
  const r = Rhythm.fromModule(RHYTHM, SR);
  r.loadFamilies(familyTable());
  r.setLevel(1);
  r.setClassify(false);
  r.setLiveRange(false);
  const F = r.layout.fields;
  const frames = [];
  for (let i = 0; i < src.length; i += 2048) {
    const n = r.push(src.subarray(i, Math.min(src.length, i + 2048)));
    for (let k = 0; k < n; k++) {
      const f = r.frame(k).slice();
      frames.push({ f, mt: (f[F.frame[0]] * r.hop) / SR });
    }
  }
  return { r, frames, ready: { t: "ready", layout: r.layoutText, hop: r.hop, lookahead: r.lookahead, frameLen: r.frameLen, sampleRate: SR } };
}

function batch(el, frames, gen) {
  const L = frames[0].f.length;
  const all = new Float32Array(frames.length * L);
  frames.forEach((x, i) => all.set(x.f, i * L));
  const b = Buffer.from(all.buffer).toString("base64");
  return { t: "f", gen, el: el._id, n: frames.length, b, mt: frames.map((x) => Math.round(x.mt * 1e5) / 1e5) };
}

// The player's clock: what NativeAudio.kt reports (position, playing).
function at(el, t) {
  clock += 0; // the report and the page clock move together
  window.__nsAudio(el._id, { c: el._seq, st: 3, p: true, t, b: t + 5, sk: true, d: 600 });
}

test("the app's frames are handed out when the player's clock reaches them", async () => {
  S.nativePlayer.set(true);
  assert.equal(N.nativeDspAvailable(), true);
  S.player.playQueue([{ id: "00000000-0000-4000-8000-000000000001", title: "Techno", duration: 600 }]);
  const el = N.createNativeElement();
  el.src = "/api/stream/x";
  el.load();
  el.play().catch(() => {});
  at(el, 0);

  const got = [];
  const unsub = E.subscribeFrames((f) => got.push({ ctxT: f.ctxT, heard: el.currentTime, bpm: f.beat?.bpm, locked: f.beat?.locked }), E.LEVEL.RHYTHM);
  const start = sent.analysis.find((m) => m.t === "start");
  assert.ok(start, "the engine asks the app to analyse");
  assert.equal(start.level, 1);
  assert.equal(start.families.length, familyTable().length, "with the family table the worklet gets");

  const { frames, ready } = appAnalyser("techno-132", 20);
  window.__nsFrames(ready);
  // The sink runs ~0.5 s ahead of what is heard; batches of 16, as the app sends.
  let sentTo = 0;
  const AHEAD = 0.5;
  for (let t = 0; t <= 19; t += 0.04) {
    clock += 40;
    at(el, t);
    const batchUp = [];
    while (sentTo < frames.length && frames[sentTo].mt <= t + AHEAD) batchUp.push(frames[sentTo++]);
    for (let i = 0; i < batchUp.length; i += 16) window.__nsFrames(batch(el, batchUp.slice(i, i + 16), lastGen()));
    await tick();
  }
  const early = got.filter((g) => g.ctxT > g.heard + 0.002);
  assert.equal(early.length, 0, `no frame before its audio (${early.length} early)`);
  const late = got.map((g) => g.heard - g.ctxT).sort((a, b) => a - b);
  const p95 = late[Math.floor(late.length * 0.95)];
  // Released on the step that reaches them: within one 40 ms report.
  assert.ok(p95 <= 0.045, `p95 late ${(p95 * 1000).toFixed(1)} ms`);
  assert.ok(got.length > 0.95 * frames.filter((x) => x.mt <= 19).length, `${got.length} delivered of ${frames.length}`);
  const tail = got.slice(-100);
  const bpm = tail[tail.length - 1].bpm;
  assert.ok(tail.every((g) => g.locked) && Math.abs(bpm - 132) < 1.5, `locked at ${bpm}`);

  // A seek back: what the app had already sent of the old position is not
  // this audio's, and none of it is drawn.
  window.__nsFrames(batch(el, frames.slice(sentTo, sentTo + 16), lastGen())); // mt ≈ 19.5 s, held
  const before = got.length;
  clock += 40;
  window.__nsAudio(el._id, { c: el._seq, st: 3, p: true, t: 2, b: 7, sk: true, d: 600, ev: "seeked" });
  window.__nsFrames(batch(el, frames.slice(Math.round(2 / (ready.hop / SR)), Math.round(2 / (ready.hop / SR)) + 2), lastGen()));
  await tick();
  clock += 100;
  at(el, 2.1);
  await new Promise((r) => setTimeout(r, 40)); // the pump's timer for the frame due at 2.016
  const after = got.slice(before);
  assert.ok(after.every((g) => g.ctxT < 3), `nothing of the old position drawn: ${after.map((g) => g.ctxT.toFixed(2))}`);
  assert.ok(after.length >= 2, `the new position's frames are drawn (${after.length}), not stuck behind the old ones`);

  // A seek forward: what was analysed of the position left is behind the
  // clock now, and is not drawn either.
  const fwd = got.length;
  const k2 = Math.round(2.2 / (ready.hop / SR));
  window.__nsAudio(el._id, { c: el._seq, st: 3, p: true, t: 15, b: 20, sk: true, d: 600, ev: "seeked" });
  window.__nsFrames(batch(el, frames.slice(k2, k2 + 16), lastGen()));
  await tick();
  assert.equal(got.length - fwd, 0, "the leftovers of 2 s are not drawn at 15 s");

  unsub();
  assert.ok(sent.analysis.some((m) => m.t === "sleep" && m.on), "the app's analyser sleeps with the views");
});

test("the EQ and the bass lift go to the app", () => {
  sent.fx.length = 0;
  S.eqBands.set([3, 0, 0, 0, 0, 0, 0, 0, 0, -2]);
  S.eqEnabled.set(true);
  S.bassBoost.set(0.5);
  const last = sent.fx[sent.fx.length - 1];
  assert.deepEqual(last, { eq: [3, 0, 0, 0, 0, 0, 0, 0, 0, -2], bass: 0.5 });
  S.eqEnabled.set(false);
  assert.deepEqual(sent.fx[sent.fx.length - 1], { eq: [], bass: 0.5 }, "EQ off: flat, the lift kept");
  const n = sent.fx.length;
  S.bassBoost.set(0.5);
  assert.equal(sent.fx.length, n, "an unchanged setting is not sent again");
});

test("an app without the analyser: the page path, as before", () => {
  window.NSNative.bridgeVersion = () => 5;
  N.resetNativeAudio();
  assert.equal(N.nativeDspAvailable(), false);
  window.NSNative.bridgeVersion = () => 6;
  window.NSNative.naAnalysisAvailable = () => false;
  N.resetNativeAudio();
  assert.equal(N.nativeDspAvailable(), false, "no native core in this APK");
});

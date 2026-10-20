// The Android app's player dressed as an <audio> element (lib/audio/nativeplayer.js
// ↔ NativeAudio.kt): what the page sees for what the native side reports, and
// that a report older than the page's last command never undoes it.
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { addEventListener() {}, location: { href: "http://srv/app/", hash: "" } };
globalThis.document = { addEventListener() {}, visibilityState: "visible" };
globalThis.location = globalThis.window.location;

// A fake page clock, so the interpolation is exact.
let clock = 1000;
globalThis.performance = { now: () => clock };

const { get } = await import("svelte/store");
const S = await import("../src/lib/stores.js");
const N = await import("../src/lib/audio/nativeplayer.js");
const O = await import("../src/lib/audio/output.js");

// The native side: records commands, and answers like NativeAudio.kt.
function app({ version = 4, available = true } = {}) {
  const sent = [];
  let next = 1;
  window.NSNative = {
    bridgeVersion: () => version,
    nativeAudio: () => available,
    naCreate: () => next++,
    naCmd: (id, json) => sent.push({ id, ...JSON.parse(json) }),
  };
  N.resetNativeAudio();
  return sent;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
function events(el) {
  const seen = [];
  for (const t of ["play", "pause", "playing", "waiting", "canplay", "loadedmetadata", "durationchange",
    "timeupdate", "seeking", "seeked", "ended", "error", "emptied", "loadstart"])
    el.addEventListener(t, () => seen.push(t));
  return seen;
}
// What NativeAudio.kt sends: `c` is the last command it has applied.
const report = (el, s) => window.__nsAudio(el._id, s);

test("offered only by an app that has the player", () => {
  app({ version: 3 });
  assert.equal(N.nativeAudioAvailable(), false);
  app({ available: false });
  assert.equal(N.nativeAudioAvailable(), false);
  delete window.NSNative;
  N.resetNativeAudio();
  assert.equal(N.nativeAudioAvailable(), false);
  assert.equal(N.createNativeElement(), null);
  app();
  assert.equal(N.nativeAudioAvailable(), true);
});

test("the setting makes the path direct, with its own reason", () => {
  app();
  S.nativePlayer.set(false);
  assert.notEqual(get(O.outputPlan).why, "native");
  S.nativePlayer.set(true);
  assert.equal(get(N.nativeAudioWanted), true);
  assert.deepEqual([get(O.outputPlan).direct, get(O.outputPlan).why], [true, "native"]);
  S.nativePlayer.set(false);
});

test("src + load is ONE load, with the absolute URL", async () => {
  const sent = app();
  const el = N.createNativeElement();
  el.src = "/api/stream/abc?q=opus";
  el.load();
  await flush();
  const loads = sent.filter((m) => m.op === "src");
  assert.equal(loads.length, 1);
  assert.equal(loads[0].url, "http://srv/api/stream/abc?q=opus");
  assert.equal(loads[0].pre, true);
});

test("a play reaches playing, and the position runs on its own between ticks", async () => {
  const sent = app();
  const el = N.createNativeElement();
  const seen = events(el);
  el.src = "/api/stream/a";
  el.load();
  const c0 = sent.at(-1).c;
  report(el, { c: c0, st: 2, p: false, t: 0, d: 200, b: 3 });
  assert.equal(el.duration, 200);
  assert.equal(el.readyState, 1);
  const played = el.play();
  assert.equal(el.paused, false);
  const c1 = sent.at(-1).c;
  report(el, { c: c1, st: 3, p: true, t: 0, d: 200, b: 10 });
  await played;
  await flush();
  assert.ok(seen.includes("loadedmetadata") && seen.includes("canplay") && seen.includes("playing"));
  assert.equal(el.readyState, 4);
  clock += 500;
  assert.ok(Math.abs(el.currentTime - 0.5) < 1e-9);
  // A tick a little behind the interpolation does not move the playhead back.
  report(el, { c: c1, ev: "tick", st: 3, p: true, t: 0.48 });
  assert.ok(el.currentTime >= 0.5 - 1e-9);
  clock += 1000;
  assert.ok(Math.abs(el.currentTime - 1.48) < 1e-9);
});

test("a report sent before the pause reached the native side does not undo it", async () => {
  const sent = app();
  const el = N.createNativeElement();
  el.src = "/api/stream/a";
  el.load();
  el.play();
  const c1 = sent.at(-1).c;
  report(el, { c: c1, st: 3, p: true, t: 10, d: 200 });
  el.pause();
  report(el, { c: c1, ev: "tick", st: 3, p: true, t: 10.25 }); // in flight
  assert.equal(el.paused, true);
  // The native side pausing ON ITS OWN (focus lost) is adopted.
  el.play();
  const c2 = sent.at(-1).c;
  report(el, { c: c2, st: 3, p: true, t: 10.3 });
  const seen = events(el);
  report(el, { c: c2, st: 3, p: false, t: 11 });
  assert.equal(el.paused, true);
  assert.deepEqual(seen, ["pause"]);
});

test("a seek is reported as seeked only once the native side has done THAT seek", async () => {
  const sent = app();
  const el = N.createNativeElement();
  el.src = "/api/stream/a";
  el.load();
  const seen = events(el);
  el.currentTime = 30;
  const s1 = sent.at(-1).c;
  el.currentTime = 60;
  const s2 = sent.at(-1).c;
  assert.equal(el.seeking, true);
  report(el, { c: s1, ev: "seeked", st: 3, p: false, t: 30 });
  assert.equal(el.seeking, true);
  assert.equal(el.currentTime, 60);
  report(el, { c: s2, ev: "seeked", st: 3, p: false, t: 60 });
  assert.equal(el.seeking, false);
  assert.equal(el.currentTime, 60);
  await flush();
  assert.ok(seen.includes("seeking") && seen.includes("seeked"));
});

test("the end pauses then ends, like an element", () => {
  const sent = app();
  const el = N.createNativeElement();
  el.src = "/api/stream/a";
  el.load();
  el.play();
  const c = sent.at(-1).c;
  report(el, { c, st: 3, p: true, t: 199, d: 200 });
  const seen = events(el);
  report(el, { c, st: 4, p: true, t: 200, d: 200 });
  assert.deepEqual(seen, ["timeupdate", "pause", "ended"]);
  assert.equal(el.ended, true);
  assert.equal(el.paused, true);
  assert.equal(el.currentTime, 200);
});

test("reports about a replaced source are ignored, an error rejects the play", async () => {
  const sent = app();
  const el = N.createNativeElement();
  el.src = "/api/stream/a";
  el.load();
  const old = sent.at(-1).c;
  el.src = "/api/stream/b";
  el.load();
  report(el, { c: old, st: 3, p: false, t: 99, d: 300 });
  assert.equal(el.duration, NaN);
  const p = el.play();
  report(el, { c: sent.at(-1).c, ev: "error", code: 2, msg: "HTTP 503" });
  await assert.rejects(p);
  assert.equal(el.error.code, 2);
});

test("volume, rate and release go across; nothing is sent after release", () => {
  const sent = app();
  const el = N.createNativeElement();
  el.volume = 0.5;
  el.volume = 0.5; // unchanged: not sent again
  el.muted = true;
  el.playbackRate = 1.5;
  assert.deepEqual(
    sent.map((m) => [m.op, m.v ?? m.r]),
    [["volume", 0.5], ["volume", 0], ["rate", 1.5]]
  );
  el.release();
  const n = sent.length;
  el.volume = 0.1;
  el.play().catch(() => {});
  assert.equal(sent.at(-1).op === "release" ? sent.length : -1, n);
});

// Lot N6: on by default where the app's player carries everything the page's
// does, and the page's player back the moment the app's own fails.
function dspApp(version = 6, appVersion = "1.6.0") {
  const sent = app({ version });
  Object.assign(window.NSNative, {
    naFx() {},
    naAnalysis() {},
    naAnalysisAvailable: () => true,
    appVersion: () => appVersion,
  });
  N.resetNativeAudio();
  return sent;
}

test("nobody chose: on where the app's player has the effects and the animations, off where it has not", () => {
  S.nativeFault.set(null);
  S.nativePlayer.set(null);
  dspApp(6);
  assert.equal(get(N.nativeAudioWanted), true, "bridge 6: the app's player");
  app({ version: 5 });
  assert.equal(get(N.nativeAudioWanted), false, "bridge 5 (no EQ, no animations): the page's");
  S.nativePlayer.set(true);
  assert.equal(get(N.nativeAudioWanted), true, "unless the person asked for it");
  dspApp(6);
  S.nativePlayer.set(false);
  assert.equal(get(N.nativeAudioWanted), false, "and a choice of off is kept");
  S.nativePlayer.set(null);
});

test("the app's player failing hands the music to the page's, before anyone hears of the error", () => {
  S.nativeFault.set(null);
  S.nativePlayer.set(null);
  const sent = dspApp(6, "1.6.0");
  const el = N.createNativeElement();
  el.src = "/api/stream/x";
  el.load();
  let wantedAtError = null;
  el.addEventListener("error", () => (wantedAtError = get(N.nativeAudioWanted)));
  // A network error is not the player's: the page's would fail just the same.
  report(el, { c: sent.at(-1).c, ev: "error", code: 2, msg: "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED" });
  assert.equal(wantedAtError, true);
  assert.equal(get(S.nativeFault), null);
  // The audio output could not be opened: that one is.
  report(el, { c: sent.at(-1).c, ev: "error", code: 3, msg: "ERROR_CODE_AUDIO_TRACK_INIT_FAILED" });
  assert.equal(wantedAtError, false, "Player.svelte's handler already reads the page's player as wanted");
  assert.equal(get(S.nativeFault).why, "ERROR_CODE_AUDIO_TRACK_INIT_FAILED");
  assert.equal(get(N.nativeAudioWanted), false);
});

test("a fault holds for a day and for this version of the app", () => {
  dspApp(6, "1.6.0");
  const at = Date.now();
  const f = { at, app: "1.6.0", why: "x" };
  assert.equal(N.faultHolds(f, at + 23 * 3600e3), true);
  assert.equal(N.faultHolds(f, at + 25 * 3600e3), false, "tried again the next day");
  dspApp(6, "1.7.0");
  assert.equal(N.faultHolds(f, at + 1000), false, "and by a new version of the app");
  S.nativeFault.set({ at, app: "1.7.0", why: "x" });
  assert.equal(get(N.nativeAudioWanted), false);
  N.clearNativeFault();
  assert.equal(get(N.nativeAudioWanted), true, "Réessayer maintenant");
});

test("an app that cannot make a player is not asked again on every element", () => {
  S.nativeFault.set(null);
  dspApp(6);
  window.NSNative.naCreate = () => 0;
  assert.equal(N.createNativeElement(), null);
  assert.equal(get(S.nativeFault).why, "no player");
  assert.equal(get(N.nativeAudioWanted), false);
  S.nativeFault.set(null);
});

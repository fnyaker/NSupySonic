// WHERE THE SOUND GOES: straight to the system, or through Web Audio.
//
// The player's <audio> element can reach the speakers two ways. DIRECT, the
// browser's own media pipeline plays it — one decoder, one output stream, the
// buffering every media app on the phone relies on. PROCESSED, it is routed
// through an AudioContext (lib/audio/graph.js) so the animations can read it and
// the effects can change it. createMediaElementSource is one-way: once an
// element is routed, its sound only ever reaches the speakers through the
// context, for the element's whole life.
//
// The processed path is the fragile one. On Android, a context with an
// AudioWorklet renders on the worklet thread and hands its audio to the device
// through a FIFO; a Bluetooth sink asks for audio in large, irregular bursts,
// and when a burst finds the FIFO short it is padded with silence while the
// frames rendered late are dropped when they arrive (Chromium issue 40133762,
// and the "Bluetooth + WebAudio + background tab = stutter" report every PWA
// that meters its audio has filed). Heard through an AAC car radio it is
// exactly what was reported: the music sounds sped up, as if pieces were being
// cut out. Switching the analysis off changed nothing, and could not have: the
// element was already routed, and the worklet had already moved the context's
// rendering onto its thread.
//
// AND IT COMES AND GOES. The same phone on the same car radio, reconnected,
// played cleanly again — a context, a link, a codec session in a bad state,
// not the output as such. So playing every Bluetooth output direct up front
// would take the equalizer, the full normalization and the animations' timing
// away from every headset that never had the problem, for a fault that is not
// even there most of the time. The policy is therefore MEASURED:
//
//   "auto"    processed, as always — and DIRECT the moment the timekeeper
//             (timekeeper.js) measures the processed path losing audio, for as
//             long as the fault can be expected to last: THIS connection of
//             this output (the Android app numbers them, AudioRoute.kt), and
//             only until a retry. At a track change after RETRY_FIRST the
//             processed path is tried again, on a fresh context; if the fault
//             is back, the next retry waits twice as long (up to RETRY_MAX);
//             if GOOD_TO_CLEAR windows in a row keep time, it is forgotten. A
//             new connection starts with a clean slate.
//   "direct"  always direct. The animations still run, off a copy of the sound
//             (graph.js#captureElement); the equalizer and the bass lift, which
//             need the sound to go THROUGH the processor, are off; the
//             normalization can only turn a track down (element.volume <= 1);
//             the crossfade rides the elements' volumes.
//   "graph"   always processed, as before this module existed; a measured
//             fault is only reported.

import { derived, get, writable } from "svelte/store";
import { audioOutput, glitchRoutes } from "../stores.js";

export const OUTPUT_MODES = ["auto", "direct", "graph"];

// The first retry of the processed path after a verdict, and the ceiling the
// doubling stops at. Every retry that finds the fault again costs the listener
// one window of it (eight seconds), so they get rarer while the fault lasts.
export const RETRY_FIRST = 15 * 60 * 1000;
export const RETRY_MAX = 4 * 3600 * 1000;
// Clean windows in a row, on the processed path, that close a verdict.
export const GOOD_TO_CLEAR = 6;
// A verdict nobody has touched in this long is dropped from storage.
export const VERDICT_MAX_AGE = 7 * 24 * 3600 * 1000;

// A context that reports this much output latency on Android is on a wireless
// link: measured, a phone's own speaker or a wired headset sits at 20-60 ms,
// Bluetooth at 150-300 ms (A2DP buffers a whole codec frame queue). Used only
// to NAME the output where nothing else can (a browser, an older app).
export const BT_LATENCY = 0.15;

export const UNKNOWN_ROUTE = Object.freeze({ kind: "unknown", name: "", key: "default", conn: "", source: "none" });

const KINDS = new Set(["bluetooth", "wired", "usb", "speaker", "hdmi", "other", "unknown"]);

/** A route as the rest of the app reads it, whatever the native side sent. */
export function normalizeRoute(r) {
  if (!r || typeof r !== "object") return UNKNOWN_ROUTE;
  const kind = KINDS.has(r.kind) ? r.kind : "other";
  // Third-party text (a Bluetooth device names itself): bounded, one line.
  const name = String(r.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const key =
    typeof r.key === "string" && r.key
      ? r.key.slice(0, 80)
      : kind === "unknown"
        ? "default"
        : `${kind}:${name.toLowerCase()}`;
  // Which connection of that output this is (AudioRoute.kt changes it every
  // time the output comes back): a verdict is about one connection.
  const conn = r.conn == null ? "" : String(r.conn).slice(0, 40);
  return {
    kind,
    name,
    key,
    conn,
    source: r.source === "latency" ? "latency" : r.source === "native" ? "native" : "none",
  };
}

/** The output the sound is going to, as far as anything can tell. */
export const audioRoute = writable(UNKNOWN_ROUTE);
let nativeRoute = false; // the Android app answers: never second-guess it

function fromNative(raw) {
  try {
    const r = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!r) return;
    nativeRoute = true;
    audioRoute.set(normalizeRoute({ ...r, source: "native" }));
  } catch {
    /* a malformed answer changes nothing */
  }
}

if (typeof window !== "undefined") {
  // Pushed by MainActivity whenever an output device comes or goes.
  window.__nsAudioRoute = fromNative;
  try {
    const nat = window.NSNative;
    if (nat && typeof nat.audioRoute === "function") fromNative(nat.audioRoute());
  } catch {
    /* an older app build: the route stays unknown */
  }
}

const IS_ANDROID = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");

/**
 * Where the native side cannot say (a browser, an older app), the context's
 * own reported latency can: on Android a wireless output is the only thing
 * that puts it past BT_LATENCY. Called with a running context by the
 * timekeeper; a short latency takes an inferred Bluetooth route back.
 */
export function noteContextLatency(ctx) {
  if (nativeRoute || !IS_ANDROID || !ctx || ctx.state !== "running") return;
  const lag = (+ctx.outputLatency || 0) + (+ctx.baseLatency || 0) / 2;
  if (!(lag > 0)) return;
  const cur = get(audioRoute);
  if (lag >= BT_LATENCY && cur.kind !== "bluetooth")
    audioRoute.set(normalizeRoute({ kind: "bluetooth", name: "", key: "latency:high", source: "latency" }));
  else if (lag < BT_LATENCY * 0.6 && cur.source === "latency") audioRoute.set(UNKNOWN_ROUTE);
}

// A stored verdict still describes the output playing now: same output, same
// connection of it, and not stale.
function sameConnection(v, route, now) {
  return (
    !!v &&
    typeof v.at === "number" &&
    now - v.at < VERDICT_MAX_AGE &&
    v.at <= now + 60_000 &&
    (v.conn || "") === (route?.conn || "")
  );
}

/**
 * The decision, as a value: `direct`, and `why` — "setting", "glitch" (the
 * fault was measured on this connection and is not being retried) or
 * "default". Pure, so the rule is testable without a browser.
 */
export function decideOutput(mode, route, glitches, now = Date.now()) {
  if (mode === "direct") return { direct: true, why: "setting" };
  if (mode === "graph") return { direct: false, why: "setting" };
  const v = glitches && glitches[route?.key || "default"];
  if (sameConnection(v, route, now) && !v.probing) return { direct: true, why: "glitch", retryAt: v.retryAt };
  return { direct: false, why: sameConnection(v, route, now) ? "probing" : "default" };
}

export const outputPlan = derived([audioOutput, audioRoute, glitchRoutes], ([$mode, $route, $glitches]) => ({
  ...decideOutput(OUTPUT_MODES.includes($mode) ? $mode : "auto", $route, $glitches),
  route: $route,
}));

/** true while the player must keep its elements off Web Audio. */
export const directOutput = derived(outputPlan, ($p) => $p.direct);

// Write one output's verdict, dropping every expired one on the way.
function writeVerdict(key, entry) {
  glitchRoutes.update((m) => {
    const next = {};
    const now = Date.now();
    for (const [k, v] of Object.entries(m || {}))
      if (v && typeof v.at === "number" && now - v.at < VERDICT_MAX_AGE) next[k] = v;
    if (entry) next[key] = entry;
    else delete next[key];
    return next;
  });
}

/**
 * The timekeeper's verdict: the processed path lost audio on the current
 * output. Direct for this connection until a retry; a fault found again by a
 * retry waits twice as long for the next one. Returns true when that changes
 * what plays (auto mode), false when the setting pins the path and the verdict
 * is only reported.
 */
export function reportGlitch(info = {}, now = Date.now()) {
  const route = get(audioRoute);
  const prev = get(glitchRoutes)[route.key];
  const again = sameConnection(prev, route, now);
  const backoff = again ? Math.min(RETRY_MAX, Math.max(RETRY_FIRST, (prev.backoff || RETRY_FIRST) * 2)) : RETRY_FIRST;
  writeVerdict(route.key, {
    at: now,
    conn: route.conn || "",
    name: route.name || "",
    kind: route.kind,
    why: String(info.why || "").slice(0, 120),
    ratio: Number.isFinite(info.ratio) ? Math.round(info.ratio * 10000) / 10000 : null,
    count: again ? (prev.count || 1) + 1 : 1,
    backoff,
    retryAt: now + backoff,
    probing: false,
    good: 0,
  });
  return get(audioOutput) === "auto";
}

/**
 * At a track change: if the current output's verdict is due for a retry, try
 * the processed path again (the verdict stays, marked as being probed, until
 * the timekeeper either clears it or finds the fault again). Returns true when
 * it flipped the path.
 */
export function retryIfDue(now = Date.now()) {
  if (get(audioOutput) !== "auto") return false;
  const route = get(audioRoute);
  const v = get(glitchRoutes)[route.key];
  if (!sameConnection(v, route, now) || v.probing || !(now >= v.retryAt)) return false;
  writeVerdict(route.key, { ...v, probing: true, good: 0 });
  return true;
}

/**
 * A window that kept time on the processed path. While a verdict is being
 * probed, GOOD_TO_CLEAR of them in a row close it: the fault is gone.
 */
export function noteGoodWindow(now = Date.now()) {
  const route = get(audioRoute);
  const v = get(glitchRoutes)[route.key];
  if (!sameConnection(v, route, now) || !v.probing) return;
  const good = (v.good || 0) + 1;
  writeVerdict(route.key, good >= GOOD_TO_CLEAR ? null : { ...v, good });
}

/** "Réessayer maintenant" in Réglages: probe the processed path at once. */
export function retryNow(key) {
  const v = get(glitchRoutes)[key];
  if (!v) return;
  writeVerdict(key, { ...v, probing: true, good: 0 });
}

/** Forget one output's verdict altogether. */
export function forgetGlitch(key) {
  writeVerdict(key, null);
}

/** The verdicts still on record, newest first, for the settings screen. */
export function activeGlitches(map, now = Date.now()) {
  return Object.entries(map || {})
    .filter(([, v]) => v && typeof v.at === "number" && now - v.at < VERDICT_MAX_AGE && v.at <= now + 60_000)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.at - a.at);
}

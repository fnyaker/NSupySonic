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
// The processed path is the fragile one, and on one kind of output it is broken
// outright. On Android, a context with an AudioWorklet renders on the worklet
// thread and hands its audio to the device through a FIFO; a Bluetooth sink
// asks for audio in large, irregular bursts, and when a burst finds the FIFO
// short it is padded with silence while the frames rendered late are dropped
// when they arrive (Chromium issue 40133762, and the "Bluetooth + WebAudio +
// background tab = stutter" report every PWA that meters its audio has filed).
// Heard through an AAC car radio it is exactly what was reported: the music
// sounds sped up, as if pieces were being cut out. Switching the analysis off
// changed nothing, and could not have: the element was already routed, and the
// worklet had already moved the context's rendering onto its thread.
//
// So the route is a POLICY, decided here and applied by graph.js (which refuses
// to route an element while it says direct) and Player.svelte (which hands a
// routed element's playback over to a fresh one — the only way out):
//
//   "direct"  always direct. The animations still run, off a copy of the sound
//             (graph.js#captureElement); the equalizer and the bass lift, which
//             need the sound to go THROUGH the processor, are off; the
//             normalization can only turn a track down (element.volume <= 1);
//             the crossfade rides the elements' volumes.
//   "graph"   always processed, as before this module existed.
//   "auto"    direct on a Bluetooth output — the Android app reports the route
//             (MainActivity: AudioManager's output devices); a browser on
//             Android is recognised by the latency its context reports — unless
//             the equalizer or the bass lift is on, which only the processed
//             path can do. And direct, whatever the output, wherever the
//             processed path was MEASURED losing audio (timekeeper.js): that
//             verdict is remembered per output for GLITCH_TTL.

import { derived, get, writable } from "svelte/store";
import { audioOutput, bassBoost, eqBands, eqEnabled, glitchRoutes } from "../stores.js";

export const OUTPUT_MODES = ["auto", "direct", "graph"];

// How long a measured failure keeps an output on the direct path. Long enough
// that a car radio is not re-tested on every drive; short enough that a browser
// update that fixes the bug is given a chance within a season.
export const GLITCH_TTL = 45 * 24 * 3600 * 1000;

// A context that reports this much output latency on Android is on a wireless
// link: measured, a phone's own speaker or a wired headset sits at 20-60 ms,
// Bluetooth at 150-300 ms (A2DP buffers a whole codec frame queue).
export const BT_LATENCY = 0.15;

export const UNKNOWN_ROUTE = Object.freeze({ kind: "unknown", name: "", key: "default", source: "none" });

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
  return { kind, name, key, source: r.source === "latency" ? "latency" : r.source === "native" ? "native" : "none" };
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

/** Only the processed path can do these: they change the sound on its way through. */
export const dspWanted = derived(
  [eqEnabled, eqBands, bassBoost],
  ([$eq, $bands, $bass]) =>
    (!!$eq && Array.isArray($bands) && $bands.some((g) => Math.abs(+g || 0) > 0.01)) || (+$bass || 0) > 0.01
);

/** A glitch measured in THIS session, for an output whose verdict is not stored yet. */
export const sessionGlitch = writable(null);

function freshVerdict(v, now) {
  return !!v && typeof v.at === "number" && now - v.at < GLITCH_TTL && v.at <= now + 60_000;
}

/**
 * The decision, as a value: `direct`, and `why` — "setting", "bluetooth",
 * "glitch", "dsp" (Bluetooth, but an effect needs the processor) or "default".
 * Pure, so the rule is testable without a browser.
 */
export function decideOutput(mode, route, glitches, session, dsp, now = Date.now()) {
  if (mode === "direct") return { direct: true, why: "setting" };
  if (mode === "graph") return { direct: false, why: "setting" };
  const key = route?.key || "default";
  if (freshVerdict(glitches && glitches[key], now) || (session && session.key === key))
    return { direct: true, why: "glitch" };
  if (route?.kind === "bluetooth") return dsp ? { direct: false, why: "dsp" } : { direct: true, why: "bluetooth" };
  return { direct: false, why: "default" };
}

export const outputPlan = derived(
  [audioOutput, audioRoute, glitchRoutes, sessionGlitch, dspWanted],
  ([$mode, $route, $glitches, $session, $dsp]) => ({
    ...decideOutput(OUTPUT_MODES.includes($mode) ? $mode : "auto", $route, $glitches, $session, $dsp),
    route: $route,
  })
);

/** true while the player must keep its elements off Web Audio. */
export const directOutput = derived(outputPlan, ($p) => $p.direct);

/**
 * The timekeeper's verdict: the processed path lost audio on the current
 * output. Remembered for this output, so the next session starts direct.
 * Returns true when that changes what plays (auto mode), false when the
 * setting pins the path and the verdict is only reported.
 */
export function reportGlitch(info = {}) {
  const route = get(audioRoute);
  const entry = {
    at: Date.now(),
    name: route.name || "",
    kind: route.kind,
    why: String(info.why || "").slice(0, 120),
    ratio: Number.isFinite(info.ratio) ? Math.round(info.ratio * 10000) / 10000 : null,
  };
  glitchRoutes.update((m) => {
    const next = {};
    const now = Date.now();
    // Keep the map small and current: expired verdicts go on every write.
    for (const [k, v] of Object.entries(m || {})) if (freshVerdict(v, now)) next[k] = v;
    next[route.key] = entry;
    return next;
  });
  sessionGlitch.set({ key: route.key, at: entry.at });
  return get(audioOutput) === "auto";
}

/** Give the processed path another chance on one output (Réglages). */
export function forgetGlitch(key) {
  glitchRoutes.update((m) => {
    const next = { ...(m || {}) };
    delete next[key];
    return next;
  });
  const s = get(sessionGlitch);
  if (s && s.key === key) sessionGlitch.set(null);
}

/** The verdicts still in force, newest first, for the settings screen. */
export function activeGlitches(map, now = Date.now()) {
  return Object.entries(map || {})
    .filter(([, v]) => freshVerdict(v, now))
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.at - a.at);
}

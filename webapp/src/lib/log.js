// Client-side diagnostic log.
//
// OFF by default, and effectively free when off: every call site costs one
// boolean read, and nothing is formatted or stored.
//
// The point of this is POST-MORTEM. The problems worth logging here — playback
// resuming on the wrong track, an episode that never starts — happen while the
// screen is off and are only noticed after Android has killed the WebView, so a
// buffer that lives in memory would die with the very thing it is meant to
// explain. Entries are therefore mirrored into localStorage:
//
//   - paced off the CLOCK, not a timer: a backgrounded Android WebView is never
//     told it is hidden (the app deliberately skips webView.onPause()), and its
//     timers get throttled to as little as once a minute anyway.
//   - anything marked `important` is flushed the instant it happens, because it
//     is exactly the kind of event that tends to be the last one before a kill.
//
// The buffer is a bounded ring: a long listening session can emit thousands of
// entries and localStorage is a few megabytes for the whole origin.

import { writable } from "svelte/store";

const ENABLED_KEY = "debug.logs";
const BUFFER_KEY = "debug.log.buffer";
// ~800 entries at ~120 bytes is under 100 KB — big enough to hold a full
// screen-off listening session, small enough to never threaten the quota.
const MAX_ENTRIES = 800;
const FLUSH_MS = 1500;

function readEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

// --- state ------------------------------------------------------------------
// Declared BEFORE the store below, and that order is load-bearing: a store
// subscription fires synchronously on creation, so if logging is already on
// from a previous run the callback runs during module evaluation. Anything it
// touches that is declared further down is still in the temporal dead zone —
// which throws, and takes the whole app's boot down with it, for precisely the
// people who turned logging on.
let buffer = [];
let lastFlush = 0;
let loaded = false;
// A plain module-level mirror of the store, so the hot path never touches a
// Svelte subscription just to decide "am I on?".
let enabled = readEnabled();

export const logsEnabled = writable(enabled);

logsEnabled.subscribe((v) => {
  enabled = !!v;
  try {
    localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!v) return;
  // Marks each run, so a downloaded log always says which session it came from.
  logInfo("log", "session start", {
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
    at: new Date().toISOString(),
  });
});

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(BUFFER_KEY);
    if (raw) buffer = JSON.parse(raw) || [];
  } catch {
    buffer = [];
  }
  if (!Array.isArray(buffer)) buffer = [];
}

function flush() {
  lastFlush = Date.now();
  try {
    localStorage.setItem(BUFFER_KEY, JSON.stringify(buffer));
  } catch {
    // Out of quota: drop the oldest half rather than lose the recent entries,
    // which are the ones that explain whatever just happened.
    buffer = buffer.slice(-Math.floor(MAX_ENTRIES / 2));
    try {
      localStorage.setItem(BUFFER_KEY, JSON.stringify(buffer));
    } catch {
      /* give up quietly — logging must never break the app */
    }
  }
}

/**
 * Record one line. `data` is optional and is stringified defensively (a value
 * that can't be serialized must not take the player down with it).
 *
 * Pass `{ important: true }` for events that are plausibly the last thing to
 * run before the process dies — they are persisted immediately instead of
 * waiting for the next flush window.
 */
export function logInfo(scope, msg, data = null, opts = null) {
  if (!enabled) return;
  load();
  let extra = "";
  if (data != null) {
    try {
      extra = typeof data === "string" ? data : JSON.stringify(data);
    } catch {
      extra = "[unserialisable]";
    }
    if (extra.length > 400) extra = extra.slice(0, 400) + "…";
  }
  buffer.push([Date.now(), String(scope), String(msg), extra]);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  if ((opts && opts.important) || Date.now() - lastFlush >= FLUSH_MS) flush();
}

/** Force everything to disk — for handlers that run as the page goes away. */
export function flushLog() {
  if (!enabled) return;
  load();
  flush();
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function stamp(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** The whole log as one plain-text document. */
export function logText() {
  load();
  const head = [
    "NSupySonic — journal client",
    `exporté : ${new Date().toISOString()}`,
    `entrées : ${buffer.length}`,
    typeof navigator !== "undefined" ? `agent   : ${navigator.userAgent}` : "",
    typeof screen !== "undefined" ? `écran   : ${screen.width}x${screen.height}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = buffer
    .map(([t, scope, msg, extra]) =>
      `${stamp(t)}  ${String(scope).padEnd(9)} ${msg}${extra ? "  " + extra : ""}`
    )
    .join("\n");
  return head + body + "\n";
}

export function logCount() {
  load();
  return buffer.length;
}

export function clearLog() {
  buffer = [];
  loaded = true;
  try {
    localStorage.removeItem(BUFFER_KEY);
  } catch {
    /* ignore */
  }
}

/** Save the log as a .txt. Returns false if the browser refused. */
export function downloadLog() {
  try {
    const blob = new Blob([logText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    a.href = url;
    a.download = `nsupysonic-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch {
    return false;
  }
}

/** Copy the log to the clipboard — the reliable path inside a WebView, where a
 * download can be swallowed by the host app. */
export async function copyLog() {
  const text = logText();
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older WebViews: fall back to the ancient execCommand dance.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function isLogging() {
  return enabled;
}

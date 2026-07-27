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
// ~2000 entries at ~120 bytes is around 240 KB — big enough to hold a long
// session with full capture on, small enough to never threaten the quota.
const MAX_ENTRIES = 2000;
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
// Capture state lives up here for the same reason as the buffer: installCapture
// runs from the subscription below, which fires during module evaluation.
let captureInstalled = false;
const originals = {};
// Hosts already reported as failing, so repeats coalesce into one counted line.
const seenBadHosts = new Set();
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
  // Installed on first enable and never removed: the hooks are inert once
  // `enabled` goes false again (every one of them starts with logInfo, which
  // returns immediately), and unwrapping the platform is far riskier than
  // leaving a no-op wrapper in place.
  // Deferred by a microtask rather than called inline: this subscription fires
  // during module evaluation, so anything it reaches that is declared further
  // down the file is still in the temporal dead zone. Deferring removes the
  // whole class of hazard instead of relying on declaration order staying right.
  queueMicrotask(installCapture);
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
  scope = String(scope);
  msg = String(msg);
  // Coalesce a repeat of the line just written. Capturing everything means a
  // dead image CDN can emit fifty identical `resource` failures in a second,
  // and without this they evict the entries that actually explain something.
  // The count and the last timestamp are kept, so nothing is lost but the noise.
  const last = buffer[buffer.length - 1];
  if (last && last[1] === scope && last[2] === msg && last[3] === extra) {
    last[0] = Date.now();
    last[4] = (last[4] || 1) + 1;
  } else {
    buffer.push([Date.now(), scope, msg, extra]);
  }
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
    .map(([t, scope, msg, extra, n]) =>
      `${stamp(t)}  ${String(scope).padEnd(12)} ${msg}${n > 1 ? ` (x${n})` : ""}${extra ? "  " + extra : ""}`
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
  const name = logFileName();
  // The Android host cannot download a blob: URL — its DownloadListener hands
  // the URL to DownloadManager, which only speaks http(s). That is why saving
  // the log from the mobile app failed. Ask the native side to write the text
  // directly when it is there.
  try {
    if (window.NSNative && typeof window.NSNative.saveText === "function") {
      window.NSNative.saveText(name, logText());
      logInfo("log", "saved via native bridge: " + name, null, { important: true });
      return true;
    }
  } catch (e) {
    logInfo("log", "native save failed: " + String(e), null, { important: true });
  }
  try {
    const blob = new Blob([logText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    logInfo("log", "saved via blob download: " + name);
    return true;
  } catch (e) {
    logInfo("log", "download failed: " + String(e), null, { important: true });
    return false;
  }
}

function logFileName() {
  const d = new Date();
  return `nsupysonic-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
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

// -- global capture ----------------------------------------------------------
// "Everything that happens" means the app's own instrumentation is not enough:
// the things that go wrong most visibly (a download that fails, a request that
// 500s, an exception in a handler) never call logInfo. So when logging is on we
// wrap the platform itself. All of it is installed lazily and removable, and
// every hook is written so that a throw inside it can never reach the app.

// Query parameters that must never reach a log the user is going to paste into
// a chat. The Subsonic API puts credentials straight in the query string.
const SECRET_PARAMS = /^(p|t|s|password|token|jwt|arl|auth|api_key|key|secret)$/i;

function safeUrl(u) {
  try {
    const url = new URL(String(u), location.href);
    let redacted = false;
    url.searchParams.forEach((_v, k) => {
      if (SECRET_PARAMS.test(k)) redacted = true;
    });
    if (redacted) {
      const keys = [];
      url.searchParams.forEach((_v, k) => keys.push(k));
      for (const k of keys) if (SECRET_PARAMS.test(k)) url.searchParams.set(k, "***");
    }
    // Same origin is the overwhelming case — keep the lines readable.
    return url.origin === location.origin ? url.pathname + url.search : url.href;
  } catch {
    return String(u).slice(0, 200);
  }
}

function fmtArg(a) {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function installCapture() {
  if (captureInstalled || typeof window === "undefined") return;
  captureInstalled = true;

  // --- console -------------------------------------------------------------
  // Third-party code and our own stray warnings both land here. `depth` stops a
  // console call made from inside the logger itself from recursing.
  let depth = 0;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    if (typeof console[level] !== "function") continue;
    originals[level] = console[level];
    console[level] = function (...args) {
      try {
        if (!depth) {
          depth++;
          logInfo(
            "console." + level,
            args.map(fmtArg).join(" ").slice(0, 500),
            null,
            { important: level === "error" }
          );
          depth--;
        }
      } catch {
        depth = 0;
      }
      return originals[level].apply(console, args);
    };
  }

  // --- uncaught failures ---------------------------------------------------
  originals.onerror = window.onerror;
  window.addEventListener("error", onWindowError, true);
  window.addEventListener("unhandledrejection", onRejection);

  // --- network -------------------------------------------------------------
  // The single most valuable stream here: a failed download, a 502 on a stream,
  // a request that never came back. Bodies are never touched — only method,
  // path, status and duration.
  if (typeof window.fetch === "function") {
    originals.fetch = window.fetch;
    window.fetch = function (input, init) {
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const url = safeUrl(typeof input === "string" ? input : input && input.url);
      const t0 = Date.now();
      let p;
      try {
        p = originals.fetch.apply(this, arguments);
      } catch (e) {
        logInfo("net", `${method} ${url} threw ${fmtArg(e)}`, null, { important: true });
        throw e;
      }
      return p.then(
        (res) => {
          logInfo("net", `${method} ${url} -> ${res.status} in ${Date.now() - t0}ms`, null,
                  { important: !res.ok });
          return res;
        },
        (err) => {
          logInfo("net", `${method} ${url} FAILED after ${Date.now() - t0}ms: ${fmtArg(err)}`,
                  null, { important: true });
          throw err;
        }
      );
    };
  }

  if (typeof XMLHttpRequest === "function") {
    const XP = XMLHttpRequest.prototype;
    originals.xhrOpen = XP.open;
    originals.xhrSend = XP.send;
    XP.open = function (method, url) {
      try {
        this.__nsLog = { method: String(method || "GET").toUpperCase(), url: safeUrl(url) };
      } catch {
        /* ignore */
      }
      return originals.xhrOpen.apply(this, arguments);
    };
    XP.send = function () {
      const meta = this.__nsLog;
      if (meta) {
        meta.t0 = Date.now();
        const done = (what) => {
          try {
            logInfo("net", `${meta.method} ${meta.url} ${what} in ${Date.now() - meta.t0}ms`,
                    null, { important: what !== "ok" });
          } catch {
            /* ignore */
          }
        };
        this.addEventListener("load", () => done("-> " + this.status));
        this.addEventListener("error", () => done("FAILED"));
        this.addEventListener("abort", () => done("aborted"));
        this.addEventListener("timeout", () => done("timed out"));
      }
      return originals.xhrSend.apply(this, arguments);
    };
  }

  // --- connectivity + lifecycle -------------------------------------------
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("resume", onResume, true);

  logInfo("log", "capture installed", {
    online: navigator.onLine,
    native: !!window.NSNative,
    dpr: window.devicePixelRatio,
    lang: navigator.language,
  }, { important: true });
}

function onWindowError(e) {
  try {
    // Resource errors (an <img>/<audio> that failed) don't have `message`.
    if (e && e.target && e.target !== window && e.target.tagName) {
      // Keyed by HOST, not by URL: a CDN having a bad minute produces one failed
      // image per cover on screen, and fifty near-identical lines would push
      // everything else out of the ring. The host is the actionable part; the
      // first full URL from each host is kept as evidence, the rest just count.
      const raw = e.target.currentSrc || e.target.src || "";
      let host = raw;
      try {
        host = new URL(raw, location.href).host || raw;
      } catch {
        /* keep the raw value */
      }
      const tag = e.target.tagName.toLowerCase();
      const first = !seenBadHosts.has(host);
      seenBadHosts.add(host);
      logInfo("resource", `${tag} failed from ${host}`, first ? safeUrl(raw) : null,
              { important: first });
      return;
    }
    logInfo("error", `${e.message} @ ${safeUrl(e.filename || "")}:${e.lineno || 0}`,
            e.error && e.error.stack ? String(e.error.stack).split("\n").slice(0, 4).join(" | ") : null,
            { important: true });
  } catch {
    /* ignore */
  }
}

function onRejection(e) {
  try {
    const r = e && e.reason;
    logInfo("rejection", fmtArg(r),
            r && r.stack ? String(r.stack).split("\n").slice(0, 4).join(" | ") : null,
            { important: true });
  } catch {
    /* ignore */
  }
}

function onOnline() {
  logInfo("net", "browser reports ONLINE", null, { important: true });
}
function onOffline() {
  logInfo("net", "browser reports OFFLINE", null, { important: true });
}
function onResume() {
  logInfo("page", "resume (unfrozen)", null, { important: true });
}

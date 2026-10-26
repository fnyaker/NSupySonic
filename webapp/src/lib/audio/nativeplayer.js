// THE ANDROID APP'S OWN PLAYER, dressed as an <audio> element.
//
// In the Android app the page can play through Media3/ExoPlayer instead of
// Chromium's media pipeline (NativeAudio.kt): the decoder and the output stream
// live in the app's process, outside the WebView's renderer — a renderer
// Android may kill in the background, and a pipeline that hands a Bluetooth
// sink its audio through the same fragile path as everything else in the page.
// Player.svelte is written against HTMLMediaElement, and everything that watches
// it (the listen party, the timekeeper, the ladder, the lock screen) reads the
// element; so the native player is put behind that same interface rather than
// beside it. Player.svelte creates one of these in place of `new Audio()` when
// the setting asks for it (`nativePlayer`), and nothing else needs to know.
//
// The wire: `NSNative.naCreate()` gives a player id, `NSNative.naCmd(id, json)`
// sends it a command ({c, op, …}: src, clear, play, pause, seek, volume, rate,
// release), and the native side reports back through `window.__nsAudio(id, s)`:
// its state on every change and four times a second while playing, plus the
// two events a state cannot say (`seeked`, `error`). Every command carries a
// sequence number the state echoes (`c`), and a field is adopted only from a
// state that has seen the last command which could have changed it — a tick
// sent just before a pause or a seek reached the native side must not undo it.
//
// Two things only the app can do, because the page may not be running (a
// hidden page whose sound comes out of the app is silent to Chromium, so it is
// throttled and then frozen behind a locked screen), from bridge version 7:
//  - while the page is hidden, Player.svelte names the tracks that follow
//    (`setNext`), and the player goes on to each by itself at the end of the last.
//    It reports that (`k`, the key it was given, on every state until the next
//    source) and the element dispatches `nsadvance` and nothing else until the
//    page adopts the new source (`adopt`) or loads its own;
//  - a seek in a stream with no length (a first play) is held by the app until
//    it can land (`sc` in its state), so the element is seekable everywhere.
// From bridge version 8 the list is kept up to date while the page is VISIBLE
// too (naming it at the moment the page is hidden raced the page being
// throttled), each entry carries where its audio ends (`e`, the silence trim)
// and so does the current track (`end`); the app follows the list only while
// its activity is stopped, ends a trimmed track there itself, and says so in
// every state (`bg`) so that the page leaves those transitions to it.
//
// Only what the player uses is here. A `blob:` source (a track downloaded into
// IndexedDB) cannot be read by the native side, so the element plays it on a
// real <audio> inside it, re-dispatching its events: until downloads move to
// native storage, those play the way they always did.

import { derived } from "svelte/store";
import { nativePlayer, nativeFault, eqEnabled, eqBands, bassBoost } from "../stores.js";
import { logInfo } from "../log.js";

// ExoPlayer's playback states, as the native side reports them.
export const ST_IDLE = 1;
export const ST_BUFFERING = 2;
export const ST_READY = 3;
export const ST_ENDED = 4;

// The bridge version that has naCreate / naCmd.
export const NATIVE_AUDIO_BRIDGE = 4;
// ...and the one whose players go on to the next track by themselves.
export const NATIVE_NEXT_BRIDGE = 7;
// ...and the one that keeps the list while visible and owns the transitions in
// the background (the trimmed end included).
export const NATIVE_OWN_BRIDGE = 8;

// A reading of the position that goes back by less than this is taken for the
// tick arriving a little behind the interpolation, not for a move.
const MONOTONIC_SLACK = 0.05;

const WEB_EVENTS = [
  "timeupdate", "ended", "play", "pause", "playing", "error", "stalled", "waiting", "progress",
  "loadstart", "loadedmetadata", "loadeddata", "durationchange", "canplay", "canplaythrough",
  "seeking", "seeked", "ratechange", "volumechange", "emptied",
];

const registry = new Map();
// This document's token: the app releases what an EARLIER document left
// playing the moment this one makes its first player (NativeAudio.kt).
const PAGE = Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
let pageHideHooked = false;

function releaseAllNative(e) {
  if (e && e.persisted) return;
  for (const el of [...registry.values()]) el.release();
}

function receive(id, s) {
  const el = registry.get(id);
  if (el && s && typeof s === "object") el._onState(s);
}

function bridge() {
  return typeof window !== "undefined" ? window.NSNative : null;
}

let availability = null;
/** Whether this page runs in an app that can play natively. Asked once. */
export function nativeAudioAvailable() {
  if (availability !== null) return availability;
  const b = bridge();
  try {
    availability = !!(
      b &&
      typeof b.bridgeVersion === "function" &&
      b.bridgeVersion() >= NATIVE_AUDIO_BRIDGE &&
      typeof b.naCreate === "function" &&
      typeof b.nativeAudio === "function" &&
      b.nativeAudio()
    );
  } catch {
    availability = false;
  }
  return availability;
}

// The app's players run the Rust chain (the EQ, the bass lift) and the rhythm
// analyser on their own sound from bridge version 6 (NativeAnalysis.kt).
export const NATIVE_DSP_BRIDGE = 6;
let dsp = null;
/** Whether the app's players apply the EQ and the bass lift, and analyse what they play. */
export function nativeDspAvailable() {
  if (dsp !== null) return dsp;
  const b = bridge();
  try {
    dsp = !!(
      nativeAudioAvailable() &&
      b.bridgeVersion() >= NATIVE_DSP_BRIDGE &&
      typeof b.naFx === "function" &&
      typeof b.naAnalysis === "function" &&
      typeof b.naAnalysisAvailable === "function" &&
      b.naAnalysisAvailable()
    );
  } catch {
    dsp = false;
  }
  return dsp;
}

/** The native element player `id` (the analysis frames name their player). */
export function nativeElementById(id) {
  return registry.get(id) || null;
}

/** For the tests: forget the cached answer. */
export function resetNativeAudio() {
  availability = null;
  dsp = null;
  fxSent = "";
  registry.clear();
}

// The effects go to the app as they change, the way graph.js applies them to
// its nodes: the app's players all share one setting.
let fxState = { on: false, bands: [], bass: 0 };
let fxSent = "";
function sendFx() {
  if (!nativeDspAvailable()) return;
  const msg = JSON.stringify({
    eq: fxState.on ? fxState.bands.slice(0, 10).map((v) => +v || 0) : [],
    bass: Math.max(0, Math.min(1, +fxState.bass || 0)),
  });
  if (msg === fxSent) return;
  fxSent = msg;
  try {
    bridge().naFx(msg);
  } catch {
    fxSent = "";
  }
}
eqEnabled.subscribe((v) => {
  fxState = { ...fxState, on: !!v };
  sendFx();
});
eqBands.subscribe((v) => {
  fxState = { ...fxState, bands: Array.isArray(v) ? v : [] };
  sendFx();
});
bassBoost.subscribe((v) => {
  fxState = { ...fxState, bass: v };
  sendFx();
});

/** The setting as it stands: the person's choice, or the app's default. */
export function nativeChoiceOn(choice) {
  if (!nativeAudioAvailable()) return false;
  if (choice === true || choice === false) return choice;
  return nativeDspAvailable();
}

// A failure of the app's player ITSELF sends the music back to the page's for
// a day, and for this version of the app only: an update is the likely fix.
export const FAULT_HOLD_MS = 24 * 3600 * 1000;
function appId() {
  try {
    const b = bridge();
    return String((b && typeof b.appVersion === "function" && b.appVersion()) || "");
  } catch {
    return "";
  }
}
/** Whether a recorded fault still keeps the app's player off. */
export function faultHolds(f, at = Date.now()) {
  return !!(f && typeof f.at === "number" && at - f.at >= 0 && at - f.at < FAULT_HOLD_MS && f.app === appId());
}
/** The app's player could not play at all here: the page's takes over. */
export function noteNativeFault(why) {
  const msg = String(why || "app player failed").slice(0, 120);
  logInfo("audio", `app player failed (${msg}): the page's player takes over`, null, { important: true });
  nativeFault.set({ at: Date.now(), app: appId(), why: msg });
}
export function clearNativeFault() {
  nativeFault.set(null);
}
// What only the app's player can get wrong, against what any player would:
// HTMLMediaElement code 3 is the decoder or the audio output (ExoPlayer's
// 4000-5999), and "no player" is the app unable to make one. A network error
// or a source refused would fail the page's player just the same.
function isPlayerFault(code, msg) {
  return code === 3 || (code === 4 && msg === "no player");
}

/** true while the player must play through the app's own player. */
export const nativeAudioWanted = derived(
  [nativePlayer, nativeFault],
  ([choice, fault]) => nativeChoiceOn(choice) && !faultHolds(fault),
);

/** A native element, or null when the app could not make a player. */
export function createNativeElement() {
  if (!nativeAudioAvailable()) return null;
  try {
    const el = new NativeAudioElement(bridge());
    if (el._id) return el;
  } catch {
    /* below */
  }
  // Without a player, asking again on every element would ask for ever.
  noteNativeFault("no player");
  return null;
}

export function isNativeEl(el) {
  return el instanceof NativeAudioElement;
}

function ranges(list) {
  return {
    length: list.length,
    start: (i) => {
      if (i < 0 || i >= list.length) throw new RangeError("index");
      return list[i][0];
    },
    end: (i) => {
      if (i < 0 || i >= list.length) throw new RangeError("index");
      return list[i][1];
    },
  };
}

function abortError(msg) {
  try {
    return new DOMException(msg, "AbortError");
  } catch {
    const e = new Error(msg);
    e.name = "AbortError";
    return e;
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class NativeAudioElement extends EventTarget {
  constructor(b) {
    super();
    this._b = b;
    this._id = 0;
    const id = b.naCreate(PAGE);
    if (typeof window !== "undefined") {
      if (window.__nsAudio !== receive) window.__nsAudio = receive;
      // Leaving the page (a reload, an update) stops what it was playing.
      if (!pageHideHooked && typeof window.addEventListener === "function") {
        pageHideHooked = true;
        window.addEventListener("pagehide", releaseAllNative);
      }
    }
    this._id = Number.isInteger(id) && id > 0 ? id : 0;
    if (this._id) registry.set(this._id, this);
    this._seq = 0;
    this._pSeq = 0; // last play/pause
    this._tSeq = 0; // last seek or load
    this._srcSeq = 0; // last load
    this._src = "";
    this._dirty = false;
    this._web = null;
    this._webOn = false;
    this._vol = 1;
    this._muted = false;
    this._rate = 1;
    this._released = false;
    this.preload = "auto";
    this.autoplay = false;
    this.preservesPitch = true;
    this.webkitPreservesPitch = true;
    this.defaultPlaybackRate = 1;
    this._plays = [];
    this._chase = false;
    this._appBg = false; // the app's activity is stopped (bridge 8: `bg` on every state)
    this._nextSent = "";
    this._advKey = ""; // the key of the track the app went on to by itself
    this._advPending = false; // ...which the page has not taken over yet
    this._advFired = false;
    this._clear();
  }

  _clear() {
    this._t = 0;
    this._at = now();
    this._lastOut = 0;
    this._d = NaN;
    this._st = 0;
    this._paused = true;
    this._ended = false;
    this._buf = 0;
    this._seekable = false;
    this._err = null;
    this._seeking = false;
    this._meta = false;
    this._everReady = false;
  }

  // --- the wire --------------------------------------------------------------

  _send(op, extra) {
    if (!this._id || this._released) return 0;
    const c = ++this._seq;
    try {
      this._b.naCmd(this._id, JSON.stringify({ c, op, ...extra }));
    } catch {
      /* the activity is going away */
    }
    return c;
  }

  _fire(type) {
    // Until the page takes over a track the app went on to, every event would
    // be read as being about the track the page still thinks is playing.
    if (this._advPending && type !== "nsadvance") return;
    this.dispatchEvent(new Event(type));
  }

  _later(...types) {
    Promise.resolve().then(() => {
      for (const t of types) this._fire(t);
    });
  }

  _settlePlays(err) {
    const p = this._plays;
    this._plays = [];
    for (const { resolve, reject } of p) err ? reject(err) : resolve();
  }

  _onState(s) {
    if (this._webOn || this._released) return;
    const c = +s.c || 0;
    if (c < this._srcSeq) return; // about a source we have since replaced
    if (s.ev === "error") {
      this._err = { code: [1, 2, 3, 4].includes(s.code) ? s.code : 2, message: String(s.msg || "") };
      // Before the event: whoever handles it already reads the page's player as the one wanted.
      if (isPlayerFault(this._err.code, this._err.message)) noteNativeFault(this._err.message || "code " + this._err.code);
      this._settlePlays(Object.assign(new Error(this._err.message || "native playback failed"), { name: "NotSupportedError" }));
      this._fire("error");
      return;
    }
    if (typeof s.k === "string" && s.k && s.k !== this._advKey) {
      // The app went on to the track the page named (its first state about it,
      // or the first one the page hears after a freeze).
      this._advKey = s.k;
      this._advPending = true;
      if (typeof s.u === "string" && s.u) this._src = s.u;
      // The app still holds the rest of the list: whatever is sent next goes.
      this._nextSent = null;
      this._d = NaN;
      this._ended = false;
      this._meta = false;
      this._everReady = false;
      this._err = null;
      this._seeking = false;
      this._lastOut = 0;
      this._advFired = true;
      // Player.svelte moves its queue on now; it takes the source over (adopt)
      // once this state has been read, before the next one arrives.
      this._fire("nsadvance");
    }
    if (typeof s.sc === "boolean") this._chase = s.sc;
    if (typeof s.bg === "boolean") this._appBg = s.bg;
    const prevSt = this._st;
    const prevD = this._d;
    const prevBuf = this._buf;
    if (typeof s.st === "number") this._st = s.st;
    if (typeof s.d === "number" && s.d > 0 && isFinite(s.d)) this._d = s.d;
    if (typeof s.b === "number") this._buf = s.b;
    this._seekable = !!s.sk;
    let pauseFlip = null;
    if (c >= this._pSeq && typeof s.p === "boolean" && s.p === this._paused && this._st !== ST_ENDED) {
      // The native side changed it on its own: audio focus lost, headphones out.
      this._paused = !s.p;
      pauseFlip = this._paused ? "pause" : "play";
    }
    if (c >= this._tSeq && typeof s.t === "number" && isFinite(s.t)) {
      this._t = Math.max(0, s.t);
      this._at = now();
    }
    if (s.ev === "seeked" && c >= this._tSeq) {
      this._seeking = false;
      this._lastOut = this._t;
      this._fire("timeupdate");
      this._fire("seeked");
    }
    if (pauseFlip) {
      this._fire(pauseFlip);
      if (pauseFlip === "pause") this._settlePlays(abortError("paused by the system"));
    }
    if (this._d !== prevD && !(isNaN(prevD) && isNaN(this._d))) {
      if (!this._meta) {
        this._meta = true;
        this._fire("durationchange");
        this._fire("loadedmetadata");
      } else this._fire("durationchange");
    }
    if (this._st === ST_READY && prevSt !== ST_READY) {
      if (!this._meta) {
        this._meta = true;
        this._fire("loadedmetadata");
      }
      if (!this._everReady) {
        this._everReady = true;
        this._fire("loadeddata");
      }
      this._fire("canplay");
      this._fire("canplaythrough");
      if (!this._paused) {
        this._fire("playing");
        this._settlePlays(null);
      }
    } else if (this._st === ST_BUFFERING && prevSt === ST_READY && !this._paused && !this._seeking) {
      this._fire("waiting");
    }
    if (this._buf !== prevBuf) this._fire("progress");
    if (this._st === ST_ENDED && prevSt !== ST_ENDED && c >= this._tSeq) {
      this._ended = true;
      if (isFinite(this._d)) this._t = this._d;
      this._fire("timeupdate");
      if (!this._paused) {
        this._paused = true;
        this._fire("pause");
      }
      this._fire("ended");
      return;
    }
    if (s.ev === "tick" && !this._paused && this._st === ST_READY && !this._seeking) this._fire("timeupdate");
  }

  // --- the next track, played by the app on its own --------------------------

  /** Whether the app can go on to a next track by itself. */
  get canChain() {
    if (this._released || this._webOn || !this._id) return false;
    try {
      return this._b.bridgeVersion() >= NATIVE_NEXT_BRIDGE;
    } catch {
      return false;
    }
  }

  /** Whether the app keeps the list while visible and owns the background transitions. */
  get ownsBackground() {
    if (!this.canChain) return false;
    try {
      return this._b.bridgeVersion() >= NATIVE_OWN_BRIDGE;
    } catch {
      return false;
    }
  }

  /** Whether the app's activity is stopped (screen off, another app), as its last state said. */
  get appInBackground() {
    return !!this._appBg && this.ownsBackground;
  }

  /**
   * The tracks that follow, in order, played by the app as each one ends:
   * `[{url, at, e, v, k, meta}]` (`at` where it starts, `e` where its audio
   * ends — 0 for the file's end —, `v` its volume, `k` its key, `meta` what the
   * notification shows); empty for none. `end` is where the CURRENT track's
   * audio ends (0: its file's end).
   */
  setNext(list, end = 0) {
    if (!this.canChain) return;
    const own = this.ownsBackground;
    const q = (Array.isArray(list) ? list : [])
      .filter((n) => n && n.url)
      .map((n) => {
        const o = { url: n.url, at: +n.at || 0, v: +n.v || 0, k: String(n.k || ""), meta: n.meta || null };
        if (own) o.e = +n.e > 0 ? +n.e : 0;
        return o;
      });
    const cut = own && +end > 0 ? +end : 0;
    const msg = q.length ? JSON.stringify(q) + "|" + cut : "";
    if (msg === this._nextSent) return;
    this._nextSent = msg;
    this._send("next", own ? { q, end: cut } : { q });
  }

  /** The key of the track the app went on to and the page has not taken over, or "". */
  get advancedKey() {
    return this._advPending ? this._advKey : "";
  }

  /**
   * The page takes over the track the app went on to: the element is now
   * about it, and says so the way a load would, at the point it has reached.
   */
  adopt(key) {
    if (!this._advPending || key !== this._advKey) return false;
    this._advPending = false;
    this._advFired = false;
    this._dirty = false;
    const types = ["loadstart"];
    if (isFinite(this._d) || this._st === ST_READY) {
      this._meta = true;
      types.push("durationchange", "loadedmetadata");
    }
    if (this._st === ST_READY) {
      this._everReady = true;
      types.push("loadeddata", "canplay", "canplaythrough");
      if (!this._paused) types.push("playing");
    }
    this._later(...types);
    return true;
  }

  /** The page will not take it over (it loads a source of its own instead). */
  dropAdvance() {
    this._advPending = false;
    this._advFired = false;
  }

  // --- the element -----------------------------------------------------------

  // Played in the page rather than by the app: a local object (an offline
  // download's blob) the native side cannot fetch. Anything else, whatever its
  // scheme, goes to the app, which only ever opens the server's own URLs.
  _isWebSrc(url) {
    let scheme;
    try {
      scheme = new URL(url, typeof location !== "undefined" ? location.href : undefined).protocol;
    } catch {
      return false;
    }
    return scheme === "blob:" || scheme === "data:";
  }

  _ensureWeb() {
    if (this._web) return this._web;
    const w = new Audio();
    for (const t of WEB_EVENTS)
      w.addEventListener(t, () => {
        if (this._webOn) this._fire(t);
      });
    this._web = w;
    return w;
  }

  get src() {
    return this._src;
  }
  set src(url) {
    this._src = url == null ? "" : String(url);
    this._dirty = true;
    Promise.resolve().then(() => {
      if (this._dirty) this.load();
    });
  }
  get currentSrc() {
    return this._src;
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
  getAttribute(name) {
    return name === "src" && this._src ? this._src : null;
  }

  load() {
    this._dirty = false;
    if (this._released) return;
    this.dropAdvance();
    this._advKey = "";
    this._nextSent = "";
    this._settlePlays(abortError("the source changed"));
    const hadSomething = this._st !== 0 || this._webOn;
    const web = this._isWebSrc(this._src);
    this._clear();
    this.playbackRate = this.defaultPlaybackRate;
    if (web) {
      this._srcSeq = this._tSeq = this._pSeq = this._send("clear");
      const w = this._ensureWeb();
      this._webOn = true;
      w.preload = this.preload;
      w.preservesPitch = this.preservesPitch;
      w.defaultPlaybackRate = this.defaultPlaybackRate;
      w.playbackRate = this._rate;
      w.volume = this._vol;
      w.muted = this._muted;
      w.src = this._src;
      w.load();
      return;
    }
    if (this._webOn) {
      this._webOn = false;
      try {
        this._web.pause();
        this._web.removeAttribute("src");
        this._web.load();
      } catch {
        /* ignore */
      }
    }
    if (!this._src) {
      this._srcSeq = this._tSeq = this._pSeq = this._send("clear");
      if (hadSomething) this._later("emptied");
      return;
    }
    this._st = ST_IDLE;
    this._srcSeq = this._tSeq = this._pSeq = this._send("src", {
      url: new URL(this._src, typeof location !== "undefined" ? location.href : undefined).href,
      pre: this.preload !== "none",
      v: this._muted ? 0 : this._vol,
      r: this._rate,
    });
    if (hadSomething) this._later("emptied", "loadstart");
    else this._later("loadstart");
  }

  play() {
    if (this._webOn) return this._web.play();
    if (this._released) return Promise.reject(abortError("released"));
    if (this._dirty) this.load();
    const wasPaused = this._paused;
    if (this._ended) {
      this._ended = false;
      this.currentTime = 0;
    }
    this._paused = false;
    this._pSeq = this._send("play");
    this._at = now();
    if (wasPaused) this._later("play");
    if (this._st === ST_READY) {
      if (wasPaused) this._later("playing");
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this._plays.push({ resolve, reject }));
  }

  pause() {
    if (this._webOn) return this._web.pause();
    if (this._paused) return;
    this._t = this.currentTime;
    this._at = now();
    this._paused = true;
    this._pSeq = this._send("pause");
    this._settlePlays(abortError("paused"));
    this._later("timeupdate", "pause");
  }

  get paused() {
    return this._webOn ? this._web.paused : this._paused;
  }
  get ended() {
    return this._webOn ? this._web.ended : this._ended;
  }
  get seeking() {
    return this._webOn ? this._web.seeking : this._seeking;
  }
  get duration() {
    return this._webOn ? this._web.duration : this._d;
  }
  get error() {
    return this._webOn ? this._web.error : this._err;
  }
  get readyState() {
    if (this._webOn) return this._web.readyState;
    if (this._st === ST_READY || this._st === ST_ENDED) return 4;
    if (this._st === ST_BUFFERING) return this._everReady ? 2 : this._meta ? 1 : 0;
    return this._meta ? 1 : 0;
  }
  get networkState() {
    if (this._webOn) return this._web.networkState;
    return this._src ? (this._st === ST_BUFFERING ? 2 : 1) : 0;
  }

  get currentTime() {
    if (this._webOn) return this._web.currentTime;
    let v = this._t;
    if (!this._paused && this._st === ST_READY && !this._seeking) v += ((now() - this._at) / 1000) * this._rate;
    if (isFinite(this._d)) v = Math.min(v, this._d);
    if (!this._seeking && v < this._lastOut && this._lastOut - v < MONOTONIC_SLACK) v = this._lastOut;
    this._lastOut = v;
    return v;
  }
  set currentTime(t) {
    if (this._webOn) {
      this._web.currentTime = t;
      return;
    }
    const x = Math.max(0, +t || 0);
    this._t = x;
    this._at = now();
    this._lastOut = x;
    this._ended = false;
    this._seeking = true;
    this._tSeq = this._send("seek", { t: x });
    this._later("seeking");
  }

  get volume() {
    return this._vol;
  }
  set volume(v) {
    const x = Math.min(1, Math.max(0, +v));
    if (!isFinite(x)) throw new TypeError("volume");
    if (x === this._vol) return;
    this._vol = x;
    if (this._webOn) this._web.volume = x;
    else if (!this._muted) this._send("volume", { v: x });
    this._later("volumechange");
  }
  get muted() {
    return this._muted;
  }
  set muted(m) {
    const x = !!m;
    if (x === this._muted) return;
    this._muted = x;
    if (this._webOn) this._web.muted = x;
    else this._send("volume", { v: x ? 0 : this._vol });
    this._later("volumechange");
  }
  get playbackRate() {
    return this._rate;
  }
  set playbackRate(r) {
    const x = +r;
    if (!(x > 0) || !isFinite(x)) return;
    if (x === this._rate) return;
    this._t = this.currentTime;
    this._at = now();
    this._rate = x;
    if (this._webOn) this._web.playbackRate = x;
    else this._send("rate", { r: x });
    this._later("ratechange");
  }

  get buffered() {
    if (this._webOn) return this._web.buffered;
    return ranges(this._buf > 0 ? [[0, this._buf]] : []);
  }
  get seekable() {
    if (this._webOn) return this._web.seekable;
    // A stream with no length is still seekable: the app holds the seek until it can land.
    if (this._chase && this._st !== 0) return ranges([[0, isFinite(this._d) ? this._d : Infinity]]);
    return ranges(this._seekable && isFinite(this._d) ? [[0, this._d]] : []);
  }

  /** Let the native player go. The element is dead afterwards. */
  release() {
    if (this._released) return;
    this._send("release");
    this._released = true;
    registry.delete(this._id);
    this._settlePlays(abortError("released"));
    if (this._web) {
      try {
        this._web.pause();
        this._web.removeAttribute("src");
        this._web.load();
      } catch {
        /* ignore */
      }
      this._web = null;
      this._webOn = false;
    }
  }
}

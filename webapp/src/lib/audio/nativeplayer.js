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
// Only what the player uses is here. A `blob:` source (a track downloaded into
// IndexedDB) cannot be read by the native side, so the element plays it on a
// real <audio> inside it, re-dispatching its events: until downloads move to
// native storage, those play the way they always did.

import { derived } from "svelte/store";
import { nativePlayer } from "../stores.js";

// ExoPlayer's playback states, as the native side reports them.
export const ST_IDLE = 1;
export const ST_BUFFERING = 2;
export const ST_READY = 3;
export const ST_ENDED = 4;

// The bridge version that has naCreate / naCmd.
export const NATIVE_AUDIO_BRIDGE = 4;

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

/** For the tests: forget the cached answer. */
export function resetNativeAudio() {
  availability = null;
  registry.clear();
}

/** true while the player must play through the app's own player. */
export const nativeAudioWanted = derived(nativePlayer, (on) => !!on && nativeAudioAvailable());

/** A native element, or null when the app could not make a player. */
export function createNativeElement() {
  if (!nativeAudioAvailable()) return null;
  try {
    const el = new NativeAudioElement(bridge());
    return el._id ? el : null;
  } catch {
    return null;
  }
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
      this._settlePlays(Object.assign(new Error(this._err.message || "native playback failed"), { name: "NotSupportedError" }));
      this._fire("error");
      return;
    }
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

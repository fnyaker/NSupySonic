// Downloads kept by the Android app rather than in IndexedDB (lot N4,
// android/…/OfflineStore.kt). The page still owns what it LISTS — the record
// in `meta`, the cover — and the app owns the audio: it fetches the stream
// itself and keeps it as a file, so a 40 MB FLAC never sits in the renderer as
// a Blob, and the native player reads it straight off the disk.
//
// The page plays such a download from `<origin>/__nsoffline/<key>`: the app
// answers that URL from the file (byte ranges included), with no network, for
// the page's <audio> element and for its own player alike.

const BRIDGE = 5;
const PATH = "/__nsoffline/";
// A piece of a download moved in from IndexedDB: 768 KiB, a multiple of 3 so
// every piece is whole base64 (no padding mid-file), 1 MiB of text a call.
const PIECE = 768 * 1024;

let known = null; // cached availability
const pending = new Map(); // key -> { resolve, reject, onProgress }
const stored = new Set(); // keys the app holds

function bridge() {
  return typeof window !== "undefined" ? window.NSNative : null;
}

/** Whether downloads go to the app's storage. */
export function nativeOfflineAvailable() {
  if (known !== null) return known;
  const n = bridge();
  try {
    known = !!(n && typeof n.bridgeVersion === "function" && n.bridgeVersion() >= BRIDGE &&
      typeof n.offAvailable === "function" && n.offAvailable());
  } catch {
    known = false;
  }
  return known;
}

/** For tests: forget the cached answer and what is stored. */
export function resetNativeOffline() {
  known = null;
  stored.clear();
  for (const p of pending.values()) p.reject(new Error("reset"));
  pending.clear();
}

export const KEY_RE = /^[A-Za-z0-9:_-]{1,96}$/;

/** The URL a stored download plays from. */
export function nativeOfflineUrl(key) {
  const base = typeof location !== "undefined" ? location.origin : "http://localhost";
  return base + PATH + encodeURIComponent(String(key));
}

export function nativeHas(key) {
  return stored.has(String(key));
}

/** What the app holds: [{id, type, size}]. Fills the index nativeHas reads. */
export function nativeList() {
  if (!nativeOfflineAvailable()) return [];
  let rows = [];
  try {
    rows = JSON.parse(bridge().offList() || "[]");
  } catch {
    rows = [];
  }
  stored.clear();
  for (const r of rows) if (r && r.id) stored.add(String(r.id));
  return rows;
}

if (typeof window !== "undefined") {
  window.__nsOffline = (ev) => {
    if (!ev || !ev.id) return;
    const p = pending.get(String(ev.id));
    if (!p) return;
    if (ev.st === "progress") {
      if (p.onProgress) p.onProgress(ev.t > 0 ? ev.r / ev.t : null);
    } else if (ev.st === "done") {
      pending.delete(String(ev.id));
      stored.add(String(ev.id));
      p.resolve({ size: +ev.size || 0, type: ev.type || "" });
    } else if (ev.st === "error") {
      pending.delete(String(ev.id));
      p.reject(new Error(ev.msg || "download failed"));
    }
  };
}

/**
 * Has the app download the server's `url` as `key`. Resolves {size, type};
 * rejects with the app's reason.
 */
export function nativeDownload(key, url, onProgress = null) {
  key = String(key);
  if (!KEY_RE.test(key)) return Promise.reject(new Error("bad key"));
  if (pending.has(key)) return Promise.reject(new Error("already downloading"));
  const abs = new URL(url, typeof location !== "undefined" ? location.href : undefined).href;
  return new Promise((resolve, reject) => {
    pending.set(key, { resolve, reject, onProgress });
    let ok = false;
    try {
      ok = bridge().offDownload(key, abs);
    } catch {
      ok = false;
    }
    if (!ok) {
      pending.delete(key);
      reject(new Error("refused by the app"));
    }
  });
}

export function nativeRemove(key) {
  stored.delete(String(key));
  if (!nativeOfflineAvailable()) return;
  try {
    bridge().offRemove(String(key));
  } catch {
    /* best effort */
  }
}

export function nativeClear() {
  stored.clear();
  if (!nativeOfflineAvailable()) return;
  try {
    bridge().offClear();
  } catch {
    /* best effort */
  }
}

export function nativeFree() {
  try {
    return nativeOfflineAvailable() ? +bridge().offFree() || 0 : 0;
  } catch {
    return 0;
  }
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

/**
 * Hands a Blob the page holds over to the app as `key`, piece by piece,
 * yielding between pieces so the page stays fluid. Resolves the stored size;
 * rejects when the app refuses a piece (the partial file is the app's to drop:
 * the next try starts it again from zero).
 */
export async function nativeAdopt(key, blob) {
  key = String(key);
  if (!KEY_RE.test(key)) throw new Error("bad key");
  const n = bridge();
  for (let off = 0; off < blob.size; off += PIECE) {
    const buf = new Uint8Array(await blob.slice(off, off + PIECE).arrayBuffer());
    if (!n.offPut(key, off, toBase64(buf))) throw new Error("piece refused at " + off);
    await yieldFrame();
  }
  const size = +n.offCommit(key, blob.type || "audio/flac");
  if (!(size > 0) || size !== blob.size) {
    try {
      n.offRemove(key);
    } catch {
      /* best effort */
    }
    throw new Error(`stored ${size} of ${blob.size} bytes`);
  }
  stored.add(key);
  return size;
}

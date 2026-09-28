// Which player this is, for a remote-control link to point at.
//
// A link drives ONE device — the one it was made on — so every tab of the app
// needs a stable name for its device: a random id kept in localStorage (the
// same one after a reload, a restart, an app update), plus a human label the
// owner recognises in the list of links ("Android · app NSupySonic").

const KEY = "remote.device";
const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

function randomId() {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = new Uint8Array(18);
  (globalThis.crypto || {}).getRandomValues?.(bytes);
  let s = "";
  for (const b of bytes) s += abc[b & 63];
  return s;
}

let cached = null;
export function deviceId() {
  if (cached) return cached;
  try {
    const v = localStorage.getItem(KEY);
    if (v && ID_RE.test(v)) return (cached = v);
    const id = randomId();
    localStorage.setItem(KEY, id);
    return (cached = id);
  } catch {
    // No storage: a per-page id still works for as long as the page lives.
    return (cached = randomId());
  }
}

export function deviceName(ua = typeof navigator === "undefined" ? "" : navigator.userAgent || "") {
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Appareil";
  const app = /NSupySonicApp/.test(ua)
    ? "app NSupySonic"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "navigateur";
  return `${os} · ${app}`;
}

// Extract a dominant/vibrant color from a cover image for Spotify-style
// gradient headers. Deezer CDN images are CORS-enabled, so the canvas isn't
// tainted; if extraction fails for any reason we fall back to a neutral purple.

import { loResCover } from "./format.js";

const cache = new Map();
const CACHE_MAX = 200; // bounded: a long browse session shouldn't grow forever
// Extractions already running, keyed by URL — two views asking for the same
// cover at once (the header and the now-playing backdrop) shared one decode
// instead of racing two.
const inFlight = new Map();
const FALLBACK = [60, 40, 90];

function remember(url, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(url, value);
}

export function dominantColor(url) {
  if (!url) return Promise.resolve(FALLBACK);
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  const running = inFlight.get(url);
  if (running) return running;
  // The canvas below is 24px — the tiny Deezer variant (a few KB) is plenty.
  // Fetching the full 500px in CORS mode re-downloaded the whole cover just
  // for this. Non-Deezer URLs (local art, blobs) pass through unchanged.
  const fetchUrl = loResCover(url, 96) || url;

  const p = new Promise((resolve) => {
    const img = new Image();
    // crossOrigin is only needed to un-taint the canvas for a CROSS-origin
    // source — and it actively hurts on our own routes: it drops the session
    // cookie, so the login-protected /api/cover and /api/localcover art came
    // back 401 and every local file's header fell back to the default purple.
    if (!sameOrigin(fetchUrl)) img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      try {
        const size = 24;
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let best = FALLBACK;
        let bestScore = -1;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 200) continue;
          const cr = data[i];
          const cg = data[i + 1];
          const cb = data[i + 2];
          r += cr;
          g += cg;
          b += cb;
          n++;
          // Prefer saturated, mid-bright pixels for the accent.
          const max = Math.max(cr, cg, cb);
          const min = Math.min(cr, cg, cb);
          const sat = max === 0 ? 0 : (max - min) / max;
          const lum = max / 255;
          const score = sat * (1 - Math.abs(lum - 0.55));
          if (score > bestScore) {
            bestScore = score;
            best = [cr, cg, cb];
          }
        }
        // If the image is basically grayscale, use the average instead.
        const result = bestScore > 0.15 && n ? best : n ? [r / n, g / n, b / n].map(Math.round) : FALLBACK;
        remember(url, result);
        resolve(result);
      } catch {
        resolve(FALLBACK);
      }
    };
    // No colour to extract (CDN drop, 404): DON'T memoize the fallback — the
    // next visit should get a real colour once the art is reachable again.
    img.onerror = () => resolve(FALLBACK);
    img.src = fetchUrl;
  }).finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}

function sameOrigin(u) {
  if (!u) return true;
  if (u.startsWith("blob:") || u.startsWith("data:")) return true;
  try {
    return new URL(u, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
}

export function rgb([r, g, b], a = 1) {
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${a})`;
}

// Darken a color toward black by `f` (0..1) for readable gradients.
export function darken([r, g, b], f = 0.5) {
  return [r * (1 - f), g * (1 - f), b * (1 - f)];
}

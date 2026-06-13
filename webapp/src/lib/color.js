// Extract a dominant/vibrant color from a cover image for Spotify-style
// gradient headers. Deezer CDN images are CORS-enabled, so the canvas isn't
// tainted; if extraction fails for any reason we fall back to a neutral purple.

const cache = new Map();
const FALLBACK = [60, 40, 90];

export function dominantColor(url) {
  if (!url) return Promise.resolve(FALLBACK);
  if (cache.has(url)) return Promise.resolve(cache.get(url));

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
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
        cache.set(url, result);
        resolve(result);
      } catch {
        resolve(FALLBACK);
      }
    };
    img.onerror = () => resolve(FALLBACK);
    img.src = url;
  });
}

export function rgb([r, g, b], a = 1) {
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${a})`;
}

// Darken a color toward black by `f` (0..1) for readable gradients.
export function darken([r, g, b], f = 0.5) {
  return [r * (1 - f), g * (1 - f), b * (1 - f)];
}

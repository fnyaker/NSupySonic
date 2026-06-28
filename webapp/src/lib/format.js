export function duration(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

export function artists(track) {
  return track && track.artist ? track.artist.name : "";
}

// Human-readable byte size, e.g. 1536 -> "1.5 Ko", 4e9 -> "3.7 Go".
export function bytes(n) {
  n = Number(n) || 0;
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// Deezer CDN covers embed their dimensions in the path, e.g.
// .../cover/<md5>/500x500-000000-80-0-0.jpg. The API hands us 500px art, which
// upscales (blurry) in the full-screen now-playing views, so bump the size in
// the URL for those. Leaves non-Deezer / local covers untouched.
export function hiResCover(url, size = 1000) {
  if (!url || typeof url !== "string") return url;
  return url.replace(/\/\d+x\d+(-[^/]*\.(?:jpg|jpeg|png|webp))/i, `/${size}x${size}$1`);
}

// A tiny variant of a Deezer cover, used as an instant low-quality placeholder
// while the full-size art loads (it downloads in a few KB). Returns null when
// the URL has no Deezer dimensions to shrink (local / non-Deezer covers), so
// the caller can skip the placeholder.
export function loResCover(url, size = 48) {
  if (!url || typeof url !== "string") return null;
  const out = url.replace(/\/\d+x\d+(-[^/]*\.(?:jpg|jpeg|png|webp))/i, `/${size}x${size}$1`);
  return out === url ? null : out;
}

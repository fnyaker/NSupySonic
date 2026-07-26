export function duration(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  // Podcast episodes and long albums run past an hour — show h:mm:ss then,
  // otherwise m:ss (never a bare "92:15").
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

// The canonical rendered size of a Deezer cover — the 500px art the API hands
// out and that the browser HTTP-caches from browsing/notifications. Used as an
// offline fallback for the full-screen views' hi-res URL, whose bumped size was
// never fetched online and so isn't in the cache. Non-Deezer URLs pass through.
export function baseCover(url, size = 500) {
  if (!url || typeof url !== "string") return url;
  return url.replace(/\/\d+x\d+(-[^/]*\.(?:jpg|jpeg|png|webp))/i, `/${size}x${size}$1`);
}

// A resolution-independent key for a Deezer cover: collapses the embedded WxH
// so every size of the same art (the 500px we cache, the 1000/1500px the
// full-screen views request) maps to ONE offline-cache entry. Non-Deezer URLs
// (local covers) are returned unchanged.
export function coverKey(url) {
  if (!url || typeof url !== "string") return url;
  return url.replace(/\/\d+x\d+(-[^/]*\.(?:jpg|jpeg|png|webp))/i, "/x$1");
}

// Resolve a cover URL to the best available source: the offline cache blob for
// that art (any resolution) if we have it, else the URL itself. `covers` is the
// offlineCovers map. Used for CSS backgrounds that can't go through Cover.svelte.
export function resolveCover(covers, url) {
  if (!url) return url;
  return (covers && covers[coverKey(url)]) || url;
}

// A safe CSS `url(…)` value for an inline style. An UNQUOTED url() is invalid
// as soon as the URL contains a parenthesis, a space or a quote — and an empty
// one (`url()`) drops the whole declaration — so backdrops silently vanished on
// perfectly ordinary art. Quotes + escapes, and `none` when there's no image.
export function cssUrl(u) {
  if (!u) return "none";
  return `url("${String(u).replace(/[\\"]/g, "\\$&").replace(/[\n\r]/g, "")}")`;
}

// True for a LOCAL entity id (a uuid) as opposed to a numeric Deezer id.
// `/api/cover/<id>` resolves a uuid to whatever local row owns it (album,
// artist, playlist, podcast, track) but treats a NUMERIC id as a *track* id —
// so only a uuid is a safe cover fallback for a non-track entity.
export function isLocalId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(id);
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

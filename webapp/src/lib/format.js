export function duration(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

export function artists(track) {
  return track && track.artist ? track.artist.name : "";
}

// Deezer CDN covers embed their dimensions in the path, e.g.
// .../cover/<md5>/500x500-000000-80-0-0.jpg. The API hands us 500px art, which
// upscales (blurry) in the full-screen now-playing views, so bump the size in
// the URL for those. Leaves non-Deezer / local covers untouched.
export function hiResCover(url, size = 1000) {
  if (!url || typeof url !== "string") return url;
  return url.replace(/\/\d+x\d+(-[^/]*\.(?:jpg|jpeg|png|webp))/i, `/${size}x${size}$1`);
}

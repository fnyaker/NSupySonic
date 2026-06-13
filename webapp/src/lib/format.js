export function duration(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

export function artists(track) {
  return track && track.artist ? track.artist.name : "";
}

// The YouTube fallback, client side (server: supysonic/deezer/youtube.py).
//
// YouTube is reached only when somebody asks for it — the search screen's box,
// the replacement sheet's button — so nothing here runs on its own: the status
// is read once (is it installed, did the admin switch it off) and a track's
// real bitrate is asked of OUR server, never of YouTube.
import { writable } from "svelte/store";
import { api } from "./api.js";

export const youtubeStatus = writable(null);

let inflight = null;
export function loadYoutubeStatus(force = false) {
  if (inflight && !force) return inflight;
  inflight = api
    .youtubeStatus()
    .then((s) => {
      youtubeStatus.set(s);
      return s;
    })
    .catch(() => {
      inflight = null; // a failed read is asked again next time
      return null;
    });
  return inflight;
}

export async function setYoutubeEnabled(enabled) {
  const s = await api.setYoutubeEnabled(enabled);
  youtubeStatus.set(s);
  inflight = Promise.resolve(s);
  return s;
}

export const isYoutube = (t) => t?.source === "youtube";

// What a quality setting asks for, in kbit/s. FLAC is "all there is".
export function askedKbps(quality) {
  if (quality === "FLAC") return Infinity;
  const m = /^OPUS_(\d+)$/.exec(quality || "");
  return m ? +m[1] : Infinity;
}

// The badge says what the file really is when the setting asks for MORE than
// that: YouTube's best is Opus around 130-160 kbit/s, and a "FLAC" or "Opus
// 320" label over it would claim a quality nobody is hearing. Asking for less
// gets a real transcode (the server's rule), so the label is then the truth.
// `real` 0 means not known yet: still worth saying where it comes from.
export function realBitrateBadge(track, quality, real) {
  if (!isYoutube(track)) return null;
  const kbps = real || track.bitrate || 0;
  const asked = askedKbps(quality);
  if (kbps && asked <= kbps) return null;
  return {
    short: kbps ? `YT ${kbps}k` : "YT",
    title: kbps
      ? `Source YouTube : Opus ~${kbps} kbit/s. Ce titre n'existe pas en meilleure qualité, il est lu tel quel.`
      : "Source YouTube : Opus ~130-160 kbit/s, lu tel quel.",
  };
}

// A track's archived bitrate, read once per track from /probe (a database
// read on our server; it never reaches YouTube). Only asked while the queue's
// copy of the track does not know it — a hit from a search, played for the
// first time, is archived by that very play.
const known = new Map();
export async function realBitrate(track) {
  if (!isYoutube(track)) return 0;
  const id = String(track.deezer_id);
  if (track.bitrate) return track.bitrate;
  if (known.has(id)) return known.get(id);
  try {
    const r = await api.probeTrack(id);
    const kbps = +r?.bitrate || 0;
    if (kbps) known.set(id, kbps);
    return kbps;
  } catch {
    return 0;
  }
}

// The YouTube fallback, client side (server: supysonic/deezer/youtube.py).
//
// YouTube is reached only when somebody asks for it — the search screen's box,
// the replacement sheet's button — so nothing here runs on its own. Whether it
// is on, and where it stands among the sources, is lib/sources.js; a track's
// real bitrate is asked of OUR server, never of YouTube.
import { api } from "./api.js";
import { trackKey, trackRef } from "./trackkey.js";

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
  const id = trackKey(track);
  if (track.bitrate) return track.bitrate;
  if (known.has(id)) return known.get(id);
  try {
    const r = await api.probeTrack(trackRef(track));
    const kbps = +r?.bitrate || 0;
    if (kbps) known.set(id, kbps);
    return kbps;
  } catch {
    return 0;
  }
}

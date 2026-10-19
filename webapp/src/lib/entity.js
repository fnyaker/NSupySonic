// The one identity of an album, an artist or a playlist in the app: its row's
// `id` (a UUID), whichever provider the entity came from.
//
// Pages, cards and search hits the library holds say `id`. A TRACK of the
// library does not repeat it for its album and its artists (a 4 000-track list
// would carry two or three UUIDs more on every row, 28% more bytes): they are
// rows too, and every row with a provider id was created under the UUID that
// id hashes to (`ids.album_uuid`, `ids.artist_uuid` in Python, pinned by
// entity.test.mjs), so the UUID is computed here when the track has a row of
// its own (`track.id`). A catalogue result has no row, hence no `id`: its
// entities are opened by the provider's id, the only form the server can still
// turn into a page.
//
//   entityRef(x)               what a link names x by: `id`, else the provider id.
//   trackEntityRef(t, kind, x) the same for the album / artist / credit `x` of the
//                              track `t`; "" where there is nothing to open (a
//                              YouTube hit's album).
//
// State written by an older build carries the provider id only; the server
// opens a page by it too.

import { nsBytes, uuid5 } from "./trackkey.js";

// `ids.NS_ALBUM`, `ids.NS_ARTIST`.
const NS = {
  album: nsBytes("a5bac9ee-7669-5006-800f-fd646bea2ca3"),
  artist: nsBytes("bdd5399e-d7eb-5374-8b16-10e873164bd8"),
};

const DIGITS = /^[0-9]{1,20}$/;
const memo = { album: new Map(), artist: new Map() };
const MEMO_MAX = 5000;

export function entityRef(x) {
  if (!x) return "";
  const ref = x.id || x.deezer_id;
  return ref ? String(ref) : "";
}

export function trackEntityRef(track, kind, x) {
  if (!x) return "";
  if (x.id) return String(x.id);
  const dz = x.deezer_id ? String(x.deezer_id) : "";
  if (!track || !track.id || !DIGITS.test(dz) || !NS[kind]) return dz;
  const m = memo[kind];
  let u = m.get(dz);
  if (u === undefined) {
    u = uuid5(NS[kind], dz);
    if (m.size >= MEMO_MAX) m.clear();
    m.set(dz, u);
  }
  return u;
}

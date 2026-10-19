// The one identity of an album, an artist, a playlist or a show in the app: its
// row UUID, the entity twin of trackkey.js.
//
// The server gives every such card an `id`: the row's UUID, or — for a
// catalogue entry that is not in the library yet — the UUID its row WILL have
// (`ids.album_uuid` & co. are deterministic uuid5s of the provider's id), so a
// card has the same key before and after it enters the library.
//
//   entityKey(x, kind)  what lists, stores and caches are keyed on. Tolerates an
//                       older answer that carries only a `deezer_id`.
//   entityRef(x)        what a route or a request names it by. The provider's id
//                       when there is one, else the UUID: a UUID cannot be
//                       inverted into the id it was hashed from, so a card with
//                       no row yet can only be opened by the id it was listed
//                       under (the server takes both forms for a row).
//   canonicalPath(p)    an API path with the provider's id in it, spelled with the
//                       UUID, so `/album/3361` and `/album/<uuid5>` are one entry
//                       of the offline cache.

import { sha1 } from "./trackkey.js";

// `ids.NS_ALBUM` & co. in Python (namespaces derived from "deezer.com/supysonic").
const NAMESPACES = {
  album: "a5bac9ee-7669-5006-800f-fd646bea2ca3",
  artist: "bdd5399e-d7eb-5374-8b16-10e873164bd8",
  playlist: "1dd5061d-0f40-53b0-809b-2c7b2c2daacf",
  show: "3e954095-9b74-5cbf-9dd8-926f3c70ca72",
};

const NS_BYTES = {};
for (const [kind, uuid] of Object.entries(NAMESPACES)) {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  NS_BYTES[kind] = out;
}

const DIGITS = /^[0-9]{1,20}$/;
const memo = new Map();
const MEMO_MAX = 20000;

/** Python's `ids.<kind>_uuid(raw)`, as text; null for a kind or an id that is not one. */
export function entityUuid(kind, raw) {
  const ns = NS_BYTES[kind];
  if (!ns || raw === null || raw === undefined) return null;
  const text = String(raw);
  if (!DIGITS.test(text)) return null;
  const mk = kind + ":" + text;
  let k = memo.get(mk);
  if (k !== undefined) return k;
  const name = new TextEncoder().encode(text);
  const msg = new Uint8Array(16 + name.length);
  msg.set(ns);
  msg.set(name, 16);
  const h = sha1(msg).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < 16; i++) hex += h[i].toString(16).padStart(2, "0");
  k = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(mk, k);
  return k;
}

/** An entity's identity: its row UUID, or the one its row will have. null for none. */
export function entityKey(x, kind) {
  if (!x) return null;
  if (x.id) return String(x.id);
  return entityUuid(kind, x.deezer_id);
}

/** What a route or a request names the entity by (see the header). */
export function entityRef(x) {
  if (!x) return null;
  return String(x.deezer_id || x.id || "") || null;
}

// Pages whose path carries an album / artist / playlist id (query stripped by the caller).
const PATH = /^\/(album|artist|playlist)\/([0-9]{1,20})(?=\/|$)/;

/** `/album/3361/on-deezer` -> `/album/<uuid5>/on-deezer`; any other path as it is. */
export function canonicalPath(path) {
  const s = String(path);
  const m = PATH.exec(s);
  if (!m) return s;
  return "/" + m[1] + "/" + entityUuid(m[1], m[2]) + s.slice(m[0].length);
}

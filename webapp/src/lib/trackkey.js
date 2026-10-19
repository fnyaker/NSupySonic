// The one identity of a track in the app: its row UUID.
//
// The server addresses every track by `id` (a uuid5 of the Deezer id for a
// Deezer track, a stored UUID for an upload, a podcast episode or a YouTube
// hit). A catalogue result that is not in the library yet has no row, hence no
// `id`, only the Deezer id it was listed under, and `ids.track_uuid` (Python)
// is deterministic: the UUID its row WILL have is computable here, so a track
// keeps the same key before and after it enters the library.
//
//   trackKey(t)  what stores, caches and comparisons are keyed on.
//   trackRef(t)  what a request names the track by. The row's `id` when there is
//                one; the Deezer id for a result with no row, which is the only
//                form the server can still turn into a row (a UUID cannot be
//                inverted back to the id it was hashed from).
//   migrateKey   an old stored key (a Deezer id) -> its UUID; anything else as is.

// `ids.NS_TRACK` in Python (a namespace derived from "deezer.com/supysonic" and "track").
const NS_TRACK = "349c6f7c-1d1f-508d-8539-9180c66e5ef7";

/** A namespace UUID as 16 bytes. */
export function nsBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

const NS_BYTES = nsBytes(NS_TRACK);

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

/** SHA-1 of a byte array, as 20 bytes (RFC 3174). uuid5 is defined on it. */
export function sha1(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setInt32(i * 4, h));
  return out;
}

/** Python's `uuid.uuid5(ns, name)`, as text; `ns` is `nsBytes(...)`. */
export function uuid5(ns, name) {
  const text = new TextEncoder().encode(String(name));
  const msg = new Uint8Array(16 + text.length);
  msg.set(ns);
  msg.set(text, 16);
  const h = sha1(msg).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < 16; i++) hex += h[i].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Python's `ids.track_uuid(name)`, as text. */
export function uuid5Track(name) {
  return uuid5(NS_BYTES, name);
}

const DIGITS = /^[0-9]{1,20}$/;
// A list of 4 000 tracks asks for 4 000 keys on every change: hash a Deezer id once.
const memo = new Map();
const MEMO_MAX = 20000;

/** The key for a raw id: a Deezer id (digits) is hashed, anything else (already a UUID) kept. */
export function migrateKey(raw) {
  if (raw === null || raw === undefined || raw === "") return raw;
  const text = String(raw);
  if (!DIGITS.test(text)) return text;
  let k = memo.get(text);
  if (k === undefined) {
    k = uuid5Track(text);
    if (memo.size >= MEMO_MAX) memo.clear();
    memo.set(text, k);
  }
  return k;
}

/** A track's identity: its row UUID, or the UUID its row will have. null for no track. */
export function trackKey(t) {
  if (!t) return null;
  if (t.id) return String(t.id);
  return t.deezer_id ? migrateKey(t.deezer_id) : null;
}

/** What a request names the track by (see the header). */
export function trackRef(t) {
  if (!t) return null;
  return String(t.id || t.deezer_id || "") || null;
}

/** True when two track-ish values are the same track. */
export function sameTrack(a, b) {
  if (a === b) return true;
  const ka = trackKey(a);
  return ka !== null && ka === trackKey(b);
}

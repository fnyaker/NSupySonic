// The genre head's wire format: what the studio sends the server
// (`PUT /api/genre/model`) and what the server hands back for training
// (`POST /api/genre/embeddings`). Base64 float16 both ways — half the bytes for
// a precision nothing downstream can resolve — and read by the server with
// `struct`'s "e" format (supysonic/deezer/genre.py#_decode_f16).

function f32ToF16(value) {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  f[0] = value;
  const x = i[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) return sign; // underflow to signed zero
  if (exp >= 0x1f) return sign | 0x7c00; // overflow to infinity
  mant = mant >> 13;
  return sign | (exp << 10) | mant;
}

/**
 * A head -> the base64 float16 blob the server stores.
 *
 * One flat buffer, in the order the server reads it back: a linear head is
 * W then b; an MLP is W1, b1, W2, b2 (and W3, b3 with a second hidden layer).
 */
export function encodeHead(head) {
  const blocks =
    head.kind === "mlp2"
      ? [head.W1, head.b1, head.W2, head.b2, head.W3, head.b3]
      : head.kind === "mlp"
        ? [head.W1, head.b1, head.W2, head.b2]
        : [head.W, head.b];
  let total = 0;
  for (const blk of blocks) total += blk.length;
  const out = new Uint16Array(total);
  let o = 0;
  for (const blk of blocks) {
    for (let i = 0; i < blk.length; i++) out[o + i] = f32ToF16(blk[i]);
    o += blk.length;
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode blows the stack past ~100k args
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** base64 float16 -> Float32Array, for the vectors the server hands back. */
export function decodeEmbedding(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const half = new Uint16Array(bytes.buffer);
  const out = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) {
    const h = half[i];
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) out[i] = sign * mant * Math.pow(2, -24);
    else if (exp === 0x1f) out[i] = mant ? NaN : sign * Infinity;
    else out[i] = sign * (mant + 1024) * Math.pow(2, exp - 25);
  }
  return out;
}

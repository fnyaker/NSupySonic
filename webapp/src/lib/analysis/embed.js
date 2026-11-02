// The extractor's embedding of ONE track, on this computer: the Rust front-end (measure.wasm:
// patches, log-mel, levels, the 3840-vector) around the operator's own `.onnx`, run by
// onnxruntime-web. The network sees what the server's onnxruntime sees: (count, 128, 96)
// float patches, one 1280-wide row back per patch. Pure of the page: `ort` and the instantiated
// core are passed in, so it runs in a Worker and in node alike.

export const PATCH_SAMPLES = 33024;
export const PATCH_SHAPE = [128, 96];
export const MODEL_DIM = 1280;
export const EMBED_DIM = MODEL_DIM * 3;
/** Patches per network call: the peak memory of the network grows with the batch. */
export const BATCH = 8;

const view = (x, ptr, n) => new Float32Array(x.memory.buffer, ptr, n);

/** float32 -> IEEE half bits, round to nearest even (what struct's "e" writes). */
export function toHalf(v) {
  if (v !== v) return 0x7e00;
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = v;
  const x = u[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let man = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (man ? 0x200 : 0);
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    man |= 0x800000;
    const shift = 14 - exp;
    let h = man >>> shift;
    const rest = man & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rest > half || (rest === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (exp << 10) | (man >>> 13);
  const rest = man & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h++;
  return sign | h;
}

/** The sidecar's layout, base64: EMBED_DIM little-endian halves. */
export function encodeVector(vec) {
  const out = new Uint8Array(vec.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < vec.length; i++) dv.setUint16(i * 2, toHalf(vec[i]), true);
  let s = "";
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * @param x        the instantiated measure core
 * @param session  an `ort.InferenceSession` over the extractor
 * @param ort      the module (for `ort.Tensor`)
 * @param samples  Float32Array, the track as 16 kHz mono
 * @returns Float32Array(EMBED_DIM)
 */
export async function embedSamples(x, session, ort, samples) {
  const count = x.mel_plan(samples.length);
  if (!count) throw new Error("track too short or too long for the extractor");
  for (let k = 0; k < count; k++) {
    const off = x.mel_offset(k);
    const part = samples.subarray(off, Math.min(samples.length, off + PATCH_SAMPLES));
    view(x, x.mel_segment(k), PATCH_SAMPLES).set(part); // the buffer is zeroed: a short end pads
  }
  if (!x.mel_run()) throw new Error("front-end failed");
  const per = PATCH_SHAPE[0] * PATCH_SHAPE[1];
  const patches = view(x, x.mel_patches(), count * per).slice(); // wasm memory may move: own copy
  const input = session.inputNames[0];
  const rows = new Float32Array(count * MODEL_DIM);
  for (let from = 0; from < count; from += BATCH) {
    const n = Math.min(BATCH, count - from);
    const t = new ort.Tensor("float32", patches.subarray(from * per, (from + n) * per), [n, ...PATCH_SHAPE]);
    const outs = await session.run({ [input]: t });
    // the published model has the style activations and the embedding: take the MODEL_DIM wide one
    let pick = null;
    for (const name of session.outputNames) {
      const o = outs[name];
      if (o.dims.length === 2 && o.dims[1] === MODEL_DIM && o.dims[0] === n) pick = o;
    }
    if (!pick) throw new Error(`the extractor has no ${MODEL_DIM}-wide output`);
    rows.set(pick.data, from * MODEL_DIM);
  }
  view(x, x.mel_rows(), count * MODEL_DIM).set(rows);
  const ptr = x.mel_aggregate();
  if (!ptr) throw new Error("aggregation failed");
  return view(x, ptr, EMBED_DIM).slice();
}

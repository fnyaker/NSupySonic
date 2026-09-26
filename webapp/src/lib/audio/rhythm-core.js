// The JavaScript side of the rhythm analyser (webapp/rhythm, compiled to
// src/lib/audio/rhythm.wasm). Shared, unchanged, by the three places that run
// it: the AudioWorklet (rhythm.worklet.js — the normal path), the main-thread
// fallback in engine.js, and the Node tests and eval.
//
// It does as little as possible. The analyser owns every buffer; this writes
// mono samples into its input, calls it, and hands back views of the frames it
// produced. The frame LAYOUT is read from the module itself (a "name:length;"
// string), so nothing here hard-codes an offset the Rust side could move.

const decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

function decodeAscii(bytes) {
  if (decoder) return decoder.decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** "name:len;name:len" -> { len, fields: { name: [offset, length] } } */
export function parseLayout(text) {
  const fields = {};
  let off = 0;
  for (const part of text.split(";")) {
    if (!part) continue;
    const [name, len] = part.split(":");
    const n = +len;
    fields[name] = [off, n];
    off += n;
  }
  return { len: off, fields };
}

export class Rhythm {
  /**
   * @param {WebAssembly.Instance} instance
   * @param {number} sampleRate
   */
  constructor(instance, sampleRate) {
    this.x = instance.exports;
    this.memory = this.x.memory;
    this.sampleRate = sampleRate;
    this.x.rhythm_init(sampleRate);
    this.hop = this.x.rhythm_hop();
    this.lookahead = this.x.rhythm_lookahead();
    this.frameLen = this.x.rhythm_frame_len();
    this.inputCap = this.x.rhythm_input_cap();
    const lp = this.x.rhythm_layout();
    const ll = this.x.rhythm_layout_len();
    this.layoutText = decodeAscii(new Uint8Array(this.memory.buffer, lp, ll));
    this.layout = parseLayout(this.layoutText);
    if (this.layout.len !== this.frameLen) throw new Error("rhythm: layout and frame length disagree");
    this._views();
  }

  /** Instantiate from a compiled module (the worklet) or from bytes (Node). */
  static fromModule(module, sampleRate) {
    return new Rhythm(new WebAssembly.Instance(module, {}), sampleRate);
  }

  static async fromBytes(bytes, sampleRate) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Rhythm(instance, sampleRate);
  }

  // Views into the module's memory, re-made whenever it has grown (a grown
  // memory detaches every view on the old buffer).
  _views() {
    const buf = this.memory.buffer;
    if (this._buf === buf) return;
    this._buf = buf;
    this.input = new Float32Array(buf, this.x.rhythm_input(), this.inputCap);
    this._outPtr = this.x.rhythm_output();
  }

  /**
   * Analyse mono samples. Returns how many frames came out; read them with
   * `frame(i)` before the next call.
   */
  push(samples, count = samples.length) {
    let done = 0;
    let produced = 0;
    this._pending = this._pending || [];
    this._pending.length = 0;
    while (done < count) {
      const n = Math.min(this.inputCap, count - done);
      this._views();
      this.input.set(samples.subarray ? samples.subarray(done, done + n) : samples.slice(done, done + n));
      const k = this.x.rhythm_process(n);
      this._views();
      if (k) {
        // A long push can produce more frames than one call's output holds;
        // copy them out so none is overwritten by the next chunk.
        const all = new Float32Array(this._buf, this._outPtr, k * this.frameLen);
        if (done + n < count) this._pending.push(all.slice());
        else this._last = all;
        produced += k;
      }
      done += n;
    }
    this._count = produced;
    return produced;
  }

  /** The i-th frame of the last push, as a Float32Array view. */
  frame(i) {
    const L = this.frameLen;
    let base = 0;
    for (const block of this._pending || []) {
      const n = block.length / L;
      if (i < base + n) return block.subarray((i - base) * L, (i - base + 1) * L);
      base += n;
    }
    const j = i - base;
    return this._last.subarray(j * L, (j + 1) * L);
  }

  /** Mix a planar stereo block to mono straight into the input. */
  pushStereo(left, right) {
    this._views();
    const n = left.length;
    const inp = this.input;
    if (right && right !== left) for (let i = 0; i < n; i++) inp[i] = (left[i] + right[i]) * 0.5;
    else inp.set(left);
    const k = this.x.rhythm_process(n);
    this._views();
    this._pending = null;
    this._last = k ? new Float32Array(this._buf, this._outPtr, k * this.frameLen) : null;
    this._count = k;
    return k;
  }

  seed(bpm, confidence = 0.9) {
    return !!this.x.rhythm_seed(+bpm || 0, +confidence || 0.9);
  }
  setRange(lo, hi) {
    this.x.rhythm_set_range(+lo || 0, +hi || 0);
  }
  setLiveRange(on) {
    this.x.rhythm_set_live_range(on ? 1 : 0);
  }
  setLevel(level) {
    this.x.rhythm_set_level(level | 0);
  }
  reset() {
    this.x.rhythm_reset();
  }
  /** The genre vocabulary, from lib/audio/style.js#familyTable. */
  loadFamilies(table) {
    const ptr = this.x.rhythm_families(table.length);
    this._buf = null;
    this._views();
    new Float32Array(this.memory.buffer, ptr, table.length).set(table);
    return !!this.x.rhythm_load_families(table.length);
  }
  srcHash() {
    return this.x.rhythm_src_hash() >>> 0;
  }
}

/**
 * Read one frame (a Float32Array in the layout) into plain numbers: `f(name)`
 * for a scalar, `arr(name)` for a view of a vector field.
 */
export function reader(layout, frame) {
  const F = layout.fields;
  return {
    f: (name) => frame[F[name][0]],
    arr: (name) => frame.subarray(F[name][0], F[name][0] + F[name][1]),
  };
}

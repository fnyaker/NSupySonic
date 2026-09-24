// The animations' arithmetic, in Rust (webapp/rhythm/src/viz*.rs).
//
// The same WebAssembly module as the rhythm analyser, instantiated a second
// time on the page: the analyser's instance lives in the AudioWorklet and says
// what the music is doing; this one turns that into what is drawn — the
// oscilloscope's trigger and trace, the bars' levelling. The compiled module is
// shared (lib/audio/rhythm-assets.js#rhythmBinary), so this costs no download
// and no compile of its own.
//
// Everything is created through a HANDLE and allocates nothing once built, so
// a view taken on the module's memory stays valid from frame to frame. The one
// exception is the scope's input, which grows the first time a larger window
// arrives; every view here is re-made whenever the memory's buffer changes,
// which is the only thing that can invalidate one.

let core = null;
let loading = null;

function wrap(instance) {
  const x = instance.exports;
  const memory = x.memory;
  return {
    x,
    memory,
    /** A Float32Array view at `ptr`, `n` long, on the current buffer. */
    f32(ptr, n) {
      return new Float32Array(memory.buffer, ptr, n);
    },
  };
}

/** The core, if it has loaded. */
export function vizCore() {
  return core;
}

/**
 * Load the core (once per page). Rejects when WebAssembly is unavailable or
 * the binary cannot be fetched; a later call tries again.
 */
export function loadVizCore() {
  if (core) return Promise.resolve(core);
  if (!loading) {
    loading = import("../audio/rhythm-assets.js")
      .then(({ rhythmBinary }) => rhythmBinary())
      .then(({ module }) => (core = wrap(new WebAssembly.Instance(module, {}))));
    loading.catch(() => (loading = null));
  }
  return loading;
}

/** For Node (the tests and the benches): the core from the binary's bytes. */
export function vizCoreFromBytes(bytes) {
  core = wrap(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}));
  return core;
}

// A view that follows the memory: re-made when the buffer it was taken on has
// been replaced by a grow, otherwise the same object every frame.
function viewer(c, ptrFn, n) {
  let buf = null;
  let view = null;
  return () => {
    if (buf !== c.memory.buffer) {
      buf = c.memory.buffer;
      view = c.f32(ptrFn(), n);
    }
    return view;
  };
}

/**
 * The oscilloscope (lib/viz/scenes/scope.js draws it; see viz_scope.rs for the
 * arithmetic). `trace()` is the two channels' `[lo, hi]` pairs, channel A in
 * the first MAX_COLS pairs and channel B in the next.
 */
export class ScopeCore {
  constructor(c) {
    this.c = c;
    this.h = c.x.viz_scope_new();
    this.maxCols = c.x.viz_scope_max_cols();
    this.trace = viewer(c, () => c.x.viz_scope_trace(this.h), c.x.viz_scope_trace_len());
    this._state = viewer(c, () => c.x.viz_scope_state(this.h), c.x.viz_scope_state_len());
    this._wave = null;
    this._waveBuf = null;
    this._waveSize = 0;
  }
  config(sc) {
    this.c.x.viz_scope_config(this.h, sc.search || 0, sc.exact ? 1 : 0, sc.fine ? 1 : 0, sc.interp ? 1 : 0);
  }
  cols(n) {
    this.c.x.viz_scope_cols(this.h, Math.min(n, this.maxCols));
  }
  /** One analysis frame's window: `{ left, right, size, sampleRate }`. */
  update(wave, dt) {
    const { x } = this.c;
    const size = wave.size;
    const ptr = x.viz_scope_wave(this.h, size);
    if (this._waveBuf !== this.c.memory.buffer || this._waveSize !== size || this._wavePtr !== ptr) {
      this._waveBuf = this.c.memory.buffer;
      this._waveSize = size;
      this._wavePtr = ptr;
      this._wave = this.c.f32(ptr, size * 2);
    }
    const w = this._wave;
    w.set(wave.left.length === size ? wave.left : wave.left.subarray(0, size));
    w.set(wave.right.length === size ? wave.right : wave.right.subarray(0, size), size);
    x.viz_scope_update(this.h, size, wave.sampleRate || 48000, dt);
  }
  idle(dt) {
    this.c.x.viz_scope_idle(this.h, dt);
  }
  /** `{ gain, locked }`, read once per frame. */
  state() {
    this.c.x.viz_scope_state(this.h);
    const s = this._state();
    return { gain: s[0], locked: s[1], signal: s[4] > 0 };
  }
  free() {
    this.c.x.viz_scope_free(this.h);
    this.h = 0;
  }
}

/** The spectrum bars' levelling (lib/viz/scenes/bars.js draws them). */
export class BarsCore {
  constructor(c) {
    this.c = c;
    this.h = c.x.viz_bars_new();
    this.max = c.x.viz_bars_max();
    this._in = viewer(c, () => c.x.viz_bars_input(this.h), 256);
    this._out = viewer(c, () => c.x.viz_bars_output(this.h), this.max * 2);
    this.n = 0;
  }
  count(n) {
    this.n = Math.min(n, this.max);
    this.c.x.viz_bars_count(this.h, this.n);
  }
  update(bands, level, dt) {
    const n = Math.min(bands.length, 256);
    this._in().set(n === bands.length ? bands : bands.subarray(0, n));
    this.c.x.viz_bars_update(this.h, n, level, dt);
  }
  /** Heights, 0..1, the first `n` live. */
  get smooth() {
    return this._out().subarray(0, this.n);
  }
  /** The falling caps, the first `n` live. */
  get peaks() {
    const o = this._out();
    return o.subarray(this.max, this.max + this.n);
  }
  get level() {
    return this.c.x.viz_bars_level(this.h);
  }
  free() {
    this.c.x.viz_bars_free(this.h);
    this.h = 0;
  }
}

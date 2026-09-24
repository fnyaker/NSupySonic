// The rhythm analyser's home: an AudioWorkletProcessor on the AUDIO thread.
//
// The analysis used to run on the main thread, off AnalyserNode snapshots
// polled ~94 times a second, which is how it picked up the "small slowdowns"
// it was reported for: a long task on the main thread (a route change, a big
// list, a garbage collection) delayed or skipped frames, and a skipped frame
// is a missed kick. Here every sample is analysed exactly once, in order, on a
// thread nothing else runs on — webapp/rhythm (Rust, compiled to
// rhythm.wasm) does the work, and this file only feeds it and posts what it
// says.
//
// Each render quantum (128 frames) is mixed to mono and pushed; every `hop`
// samples the analyser emits one frame, which goes to the main thread in a
// pooled Float32Array (transferred, and handed back once read — nothing is
// allocated per frame once the pool is warm). A frame is stamped with the
// context time its audio started, so lib/audio/engine.js can hold it until
// that audio actually reaches the listener.
//
// It is built by Vite as a worker chunk (`?worker&url` in engine.js), so the
// import below is bundled into it and the file is served from the app's own
// origin — the CSP allows 'self' and WebAssembly compilation, not blob: URLs.

import { Rhythm } from "./rhythm-core.js";

const POOL_MAX = 48;

class NsRhythm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.alive = true;
    this.awake = true;
    this.pool = [];
    this.gen = o.gen | 0;
    this.pushed = 0;
    this.silence = null;
    this.port.onmessage = (e) => this.onMessage(e.data);
    try {
      // A compiled module when the browser could clone one across (instant);
      // raw bytes otherwise, compiled here — off the main thread, where a
      // synchronous compile is allowed.
      const mod =
        o.module instanceof WebAssembly.Module ? o.module : new WebAssembly.Module(o.bytes);
      this.r = Rhythm.fromModule(mod, sampleRate);
      if (o.families && o.families.length) this.r.loadFamilies(o.families);
      this.r.setLevel(o.level | 0);
      if (o.liveRange === false) this.r.setLiveRange(false);
      this.port.postMessage({
        t: "ready",
        layout: this.r.layoutText,
        hop: this.r.hop,
        lookahead: this.r.lookahead,
        frameLen: this.r.frameLen,
        sampleRate,
        srcHash: this.r.srcHash(),
      });
    } catch (err) {
      this.alive = false;
      this.port.postMessage({ t: "error", message: String((err && err.message) || err) });
    }
  }

  onMessage(m) {
    if (!m || !this.r) return;
    switch (m.t) {
      case "recycle":
        if (m.buf && this.pool.length < POOL_MAX) this.pool.push(m.buf);
        break;
      case "seed":
        this.r.seed(m.bpm, m.conf);
        break;
      case "range":
        this.r.setRange(m.lo, m.hi);
        break;
      case "liveRange":
        this.r.setLiveRange(!!m.on);
        break;
      case "level":
        this.r.setLevel(m.level | 0);
        break;
      case "reset":
        this.r.reset();
        this.gen = m.gen | 0;
        break;
      case "sleep":
        this.awake = !m.on;
        break;
      case "close":
        this.alive = false;
        break;
      default:
        break;
    }
  }

  process(inputs) {
    if (!this.alive) return false;
    if (!this.awake) return true;
    const input = inputs[0];
    let left = input && input[0];
    let right = input && input[1];
    if (!left) {
      // No active source upstream (paused, between tracks): the timeline still
      // runs, so silence is pushed rather than nothing — the analyser sees the
      // pause for what it is, and a frame's sample count keeps mapping onto
      // context time.
      if (!this.silence) this.silence = new Float32Array(128);
      left = right = this.silence;
    }
    const k = this.r.pushStereo(left, right || left);
    this.pushed += left.length;
    if (k) {
      // The context time of the END of this quantum, and how many samples had
      // been pushed by then: enough for the main thread to place any frame.
      const end = currentTime + left.length / sampleRate;
      const L = this.r.frameLen;
      for (let i = 0; i < k; i++) {
        let buf = this.pool.pop();
        if (!buf || buf.length !== L) buf = new Float32Array(L);
        buf.set(this.r.frame(i));
        this.port.postMessage({ t: "f", buf, end, pushed: this.pushed, gen: this.gen }, [buf.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("ns-rhythm", NsRhythm);

// The whole-track measures of ONE decoded track, by the Rust core (webapp/measure): the
// spectral descriptors and loudness, the beat tracker and the low band. The numbers are
// the server's (docs/agents/analysis-genre.md, "Analysis on the client PC"): the server
// only gates and decides them. Pure functions of what is passed in, so it runs in a
// Worker and in node alike.

const TEMPO_RATE = 44100;
const TEMPO_CHUNK = TEMPO_RATE * 10;

export async function loadMeasure(wasm) {
  const raw = typeof wasm !== "string" && (wasm instanceof ArrayBuffer || ArrayBuffer.isView(wasm));
  const bytes = raw ? wasm : await (await fetch(wasm)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

const view = (x, ptr, n) => new Float32Array(x.memory.buffer, ptr, n);

/**
 * @param x           the instantiated core
 * @param channels    Float32Array[] at `rate` (the file's own rate: ffmpeg measures the source)
 * @param rate        Hz
 * @param mono44      Float32Array, the track as 44.1 kHz mono (what the beat tracker reads)
 * @param caps        { spectral, tempo } seconds the server reads at most
 * @returns { spectral, tempo | null } — null tempo: nothing to track (the server gates the rest)
 */
export function measureTrack(x, { channels, rate, mono44, caps = { spectral: 600, tempo: 1200 } }) {
  const n = Math.min(channels[0].length, Math.floor(caps.spectral * rate));
  if (!x.ms_begin(channels.length, n, rate)) throw new Error("track too short or unreadable");
  channels.forEach((ch, i) => view(x, x.ms_channel(i), n).set(ch.subarray(0, n)));
  if (!x.ms_run()) throw new Error("no spectral frames");
  const out = (i) => x.ms_out(i);
  const spectral = {
    centroid: out(0), spread: out(1), flatness: out(2), flatness_hi: out(3), entropy: out(4),
    rolloff: out(5), flux_peak: out(6),
    lufs: Number.isFinite(out(7)) ? out(7) : null, lra: Number.isFinite(out(8)) ? out(8) : null,
    frames: out(9),
  };
  x.lb_run();
  const attacks = x.lb_attacks();

  x.tp_begin();
  const m = mono44.subarray(0, Math.min(mono44.length, Math.floor(caps.tempo * TEMPO_RATE)));
  for (let at = 0; at < m.length; at += TEMPO_CHUNK) {
    const part = m.subarray(at, Math.min(m.length, at + TEMPO_CHUNK));
    const ptr = x.tp_chunk(part.length);
    if (!ptr) throw new Error("chunk refused");
    view(x, ptr, part.length).set(part);
    x.tp_push();
  }
  let tempo = null;
  if (x.tp_finish()) {
    const bpm = x.tp_out(0);
    tempo = {
      bpm, confidence: x.tp_out(1), salience: x.tp_out(2), alternation: x.tp_out(4),
      attacks, grid: x.lb_grid(bpm),
    };
  }
  return { spectral, tempo };
}

/** The 44.1 kHz mono signal from channels already at 44.1 kHz (the mean, as Web Audio's down-mix). */
export function monoOf(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

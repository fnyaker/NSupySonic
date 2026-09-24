// The browser half of test/rhythm/run.mjs: the REAL engine — graph.js, the
// AudioWorklet, the WebAssembly analyser, the delivery queue — fed by a real
// <audio> element playing a record from test/songs.mjs. Everything the
// animations would receive is recorded, with the context time of its audio.

import { registerSource, getContext } from "/src/lib/audio/graph.js";
import { subscribeFrames, readout } from "/src/lib/audio/engine.js";
import { player } from "/src/lib/stores.js";

function wavBlob(pcm, sr) {
  const n = pcm.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Blob([buf], { type: "audio/wav" });
}

window.bench = {
  ready: true,
  async run({ file, seconds = 20, level = 2, id = "900000001", sr = 48000 }) {
    const raw = await (await fetch(file)).arrayBuffer();
    const pcm = new Float32Array(raw).subarray(0, Math.min(raw.byteLength / 4, Math.ceil((seconds + 2) * sr)));
    const audio = new Audio();
    audio.src = URL.createObjectURL(wavBlob(pcm, sr));
    player.playQueue([{ id: "bench", deezer_id: id, title: "bench" }], 0);
    registerSource(audio);
    const rec = { frames: 0, kicks: [], beats: [], downbeats: [], mains: [], drops: [], rolls: [], bpm: [], late: [], errors: [] };
    let playCtx = null;
    let lastT = 0;
    const gaps = [];
    const unsub = subscribeFrames((f) => {
      rec.frames++;
      if (lastT) gaps.push(f.t - lastT);
      lastT = f.t;
      rec.late.push(f.lateBy);
      if (f.features?.kickHit) rec.kicks.push(f.ctxT);
      if (f.beat?.beat) rec.beats.push(f.ctxT + (f.lateBy || 0));
      if (f.beat?.downbeat) rec.downbeats.push(f.ctxT + (f.lateBy || 0));
      if (f.pattern?.mainKick) rec.mains.push(f.ctxT);
      if (f.pattern?.drop) rec.drops.push(f.ctxT);
      if (f.pattern?.roll > 0.5) rec.rolls.push(f.ctxT);
      if (f.beat?.locked) rec.bpm.push(f.beat.bpm);
    }, level);
    audio.addEventListener("playing", () => {
      const ctx = getContext();
      if (ctx && playCtx == null) playCtx = ctx.currentTime - audio.currentTime;
    });
    await audio.play();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    audio.pause();
    unsub();
    let ro;
    readout.subscribe((v) => (ro = v))();
    gaps.sort((a, b) => a - b);
    return {
      ...rec,
      playCtx,
      readout: ro,
      sampleRate: getContext()?.sampleRate,
      gapP50: gaps[gaps.length >> 1],
      gapP99: gaps[Math.floor(gaps.length * 0.99)],
    };
  },
};

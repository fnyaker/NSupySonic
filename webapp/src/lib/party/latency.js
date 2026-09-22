// How long a DynamicsCompressorNode delays the signal in THIS browser. The
// spec leaves it to the implementation (Blink's has a fixed lookahead), and the
// host's chain has two of them in series — a few milliseconds each that would
// otherwise be a constant offset between every host and every guest.
let compDelay = null;
export function compressorDelay() {
  if (compDelay) return compDelay;
  compDelay = (async () => {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return 0;
    try {
      const rate = 48000;
      const oc = new OAC(1, 4096, rate);
      const b = oc.createBuffer(1, 4096, rate);
      b.getChannelData(0)[64] = 0.25;
      const src = oc.createBufferSource();
      src.buffer = b;
      const comp = oc.createDynamicsCompressor();
      src.connect(comp);
      comp.connect(oc.destination);
      src.start(0);
      const out = (await oc.startRendering()).getChannelData(0);
      let at = 0;
      let best = 0;
      for (let i = 0; i < out.length; i++) {
        if (Math.abs(out[i]) > best) {
          best = Math.abs(out[i]);
          at = i;
        }
      }
      return best > 0 ? Math.max(0, (at - 64) / rate) : 0;
    } catch {
      return 0;
    }
  })();
  return compDelay;
}

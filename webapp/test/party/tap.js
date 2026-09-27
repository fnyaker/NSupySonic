// A click detector for the listen-party bench: an AudioWorklet that reports the
// context time of every rising edge through 0.3, to the sample. Shared by the
// host and the guest page.
const WORKLET = `registerProcessor("ns-click", class extends AudioWorkletProcessor {
  constructor() { super(); this.prev = 0; this.hold = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      const x = Math.abs(ch[i]);
      if (this.hold > 0) this.hold--;
      else if (x > 0.3 && this.prev <= 0.3) { this.port.postMessage(currentTime + i / sampleRate); this.hold = 2000; }
      this.prev = x;
    }
    return true;
  }
});`;

export async function clickTap(ctx) {
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
  const node = new AudioWorkletNode(ctx, "ns-click");
  const clicks = [];
  node.port.onmessage = (e) => clicks.push(e.data);
  return { node, clicks };
}

// The browser's own account of when a context time is heard: every distinct
// output timestamp, with the wall time it was read at. The truth both sides
// are scored against.
export function outputClock(ctx) {
  const stamps = [];
  let last = -1;
  const timer = setInterval(() => {
    if (ctx.state !== "running") return;
    const ts = ctx.getOutputTimestamp();
    if (ts.performanceTime > 0 && ts.contextTime !== last) {
      last = ts.contextTime;
      stamps.push([performance.now(), ts.contextTime - ts.performanceTime / 1000]);
    }
  }, 5);
  return { stamps, stop: () => clearInterval(timer) };
}

// Context time -> the epoch millisecond it is heard at, with the output clock
// as it stood around then (the median of the readings within 300 ms).
export function heardEpoch(stamps, ctxT, nearMs) {
  const near = [];
  for (const [t, d] of stamps) if (Math.abs(t - nearMs) <= 300) near.push(d);
  if (!near.length) return null;
  near.sort((a, b) => a - b);
  const d = near[near.length >> 1];
  return performance.timeOrigin + (ctxT - d) * 1000;
}

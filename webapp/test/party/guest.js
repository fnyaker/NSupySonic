// The guest half of the listen-party bench: the REAL guest (lib/party/guest.js)
// joining through the real server, with one thing added: the AudioContext's
// destination is fanned out to a click detector, so what this page actually
// sends to its speakers is on record.
import { outputTrim } from "/src/lib/stores.js";
import { clickTap, outputClock, heardEpoch } from "./tap.js";

const Native = window.AudioContext;
let captured = null;
class BenchContext extends Native {
  constructor(opts) {
    super(opts);
    const real = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "destination").get.call(this);
    this._fan = super.createGain();
    this._fan.connect(real);
    captured = this;
  }
  get destination() {
    return this._fan;
  }
}
window.AudioContext = BenchContext;

let session = null;
let tap = null;
let clock = null;

window.guestBench = {
  async join(pid, { trim = 0, fmt = null } = {}) {
    outputTrim.set(trim);
    if (fmt) localStorage.setItem("party.fmt", fmt);
    const { joinParty } = await import("/src/lib/party/guest.js");
    session = joinParty(pid, "bench");
    const ctx = captured;
    tap = await clickTap(ctx);
    ctx._fan.connect(tap.node);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    tap.node.connect(mute);
    mute.connect(Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, "destination").get.call(ctx));
    clock = outputClock(ctx);
    return true;
  },
  status() {
    let v;
    session.view.subscribe((x) => (v = x))();
    return { phase: v.phase, status: v.status, osLatency: v.osLatency, latency: v.latency };
  },
  heard() {
    const out = [];
    for (const T of tap.clicks) {
      const approx = (T - (clock.stamps.at(-1)?.[1] ?? 0)) * 1000;
      const e = heardEpoch(clock.stamps, T, approx);
      if (e != null) out.push(e);
    }
    return { heard: out, stamps: clock.stamps, origin: performance.timeOrigin, base: captured.baseLatency, output: captured.outputLatency, sr: captured.sampleRate };
  },
  debug() {
    return window.__nsParty && window.__nsParty.guest ? window.__nsParty.guest() : null;
  },
};
window.benchReady = true;

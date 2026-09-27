// The host half of the listen-party bench: the REAL hosting code (lib/party/host.js,
// the clock, the anchor fit, the latency model) watching a plain <audio> element
// routed through the REAL graph (graph.js) — which is the case whose latency
// has to be modelled: an element played through Web Audio is heard after the
// whole graph, and its currentTime knows nothing of it. A click detector sits
// on the graph's output, so what this page PLAYS is on record, not what it
// says it plays.
import { player, current, outputTrim } from "/src/lib/stores.js";
import { registerSource, requestAnalyser, getContext, tapRhythm, lookaheadSeconds } from "/src/lib/audio/graph.js";
import { bindPartySource } from "/src/lib/party/hostbridge.js";
import { clickTap, outputClock, heardEpoch } from "./tap.js";

let audio = null;
let loadedId = null;
let tap = null;
let clock = null;
const las = []; // [perf ms, lookahead s]
// What the host PUBLISHED, sampled as it went: [epoch ms, server ms, {t, p, playing}, track id].
const lines = [];
setInterval(() => {
  const h = window.__nsParty && window.__nsParty.host && window.__nsParty.host();
  if (h && h.published) lines.push([performance.timeOrigin + performance.now(), h.S, h.published, h.id]);
}, 100);

window.hostBench = {
  async login() {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bench", password: "Bench1" }),
    });
    return r.ok;
  },
  async play(track, { trim = 0 } = {}) {
    outputTrim.set(trim);
    if (!audio) {
      audio = new Audio();
      audio.preload = "auto";
      bindPartySource({
        element: () => audio,
        loaded: () => loadedId,
        xfading: () => 0,
        plan: () => null,
      });
    }
    loadedId = null;
    player.playQueue([{ id: track.id, deezer_id: track.id, title: track.title, duration: track.duration, artist: { name: "Bench" } }], 0);
    audio.src = `/api/stream/${track.id}`;
    registerSource(audio);
    requestAnalyser();
    const ctx = getContext();
    if (!tap) {
      tap = await clickTap(ctx);
      tapRhythm(tap.node);
      clock = outputClock(ctx);
      setInterval(() => las.push([performance.now(), lookaheadSeconds()]), 20);
    }
    await audio.play();
    loadedId = track.id;
    return true;
  },
  async startParty() {
    const host = await import("/src/lib/party/host.js");
    const h = await host.startParty();
    return h && h.id;
  },
  seek(t) {
    audio.currentTime = t;
    import("/src/lib/party/hostbridge.js").then((b) => b.partyPoke());
  },
  pause() {
    audio.pause();
    import("/src/lib/party/hostbridge.js").then((b) => b.partyPoke());
  },
  async resume() {
    await audio.play();
    import("/src/lib/party/hostbridge.js").then((b) => b.partyPoke());
  },
  // Every click this page played, as the epoch millisecond it was heard at.
  heard() {
    const ctx = getContext();
    const out = [];
    for (const T of tap.clicks) {
      // Which wall time was this context time near? Heard ≈ T + look-ahead,
      // mapped by the output clock.
      const approx = (T - (clock.stamps.at(-1)?.[1] ?? 0)) * 1000;
      let la = 0;
      for (const [t, v] of las) if (t <= approx) la = v;
      const e = heardEpoch(clock.stamps, T + la, approx);
      if (e != null) out.push(e);
    }
    return { heard: out, lines, stamps: clock.stamps, origin: performance.timeOrigin, base: ctx.baseLatency, output: ctx.outputLatency, sr: ctx.sampleRate };
  },
  debug() {
    return window.__nsParty && window.__nsParty.host ? window.__nsParty.host() : null;
  },
};
window.benchReady = true;

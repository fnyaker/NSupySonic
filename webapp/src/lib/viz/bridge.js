// The link between the tab that plays and the tab that draws.
//
// The projector window is the same SPA on #/viz, opened in a second tab so it
// can be dragged onto a beamer and put full screen. It deliberately does NOT
// play anything: a second <audio> would be a second stream off the server, a
// second decode, and — worse — two playheads that drift apart within a minute,
// so the animation on the big screen would slowly stop matching the room.
//
// Instead the playing tab publishes its analysis frames on a BroadcastChannel
// (same origin, no server involved) and the projector renders them. One decode,
// one analysis, one timeline, and the projector costs the player tab about
// 700 bytes at 45 Hz.
//
// The playing tab also has to be told when someone is listening, because rAF
// stops in a hidden tab and the player tab is exactly the one that ends up
// behind the projector window. A live viewer switches the analysis engine onto
// its audio-thread clock (see engine.js) so the feed survives being hidden.

import { setBackgroundAnalysis, BAND_COUNT } from "../audio/engine.js";

const CHANNEL = "nsupysonic-viz";
const PUBLISH_HZ = 45; // the projector renders at 60; 45 is indistinguishable
const VIEWER_TIMEOUT = 6000; // a viewer that stops pinging is gone
const PING_EVERY = 2000;

function open() {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

// --- the playing tab --------------------------------------------------------
export function createPublisher({ onViewers } = {}) {
  const ch = open();
  if (!ch) return { send() {}, meta() {}, close() {}, get viewers() { return 0; } };
  const viewers = new Map(); // id → last seen
  let announced = 0;

  // The host only runs the analysis engine while somebody is watching, so the
  // count crossing zero is the signal it acts on.
  function announce() {
    if (viewers.size === announced) return;
    announced = viewers.size;
    setBackgroundAnalysis(announced > 0);
    onViewers?.(announced);
  }
  let last = 0;
  let metaCache = null;
  const bands = new Float32Array(BAND_COUNT);

  function prune() {
    const now = Date.now();
    for (const [id, t] of viewers) if (now - t > VIEWER_TIMEOUT) viewers.delete(id);
    announce();
  }

  ch.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.t === "hello" || m.t === "ping") {
      const known = viewers.has(m.id);
      viewers.set(m.id, Date.now());
      announce();
      if (!known && metaCache) ch.postMessage(metaCache);
    } else if (m.t === "bye") {
      viewers.delete(m.id);
      announce();
    }
  };

  return {
    get viewers() {
      return viewers.size;
    },
    // Called on every analysis frame; throttles itself.
    send(frame) {
      if (!viewers.size) return;
      const now = performance.now();
      if (now - last < 1000 / PUBLISH_HZ) return;
      last = now;
      bands.set(frame.bands);
      const b = frame.beat;
      const f = frame.features;
      const st = frame.style;
      ch.postMessage({
        t: "f",
        bands,
        e: [
          frame.energy.sub,
          frame.energy.bass,
          frame.energy.lowMid,
          frame.energy.mid,
          frame.energy.high,
          frame.energy.air,
        ],
        // Only the descriptors the scenes actually read. Sending the whole
        // feature object would triple the payload for fields nothing draws.
        f: f
          ? [f.level, f.flux, f.lowFlux, f.midFlux, f.highFlux, f.centroidN, f.flatness,
             f.percussivity, f.vocalMod, f.crest, f.silent ? 1 : 0]
          : null,
        b: [b.bpm, b.confidence, b.phase, b.beat ? 1 : 0, b.beatIndex, b.barPos,
            b.beatsPerBar, b.downbeat ? 1 : 0, b.onset, b.kickPulse, b.period,
            b.locked ? 1 : 0],
        s: st
          ? {
              d: st.dominant,
              l: st.dominantLabel,
              c: st.confidence,
              a: st.archetypes,
              k: [st.kick.type, st.kick.strength, st.kick.decay, st.kick.hit ? 1 : 0],
            }
          : null,
      });
    },
    // Track identity + cover colour, resent whenever a viewer joins.
    meta(info) {
      metaCache = { t: "m", ...info };
      ch.postMessage(metaCache);
    },
    prune,
    close() {
      viewers.clear();
      announce();
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// --- the projector tab ------------------------------------------------------
// Rebuilds a frame object with the same shape the scenes expect, so a scene has
// no idea whether it is running next to the audio or on the other screen.
export function createSubscriber(onFrame, onMeta, onState) {
  const ch = open();
  const id = Math.random().toString(36).slice(2);
  const energy = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
  const features = {
    level: 0, flux: 0, lowFlux: 0, midFlux: 0, highFlux: 0, centroidN: 0,
    flatness: 0, percussivity: 0, vocalMod: 0, crest: 0, silent: true,
  };
  const beat = {
    bpm: 0, confidence: 0, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0, period: 0.5, locked: false,
  };
  const kick = { type: "soft", strength: 0, decay: 0.1, hit: false };
  const style = { dominant: "", dominantLabel: "", confidence: 0, archetypes: null, kick };
  const frame = {
    t: 0, dt: 1 / 60,
    bands: new Float32Array(BAND_COUNT),
    energy, features, beat, style: null, silent: true,
  };
  let lastAt = 0;
  let alive = false;
  let pingTimer = null;
  let watchTimer = null;

  if (ch) {
    ch.onmessage = (e) => {
      const m = e.data;
      if (!m || m.t === "hello" || m.t === "ping" || m.t === "bye") return;
      if (m.t === "m") {
        onMeta?.(m);
        return;
      }
      if (m.t !== "f") return;
      const now = performance.now() / 1000;
      frame.dt = lastAt ? Math.min(0.2, Math.max(0.004, now - lastAt)) : 1 / 45;
      lastAt = now;
      frame.t = now;
      frame.bands.set(m.bands);
      const e2 = m.e;
      energy.sub = e2[0]; energy.bass = e2[1]; energy.lowMid = e2[2];
      energy.mid = e2[3]; energy.high = e2[4]; energy.air = e2[5];
      if (m.f) {
        const a = m.f;
        features.level = a[0]; features.flux = a[1]; features.lowFlux = a[2];
        features.midFlux = a[3]; features.highFlux = a[4]; features.centroidN = a[5];
        features.flatness = a[6]; features.percussivity = a[7]; features.vocalMod = a[8];
        features.crest = a[9]; features.silent = !!a[10];
      }
      const b = m.b;
      beat.bpm = b[0]; beat.confidence = b[1]; beat.phase = b[2]; beat.beat = !!b[3];
      beat.beatIndex = b[4]; beat.barPos = b[5]; beat.beatsPerBar = b[6];
      beat.downbeat = !!b[7]; beat.onset = b[8]; beat.kickPulse = b[9];
      beat.period = b[10]; beat.locked = !!b[11];
      if (m.s) {
        style.dominant = m.s.d; style.dominantLabel = m.s.l; style.confidence = m.s.c;
        style.archetypes = m.s.a;
        kick.type = m.s.k[0]; kick.strength = m.s.k[1];
        kick.decay = m.s.k[2]; kick.hit = !!m.s.k[3];
        frame.style = style;
      } else frame.style = null;
      frame.silent = features.silent;
      if (!alive) {
        alive = true;
        onState?.(true);
      }
      onFrame(frame);
    };
    ch.postMessage({ t: "hello", id });
    pingTimer = setInterval(() => ch.postMessage({ t: "ping", id }), PING_EVERY);
    // "Is anything still sending?" — the player tab can be closed at any moment
    // and the projector must say so rather than freeze on the last frame.
    watchTimer = setInterval(() => {
      const stale = performance.now() / 1000 - lastAt > 2;
      if (alive && stale) {
        alive = false;
        onState?.(false);
      }
    }, 1000);
  }

  return {
    get supported() {
      return !!ch;
    },
    close() {
      clearInterval(pingTimer);
      clearInterval(watchTimer);
      try {
        ch?.postMessage({ t: "bye", id });
        ch?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

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
//
// MORE THAN ONE TAB CAN PUBLISH. Leaving the app open in two tabs is completely
// ordinary, and both of them answer a projector's hello — so the projector used
// to receive two contradictory streams and show whichever landed last, which
// for an idle second tab meant "nothing playing" over the top of a tab that was
// very much playing. Every message therefore carries its sender, and the
// projector FOLLOWS ONE: it prefers a tab that reports playback, keeps it while
// its heartbeat holds, and only lets another take over once it goes quiet.

import { setBackgroundAnalysis, BAND_COUNT } from "../audio/engine.js";
import { LOOK_KEYS } from "../audio/style.js";

const CHANNEL = "nsupysonic-viz";
// ANALYSIS AND RENDERING ARE DIFFERENT THINGS, and this channel is the line
// between them. The sound is analysed ONCE, in the tab that has the audio — one
// beat tracker, one classifier, so the genre is decided once and both screens
// agree about it by construction. What crosses the channel is that analysis.
// What each side does with it is its own business: the player and the projector
// pick their own scene, their own quality tier and their own frame rate, and
// neither waits for the other.
//
// The level the analysis runs AT is the most demanding of the two, which is the
// only part that has to be shared: a projector on `smart` needs a beat tracker
// even if the player is showing bars, and a player on `smart` needs one whether
// or not anybody is watching the second screen. The viewer announces what it
// needs (`lv` on its hello), the publisher subscribes at that level, and the
// engine's own `recomputeLevel` maxes it with whatever this tab wants — so the
// rule falls out of machinery that already existed rather than a new one.
const PUBLISH_HZ = 45; // the projector renders at 60; 45 is indistinguishable
// A viewer proves it is alive by pinging. That ping is a setInterval in a
// window that is, by design, not the focused one — and a browser throttles
// timers in a backgrounded tab to once a second, then to once a MINUTE after a
// few minutes of it. So the timeout has to be generous enough to survive that:
// the only cost of believing in a viewer that has gone is that this tab keeps
// analysing, while the cost of dropping a live one is the projector freezing.
// A window that closes properly says goodbye, which is the normal path out.
const VIEWER_TIMEOUT = 90000;
const PING_EVERY = 5000;
// The transport heartbeat. It is what lets the projector tell "the player is
// there and paused" from "there is no player" — without it, a pause (which
// legitimately stops the frames) looked exactly like a disconnection.
const HEARTBEAT_EVERY = 2000;
const HEARTBEAT_TIMEOUT = 9000;

function open() {
  try {
    return typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

// --- the playing tab --------------------------------------------------------
export function createPublisher({ onViewers, channel } = {}) {
  // `channel` is a seam for the tests: the latching below is the fix for the
  // projector missing half of every track's events, and it is not observable
  // from anywhere else.
  const ch = channel || open();
  if (!ch)
    return {
      send() {},
      meta() {},
      state() {},
      prune() {},
      close() {},
      get viewers() {
        return 0;
      },
    };
  const src = Math.random().toString(36).slice(2);
  const viewers = new Map(); // id → last seen
  let announced = 0;
  let viewerLevel = 0;
  // Events are STICKY between publishes. The engine runs at ~94 Hz and this
  // channel at 45, so a beat — which is true on exactly one frame — had a
  // better than even chance of landing in a frame that was dropped. The
  // projector was therefore missing about half of every track's beats, kicks
  // and downbeats, which is most of what "they are not in sync" was: not a
  // clock problem, a sampling one. Continuous values can be sampled; events
  // have to be accumulated.
  let hadBeat = false;
  let hadDown = false;
  let hadKick = false;
  let hadStyleHit = false;
  let peakOnset = 0;
  // The musical layer's events, latched for exactly the same reason.
  let hadMain = false;
  let hadBig = false;
  let hadRollKick = false;
  let hadDrop = false;
  let transport = { playing: false, loaded: false };
  let beat = null;

  // The host only runs the analysis engine while somebody is watching, so the
  // count crossing zero is the signal it acts on.
  function announce() {
    // The most demanding viewer decides, and a change of level is as much a
    // reason to re-announce as a change of count.
    let lv = 0;
    for (const v of viewers.values()) if (v && v.lv > lv) lv = v.lv;
    if (viewers.size === announced && lv === viewerLevel) return;
    viewerLevel = lv;
    announced = viewers.size;
    setBackgroundAnalysis(announced > 0);
    if (announced > 0 && !beat) beat = setInterval(sendState, HEARTBEAT_EVERY);
    else if (!announced && beat) {
      clearInterval(beat);
      beat = null;
    }
    onViewers?.(announced, viewerLevel);
  }

  function sendState() {
    if (!viewers.size) return;
    ch.postMessage({
      t: "s",
      src,
      playing: transport.playing,
      loaded: transport.loaded,
    });
  }
  let last = 0;
  let metaCache = null;
  const bands = new Float32Array(BAND_COUNT);
  const chroma = new Float32Array(12);
  const look = new Float32Array(LOOK_KEYS.length);

  function prune() {
    const now = Date.now();
    for (const [id, v] of viewers) if (now - v.at > VIEWER_TIMEOUT) viewers.delete(id);
    announce();
  }

  ch.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.t === "hello" || m.t === "ping") {
      const known = viewers.has(m.id);
      // `lv` is the analysis level this viewer needs for the scene IT chose.
      // An older projector does not send one; SMART is the safe assumption,
      // because under-analysing silently degrades its picture while
      // over-analysing only costs this tab a little work.
      viewers.set(m.id, { at: Date.now(), lv: Number.isFinite(m.lv) ? m.lv : 2 });
      announce();
      if (!known) {
        if (metaCache) ch.postMessage(metaCache);
        sendState();
      }
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
      // Latch first, ALWAYS — before the throttle can return. This runs on
      // every analysis frame and is four ORs and a max.
      const fb = frame.beat;
      const ff = frame.features;
      if (fb.beat) hadBeat = true;
      if (fb.downbeat) hadDown = true;
      if (ff?.kickHit) hadKick = true;
      if (frame.style?.kick?.hit) hadStyleHit = true;
      if (fb.onset > peakOnset) peakOnset = fb.onset;
      const fp = frame.pattern;
      if (fp) {
        if (fp.mainKick) hadMain = true;
        if (fp.bigKick) hadBig = true;
        if (fp.rollKick) hadRollKick = true;
        if (fp.drop) hadDrop = true;
      }

      const now = performance.now();
      if (now - last < 1000 / PUBLISH_HZ) return;
      last = now;
      bands.set(frame.bands);
      const b = frame.beat;
      const f = frame.features;
      const st = frame.style;
      ch.postMessage({
        t: "f",
        src,
        bands,
        e: [
          frame.energy.sub,
          frame.energy.bass,
          frame.energy.lowMid,
          frame.energy.mid,
          frame.energy.high,
          frame.energy.air,
        ],
        // Only the descriptors the scenes actually read — but ALL of them. The
        // melodic channel and the dynamics gate were missing, so the projector
        // ran the same scenes with `dynamics` undefined (no quiet passages) and
        // no chroma at all (no melody layer), which is most of why the second
        // screen looked more generic than the player it mirrors.
        f: f
          ? [f.level, f.flux, f.lowFlux, f.midFlux, f.highFlux, f.centroidN, f.flatness,
             f.percussivity, f.vocalMod, f.crest, f.silent ? 1 : 0, f.kick,
             f.dynamics, f.tonal, f.melody, f.melodyPitch, f.melodyFlux, f.chordChange,
             // `kickHit` was simply missing, so every animation on the
             // projector that fires on a kick never fired at all — including
             // all of `lib/viz/genres/`, whose whole timing is built on it.
             hadKick ? 1 : 0]
          : null,
        c: f?.chroma ? (chroma.set(f.chroma), chroma) : null,
        b: [b.bpm, b.confidence, b.phase, hadBeat ? 1 : 0, b.beatIndex, b.barPos,
            b.beatsPerBar, hadDown ? 1 : 0, peakOnset, b.kickPulse, b.period,
            b.locked ? 1 : 0],
        // The MUSICAL layer (lib/audio/pattern.js). Its four events are latched
        // above; the rest are continuous and can be sampled.
        p: frame.pattern
          ? [hadMain ? 1 : 0, frame.pattern.mainPower, hadBig ? 1 : 0, hadRollKick ? 1 : 0,
             frame.pattern.roll, frame.pattern.rollDiv, frame.pattern.rollNotes,
             hadDrop ? 1 : 0, frame.pattern.sinceDrop, frame.pattern.dropped,
             frame.pattern.breakdown, frame.pattern.build, frame.pattern.energy]
          : null,
        s: st
          ? {
              d: st.dominant,
              l: st.dominantLabel,
              c: st.confidence,
              a: st.archetypes,
              // The look vector: seven numbers that say what the SUBGENRE looks
              // like. Without it every projector scene fell back to the neutral
              // default and frenchcore drew the same picture as techno.
              w: st.look ? (LOOK_KEYS.forEach((k, i) => (look[i] = st.look[k])), look) : null,
              k: [st.kick.type, st.kick.strength, st.kick.decay, hadStyleHit ? 1 : 0],
            }
          : null,
      });
      hadBeat = hadDown = hadKick = hadStyleHit = false;
      hadMain = hadBig = hadRollKick = hadDrop = false;
      peakOnset = 0;
    },
    // Transport state. Sent on every change and, while anyone is watching, as
    // a heartbeat — it is the projector's proof that this tab is still here.
    state(playing, loaded) {
      const changed = transport.playing !== !!playing || transport.loaded !== !!loaded;
      transport = { playing: !!playing, loaded: !!loaded };
      if (changed) sendState();
    },
    // Track identity + cover colour, resent whenever a viewer joins.
    meta(info) {
      metaCache = { t: "m", src, ...info };
      ch.postMessage(metaCache);
    },
    prune,
    close() {
      viewers.clear();
      announce();
      clearInterval(beat);
      beat = null;
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
export function createSubscriber(onFrame, onMeta, onState, initialLevel = 2) {
  let level = initialLevel;
  const ch = open();
  const id = Math.random().toString(36).slice(2);
  const energy = { sub: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
  const features = {
    level: 0, flux: 0, lowFlux: 0, midFlux: 0, highFlux: 0, centroidN: 0,
    flatness: 0, percussivity: 0, vocalMod: 0, crest: 0, silent: true, kick: 0,
    kickHit: false,
    dynamics: 1, tonal: 0, melody: 0, melodyPitch: 0.5, melodyFlux: 0, chordChange: 0,
    chroma: new Float32Array(12),
  };
  const beat = {
    bpm: 0, confidence: 0, phase: 0, beat: false, beatIndex: 0, barPos: 0,
    beatsPerBar: 4, downbeat: false, onset: 0, kickPulse: 0, period: 0.5, locked: false,
  };
  const kick = { type: "soft", strength: 0, decay: 0.1, hit: false };
  // The musical layer, rebuilt in the shape lib/audio/pattern.js publishes.
  const pattern = {
    mainKick: false, mainPower: 0, bigKick: false, rollKick: false,
    roll: 0, rollDiv: 0, rollNotes: 0,
    drop: false, sinceDrop: 999, dropped: 0, breakdown: 0, build: 0, energy: 1,
  };
  const look = {};
  for (const k of LOOK_KEYS) look[k] = 0;
  const style = {
    dominant: "", dominantLabel: "", confidence: 0, archetypes: null, look: null, kick,
  };
  const frame = {
    t: 0, dt: 1 / 60,
    bands: new Float32Array(BAND_COUNT),
    energy, features, beat, pattern: null, style: null, silent: true,
  };
  let lastAt = 0;
  let lastBeat = 0;
  let alive = false;
  // Which publisher we are following, and how good a claim it has: 2 playing,
  // 1 loaded-but-paused, 0 idle. A better claim, or the current one going
  // quiet, is what lets another tab take over.
  let source = null;
  let sourceRank = -1;
  let playing = false;
  let loaded = false;
  let pingTimer = null;
  let watchTimer = null;

  function report() {
    onState?.({ alive, playing, loaded });
  }

  if (ch) {
    ch.onmessage = (e) => {
      const m = e.data;
      if (!m || m.t === "hello" || m.t === "ping" || m.t === "bye") return;
      if (m.t === "m") {
        // Before a source is settled, take the first description offered; after
        // that, only the tab we are following gets to name the track.
        if (!source || m.src === source || !m.src) onMeta?.(m);
        return;
      }
      if (m.t === "s") {
        // The heartbeat, not the frames, is what "connected" means: a paused
        // player sends no frames and is still very much there.
        const now = performance.now() / 1000;
        const rank = m.playing ? 2 : m.loaded ? 1 : 0;
        const stale = now - lastBeat > HEARTBEAT_TIMEOUT / 1000;
        if (source && m.src !== source) {
          // Another tab. It only takes over if it has a better claim than the
          // one we follow, or if the one we follow has gone quiet.
          if (rank <= sourceRank && !stale) return;
          source = m.src;
          // The new source has not told us what it is playing yet.
          ch.postMessage({ t: "hello", id, lv: level });
        } else if (!source) {
          source = m.src ?? null;
        }
        sourceRank = rank;
        lastBeat = now;
        // Report only on a real change: the heartbeat itself ticks twice a
        // second and reassigning Svelte state that often would re-render the
        // whole overlay for nothing.
        const changed = !alive || playing !== !!m.playing || loaded !== !!m.loaded;
        playing = !!m.playing;
        loaded = !!m.loaded;
        alive = true;
        if (changed) report();
        return;
      }
      if (m.t !== "f") return;
      if (source && m.src && m.src !== source) return; // another tab's stream
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
        features.crest = a[9]; features.silent = !!a[10]; features.kick = a[11] || 0;
        // Older publishers stop at index 11, so keep the neutral defaults when
        // the tail is missing: a projector and a player can be on different
        // builds for as long as one of the two tabs stays open.
        if (a.length > 12) {
          features.dynamics = a[12]; features.tonal = a[13]; features.melody = a[14];
          features.melodyPitch = a[15]; features.melodyFlux = a[16]; features.chordChange = a[17];
        }
        // Latched by the publisher across the frames the throttle dropped, so
        // this is "a kick happened since the last message" rather than "a kick
        // is happening in the frame that got through".
        features.kickHit = a.length > 18 ? !!a[18] : false;
      }
      if (m.c) features.chroma.set(m.c);
      const b = m.b;
      beat.bpm = b[0]; beat.confidence = b[1]; beat.phase = b[2]; beat.beat = !!b[3];
      beat.beatIndex = b[4]; beat.barPos = b[5]; beat.beatsPerBar = b[6];
      beat.downbeat = !!b[7]; beat.onset = b[8]; beat.kickPulse = b[9];
      beat.period = b[10]; beat.locked = !!b[11];
      if (m.p) {
        const a = m.p;
        // Latched by the publisher across the frames the throttle dropped, so
        // these are "since the last message" rather than "in this frame".
        pattern.mainKick = !!a[0]; pattern.mainPower = a[1]; pattern.bigKick = !!a[2];
        pattern.rollKick = !!a[3]; pattern.roll = a[4]; pattern.rollDiv = a[5];
        pattern.rollNotes = a[6]; pattern.drop = !!a[7]; pattern.sinceDrop = a[8];
        pattern.dropped = a[9]; pattern.breakdown = a[10]; pattern.build = a[11];
        pattern.energy = a[12];
        frame.pattern = pattern;
      } else frame.pattern = null;
      if (m.s) {
        style.dominant = m.s.d; style.dominantLabel = m.s.l; style.confidence = m.s.c;
        style.archetypes = m.s.a;
        if (m.s.w) {
          for (let i = 0; i < LOOK_KEYS.length; i++) look[LOOK_KEYS[i]] = m.s.w[i];
          style.look = look;
        } else style.look = null;
        kick.type = m.s.k[0]; kick.strength = m.s.k[1];
        kick.decay = m.s.k[2]; kick.hit = !!m.s.k[3];
        frame.style = style;
      } else frame.style = null;
      frame.silent = features.silent;
      if (!alive) {
        alive = true;
        report();
      }
      onFrame(frame);
    };
    ch.postMessage({ t: "hello", id, lv: level });
    pingTimer = setInterval(() => ch.postMessage({ t: "ping", id, lv: level }), PING_EVERY);
    // "Is anything still there?" — keyed off the HEARTBEAT, so a paused player
    // stays connected. Only a player tab that has actually gone away (closed,
    // navigated, crashed) stops sending one.
    watchTimer = setInterval(() => {
      if (!alive) return;
      if (performance.now() / 1000 - lastBeat > HEARTBEAT_TIMEOUT / 1000) {
        alive = false;
        playing = false;
        // Let go of the source too, so whichever tab speaks next is followed
        // rather than being ignored for having a worse claim than a ghost.
        source = null;
        sourceRank = -1;
        report();
      }
    }, 1000);
    // Coming back to the foreground after the browser throttled this window's
    // timers: re-announce at once rather than waiting out a stretched interval.
    document.addEventListener("visibilitychange", onVisible);
    // And leave cleanly, so the player drops us immediately instead of holding
    // the analysis open until the timeout.
    window.addEventListener("pagehide", sayBye);
  }

  function onVisible() {
    if (!document.hidden) {
      try {
        ch?.postMessage({ t: "hello", id, lv: level });
      } catch {
        /* ignore */
      }
    }
  }
  function sayBye() {
    try {
      ch?.postMessage({ t: "bye", id });
    } catch {
      /* ignore */
    }
  }

  return {
    get supported() {
      return !!ch;
    },
    /**
     * The projector's own scene changed, so what it needs from the analysis
     * changed too. Announced immediately rather than at the next ping: a
     * viewer that switched to `smart` should not draw two beat-less bars while
     * a twenty-second timer runs down.
     */
    setLevel(lv) {
      if (!Number.isFinite(lv) || lv === level) return;
      level = lv;
      try {
        ch?.postMessage({ t: "ping", id, lv: level });
      } catch {
        /* the channel is gone; the next hello carries it */
      }
    },
    close() {
      clearInterval(pingTimer);
      clearInterval(watchTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", sayBye);
      sayBye();
      try {
        ch?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

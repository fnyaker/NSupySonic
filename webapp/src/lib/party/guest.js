// Joining a listen party: the browser around the scheduler (engine.js).
//
// A guest has no account and no session: everything it touches is under
// /api/party/<id>/, which only ever opens what the host is playing. It needs:
//
//   - an AudioContext, created INSIDE the tap on "Rejoindre" (autoplay rules),
//     with a limiter at the end — the host's chain has one, and normalisation
//     can push a quiet track up;
//   - the party clock (clock.js), and a bridge from it to the audio clock;
//   - the state, polled about once a second, faster near a predicted handover
//     so a correction from the host lands early in the new track;
//   - the chunks: Ogg Opus where the browser decodes it, FLAC where it does not
//     (the first refusal decides, and is remembered);
//   - the screen kept awake, because a phone that locks suspends Web Audio.

import { writable } from "svelte/store";
import { startClock } from "./clock.js";
import { PartyEngine, makeClockBridge } from "./engine.js";
import { compressorDelay } from "./latency.js";
import { serverTimeAt } from "./timeline.js";

const POLL_MS = 1000;
const POLL_FAST_MS = 350; // within HANDOVER_SOON of a predicted handover
const HANDOVER_SOON = 4000;
const TICK_MS = 200;
const OFFLINE_AFTER = 6000; // no answer this long: tell the listener
const MIN_PROBES = 4;
const FETCH_TIMEOUT = 20_000;

const FMT_KEY = "party.fmt";
const LAT_KEY = "party.latency";
const VOL_KEY = "party.volume";
const NAME_KEY = "party.name";

function readNum(key, dflt) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) ? v : dflt;
  } catch {
    return dflt;
  }
}
function write(key, v) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* private mode */
  }
}

export function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

// The state before joining: who is hosting and what is playing. null when the
// party does not exist (ended, or never did).
export async function peekParty(pid) {
  const res = await fetch(`/api/party/${encodeURIComponent(pid)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("party");
  return res.json();
}

// Must be called from a user gesture (it creates the AudioContext).
export function joinParty(pid, name) {
  const base = `/api/party/${encodeURIComponent(pid)}`;
  const view = writable({
    phase: "joining",
    state: null,
    status: "idle",
    clock: null,
    offline: false,
    suspended: false,
    latency: readNum(LAT_KEY, 0),
    volume: readNum(VOL_KEY, 1),
  });
  const patch = (o) => view.update((v) => ({ ...v, ...o }));

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  // iOS: without this, Web Audio follows the ringer switch and a phone on
  // silent plays nothing at all (Safari 16.4+).
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch {
    /* not supported */
  }
  ctx.resume().catch(() => {});

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -0.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.06;
  limiter.connect(ctx.destination);

  let latency = readNum(LAT_KEY, 0);
  let clockEst = null;
  let probes = 0;
  let waiting = null; // the latest state, while the clocks are not known yet
  let fmt = (() => {
    try {
      return localStorage.getItem(FMT_KEY) || "opus";
    } catch {
      return "opus";
    }
  })();
  let fmtProven = false;
  const rate = ctx.sampleRate === 44100 ? 44100 : 48000;

  let bridge = null;
  let engine = null;
  let lid = null;
  let stopped = false;
  let pollTimer = null;
  let tickTimer = null;
  let lastAnswer = performance.now();
  let wake = null;

  async function load(id, k) {
    // Bounded: a request that hangs would otherwise hold one of the engine's
    // two download slots for good.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
    let res;
    try {
      res = await fetch(`${base}/chunk/${encodeURIComponent(id)}/${k}?f=${fmt}&sr=${rate}`, { signal: ac.signal });
    } catch {
      throw { retry: 2 };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 503) throw { retry: Math.max(1, parseFloat(res.headers.get("Retry-After")) || 2) };
    if (res.status === 404) return null; // past the end, or no longer in the party
    if (!res.ok) throw { retry: 3 };
    const data = await res.arrayBuffer();
    let buf;
    try {
      buf = await ctx.decodeAudioData(data);
    } catch {
      if (fmt === "opus" && !fmtProven) {
        // This browser cannot decode Ogg Opus here: FLAC from now on.
        fmt = "flac";
        write(FMT_KEY, fmt);
        return load(id, k);
      }
      throw { retry: 2 };
    }
    fmtProven = true;
    return buf && buf.length ? buf : null;
  }

  (async () => {
    const graphDelay = await compressorDelay();
    if (stopped) return;
    // The first probes ride a fresh connection (its handshake is in the round
    // trip): a few are needed before an offset is worth placing audio on.
    bridge = makeClockBridge(
      ctx,
      () => (clockEst && probes >= MIN_PROBES ? clockEst.offset : null),
      () => latency,
      graphDelay
    );
    engine = new PartyEngine({
      ctx,
      load,
      serverNow: bridge.serverNow,
      toCtx: bridge.toCtx,
      destination: limiter,
      onChange: (status) => patch({ status }),
    });
    engine.setVolume(readNum(VOL_KEY, 1));
    // Where this device says it is on the shared clock — what an end-to-end
    // check compares with the host, and what a curious listener can read from
    // the console.
    (window.__nsParty = window.__nsParty || {}).guest = () => {
      const S = bridge.serverNow();
      return { S, heard: engine.heardAt(S), status: engine.status, clock: clockEst, fmt, latency };
    };
    // Learn the audio clock quickly at first (a reading every 50 ms for two
    // seconds), then keep it fresh on the tick.
    let quick = 40;
    const learn = setInterval(() => {
      bridge.sample();
      if (waiting && bridge.serverNow() != null) {
        const st = waiting;
        waiting = null;
        engine.apply(st);
      }
      if (--quick <= 0 || stopped) clearInterval(learn);
    }, 50);
    let suspended = false;
    tickTimer = setInterval(() => {
      if (!engine) return;
      bridge.sample();
      // A poll that landed before both clocks were known is applied the moment
      // they are, not a whole poll later — that second was most of "joining".
      if (waiting && bridge.serverNow() != null) {
        const st = waiting;
        waiting = null;
        engine.apply(st);
      }
      engine.tick();
      // Only on a change: the screen re-renders on every store update.
      if ((ctx.state !== "running") !== suspended) {
        suspended = !suspended;
        patch({ suspended });
      }
    }, TICK_MS);
    poll();
  })();

  const clock = startClock(`${base}/clock`, (e) => {
    if (e) probes++;
    clockEst = e;
    patch({ clock: e ? { spread: e.spread, rtt: e.rtt } : null });
  });

  // Join as a named listener (the host sees who is there). A reload keeps its
  // seat rather than appearing twice; a seat the server dropped (a tab frozen
  // in the background past the timeout) is taken again.
  const seatKey = `party.lid.${pid}`;
  let joining = false;
  async function takeSeat(fresh = false) {
    if (joining) return;
    joining = true;
    try {
      lid = fresh ? null : sessionStorage.getItem(seatKey);
      if (!lid) {
        const r = await fetch(`${base}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (r.ok) {
          lid = (await r.json()).lid;
          sessionStorage.setItem(seatKey, lid);
        }
      }
    } catch {
      /* listening works without a seat */
    } finally {
      joining = false;
    }
  }
  takeSeat();

  async function poll() {
    if (stopped) return;
    let next = POLL_MS;
    try {
      const q = new URLSearchParams();
      if (lid) q.set("l", lid);
      if (clockEst) q.set("q", clockEst.spread.toFixed(1));
      if (engine) q.set("st", engine.status);
      const res = await fetch(`${base}?${q}`, { cache: "no-store" });
      if (res.status === 404) {
        // Over (or it never existed). Let the music stop as it would at home.
        end("ended");
        return;
      }
      if (res.ok) {
        const st = await res.json();
        lastAnswer = performance.now();
        if (lid && st.me === false) takeSeat(true);
        if (engine) {
          if (bridge.serverNow() == null) waiting = st;
          else engine.apply(st);
        }
        patch({ phase: "live", state: st, offline: false });
        const S = bridge && bridge.serverNow();
        if (S != null && st.playing && st.next && st.anchor) {
          const h = serverTimeAt({ t: st.anchor.t, p: st.anchor.p }, st.next.at);
          if (h - S < HANDOVER_SOON && h - S > -2000) next = POLL_FAST_MS;
        }
      }
    } catch {
      /* the engine keeps playing the timeline it has */
    }
    if (performance.now() - lastAnswer > OFFLINE_AFTER) patch({ offline: true });
    if (!stopped) pollTimer = setTimeout(poll, next);
  }

  async function keepAwake() {
    try {
      if (navigator.wakeLock && document.visibilityState === "visible") {
        wake = await navigator.wakeLock.request("screen");
      }
    } catch {
      /* battery saver, or not supported */
    }
  }
  keepAwake();

  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    ctx.resume().catch(() => {});
    keepAwake();
    clearTimeout(pollTimer);
    poll();
  };
  document.addEventListener("visibilitychange", onVisible);
  const onHide = () => leaveBeacon();
  window.addEventListener("pagehide", onHide);

  function leaveBeacon() {
    if (!lid) return;
    try {
      navigator.sendBeacon(`${base}/leave`, JSON.stringify({ lid }));
      sessionStorage.removeItem(seatKey);
    } catch {
      /* ignore */
    }
  }

  function end(phase) {
    if (stopped) return;
    stopped = true;
    clearTimeout(pollTimer);
    clearInterval(tickTimer);
    clock.stop();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pagehide", onHide);
    if (engine) engine.stop();
    if (window.__nsParty) delete window.__nsParty.guest;
    try {
      if (wake) wake.release();
    } catch {
      /* ignore */
    }
    // Let the last fade finish before the context goes.
    setTimeout(() => ctx.close().catch(() => {}), 300);
    patch({ phase });
  }

  return {
    view,
    position: () => (engine ? engine.position() : 0),
    resume: () => ctx.resume().catch(() => {}),
    setVolume(v) {
      write(VOL_KEY, v);
      if (engine) engine.setVolume(v);
      patch({ volume: v });
    },
    // This device's own output delay (Bluetooth, a soundbar): positive plays
    // earlier to make up for it.
    setLatency(ms) {
      latency = Math.max(-500, Math.min(1000, Math.round(ms)));
      write(LAT_KEY, latency);
      if (engine) engine.realign();
      patch({ latency });
    },
    leave() {
      leaveBeacon();
      end("left");
    },
  };
}

export function rememberName(name) {
  write(NAME_KEY, name);
}

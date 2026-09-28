// The controlled side of a remote control: THIS device's player, lent.
//
// Two loops, both polling (supysonic/webui/remote.py says why): one PUBLISHES
// what the player is doing when it changes, one ASKS for commands and runs
// them. Commands run through the player store's own methods — a remote "next"
// is `player.next()` here, exactly what the owner's own button calls — so the
// engine, the crossfade, the queue top-ups, the lock screen all follow without
// knowing a remote was involved. The owner's own hand is never taken: their
// taps work as they always did, and the last action wins whoever made it.
//
// It costs nothing when nothing is lent: the loop starts only once a live link
// points at this device, polls every few seconds while nobody drives it, fast
// (~0.7 s) while somebody does, and stops the moment the server says no link
// is left. A network drop, a server restart, a reload: it picks up on its own
// — the server tells it the channel it knew is gone and it publishes it all
// again, and a command sent while it was reconnecting still lands.

import { get } from "svelte/store";
import { player, seekTo, playbackStatus, current } from "../stores.js";
import { logInfo } from "../log.js";
import { api } from "../api.js";
import { deviceId } from "./device.js";
import { remoteHost } from "./hoststate.js";
import { mirroredEntries, mirroredMap, snapshotSettings } from "./settings.js";
import { runCommand, slimTrack } from "./commands.js";
import { wire, jsonBody } from "./wire.js";

const FAST_MS = 700; // somebody is driving
// Links exist, nobody on them yet. This is also how long the FIRST tap of a
// controller that just opened its link can wait (the player only learns it is
// being driven at its next look): measured end to end, 2.8 s at a 3 s idle
// rate, which reads as a button that does nothing. A tiny in-memory GET every
// 1.5 s, only while something is lent, is the cheaper side of that trade.
const SLOW_MS = 1500;
const HEARTBEAT_MS = 15000; // re-anchor the position even when nothing moved
const SEEK_JUMP = 1.5; // s of position drift from the published line = a seek
const RETRY_MAX = 15000;

export { remoteHost };

let running = false;
let pollTimer = null;
let pubTimer = null;
let failures = 0;
let since = 0;
let chan = "";
let applied = 0; // last command seq run
let ackSent = 0;

// Where this tab is in the command stream, kept across a RELOAD: without it a
// reload a few seconds after running "next" would be handed the same "next"
// again (the server replays what is fresh to a player it has not seen) and
// skip twice. Per tab, so two tabs never share one cursor.
const CURSOR = "remote.host.cursor";
function loadCursor() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CURSOR) || "null");
    if (c && typeof c.chan === "string" && Number.isFinite(c.applied)) {
      chan = c.chan;
      applied = since = c.applied;
    }
  } catch {
    /* no storage: a reload may repeat one command, never lose one */
  }
}
function saveCursor() {
  try {
    sessionStorage.setItem(CURSOR, JSON.stringify({ chan, applied }));
  } catch {
    /* ignore */
  }
}

// Versions of what the channel holds. The page id makes them unique per load,
// so a reload is always "new" to the server.
const page = Math.random().toString(36).slice(2, 7);
let qn = 0;
let sn = 0;
let qv = "";
let sv = "";
let queueRef = null;
let queueDirty = true;
let settingsDirty = true;
let shape = "";
let line = { p: 0, at: 0, playing: false };
let lastPublishAt = 0;
let publishing = false;
let publishAgain = false;
const unsubs = [];

function readState() {
  return get(player);
}

function env() {
  return { player, seekTo, state: readState, settings: mirroredMap(), read: get };
}

/** Start (or nudge) the loops — right after a link is made on this device. */
export function startRemoteHost() {
  if (running) {
    schedulePoll(0);
    return;
  }
  running = true;
  failures = 0;
  chan = "";
  since = applied = 0;
  loadCursor();
  queueDirty = settingsDirty = true;
  watch();
  schedulePoll(0);
  logInfo("remote", "host started", deviceId(), { important: true });
}

export function stopRemoteHost() {
  if (!running) return;
  running = false;
  clearTimeout(pollTimer);
  clearTimeout(pubTimer);
  pollTimer = pubTimer = null;
  while (unsubs.length) unsubs.pop()();
  remoteHost.set({ active: false, controllers: [] });
  logInfo("remote", "host stopped — nothing lent", null, { important: true });
}

function watch() {
  // The transport, the track, the queue: publish when the SHAPE changes, not
  // on every progress tick (the store moves four times a second).
  unsubs.push(
    player.subscribe((s) => {
      if (s.queue !== queueRef) {
        queueRef = s.queue;
        qn += 1;
        qv = `${page}.${qn}`;
        queueDirty = true;
      }
      const t = s.queue[s.index];
      const key = [
        s.index,
        t ? t.deezer_id : "",
        s.playing,
        Math.round((s.duration || 0) * 10),
        s.volume,
        s.muted,
        s.shuffle,
        s.repeat,
        qv,
      ].join("|");
      if (key !== shape) {
        shape = key;
        publishSoon(80);
        return;
      }
      // Same shape: only a jump in position is news (a seek), measured against
      // the line last published — plain progress follows from that line.
      if (s.playing && line.at) {
        const expected = line.p + (line.playing ? (Date.now() - line.at) / 1000 : 0);
        if (Math.abs((s.currentTime || 0) - expected) > SEEK_JUMP) publishSoon(80);
      }
    })
  );
  unsubs.push(playbackStatus.subscribe(() => publishSoon(150)));
  for (const [, store] of mirroredEntries()) {
    let first = true;
    unsubs.push(
      store.subscribe(() => {
        if (first) {
          first = false;
          return;
        }
        sn += 1;
        sv = `${page}.${sn}`;
        settingsDirty = true;
        publishSoon(150);
      })
    );
  }
  if (!sv) sv = `${page}.0`;
}

function publishSoon(ms) {
  if (!running) return;
  if (pubTimer) return;
  pubTimer = setTimeout(() => {
    pubTimer = null;
    publish();
  }, ms);
}

async function publish() {
  if (!running) return;
  if (publishing) {
    publishAgain = true;
    return;
  }
  publishing = true;
  try {
    const s = readState();
    const status = get(playbackStatus);
    const cur = get(current);
    const payload = {
      chan,
      qv,
      sv,
      ack: applied,
      state: {
        index: s.index,
        playing: !!s.playing,
        p: s.currentTime || 0,
        duration: s.duration || (cur && cur.duration) || 0,
        volume: s.volume,
        muted: !!s.muted,
        shuffle: !!s.shuffle,
        repeat: s.repeat,
        status: status && status.state !== "idle" ? status.state : "",
        track: cur ? slimTrack(cur) : null,
        context: s.context || null,
      },
    };
    const sendQueue = queueDirty;
    const sendSettings = settingsDirty;
    if (sendQueue) payload.queue = s.queue.map(slimTrack);
    if (sendSettings) payload.settings = snapshotSettings();
    const { body, headers } = await jsonBody(payload);
    const r = await wire(`/api/remote/host/${deviceId()}`, { method: "POST", body, headers });
    if (!r.ok) return; // the poll loop owns the backoff; the next change retries
    if (!r.data || !r.data.active) {
      stopRemoteHost();
      return;
    }
    lastPublishAt = Date.now();
    line = { p: payload.state.p, at: lastPublishAt, playing: payload.state.playing };
    ackSent = applied;
    if (sendQueue) queueDirty = false;
    if (sendSettings) settingsDirty = false;
    // What the channel still lacks (a restart took it): send it right away.
    if (r.data.need_queue) queueDirty = true;
    if (r.data.need_settings) settingsDirty = true;
    if (r.data.need_queue || r.data.need_settings) publishSoon(0);
  } finally {
    publishing = false;
    if (publishAgain) {
      publishAgain = false;
      publishSoon(0);
    }
  }
}

function schedulePoll(ms) {
  if (!running) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function poll() {
  pollTimer = null;
  if (!running) return;
  const dev = deviceId();
  const r = await wire(`/api/remote/host/${dev}/poll?since=${since}&chan=${encodeURIComponent(chan)}`, {
    timeout: 6000,
  });
  if (!running) return;
  if (!r.ok) {
    // Offline, a restart, a 5xx: keep asking, less and less often. The player
    // itself plays on regardless — this only affects who can drive it.
    failures += 1;
    if (r.status === 401) {
      stopRemoteHost(); // logged out: whatever was lent went with the session
      return;
    }
    schedulePoll(Math.min(RETRY_MAX, 1000 * 2 ** Math.min(failures, 4)));
    return;
  }
  failures = 0;
  const d = r.data || {};
  if (!d.active) {
    stopRemoteHost();
    return;
  }
  if (d.reset || d.chan !== chan) {
    // A channel this page has not published to: the server restarted, or this
    // is the first look. Everything goes again, and the command numbers start
    // over with it.
    chan = d.chan;
    applied = since = 0;
    queueDirty = settingsDirty = true;
    publishSoon(0);
  } else if (!d.has_state) {
    queueDirty = settingsDirty = true;
    publishSoon(0);
  }
  let ran = 0;
  for (const cmd of d.cmds || []) {
    if (cmd.seq <= applied) continue;
    applied = cmd.seq;
    let what = null;
    try {
      what = runCommand(cmd, env());
    } catch (e) {
      logInfo("remote", `command ${cmd.op} failed: ${e && e.message}`, null, { important: true });
    }
    logInfo("remote", what ? `ran ${what}` : `ignored ${cmd.op}`);
    ran += 1;
  }
  since = Math.max(since, d.seq || 0, applied);
  saveCursor();
  const controllers = Array.isArray(d.controllers) ? d.controllers : [];
  remoteHost.set({ active: true, controllers });
  // Tell the controller its command landed (it holds its optimistic view until
  // then), and keep the position line fresh while nothing else moves.
  if (ran || applied > ackSent || Date.now() - lastPublishAt > HEARTBEAT_MS) publishSoon(ran ? 60 : 0);
  schedulePoll(controllers.length ? FAST_MS : SLOW_MS);
}

/** Cut every link onto this device — the owner's button, always within reach. */
export async function cutAll() {
  const dev = deviceId();
  try {
    await api.remoteRevokeDevice(dev);
  } finally {
    remoteHost.set({ active: false, controllers: [] });
    stopRemoteHost();
  }
}

// On the page's return to the foreground (and back online), ask at once: a
// hidden tab's timers are throttled, and the person driving should not wait
// for the browser to get round to it.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (running && !document.hidden) schedulePoll(0);
  });
  window.addEventListener("online", () => {
    if (running) schedulePoll(0);
  });
}

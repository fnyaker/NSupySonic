// The controlling side of a remote control: this page drives somebody else's
// player, through the same app.
//
// Nothing on screen knows. The player store is the one every view already
// reads and writes; on a remote control its methods are rebound to SEND what
// they would have done (commands.js#commandFor) while still doing it locally
// at once, so a tap answers instantly. The controlled player's state comes
// back about once a second and REPLACES the local view — except while a
// command of ours has not landed yet (the server echoes the last one the
// player ran, `ack`), which is what keeps a tap from flickering back for the
// half-second it takes to arrive. The position runs locally on the player's
// own line (a position at a server instant), extrapolated four times a second,
// so the seek bar moves as smoothly as it does over local audio.
//
// It resumes on its own. A dropped network, a sleeping phone, a server
// restart, the controlled player going away for a minute: the loop keeps
// asking, less and less often up to a few seconds, and asks at once when the
// browser says the network is back or the page is shown again. Commands are
// never queued across an outage — a pause pressed a minute ago is not what
// anyone wants when the link comes back — so a tap while offline says so.

import { writable, get } from "svelte/store";
import { player, current, seekTo, setPlaybackStatus, toasts } from "../stores.js";
import { beginTrack, audioReady } from "../ladder.js";
import { onRemoteEnded } from "../api.js";
import { logInfo } from "../log.js";
import { REMOTE, atLeast, forgetRemote, reloadHome } from "./mode.js";
import { commandFor, opLevel } from "./commands.js";
import { mirroredEntries, sameValue } from "./settings.js";
import { wire } from "./wire.js";

const POLL_MS = 1000;
const POLL_FAST_MS = 300; // just after a command: show its effect promptly
const POLL_HIDDEN_MS = 5000;
const FAST_WINDOW_MS = 3000;
const ACK_WAIT_MS = 2500; // how long a local, optimistic view is held
const RETRY_MAX_MS = 8000;
const TICK_MS = 250;

/**
 * What the banner shows. `phase`: connecting | live | reconnecting | ended.
 * `online`: whether the controlled player itself is reachable.
 */
export const remoteStatus = writable({
  phase: "connecting",
  online: false,
  level: REMOTE ? REMOTE.level : null,
  owner: REMOTE ? REMOTE.owner : "",
  device: REMOTE ? REMOTE.device : "",
  label: REMOTE ? REMOTE.label : "",
  restored: null,
  since: Date.now(),
});

const METHODS = [
  "playQueue",
  "playTrack",
  "shufflePlay",
  "addToQueue",
  "extend",
  "autoExtend",
  "playNext",
  "removeAt",
  "next",
  "prev",
  "jump",
  "toggle",
  "play",
  "pause",
  "setVolume",
  "toggleMute",
  "toggleShuffle",
  "cycleRepeat",
];
// Methods whose local effect lands on another track: the position restarts.
const MOVES = new Set(["playQueue", "playTrack", "shufflePlay", "next", "jump", "autoExtend"]);

let started = false;
let ended = false;
let pollTimer = null;
let tickTimer = null;
let failures = 0;
let qv = null;
let sv = null;
let anchor = null; // {p, t (server ms), playing, duration}
let skew = 0; // server clock minus this one, ms
let pending = { seq: 0, at: 0 };
let fastUntil = 0;
let applyingSettings = false;
let settingsReady = false;
let known = {}; // the controlled player's settings, as last received
const orig = {};

const serverNow = () => Date.now() + skew;

export function startController() {
  if (started || !REMOTE) return;
  started = true;
  rebindPlayer();
  watchSeek();
  watchTrack();
  watchSettings();
  onRemoteEnded(end);
  window.addEventListener("online", () => pollNow());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollNow();
  });
  tickTimer = setInterval(tick, TICK_MS);
  poll();
  logInfo("remote", `controlling ${REMOTE.owner}'s player (${REMOTE.level})`, REMOTE.device, {
    important: true,
  });
}

// -- the player store, rebound --------------------------------------------------

function rebindPlayer() {
  for (const name of METHODS) orig[name] = player[name].bind(player);
  // playTrack calls this.playQueue: locally it must reach the ORIGINAL, or the
  // one tap would be sent twice.
  const local = {
    ...orig,
    playTrack: (track, context) => orig.playQueue([track], 0, context),
  };
  for (const name of METHODS) {
    player[name] = (...args) => {
      const before = get(player);
      const cmd = commandFor(name, args, before);
      if (!cmd) return undefined;
      if (!atLeast(opLevel(cmd.op, cmd.args))) {
        refuse();
        return undefined;
      }
      const out = local[name](...args);
      afterLocal(name, before);
      send(cmd);
      return out;
    };
  }
  // Nothing of the controlled player's is ever saved on this device.
  player.flushSession = () => {};
}

// Re-anchor the local line on what the tap just did, so the extrapolation
// runs from where the user now expects it to be.
function afterLocal(name, before) {
  const s = get(player);
  const moved = MOVES.has(name) && (s.index !== before.index || s.queue !== before.queue);
  if (moved) {
    const t = s.queue[s.index];
    player.setProgress(0, (t && t.duration) || 0);
  }
  const now = get(player);
  anchor = {
    p: moved ? 0 : now.currentTime || 0,
    t: serverNow(),
    playing: !!now.playing,
    duration: now.duration || 0,
  };
}

function refuse() {
  toasts.push(
    REMOTE && REMOTE.level === "queue"
      ? "Ce lien ne permet que la lecture et la file d'attente"
      : "Ce lien est en lecture seule",
    "info"
  );
}

// -- sending -------------------------------------------------------------------

// A drag on the seek bar or the volume slider fires dozens of inputs a second;
// only the last one of each burst is worth a request.
const COALESCE_MS = 150;
const coalesced = new Map(); // op -> {timer, cmd}

function send(cmd) {
  fastUntil = Date.now() + FAST_WINDOW_MS;
  if (cmd.op === "seek" || cmd.op === "volume") {
    const c = coalesced.get(cmd.op);
    if (c) {
      c.cmd = cmd;
      return;
    }
    const entry = { cmd, timer: null };
    entry.timer = setTimeout(() => {
      coalesced.delete(cmd.op);
      post(entry.cmd);
    }, COALESCE_MS);
    coalesced.set(cmd.op, entry);
    // Hold the local view from the first input of the burst.
    pending = { seq: Number.MAX_SAFE_INTEGER, at: Date.now() };
    return;
  }
  post(cmd);
}

async function post(cmd) {
  pending = { seq: Number.MAX_SAFE_INTEGER, at: Date.now() };
  const r = await wire("/api/remote/cmd", { method: "POST", body: JSON.stringify(cmd), timeout: 6000 });
  if (r.ok && r.data && r.data.seq) {
    pending = { seq: r.data.seq, at: Date.now() };
    schedulePoll(POLL_FAST_MS);
    return;
  }
  // Whatever went wrong, the controlled player's own state is the truth: drop
  // the local view at the next read.
  pending = { seq: 0, at: 0 };
  if (r.status === 401 && r.data && r.data.error === "remote ended") return end(r.data.restored);
  if (r.status === 409) toasts.push("Le lecteur est injoignable pour l'instant", "error");
  else if (r.status === 403) refuse();
  else if (r.network) toasts.push("Connexion perdue — l'action n'a pas été envoyée", "error");
  else toasts.push("Action refusée par le lecteur", "error");
  pollNow();
}

function watchSeek() {
  // Every view seeks through `seekTo` (the engine's inbox on a local player).
  // Here it is the controller's: move the local line, send the position.
  seekTo.subscribe((t) => {
    if (t == null || ended) return;
    seekTo.set(null);
    const d = get(player).duration || 0;
    const at = Math.max(0, d ? Math.min(+t, d) : +t);
    player.setProgress(at, d);
    anchor = { ...(anchor || {}), p: at, t: serverNow(), playing: get(player).playing, duration: d };
    send({ op: "seek", args: { t: at } });
  });
}

// What waits on "the audio of this track is under way" (lib/ladder.js: the
// lyrics) waits on the element Player.svelte drives — which a remote control
// never mounts. There is no audio here to race, so each track is ready the
// moment it is the current one. A queue-only link reads no lyrics at all.
function watchTrack() {
  if (!atLeast("read")) return;
  let id = null;
  current.subscribe((t) => {
    const next = t && t.deezer_id != null ? String(t.deezer_id) : null;
    if (next === id) return;
    id = next;
    beginTrack(next);
    if (next) audioReady(next);
  });
}

function watchSettings() {
  for (const [key, store] of mirroredEntries()) {
    store.subscribe((value) => {
      if (applyingSettings || !settingsReady || ended) return;
      if (!(key in known) || sameValue(value, known[key])) return;
      const cmd = { op: "set", args: { key, value } };
      if (!atLeast(opLevel("set", cmd.args))) {
        // Put it back: this link cannot change that setting.
        applyingSettings = true;
        store.set(known[key]);
        applyingSettings = false;
        refuse();
        return;
      }
      known = { ...known, [key]: value };
      send(cmd);
    });
  }
}

// -- reading -------------------------------------------------------------------

function schedulePoll(ms) {
  if (ended) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

function pollNow() {
  if (!ended) schedulePoll(0);
}

async function poll() {
  pollTimer = null;
  if (ended) return;
  const t0 = Date.now();
  const r = await wire("/api/remote/state?sv=" + encodeURIComponent(sv ?? ""), { timeout: 6000 });
  const t1 = Date.now();
  if (ended) return;
  if (r.status === 401) return end(r.data && r.data.error === "remote ended" ? r.data.restored : null);
  if (!r.ok || !r.data) {
    failures += 1;
    remoteStatus.update((s) => ({ ...s, phase: "reconnecting" }));
    schedulePoll(Math.min(RETRY_MAX_MS, 500 * 2 ** Math.min(failures, 4)));
    return;
  }
  failures = 0;
  const d = r.data;
  // The server's clock, to the round trip: good to well under the tenth of a
  // second a seek bar can show.
  if (typeof d.now === "number") skew = d.now - (t0 + t1) / 2;
  remoteStatus.update((s) => ({
    ...s,
    phase: "live",
    online: !!d.online,
    level: d.remote ? d.remote.level : s.level,
    label: d.remote ? d.remote.label : s.label,
    device: d.remote && d.remote.device ? d.remote.device : s.device,
  }));
  if (d.settings) applySettings(d.settings, d.sv);
  if (d.state) {
    if (d.state.qv !== qv) await loadQueue(d.state.qv);
    applyState(d.state, d.ack || 0);
  }
  const hidden = typeof document !== "undefined" && document.hidden;
  schedulePoll(hidden ? POLL_HIDDEN_MS : Date.now() < fastUntil ? POLL_FAST_MS : POLL_MS);
}

let queue = [];
async function loadQueue(want) {
  const r = await wire("/api/remote/queue", { timeout: 10000 });
  if (!r.ok || !r.data || !Array.isArray(r.data.queue)) return;
  queue = r.data.queue;
  qv = r.data.qv;
  if (qv !== want) qv = null; // moved again under us: read it once more next time
}

function applyState(st, ack) {
  // Our own tap is still on its way: keep showing what it did.
  if (pending.seq > ack && Date.now() - pending.at < ACK_WAIT_MS) return;
  pending = { seq: 0, at: 0 };
  anchor = { p: st.p || 0, t: st.t || serverNow(), playing: !!st.playing, duration: st.duration || 0 };
  const q = qv === st.qv ? queue : get(player).queue;
  player.update((s) => {
    const was = s.queue[s.index];
    const now = q[st.index];
    const changed = (was && was.deezer_id) !== (now && now.deezer_id);
    return {
      ...s,
      queue: q,
      index: st.index,
      playing: !!st.playing,
      currentTime: position(),
      duration: st.duration || (now && now.duration) || 0,
      volume: st.volume,
      muted: !!st.muted,
      shuffle: !!st.shuffle,
      repeat: st.repeat || "off",
      context: st.context || null,
      seq: changed ? s.seq + 1 : s.seq,
    };
  });
  setPlaybackStatus(st.status || "idle");
}

function applySettings(settings, version) {
  applyingSettings = true;
  try {
    for (const [key, store] of mirroredEntries()) {
      if (!(key in settings)) continue;
      if (!sameValue(get(store), settings[key])) store.set(settings[key]);
    }
  } finally {
    applyingSettings = false;
  }
  known = { ...settings };
  sv = version;
  settingsReady = true;
}

function position() {
  if (!anchor) return 0;
  const p = anchor.p + (anchor.playing ? (serverNow() - anchor.t) / 1000 : 0);
  return anchor.duration ? Math.max(0, Math.min(anchor.duration, p)) : Math.max(0, p);
}

function tick() {
  if (ended || !anchor || !anchor.playing) return;
  const s = get(player);
  player.setProgress(position(), s.duration);
}

// -- ending --------------------------------------------------------------------

function end(restored) {
  if (ended) return;
  ended = true;
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  for (const c of coalesced.values()) clearTimeout(c.timer);
  coalesced.clear();
  forgetRemote();
  player.update((s) => ({ ...s, playing: false }));
  remoteStatus.update((s) => ({ ...s, phase: "ended", online: false, restored: restored || null }));
  logInfo("remote", "control ended", restored ? restored.name : null, { important: true });
}

/** Stop driving and hand the browser back its own account, if it had one. */
export async function leaveRemote() {
  let restored = null;
  try {
    const r = await wire("/api/remote/leave", { method: "POST", body: "{}" });
    restored = r.data && r.data.restored;
  } finally {
    forgetRemote();
    reloadHome();
  }
}

export { reloadHome };

export const remoteController = { poll: pollNow };

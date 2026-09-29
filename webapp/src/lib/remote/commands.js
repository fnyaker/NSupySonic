// What crosses between a remote control and the player it drives.
//
// The two sides run the SAME app, so a command is simply a player-store method
// said over the wire: the controller turns `player.next()` into {op: "next"}
// (commandFor), the controlled player turns it back into `player.next()` on its
// own store (runCommand), and its engine does the rest exactly as if the owner
// had tapped the button. Nothing here knows about audio.
//
// Pure, on purpose — test/remote.test.mjs drives both halves on plain objects.

import { settingLevel } from "./settings.js";

// Each command and the lowest level that may send it — the server's table
// (supysonic/webui/remote.py#OPS), which is the one that is enforced. The
// client keeps its own copy only to not offer what it would be refused.
export const OPS = {
  play: "queue",
  pause: "queue",
  toggle: "queue",
  next: "queue",
  prev: "queue",
  seek: "queue",
  jump: "queue",
  volume: "queue",
  mute: "queue",
  shuffle: "read",
  repeat: "read",
  remove: "read",
  move: "read",
  clear: "read",
  add: "read",
  play_next: "read",
  play_queue: "read",
  shuffle_play: "read",
  set: "read",
};

export function opLevel(op, args) {
  if (!(op in OPS)) return null;
  if (op === "set") return settingLevel((args && args.key) || "");
  return OPS[op];
}

// The server takes at most this many tracks in one command.
export const MAX_ADD = 2000;
export const MAX_QUEUE = 5000;

// A track id that can stand in a URL path segment: the server drops any other.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const playableId = (t) => !!t && ID_RE.test(String(t.deezer_id ?? ""));

const pick = (o, keys) => {
  if (!o || typeof o !== "object") return undefined;
  const out = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
};

/**
 * A track as the other side needs it: what the lists and the player DRAW, and
 * nothing else. A 1000-track queue crosses in full whenever it changes, and a
 * podcast episode's description alone can be a paragraph.
 */
export function slimTrack(t) {
  if (!t || typeof t !== "object") return null;
  const out = pick(t, [
    "deezer_id",
    "title",
    "duration",
    "explicit",
    "local",
    "podcast",
    "gain",
    "unavailable",
    "archived",
    "published",
    "channel_id",
    "cover",
    "display_artist",
  ]);
  out.deezer_id = String(t.deezer_id);
  if (t.artist) out.artist = pick(t.artist, ["deezer_id", "name"]);
  if (Array.isArray(t.artists))
    out.artists = t.artists.slice(0, 12).map((a) => pick(a, ["deezer_id", "name", "role"]));
  if (t.album) out.album = pick(t.album, ["deezer_id", "title", "cover"]);
  return out;
}

/**
 * The tracks a list command carries, and where `start` lands in them.
 *
 * The server drops what it could not play, so the list is cleaned HERE and
 * the start index recomputed against the cleaned list — otherwise one
 * unplayable row before the tapped one would start the wrong track. A list
 * longer than the server takes is cut to a window around the tapped track.
 */
export function packTracks(tracks, start = 0, cap = MAX_QUEUE) {
  const src = Array.isArray(tracks) ? tracks : [];
  const wanted = src[Math.min(Math.max(start | 0, 0), Math.max(0, src.length - 1))];
  let list = src.filter(playableId);
  let at = Math.max(0, list.indexOf(wanted));
  if (list.length > cap) {
    const from = Math.min(Math.max(0, at - (cap >> 1)), list.length - cap);
    list = list.slice(from, from + cap);
    at -= from;
  }
  return { tracks: list.map(slimTrack), start: at };
}

const slimContext = (c) => (c && typeof c === "object" ? pick(c, ["kind", "id", "title"]) : null);

/**
 * The command a player-store method call becomes on a remote control, or null
 * when it means nothing to send (a jump to a row that does not exist).
 * `state` is the store as the controller sees it, for index-based calls.
 */
export function commandFor(method, args, state) {
  const [a, b, c] = args;
  const queue = (state && state.queue) || [];
  switch (method) {
    case "play":
    case "pause":
    case "toggle":
    case "next":
    case "prev":
      return { op: method, args: {} };
    case "jump":
    case "removeAt": {
      const t = queue[a];
      if (!t || !playableId(t)) return null;
      return { op: method === "jump" ? "jump" : "remove", args: { i: a, id: String(t.deezer_id) } };
    }
    case "move": {
      const t = queue[a];
      if (!t || !playableId(t) || !Number.isInteger(b) || b < 0) return null;
      return { op: "move", args: { i: a, id: String(t.deezer_id), to: b } };
    }
    case "clearUpcoming":
      return { op: "clear", args: {} };
    case "setVolume":
      return { op: "volume", args: { v: Math.max(0, Math.min(1, +a || 0)) } };
    case "toggleMute":
      return { op: "mute", args: {} };
    case "toggleShuffle":
      return { op: "shuffle", args: {} };
    case "cycleRepeat":
      return { op: "repeat", args: {} };
    case "playTrack": {
      if (!playableId(a)) return null;
      return { op: "play_queue", args: { tracks: [slimTrack(a)], start: 0, context: slimContext(b) } };
    }
    case "playQueue": {
      const p = packTracks(a, b || 0);
      if (!p.tracks.length) return null;
      return { op: "play_queue", args: { tracks: p.tracks, start: p.start, context: slimContext(c) } };
    }
    case "shufflePlay": {
      const p = packTracks(a, 0);
      if (!p.tracks.length) return null;
      return { op: "shuffle_play", args: { tracks: p.tracks, context: slimContext(b) } };
    }
    case "addToQueue":
    case "extend":
    case "autoExtend":
    case "playNext": {
      const tracks = (Array.isArray(a) ? a : []).filter(playableId).slice(0, MAX_ADD).map(slimTrack);
      if (!tracks.length) return null;
      return { op: method === "playNext" ? "play_next" : "add", args: { tracks } };
    }
    default:
      return null;
  }
}

/**
 * Where row `i` of the controller's view of the queue is NOW.
 *
 * Between the controller reading the queue and the command landing, the
 * player may have moved it (a Flow top-up, the owner's own edit). The row is
 * named by index AND id: the index when it still holds that id, else the
 * nearest row that does, else nothing — a jump to the wrong track is worse
 * than no jump.
 */
export function resolveIndex(queue, i, id) {
  if (!Array.isArray(queue)) return -1;
  if (queue[i] && String(queue[i].deezer_id) === id) return i;
  let best = -1;
  for (let k = 0; k < queue.length; k++) {
    if (String(queue[k]?.deezer_id) !== id) continue;
    if (best < 0 || Math.abs(k - i) < Math.abs(best - i)) best = k;
  }
  return best;
}

/** Whether a mirrored setting may take `value` (same shape as what it holds). */
export function acceptableSetting(current, value) {
  if (Array.isArray(current) || Array.isArray(value)) return Array.isArray(current) && Array.isArray(value);
  if (current === null || current === undefined) return value === null || typeof value !== "object";
  return typeof current === typeof value;
}

/**
 * Run one command on this device's player. `env` is {player, seekTo, state,
 * settings: Map<key, store>, read(store)}. Returns a short description for
 * the log, or null when the command was refused or meant nothing any more.
 */
export function runCommand(cmd, env) {
  const { player, seekTo } = env;
  const a = cmd.args || {};
  const s = env.state();
  switch (cmd.op) {
    case "play":
    case "pause":
    case "toggle":
    case "next":
    case "prev":
      player[cmd.op]();
      return cmd.op;
    case "seek": {
      const t = Math.max(0, +a.t || 0);
      const d = s.duration || 0;
      seekTo.set(d > 0 ? Math.min(t, Math.max(0, d - 0.25)) : t);
      return `seek ${t.toFixed(1)}`;
    }
    case "jump":
    case "remove": {
      const i = resolveIndex(s.queue, a.i | 0, String(a.id || ""));
      if (i < 0) return null;
      if (cmd.op === "jump") player.jump(i);
      else player.removeAt(i);
      return `${cmd.op} ${i}`;
    }
    case "move": {
      // Named by index AND id like a removal; the destination is an index in
      // the controller's view, carried over by however far the row itself moved.
      const i = resolveIndex(s.queue, a.i | 0, String(a.id || ""));
      if (i < 0) return null;
      const to = Math.max(0, Math.min(s.queue.length - 1, (a.to | 0) + (i - (a.i | 0))));
      player.move(i, to);
      return `move ${i} -> ${to}`;
    }
    case "clear":
      player.clearUpcoming();
      return "clear";
    case "volume":
      player.setVolume(Math.max(0, Math.min(1, +a.v || 0)));
      return `volume ${(+a.v || 0).toFixed(2)}`;
    case "mute":
      player.toggleMute();
      return "mute";
    case "shuffle":
      player.toggleShuffle();
      return "shuffle";
    case "repeat":
      player.cycleRepeat();
      return "repeat";
    case "add":
    case "play_next": {
      const tracks = (a.tracks || []).filter(playableId);
      if (!tracks.length) return null;
      if (cmd.op === "add") player.addToQueue(tracks);
      else player.playNext(tracks);
      return `${cmd.op} ${tracks.length}`;
    }
    case "play_queue": {
      const tracks = (a.tracks || []).filter(playableId);
      if (!tracks.length) return null;
      player.playQueue(tracks, a.start | 0, a.context || null);
      return `play_queue ${tracks.length}@${a.start | 0}`;
    }
    case "shuffle_play": {
      const tracks = (a.tracks || []).filter(playableId);
      if (!tracks.length) return null;
      player.shufflePlay(tracks, a.context || null);
      return `shuffle_play ${tracks.length}`;
    }
    case "set": {
      const store = env.settings.get(a.key);
      if (!store) return null;
      if (!acceptableSetting(env.read(store), a.value)) return null;
      store.set(a.value);
      return `set ${a.key}`;
    }
    default:
      return null;
  }
}

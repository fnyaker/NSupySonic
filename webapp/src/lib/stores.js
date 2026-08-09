import { writable, derived, get } from "svelte/store";
import { logInfo, flushLog } from "./log.js";

// -- auth -------------------------------------------------------------------

export const user = writable(null);
export const authChecked = writable(false);

// Only the admin owns the Deezer account: its playlists, favorites, Flow,
// recommendations and listen telemetry. Everyone else is a guest — Deezer is
// just a content source, their favorites are private/local. The UI hides the
// owner-only bits accordingly (the backend enforces it regardless).
export const isAdmin = derived(user, ($u) => !!($u && $u.admin));

// -- small persistence helper ----------------------------------------------

function persisted(key, initial) {
  let start = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) start = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const store = writable(start);
  store.subscribe((v) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  });
  return store;
}

// -- UI panels --------------------------------------------------------------

export const nowPlayingOpen = persisted("ui.nowPlaying", false);
export const sidebarOpen = writable(false); // mobile drawer
export const immersiveOpen = writable(false); // full-screen now-playing view
// Seek request (seconds) consumed by the <audio> owner (Player.svelte), so any
// view can drive the transport without holding the element.
export const seekTo = writable(null);

// How far the current track is buffered ahead (seconds), published by the audio
// owner so every seek bar can paint the loaded region. Seeking past it means a
// re-buffer (a brief pause), so showing it makes that behaviour legible.
export const buffered = writable(0);

// What the player is actually DOING when it isn't cleanly playing — so the UI
// can say why "it isn't playing even though I pressed play" instead of showing
// a lying pause icon over silence. Driven solely by Player.svelte.
//   idle            — playing normally (or nothing loaded): show nothing
//   loading         — a new track's source is being attached
//   buffering       — the element ran out of data mid-play (waiting/stalled)
//   archiving       — server is fetching/transcoding this track for the 1st time
//   waiting-network — offline; holding the track, will resume on reconnect
//   recovering      — a stall/error is being retried (carries attempt/max)
//   error           — the track could not be played at all
export const playbackStatus = writable({ state: "idle", since: 0, attempt: 0, max: 0 });
export function setPlaybackStatus(state, extra = {}) {
  playbackStatus.update((s) =>
    s.state === state && s.attempt === (extra.attempt || 0)
      ? s
      : { state, since: Date.now(), attempt: extra.attempt || 0, max: extra.max || 0 }
  );
}

// Web-player streaming quality (FLAC | MP3_320 | MP3_128).
export const quality = persisted("player.quality", "FLAC");

// -- audio effects (opt-in DSP chain) ---------------------------------------
// All three default OFF: when nothing is engaged the player keeps a PURE audio
// path (no Web Audio graph), which is what preserves reliable background
// playback on mobile. Enabling any effect routes audio through the processor.
//
// Ten-band graphic EQ. Frequencies are fixed (see visualizer.js EQ_FREQS);
// each entry is a gain in dB in [-12, +12], 0 = flat.
export const eqEnabled = persisted("fx.eq.enabled", false);
export const eqBands = persisted("fx.eq.bands", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
// Bass enhancement, 0..1 (a low-shelf lift). A brick-wall limiter always sits
// at the end of the chain so a heavy lift can't clip/saturate the output.
export const bassBoost = persisted("fx.bass", 0);
// Volume normalization strength: "off" | "low" | "medium" | "high". A
// dynamics compressor + make-up gain that evens out loud/quiet tracks.
export const normalization = persisted("fx.normalize", "off");

// The user's own saved presets. A preset captures the WHOLE audio setup —
// EQ on/off + the ten band gains, the bass lift and the normalization level —
// not just the curve, because that's what "my setup for headphones" or "my
// setup for the car" actually means.
//   [{ id, name, eq: bool, bands: number[10], bass: number, norm: string }]
export const fxPresets = persisted("fx.presets", []);

export function saveFxPreset(name) {
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) return null;
  const snapshot = {
    id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: clean,
    eq: get(eqEnabled),
    bands: get(eqBands).slice(),
    bass: get(bassBoost),
    norm: get(normalization),
  };
  fxPresets.update((list) => {
    // Saving under an existing name overwrites it rather than piling up
    // near-duplicates — that's what the user means by re-saving.
    const i = list.findIndex((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (i < 0) return [...list, snapshot];
    const next = list.slice();
    next[i] = { ...snapshot, id: list[i].id };
    return next;
  });
  return snapshot;
}

export function applyFxPreset(preset) {
  if (!preset) return;
  if (Array.isArray(preset.bands) && preset.bands.length === 10)
    eqBands.set(preset.bands.slice());
  eqEnabled.set(!!preset.eq);
  bassBoost.set(Math.max(0, Math.min(1, +preset.bass || 0)));
  normalization.set(
    ["off", "low", "medium", "high"].includes(preset.norm) ? preset.norm : "off"
  );
}

export function deleteFxPreset(id) {
  fxPresets.update((list) => list.filter((p) => p.id !== id));
}

// -- offline / downloads ----------------------------------------------------

// Default quality used when downloading a track to the device (overridable per
// download). Opus 320 is the sweet spot of quality vs on-device size.
export const downloadQuality = persisted("offline.quality", "OPUS_320");
// Set of track ids currently stored on the device, and the total bytes used —
// kept in memory (loaded from IndexedDB at startup) for instant UI state.
export const downloads = writable(new Set());
export const downloadsSize = writable(0);
// Track ids whose download is in flight (for spinners / progress).
export const downloading = writable(new Set());
// Cached cover art (from BOTH permanent downloads and the playback cache): maps
// a remote cover URL (what the UI renders) to a local blob: object URL, so
// pochettes show offline. Populated from IndexedDB at startup; both offline.js
// and playcache.js merge into it, and Cover.svelte resolves through it.
export const offlineCovers = writable({});

// -- playback cache (ephemeral, LRU, capped) --------------------------------
// Distinct from downloads: the next track is prefetched here during playback so
// a network drop doesn't interrupt it, and re-buffers are served locally. Auto-
// managed — evicted oldest-first once over the cap.
export const playCacheLimit = persisted("cache.limit", 1024 * 1024 * 1024); // 1 GB
export const playCacheSize = writable(0);
// Whether to prefetch upcoming tracks into the cache during playback. On by
// default (resilience); can be turned off to save mobile data.
export const prefetchEnabled = persisted("cache.prefetch", true);
// How many upcoming tracks to keep ahead in that cache (1..10). One is enough to
// ride out a network drop; a bigger buffer is what carries you through a tunnel,
// a plane, or a dead cell — at the cost of data and disk. Clamped on read so a
// hand-edited localStorage value can't ask for a thousand.
export const PREFETCH_MAX = 10;
export const prefetchCount = persisted("cache.prefetchCount", 1);
export function setPrefetchCount(n) {
  const v = Math.round(Number(n));
  prefetchCount.set(Number.isFinite(v) ? Math.max(1, Math.min(PREFETCH_MAX, v)) : 1);
}
export function prefetchAhead() {
  const v = Math.round(Number(get(prefetchCount)));
  return Number.isFinite(v) ? Math.max(1, Math.min(PREFETCH_MAX, v)) : 1;
}

// When offline, only queue tracks that are actually available on the device
// (downloaded / local) instead of trying — and skipping through — unplayable
// ones. On by default; the toggle is for people who'd rather queue everything.
export const offlineOnlyDownloaded = persisted("offline.onlyDownloaded", true);

// Filter applied to a queue when starting playback (play-all / shuffle / tap).
// Injected at startup (playfilter.js) so the offline-availability logic stays
// out of the store. Default identity — no effect until registered.
let _queueFilter = (tracks) => tracks;
export function setQueueFilter(fn) {
  _queueFilter = typeof fn === "function" ? fn : (t) => t;
}
export function filterQueue(tracks) {
  return _queueFilter(tracks);
}
// Track ids currently held in the playback cache (in-memory mirror for instant,
// synchronous lookups on the play path).
export const cachedIds = writable(new Set());

// Tracks the server has confirmed unplayable during THIS session. Lists already
// receive an `unavailable` flag from the API, but a track that dies mid-session
// (or was never listed) has to show up as such immediately, everywhere it
// appears, without refetching every page.
export const unavailableIds = writable(new Set());
export function markUnavailable(id) {
  if (!id) return;
  unavailableIds.update((s) => {
    const key = String(id);
    if (s.has(key)) return s;
    const next = new Set(s);
    next.add(key);
    return next;
  });
}
// The last track that stopped being a problem — replaced, deleted, or simply
// playable again. The library's "Indisponibles" list is fetched once and kept in
// component state; without this signal it kept showing a track the user had
// already dealt with, which reads as "it didn't work".
export const resolvedUnavailable = writable(null);

// Bumped once the SERVER has finished acting on it. The replace/delete work
// happens in a worker thread, so a list refetched at the moment the sheet closes
// still sees the old state — the row would vanish and then come back, which
// looks exactly like a failure.
export const unavailableVersion = writable(0);
export function unavailableChanged() {
  unavailableVersion.update((n) => n + 1);
}

export function clearUnavailable(id) {
  if (!id) return;
  resolvedUnavailable.set(String(id));
  unavailableIds.update((s) => {
    const key = String(id);
    if (!s.has(key)) return s;
    const next = new Set(s);
    next.delete(key);
    return next;
  });
}

// True while a manual Deezer sync is running (shared so every entry point — the
// sidebar button and the mobile library button — reflects/guards the same job).
export const syncing = writable(false);

// -- toasts -----------------------------------------------------------------

function createToasts() {
  const { subscribe, update } = writable([]);
  let id = 0;
  return {
    subscribe,
    push(message, kind = "info", ttl = 2600) {
      // Every verdict the app shows the user belongs in the log — a toast is
      // often the ONLY trace of a failure that was handled and swallowed.
      logInfo("toast", `[${kind}] ${message}`, null, { important: kind === "error" });
      const t = { id: ++id, message, kind };
      update((list) => [...list, t]);
      setTimeout(() => update((list) => list.filter((x) => x.id !== t.id)), ttl);
    },
    dismiss(tid) {
      update((list) => list.filter((x) => x.id !== tid));
    },
  };
}
export const toasts = createToasts();

// -- notices ----------------------------------------------------------------
// A toast says "done"; a notice says "something is wrong / something is
// available" and STAYS until it's resolved or dismissed. Used for the things
// the user must actually see: an expired Deezer credential, a downloaded app
// update waiting to be applied, a newer Android build to install.
//
// Keyed by id, so re-publishing the same condition updates it in place instead
// of stacking duplicates (the Deezer status is polled — without this, every
// poll would add another banner).
function createNotices() {
  const { subscribe, update } = writable([]);
  return {
    subscribe,
    // { id, kind: "info"|"warn"|"error", message, actionLabel?, action?,
    //   dismissible = true }
    push(notice) {
      if (!notice || !notice.id) return;
      logInfo("notice", `[${notice.kind || "info"}] ${notice.message}`, null, {
        important: notice.kind === "error",
      });
      update((list) => {
        const next = { dismissible: true, kind: "info", ...notice };
        const i = list.findIndex((n) => n.id === next.id);
        if (i === -1) return [...list, next];
        const copy = [...list];
        copy[i] = next;
        return copy;
      });
    },
    dismiss(id) {
      update((list) => list.filter((n) => n.id !== id));
    },
  };
}
export const notices = createNotices();

// -- playlists (quick-add UX) -------------------------------------------------

// Last playlist a track was added to ({id, title} | null), persisted — powers
// the one-tap "Ajouter à « X »" entry in the track menu.
export const lastPlaylist = persisted("playlist.lastUsed", null);

// Playlist picker sheet: pick (or search, or create) a playlist for a track.
// { track } | null — mounted once in App.svelte, opened from anywhere.
export const playlistPicker = writable(null);
export function openPlaylistPicker(track) {
  playlistPicker.set({ track });
}
export function closePlaylistPicker() {
  playlistPicker.set(null);
}

// -- share sheet -------------------------------------------------------------
// { track } | null — the full share UI (whole file or waveform-selected clip).
// Mounted once in App.svelte, opened from anywhere (menus, players).

export const shareSheet = writable(null);
export function openShare(track) {
  if (track && track.deezer_id) shareSheet.set({ track });
}
export function closeShare() {
  shareSheet.set(null);
}

// -- replacement sheet -------------------------------------------------------
// { track } | null — a track that can no longer be played, and the sheet that
// finds it a stand-in (a close match, or a file of your own) and swaps it
// everywhere it appears. Mounted once in App.svelte, opened from the track menu,
// from the badge on a dead row, and from the library's "indisponibles" section.
export const replaceSheet = writable(null);
export function openReplace(track) {
  if (track && track.deezer_id) replaceSheet.set({ track });
}
export function closeReplace() {
  replaceSheet.set(null);
}

// -- export sheet ------------------------------------------------------------
// { kind: "playlist" | "album" | "favorites", id, title } | null — pick a format
// and download the whole thing as a ZIP. Mounted once in App.svelte.

export const exportSheet = writable(null);
export function openExport(kind, id, title = "") {
  if (kind && id) exportSheet.set({ kind, id: String(id), title });
}
export function closeExport() {
  exportSheet.set(null);
}

// -- context menu -----------------------------------------------------------
// { x, y, items: [{label, icon, action, danger, sub:[...]}, "divider"] } | null

export const contextMenu = writable(null);

export function openMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  contextMenu.set({ x: event.clientX, y: event.clientY, items });
}
export function closeMenu() {
  contextMenu.set(null);
}

// -- favorites (set of deezer track ids for accurate heart state) -----------

function createFavorites() {
  const { subscribe, update, set } = writable(new Set());
  return {
    subscribe,
    set,
    add(id) {
      update((s) => new Set(s).add(String(id)));
    },
    remove(id) {
      update((s) => {
        const n = new Set(s);
        n.delete(String(id));
        return n;
      });
    },
    has(id) {
      return get({ subscribe }).has(String(id));
    },
  };
}
export const favorites = createFavorites();

// Full favorite tracks (with metadata), cached so re-opening the library is
// instant. null = never loaded yet. See actions.loadMyFavorites.
export const favTracks = writable(null);

// -- recently played (client-side) ------------------------------------------

export const recent = persisted("recent.tracks", []);
export function pushRecent(track) {
  if (!track || !track.deezer_id) return;
  recent.update((list) => {
    const next = [track, ...list.filter((t) => t.deezer_id !== track.deezer_id)];
    return next.slice(0, 30);
  });
}

// -- player -----------------------------------------------------------------

const savedVolume = persisted("player.volume", 1);
const savedMuted = persisted("player.muted", false);
const savedShuffle = persisted("player.shuffle", false);
const savedRepeat = persisted("player.repeat", "off"); // off | all | one
// Last session (queue/index/position/context), so a reload — or Android
// killing the backgrounded tab — resumes where you left off. Written through
// writeSession (not the `persisted` helper) so a quota failure can retry with
// a tighter queue window instead of silently saving nothing.
const SESSION_KEY = "player.session";
// The playhead position lives in its OWN tiny key ({index, id, time}, ~60
// bytes). During plain playback only this key is refreshed — re-serializing
// the whole queue (potentially hundreds of KB) 30×/min just to move the
// position was a pointless CPU/storage cost. The full session is only written
// on real actions: track/queue changes and play/pause.
const POS_KEY = "player.pos";
// Persisted-queue caps: keep as much of the queue as the quota allows (~1000
// tracks is well under localStorage limits), fall back to a tight window
// around the playing track if the write still fails.
const SESSION_CAP = 1000;
const SESSION_CAP_MIN = 100;

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
  return true;
}

function readSession() {
  const sess = readJSON(SESSION_KEY);
  if (!sess) return null;
  // Overlay the position tick when it's FRESHER than the full snapshot (both
  // carry a write timestamp) — during playback the tick is the up-to-date one,
  // right after a queue change the full snapshot is.
  //
  // The tick carries the INDEX as well as the time, and is trusted for both:
  // that's what lets a plain track change skip rewriting the whole queue (see
  // the subscriber below). The id at that index still has to match — but a
  // mismatch is repaired rather than dropped, see below.
  const pos = readJSON(POS_KEY);
  // The single most valuable line in the log: exactly what the two keys held at
  // boot, so a resume that lands on the wrong track can be explained instead of
  // guessed at.
  logInfo("restore", "read", {
    sess: sess && { i: sess.index, n: sess.queue?.length, age: Date.now() - (sess.at || 0) },
    pos: pos && { i: pos.i, id: pos.id, t: pos.t, age: Date.now() - (pos.at || 0) },
  }, { important: true });
  if (!pos || !Number.isInteger(pos.i) || typeof pos.t !== "number") {
    logInfo("restore", "no usable tick -> snapshot index " + sess.index);
    return sess;
  }
  if ((pos.at || 0) < (sess.at || 0)) {
    logInfo("restore", "snapshot is fresher -> index " + sess.index);
    return sess; // the snapshot is the fresh one
  }
  const queue = Array.isArray(sess.queue) ? sess.queue : [];
  if (queue[pos.i]?.deezer_id === pos.id) {
    sess.index = pos.i;
    sess.currentTime = pos.t;
    logInfo("restore", `tick accepted -> index ${pos.i} @ ${pos.t.toFixed(1)}s`);
    return sess;
  }

  // The tick doesn't line up with the snapshot's queue — but it is still the
  // FRESHER of the two, so simply ignoring it rewinds playback to wherever it
  // was at the last full save. That is what "coming back to the app jumps
  // several tracks back" was: the queue had been extended in the background
  // (Flow/radio topping itself up) and that write hadn't landed, while the
  // position ticks kept running on into the tracks it never recorded.
  // Recover rather than rewind.
  let found = -1;
  let ambiguous = false;
  for (let k = 0; k < queue.length; k++) {
    if (queue[k]?.deezer_id !== pos.id) continue;
    if (found >= 0) {
      ambiguous = true; // the same track twice: no way to tell which one
      break;
    }
    found = k;
  }
  if (found >= 0 && !ambiguous) {
    // Same queue, shifted indices (a re-windowed snapshot).
    sess.index = found;
    sess.currentTime = pos.t;
    logInfo("restore", `tick relocated ${pos.i} -> ${found}`, null, { important: true });
  } else if (found < 0 && queue.length && pos.i >= queue.length) {
    // Playback ran past everything the snapshot knows about. The exact track
    // is unrecoverable, but the last one we DO know about is far closer than
    // the stale index — and resuming forward never replays a whole run of
    // tracks the listener already heard.
    sess.index = queue.length - 1;
    sess.currentTime = 0;
    logInfo("restore", `tick ran past the queue (${pos.i} >= ${queue.length}) -> clamped`,
            null, { important: true });
  } else {
    logInfo("restore", `tick unusable (found=${found}, ambiguous=${ambiguous}) -> snapshot index ${sess.index}`,
            null, { important: true });
  }
  return sess;
}

// Run `fn` when the main thread is next idle, so a big serialize+write never
// lands in the same frame as a user interaction. Falls back to a short timer
// where requestIdleCallback isn't available (Safari before 16.4).
const runIdle =
  typeof requestIdleCallback === "function"
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(fn, 1);
const cancelIdle =
  typeof cancelIdleCallback === "function" ? cancelIdleCallback : clearTimeout;

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createPlayer() {
  const sess = readSession() || {};
  const restoredQueue = Array.isArray(sess.queue) ? sess.queue : [];
  const { subscribe, update, set } = writable({
    queue: restoredQueue,
    index:
      Number.isInteger(sess.index) && sess.index < restoredQueue.length
        ? sess.index
        : restoredQueue.length
          ? 0
          : -1,
    playing: false, // never auto-resume audio without a user gesture
    currentTime: sess.currentTime || 0, // seek bar starts where we left off
    duration: 0,
    // Bumped on every *deliberate* navigation (next/prev/jump/new queue). The
    // audio owner watches it so it can restart a track even when the next slot
    // holds the SAME deezer id (a duplicate in the queue, or a "restart current"
    // prev), where a plain id-change check would miss the transition.
    seq: 0,
    volume: get(savedVolume),
    muted: get(savedMuted),
    shuffle: get(savedShuffle),
    repeat: get(savedRepeat),
    autoplay: true, // autoplay is always on (no toggle)
    context: sess.context || null,
    _orig: Array.isArray(sess._orig) ? sess._orig : null,
  });

  // Persistence is split by WHAT CHANGES, not by when:
  //   POS_KEY  — {index, id, time}, ~60 bytes. Where playback is. Written
  //              synchronously on every track change and roughly every 2s of
  //              progress, and it is what a resume reads.
  //   SESSION_KEY — the queue (plus context/shuffle/repeat). Big, and written
  //              only when the queue itself changes, on an idle callback.
  // Splitting it this way is what keeps a track change costing 60 bytes instead
  // of a quarter of a megabyte, and it means a resume never depends on the two
  // keys agreeing with each other — see readSession.
  let saveIdle = null;
  let lastQueue = null;
  let lastPlaying = null;
  let lastIndexKey = "";
  let latest = null;
  // Offset of the persisted queue window inside the LIVE queue. A capped queue
  // is stored as a window around the playing track, so its indices are shifted;
  // the position tick has to record its index in the same coordinate space or
  // the restore would land on the wrong track.
  let savedOffset = 0;
  // When the last position tick was written, so the background path can pace
  // itself off the clock rather than off a timer the browser may not run.
  let lastPosAt = 0;
  function snapshot(s, cap = SESSION_CAP) {
    // Cap the persisted queue with a window AROUND the playing track — a plain
    // head slice restored the wrong track whenever the index was past the cap.
    let queue = s.queue;
    let index = s.index;
    let start = 0;
    if (queue.length > cap) {
      start = Math.min(Math.max(0, index - (cap >> 1)), queue.length - cap);
      queue = queue.slice(start, start + cap);
      index = index - start; // still -1 when nothing was playing (start is 0)
    }
    return {
      queue,
      index,
      start,
      currentTime: s.currentTime,
      context: s.context,
      shuffle: s.shuffle,
      repeat: s.repeat,
      _orig: s._orig ? s._orig.slice(0, cap) : null,
      at: Date.now(),
    };
  }
  function save(s) {
    // Quota blown by a huge queue: retry with a tight window around the
    // playing track so at least the position and nearby tracks survive.
    let snap = snapshot(s);
    if (!writeJSON(SESSION_KEY, snap)) {
      snap = snapshot(s, SESSION_CAP_MIN);
      writeJSON(SESSION_KEY, snap);
    }
    savedOffset = snap.start;
    logInfo("session", `queue written: n=${snap.queue.length} i=${snap.index} start=${snap.start}`,
            null, { important: true });
  }
  function savePos(s) {
    lastPosAt = Date.now();
    logInfo("pos", `i=${s.index - savedOffset} id=${s.queue[s.index]?.deezer_id ?? "-"} t=${(s.currentTime || 0).toFixed(1)}`);
    writeJSON(POS_KEY, {
      i: s.index - savedOffset, // same coordinates as the persisted window
      id: s.queue[s.index]?.deezer_id ?? null,
      t: s.currentTime,
      at: Date.now(),
    });
  }
  // Serialising a long queue and handing it to localStorage is synchronous
  // main-thread work — localStorage is disk I/O — so it runs on the next idle
  // moment instead of inside the store update. Measured at 6× CPU throttle with
  // a 1000-track queue: ~255 KB and 5–7 ms of blocking. That is why only a real
  // QUEUE change comes through here; a track change costs the ~60 byte tick.
  // Losing one of these to an idle callback that never fires is survivable —
  // the tick was already written synchronously and carries the track id, so the
  // restore repairs itself against the older queue (see readSession).
  function scheduleSave() {
    if (saveIdle !== null) return;
    saveIdle = runIdle(() => {
      saveIdle = null;
      if (latest) save(latest);
    });
  }
  // Write the freshest full state NOW — called when the page is hidden/frozen/
  // closed, the moments after which timers can't be trusted.
  function flushSession() {
    if (!latest) return;
    if (saveIdle !== null) {
      cancelIdle(saveIdle);
      saveIdle = null;
    }
    savePos(latest); // the position first: it is what a resume actually needs
    save(latest);
  }
  subscribe((s) => {
    latest = s;
    // What gets written, and how often:
    //
    //  - the POSITION tick ({index, id, time}, ~60 bytes) on every track change
    //    and, while playing, about every two seconds. It is the AUTHORITATIVE
    //    record of where playback is — readSession takes the position from it,
    //    never from the queue blob, so the two never have to agree.
    //  - the QUEUE blob only when the queue itself actually changes. It is the
    //    expensive one (a 1000-track queue is ~255 KB of JSON, 5-7 ms of
    //    blocking at 6x CPU throttle), and re-writing it on every track change
    //    is what used to hitch the player — and what made a resume depend on
    //    two keys agreeing.
    //
    // Deliberately NOT keyed off `document.hidden`. The Android app never calls
    // webView.onPause() (that is what kept background playback alive), so the
    // WebView is never told it is hidden and `document.hidden` stays false the
    // whole time the screen is off. A hidden-only path is dead code exactly
    // where it is needed most.
    const queueChanged = s.queue !== lastQueue;
    const playChanged = s.playing !== lastPlaying;
    const idxKey = `${s.index}|${s.queue[s.index]?.deezer_id ?? ""}`;
    const moved = idxKey !== lastIndexKey;
    lastQueue = s.queue;
    lastPlaying = s.playing;
    lastIndexKey = idxKey;

    if (queueChanged) {
      // Write the position FIRST and synchronously: it is tiny, it can't fail
      // for want of an idle moment, and it keeps the resume correct however
      // late the blob lands (or if it never does).
      savePos(s);
      scheduleSave();
    } else if (moved || playChanged) {
      savePos(s);
    } else if (Date.now() - lastPosAt >= 2000) {
      // Plain progress inside a track. Rate-limited off the CLOCK rather than a
      // timer: the store is updated ~4x/second by the audio element's
      // `timeupdate`, which keeps firing while audio plays, whereas a
      // setTimeout is throttled to as little as once a minute in a backgrounded
      // page and never runs at all in a frozen one.
      savePos(s);
    }
  });

  function clean(tracks) {
    return (tracks || []).filter((t) => t && t.deezer_id);
  }

  const player = {
    subscribe,
    set,
    update,

    playQueue(tracks, start = 0, context = null) {
      // Logged with a stack hint: if the player ever resets itself on returning
      // to the foreground, this is what will name the culprit.
      logInfo(
        "queue",
        `playQueue n=${(tracks || []).length} start=${start} ctx=${context?.kind || "-"}:${context?.id || "-"}`,
        { from: (new Error().stack || "").split("\n").slice(2, 5).join(" | ") },
        { important: true }
      );
      // Resolve the tapped track from the ORIGINAL list first: `start` is an
      // index into what the user saw, but clean() drops unplayable entries and
      // would shift the index, starting playback on the wrong track.
      const src = tracks || [];
      const wanted = src[Math.min(Math.max(start, 0), Math.max(0, src.length - 1))];
      let queue = clean(src);
      if (!queue.length) return;
      const startTrack = wanted && wanted.deezer_id ? wanted : queue[0];
      queue = filterQueue(queue);
      if (!queue.length) return;
      let index = queue.indexOf(startTrack);
      if (index < 0) index = 0;
      let _orig = null;
      update((s) => {
        if (s.shuffle) {
          const cur = queue[index];
          _orig = queue;
          queue = [cur, ...shuffled(queue.filter((_, i) => i !== index))];
          index = 0;
        }
        return { ...s, queue, index, playing: true, context, _orig, seq: s.seq + 1 };
      });
    },

    playTrack(track, context = null) {
      this.playQueue([track], 0, context);
    },

    shufflePlay(tracks, context = null) {
      const q = filterQueue(clean(tracks));
      if (!q.length) return;
      savedShuffle.set(true);
      update((s) => ({
        ...s,
        shuffle: true,
        queue: shuffled(q),
        index: 0,
        playing: true,
        context,
        _orig: q,
        seq: s.seq + 1,
      }));
    },

    addToQueue(tracks) {
      const extra = clean(tracks);
      if (!extra.length) return;
      update((s) => ({
        ...s,
        queue: [...s.queue, ...extra],
        _orig: s._orig ? [...s._orig, ...extra] : null,
        index: s.index < 0 ? 0 : s.index,
        playing: s.index < 0 ? true : s.playing,
      }));
      toasts.push(
        extra.length > 1 ? `${extra.length} titres ajoutés à la file` : "Ajouté à la file"
      );
    },

    // Append more tracks to the end of the queue, de-duplicated, no toast,
    // without changing the current index (used to keep Flow/radio endless).
    // Returns how many tracks were actually appended, so the caller can tell an
    // extension that did something from one that was entirely duplicates.
    extend(tracks) {
      const extra = clean(tracks);
      if (!extra.length) return 0;
      // Compute the delta BEFORE touching the store, and leave the store alone
      // when there is nothing to add. Returning the unchanged state from
      // update() is NOT free: svelte's safe_not_equal is unconditionally true
      // for objects, so subscribers fire anyway — and this store's subscribers
      // include the reactive block that calls the queue top-up, which then asks
      // for more tracks, gets the same duplicates, and notifies again. A radio
      // whose tracks are all already queued span that into a permanent request
      // storm (a /api/radio/track call every ~250ms, for hours), which pegs the
      // main thread and makes the whole UI stop responding.
      const s = get({ subscribe });
      const have = new Set(s.queue.map((t) => t.deezer_id));
      const add = extra.filter((t) => !have.has(t.deezer_id));
      if (!add.length) return 0;
      update((cur) => ({
        ...cur,
        queue: [...cur.queue, ...add],
        _orig: cur._orig ? [...cur._orig, ...add] : null,
      }));
      return add.length;
    },

    // Append + advance silently (used by autoplay/radio continuation).
    autoExtend(tracks) {
      const extra = clean(tracks);
      if (!extra.length) return;
      update((s) => ({
        ...s,
        queue: [...s.queue, ...extra],
        _orig: s._orig ? [...s._orig, ...extra] : null,
        index: s.index + 1,
        playing: true,
        seq: s.seq + 1,
      }));
    },

    playNext(tracks) {
      const extra = clean(tracks);
      if (!extra.length) return;
      update((s) => {
        const at = s.index < 0 ? 0 : s.index + 1;
        const queue = s.queue.slice();
        queue.splice(at, 0, ...extra);
        return {
          ...s,
          queue,
          index: s.index < 0 ? 0 : s.index,
          playing: s.index < 0 ? true : s.playing,
        };
      });
      toasts.push("Sera lu ensuite");
    },

    removeAt(i) {
      update((s) => {
        if (i < 0 || i >= s.queue.length) return s;
        const queue = s.queue.slice();
        queue.splice(i, 1);
        // Emptied the queue: stop, don't leave playing=true with index -1 (which
        // kept the <audio> element playing a track no longer in the queue while
        // the UI showed "nothing playing").
        if (!queue.length) return { ...s, queue, index: -1, playing: false };
        let index = s.index;
        if (i < s.index) index--;
        else if (i === s.index) index = Math.min(index, queue.length - 1);
        return { ...s, queue, index };
      });
    },

    next() {
      update((s) => {
        if (s.index < s.queue.length - 1)
          return { ...s, index: s.index + 1, playing: true, seq: s.seq + 1 };
        if (s.repeat === "all" && s.queue.length)
          return { ...s, index: 0, playing: true, seq: s.seq + 1 };
        return { ...s, playing: false };
      });
    },

    prev() {
      update((s) => {
        // restart current track if we're past 3s, else go back
        if (s.currentTime > 3) return { ...s, currentTime: 0, seq: s.seq + 1 };
        if (s.index > 0) return { ...s, index: s.index - 1, playing: true, seq: s.seq + 1 };
        return { ...s, currentTime: 0, seq: s.seq + 1 };
      });
    },

    jump(i) {
      update((s) =>
        i >= 0 && i < s.queue.length
          ? { ...s, index: i, playing: true, seq: s.seq + 1 }
          : s
      );
    },

    toggle() {
      update((s) => (s.index >= 0 ? { ...s, playing: !s.playing } : s));
    },

    play() {
      update((s) => (s.index >= 0 ? { ...s, playing: true } : s));
    },

    pause() {
      update((s) => ({ ...s, playing: false }));
    },

    setProgress(currentTime, duration) {
      update((s) => ({ ...s, currentTime, duration: duration || s.duration }));
    },

    setVolume(volume) {
      savedVolume.set(volume);
      savedMuted.set(false);
      update((s) => ({ ...s, volume, muted: false }));
    },

    toggleMute() {
      update((s) => {
        const muted = !s.muted;
        savedMuted.set(muted);
        return { ...s, muted };
      });
    },

    toggleShuffle() {
      update((s) => {
        const shuffle = !s.shuffle;
        savedShuffle.set(shuffle);
        if (!s.queue.length) return { ...s, shuffle };
        const cur = s.queue[s.index];
        if (shuffle) {
          const _orig = s.queue;
          const queue = [cur, ...shuffled(s.queue.filter((_, i) => i !== s.index))];
          return { ...s, shuffle, queue, index: 0, _orig };
        }
        const base = s._orig || s.queue;
        // Find the playing track by IDENTITY first — an id lookup could point
        // at another copy when the queue holds the same track twice.
        let index = base.indexOf(cur);
        if (index < 0) index = base.findIndex((t) => t.deezer_id === cur?.deezer_id);
        index = Math.max(0, index);
        return { ...s, shuffle, queue: base, index, _orig: null };
      });
    },

    cycleRepeat() {
      update((s) => {
        const order = { off: "all", all: "one", one: "off" };
        const repeat = order[s.repeat] || "off";
        savedRepeat.set(repeat);
        return { ...s, repeat };
      });
    },

    flushSession,
  };

  return player;
}

export const player = createPlayer();

// Flush the session at every "last reliable moment" of the page lifecycle:
// backgrounding (Android may kill the tab without any further event), the
// page-freeze that precedes it, and an outright close/navigation. This is
// what makes the position/queue survive the OS reclaiming a paused player.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    logInfo("page", "visibilitychange -> " + document.visibilityState, null, { important: true });
    if (document.visibilityState === "hidden") player.flushSession();
  });
  window.addEventListener("hashchange", () => {
    logInfo("nav", location.hash || "#/");
  });
  logInfo("nav", "start at " + (location.hash || "#/"));
  window.addEventListener("pagehide", () => {
    logInfo("page", "pagehide", null, { important: true });
    player.flushSession();
    flushLog();
  });
  // Page Lifecycle API (Chrome): fired right before a hidden tab is frozen.
  document.addEventListener("freeze", () => {
    logInfo("page", "freeze", null, { important: true });
    player.flushSession();
    flushLog();
  });
}

export const current = derived(player, ($p) =>
  $p.index >= 0 && $p.index < $p.queue.length ? $p.queue[$p.index] : null
);

// Lightweight stores that only change on track/play-state changes — NOT on every
// timeupdate. Track rows subscribe to these instead of the whole player store,
// so long lists (e.g. thousands of favorites) don't re-render 4×/second.
export const currentId = derived(current, ($c) => ($c ? $c.deezer_id : null));
export const playing = derived(player, ($p) => $p.playing);

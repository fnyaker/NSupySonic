import { writable, derived, get } from "svelte/store";

// -- auth -------------------------------------------------------------------

export const user = writable(null);
export const authChecked = writable(false);

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

// Web-player streaming quality (FLAC | MP3_320 | MP3_128).
export const quality = persisted("player.quality", "FLAC");

// -- toasts -----------------------------------------------------------------

function createToasts() {
  const { subscribe, update } = writable([]);
  let id = 0;
  return {
    subscribe,
    push(message, kind = "info", ttl = 2600) {
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
const savedAutoplay = persisted("player.autoplay", true);

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createPlayer() {
  const { subscribe, update, set } = writable({
    queue: [],
    index: -1,
    playing: false,
    currentTime: 0,
    duration: 0,
    volume: get(savedVolume),
    muted: get(savedMuted),
    shuffle: get(savedShuffle),
    repeat: get(savedRepeat),
    autoplay: get(savedAutoplay),
    context: null,
    _orig: null, // unshuffled order, when shuffle is on
  });

  function clean(tracks) {
    return (tracks || []).filter((t) => t && t.deezer_id);
  }

  const player = {
    subscribe,
    set,
    update,

    playQueue(tracks, start = 0, context = null) {
      let queue = clean(tracks);
      if (!queue.length) return;
      let index = Math.min(Math.max(start, 0), queue.length - 1);
      let _orig = null;
      update((s) => {
        if (s.shuffle) {
          const cur = queue[index];
          _orig = queue;
          queue = [cur, ...shuffled(queue.filter((_, i) => i !== index))];
          index = 0;
        }
        return { ...s, queue, index, playing: true, context, _orig };
      });
    },

    playTrack(track, context = null) {
      this.playQueue([track], 0, context);
    },

    shufflePlay(tracks, context = null) {
      const q = clean(tracks);
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
    extend(tracks) {
      const extra = clean(tracks);
      if (!extra.length) return;
      update((s) => {
        const have = new Set(s.queue.map((t) => t.deezer_id));
        const add = extra.filter((t) => !have.has(t.deezer_id));
        if (!add.length) return s;
        return {
          ...s,
          queue: [...s.queue, ...add],
          _orig: s._orig ? [...s._orig, ...add] : null,
        };
      });
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
        let index = s.index;
        if (i < s.index) index--;
        else if (i === s.index) index = Math.min(index, queue.length - 1);
        return { ...s, queue, index };
      });
    },

    next() {
      update((s) => {
        if (s.index < s.queue.length - 1) return { ...s, index: s.index + 1, playing: true };
        if (s.repeat === "all" && s.queue.length) return { ...s, index: 0, playing: true };
        return { ...s, playing: false };
      });
    },

    prev() {
      update((s) => {
        // restart current track if we're past 3s, else go back
        if (s.currentTime > 3) return { ...s, currentTime: 0 };
        if (s.index > 0) return { ...s, index: s.index - 1, playing: true };
        return { ...s, currentTime: 0 };
      });
    },

    jump(i) {
      update((s) =>
        i >= 0 && i < s.queue.length ? { ...s, index: i, playing: true } : s
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
        const index = Math.max(
          0,
          base.findIndex((t) => t.deezer_id === cur?.deezer_id)
        );
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

    toggleAutoplay() {
      update((s) => {
        const autoplay = !s.autoplay;
        savedAutoplay.set(autoplay);
        toasts.push(autoplay ? "Lecture auto activée" : "Lecture auto désactivée");
        return { ...s, autoplay };
      });
    },
  };

  return player;
}

export const player = createPlayer();

export const current = derived(player, ($p) =>
  $p.index >= 0 && $p.index < $p.queue.length ? $p.queue[$p.index] : null
);

// Lightweight stores that only change on track/play-state changes — NOT on every
// timeupdate. Track rows subscribe to these instead of the whole player store,
// so long lists (e.g. thousands of favorites) don't re-render 4×/second.
export const currentId = derived(current, ($c) => ($c ? $c.deezer_id : null));
export const playing = derived(player, ($p) => $p.playing);

export const upNext = derived(player, ($p) =>
  $p.index >= 0 ? $p.queue.slice($p.index + 1) : []
);

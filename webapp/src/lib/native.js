// Bridge to the native Android shell (android/). When the SPA runs inside the
// NSupySonic app, the WebView injects a `window.NSNative` object before the
// page loads. We then mirror the player state to the native side — which owns
// the REAL MediaSession, the foreground service and the media notification
// (that's what keeps Android from killing playback in the background) — and
// accept transport commands back from the lockscreen/notification/Bluetooth.
//
// Everything here is fail-soft and a no-op in a regular browser: audio stays
// 100% in the WebView (all the cache/offline/recovery logic in Player.svelte
// keeps working unchanged); the native layer is only a remote control + a
// process keep-alive.

import { get } from "svelte/store";
import { player, seekTo, offlineCovers } from "./stores.js";
import { resolveCover } from "./format.js";

export const isNativeApp =
  typeof window !== "undefined" && typeof window.NSNative !== "undefined";

export function initNativeBridge() {
  if (!isNativeApp) return;
  const native = window.NSNative;

  // Commands from the native MediaSession (notification / lockscreen / BT).
  window.__nsNativeCmd = (cmd, value) => {
    try {
      switch (cmd) {
        case "play":
          player.play();
          break;
        case "pause":
          player.pause();
          break;
        case "toggle":
          player.toggle();
          break;
        case "next":
          player.next();
          break;
        case "prev":
          player.prev();
          break;
        case "seek": {
          // Routed through the seekTo store so Player.svelte's performSeek
          // handles non-seekable live streams properly.
          const t = Number(value);
          if (Number.isFinite(t) && t >= 0) seekTo.set(t);
          break;
        }
      }
    } catch {
      /* a broken remote command must never take the player down */
    }
  };

  // State out. Structural changes (track / play-pause / duration) publish
  // immediately; pure position progress is throttled to ~1/s — the native
  // PlaybackState carries position+speed, so the lockscreen bar interpolates
  // between ticks anyway.
  let lastKey = "";
  let lastTick = 0;
  player.subscribe((s) => {
    const t = s.index >= 0 && s.index < s.queue.length ? s.queue[s.index] : null;
    const key = `${t?.deezer_id ?? ""}|${s.playing}|${Math.round(s.duration)}`;
    const now = Date.now();
    if (key === lastKey && now - lastTick < 1000) return;
    lastKey = key;
    lastTick = now;

    // Cover: the offline map can hold a blob: URL, meaningless outside the
    // WebView — fall back to the plain URL the native side can fetch itself,
    // made absolute since it may be a same-origin /api path.
    let cover = t ? resolveCover(get(offlineCovers), t.album?.cover) : null;
    if (cover && cover.startsWith("blob:")) cover = t.album?.cover || null;
    if (cover && !/^https?:/i.test(cover)) {
      try {
        cover = new URL(cover, window.location.href).href;
      } catch {
        cover = null;
      }
    }

    try {
      native.publish(
        JSON.stringify({
          active: !!t,
          playing: !!s.playing,
          title: t?.title || "",
          artist: t?.artist?.name || "",
          album: t?.album?.title || "",
          cover: cover || "",
          position: s.currentTime || 0,
          duration: s.duration || 0,
          hasPrev: s.index > 0 || s.currentTime > 3,
          hasNext: s.index >= 0 && (s.index < s.queue.length - 1 || s.repeat === "all"),
        })
      );
    } catch {
      /* bridge hiccup — next tick retries */
    }
  });
}

// Injected by the NSupySonic Android app at document start (MainActivity).
//
// Replaces navigator.mediaSession with a capturing shim: the web player
// already feeds mediaSession everything a media notification needs (metadata,
// playbackState, setPositionState on every timeupdate, and action handlers
// for play/pause/nexttrack/previoustrack/seekto). Instead of routing that to
// Chromium — which shows nothing in a WebView — we forward it to the native
// side (window.NSNative -> PlayerService), which owns the real MediaSession,
// the foreground service and the media notification. Transport commands come
// back through window.__nsNativeCmd and invoke the captured page handlers.
//
// This works with ANY deployed version of the SPA (no webapp change or
// server rebuild needed) and is a no-op without the NSNative bridge.
(function () {
  "use strict";
  if (window.__nsShim) return;
  window.__nsShim = true;

  var handlers = {};
  var meta = { raw: null, title: "", artist: "", album: "", cover: "" };
  var pos = { position: 0, duration: 0, rate: 1, at: Date.now() };
  var playbackState = "none";
  var started = false; // first real signal from the page seen
  var lastSent = 0;
  var timer = null;

  function artworkUrl(m) {
    try {
      var art = (m && m.artwork) || [];
      for (var i = 0; i < art.length; i++) {
        var src = art[i] && art[i].src;
        // blob: URLs are meaningless outside the WebView — skip them, the
        // native side fetches the cover over HTTP itself.
        if (src && src.indexOf("blob:") !== 0)
          return new URL(src, window.location.href).href;
      }
    } catch (e) {}
    return "";
  }

  function publish(force) {
    if (!window.NSNative || !started) return;
    var now = Date.now();
    if (!force && now - lastSent < 1000) {
      // Coalesce the position ticks; one deferred send keeps things fresh.
      if (!timer)
        timer = setTimeout(function () {
          timer = null;
          publish(true);
        }, 1000);
      return;
    }
    lastSent = now;
    var playing = playbackState === "playing";
    // Interpolate from the last setPositionState snapshot — the page only sends
    // one on discontinuities (load/seek/play/pause), per the MediaSession spec.
    var p = pos.position + (playing ? ((now - pos.at) / 1000) * (pos.rate || 1) : 0);
    if (pos.duration > 0) p = Math.min(p, pos.duration);
    try {
      window.NSNative.publish(
        JSON.stringify({
          active: !!(meta.title || pos.duration > 0 || playing),
          playing: playing,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          cover: meta.cover,
          position: Math.max(0, p),
          duration: pos.duration,
        })
      );
    } catch (e) {}
  }

  var shim = {
    setActionHandler: function (name, fn) {
      handlers[name] = fn;
    },
    setPositionState: function (s) {
      s = s || {};
      pos = {
        position: s.position || 0,
        duration: s.duration || 0,
        rate: s.playbackRate || 1,
        at: Date.now(),
      };
      started = true;
      publish(false);
    },
  };
  Object.defineProperty(shim, "metadata", {
    get: function () {
      return meta.raw;
    },
    set: function (m) {
      var cover = artworkUrl(m);
      // The player upgrades artwork to a blob: copy for the same track — keep
      // the previous fetchable URL in that case instead of dropping the art.
      if (!cover && m && m.title === meta.title) cover = meta.cover;
      meta = {
        raw: m,
        title: (m && m.title) || "",
        artist: (m && m.artist) || "",
        album: (m && m.album) || "",
        cover: cover,
      };
      started = true;
      publish(true);
    },
  });
  Object.defineProperty(shim, "playbackState", {
    get: function () {
      return playbackState;
    },
    set: function (v) {
      // Re-assigning the same state is a no-op: pages tend to mirror it on
      // every progress tick, and force-publishing each mirror flooded the
      // native bridge (JNI + MediaSession update several times per second).
      if (v === playbackState) return;
      // Position snapshots only arrive on discontinuities, so fold the
      // interpolation into the snapshot at every play<->pause flip: freezes
      // the playhead at the right spot on pause, and prevents the paused
      // wall-time from being counted as playback on resume.
      var now = Date.now();
      var p =
        pos.position +
        (playbackState === "playing" ? ((now - pos.at) / 1000) * (pos.rate || 1) : 0);
      if (pos.duration > 0) p = Math.min(p, pos.duration);
      pos.position = Math.max(0, p);
      pos.at = now;
      playbackState = v;
      if (v === "playing" || v === "paused") started = true;
      publish(true);
    },
  });

  try {
    Object.defineProperty(Navigator.prototype, "mediaSession", {
      get: function () {
        return shim;
      },
      configurable: true,
    });
  } catch (e) {
    try {
      Object.defineProperty(navigator, "mediaSession", {
        value: shim,
        configurable: true,
      });
    } catch (e2) {}
  }
  // Some WebViews lack MediaMetadata; the page does `new MediaMetadata({...})`.
  if (typeof window.MediaMetadata === "undefined") {
    window.MediaMetadata = function (init) {
      init = init || {};
      this.title = init.title || "";
      this.artist = init.artist || "";
      this.album = init.album || "";
      this.artwork = init.artwork || [];
    };
  }

  // Transport commands from the native MediaSession (notification, lockscreen,
  // Bluetooth) — routed to the handlers the page registered.
  window.__nsNativeCmd = function (cmd, value) {
    try {
      var map = {
        play: "play",
        pause: "pause",
        next: "nexttrack",
        prev: "previoustrack",
        seek: "seekto",
      };
      var h = handlers[map[cmd] || cmd];
      if (!h) return;
      if (cmd === "seek") h({ seekTime: Number(value) });
      else h({});
    } catch (e) {}
  };
})();

<script>
  // Share sheet: share the playing file whole, or cut an excerpt on a zoomable
  // waveform timeline. The waveform peaks come pre-computed from the server
  // (/api/share/waveform); the cut itself is done server-side by ffmpeg, so
  // what leaves the device is a small, ready-to-send audio file. Sharing uses
  // the Web Share API (with files) when available, else a plain download.
  import { onDestroy, tick } from "svelte";
  import { get } from "svelte/store";
  import {
    shareSheet,
    closeShare,
    player,
    current,
    toasts,
    normalization,
  } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { wirePreview, releasePreview, setPreviewGain } from "../lib/visualizer.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import { episodeMarkers, loadEpisodeMarkers } from "../lib/markers.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";

  // The server refuses clips longer than this (keep in sync with share.py).
  const CLIP_MAX = 600;
  const MIN_CLIP = 1; // seconds — a selection can't collapse to nothing
  const MIN_WINDOW = 3; // seconds visible at maximum zoom

  let track = null;
  let id = null;
  let peaks = null;
  let duration = 0;
  let loadingWave = false;
  let waveError = false;

  let mode = "clip"; // "full" | "clip" — the waveform is the star, open on it
  let selStart = 0;
  let selEnd = 30;
  let zoom = 1;
  let viewStart = 0; // seconds at the left edge
  let clipFmt = "mp3";
  let fullFmt = "orig";
  let busy = false;

  let canvas = null;
  let overviewCanvas = null;
  let wrapEl = null;

  // -- open / close -----------------------------------------------------------

  $: open = !!$shareSheet;
  $: if ($shareSheet && $shareSheet.track.deezer_id !== id) init($shareSheet.track);
  $: if (!$shareSheet && id) teardown();

  let initSeq = 0;
  async function init(t) {
    const mine = ++initSeq;
    track = t;
    id = t.deezer_id;
    peaks = null;
    waveError = false;
    loadingWave = true;
    duration = t.duration || 0;
    zoom = 1;
    viewStart = 0;
    mode = "clip";
    // Reset the format choice so a hidden option (e.g. MP3 for a podcast) can't
    // linger from a previously-shared track with no radio button selected.
    clipFmt = "mp3";
    fullFmt = "orig";
    busy = false;
    stopPreview();
    // Sharing another track while the sheet is already open: the preview
    // element still holds the previous track's source — drop it (and detach it
    // from the audio graph, since its source node can't be recreated).
    if (preview) {
      releasePreview();
      try {
        preview.removeAttribute("src");
        preview.load();
      } catch {
        /* ignore */
      }
      preview = null;
    }
    previewTime = 0;
    // Seed the preview's normalization from this track's ReplayGain (backfilled
    // if unknown) so the pre-listen matches the pipeline's per-track loudness.
    setPreviewGain(typeof t.gain === "number" ? t.gain : null);
    ensurePreviewGain(t);
    defaultSelection();
    if (t.podcast) loadEpisodeMarkers(id);
    try {
      const r = await api.waveform(id);
      if (mine !== initSeq) return;
      peaks = r.peaks || null;
      if (r.duration) duration = r.duration;
    } catch {
      if (mine !== initSeq) return;
      waveError = true;
    }
    loadingWave = false;
    defaultSelection();
    await tick();
    requestDraw();
  }

  function teardown() {
    initSeq++;
    stopPreview();
    if (preview) {
      releasePreview();
      try {
        preview.removeAttribute("src");
        preview.load();
      } catch {
        /* ignore */
      }
      preview = null;
    }
    track = null;
    id = null;
    peaks = null;
  }

  onDestroy(teardown);

  // Default selection: 30 s around the playhead when sharing the track that's
  // playing (the most likely "share this bit"), else the first 30 s.
  function defaultSelection() {
    const cur = get(current);
    const at = cur && cur.deezer_id === id ? get(player).currentTime : 0;
    const len = Math.min(30, duration || 30);
    selStart = Math.max(0, Math.min(at - len / 2, (duration || len) - len));
    selEnd = selStart + len;
    if (duration) selEnd = Math.min(selEnd, duration);
  }

  function close() {
    closeShare();
  }
  function onKey(e) {
    if (open && e.key === "Escape") close();
  }

  // -- preview ----------------------------------------------------------------
  // A dedicated element (the archived file honours range requests, so seeking
  // is instant) — the main player is paused so the two never overlap.

  let preview = null;
  let previewPlaying = false;
  let previewTime = 0;
  let previewStopAt = null;

  function ensurePreview() {
    if (preview) return preview;
    preview = new Audio();
    preview.preload = "auto";
    // Same-origin stream (/api/stream), so the element isn't CORS-tainted and
    // can be routed through the shared Web Audio graph — the pre-listen then gets
    // the exact standard pipeline (per-track normalization, EQ, bass, safety
    // limiter), while volume/mute stay on the element itself, like the player.
    preview.src = api.streamUrl(id);
    preview.volume = get(player).muted ? 0 : get(player).volume;
    preview.addEventListener("timeupdate", onPreviewTime);
    preview.addEventListener("ended", stopPreview);
    preview.addEventListener("pause", () => {
      previewPlaying = false;
      requestDraw();
    });
    wirePreview(preview);
    return preview;
  }

  // Follow the master volume / mute live, exactly as the player does on its own
  // element — the preview is part of the same pipeline, so it obeys the same
  // output level.
  $: if (preview) preview.volume = $player.muted ? 0 : $player.volume;

  // Backfill the previewed track's ReplayGain when unknown, so normalization
  // works on tracks whose metadata predates the gain field. Only when
  // normalization is on; dedup per session; caches on the track object.
  const gainTried = new Set();
  async function ensurePreviewGain(t) {
    if (!t || get(normalization) === "off" || typeof t.gain === "number") return;
    const gid = String(t.deezer_id || "");
    if (!/^\d+$/.test(gid) || gainTried.has(gid)) return;
    gainTried.add(gid);
    try {
      const r = await api.trackGain(gid);
      if (r && typeof r.gain === "number") {
        t.gain = r.gain; // cache on the track object
        // Apply only if this is still the track the sheet is showing. Ramp
        // (snap=false) — a preview may already be audible when this lands.
        if (t.deezer_id === id) setPreviewGain(r.gain, false);
      }
    } catch {
      /* leave the preview un-normalized */
    }
  }
  function onPreviewTime() {
    if (!preview) return;
    previewTime = preview.currentTime;
    if (previewStopAt != null && previewTime >= previewStopAt) stopPreview();
    requestDraw();
  }
  function seekPreview(t) {
    const p = ensurePreview();
    previewTime = t;
    try {
      p.currentTime = t;
    } catch {
      /* metadata not there yet — the pending play seeks again */
    }
    requestDraw();
  }
  function togglePreview() {
    const p = ensurePreview();
    if (previewPlaying) {
      p.pause();
      return;
    }
    player.pause(); // never two audio streams at once
    previewStopAt = mode === "clip" ? selEnd : null;
    // Restart from the top of the selection when outside it.
    if (mode === "clip" && (previewTime < selStart - 0.25 || previewTime >= selEnd)) {
      seekPreview(selStart);
    }
    p.play()
      .then(() => {
        previewPlaying = true;
        rafLoop();
      })
      .catch(() => {});
  }
  function stopPreview() {
    previewStopAt = null;
    previewPlaying = false;
    if (preview) preview.pause();
    requestDraw();
  }

  let rafId = null;
  function rafLoop() {
    cancelAnimationFrame(rafId);
    const step = () => {
      if (!previewPlaying || !preview) return;
      previewTime = preview.currentTime;
      draw();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }
  onDestroy(() => cancelAnimationFrame(rafId));

  // -- waveform geometry ------------------------------------------------------

  $: maxZoom = Math.max(1, (duration || 60) / MIN_WINDOW);
  $: visSpan = (duration || 1) / zoom;

  function clampView() {
    const dur = duration || 1;
    viewStart = Math.min(Math.max(0, viewStart), Math.max(0, dur - visSpan));
  }
  function t2x(t, W) {
    return ((t - viewStart) / visSpan) * W;
  }
  function x2t(x, W) {
    return viewStart + (x / W) * visSpan;
  }

  function setZoom(z, anchorT = null, anchorX = null, W = null) {
    const dur = duration || 1;
    z = Math.min(Math.max(1, z), maxZoom);
    if (anchorT != null && anchorX != null && W) {
      // Keep the time under the cursor pinned while the scale changes.
      const newSpan = dur / z;
      viewStart = anchorT - (anchorX / W) * newSpan;
    } else {
      const center = viewStart + visSpan / 2;
      viewStart = center - dur / z / 2;
    }
    zoom = z;
    clampView();
    requestDraw();
  }
  function zoomIn() {
    setZoom(zoom * 1.8);
  }
  function zoomOut() {
    setZoom(zoom / 1.8);
  }
  function zoomToSelection() {
    const len = Math.max(selEnd - selStart, MIN_WINDOW);
    const z = Math.min(maxZoom, (duration || 1) / (len * 1.4));
    zoom = Math.max(1, z);
    viewStart = selStart - ((duration || 1) / zoom - (selEnd - selStart)) / 2;
    clampView();
    requestDraw();
  }

  // Peak amplitude (0..1) at a time, interpolating between server buckets so
  // deep zoom stays smooth instead of blocky.
  function peakAt(t) {
    if (!peaks || !peaks.length || !duration) return 0;
    const f = (t / duration) * (peaks.length - 1);
    const i = Math.floor(f);
    if (i < 0) return peaks[0];
    if (i >= peaks.length - 1) return peaks[peaks.length - 1];
    const frac = f - i;
    return peaks[i] * (1 - frac) + peaks[i + 1] * frac;
  }
  // Max peak over a time range (a bar's span) so zoomed-out bars keep the true
  // envelope instead of aliasing.
  function peakRange(t0, t1) {
    if (!peaks || !peaks.length || !duration) return 0;
    const n = peaks.length;
    let i0 = Math.max(0, Math.floor((t0 / duration) * n));
    let i1 = Math.min(n - 1, Math.ceil((t1 / duration) * n));
    if (i1 - i0 <= 1) return peakAt((t0 + t1) / 2);
    let m = 0;
    for (let i = i0; i <= i1; i++) if (peaks[i] > m) m = peaks[i];
    return m;
  }

  // -- drawing ----------------------------------------------------------------

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return v ? v.trim() : fallback;
    } catch {
      return fallback;
    }
  }

  // roundRect with a plain-rect fallback for older engines.
  function rrect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  function niceStep(minSec) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (const s of steps) if (s >= minSec) return s;
    return 7200;
  }

  function draw() {
    if (!canvas || !open) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const accent = cssVar("--accent", "#a855f7");
    const accent2 = cssVar("--accent-2", "#ec4899");
    const rulerH = 18;
    const waveH = H - rulerH;
    const mid = waveH / 2;

    const isCur = get(current)?.deezer_id === id;
    const playT = previewPlaying || previewTime > 0 ? previewTime : isCur ? get(player).currentTime : null;

    // bars
    const barW = 2;
    const gap = 1;
    const inClip = mode === "clip";
    for (let x = 0; x < W; x += barW + gap) {
      const t0 = x2t(x, W);
      const t1 = x2t(x + barW + gap, W);
      if (t1 < 0 || t0 > duration) continue;
      const p = peaks ? peakRange(t0, t1) : 0.18 + 0.1 * Math.abs(Math.sin(x * 0.3));
      const h = Math.max(2, p * (waveH * 0.86));
      const tc = (t0 + t1) / 2;
      const selected = !inClip || (tc >= selStart && tc <= selEnd);
      const played = playT != null && tc <= playT;
      if (selected) {
        const g = ctx.createLinearGradient(0, mid - h / 2, 0, mid + h / 2);
        g.addColorStop(0, played ? accent2 : accent);
        g.addColorStop(1, played ? accent : accent2);
        ctx.fillStyle = g;
        ctx.globalAlpha = played ? 1 : 0.92;
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.globalAlpha = 0.16;
      }
      rrect(ctx, x, mid - h / 2, barW, h, 1);
      ctx.globalAlpha = 1;
    }

    // markers (podcasts): small bookmark ticks along the top
    if (track?.podcast) {
      const marks = get(episodeMarkers)[id] || [];
      ctx.fillStyle = accent2;
      for (const m of marks) {
        const x = t2x(m.position, W);
        if (x < 0 || x > W) continue;
        ctx.beginPath();
        ctx.moveTo(x - 4, 0);
        ctx.lineTo(x + 4, 0);
        ctx.lineTo(x + 4, 9);
        ctx.lineTo(x, 6);
        ctx.lineTo(x - 4, 9);
        ctx.closePath();
        ctx.fill();
      }
    }

    // selection bounds + handles
    if (inClip) {
      const xs = t2x(selStart, W);
      const xe = t2x(selEnd, W);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(Math.max(0, xs), 0, Math.min(W, xe) - Math.max(0, xs), waveH);
      for (const [x, edge] of [
        [xs, "l"],
        [xe, "r"],
      ]) {
        if (x < -12 || x > W + 12) continue;
        ctx.fillStyle = "#fff";
        ctx.fillRect(x - 1, 0, 2, waveH);
        // grip
        rrect(ctx, edge === "l" ? x - 9 : x - 1, mid - 14, 10, 28, 5);
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = 1;
        for (const dx of [3.5, 6.5]) {
          const gx = (edge === "l" ? x - 9 : x - 1) + dx;
          ctx.beginPath();
          ctx.moveTo(gx, mid - 7);
          ctx.lineTo(gx, mid + 7);
          ctx.stroke();
        }
      }
    }

    // playhead
    if (playT != null) {
      const x = t2x(playT, W);
      if (x >= 0 && x <= W) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(x - 0.75, 0, 1.5, waveH);
      }
    }

    // ruler
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "top";
    const step = niceStep((70 / W) * visSpan);
    const first = Math.ceil(viewStart / step) * step;
    for (let t = first; t <= viewStart + visSpan && t <= duration + 0.01; t += step) {
      const x = t2x(t, W);
      ctx.fillRect(x, waveH + 2, 1, 4);
      ctx.fillText(fmtDuration(Math.round(t)), x + 3, waveH + 4);
    }

    drawOverview();
  }

  function drawOverview() {
    if (!overviewCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = overviewCanvas.clientWidth;
    const H = overviewCanvas.clientHeight;
    if (!W || !H) return;
    if (overviewCanvas.width !== W * dpr || overviewCanvas.height !== H * dpr) {
      overviewCanvas.width = W * dpr;
      overviewCanvas.height = H * dpr;
    }
    const ctx = overviewCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const accent = cssVar("--accent", "#a855f7");
    const mid = H / 2;
    const n = peaks?.length || 0;
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    for (let x = 0; x < W; x += 2) {
      let p = 0.2;
      if (n) {
        const i0 = Math.floor((x / W) * n);
        const i1 = Math.min(n - 1, Math.floor(((x + 2) / W) * n));
        for (let i = i0; i <= i1; i++) if (peaks[i] > p) p = Math.max(p, peaks[i]);
        p = Math.max(0.06, p);
      }
      const h = Math.max(1.5, p * (H * 0.8));
      ctx.fillRect(x, mid - h / 2, 1.4, h);
    }
    if (mode === "clip" && duration) {
      const xs = (selStart / duration) * W;
      const xe = (selEnd / duration) * W;
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(xs, 0, xe - xs, H);
      ctx.globalAlpha = 1;
    }
    // visible window
    if (duration) {
      const xs = (viewStart / duration) * W;
      const xe = ((viewStart + visSpan) / duration) * W;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(xs + 0.5, 1, Math.max(4, xe - xs) - 1, H - 2);
    }
  }

  // Redraw on any relevant state change.
  $: if (open && (mode || selStart || selEnd || zoom || viewStart || peaks || $episodeMarkers)) requestDraw();
  // Follow the main player's playhead while it plays the shared track.
  $: if (open && $player.currentTime != null && !previewPlaying) requestDraw();

  // -- pointer interaction ----------------------------------------------------

  const pointers = new Map(); // pointerId -> {x, y}
  let gesture = null; // {kind: "start"|"end"|"move"|"scrub"|"pan", ...}
  let pinchBase = null;

  function canvasX(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, W: r.width };
  }

  function onPointerDown(e) {
    if (!canvas || !duration) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // pinch zoom takes over
      const [a, b] = [...pointers.values()];
      pinchBase = { dist: Math.abs(a.x - b.x) || 1, zoom, mid: (a.x + b.x) / 2 };
      gesture = { kind: "pinch" };
      return;
    }
    const { x, W } = canvasX(e);
    const t = x2t(x, W);
    if (mode === "clip") {
      const xs = t2x(selStart, W);
      const xe = t2x(selEnd, W);
      if (Math.abs(x - xs) < 12) {
        gesture = { kind: "start" };
        return;
      }
      if (Math.abs(x - xe) < 12) {
        gesture = { kind: "end" };
        return;
      }
      if (x > xs && x < xe) {
        gesture = { kind: "move", grabT: t, s0: selStart, e0: selEnd, moved: false };
        return;
      }
      gesture = { kind: "create", anchorT: t, moved: false };
      return;
    }
    gesture = { kind: "scrub", moved: false, panX: x, view0: viewStart };
  }

  function onPointerMove(e) {
    if (!gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture.kind === "pinch" && pointers.size === 2 && pinchBase) {
      const [a, b] = [...pointers.values()];
      const dist = Math.abs(a.x - b.x) || 1;
      const r = canvas.getBoundingClientRect();
      const midX = (a.x + b.x) / 2 - r.left;
      setZoom(pinchBase.zoom * (dist / pinchBase.dist), x2t(midX, r.width), midX, r.width);
      return;
    }
    const { x, W } = canvasX(e);
    const t = Math.min(Math.max(0, x2t(x, W)), duration);
    if (gesture.kind === "start") {
      selStart = Math.min(t, selEnd - MIN_CLIP);
      selStart = Math.max(0, selStart);
      capClip("start");
    } else if (gesture.kind === "end") {
      selEnd = Math.max(t, selStart + MIN_CLIP);
      selEnd = Math.min(duration, selEnd);
      capClip("end");
    } else if (gesture.kind === "move") {
      gesture.moved = true;
      const d = t - gesture.grabT;
      const len = gesture.e0 - gesture.s0;
      selStart = Math.min(Math.max(0, gesture.s0 + d), duration - len);
      selEnd = selStart + len;
    } else if (gesture.kind === "create") {
      if (!gesture.moved && Math.abs(t - gesture.anchorT) * (W / visSpan) < 5) return;
      gesture.moved = true;
      selStart = Math.max(0, Math.min(gesture.anchorT, t));
      selEnd = Math.min(duration, Math.max(gesture.anchorT, t));
      capClip(t >= gesture.anchorT ? "end" : "start");
    } else if (gesture.kind === "scrub") {
      // In full mode a horizontal drag pans when zoomed, else it scrubs.
      if (zoom > 1) {
        gesture.moved = true;
        viewStart = gesture.view0 - (x - gesture.panX) * (visSpan / W);
        clampView();
      }
    }
    requestDraw();
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchBase = null;
    if (!gesture) return;
    const g = gesture;
    if (pointers.size === 0) gesture = null;
    const { x, W } = canvasX(e);
    const t = Math.min(Math.max(0, x2t(x, W)), duration);
    // A tap (no drag) positions the preview playhead.
    if ((g.kind === "scrub" || g.kind === "create" || g.kind === "move") && !g.moved) {
      seekPreview(t);
      if (previewPlaying && mode === "clip") previewStopAt = selEnd;
    }
    requestDraw();
  }

  // Selections stay within the server's clip cap, anchored on the edge that
  // is NOT being dragged.
  function capClip(edge) {
    if (selEnd - selStart <= CLIP_MAX) return;
    if (edge === "end") selEnd = selStart + CLIP_MAX;
    else selStart = selEnd - CLIP_MAX;
  }

  function onWheel(e) {
    if (!duration) return;
    e.preventDefault();
    const { x, W } = canvasX(e);
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      viewStart += e.deltaX * (visSpan / W) * 1.2;
      clampView();
    } else {
      const factor = Math.exp(-e.deltaY * 0.0018);
      setZoom(zoom * factor, x2t(x, W), x, W);
    }
    requestDraw();
  }

  // overview: click/drag moves the visible window
  let ovDragging = false;
  function ovTo(e) {
    const r = overviewCanvas.getBoundingClientRect();
    const frac = Math.min(Math.max(0, (e.clientX - r.left) / r.width), 1);
    viewStart = frac * duration - visSpan / 2;
    clampView();
    requestDraw();
  }
  function onOvDown(e) {
    if (!duration) return;
    ovDragging = true;
    overviewCanvas.setPointerCapture(e.pointerId);
    ovTo(e);
  }
  function onOvMove(e) {
    if (ovDragging) ovTo(e);
  }
  function onOvUp() {
    ovDragging = false;
  }

  // -- share / download -------------------------------------------------------

  // The Android app (MainActivity.kt) injects window.NSNative — a plain
  // android.webkit.WebView typically has no file-sharing plumbing wired up for
  // navigator.share (only text/url), so canShare({files}) there reports false
  // and silently falls back to a download with no visible share sheet at all.
  // Preferring the native bridge sidesteps that: it fetches the file itself
  // and hands it to a real Android share Intent, which always works.
  const nativeShare =
    typeof window !== "undefined" && typeof window.NSNative?.shareFile === "function"
      ? window.NSNative.shareFile.bind(window.NSNative)
      : null;

  let canShareFiles = false;
  if (!nativeShare) {
    try {
      canShareFiles =
        typeof navigator !== "undefined" &&
        !!navigator.canShare &&
        navigator.canShare({ files: [new File([""], "t.mp3", { type: "audio/mpeg" })] });
    } catch {
      canShareFiles = false;
    }
  }

  $: clipLen = Math.max(0, selEnd - selStart);
  $: shareUrl =
    mode === "clip"
      ? api.shareClipUrl(id, selStart, selEnd, clipFmt)
      : api.shareFileUrl(id, fullFmt === "orig" ? null : fullFmt);

  function fallbackName() {
    const artist = track.artist?.name || "";
    const base = (artist ? artist + " - " : "") + (track.title || "audio");
    // "orig" = whatever the archive holds (mp3 for podcasts, else flac); a
    // named format (mp3/m4a/flac) is its own extension.
    const ext =
      mode === "clip"
        ? clipFmt
        : fullFmt === "orig"
          ? track.podcast
            ? "mp3"
            : "flac"
          : fullFmt;
    return base.replace(/[\\/:*?"<>|]/g, "_") + "." + ext;
  }

  function download() {
    const a = document.createElement("a");
    a.href = shareUrl;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toasts.push(mode === "clip" ? "Préparation de l'extrait…" : "Téléchargement lancé");
  }

  async function share() {
    if (nativeShare) {
      // Fire-and-forget: the native side fetches the file itself (with the
      // session cookie) and hands it straight to Android's share Intent —
      // there's no promise to await, and it shows its own toast on failure.
      try {
        nativeShare(new URL(shareUrl, window.location.href).href);
      } catch {
        toasts.push("Échec du partage", "error");
      }
      return;
    }
    if (!canShareFiles) {
      download();
      return;
    }
    busy = true;
    try {
      const res = await fetch(shareUrl, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      // Pull the server's nice filename out of Content-Disposition when we can.
      let name = fallbackName();
      const disp = res.headers.get("Content-Disposition") || "";
      const m = /filename\*=UTF-8''([^;]+)/i.exec(disp) || /filename="([^"]+)"/i.exec(disp);
      if (m) {
        try {
          name = decodeURIComponent(m[1]);
        } catch {
          name = m[1];
        }
      }
      const file = new File([blob], name, { type: blob.type || "audio/mpeg" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: track.title });
      } else {
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (e) {
      if (e && (e.name === "AbortError" || e.name === "NotAllowedError")) {
        /* the user closed the OS share panel — not an error */
      } else {
        toasts.push("Échec du partage", "error");
      }
    } finally {
      busy = false;
    }
  }

  function setEdgeToPlayhead(edge) {
    const t = previewTime;
    if (edge === "start") {
      selStart = Math.min(Math.max(0, t), selEnd - MIN_CLIP);
      capClip("start");
    } else {
      selEnd = Math.max(Math.min(duration, t), selStart + MIN_CLIP);
      capClip("end");
    }
    requestDraw();
  }
</script>

<svelte:window on:keydown={onKey} on:resize={() => open && requestDraw()} />

{#if open && track}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="backdrop" on:click={close}>
    <div class="sheet" role="dialog" aria-label="Partager" tabindex="-1" on:click|stopPropagation>
      <header>
        <div class="who">
          <Cover src={track.album?.cover} alt={track.title} size={46} kind="track" fallbackId={track.deezer_id} />
          <div class="txt">
            <span class="t">{track.title}</span>
            <span class="a muted">{track.artist?.name}</span>
          </div>
        </div>
        <button class="ic" on:click={close} aria-label="Fermer"><Icon name="close" size={20} /></button>
      </header>

      <div class="modes" role="tablist">
        <button role="tab" aria-selected={mode === "clip"} class:on={mode === "clip"} on:click={() => (mode = "clip")}>
          <Icon name="scissors" size={15} /> Extrait
        </button>
        <button role="tab" aria-selected={mode === "full"} class:on={mode === "full"} on:click={() => (mode = "full")}>
          <Icon name="music" size={15} /> Fichier complet
        </button>
      </div>

      <div class="wave-wrap" bind:this={wrapEl}>
        {#if loadingWave}
          <div class="wave-loading">
            <span class="shimmer"></span>
            <span class="muted">Analyse de l'audio…</span>
          </div>
        {:else if waveError}
          <div class="wave-loading">
            <span class="muted">Forme d'onde indisponible — la sélection reste utilisable.</span>
          </div>
        {/if}
        <canvas
          class="wave"
          class:dim={loadingWave}
          bind:this={canvas}
          on:pointerdown={onPointerDown}
          on:pointermove={onPointerMove}
          on:pointerup={onPointerUp}
          on:pointercancel={onPointerUp}
          on:wheel={onWheel}
          style="touch-action: none;"
        ></canvas>
        <canvas
          class="overview"
          bind:this={overviewCanvas}
          on:pointerdown={onOvDown}
          on:pointermove={onOvMove}
          on:pointerup={onOvUp}
          on:pointercancel={onOvUp}
          style="touch-action: none;"
        ></canvas>
        <div class="wave-tools">
          <button class="ic" on:click={togglePreview} aria-label="Pré-écoute" title={mode === "clip" ? "Écouter l'extrait" : "Écouter"}>
            <Icon name={previewPlaying ? "pause" : "play"} size={16} />
          </button>
          <span class="ptime muted">{fmtDuration(Math.round(previewTime))}</span>
          <span class="spacer"></span>
          <button class="ic" on:click={zoomOut} disabled={zoom <= 1.001} aria-label="Zoom arrière"><Icon name="zoomOut" size={16} /></button>
          <button class="ic" on:click={zoomIn} disabled={zoom >= maxZoom - 0.001} aria-label="Zoom avant"><Icon name="zoomIn" size={16} /></button>
          {#if mode === "clip"}
            <button class="fit" on:click={zoomToSelection}>Ajuster à la sélection</button>
          {/if}
        </div>
      </div>

      {#if mode === "clip"}
        <div class="cliprow">
          <div class="bounds">
            <button class="bound" on:click={() => setEdgeToPlayhead("start")} title="Début = position de pré-écoute">
              <span class="bl muted">Début</span>
              <span class="bv">{fmtDuration(Math.round(selStart))}</span>
            </button>
            <span class="len">
              <span class="bl muted">Durée</span>
              <span class="bv accent">{fmtDuration(Math.round(clipLen))}</span>
            </span>
            <button class="bound" on:click={() => setEdgeToPlayhead("end")} title="Fin = position de pré-écoute">
              <span class="bl muted">Fin</span>
              <span class="bv">{fmtDuration(Math.round(selEnd))}</span>
            </button>
          </div>
          <div class="fmt" role="radiogroup" aria-label="Format">
            <button role="radio" aria-checked={clipFmt === "mp3"} class:on={clipFmt === "mp3"} on:click={() => (clipFmt = "mp3")}>MP3 320</button>
            <button role="radio" aria-checked={clipFmt === "m4a"} class:on={clipFmt === "m4a"} on:click={() => (clipFmt = "m4a")}>AAC</button>
            <button role="radio" aria-checked={clipFmt === "flac"} class:on={clipFmt === "flac"} on:click={() => (clipFmt = "flac")}>FLAC</button>
          </div>
        </div>
        <p class="hint muted">
          Glissez les poignées pour choisir l'extrait — molette ou pincement pour zoomer.
        </p>
      {:else}
        <div class="cliprow">
          <span class="fullinfo muted">
            {track.podcast ? "Épisode complet" : "Titre complet"} · {fmtDuration(Math.round(duration))}
          </span>
          <div class="fmt" role="radiogroup" aria-label="Format">
            <button role="radio" aria-checked={fullFmt === "orig"} class:on={fullFmt === "orig"} on:click={() => (fullFmt = "orig")}>
              {track.podcast ? "MP3 d'origine" : "Original"}
            </button>
            {#if !track.podcast}
              <button role="radio" aria-checked={fullFmt === "mp3"} class:on={fullFmt === "mp3"} on:click={() => (fullFmt = "mp3")}>MP3 320</button>
            {/if}
            <button role="radio" aria-checked={fullFmt === "m4a"} class:on={fullFmt === "m4a"} on:click={() => (fullFmt = "m4a")}>AAC</button>
          </div>
        </div>
      {/if}

      <footer>
        <button class="ghost" on:click={download} disabled={busy}>
          <Icon name="download" size={17} /> Télécharger
        </button>
        <button class="primary" on:click={share} disabled={busy}>
          {#if busy}
            <span class="spin"></span> Préparation…
          {:else}
            <Icon name="share" size={17} /> Partager
          {/if}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 300;
    background: rgba(8, 6, 12, 0.62);
    backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
    padding: 18px;
  }
  .sheet {
    width: min(680px, 100%);
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    border-radius: 18px;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
    padding: 18px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .who .txt {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .who .t {
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .who .a {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ic {
    color: var(--text-dim);
    display: grid;
    place-items: center;
    padding: 4px;
    border-radius: 8px;
  }
  .ic:hover:not(:disabled) {
    color: var(--text);
    background: var(--bg-hover);
  }
  .ic:disabled {
    opacity: 0.35;
  }

  .modes {
    display: flex;
    gap: 6px;
    background: var(--bg-card);
    border-radius: 999px;
    padding: 4px;
    align-self: flex-start;
  }
  .modes button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 14px;
    border-radius: 999px;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .modes button.on {
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    color: #fff;
  }

  .wave-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
    border-radius: 14px;
    padding: 12px;
  }
  .wave {
    width: 100%;
    height: 150px;
    display: block;
    cursor: crosshair;
    border-radius: 8px;
  }
  .wave.dim {
    opacity: 0.25;
  }
  .overview {
    width: 100%;
    height: 30px;
    display: block;
    cursor: grab;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
  }
  .wave-loading {
    position: absolute;
    inset: 12px 12px 50px;
    display: grid;
    place-items: center;
    gap: 6px;
    z-index: 1;
    font-size: 0.85rem;
  }
  .shimmer {
    width: 60%;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--bg-hover), var(--accent), var(--bg-hover));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  @keyframes shimmer {
    from {
      background-position: 200% 0;
    }
    to {
      background-position: -200% 0;
    }
  }
  .wave-tools {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .wave-tools .spacer {
    flex: 1;
  }
  .ptime {
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .fit {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 999px;
    padding: 4px 10px;
  }
  .fit:hover {
    color: var(--text);
  }

  .cliprow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
  }
  .bounds {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }
  .bound,
  .len {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    padding: 6px 12px;
    border-radius: 10px;
    background: var(--bg-card);
    border: 1px solid var(--bg-hover);
  }
  .bound:hover {
    border-color: var(--accent);
  }
  .bl {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .bv {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    font-size: 0.95rem;
    color: var(--text);
  }
  .bv.accent {
    color: var(--accent);
  }
  .fullinfo {
    font-size: 0.88rem;
  }
  .fmt {
    display: flex;
    gap: 4px;
    background: var(--bg-card);
    border-radius: 999px;
    padding: 3px;
  }
  .fmt button {
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--text-dim);
  }
  .fmt button.on {
    background: var(--bg-hover);
    color: var(--text);
  }
  .hint {
    font-size: 0.78rem;
    margin: -4px 0 0;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  footer button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 0.9rem;
  }
  .ghost {
    color: var(--text);
    border: 1px solid var(--bg-hover);
  }
  .ghost:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .primary {
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    color: #fff;
  }
  .primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  footer button:disabled {
    opacity: 0.6;
  }
  .spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* mobile: full-width bottom sheet */
  @media (max-width: 640px) {
    .backdrop {
      place-items: end center;
      padding: 0;
    }
    .sheet {
      border-radius: 18px 18px 0 0;
      border-bottom: none;
      max-height: 92dvh;
      overflow-y: auto;
      padding-bottom: max(20px, env(safe-area-inset-bottom));
    }
    .wave {
      height: 120px;
    }
    .bounds {
      width: 100%;
      justify-content: space-between;
    }
    footer {
      flex-direction: column-reverse;
    }
    footer button {
      justify-content: center;
    }
  }
</style>

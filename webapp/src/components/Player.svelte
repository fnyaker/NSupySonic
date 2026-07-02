<script>
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { push } from "svelte-spa-router";
  import {
    player,
    current,
    favorites,
    nowPlayingOpen,
    immersiveOpen,
    seekTo,
    buffered,
    pushRecent,
    quality,
    openMenu,
    toasts,
    prefetchEnabled,
  } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { online } from "../lib/net.js";
  import { isDownloaded, getObjectURL, touch } from "../lib/offline.js";
  import { isCached, getCachedAudioURL, prefetchTrack } from "../lib/playcache.js";
  import { toggleFavorite, buildTrackMenu, userPlaylists } from "../lib/actions.js";
  import { duration as fmtDuration } from "../lib/format.js";
  import { registerSource, resumeAudio } from "../lib/visualizer.js";
  import Cover from "./Cover.svelte";
  import Icon from "./Icon.svelte";
  import ImmersivePlayer from "./ImmersivePlayer.svelte";

  // Two managed audio elements so a quality change can be gapless: we preload
  // the new bitrate on the idle element at the exact current position, then
  // hand playback over with no reload pause. `audio` is whichever is playing.
  let audio = null;
  let els = [];
  let curId = null; // deezer_id currently loaded on `audio`
  let curQ = null; // quality currently loaded on `audio`
  let curSeq = -1; // player.seq the active element was (re)started for
  let switching = false;
  // When the active track is served from an on-device download, its src is a
  // blob: URL of a fixed quality — so quality switching / network recovery don't
  // apply, and the object URL must be revoked when we move on.
  let curBlobUrl = null;
  let curIsBlob = false;
  // Last position we actually saw progress at, so we can restore it if the
  // browser silently rewinds the element to 0 after a long suspend (mobile lock).
  let lastKnownTime = 0;

  function makeEl() {
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    el.addEventListener("play", onElPlay);
    el.addEventListener("pause", onElPause);
    el.addEventListener("error", onElError);
    el.addEventListener("stalled", onElStall);
    el.addEventListener("progress", onProgress);
    return el;
  }
  onMount(() => {
    els = [makeEl(), makeEl()];
    audio = els[0]; // assignment kicks the reactive load/transport blocks
    startWatchdog();
    document.addEventListener("visibilitychange", onVisibility);
  });
  onDestroy(() => {
    stopWatchdog();
    cancelPauseMirror();
    clearTimeout(prefetchTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    releaseWakeLock();
    setBlobUrl(null); // revoke any live object URL
    for (const el of els) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* ignore */
      }
    }
  });

  // --- Screen wake lock ------------------------------------------------------
  // A SCREEN wake lock keeps the display on — costly, and useless for keeping
  // background audio alive (it's auto-dropped the moment the page is hidden, and
  // the browser/OS already holds the partial wake lock that audio playback needs
  // — that one is battery-exempt). So we hold it ONLY while the full-screen
  // player is open and visible, purely so the screen doesn't dim while the user
  // is watching the now-playing view / visualizer — never just because audio is
  // playing in the background.
  let wakeLock = null;
  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch {
      wakeLock = null; // e.g. denied while not visible — retried on visibility
    }
  }
  function releaseWakeLock() {
    try {
      wakeLock?.release();
    } catch {
      /* ignore */
    }
    wakeLock = null;
  }
  function onVisibility() {
    if (document.visibilityState !== "visible") return;
    // Coming back to the foreground: re-arm the visualizer's AudioContext (the
    // OS may have suspended it while hidden) and re-take the screen lock if the
    // full-screen player is still up.
    resumeAudio();
    if (get(immersiveOpen) && get(player).playing) requestWakeLock();
  }
  // Keep the screen awake only while the full-screen player is open AND playing.
  $: if ($immersiveOpen && $player.playing) requestWakeLock();
  else releaseWakeLock();

  // --- Playback watchdog / auto-recovery -------------------------------------
  // If playback dies on a bug (network drop, decode error, a stalled live
  // transcode) we reload the source and resume at the same position. We must
  // NOT auto-resume a *clean* pause: when another app grabs audio focus (a GPS
  // voice prompt, etc.) the element fires `pause`, onElPause flips the store to
  // paused, and the watchdog then sees playing=false and stays out of the way.
  let watchdog = null;
  let lastPos = -1;
  let lastAdvance = 0;
  let recovering = false;
  let recoverAttempts = 0;
  // True while playback is interrupted purely because the network is down: we
  // hold the track + position and resume on reconnect instead of skipping.
  let netWaiting = false;

  function startWatchdog() {
    stopWatchdog();
    lastAdvance = Date.now();
    watchdog = setInterval(() => {
      if (!audio || switching || recovering) return;
      const s = get(player);
      if (!s.playing || audio.paused) return; // not trying to play / cleanly paused
      if (audio.currentTime !== lastPos) {
        lastPos = audio.currentTime;
        lastAdvance = Date.now();
        return;
      }
      // currentTime frozen while we believe we're playing → stuck on a bug.
      if (Date.now() - lastAdvance > 6000) recoverPlayback();
    }, 2000);
  }
  function stopWatchdog() {
    clearTimeout(watchdog);
    clearInterval(watchdog);
    watchdog = null;
  }

  function onElError(e) {
    if (e && e.target !== audio) return;
    if (get(player).playing) recoverPlayback();
  }
  function onElStall(e) {
    if (e && e.target !== audio) return;
    // Give buffering a moment; the watchdog handles a sustained freeze.
  }

  // Reload the current track in place and resume where it died. Capped so a
  // permanently broken stream can't spin in a reload loop.
  function recoverPlayback() {
    const cur = get(current);
    if (!cur || !audio || switching || recovering) return;
    // Network down: don't burn the retry budget or skip the track. Park it and
    // let the reconnect handler resume from the same spot. A downloaded track
    // plays from a local blob, so the network is irrelevant — recover it in
    // place (reloading the object URL) instead of parking or hitting the net.
    if (!curIsBlob && (!navigator.onLine || !get(online))) {
      netWaiting = true;
      return;
    }
    if (recoverAttempts >= 4) {
      failCurrentTrack(); // permanently broken stream — move on
      return;
    }
    recovering = true;
    recoverAttempts++;
    const pos =
      audio.currentTime > 0.5
        ? audio.currentTime
        : lastKnownTime || get(player).currentTime || 0;
    audio.src =
      curIsBlob && curBlobUrl ? curBlobUrl : api.streamUrl(cur.deezer_id, curQ);
    audio.load();
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("error", onErr);
    };
    const onMeta = () => {
      cleanup();
      try {
        if (pos > 0) audio.currentTime = pos;
      } catch {
        /* not seekable yet */
      }
      audio.play().catch(() => {});
      recovering = false;
      lastAdvance = Date.now();
    };
    // The reload itself failed (e.g. server 502): loadedmetadata never fires, so
    // release `recovering` and schedule the next attempt with backoff. Once the
    // budget is spent the next call skips the track (or parks it if offline).
    const onErr = () => {
      cleanup();
      recovering = false;
      const delay = Math.min(800 * recoverAttempts, 4000);
      setTimeout(() => {
        if (get(player).playing) recoverPlayback();
      }, delay);
    };
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("error", onErr);
  }

  // A buffer underrun makes some browsers fire a transient `pause` (immediately
  // followed by `play` once data arrives). Mirroring that blip straight into the
  // store makes the transport block react and fight the element, which can spin
  // into a rapid play/pause oscillation — and once the store reads paused the
  // watchdog bails, so a stuck stream never recovers on its own (you have to
  // restart it by hand). So we DEFER mirroring a pause: only reflect it if the
  // element is still paused a moment later (a genuine, sustained pause — audio
  // focus lost, user paused from the OS), and cancel the pending mirror the
  // instant playback resumes.
  let pauseMirrorTimer = null;
  function cancelPauseMirror() {
    if (pauseMirrorTimer) {
      clearTimeout(pauseMirrorTimer);
      pauseMirrorTimer = null;
    }
  }

  function onElPlay(e) {
    if (e.target !== audio) return;
    cancelPauseMirror(); // resumed — the pause (if any) was just a rebuffer blip
    registerSource(audio); // wires Web Audio only if a visualizer view wants it
    resumeAudio();
    // A long suspend (mobile lock) can silently rewind the element to 0. If we
    // resume play near the start but knew a later position, restore it. The
    // guard (knew > 2s, now ~0) keeps legit fresh starts at the beginning.
    if (lastKnownTime > 2 && audio.currentTime < 0.5) safeSeek(lastKnownTime);
    if (!get(player).playing) player.play();
  }
  function onElPause(e) {
    if (e.target !== audio) return;
    if (!get(player).playing) return; // already paused in the store (our own doing)
    if (audio.ended) return; // end-of-track is handled by onEnded, not here
    cancelPauseMirror();
    pauseMirrorTimer = setTimeout(() => {
      pauseMirrorTimer = null;
      // Still paused, still active, not at the end and still meant to be playing
      // → a real pause (a rebuffer would have fired `play` and cancelled this).
      if (audio && audio.paused && !audio.ended && get(player).playing) player.pause();
    }, 300);
  }

  const QUALITIES = ["FLAC", "OPUS_320", "OPUS_256", "OPUS_192", "OPUS_128", "OPUS_64"];
  const QUALITY_LABEL = {
    FLAC: "FLAC",
    OPUS_320: "Opus 320",
    OPUS_256: "Opus 256",
    OPUS_192: "Opus 192",
    OPUS_128: "Opus 128",
    OPUS_64: "Opus 64",
  };
  const QUALITY_HINT = {
    FLAC: "Sans perte",
    OPUS_320: "Haute qualité",
    OPUS_256: "Haute qualité",
    OPUS_192: "Bon compromis",
    OPUS_128: "Standard",
    OPUS_64: "Données réduites",
  };
  let qOpen = false;
  function selectQuality(q) {
    quality.set(q);
    qOpen = false;
  }

  // Play telemetry: when the track changes, report how long the previous one
  // was played (feeds Deezer recommendations; server no-ops unless enabled).
  let listenId = null;
  let listenStart = 0;
  function flushListen(nextId = null) {
    if (listenId && listenId !== nextId) {
      const listened = Math.max(0, Math.round((Date.now() - listenStart) / 1000));
      const s = get(player);
      api.reportListen({
        deezer_id: listenId,
        listened,
        next_id: nextId,
        context: s.context || null,
        shuffle: s.shuffle,
      });
    }
    listenId = nextId;
    listenStart = Date.now();
  }

  // Seek requests from other views (e.g. the immersive player).
  $: if (audio && $seekTo != null) {
    audio.currentTime = $seekTo;
    seekTo.set(null);
  }

  $: fav = $current && $favorites.has(String($current.deezer_id));

  // Load a new track onto the active element when the track changes — OR restart
  // the current one when the player navigated to it deliberately even though it
  // carries the same deezer id (a duplicate in the queue, a "restart" prev).
  $: if (audio && $current) {
    if ($current.deezer_id !== curId) loadTrack($current);
    else if ($player.seq !== curSeq) restartCurrent();
  }
  // A quality change for the SAME track is handed off gaplessly instead of
  // reloading the element in place.
  $: if (
    audio &&
    $current &&
    $current.deezer_id === curId &&
    $quality !== curQ &&
    !switching &&
    !curIsBlob // a downloaded track is a fixed-quality blob; ignore quality changes
  )
    switchQuality($quality);

  // Prefer an on-device download (instant, plays in airplane mode) over the
  // network. Returns { url, blob } — blob true means a revocable object URL.
  async function resolveSource(deezerId, q) {
    // 1) A permanent download (fixed quality, plays in airplane mode).
    if (isDownloaded(deezerId)) {
      try {
        const u = await getObjectURL(deezerId);
        if (u) return { url: u, blob: true };
      } catch {
        /* fall back to the cache / network */
      }
    }
    // 2) The playback cache (prefetched next track) — check before the network
    //    so a drop right at the track change doesn't stall playback.
    if (isCached(deezerId)) {
      try {
        const u = await getCachedAudioURL(deezerId);
        if (u) return { url: u, blob: true };
      } catch {
        /* fall back to the network */
      }
    }
    // 3) Stream from the server.
    return { url: api.streamUrl(deezerId, q), blob: false };
  }

  function setBlobUrl(url) {
    if (curBlobUrl && curBlobUrl !== url) {
      try {
        URL.revokeObjectURL(curBlobUrl);
      } catch {
        /* ignore */
      }
    }
    curBlobUrl = url;
  }

  async function loadTrack(track) {
    const firstLoad = curId === null;
    // On the very first (session-restored) load, resume the saved position.
    const resumeAt = firstLoad && $player.currentTime > 1 ? $player.currentTime : 0;
    curId = track.deezer_id;
    curQ = get(quality);
    curSeq = get(player).seq;
    lastKnownTime = resumeAt;
    recoverAttempts = 0; // fresh track, fresh recovery budget
    cancelPauseMirror(); // drop a deferred pause from the outgoing track
    buffered.set(0); // new source -> nothing loaded yet

    const src = await resolveSource(track.deezer_id, curQ);
    // A newer load may have superseded us while reading the blob from IndexedDB.
    if (curId !== track.deezer_id) {
      if (src.blob) {
        try {
          URL.revokeObjectURL(src.url);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    setBlobUrl(src.blob ? src.url : null);
    curIsBlob = src.blob;
    audio.src = src.url;
    audio.load();
    if (src.blob) touch(track.deezer_id); // bump LRU recency

    if (resumeAt > 0) seekOnceLoaded(resumeAt);
    if ($player.playing) audio.play().catch(() => {});
    // Seed duration from metadata right away so the seek bar is correct before
    // the first timeupdate (live transcodes report no duration).
    player.setProgress(resumeAt, track.duration || 0);
    flushListen(track.deezer_id);
    pushRecent(track);
    updateMediaSession(track);
  }

  // Restart the already-loaded track from the top (same deezer id, new queue
  // slot or a deliberate "restart"). Avoids a full reload of the element.
  function restartCurrent() {
    curSeq = get(player).seq;
    lastKnownTime = 0;
    try {
      audio.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
    player.setProgress(0, $current?.duration || get(player).duration || 0);
    recoverAttempts = 0;
    if (get(player).playing) audio.play().catch(() => {});
  }

  // Back online after a network drop: clear the wait, reset the retry budget and
  // resume from the same position (the element may have emptied during the
  // outage, so go through recoverPlayback to reload + reseek).
  $: if ($online && netWaiting) resumeAfterNetwork();
  function resumeAfterNetwork() {
    netWaiting = false;
    recoverAttempts = 0;
    lastAdvance = Date.now();
    if (audio && get(current) && get(player).playing) recoverPlayback();
  }

  // A track we couldn't play at all (no playable source / archiving failed /
  // repeated decode errors). Skip to the next one instead of freezing.
  function failCurrentTrack() {
    recovering = false;
    switching = false;
    const s = get(player);
    toasts.push("Titre indisponible, passage au suivant", "error");
    if (s.index < s.queue.length - 1) player.next();
    else player.pause();
  }

  // Apply a target time, immediately if the element can already seek, else once
  // its metadata is (re)loaded.
  function safeSeek(t) {
    try {
      if (audio.readyState >= 1) {
        audio.currentTime = t;
        return;
      }
    } catch {
      /* fall through to the deferred path */
    }
    seekOnceLoaded(t);
  }

  // Gapless quality switch: buffer the new bitrate on the idle element at the
  // current position, then swap playback over once it can play through. Keeps
  // the position to the element's full precision so there's no audible jump.
  function switchQuality(newQ) {
    const cur = get(current);
    const incoming = els.find((e) => e !== audio);
    if (!audio || !cur || !incoming) return;
    switching = true;
    const pos = audio.currentTime;
    const wasPlaying = !audio.paused && get(player).playing;
    incoming.volume = audio.volume;
    incoming.muted = audio.muted;
    incoming.src = api.streamUrl(cur.deezer_id, newQ);
    incoming.load();

    let done = false;
    let failTimer = null;
    const onMeta = () => {
      try {
        incoming.currentTime = pos;
      } catch {
        /* not seekable yet */
      }
    };
    const swap = () => {
      if (done) return;
      done = true;
      clearTimeout(failTimer);
      incoming.removeEventListener("loadedmetadata", onMeta);
      incoming.removeEventListener("canplay", swap);
      // Bail if the track changed underneath us while preloading.
      if (get(current)?.deezer_id !== cur.deezer_id) {
        switching = false;
        return;
      }
      try {
        if (Math.abs(incoming.currentTime - pos) > 0.05) incoming.currentTime = pos;
      } catch {
        /* ignore */
      }
      const old = audio;
      audio = incoming; // make it active BEFORE play so the handlers accept it
      curQ = newQ;
      registerSource(incoming);
      resumeAudio();
      if (wasPlaying) incoming.play().catch(() => {});
      old.pause();
      try {
        old.removeAttribute("src");
        old.load();
      } catch {
        /* ignore */
      }
      switching = false;
    };
    incoming.addEventListener("loadedmetadata", onMeta);
    incoming.addEventListener("canplay", swap); // enough buffered at `pos` to start
    // Safety net so a stalled preload can't lock the quality picker forever.
    failTimer = setTimeout(swap, 8000);
  }

  // Apply a target time once the freshly-loaded source can seek. Cached/archived
  // files honour range requests; a live transcode may ignore it (best-effort).
  function seekOnceLoaded(t) {
    const apply = () => {
      try {
        audio.currentTime = t;
      } catch {
        /* not seekable yet */
      }
      audio.removeEventListener("loadedmetadata", apply);
    };
    audio.addEventListener("loadedmetadata", apply);
  }

  // Reflect transport state onto the element, but ONLY on a real mismatch.
  // This block re-runs on every player-store change (incl. 4×/s progress
  // updates), so blindly calling audio.play()/pause() here would fight the OS:
  // when another app (e.g. a TTS that grabs audio focus) pauses us, the element
  // is paused while the store may still read playing=true for a tick, and an
  // unconditional play() gets cut off again → a rapid play/pause loop. Guarding
  // on audio.paused makes each direction idempotent and breaks the oscillation.
  $: if (audio && curId && !switching && !recovering) {
    if ($player.playing && audio.paused) audio.play().catch(() => {});
    else if (!$player.playing && !audio.paused) audio.pause();
  }
  $: if (audio) audio.volume = $player.muted ? 0 : $player.volume;

  // Keep the OS media notification's transport state in sync (play/pause glyph).
  $: if ("mediaSession" in navigator)
    navigator.mediaSession.playbackState = $player.playing ? "playing" : "paused";

  function onTime(e) {
    if (e && e.target !== audio) return; // ignore the idle/preloading element
    // Healthy progress: clear the recovery budget so a later, unrelated stall
    // gets its full retry allowance again.
    if (recoverAttempts && audio.currentTime > lastPos) recoverAttempts = 0;
    // A live, on-the-fly transcoded stream (e.g. Opus/ogg piped from ffmpeg)
    // has no Content-Length, so audio.duration is Infinity/NaN. Fall back to
    // the duration we already know from the track metadata.
    const d =
      audio.duration && isFinite(audio.duration)
        ? audio.duration
        : $current?.duration || 0;
    if (audio.currentTime > 0.25) lastKnownTime = audio.currentTime;
    if (netWaiting) netWaiting = false; // progress resumed on its own
    player.setProgress(audio.currentTime, d);
    updateBuffered();
    updatePositionState(audio.currentTime, d);
  }

  // Publish how far we've buffered ahead of the playhead so the seek bars can
  // paint the loaded region (seeking past it = a re-buffer pause). Fires on the
  // element's `progress` events and every timeupdate.
  function onProgress(e) {
    if (e && e.target !== audio) return;
    updateBuffered();
  }
  function updateBuffered() {
    if (!audio) return;
    let end = audio.currentTime;
    try {
      const b = audio.buffered;
      for (let i = 0; i < b.length; i++) {
        // The range covering (or just reached by) the playhead.
        if (b.start(i) <= audio.currentTime + 0.25 && b.end(i) >= audio.currentTime) {
          end = Math.max(end, b.end(i));
          break;
        }
      }
    } catch {
      /* buffered may throw if the element isn't ready */
    }
    buffered.set(end);
  }

  // Feed the OS media notification a duration/position so it can draw a seek
  // bar. Throws if duration <= 0 or position > duration, so clamp + guard.
  function updatePositionState(position, duration) {
    if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession))
      return;
    if (!duration || !isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: Math.min(Math.max(position, 0), duration),
        playbackRate: audio?.playbackRate || 1,
      });
    } catch {
      /* ignore */
    }
  }

  async function onEnded(e) {
    if (e && e.target !== audio) return; // ignore the idle/preloading element
    const s = get(player);
    const cur = $current;
    if (s.repeat === "one") {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (s.index < s.queue.length - 1) {
      player.next();
      return;
    }
    if (s.repeat === "all") {
      player.jump(0);
      return;
    }
    if (s.autoplay && cur) {
      try {
        const r = await api.trackRadio(cur.deezer_id);
        const more = (r.tracks || []).filter((t) => t.deezer_id !== cur.deezer_id);
        if (more.length) {
          player.autoExtend(more);
          return;
        }
      } catch {
        /* ignore */
      }
    }
    flushListen(null); // playback stops here — report the final track
    player.pause();
  }

  // Keep the queue topped up so Flow / radio play endlessly without a gap.
  let extending = false;
  async function ensureUpcoming() {
    if (!get(online)) return; // radio/flow need the network — skip while offline
    const s = get(player);
    if (!s.autoplay || s.index < 0) return;
    if (s.index < s.queue.length - 3) return; // still buffered
    if (extending) return;
    extending = true;
    try {
      let more = [];
      if (s.context && s.context.kind === "flow") {
        more = (await api.flow()).tracks || [];
      } else {
        const seed = s.queue[s.queue.length - 1] || s.queue[s.index];
        if (seed) more = (await api.trackRadio(seed.deezer_id)).tracks || [];
      }
      player.extend(more);
    } catch {
      /* ignore */
    } finally {
      extending = false;
    }
  }

  // Re-check the buffer each time the playing track changes.
  $: if ($current) ensureUpcoming();

  // Pre-archive ONLY the next track (n+1) so it starts instantly, and re-fire
  // whenever that upcoming track changes — a skip, a queue extension, or a Flow
  // re-tune. Keeping it to a single track avoids hammering the archiver.
  let prefetchedId = null;
  let prefetchTimer = null;
  // Delay before pulling the next track's audio into the on-device cache. It
  // gives the CURRENT track's buffering first claim on the bandwidth, and it
  // means skipping through a playlist doesn't fire a full audio download per
  // skip — only a "next" that survives the delay gets fetched.
  const PREFETCH_DELAY = 12000;
  $: {
    const nextTrack =
      $player.index >= 0 ? $player.queue[$player.index + 1] : null;
    const nextId = nextTrack?.deezer_id;
    // Skip when offline or when the next track is already on the device (it'll
    // play from its local blob anyway).
    if (nextId && nextId !== prefetchedId && $online && !isDownloaded(nextId)) {
      prefetchedId = nextId;
      api.download([nextId]).catch(() => {}); // server-side pre-archive (cheap call)
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => {
        // Re-check at fire time: still the upcoming track, still online, still
        // wanted. A skip meanwhile changed `next` (and rescheduled us).
        const s = get(player);
        const stillNext = s.index >= 0 && s.queue[s.index + 1]?.deezer_id === nextId;
        if (stillNext && get(online) && get(prefetchEnabled))
          prefetchTrack(nextTrack, get(quality)).catch(() => {});
      }, PREFETCH_DELAY);
    }
  }

  async function trackMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!$current) return;
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    await userPlaylists();
    openMenu(coords, buildTrackMenu($current, push));
  }

  function seek(e) {
    if (audio && audio.duration) audio.currentTime = +e.target.value;
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist?.name,
        album: track.album?.title,
        artwork: track.album?.cover
          ? [{ src: track.album.cover, sizes: "500x500", type: "image/jpeg" }]
          : [],
      });
      navigator.mediaSession.setActionHandler("play", () => player.play());
      navigator.mediaSession.setActionHandler("pause", () => player.pause());
      navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
      navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
      // Scrubbing + skip from the OS notification / lock screen.
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (audio && d.seekTime != null) audio.currentTime = d.seekTime;
      });
      navigator.mediaSession.setActionHandler("seekbackward", (d) => {
        if (audio)
          audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler("seekforward", (d) => {
        if (audio)
          audio.currentTime = Math.min(
            audio.duration || $current?.duration || 0,
            audio.currentTime + (d.seekOffset || 10)
          );
      });
    } catch {
      /* ignore */
    }
  }

  $: progress = $player.duration ? ($player.currentTime / $player.duration) * 100 : 0;
  // Buffered region (lighter fill), clamped to never read below the playhead.
  $: bufferedPct = $player.duration
    ? Math.min(100, Math.max(progress, ($buffered / $player.duration) * 100))
    : 0;
  $: repeatIconName = $player.repeat === "one" ? "repeat1" : "repeat";
</script>

<svelte:window on:click={() => (qOpen = false)} />

<!-- the <audio> elements are created and managed in JS (see makeEl/switchQuality) -->

<footer class="player">
  <!-- now playing (left / tap to open the immersive view) -->
  <button class="now" on:click={() => immersiveOpen.set(true)}>
    {#if $current}
      <Cover src={$current.album?.cover} alt={$current.title} size={56} />
      <span class="info">
        <span class="t">{$current.title}</span>
        <span class="a muted">{$current.artist?.name}</span>
      </span>
    {:else}
      <span class="muted ph">Rien en lecture</span>
    {/if}
  </button>

  {#if $current}
    <button class="fav desk" class:on={fav} on:click={() => toggleFavorite($current)} aria-label="Favori">
      <Icon name={fav ? "heartFilled" : "heart"} size={18} />
    </button>
  {/if}

  <!-- transport (flat children so the grid can reflow shuffle/repeat to a 2nd
       row at narrow-desktop widths instead of squeezing the play button) -->
  <div class="controls">
    <button class="sm shuf" class:on={$player.shuffle} on:click={() => player.toggleShuffle()} aria-label="Aléatoire"><Icon name="shuffle" size={18} /></button>
    <button class="prev" on:click={() => player.prev()} aria-label="Précédent"><Icon name="prev" size={20} /></button>
    <button class="pp" on:click={() => player.toggle()} aria-label="Lecture/Pause">
      <Icon name={$player.playing ? "pause" : "play"} size={18} />
    </button>
    <button class="next" on:click={() => player.next()} aria-label="Suivant"><Icon name="next" size={20} /></button>
    <button class="sm rep" class:on={$player.repeat !== "off"} on:click={() => player.cycleRepeat()} aria-label="Répéter">
      <Icon name={repeatIconName} size={18} />
    </button>
    <div class="seek">
      <span class="time">{fmtDuration($player.currentTime)}</span>
      <input type="range" min="0" max={$player.duration || 0} value={$player.currentTime} on:input={seek} style={`--p:${progress}%; --b:${bufferedPct}%`} />
      <span class="time">{fmtDuration($player.duration)}</span>
    </div>
  </div>

  <!-- extras -->
  <div class="extra">
    <div class="q-wrap">
      <button
        class="q"
        class:hifi={$quality === "FLAC"}
        class:open={qOpen}
        on:click|stopPropagation={() => (qOpen = !qOpen)}
        title="Qualité de streaming"
        aria-haspopup="listbox"
        aria-expanded={qOpen}
      >
        {QUALITY_LABEL[$quality]}
        <Icon name="chevronUp" size={12} />
      </button>
      {#if qOpen}
        <ul class="q-menu" role="listbox">
          {#each QUALITIES as qq}
            <li>
              <button
                role="option"
                aria-selected={$quality === qq}
                class:sel={$quality === qq}
                on:click|stopPropagation={() => selectQuality(qq)}
              >
                <span class="ql">
                  <span class="qn">{QUALITY_LABEL[qq]}</span>
                  <span class="qh muted">{QUALITY_HINT[qq]}</span>
                </span>
                {#if $quality === qq}<Icon name="check" size={15} />{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <button class="sm" on:click={trackMenu} title="Plus d'options" aria-label="Plus d'options"><Icon name="moreVertical" size={18} /></button>
    <button class="sm max" on:click={() => immersiveOpen.set(true)} title="Plein écran" aria-label="Plein écran"><Icon name="maximize" size={17} /></button>
    <button class="sm" class:on={$nowPlayingOpen} on:click={() => nowPlayingOpen.update((v) => !v)} title="File / Paroles" aria-label="File d'attente"><Icon name="queue" size={18} /></button>
    <button class="sm vol-ic" on:click={() => player.toggleMute()} aria-label="Muet"><Icon name={$player.muted || $player.volume === 0 ? "mute" : "volume"} size={18} /></button>
    <input class="vol" type="range" min="0" max="1" step="0.01" value={$player.muted ? 0 : $player.volume} on:input={(e) => player.setVolume(+e.target.value)} />
  </div>
</footer>

<!-- mobile full-screen now playing -->
<ImmersivePlayer />

<style>
  .player {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: var(--player-h);
    display: grid;
    grid-template-columns: 1fr auto 2fr 1fr;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    background: var(--bg-elev);
    border-top: 1px solid var(--bg-hover);
    z-index: 50;
  }
  .now {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    text-align: left;
  }
  .now .info {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22vw;
  }
  .t {
    font-weight: 700;
  }
  .a {
    font-size: 0.85rem;
  }
  .ph {
    padding-left: 4px;
  }
  .fav {
    color: var(--text-dim);
    font-size: 1.2rem;
  }
  .fav.on {
    color: var(--accent-2);
  }
  .controls {
    display: grid;
    align-items: center;
    justify-content: center;
    column-gap: 16px;
    row-gap: 6px;
    grid-template-areas:
      "shuf prev pp next rep"
      "seek seek seek seek seek";
  }
  .controls .shuf {
    grid-area: shuf;
  }
  .controls .prev {
    grid-area: prev;
  }
  .controls .pp {
    grid-area: pp;
  }
  .controls .next {
    grid-area: next;
  }
  .controls .rep {
    grid-area: rep;
  }
  .controls > button {
    color: var(--text-dim);
    font-size: 1.05rem;
    justify-self: center;
  }
  .controls > button:hover {
    color: var(--text);
  }
  .sm {
    font-size: 0.95rem !important;
  }
  .sm.on {
    color: var(--accent) !important;
  }
  .pp {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--text);
    color: var(--bg) !important;
    display: grid;
    place-items: center;
  }
  .pp:hover {
    transform: scale(1.06);
  }
  .seek {
    grid-area: seek;
    display: flex;
    align-items: center;
    gap: 10px;
    width: min(100%, 540px);
    justify-self: center;
  }
  .time {
    font-size: 0.72rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    width: 36px;
    text-align: center;
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: var(--bg-hover);
    flex: 1;
    cursor: pointer;
  }
  .seek input[type="range"] {
    background: linear-gradient(
      90deg,
      var(--accent) var(--p, 0%),
      rgba(255, 255, 255, 0.28) var(--p, 0%),
      rgba(255, 255, 255, 0.28) var(--b, 0%),
      var(--bg-hover) var(--b, 0%)
    );
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
  }
  .extra {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }
  .extra .sm {
    color: var(--text-dim);
  }
  .extra .sm:hover {
    color: var(--text);
  }
  .vol {
    width: 90px;
    flex: none;
  }
  .q-wrap {
    position: relative;
  }
  .q {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--text-dim);
    border: 1px solid var(--bg-hover);
    border-radius: 6px;
    padding: 3px 7px;
    white-space: nowrap;
  }
  .q :global(svg) {
    transition: transform 0.15s ease;
  }
  .q.open :global(svg) {
    transform: rotate(180deg);
  }
  .q:hover {
    color: var(--text);
  }
  .q.hifi {
    color: var(--accent);
    border-color: var(--accent);
  }
  .q-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    min-width: 188px;
    list-style: none;
    margin: 0;
    padding: 6px;
    background: var(--bg-elev);
    border: 1px solid var(--bg-hover);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    z-index: 60;
  }
  .q-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    border-radius: 7px;
    color: var(--text);
    text-align: left;
  }
  .q-menu button:hover {
    background: var(--bg-hover);
  }
  .q-menu button.sel {
    color: var(--accent);
  }
  .ql {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .qn {
    font-size: 0.82rem;
    font-weight: 600;
  }
  .qh {
    font-size: 0.68rem;
  }

  /* narrow desktop: drop shuffle/repeat to a 2nd row flanking the seek bar
     instead of cramming everything on one line and squeezing the play button. */
  @media (min-width: 641px) and (max-width: 1024px) {
    .player {
      grid-template-columns: 1fr auto 1.6fr auto;
      gap: 10px;
    }
    .controls {
      grid-template-columns: auto 1fr auto;
      grid-template-areas:
        "prev pp next"
        "shuf seek rep";
      column-gap: 12px;
    }
    .extra {
      gap: 8px;
    }
    .extra .max {
      display: none; /* tap the track to open the full-screen player */
    }
    .vol {
      width: 72px;
    }
  }

  /* mobile (phone-sized): just the now-playing + play/next, tap to expand */
  @media (max-width: 640px) {
    .player {
      grid-template-columns: 1fr auto auto;
      height: 60px;
      gap: 8px;
    }
    .controls .seek,
    .fav.desk {
      display: none;
    }
    /* Keep only the fullscreen toggle from the extras cluster — the quality
       menu, volume, etc. don't fit a narrow bar, but the fullscreen button
       must stay reachable. */
    .extra > :not(.fs) {
      display: none;
    }
    .extra {
      gap: 0;
    }
    .controls {
      display: flex;
      gap: 14px;
    }
    .controls .shuf,
    .controls .rep,
    .controls .prev {
      display: none;
    }
    .t,
    .a {
      max-width: 46vw;
    }
  }
</style>

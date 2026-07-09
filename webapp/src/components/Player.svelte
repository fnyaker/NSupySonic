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
    offlineCovers,
    setPlaybackStatus,
    normalization,
  } from "../lib/stores.js";
  import { api } from "../lib/api.js";
  import { online } from "../lib/net.js";
  import { playbackLabel, playbackBusy } from "../lib/playback.js";
  import { isDownloaded, getObjectURL, touch } from "../lib/offline.js";
  import { isCached, getCachedAudioURL, prefetchTrack } from "../lib/playcache.js";
  import { toggleFavorite, buildTrackMenu } from "../lib/actions.js";
  import { duration as fmtDuration, resolveCover, coverKey, baseCover } from "../lib/format.js";
  import { registerSource, resumeAudio, setTrackGain } from "../lib/visualizer.js";
  import {
    getEpisodeProgress,
    saveEpisodeProgress,
    clearEpisodeProgress,
  } from "../lib/podcastProgress.js";
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
  // True from the moment a track change starts until its new source is attached.
  // The outgoing element can still fire `timeupdate` during that (async) gap, so
  // this flag makes onTime ignore those stale, previous-track positions.
  let loadingTrack = false;

  function makeEl() {
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    el.addEventListener("play", onElPlay);
    el.addEventListener("pause", onElPause);
    el.addEventListener("error", onElError);
    el.addEventListener("stalled", onElStall);
    el.addEventListener("waiting", onElWaiting);
    el.addEventListener("progress", onProgress);
    return el;
  }
  onMount(() => {
    els = [makeEl(), makeEl()];
    audio = els[0]; // assignment kicks the reactive load/transport blocks
    startWatchdog();
    document.addEventListener("visibilitychange", onVisibility);
    // Last reliable moment before the tab is discarded: report the current
    // track's play time (reportListen uses keepalive, so it survives unload).
    window.addEventListener("pagehide", onPageHide);
  });
  function onPageHide() {
    savePodcastProgress(true);
    flushListen(null);
  }
  onDestroy(() => {
    savePodcastProgress(true);
    stopWatchdog();
    cancelRecovery();
    cancelSwitch();
    cancelPauseMirror();
    cancelPendingSeek();
    cancelSeekChase();
    clearTimeout(prefetchTimer);
    clearTimeout(archiveTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
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
  let recoverDeadline = null; // hard timeout so a recovery can't wedge forever
  // Has the current track ever produced audio progress? A track that never has
  // (first play of a cold Deezer track being archived/transcoded server-side)
  // gets a long grace window before we treat a frozen playhead as a stall —
  // reloading too early aborts the in-flight archive and turns slowness into a
  // skip. Reset on every (re)load / restart.
  let hadProgress = false;
  // True while playback is interrupted purely because the network is down: we
  // hold the track + position and resume on reconnect instead of skipping.
  let netWaiting = false;
  const RECOVER_MAX = 4;
  const STALL_MS = 6000; // a track that HAS played but froze → real stall
  const COLD_START_MS = 30000; // a track that never started → let the server work
  const RECOVER_DEADLINE_MS = 12000; // give up on a single recovery attempt

  function startWatchdog() {
    stopWatchdog();
    lastAdvance = Date.now();
    watchdog = setInterval(() => {
      if (!audio || switching || recovering || loadingTrack || chasing) return;
      const s = get(player);
      if (!s.playing || audio.paused) return; // not trying to play / cleanly paused
      if (audio.currentTime !== lastPos) {
        lastPos = audio.currentTime;
        lastAdvance = Date.now();
        if (audio.currentTime > 0.25) {
          hadProgress = true;
          setPlaybackStatus("idle");
        }
        return;
      }
      // currentTime frozen while we believe we're playing.
      const frozen = Date.now() - lastAdvance;
      const limit = hadProgress ? STALL_MS : COLD_START_MS;
      // Say WHAT is happening while we wait, so the silence isn't unexplained.
      if (frozen > 1500 && !netWaiting)
        setPlaybackStatus(hadProgress ? "buffering" : "archiving");
      if (frozen > limit) recoverPlayback();
    }, 2000);
  }
  function stopWatchdog() {
    clearTimeout(watchdog);
    clearInterval(watchdog);
    watchdog = null;
  }

  function onElError(e) {
    if (e && e.target !== audio) return;
    if (loadingTrack) return; // stale error from the outgoing source
    // A failing chase reload (network dropped mid-chase): fold back into the
    // normal recovery path, which parks offline / resumes at the last position.
    if (chasing) cancelSeekChase();
    if (get(player).playing) recoverPlayback();
  }
  function onElStall(e) {
    if (e && e.target !== audio) return;
    // Give buffering a moment; the watchdog handles a sustained freeze.
    if (get(player).playing && !recovering && !switching)
      setPlaybackStatus(hadProgress ? "buffering" : "archiving");
  }
  // The element ran out of buffered data and is waiting for more — surface it
  // right away (faster than the watchdog) so silence isn't unexplained.
  function onElWaiting(e) {
    if (e && e.target !== audio) return;
    if (loadingTrack || recovering || switching) return;
    if (get(player).playing && !netWaiting)
      setPlaybackStatus(hadProgress ? "buffering" : "archiving");
  }

  // Tear down any in-flight recovery so a late loadedmetadata/error can't fire
  // after the track changed OR after the user paused — that stale handler used
  // to re-`play()` a paused track and leave `recovering` stuck (the "pause does
  // nothing / silence with the play icon on" wedge). Safe to call any time.
  let recoverCleanup = null;
  function cancelRecovery() {
    clearTimeout(recoverDeadline);
    recoverDeadline = null;
    if (recoverCleanup) {
      recoverCleanup();
      recoverCleanup = null;
    }
    recovering = false;
  }

  // Reload the current track in place and resume where it died. Capped so a
  // permanently broken stream can't spin in a reload loop, and bounded by a hard
  // deadline so a HUNG reload (upstream that never answers) can't wedge the
  // transport — the whole point: the user's pause must always take effect.
  function recoverPlayback() {
    const cur = get(current);
    if (!cur || !audio || switching || recovering || loadingTrack) return;
    // Network down: don't burn the retry budget or skip the track. Park it and
    // let the reconnect handler resume from the same spot. A downloaded track
    // plays from a local blob, so the network is irrelevant — recover it in
    // place (reloading the object URL) instead of parking or hitting the net.
    if (!curIsBlob && (!navigator.onLine || !get(online))) {
      netWaiting = true;
      setPlaybackStatus("waiting-network");
      return;
    }
    if (recoverAttempts >= RECOVER_MAX) {
      failCurrentTrack(); // permanently broken stream — move on
      return;
    }
    recovering = true;
    recoverAttempts++;
    setPlaybackStatus("recovering", { attempt: recoverAttempts, max: RECOVER_MAX });
    const recoverId = curId; // the track this attempt belongs to
    const el = audio;
    const pos =
      el.currentTime > 0.5
        ? el.currentTime
        : lastKnownTime || get(player).currentTime || 0;
    // The element may still carry preload=none from a paused restore — with it,
    // load() defers fetching and loadedmetadata below would never fire.
    el.preload = "auto";
    el.src =
      curIsBlob && curBlobUrl ? curBlobUrl : api.streamUrl(cur.deezer_id, curQ);
    el.load();
    const cleanup = () => {
      clearTimeout(recoverDeadline);
      recoverDeadline = null;
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onErr);
      recoverCleanup = null;
      recovering = false;
    };
    recoverCleanup = cleanup;
    const onMeta = () => {
      // The track changed or the element was swapped meanwhile: don't touch it.
      if (recoverId !== curId || el !== audio) {
        cleanup();
        return;
      }
      try {
        // Only seek when the reloaded source actually allows it: forcing it on
        // a still-generating (rangeless) stream made the browser restart the
        // fetch and bounce playback to 0.
        if (pos > 0 && seekableAt(el, pos)) el.currentTime = pos;
      } catch {
        /* not seekable yet */
      }
      // Only resume if the user still WANTS playback — a recovery must never
      // override a pause the user made while we were reloading.
      if (get(player).playing) el.play().catch(() => {});
      cleanup();
      lastAdvance = Date.now();
      setPlaybackStatus("idle");
    };
    // The reload itself failed (e.g. server 502) OR the deadline fired (a hung
    // upstream): schedule the next attempt with backoff. Once the budget is
    // spent the next call skips the track (or parks it if offline).
    const onErr = () => {
      cleanup();
      const delay = Math.min(800 * recoverAttempts, 4000);
      setTimeout(() => {
        if (get(player).playing && recoverId === curId) recoverPlayback();
      }, delay);
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onErr);
    recoverDeadline = setTimeout(() => {
      recoverDeadline = null;
      if (recoverId === curId && el === audio) onErr();
      else cleanup();
    }, RECOVER_DEADLINE_MS);
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
    // Reflect a NATIVE resume (OS/lock-screen play) back into the store — but
    // NOT while we're mid-recovery/switch/chase, where the play() is ours or a
    // stale handler's: promoting it there would resurrect a playback the user
    // just paused (the "pause won't stick / play button inverted" bug).
    if (!get(player).playing && !recovering && !switching && !chasing)
      player.play();
  }
  function onElPause(e) {
    if (e.target !== audio) return;
    if (!get(player).playing) return; // already paused in the store (our own doing)
    if (audio.ended) return; // end-of-track is handled by onEnded, not here
    if (chasing) return; // our own programmatic pause while chasing a seek
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
  // Only time actually spent PLAYING counts — wall time used to include pauses
  // (an hour paused reported as an hour listened).
  let listenId = null;
  let listenAccum = 0; // ms played so far for the current track
  let listenMark = 0; // timestamp playback last resumed at (0 = paused)
  $: trackListenState($player.playing);
  // Persist an episode's position the moment it's paused — a pause is often the
  // last thing that runs before the tab is backgrounded and frozen.
  $: if (!$player.playing) savePodcastProgress(true);
  function trackListenState(p) {
    if (p && !listenMark) listenMark = Date.now();
    else if (!p && listenMark) {
      listenAccum += Date.now() - listenMark;
      listenMark = 0;
    }
  }
  function flushListen(nextId = null) {
    if (listenId && listenId !== nextId) {
      const played = listenAccum + (listenMark ? Date.now() - listenMark : 0);
      const listened = Math.max(0, Math.round(played / 1000));
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
    listenAccum = 0;
    listenMark = get(player).playing ? Date.now() : 0;
  }

  // Backfill a track's ReplayGain when it's unknown, so normalization works on
  // tracks whose metadata predates the gain field. Only when normalization is
  // on and online; the result is cached on the queue object and server-side, so
  // this fires at most once per track. Guarded by a session-level tried-set so
  // a track with genuinely no gain isn't refetched on every replay.
  // Turning normalization on mid-track: backfill the current track's gain too.
  $: if ($normalization !== "off" && $current) ensureGain($current);
  const gainTried = new Set();
  async function ensureGain(track) {
    if (get(normalization) === "off") return;
    if (typeof track.gain === "number") return;
    const id = String(track.deezer_id || "");
    if (!/^\d+$/.test(id) || gainTried.has(id) || !get(online)) return;
    gainTried.add(id);
    try {
      const r = await api.trackGain(id);
      if (r && typeof r.gain === "number") {
        track.gain = r.gain; // cache on the queue object
        if (get(current)?.deezer_id === track.deezer_id) setTrackGain(r.gain);
      }
    } catch {
      /* leave it un-normalized */
    }
  }

  // Podcast resume: remember the playhead of the current episode so it can be
  // picked up later. Throttled during playback (~5s), forced on pause/hide.
  let lastPodSave = 0;
  function savePodcastProgress(force = false) {
    const cur = get(current);
    if (!cur || !cur.podcast || !audio) return;
    const now = Date.now();
    if (!force && now - lastPodSave < 5000) return;
    lastPodSave = now;
    const d =
      audio.duration && isFinite(audio.duration) ? audio.duration : cur.duration || 0;
    saveEpisodeProgress(cur.deezer_id, audio.currentTime, d);
  }

  // Seek requests from other views (e.g. the immersive player). Routed through
  // performSeek so non-seekable live streams are chased instead of reset to 0.
  $: if (audio && $seekTo != null) {
    const t = $seekTo;
    seekTo.set(null);
    performSeek(t);
  }

  $: fav = $current && $favorites.has(String($current.deezer_id));

  // Load a new track onto the active element when the track changes — OR restart
  // the current one when the player navigated to it deliberately even though it
  // carries the same deezer id (a duplicate in the queue, a "restart" prev).
  $: if (audio && $current) {
    if ($current.deezer_id !== curId) loadTrack($current);
    else if ($player.seq !== curSeq) restartCurrent();
  }
  // The queue emptied (last track removed): stop and release the element so it
  // doesn't keep playing a track that's no longer current while the UI shows
  // "nothing playing".
  $: if (audio && !$current && curId !== null) teardownAudio();

  function teardownAudio() {
    cancelRecovery();
    cancelSwitch();
    cancelSeekChase();
    cancelPendingSeek();
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      /* ignore */
    }
    setBlobUrl(null);
    curId = null;
    curIsBlob = false;
    buffered.set(0);
    player.setProgress(0, 0);
    setPlaybackStatus("idle");
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
    //    so a drop right at the track change doesn't stall playback. The cached
    //    bitrate must match the asked quality while online (else stream fresh).
    if (isCached(deezerId)) {
      try {
        const u = await getCachedAudioURL(deezerId, q);
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
    // Where to (re)start this track:
    //  - a podcast episode always resumes from its own saved position, whenever
    //    it's loaded (replaying it days later still picks up where you stopped);
    //  - otherwise, only the very first (session-restored) load resumes.
    let resumeAt = 0;
    if (track.podcast) {
      const p = getEpisodeProgress(track.deezer_id);
      if (p && p.t > 1) resumeAt = p.t;
    } else if (firstLoad && $player.currentTime > 1) {
      resumeAt = $player.currentTime;
    }
    curId = track.deezer_id;
    curQ = get(quality);
    curSeq = get(player).seq;
    lastKnownTime = resumeAt;
    // Static per-track volume normalization: hand the graph this track's
    // ReplayGain (dB) so it can set a fixed gain for the whole track. No-op
    // unless the user enabled normalization. If the gain is unknown (older DB
    // rows, or a browse dict without it), backfill it lazily from the server.
    setTrackGain(track.gain);
    ensureGain(track);
    recoverAttempts = 0; // fresh track, fresh recovery budget
    hadProgress = false; // this track hasn't produced audio yet (cold-start grace)
    cancelRecovery(); // a recovery for the OUTGOING track must not touch this one
    cancelPauseMirror(); // drop a deferred pause from the outgoing track
    cancelPendingSeek(); // a stale seek must never land on this new track
    cancelSeekChase(); // ditto for a chase targeting the outgoing track
    buffered.set(0); // new source -> nothing loaded yet
    setPlaybackStatus(get(player).playing ? "loading" : "idle");
    // Reset the seek bar NOW — before the (possibly async) source resolve — so a
    // skip never leaves the outgoing track's position/duration on screen, and
    // gate onTime so a late timeupdate from the old source can't write it back.
    loadingTrack = true;
    player.setProgress(resumeAt, track.duration || 0);

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
      return; // the superseding load owns loadingTrack from here
    }
    setBlobUrl(src.blob ? src.url : null);
    curIsBlob = src.blob;
    // A paused session-restore boot must not buffer audio in the background —
    // that silently burned data on EVERY app launch. preload=none defers the
    // fetch until the user actually presses play (play() triggers the load).
    audio.preload = firstLoad && !get(player).playing ? "none" : "auto";
    audio.src = src.url;
    audio.load();
    loadingTrack = false; // new source attached — accept its timeupdates again
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
    hadProgress = false;
    cancelRecovery();
    cancelPendingSeek(); // a pending resume-seek would undo the restart
    cancelSeekChase(); // so would a chase still aiming at an old target
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
    cancelRecovery();
    cancelSwitch();
    setPlaybackStatus("error");
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

  // -- robust seeking ---------------------------------------------------------
  // A FIRST play streams from a live source (the archive downloading, or a
  // transcode being generated): no Content-Length, no range support. Setting
  // currentTime outside its buffered region makes the browser re-fetch the URL,
  // get a fresh full stream back, and reset playback to 0 — the "seek snaps
  // back to the start" bug (then the stall watchdog reloaded and lost the
  // position again). So every user seek goes through performSeek: an in-range
  // target seeks immediately; otherwise we CHASE it — keep playing while the
  // growing buffer reaches the target, and after a few seconds reload the URL
  // once (the server archives/caches WHILE it streams, so by then it usually
  // serves a finished file WITH range support) and land the seek as soon as
  // the element allows it.
  let chase = null; // { t, el, onAvail, reloadTimer, capTimer }
  let chasing = false; // gates transport auto-play / pause mirroring / onTime

  function seekableAt(el, t) {
    try {
      const s = el.seekable;
      for (let i = 0; i < s.length; i++) {
        if (t >= s.start(i) && t <= s.end(i)) return true;
      }
    } catch {
      /* element not ready yet */
    }
    return false;
  }

  function performSeek(t) {
    if (!audio || !curId) return;
    const dur = get(player).duration;
    t = Math.max(0, dur ? Math.min(t, Math.max(0, dur - 0.2)) : t);
    cancelSeekChase(); // a new seek supersedes a chase in progress
    // Reflect the intent on the bar right away (also stops the thumb snapping
    // back under the pointer between input events while dragging).
    player.setProgress(t, dur);
    // Blobs and range-supporting sources seek directly; an element without
    // metadata yet defers through safeSeek's loadedmetadata path.
    if (curIsBlob || audio.readyState < 1 || seekableAt(audio, t)) {
      safeSeek(t);
      return;
    }
    startSeekChase(t);
  }

  function startSeekChase(t) {
    const el = audio;
    const onAvail = () => {
      if (!chase || !seekableAt(chase.el, t)) return;
      const target = chase.el;
      cancelSeekChase();
      try {
        target.currentTime = t;
      } catch {
        /* lost the race — give up quietly */
      }
      if (get(player).playing) target.play().catch(() => {});
    };
    chase = { t, el, onAvail, reloadTimer: null, capTimer: null };
    chasing = true;
    // Listeners live on the ELEMENT, so they survive the reload's src change.
    el.addEventListener("progress", onAvail);
    el.addEventListener("canplay", onAvail);
    el.addEventListener("timeupdate", onAvail);
    // One reload, a few seconds in: covers backward seeks (a forward-only
    // stream never re-buffers what's behind) and picks up the server-side
    // archive/transcode if it finished meanwhile (a reload then serves a
    // seekable file).
    chase.reloadTimer = setTimeout(reloadForChase, 8000);
    // Give up silently after a while — the bar falls back to the real position.
    chase.capTimer = setTimeout(cancelSeekChase, 45000);
    onAvail(); // in case it became seekable between the check and now
  }

  function reloadForChase() {
    if (!chase) return;
    const cur = get(current);
    // No network (or a blob, which never needs this): keep waiting on the
    // buffer we already have instead of killing the stream.
    if (!cur || curIsBlob || !get(online)) return;
    const el = chase.el;
    el.pause(); // don't audibly replay from 0 while buffering toward the target
    el.preload = "auto";
    el.src = api.streamUrl(cur.deezer_id, curQ);
    el.load();
  }

  function cancelSeekChase() {
    if (!chase) return;
    const { el, onAvail, reloadTimer, capTimer } = chase;
    el.removeEventListener("progress", onAvail);
    el.removeEventListener("canplay", onAvail);
    el.removeEventListener("timeupdate", onAvail);
    clearTimeout(reloadTimer);
    clearTimeout(capTimer);
    chase = null;
    chasing = false;
  }

  // Gapless quality switch: buffer the new bitrate on the idle element at the
  // current position, then swap playback over once it can play through. Keeps
  // the position to the element's full precision so there's no audible jump.
  // Abort an in-flight quality switch and keep the CURRENT element as-is, so a
  // user pause during a (possibly hung) preload takes effect immediately on the
  // still-playing element instead of waiting out the 8s deadline.
  let switchCleanup = null;
  function cancelSwitch() {
    if (switchCleanup) {
      switchCleanup();
      switchCleanup = null;
    }
    switching = false;
  }

  function switchQuality(newQ) {
    const cur = get(current);
    const incoming = els.find((e) => e !== audio);
    if (!audio || !cur || !incoming) return;
    // No network: the preload below could never succeed. Keep the current
    // stream playing and adopt the new quality for the next load — also aligns
    // curQ so the reactive block doesn't re-trigger this on every store change.
    if (!get(online)) {
      curQ = newQ;
      return;
    }
    cancelSeekChase(); // the swap changes elements — a chase would misfire
    switching = true;
    const pos = audio.currentTime;
    incoming.volume = audio.volume;
    incoming.muted = audio.muted;
    incoming.preload = "auto"; // may carry preload=none from a paused restore
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
    const cleanup = () => {
      clearTimeout(failTimer);
      switchCleanup = null;
      incoming.removeEventListener("loadedmetadata", onMeta);
      incoming.removeEventListener("canplay", swap);
      incoming.removeEventListener("error", abort);
    };
    // Tear down the incoming preload without swapping, keeping the current
    // element playing. Used both by a user pause mid-switch (cancelSwitch) and
    // as the base of `abort`.
    switchCleanup = () => {
      if (done) return;
      done = true;
      cleanup();
      try {
        incoming.pause();
        incoming.removeAttribute("src");
        incoming.load();
      } catch {
        /* ignore */
      }
      curQ = newQ; // adopt for the next load; avoids an instant retry loop
      switching = false;
    };
    // The preload failed (404/network) or stalled past the deadline: DON'T hand
    // playback to a dead element (that used to kill the audio outright) — keep
    // playing at the old bitrate and apply the new quality on the next load.
    const abort = () => {
      if (done) return;
      const teardown = switchCleanup;
      teardown && teardown();
      toasts.push("Qualité appliquée au prochain titre", "info");
    };
    const swap = () => {
      if (done) return;
      done = true;
      cleanup();
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
      // Recompute intent at SWAP time — a pause made during the preload must not
      // be undone by a stale `wasPlaying` captured when the switch started.
      if (get(player).playing) incoming.play().catch(() => {});
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
    incoming.addEventListener("error", abort); // dead source -> abort, don't swap
    // Deadline: a preload that can't get ready in time is abandoned (it used to
    // force-swap onto a possibly broken element and kill playback).
    failTimer = setTimeout(abort, 8000);
  }

  // Apply a target time once the freshly-loaded source can seek. Cached/archived
  // files honour range requests; a live transcode may ignore it (best-effort).
  // The armed listener is tracked so a track change can CANCEL it — otherwise a
  // pending seek (e.g. the session-restore position) fires on the NEXT track's
  // metadata and teleports it to the old position (possibly near its end).
  let pendingSeek = null; // { el, fn } of the armed loadedmetadata handler
  function cancelPendingSeek() {
    if (pendingSeek) {
      pendingSeek.el.removeEventListener("loadedmetadata", pendingSeek.fn);
      pendingSeek = null;
    }
  }
  function seekOnceLoaded(t) {
    cancelPendingSeek();
    const el = audio;
    const apply = () => {
      try {
        el.currentTime = t;
      } catch {
        /* not seekable yet */
      }
      cancelPendingSeek();
    };
    pendingSeek = { el, fn: apply };
    el.addEventListener("loadedmetadata", apply);
  }

  // Reflect transport state onto the element, but ONLY on a real mismatch.
  // This block re-runs on every player-store change (incl. 4×/s progress
  // updates), so blindly calling audio.play()/pause() here would fight the OS:
  // when another app (e.g. a TTS that grabs audio focus) pauses us, the element
  // is paused while the store may still read playing=true for a tick, and an
  // unconditional play() gets cut off again → a rapid play/pause loop. Guarding
  // on audio.paused makes each direction idempotent and breaks the oscillation.
  $: if (audio && curId) {
    if (!$player.playing) {
      // A pause ALWAYS wins, in EVERY state. First tear down any in-flight
      // recovery / quality-switch / seek-chase — otherwise their late handlers
      // would re-`play()` the element a moment later and the pause "does
      // nothing" (silence with the play icon on, or the button feels inverted).
      // Then pause the element. Guard on audio.paused so we don't fight the OS.
      if (recovering) cancelRecovery();
      if (switching) cancelSwitch();
      if (chasing) cancelSeekChase();
      if (!audio.paused) audio.pause();
      setPlaybackStatus("idle"); // paused = not trying to play = no indicator
    } else if (!switching && !recovering && !chasing && audio.paused) {
      // Playback starts: restore eager buffering if the paused-restore load
      // deferred it (play() fetches regardless, but rebuffers stay eager too).
      // Mid-transition states own their own play(), so don't double-drive here.
      if (audio.preload !== "auto") audio.preload = "auto";
      audio.play().catch(() => {});
    }
  }
  $: if (audio) audio.volume = $player.muted ? 0 : $player.volume;

  // Keep the OS media notification's transport state in sync (play/pause glyph).
  $: if ("mediaSession" in navigator)
    navigator.mediaSession.playbackState = $player.playing ? "playing" : "paused";

  function onTime(e) {
    if (e && e.target !== audio) return; // ignore the idle/preloading element
    if (loadingTrack) return; // a track change is mid-flight — position is stale
    if (chasing) return; // chasing a seek — hold the bar at the target
    // If the visualizer wired the element through a Web Audio context that the
    // OS later suspended (backgrounded tab), the element "plays" but is silent —
    // resumeAudio() is a no-op unless the context is actually suspended.
    resumeAudio();
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
    if (audio.currentTime > 0.25) {
      lastKnownTime = audio.currentTime;
      hadProgress = true;
      if (!audio.paused) setPlaybackStatus("idle"); // real audio is flowing
    }
    if (netWaiting) netWaiting = false; // progress resumed on its own
    player.setProgress(audio.currentTime, d);
    updateBuffered();
    updatePositionState(audio.currentTime, d);
    savePodcastProgress(); // throttled; no-op for non-podcast tracks
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
    // A track change is mid-flight: this `ended` comes from the OUTGOING source
    // finishing during the load gap — acting on it would double-advance.
    if (loadingTrack) return;
    const s = get(player);
    const cur = $current;
    // Finished a podcast episode: drop its resume point so it doesn't offer to
    // reopen at the very end next time. (repeat "one" restarts it, so keep it.)
    if (cur && cur.podcast && s.repeat !== "one") clearEpisodeProgress(cur.deezer_id);
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
  let archiveTimer = null;
  // Debounce before asking the server to pre-archive the next track. Without
  // it, zapping through a playlist queued one FLAC archive job PER SKIP on the
  // server — only a "next" that survives the debounce gets archived.
  const ARCHIVE_DELAY = 4000;
  // Delay before pulling the next track's audio into the on-device cache. It
  // gives the CURRENT track's buffering first claim on the bandwidth, and it
  // means skipping through a playlist doesn't fire a full audio download per
  // skip — only a "next" that survives the delay gets fetched.
  const PREFETCH_DELAY = 12000;
  // Still the upcoming track at fire time? A skip meanwhile changed `next`
  // (and rescheduled us).
  function stillNext(id) {
    const s = get(player);
    return s.index >= 0 && s.queue[s.index + 1]?.deezer_id === id;
  }
  $: {
    const nextTrack =
      $player.index >= 0 ? $player.queue[$player.index + 1] : null;
    const nextId = nextTrack?.deezer_id;
    // Skip when offline or when the next track is already on the device (it'll
    // play from its local blob anyway).
    if (nextId && nextId !== prefetchedId && $online && !isDownloaded(nextId)) {
      prefetchedId = nextId;
      clearTimeout(archiveTimer);
      archiveTimer = setTimeout(() => {
        if (stillNext(nextId) && get(online))
          api.download([nextId]).catch(() => {}); // server-side pre-archive
      }, ARCHIVE_DELAY);
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => {
        if (stillNext(nextId) && get(online) && get(prefetchEnabled))
          prefetchTrack(nextTrack, get(quality)).catch(() => {});
      }, PREFETCH_DELAY);
    }
  }

  function trackMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!$current) return;
    const coords = { clientX: e.clientX, clientY: e.clientY, preventDefault() {}, stopPropagation() {} };
    openMenu(coords, buildTrackMenu($current, push));
  }

  function seek(e) {
    // The old direct currentTime set silently no-oped on live streams (NaN
    // duration) and reset them to 0 otherwise — performSeek handles both.
    performSeek(+e.target.value);
  }

  // The OS fetches the notification artwork itself, ONCE, with no retry — and
  // the Deezer image CDN is flaky enough that this regularly left the system
  // notification artless. So the art is fetched HERE (retried, through the
  // server-side cached /api/cover proxy, with the page's session cookie) and
  // handed to the media session as a local blob: URL that always displays.
  let artSeq = 0; // invalidates an in-flight artwork fetch on track change
  let artCache = { key: null, url: null }; // current track's fetched artwork

  async function notificationArt(track) {
    const cover = track.album?.cover;
    const offline = resolveCover(get(offlineCovers), cover);
    if (offline && offline !== cover) return offline; // already a local blob
    const key = coverKey(cover) || "id:" + track.deezer_id;
    if (artCache.key === key && artCache.url) return artCache.url;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(api.coverUrl(track.deezer_id), {
          credentials: "include",
        });
        if (!res.ok) throw new Error(String(res.status));
        const url = URL.createObjectURL(await res.blob());
        if (artCache.url && artCache.url.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(artCache.url);
          } catch {
            /* ignore */
          }
        }
        artCache = { key, url };
        return url;
      } catch {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    return cover || null; // last resort: let the OS try the CDN URL itself
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator) || !track) return;
    const seq = ++artSeq;
    const setMeta = (art) => {
      try {
        // Beyond the primary art (often a blob: the Android app's shim can't
        // fetch), also list the same-origin /api/cover proxy (server-cached,
        // reliable) and the plain CDN URL. Browsers use the first entry; the
        // native shim picks the first non-blob one.
        const artwork = [];
        const add = (u) => {
          if (u && !artwork.some((a) => a.src === u))
            artwork.push({ src: u, sizes: "500x500" });
        };
        add(art);
        try {
          add(new URL(api.coverUrl(track.deezer_id), window.location.href).href);
        } catch {
          /* ignore */
        }
        add(baseCover(track.album?.cover));
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist?.name,
          album: track.album?.title,
          artwork,
        });
      } catch {
        /* ignore */
      }
    };
    // Title/artist must show instantly; the artwork upgrade follows as soon as
    // the reliable (blob) copy is in hand.
    setMeta(resolveCover(get(offlineCovers), track.album?.cover));
    notificationArt(track).then((art) => {
      if (art && seq === artSeq) setMeta(art);
    });
    try {
      navigator.mediaSession.setActionHandler("play", () => player.play());
      navigator.mediaSession.setActionHandler("pause", () => player.pause());
      navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
      navigator.mediaSession.setActionHandler("previoustrack", () => player.prev());
      // Scrubbing + skip from the OS notification / lock screen. All through
      // performSeek so live streams are chased instead of reset to 0.
      navigator.mediaSession.setActionHandler("seekto", (d) => {
        if (audio && d.seekTime != null) performSeek(d.seekTime);
      });
      navigator.mediaSession.setActionHandler("seekbackward", (d) => {
        if (audio) performSeek(Math.max(0, audio.currentTime - (d.seekOffset || 10)));
      });
      navigator.mediaSession.setActionHandler("seekforward", (d) => {
        if (audio) performSeek(audio.currentTime + (d.seekOffset || 10));
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
        <!-- While the player is working toward playback, the subtitle line says
             WHAT is happening (Chargement…, Nouvel essai…) instead of the artist,
             so silence under a "playing" icon is never unexplained. -->
        <span class="a muted" class:status={$playbackLabel}>{$playbackLabel || $current.artist?.name}</span>
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
    <button class="pp" class:busy={$playbackBusy} on:click={() => player.toggle()} aria-label="Lecture/Pause">
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
    position: relative;
  }
  .pp:hover {
    transform: scale(1.06);
  }
  /* Discreet spinner ring around the play/pause button while the player is
     working toward playback (loading / buffering / archiving / retrying). */
  .pp.busy::after {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--accent);
    animation: pp-spin 0.8s linear infinite;
  }
  @keyframes pp-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .a.status {
    color: var(--accent);
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
       (class "max") must stay reachable. */
    .extra > :not(.max) {
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

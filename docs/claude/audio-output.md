# Crossfade, silence trimming, and where the sound goes (direct vs processed)

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching Player.svelte crossfade, edges.py, output.js, timekeeper.js, graph.js, or Bluetooth/glitch handling.

**Crossfade + silence trimming** (`components/Player.svelte`, `lib/edges.js`,
`supysonic/webui/edges.py`). Two ideas that need each other: masters carry a beat of digital silence
at each end, and a crossfade that ignores them fades one track's silence into another's — the gap it
was meant to remove. The server measures the bounds once per (file, threshold) with ffmpeg's
`silencedetect` and caches them; it **never archives to answer**, so asking about the next track can
never start a download, and a file that is not on disk simply answers `ready:false` and plays
untrimmed. A trailing silence is one that runs to EOF — and current ffmpeg CLOSES it at the flush
(`silence_end` equal to the stream's end, measured on 6.1 across mp3/ogg/opus/m4a/flac), where older
builds left it open; reading only the open form meant the tail was never trimmed on any recent
ffmpeg, so both caches are versioned (`edges2-` server-side, `audio.edges.v2` on the device) and a
fix to the measurement must bump them again. The handover happens at the **start** of the fade, not its end: the incoming element
becomes `audio` and the queue advances there and then, so the seek bar and the lock screen name the
track you are beginning to hear. A manual skip is not an overlap — it gets a 60 ms ramp, long enough
to kill the click of a cut mid-waveform and short enough to be inaudible as a delay. Crossfading
needs the Web Audio graph, so like the effects it is off by default (see the note in `graph.js`
about a suspended AudioContext silencing a backgrounded tab) — except on the direct path (below),
where the same equal-power curve runs on the two elements' volumes.

**WHERE THE SOUND GOES: DIRECT OR PROCESSED** (`lib/audio/output.js`, `lib/audio/timekeeper.js`,
`graph.js`, `Player.svelte#renewElements`, `android/…/AudioRoute.kt`). Played through a Bluetooth car
radio (a Kenwood on AAC), the music "sounded sped up, as if pieces were being cut out", and switching
the rhythm analysis or the automatic latency off changed nothing. Nothing COULD: the full-screen
player's animation had routed the element through `createMediaElementSource`, which is one-way for
the element's whole life, and the analyser's `addModule` had moved the context's rendering onto the
AudioWorklet thread for the context's whole life. On Android that thread hands the device its audio
through a FIFO, and an A2DP sink pulls in bursts large and irregular enough that the FIFO can be
padded with silence and then drop what arrives late (Chromium 40133762 — AudioWorklet + `latencyHint:
"playback"` on Android; and the "Bluetooth + WebAudio + background = stutter" every metering PWA has
filed). The browser's own media pipeline — what every other music app uses — has none of it. **And it
comes and goes**: the same phone on the same radio, reconnected, played cleanly again. So the route
is a policy, `audio.output`, and in its default it is MEASURED rather than assumed:

- **auto** (default): processed everywhere, Bluetooth included — and DIRECT the moment the timekeeper
  measures the processed path losing audio, for as long as the fault can be expected to last: THIS
  connection of this output (`audio.glitchRoutes[routeKey]`, whose `conn` the Android app changes every
  time the output comes back), until a retry. The retry happens at a TRACK CHANGE (`retryIfDue` in
  `loadTrack`: the source is being replaced anyway, so routing the element then is inaudible) 15 min
  later, then 30, 60… up to 4 h while the fault keeps coming back (each retry that finds it costs one
  eight-second window of it); six clean windows in a row on the processed path forget it
  (`noteGoodWindow`), and a new connection starts clean. The context that lost the audio is never
  used again (`requestContextReset`: closed once no routed element plays through it, the engine
  starting over on a fresh one — the state a reconnection cured when it was reported). Réglages →
  Audio says which path, why, and when the next try is, with "Réessayer maintenant".
- **direct**: nothing is ever routed. The normalization and the crossfade ride on `element.volume`
  (the gain can only turn a track DOWN — volume stops at 1 — and the fade is stepped by a 25 ms timer
  AND by every `timeupdate`, since a background WebView may throttle timers: coarser, never stalled);
  the EQ and the bass lift are off; the animations read a COPY (`captureStream()` → a
  MediaStreamAudioSourceNode on `analysisBus`, never toward the destination), rebuilt on every track
  (a MediaStreamAudioSourceNode is bound to one track) and let go when the engine stops, at which
  point the context is SUSPENDED — a phone in a car with its screen off has one stream open, the
  element's. The copy's timing is the context's, not the element's, so the animations are only as
  close as the two output latencies are (no look-ahead: nothing audible goes through the delay).
  Auto uses the same machinery while a fault is being corrected.
- **graph**: always processed, as before; a measured fault is only reported (a toast, the log).

Leaving the graph needs a NEW element: the idle one is replaced at once, the playing one hands its
track over to a fresh one at the position it has reached (seek at metadata and again at `canplay`,
measured 3.78 s landed for 3.79 s expected), and where that cannot land (a live first-play stream
that cannot seek) the next track's load does it, since its new source goes onto a fresh element
anyway. A failed mid-song hand-over is not retried on the same track (each try is a stream request).

The **timekeeper** watches the playing element once a second, in windows of 8 s of uninterrupted
playback (a seek, a stall, a track change or an implausible tick starts a new one), against four
clocks: the element's own position (a routed element is pulled by the context: dropped frames make
it run FAST, padded silence slow — healthy is a few hundred ppm plus a render burst of quantization,
0.25% worst on the model of what Chromium measured; "sped up" is a few percent), the context's clock,
how fast the output timestamp's mapping moves (healthy: one 21.6 ms burst step now and then, 2.4 ms/s
worst; padded-then-dropped gaps: 13-31 ms/s; the bar is 10), and `AudioContext.playbackStats`
underruns where Chrome has them (1% of the time). A window past 4% pace, 3% underrun or 25 ms/s is a
verdict on its own — the simulated fault in `test/output/run.mjs` was convicted 5.2 s after it began;
a milder one needs a second bad window in a row, so one bad moment on a loaded phone is not a
verdict. On the direct path a verdict while the animations copy the sound stops the copy for the
session. Every bad window (and one good one a minute) goes to the diagnostic log;
`window.__nsAudioPath()` says which path the music takes, why, and which context (`serial`).
`test/output.test.mjs` pins the policy (the connection scope, the doubling, the clearing), the
detector on healthy and broken readings, and the volume envelopes; `test/output/run.mjs` drives the
whole thing in Chromium.

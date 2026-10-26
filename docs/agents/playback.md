# Playback: crossfade, output path, app core, list performance

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).

**Crossfade + silence trimming** (`components/Player.svelte`, `lib/edges.js`,
`supysonic/webui/edges.py`). Two ideas that need each other: masters carry a beat of digital silence
at each end, and a crossfade that ignores them fades one track's silence into another's — the gap it
was meant to remove. The server measures the bounds once per (file, threshold) with ffmpeg's
`silencedetect` and caches them; it **never archives to answer**, so asking about the next track can
never start a download, and a file that is not on disk simply answers `ready:false` and plays
untrimmed. A trailing silence is one that runs to EOF — and current ffmpeg CLOSES it at the flush
(`silence_end` equal to the stream's end, measured on 6.1 across mp3/ogg/opus/m4a/flac), where older
builds left it open; reading only the open form meant the tail was never trimmed on any recent
ffmpeg, so both caches are versioned (`edges3-` server-side, `audio.edges.v3` on the device) and a
fix to the measurement must bump them again. **A trim is for the EDGES and nothing else**: at most
10 s at either end (`MAX_EDGE_TRIM`; it was 30, and a quiet 15-s outro was cut — heard as a skip in
the middle of the song), never past a decode that stopped short of the container's `Duration`, and
the player drops bounds measured on a file whose length is not the track's (`Player.svelte#edgesFor`,
`EDGE_LENGTH_SLACK`). The handover happens at the **start** of the fade, not its end: the incoming element
becomes `audio` and the queue advances there and then, so the seek bar and the lock screen name the
track you are beginning to hear. A manual skip is not an overlap — it gets a 60 ms ramp, long enough
to kill the click of a cut mid-waveform and short enough to be inaudible as a delay. Crossfading
needs the Web Audio graph, so like the effects it is off by default (see the note in `graph.js`
about a suspended AudioContext silencing a backgrounded tab) — except on the direct path (below),
where the same equal-power curve runs on the two elements' volumes.
**No skip waits on a timer.** A backgrounded WebView fires timers as little as once a minute, and a
crossfaded skip used to start its overlap on a `setTimeout(0)` and its softened cut on a 60 ms one:
"next" on a car radio sat on the old track for anything up to that minute (measured with timers on
20 s boundaries: 2-17 s, now 0.15 s — `test/skip/run.mjs`). A skip's overlap starts synchronously,
the short ramp's wait follows the fade's own clock (`graph.js#fadeDone`: an `ended` from the audio
thread for a routed element; a hidden page snaps a direct ramp under 0.3 s, which nothing could step
anyway), and every crossfade deadline (start, give-up, end) is also checked on `timeupdate`
(`xfadeTick`), which the media pipeline fires whatever the page's timers do.

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

**THE APP CORE IS RUST TOO** (`webapp/appcore`, compiled to `src/lib/appcore/appcore.wasm`, reached
through `lib/appcore/core.js`). The interface's own logic — not the DOM, the logic — where the
JavaScript allocated as it went, on the main thread, in the paths that must not stutter:

- **`sync.rs`: every time-sync estimator the app has.** The listen party's NTP clock
  (`party/clock.js#ClockEstimator`), the host's line (`party/anchor.js#AnchorFit`), the guest's
  audio-clock bridge (`party/engine.js#makeClockBridge`) and the output clock the animations, the
  lyric line and the party host share (`audio/latency.js`). Each did its robust statistics the
  obvious way — a median was `[...xs].sort()`, an estimate built and dropped four to six arrays — many
  times a second, in the one subsystem where a collection pause is a late chunk. Now fixed rings,
  nothing allocated once built: an estimate 16.3 → 1.4 µs, the host's add-and-read 1.13 → 0.19 µs.
  What stays in JavaScript is the READING (only the browser can call `getOutputTimestamp()`) and, for
  the output clock, a mirror of its outputs refreshed after each reading, so the dozens of reads a
  second never cross into the module. The timeline's one-line arithmetic (`party/timeline.js`) and the
  engine's Web Audio orchestration stay JavaScript on purpose: a call into wasm costs more than
  `t.p + (S - t.t) / 1000` does, and nodes can only be scheduled from JavaScript.
- **`tracks.rs` + `fold.rs`: the track lists' search and sort** (`lib/tracklist.js`, used by
  `TrackBrowser.svelte` and `Playlist.svelte`). The lists lowercased every title, credit and album of
  every row on EVERY keystroke (12 000+ strings on a 4 000-track favourites page) and again inside the
  sort comparator — and the answer was wrong for a French library: a code-unit comparison put "Éric"
  after "Zazie", and "beyonce" did not find "Beyoncé". Now a list is indexed once when it changes
  (reconcile.js keeps its identity when it did not): every field FOLDED — case and accents dropped,
  ligatures spelled out, typographic quotes made plain — into one buffer, each sort order computed on
  first use and kept, a keystroke one pass over folded bytes. Measured on 4 000 tracks: a keystroke
  0.46 → 0.11 ms, a keystroke under a sort 0.62 → 0.20 ms, for a 2.3 ms build paid once. The
  unfiltered, unsorted view never touches the core — it is the list itself, the same array — and a
  page without WebAssembly still filters and sorts the old way (`tracklist.js#fallback`).

How it is loaded and shipped: **a separate module from the analyser**, on purpose — that one is
200 KB and loads when an animation needs it, this one is 63 KB (23 KB gzipped) and a party guest with
every animation off, or anybody searching their favourites, needs it at once. `main.js` fetches it
once the first screen has painted; hosting and joining a party await it (`routes/Party.svelte` loads
it on the landing screen, since the tap that joins must create the AudioContext synchronously, and a
session started without it starts its clocks a moment later); the output clock simply takes no
reading until it is in, which is what "no mapping yet" always meant. Every object is a HANDLE freed
by `free()`, with a FinalizationRegistry behind it for a handle whose owner was collected unfreed.
No dependencies, `build.rs` stamps a hash of `src/*.rs`, the binary is committed and
`test/appcore.test.mjs` fails when it is stale — the rhythm crate's rules exactly. That test holds
each estimator to its JavaScript ORACLE (`test/reference/sync.js`) number for number on the traces
it exists for (heavy-tailed asymmetric queueing between clocks 60 ppm apart, a device that slept, an
element read from a jittery timer through seeks and stalls, a context rendering in bursts whose
mapping steps and drifts), the index to a model of what folding means (Unicode's own decomposition,
marks stripped) on every sort, direction and query, and both to being faster. `party.test.mjs` and
`latency.test.mjs` run on the Rust; `test/party/run.mjs` and `test/rhythm/run.mjs` were re-run on it
(guest heard −1.1 / +0.1 / +0.1 / −0.3 ms from the host steady / after a seek / a pause / a skip;
frames −0.7..+0.6 ms against the output clock, 100% on time).

**What a big list costs the main thread is measured in a browser too** (`webapp/test/ui/run.mjs`,
long-task time under a 4x CPU throttle, median of five rounds). Two causes came out of it that no
language change would have touched:

- **The window's rows are keyed by POSITION** (`TrackList.svelte`), not by track. Every keystroke of a
  search (and every sort) handed the window a different track at each position, so all ~30 visible
  rows were destroyed and rebuilt — DOM, five store subscriptions, a cover and an artist line each —
  and that, not the filtering, was the keystroke. Recycled, a row just gets a new `track`: `Cover`
  already resets on a new source, and `TrackRow` drops a gesture begun on the previous track so a
  swipe can never commit on the wrong one. Ten letters typed into 4 000 favourites: **470 → 55 ms**.
- **The offline cache stores the response's TEXT** (`apicache.js`). IndexedDB structured-clones what
  it is given, synchronously, and a 4 000-track list is 4 000 nested objects — cloned on every visit.
  The text comes from a `clone()` of the response, read after the caller has its data: `res.json()`
  parses straight from the bytes, and putting `text()` + `JSON.parse` on the critical path measured
  WORSE than the clone it replaced. Records an older build wrote as objects still read. Opening the
  favourites: **315 → 154 ms**; the playlist 304 → 216; a sort 97 → 52.

**Why the DOM stays Svelte.** "As much Rust as possible" stops at the DOM, deliberately: a Rust UI
framework reaches the DOM through JavaScript glue on every node it touches, so it cannot render a list
or a player faster than Svelte's compiled DOM calls — measured frameworks land level with it at best —
and it would put a few hundred kilobytes of wasm in front of the first paint that the code-splitting
work above took out. Rust goes where it wins: arithmetic over many values, state that must not
allocate, work that must be identical everywhere.

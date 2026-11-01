# Listen party

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching party.py, lib/party/, PartySheet, Party.svelte, or synchronized playback.

**Listen party** (`supysonic/webui/party.py`, `webapp/src/lib/party/`, `routes/Party.svelte`,
`components/PartySheet.svelte`). The host shares a link (`/party/<id>`, with a QR code in the sheet);
whoever opens it — no account needed — hears what the host plays, **at the same instant**, to the
sample on each device. Modelled on beatsync (github.com/freeman-jiang/beatsync): NTP-style clock,
one shared timeline, Web Audio scheduling. What differs, and why:

- **Polling, never a held connection.** A socket or long-poll per listener pins one of the worker's
  16 threads for the whole party. Guests poll the in-memory state (~1 s, 350 ms near a predicted
  handover). Continuous playback does not care: it is extrapolated from the anchor.
- **The host is the reference, and is only WATCHED.** `lib/party/host.js` reads the active
  `<audio>` element four times a second against the party clock, fits the readings to one line
  (`anchor.js`, median — a single `currentTime` read is only good to a few ms) and publishes the
  anchor `{t, p}` only when the player leaves it (track, pause, seek, stall ≥ 400 ms, or 2.5 ms of
  drift). An element routed through the Web Audio graph is heard AFTER it — the context's lag
  behind the listener AT THAT INSTANT (read together with the element's `currentTime`: both move
  in the same render bursts, to ±1.5 ms, so the burst cancels), the look-ahead and the two
  compressors (their lookahead measured once per browser, `lib/party/latency.js`) — and the
  device's trim on top (`lib/audio/latency.js#elementLag`). It used to subtract
  `baseLatency + outputLatency`, the far end of the burst's swing: every guest was heard **8-21 ms
  after the host** (`test/party/run.mjs`), and each reading scattered by a whole burst. A probe that
  once measured the element 12 ms ahead of the graph was measuring the two compressors, already
  counted — the element itself adds nothing for FLAC, MP3 or WAV (resampling adds ~1.8 ms and an Ogg
  Opus stream reads ~5 ms behind: measured, not modelled). The player itself is untouched; it hands over its element and
  its own plan for the next track (`Player.svelte#partyPlan`, which must follow exactly the rules
  of `maybeCrossfade`/`maybeTrimEnding`/`loadTrack`).
- **The next track is announced**: where this track hands over (`at`), the next one's trimmed
  start, the crossfade, and `gap` — how late this player usually is to actually start it, learnt
  from its own previous handovers. Guests start it on the beat instead of a poll late; a cut ends
  the old track at `at`, a crossfade fades it from `at`.
- **Audio as CHUNKS, not a stream, not whole files.** `/party/<id>/chunk/<track>/<k>` is
  `[k·6 s, (k+1)·6 s + 50 ms)` cut by ffmpeg, Ogg Opus 192k (FLAC at the device's rate when
  `decodeAudioData` refuses Opus — the first refusal decides, remembered). Measured, `-ss` before
  `-i` lands at ZERO lag on FLAC, Ogg and MP4 — and 32 ms off on a VBR MP3 whatever `-usetoc` says,
  so an MP3 (every podcast) is first re-encoded into an exact-seek Ogg master in the background
  (1 sample off, measured). Joining costs one chunk, memory is flat whatever the length, and each
  seam is crossfaded IN TIME over the overlap — which makes every seam a point where the guest
  re-aligns to the shared clock, so two devices' audio clocks never drift apart by more than one
  chunk's worth.
- **The guest engine** (`engine.js`) schedules `AudioBufferSourceNode.start(when, offset)` on the
  AudioContext clock. Voices (one run of one track, own gain) and nodes (one chunk, own seam
  envelope). Corrections follow ONE rule (`timeline.correctionFor`): ≤ 3 ms nothing, ≤ 30 ms at the
  next seam, behind → jump forward now, **ahead → fall silent and resume the SAME audio, never
  repeat what the room heard** (also what a resume after an overshot pause does) — but only up to
  `WAIT_MAX_MS` (2.5 s): further ahead than any stall is the host going BACK, and waiting it out
  was thirty seconds of silence after a thirty-second rewind.
- **Every voice is accounted for, not just the current one.** The bug a listener reported — skip
  on the host, and the old track carries on under the new one, through pauses, to its end — was a
  predicted next track being PROMOTED when the host merely skipped to it: the old track kept the
  end planned for it minutes away, was no longer `cur`, and pause/stop/new-track only ever
  silenced `cur` and `pending`. So a prediction is promoted only when the host's line lands within
  `PROMOTE_TOL` of it (and the old track then ends where the new one really starts, if that is
  sooner); a pause, a new track or the end silences EVERY voice (`silence`); and `stopVoice` can
  bring a planned end forward. `engine.sounding()` (in `__nsParty.guest()`) lists every voice
  audible right now with the gain the audio thread computes — the one diagnostic that sees it.
- **The host never publishes a track's name with another track's position**
  (`lib/party/hostrules.js`, pure, tested). On a skip the store names the new track at once while
  the element still plays the old one (the source is resolved, and on a softened skip faded,
  first): a reading then published the new track two minutes in. The player hands over the id
  its element actually CARRIES (`loaded`, null while a source is being attached), and until the
  element runs it the track goes out as loading (`buf`: guests stop the old one now, say
  "Chargement chez …" and poll fast). The one exception is the handover guests were TOLD about —
  they are already playing it on their prediction — which is held, publishing nothing, for up to
  `HANDOVER_HOLD_MS` until its real line confirms it; a rebuffer of a few hundred ms is held the
  same way instead of republishing a frozen position. And a line only goes out once three readings
  40 ms apart agree on it: the first reading after a start was measured 23 ms off (the element
  says it plays before its clock moves), which guests then played until their next seam.
- **The audio-clock mapping is measured, and it MOVES** (`makeClockBridge`). Both lessons came from
  the real-browser run, not the simulation: the first `getOutputTimestamp()` after creation is
  ~140 ms off and a starting context's clock stands still (so only readings from a running,
  advancing context count, median of recent ones, outliers dropped, nothing scheduled before
  three agree); and a mapping that held to ±0.2 ms **stepped by exactly 20 ms** three seconds in
  and stayed there. Chunks already placed on the old mapping were then 20 ms off until a seam that
  could not absorb it. `PartyEngine.checkMapping` re-places them: every node remembers the server
  instant it was placed for; stale future nodes are dropped and placed again, the playing one is
  re-placed at once past `MAP_NOW_MS` (8 ms). The listener's latency setting is the same path. It
  steps mid-track too, whenever a callback is late: so the guest reads the clock every 50 ms for the
  whole party, believes a move on the second agreeing reading (`MAP_AGREE`), stays usable right
  after it (a bridge back to "not ready" gave the re-place no clock, and it silently did nothing),
  and re-places at once rather than at the next tick. The host samples its own output clock ten
  times a second and restarts its line when that clock moves (`outputClockGeneration`): a median fit
  took 4.5 s to walk across a 21.6 ms step, and the guests followed the wrong line meanwhile.
- **The id is the capability**: 128 random bits, and it opens only what the host published
  (current + next + a few previous tracks, vetted as the HOST — a private upload the host may
  read, never anything else), their art (`cover_response(vetted=True)`) and their chunks. Guests
  never control anything; they see each other's names, never each other's listener ids (which
  authorise `leave`). One party per host; one TAB publishes (Web Locks); a restarted server is
  handled by the host re-creating the party under the same id (`resume`), so guests' links live on.
- **Measured on what the devices PLAY** (`webapp/test/party/run.mjs`: a real server with two click
  tracks, host and guest in separate Chromium contexts, a click detector on each one's OUTPUT, both
  mapped to the wall clock through their own output timestamps — comparing the two pages' own
  position figures, as the check below did, can only ever see whether they agree with each other):
  the guest is heard within **0.5 ms** of the host after a seek, a pause and a skip, and within the
  host's 2.5 ms republish threshold in between, FLAC or Opus chunks alike; the host's published line
  is where the host is heard to ±0.1 ms. What remains are audio dropouts: a guest whose own clock
  steps is re-placed within ~0.1 s; a step on the HOST moves the line, and a guest less than 30 ms
  off it waits for its next chunk seam (≤ 6 s) — the rule, since a seam is the one point it can
  correct at without a click. The bench lists every such click with the clock step behind it.
- Measured end to end earlier (Chromium, host and guest in separate contexts, real server, positions
  compared on the shared clock): joining ~0.4 s; |error| ≤ 0.6 ms steady, after a seek (back in
  sync in 0.3 s), after pause/resume and across a handover. Skips (to the announced next, any
  other, back, two in 250 ms), a 25 s rewind and a natural handover: the guest alone on the host's
  track 0.6–1.3 s after the click, |error| ≤ 0.5 ms, nothing else sounding. With the crossfade on,
  the host's element is wired into Web Audio and — measured in headless Chromium — its
  `currentTime` runs 373 ppm fast against both real time and the context clock (a direct element:
  −12 ppm); the host re-anchors every 2.5 ms of drift and guests sit 2–5 ms off between seams. Physical output latency is outside
  what some devices report — a Bluetooth speaker that does not tell the OS — which is what the
  *Décalage* setting (the device's `outputTrim`) is for. The page shows what the OS does report
  (`bridge.outputLag()`, "déjà compensée") and only offers the "Bluetooth (~150 ms)" shortcut when
  that is under 100 ms: a link the OS already counts would otherwise be counted twice.
  `window.__nsParty.host()` / `.guest()` expose those positions for exactly this check.

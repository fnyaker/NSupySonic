# Rhythm analyser: Rust on the audio thread, output clock, delivery

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching webapp/rhythm build, rhythm-assets.js, latency.js, engine.js delivery, lyric-line timing, or the look-ahead.

**Audio analysis is RUST, ON THE AUDIO THREAD** (`webapp/rhythm/`, compiled to
`src/lib/audio/rhythm.wasm`; `webapp/src/lib/audio/` is the delivery). The JavaScript engine read
two AnalyserNodes from the main thread on a clock that was meant to be an AudioWorklet but was loaded
from a blob: URL the server's CSP forbids — so in production it ran on requestAnimationFrame, sharing
the frame budget with the WebGL render, and every janky frame was a hole in the analysis (an
analyser only ever shows its latest window, so a kick that landed inside one was never seen). Now
`rhythm.worklet.js` runs the crate inside an AudioWorklet fed straight from the graph, and every hop
of 512 samples (~10.7 ms at 48 kHz) is analysed, in order, whatever the page is doing:

  `spectrum.rs` (the AnalyserNodes' two views, computed: a 2048-point FFT at the full rate and a
  512-point one of the signal decimated by 16) → `features.rs` (level, dynamics, SuperFlux, the kick
  witnesses, chroma, the melody) → `kick.rs` (candidates confirmed or refused two frames later) →
  `tempo.rs` (the period and the metrical level) → `beat.rs` (the grid, the bar, the phrase) →
  `pattern.rs` (main kick or roll, and the arrangement) → `style.rs` (the family, the archetypes, the
  look, the kick's shape) → `genre.rs` (the genre channel).

THE OUTPUT RUNS `LOOKAHEAD` FRAMES BEHIND THE ANALYSIS, which is what lets a kick be confirmed after
its attack and still be published ON the frame it landed on, and a drop be checked against the level
of the frames after it. `engine.js` no longer analyses anything: it holds each frame until its audio
reaches the listener (the output clock of `lib/audio/latency.js`, look-ahead and trim included, a
timer set for the frame next due), decodes it by the layout the binary publishes (`rhythm_layout`,
name:length pairs — neither side hard-codes a slot), and re-expresses the beat grid at that instant
(`projectBeat`). It is still ONE engine, shared and refcounted: every view
reads the same frame object by reference, and it runs at the shallowest level any live subscriber
needs (spectrum / rhythm / smart). Nothing allocates after `rhythm_init`. Measured against the
JavaScript chain it replaced, on 28 arranged records with ground truth (`test/eval/`): beats
F-measure at 35 ms **79 → 93** cold, kick precision **46% → 82%**, drops found on every EDM record
but trap (mostly 0 of 2 before), a half-tempo seed turned into the right tempo **17% → 88%** of the
time; end to end in headless Chromium (`test/rhythm/run.mjs`) kicks land within 5 ms, beats within
0.5 ms, frames are handed out 1 ms from their audio.

**WHEN THE LISTENER HEARS IT is one model, `lib/audio/latency.js`**, shared by the animations, the
lyric line and the listen party so the three agree. Three delays: the OUTPUT PATH, as the OS reports
it through `getOutputTimestamp()` (it carries the device buffer, the mixer, and a Bluetooth link on
the platforms that account for one — Chromium on Android reads it from AAudio); the GRAPH's own
delays (the analysis look-ahead, the two compressors); and what NO API reports — a Bluetooth speaker
that does not tell the OS, a TV, an AV receiver — which is the one number a person sets, per device:
`outputTrim` (Réglages → Animations → *Décalage de la sortie*, and the party page's *Décalage*: the
same setting, carried over from the party's old `party.latency`). Everything in it was measured in
headless Chromium, and three of its rules replaced something measurably wrong:

- **Only a NEW timestamp is a reading.** It moves once per render callback (~48 a second at
  latencyHint "playback") while the engine asks two or three times per callback; the engine used to
  fill its median from the attributes whenever the timestamp repeated — 73% of its samples, jittering
  ±10 ms against a mapping good to ±0.1 ms. Where there is no timestamp at all the context sits
  between `outputLatency` and `outputLatency + baseLatency` ahead of the listener (a render burst at
  a time: 70.7..91.1 ms measured, for 72 + 23.2), so the fallback is **output + base/2**
  (`reportedLag`); `outputLatency || baseLatency` was 8.8 ms off that and the sum 14.4 ms the other way.
- **The median is recomputed by COUNT, not by `length % 3`**: the buffer stops growing at 25, and the
  engine's median froze for good the moment it filled — a mapping that then stepped or drifted was
  never followed (a 23 ms step measured: every frame after it was handed out 23 ms early).
- **A move is believed on the second reading that agrees** (within 1 ms, 4 ms or more from the
  mapping), learnt from those two at once and usable at once (`need` drops to 2): Chromium steps
  its mapping by a whole render burst when a callback is late, and every reading spent doubting it is
  audio placed on the wrong mapping. `outputClockGeneration()` tells anything fitted against the old
  mapping (the party host's line) to start again.

**The lyric line changes when it is heard** (`lib/lyrics.js#activeLyricIndex`): it followed the player
store, written on `timeupdate` four times a second, so every line changed 0-250 ms late — and a fifth
of a second EARLY with a Bluetooth headset once the graph was wired. It now reads the playing element
itself, subtracts what the element is heard behind (the trim; the whole graph when wired) and sets one
timer for the next line: nothing ticks in between, so eco mode has nothing to stop.

**Delivery is on a timer and the look-ahead is automatic.** A held frame used to wait for the next
worklet message or animation frame: delivery was p95 **12.3 ms late** against the browser's own output
clock, and is now **−0.8..+0.2 ms** (p05..p95). The look-ahead (`vizLookaheadMode`, "auto" by default;
a value someone had set by hand is kept as "manual") is a closed loop in `engine.js#tuneLookahead`: it
measures how early each frame reaches the page against the moment its audio is heard, and holds the
5th percentile at the timer's slack (`latency.js#lookaheadStep`), raising on a shortfall and giving
back only a clear surplus. A DelayNode that moves resamples what is in it, so an automatic change is
a linear ramp at **0.3% of speed** (five cents; a 30 ms correction takes ten seconds) — by hand it is
still a quarter of a second, since the listener asked. The learnt value is remembered per device and a
graph built before anything plays starts on it; one built under a playing track starts at zero and
glides (switched in full, the delay line would be that many ms of silence). Measured with a simulated
60 ms shorter output path (`--trim -60`): it settles on 33 ms, and the last 8 s are p50 −0.2 ms,
p95 +0.1 ms, every frame on time. On a device whose output latency already covers the ~45 ms the
analysis needs (headless Chromium: 81 ms), it adds nothing at all.

How it is built and shipped — each part of this is load-bearing:

- **Two binaries**, baseline and SIMD128 (`rhythm-simd.wasm`), from `npm run wasm`
  (`rhythm/build.mjs`); `rhythm-assets.js` picks SIMD when the engine validates a one-instruction
  probe. Both are **committed** so a checkout builds without a Rust toolchain, and the Docker image
  compiles the crate in a stage of its own. `build.rs` hashes `src/*.rs` (FLAT — a module in a
  subdirectory would escape it) into `rhythm_src_hash`, and `test/rhythm.test.mjs` fails when the
  committed binary was not built from the sources beside it, and when the SIMD build does not compute
  the same frames as the baseline. After touching the crate: `npm run wasm`, commit both.
- **The compiled module is fetched and compiled ONCE** (`rhythm-assets.js#rhythmBinary`) and
  instantiated twice: in the worklet for the analysis, and on the page for the animations' core (see
  *The animations' CPU side is Rust too* below).
- **`f32::max` / `f32::min` are LIBRARY CALLS on wasm32.** Rust promises the non-NaN operand wins and
  wasm's `f32.max` propagates the NaN, so every call compiles to a call into a libm routine. The crate
  had 150 of them, some inside per-bin and per-column loops. `util::MinMax` (`.fmax` / `.fmin`) keeps
  the exact semantics with comparisons, one instruction each: the analyser went from 107.5 to 93.2 µs
  a frame with the eval identical to the bit. **Never write `f32::max`/`min` in this crate**, and
  mind `round()` for the same reason (floor-based rounding where it runs per frame).
- `graph.js` is the Web Audio graph (moved from the old `lib/visualizer.js`). Its normalization gain
  is **per source, not shared**: a crossfade has two tracks audible at once, each with its own
  ReplayGain, and one shared node could only ever be right for one of them. A separate fade gain
  sits after it so the two envelopes are scheduled independently.
- `spectrum.js` keeps the band plan the spectra are read through — the low end from the fine FFT,
  the rest from the coarse one, blended across 300-600 Hz, **interpolated between bins** where a log
  band is narrower than one (a single 512-point FFT is a 93 Hz bin, which is why every bar below
  ~400 Hz once drew as flat groups of identical bars) — and `style.js` keeps the TABLES: the family
  list and each family's look, `tempoRangeFor`, `familyLook`, `LOOK_KEYS`. The classifier that reads
  them is `style.rs`, loaded with `familyTable()` at start (`rhythm_load_families`).

The rules below were each measured on the JavaScript chain and ported rule for rule; the file names
are the Rust ones.

# Live audio analysis (Rust rhythm crate)

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).

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
  *The animations' CPU side is Rust too* in [animations.md](animations.md)).
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

**`features.rs` — three rules, each of which replaced something measurably wrong:**

- The onset function is **SuperFlux** (Böck & Widmer, DAFx-13): log magnitude, differenced against
  a version of the frame ~20 ms back that has been **maximum-filtered across three bins**. A
  partial that merely drifted is covered by its own neighbour's maximum and contributes nothing;
  energy appearing where there was none still does. Plain flux fired on every vibrato and every
  tremolo pad — measured, a sustained chord with no attack anywhere in it produced `midFlux` of
  **0.987 out of 1**. It now produces 0.000. The lookback is indexed by TIME, not by frame count,
  because this engine's clock is not guaranteed regular, and consecutive frames of a 2048-sample
  window overlap almost entirely (their difference is window smear, not music).
- **Level is information.** Adaptive whitening divided every bin by its own running maximum, which
  makes a whisper and a wall of sound produce the same numbers *by design* — right for a beat
  tracker, wrong for an animation asked to be calm when the music is calm. `dynamics` is this
  moment against `loudRef` (the track's own loud level: up in 0.4 s, down over 25 s), and
  **everything a scene draws is multiplied by it** while the tracker keeps the ungated signal, so
  the grid survives a breakdown even when the animation settles. Measured on identical material 12
  dB down, the old extractor read the same kick strength (0.365 against 0.355); it now reads 0.122.
  End to end, a −20 dB breakdown used to render **1.23× brighter than the drop** and now renders
  0.60×.
- **There is a melody in there too.** One exponential average per bin splits what PERSISTS (a held
  note, a pad, a voice) from what APPEARS (a drum), and the persistent half carries `chroma`,
  `melody`, `melodyPitch`, `melodyFlux` and `chordChange`. The chroma counts how far a bin stands
  above the third of an octave around it — a prefix sum makes each window O(1) — and divides by
  how many bins land on each pitch class: an FFT is linear and pitch is logarithmic, so raw energy
  gave flat noise a strongly peaked chroma and it read as a clear melody, exactly backwards.

**THE KICK IS FOUR WITNESSES, AND NONE OF THEM IS THE LEVEL.** The detector used to ratio two
envelopes of the 25-180 Hz band — a 3 ms attack against a 90 ms release — and it failed on exactly
the music this player exists for. Measured through the full chain on synthesised hardcore (audio →
features → tempo, pinned by `test/synth.mjs` + `test/rhythm.test.mjs`): techno **1.94
detections per kick**, frenchcore **2.08**, uptempo **0.40 — sixty per cent missed**, and
frenchcore under a screech **3.74**. Two assumptions produced all four:

- *It assumed the kick is in the kick band when it lands.* A hardcore, frenchcore or uptempo kick is
  a pitched sine driven into a distortion chain; it **starts at 190-260 Hz** and sweeps down over
  the next fifty milliseconds. Measured, the 25-180 Hz band is 4-6 dB **down** at the attack and
  does not peak until a fifth of a beat later, by which time it is indistinguishable from the
  previous kick's tail. That is the sixty per cent.
- *It assumed the level means something.* These masters are limitered flat, so when a transient
  arrives the limiter pulls the whole mix down to hold the ceiling and the loudest moment in the
  music reads as a **drop** in every band at once.

So nothing in it is a level. Four witnesses, each a step over the same 26 ms lag, each scale-free:
**lift** (the 28-420 Hz region's energy step in dB — the whole story for a techno kick in a quiet
bar, near useless under a limiter), **pitch** (that region's centroid stepping UP, in octaves — the
fundamental restarting high, the one thing a tail cannot counterfeit because a tail always sweeps
DOWN), **click** (the beater band's step), and **sub** (the bottom two octaves, which is the only
witness a pure 808 with no beater and no pitch movement brings). A kick is the best-supported
COMBINATION: **two witnesses are required**, and one alone is capped below the trigger — a hi-hat
can be several times louder than any kick in the track and used to clip its way over the threshold
on the click alone.

**Something must have STRUCK, and it must have struck LOW.** Those are the two halves of the
decision, and which witness may answer each is not interchangeable. *Struck* is **the beater and
only the beater**: a bass note swelling back between kicks moves the region's pitch (0.88, because
it is higher than the last kick's tail) and would convict itself on that alone, while its beater
witness reads 0.14 — a note that fades in has no transient to put up there. *Low* is either energy
arriving at the bottom (`lift` or `sub` over 0.8) or, when there is no room left down there,
**the fundamental restarting high with that beater on it**, which is what a kick over its own
predecessor's tail looks like. The exception is the kick with no beater at all — an 808, a sine
bass drum — which convicts on the sub alone, at a bar set far above what a pad's own wobble reaches.

**A CENTROID MEASURED ON AN EMPTY REGION IS NOT A MEASUREMENT**, and that is what convicted a
hi-hat. The other three witnesses are STEPS in decibels: they measure themselves and read zero when
nothing is there. The pitch witness is a SHAPE, and the shape of the noise floor is noise — it
wanders by a third of an octave a frame, which normalises into a witness of 0.61 on a techno track
whose kicks (their centroid moves DOWN as the bottom fills) never produce one at all. Measured,
techno with hats on every offbeat fired **2.00 per kick**, the extra one on the hat — which is
4-16 kHz noise with a 24 dB/octave skirt and puts *nothing* in the kick region: at the offbeat that
region sat **56 dB** below where this track's kicks put it. Every true kick that relies on the
restart path sits within **15 dB** of its own track's region level, so the witness is faded out
between 20 and 36 dB down, and the hat reads 1.00 per kick at any hat level.

**The region is read PER OCTAVE, not per bin.** It spans nearly four octaves (28-420 Hz) and an FFT
is linear, so a plain mean over its bins gave 210-420 Hz half the vote and 28-56 Hz a twenty-eighth
— the top of the region, where a kick barely lives, outweighing the bottom, where it does. Measured,
a correctly low-cut 700 Hz hoover whose only residue is the part sitting above the corner moved the
plain mean by 15 dB on a bar with no kick in it.

**And every adaptive scale has a floor set from the smallest step a real kick makes.** They were set
low and it showed on the one material with nothing to divide by: an ambient pad of three detuned
saws, whose partials beat against each other several times a second, so the bottom two octaves
wobble by 4.6 dB and the beater band by 2.1 — which, against floors of 4.5 and 4, read as a full sub
witness (1.02) and half a beater (0.52) and held `kick` at its cap for the whole track. A real
beater step measured 5.7 dB at the very least and 15-30 dB everywhere else.

The limiter is removed as a **common mode**: the median of eight octave bands'
steps, believed only when the bands agree to within 5 dB, because a gain change moves every band by
the same number of decibels and no instrument does. And the gate is a **Schmitt trigger**, not a
refractory window: a 300 ms hardcore tail and a 60 ms roll sit on the same side of any fixed window,
so the evidence has to fall back through a release level before another attack counts. Each witness
scales against a **slowly-rising, slowly-falling** estimate of what this track's kicks weigh, never
a running maximum — a roll's notes are shortened to fit their subdivision, so they step further than
the ordinary kicks, and with a maximum one bar of sixteenths raised the bar for the whole phrase and
took uptempo from 1.00 back down to 0.27. All of it now reads **1.00-1.01 per kick at 9-17 ms
latency** across sixteen records of real audio from trap to speedcore, with `pattern.mainKick`
scoring 97-100% precision on them.

Three more faults were found by porting the tests onto the shipped binary, and fixed at the source:
a passage played 6 dB quieter lost 25 of its 26 kicks FOR GOOD, because only an accepted kick moved
the level reference — a refused candidate with an unmistakable beater now walks it down (26/26 at
−6 dB); the kick's SHAPE (soft / hard / industrial) was never measured at all, its thresholds three
orders of magnitude above the ratio computed, so every weight sat at a third — it is now read from
each kick's own pitch sweep and the noise of its body (frenchcore hard 0.83, uptempo industrial 0.79,
techno soft 1.00); and the style look jumped 0.22 in one frame while an opinion formed — it now eases
(worst step 0.003).

**A BUZZ IS A ROLL.** Frenchcore builds end on a bar of thirty-second-note kicks, 37.5 ms apart — a
27 Hz buzz, under the 42 ms refractory that stops one kick counting twice, so the climax of the build
read as silence: no kicks and no roll. `kick.rs` recognises a buzz as a regular train of pitch
restarts closer than 50 ms, and holds it while the bottom stays full and no kick has come (a louder
note folds the restart into its first cycle); `pattern.rs` reads it as the densest roll. Roll
coverage of the buzz notes went from 16% to 91%, with kick precision, recall, main kicks, tempo and
drops unchanged.

**The limit it does have is stated rather than papered over.** A lead whose residue lands inside the
kick's region, restarting high with an attack on it, is numerically identical to a kick over a
saturated low end — a 320 Hz stab reads `lift 0.23, pitch 1.00, click 0.95, sub 0.00` and an uptempo
kick on a full bottom reads `0.23, 1.39, 0.95, 0.00`. Every attempt to separate them on one frame's
evidence cost real kicks (a sub veto took uptempo from 1.00 to 0.72). It is separated one layer up,
where the GRID is known: `features.kickHit` is a percussive-attack detector, `pattern.mainKick` is
the kick answer, and on that exact case it scores **F1 0.99**.

`tempo.rs` is a spectral-flux onset function on a fixed 100 Hz grid, an autocorrelation summed over
harmonics, and a phase-locked loop (`beat.rs`). Once locked, beats are **predicted**, not detected,
so a scene lands on the beat instead of a detector's latency after it.

**The reading has to be ONE number.** A tempo that walks off to a harmonic and back — 120, then 250,
then 120 — is worse than no tempo at all: everything downstream (the animation's grid, the
classifier's `tempoTrust`, the label in the header) re-times with it. Six things keep it still, and
each of them was measured against a tracker that did not have it. The generators the JavaScript
tracker was tuned on scheduled onsets on a timeline and rendered them into frames (asking "is
this frame near a beat" silently drops events above ~180 BPM, and a tracker fed a train with holes
in it is being tested against nothing); across a 70→250 BPM sweep of busy material the old tracker
got 54 of 74 cases exactly right with 381 tempo jumps between them, this one gets 72 with 1:

- the ODF is **conditioned** before anything reads it. A local mean (~120 ms) is subtracted and the
  rest half-wave rectified, which removes a riser, a filter sweep or a reverb wash — all of them
  raise the flux *continuously*, and a continuous rise is not a beat. What is left is expressed in
  units of the track's own average onset and **clipped**, so one enormous FX stab is worth about one
  and a quarter kicks in an eight-second window instead of twenty. The clip is deliberately far
  above an ordinary onset (25×): flattening a kick and a hi-hat onto the same value is its own way
  of losing the tempo.
- the autocorrelation runs on a **bass-weighted** mix, because every genre this player is pointed at
  puts its beat there and the treble is where the effects and the offbeat hats live;
- the harmonic-summed correlation is **averaged over time** (a running tempogram, ~2 s of estimates
  over an 8 s window). One estimate is a snapshot an FX bar can dominate; the average cannot be
  moved by one bar of anything;
- a shortlist of candidates is then scored on how well the ODF actually **folds onto each one's
  grid**, normalised by what a window that size would catch from noise — autocorrelation cannot tell
  a tempo from twice that tempo, and a half-empty grid can;
- the octave is arbitrated by **two witnesses, and the second one has a veto**. The fold asks a
  local question (is there anything at the halfway point, in the bass or across the band) and is
  fooled whenever one beat of the bar is simply louder than the others — measured on uptempo with
  rolls on the last beat of every other bar, it voted steadily to halve a perfectly correct 240 BPM
  grid. So `levelScore` asks the global one: does the music actually **fit** that level better, on
  the same terms every candidate is judged by. The fold PROPOSES and the score DISPOSES — a fold
  vote toward a level the score says is measurably worse is suppressed outright, while the score
  can move the grid on its own. Within the fold the old asymmetry stands: to go *faster* only the
  bass may answer (an offbeat hi-hat is not a beat); to go *slower* the whole band is asked, or a
  140 BPM track with a kick every other beat reports 70;
- nothing moves the grid without **persistence**: a candidate that is neither the current tempo nor
  an octave of it must win five consecutive estimates, and the incumbent carries a bonus.
- **the local mean's window is longer than a beat**, which a fixed 120 ms is not above ~200 BPM. At
  240 the beat is 250 ms, so the mean tracked the beat and subtracted most of it: measured, the
  running tempogram at the TRUE lag fell from 0.364 to 0.084 as the estimators converged, confidence
  fell with it, and the grid unlocked after ten seconds and re-locked a quarter of the tempo away —
  with the winner having been correct on every single estimate. It now scales with the grid
  (`MEAN_BEATS`), still far shorter than the risers and reverb washes it exists to remove;
- and **two candidates four grid slots apart are the same peak**. A 6% log distance is four whole
  slots at 120 BPM and barely one and a half at 240, so up there the shoulder of a peak was
  shortlisted as a rival to the peak itself. That never changed which tempo won, but it collapsed
  the confidence margin — and confidence under the floor is what UNLOCKS the grid.
- and **the drums' own pulse has a vote.** Techno with a rolling offbeat bass ran at DOUBLE tempo
  when nothing was served: the kick and the rumble alternate, every onset lands on an eighth-note
  grid, and both the fold and the level score prefer 264 BPM to 132. The kick detector already knew
  better — it finds every kick and never one on the offbeat — so `tempo.rs` keeps the confirmed kicks
  and snares (`note_hit`), merges hits that land together, and counts a hit that SPLITS an interval as
  one stray rather than two faster intervals. When they form a steady pulse inside the plausible
  range, that pulse votes down a grid twice as fast as itself and refuses any move faster than
  itself. Snares count because a kick-snare groove is one beat per hit; the range bound keeps a
  half-time groove from dragging 140 down to 70. Techno cold went from 67% to 100% tempo (F70 0.83 →
  0.96) and nothing else moved in any of the eval's four scenarios.

**THE SERVER'S ANSWERS ARE LOCKED** (`engine.js#adoptVerdict`). The genre and the tempo are measured
over the whole file on the server, its octave reconciled against Deezer's; an analyser deciding them
again from eight seconds of audio could only disagree by being wrong. So a served genre PINS the
family (`style.rs` `pinned`: its rules stop voting; look, archetype, band and bar model are the served
genre's) and a measured tempo LOCKS the grid (`tempo.rs` `fixed_bpm`: never re-estimated; the grid may
absorb a rounded figure's 0.3% and no more, `beat.rs` `fixed_period`). What stays this side's is what
the music is DOING, read with the genre's own **profile** (`style.js#profileOf` → `pattern.rs`): a song
form needs four bars without the kick before a return is a DROP (its returns still anchor the phrase),
and a genre with no drum kit publishes no kick (the bar model still reads those onsets). And whether a
beat is THERE at all: the confidence of a locked grid follows how well the music folds onto it
(`FIXED_GQ_NONE`/`FULL`, measured beatless 0.12-0.19 against beat records' medians 0.30-0.87), and once
heard it coasts through a lull. The eval's `served` scenario against `seeded`: F70/F35 95/94 →
94/94, false drops on the song-form records 10 → 0, kick precision 83 → 87%, main kicks 86 → 90%,
the ambient record locked 90% → 3% of the time. A PROVISIONAL tempo (Deezer's, before the file
exists) is not locked: it seeds, below, and the tracker may still double it.

**THE SERVED TEMPO IS AN ANCHOR, NOT A HINT.** Somebody measured the whole track; an eight-second
window deciding it disagrees is the single most common way this tracker was wrong, and the user's
report of it was exact: *"it tries to overwrite the tempo the server sent it with nothing"*. Three
things were wrong and all three are fixed:

- **the seed was only applied to an UNLOCKED tracker**, which in practice meant almost never. The
  verdict comes over the network, behind the audio in the request ladder, so by the time it lands
  the grid has been locked for seconds — on three seconds of whatever the intro happened to be.
  Measured on uptempo with the kick on the offbeat: seeded at t=0 it read 220 BPM, seeded at t=4 s
  it read 110, for the whole track. `seed()` now works at any time; on the seed's level or one or
  two octaves off it, the level moves and **the phase is kept** (the beats do not shift, only their
  name), so a late seed cannot make the animation jump.
- **the seed anchors the OCTAVE, not the tempo.** `levelPrior` — a narrow bell over a floor, used by
  everything octave-related — all but settles which metrical level the grid runs at, and `octBar`
  puts a move AWAY from it beyond the vote's reach. But `weightFor`, which picks the winner among
  candidates, uses the ordinary prior: which tempo it is is not ambiguous in the signal, and a
  served figure that is simply wrong (117 on a 175 BPM track) has to be overruled by the music.
  Putting the seed in both made a wrong figure unbeatable, which is the opposite failure and just as
  bad. A seed the music contradicts at full strength for twenty seconds has its own level moved
  (`seedDoubt`), so a tempo published at half its real value is corrected by the track rather than
  by one window of it.
- **a whole-track measurement is a reason to stay locked.** There is material whose autocorrelation
  at its own beat is genuinely poor for eight seconds at a time — rolls, a half-time passage, a bar
  of one held note — and a grid sitting exactly on the server's figure used to lose confidence
  estimate by estimate until it fell through the floor and re-locked somewhere else. While the grid
  agrees with the seed, the seed floors the confidence.

**KNOWING THE GENRE IS WHAT SETTLES THE OCTAVE, and nothing else can.** A 250 BPM uptempo track and
a 125 BPM house track produce the same autocorrelation, at the same lags, in the same proportions;
no amount of signal processing separates them. What separates them is knowing which record is
playing, which the engine does know — the server measured the track, or the live classifier named a
family. `style.js#tempoRangeFor` is that knowledge written down (frenchcore 170-230, uptempo
170-260, hardtekk 140-180, hardstyle 140-165, dnb 160-180…), `rhythm_set_range` moves the
prior's plateau to it, and `engine.js#applyTempoRange` feeds it in from the verdict (the live
classifier that used to stand in is off in the player). The ranges are deliberately WIDE: they set a
plateau, not a target, and all they are for is making the octave either side implausible. **A
missing row is not a bug** — the tracker falls back to the default 90-200 plateau. This is the
published result on tempo octave errors in electronic music, and it is the one table in the audio
code an operator might reasonably want to extend.

**And a breakdown is not a tempo change.** With no drums in it the last seconds carry no onsets and
the autocorrelation is reading a pad; the estimate is skipped entirely (both going into the quiet
part and coming out of it, which is the window that is three-quarters empty) and the grid coasts on
what the music had before. That alone is where "128 BPM, then 64, then 255" came from. And the
breakdown is not always QUIET: pads, a lead and a vocal at full level carry onsets, so the pattern
layer's own reading — a breakdown (the kick out for a bar) or a build following the groove — HOLDS
the locked tempo too (`tempo.rs#hold`, from `lib.rs`), without losing confidence. Measured on the
arranged techno record, the grid left 132 for 170 at the end of the breakdown and rode the build's
roll there for seven seconds; seeded and genre-known techno went from 97/96% right to 100%. Only
after 4 s of groove has been heard: an intro with the kick out reads as either, and holding there
held whatever octave the grid had opened on. The cost is stated: dubstep's half-time drop halves the
grid (a pre-existing error), and a breakdown's melody no longer undoes it by chance — cold dubstep
50% right to 22% (seeded, 100%).

Two older details are still there for the same reasons they always were: the ODF is smoothed
(~20 ms) before the autocorrelation, or a period that is not a whole number of grid slots (174 BPM
is 34.5) loses half its correlation to its own double; and every candidate is divided by the
**same** harmonic weight, or slow candidates get a free pass because their harmonics fall off the
end of the search range. `webapp/test/rhythm.test.mjs` pins all of it on the shipped binary
(`npm test`; no test framework to install, though `npm install` must have run —
`test/preflight.mjs` says that in one line rather than letting node abort five files and report them
as five DSP failures, which is a trap that has already cost one debugging session).

**`pattern.rs` — the MUSICAL reading, above the per-frame one.** `features.rs` says "a kick landed
and it was this hard"; `tempo.rs` says "the grid is here"; neither answers the questions an
animation wants to ask. At 200 BPM a frenchcore roll fires five hits inside one beat, so a scene
that throws something on every `kickHit` is a strobe — the user's words: *the blocks should fall on
the drop and on the main kicks, so there has to be a way of telling them apart*. It publishes
`mainKick` (on the grid, outside a roll) with `mainPower` and `bigKick`, `rollKick` with `roll` and
`rollDiv` (the subdivision, 2/3/4/6/8/12/16 — a triplet fill and a sixteenth run are different
pictures), and the arrangement: `drop` (the frame the music comes back after being out long enough
to be missed), `dropped`, `build`, `breakdown` and `energy`. It is O(1) per frame, allocates
nothing, and is read through `m.mainKick` / `m.roll` / `m.drop` in `lib/viz/musical.js` like
everything else. Its four events cross the projector channel **latched**, for the same reason every
other event does.

`style.rs` reads the kick's shape (attack, decay, click, grit → soft / hard / industrial) and a
smoothed family vector (techno, hardtekk, zaag, frenchcore, uptempo, pieep, krach, rock, metal,
strings, vocal…). It publishes TWO things for two jobs: the family, which is legible and is what the
UI shows, and a five-way **archetype** mix (sustain / voice / groove / hard / rock), which is what
the renderer blends on — animations can interpolate between five archetypes, not between eighteen
genre names, and a scene that re-drew itself every time the classifier changed its mind between two
neighbouring hardcore subgenres would be unwatchable. Nothing hard-switches: both outputs are
weights, smoothed over seconds, and the dominant family changes with hysteresis.

Five archetypes are enough to blend between and nowhere near enough to tell hardtekk from
frenchcore, so there is a THIRD output: **`look`, seven numbers** (`LOOK_KEYS`: motion, density,
punch, smooth, warm, melodic, chaos) blended by the same family weights. It is deliberately not a
name — a name cannot be interpolated — and every family starts from its archetype's look and
overrides only what it actually differs on, so a new family costs one line. The GL engine carries it
to every world (`uLookA` / `uLookB` in the Music block) — the hard worlds read it to tell neighbours
apart (`chaos` widens `shatter`'s cracks, `melodic` decides how much of `forge`'s anthem ribbon is
drawn) — and `palette.js` leans the chosen hue a third of the way toward red or cyan on
`warm`, never replacing the source the user picked. A **served** verdict names a family, so
`style.familyLook(id)` turns that name back into the seven numbers and `engine.merged` carries
them: without it the look vector was dropped exactly when the server had measured the track, and a
track that had been analysed lost every genre-specific layer while an unmeasured one kept them.

**A quiet passage is not a different genre.** A breakdown has no drums, no pulse and no grit, so
every measurement says "ambient" and the whole look of a hardcore track would change halfway
through and change back at the drop. The classifier's adaptation rate is therefore scaled by
`dynamics²`: at half level it only slows a little, at a twentieth it all but freezes and holds what
it knows until there is something to form an opinion from.

**THE CLASSIFIER READS HOW THE MUSIC IS BUILT, NOT ONLY WHAT IT AVERAGES TO** (`style.rs` F_KF0..F_FOUR,
`style.js` `RULE_FEATURES`). It named about six of the eval's 26 records right: uptempo and speedcore
were "electronic", Krach frenchcore, the piep record hardcore. Two causes. Its rules had never been
measured against the descriptors they read: the spectral crest reads 12-18 on every record there is
and five families asked for "below 3.2" (so krach, rawstyle, speedcore, industrial and metal could
NEVER be named); the band shares were per-bin means summed, 0.9 of sub and 0.00 of air on everything
(now power shares, as genre.rs learnt). And timbre averages cannot tell apart genres that are made
differently and mastered alike — a limitered uptempo drop and a limitered Krach drop are equally flat.
So it also reads what the music is MADE of: where the kick's pitch starts, the PIEP (below), how long
the kick rings, the lead, the saw buzz, screeches, the offbeat share, onsets per beat, how much of the
time a roll runs, and FOUR ON THE FLOOR — the share of beats with a main kick while the groove is in
(the grid's `kickPulse` read 0.64 on techno's rumble, inside the window written for broken beats; a
breakdown or a build's snare roll is not a broken beat, so those beats do not count). The crest's
slot is a loudness-range proxy now, used by no rule: on material all mastered alike it measures the
arrangement. Measured with `test/eval/family-eval.mjs`: **19 of 28**, every hard-dance record named by
its own family (hardstyle, rawstyle, frenchcore, uptempo, zaag, Krach, pieep, speedcore; gabber as
hardcore), techno, house, trance, psytrance, dnb. What it still misses is mostly a record whose tempo
the tracker reads an octave off (dubstep, trap, reggae) — no tempo-banded rule can name that — and
rock, metal and the solo pianos. Two rules protect the tempo from it, since a live family narrows the
tracker's range and its own rule reads the tracker's BPM:

- **A share is only as good as what it is a share of.** Where nothing fits (the grid on the wrong
  octave), every family reads next to nothing and normalising hands the whole of it to whichever
  reads least nothing: speedcore at 0.03 on techno's kick-only intro, grid at 264, confident, range
  set, techno held at 264 for a minute. The weights now move only as fast as there is evidence
  (the specific families' summed rule weight, `EVIDENCE_FULL`; the catch-all is none) and the
  confidence is capped by it.
- **A live range waits for the kicks to have been measured** (`LIVE_RANGE_KICKS`): until then the
  kick-shape weights are neutral thirds and every hard family reads a third of a hard kick. The
  catch-all has no tempo row at all.

Krach and pieep were written on false premises and are rewritten from how they are made. **Deutscher
Krach** (named 2023 by Noiseflow) is uptempo's kick past 200 BPM under a euphoric, hardstyle-leaning
lead and sung German hooks — a party; it was written as a melody-less noise wall, look included.
**Pieep** is tekk built on the PIEP KICK (it was "squeaky high leads", read on the air share that
could not even measure it). `test/songs.mjs` has both as records (`krach-205`, a tuned kick whose
tail plays the bassline; `pieep-170`), and the old "krach-210" — which was dark uptempo — is
`uptempo-dark-210`.

**EACH GENRE'S BAR IS READ ITS OWN WAY** (`beat.rs` `DOWN_MODELS`, chosen by the genre's groove,
`style.js` `GROOVES` / `grooveOf`). Where the bar starts drives every bar- and phrase-level motion,
and one set of cues for every genre read it at chance — 29% F-measure on the eval — because the cues
are not the same cues. A kick on every beat (techno, house, every hard family) says nothing about
the bar; the backbeat clap that does lands ON a kick, where the snare detector (which waits for a
strike with no kick near it) never sees it, so four-on-the-floor reads the mid band's attack beat by
beat against its neighbours (`KIND_MID`, bar evidence only — it never weighs on the beat's phase).
Hard dance closes its bars and phrases on a ROLL, so the beat after one is a downbeat
(`KIND_ROLL`); a broken beat and a live kit keep the kick on one and the snare on two and four. The
model is the served genre's when that genre is believed (the same test as its tempo range), else the
live one's once it sets the range, else the generic one. Measured: uptempo 59% to 99%, Krach 24%
to 69% cold, dark uptempo 8% to 37%, techno 31% to 43% (seeded 45% to 57%), house with its genre
known 6% to 38%; the whole eval 31% to 33% cold, 29% to 31% seeded, 25% to 30% with the genre known.
The clap cue speaks less in hard dance, where the lead's note attacks land in the mid band too
(frenchcore 98% generic, 87% at four-on-the-floor's weight, 93% at its own). What it cannot do yet:
an offbeat bass (pieep's tekk bass, techno's rumble) moves the harmonic change half a beat after the
downbeat, and pieep's bar still reads 5-11%.

**THE PIEP** (`features.rs#piep`, `style.rs` `KickShape::piep`, `kickPiep` in the frame): a pitched
squeak layered on the kick's attack. Four things together, each of which something else in a mix has
on its own: a line in 1.4-5 kHz standing above everything in the half octave beneath it (a distorted
kick's harmonics FALL with frequency, so on a plain kick nothing does), loud enough to hear next to
the body, BORN with the kick (not there three frames before — a lead note that merely changed was)
and GONE 64 ms later (a lead note that started on the kick is still sounding: on frenchcore's dense
lead the first two alone were true of 863 frames against 70 kicks). Read only on the frames just
after the onset — the kick's own window is the previous beat, where an upward-bending screech's last
partials die exactly like a squeak. Measured as a share of kicks: the piep kick 1.00 at 1.5-3.6 kHz,
falling or not, 0.46 at half level; every other kick 0.00-0.02, and every other arranged record 0.17
at most.

**THE GENRE CHANNEL** (`genre.rs`) is what the look vector cannot say: what only SOME genres are made
of, eight numbers 0..1 — the sung `lead`, the `buzz` (a saw stack, a kick distorted until it is a
tone: zaag, Deutscher Krach), `screech` attacks, the `sub`'s share of the power, the `offbeat`'s
share of the groove, onsets per beat (`density`), how long the kick rings (`tail`) and how noisy it
is (`grit`). Without it zaag and krach got exactly techno's reading. It crosses the projector
channel, is eased over a beat into `m.genre`, and reaches every shader as `uGenre[2]`.

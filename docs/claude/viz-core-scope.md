# Animations: registry, Rust CPU side, the oscilloscope

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching lib/viz/ modes, viz*.rs, musical.js, the scope world/scene, scope settings or raw-wave subscription.

**Animations** (`webapp/src/lib/viz/`): a mode registry (`off`, `bars`, `pulse`, `scope`, `aurora`,
`smart` — `modes.js`), a palette whose SOURCE the user picks (cover art / the spectrum itself / fixed
schemes), and quality tiers that `auto`-resolve from the device. Two kinds of scene come out of
`lib/viz/index.js`, and the host has to know which: **`gl`** — EVERY mode is the WebGL2 engine
(`scenes/gl.js`) with a policy for which WORLD it shows (`pulse`, `aurora`, `bars` and `scope` are
one fixed world each — `pulse`, `aurora`, `spectrum` and the `scope` instrument — and `smart` lets
the genre choose among all 50) — and **`2d`**, what a device with no WebGL2 gets instead
(`createFallback`): `scenes/scope.js`, the oscilloscope on a canvas, for the scope mode, and
`scenes/bars.js`, the spectrum on a canvas, for every other. `Visualizer.svelte` therefore owns TWO canvases and shows the one the
scene's `kind` asks for: a canvas has one context type for its whole life. `scene.update()` runs on
every analysis frame (~94 Hz, so a beat is never missed) and `scene.draw()` on rAF under the user's
frame cap — the two rates are separate on purpose. Réglages → Animations configures all of it around
a live preview (sticky, so it stays in view while the controls under it are moving it) and a readout
of what the engine currently believes, down to the world it chose.

**THE ANIMATIONS' CPU SIDE IS RUST TOO** (`webapp/rhythm/src/viz*.rs`, reached through
`lib/viz/core.js`). The PIXELS stay on the GPU, in the worlds' GLSL — a browser runs no other
language there, and drawing them on the CPU in any language would be tens of times slower. What the
CPU does for them is in the same crate as the analyser, instantiated a second time on the page from
the module the worklet already compiled (`loadVizCore` → `rhythmBinary`): no second download, no
second compile, a memory of its own. A core that cannot load (no WebAssembly — which also means no
analysis to draw) rejects like a chunk that could not be fetched, and the host leaves the canvas
empty.

- `viz_motion.rs` is the MUSICAL READING (`lib/viz/musical.js` is now its face: the same `m`, the
  same `stamp` / `count` / `genre` objects for its whole life, refreshed in place after every
  analysis frame). `viz_scene.rs` is the GL scene's arithmetic: the spectrum resampled onto the
  texture's 128 texels and max-held between pictures, its release in beats, the band shares, the
  history row per sixteenth, the clocks extrapolated to the instant of the picture, and the whole
  uniform block — packed at `glsl.js#MUSIC_OFFSET`, handed over BY NAME once (`SceneCore`), so the
  layout still lives in one place. It also holds the rig's CROSSOVER (`uPump`): three ways —
  20-160 Hz, 160 Hz-2 kHz, 2-16 kHz, the power the analyser reads off the FAST spectrum (`ways` in
  the frame, carried to the projector held over the frames its throttle drops) — each against its
  own recent loud level, thrown out at once and falling back with a cone's mass. The `soundsystem`
  world's subs, mids and horns each move on their own part of the music: they used to share one
  slow swell (the mix's balance), with the kick added to the mids to make them move at all, and
  read off the energy bands (whose low end is a 170 ms window) the subs peaked a quarter of a beat
  after the kick. Pinned in `vizcore.test.mjs` on a kick and an offbeat hat: the subs and the horns
  peak half a beat apart. A picture is asked for in two halves, `prepare` (the clocks and
  the spectrum, which the drivers read) and `pack` (the block, once they have run). `viz_scope.rs`
  is the oscilloscope's trigger, per-column min/max and auto-range; `viz_bars.rs` the canvas bars'
  levelling.
- What stays in JavaScript is everything that is not arithmetic — which world, the dissolve, the
  flash policy, the resolution governor, the WebGL calls — and the worlds' DRIVERS: a few lines
  each, and crossing into the core and back costs what they do.
- **Every object is a HANDLE** (a 1-based slot; 0 means none), and nothing allocates once built,
  so the page's typed-array views on the core's memory stay valid from frame to frame — they are
  re-made only when a grow replaces the buffer (`viewer`). A FREED object's views must never be
  written again, since its memory goes back to the allocator: every core class no-ops after `free`
  (`SceneCore` hands out scratch arrays), and a scene is boxed so the table growing never moves one.
- **The crossing is the cost, so it is written for V8.** Measured on the reading: the arithmetic is
  0.25 µs in Rust against 1.23 µs in JavaScript, but copying the result back into `m` through a loop
  over a list of key names (`st[ORDER[k]] = …`, a keyed store — V8's slow path) cost 0.8-1.5 µs and
  made the port SLOWER than what it replaced. Every store names its field, every slot index is a
  constant resolved once from the layout the binary publishes, and the reading is now 0.60 µs a frame
  all in. The same measurement found two costs in the JavaScript around it: the governor's median
  was `Array.from(intervals).sort(cmp)` on every picture without a GPU timer (Firefox, Safari) — the
  most expensive line of the draw — and is now a sort in place; and a closure plus six views were
  allocated per stage per picture. The scene went from 765 to 502 µs of CPU per second of music
  (94 frames, 60 pictures). `exp`/`pow` are kept out of line (`util::exp64` / `pow64`) so LTO does
  not paste a libm routine into every call site.
- **The JavaScript each port replaced is kept as its ORACLE** (`test/reference/`: `scope.js`,
  `bars.js`, `musical.js`, `gl.js`, unchanged but for their imports) and `test/vizcore.test.mjs`
  runs both side by side on the analyser's own reading of real records: the reading field by field
  (25 302 frames, identical to the bit), the scene's block, spectrum texture and history row picture
  by picture (9 517 pictures over three worlds, two layouts and 60/144 Hz: 0 of 1 065 904 floats
  differ), the scope's every drawn point at every tier, the bars' too — and each Rust version has to
  be measurably faster. Change a rule in Rust, and the oracle is where the old behaviour is written
  down.

**The oscilloscope** (the `scope` instrument world, `lib/viz/worlds/scope.js`; `lib/viz/scenes/scope.js`
is its canvas twin for a device without WebGL2) is the one scene that draws the music rather than
something *about* it, and that changes what "good" means: a scope is only worth looking at if it is
STABLE and HONEST. Four things carry that, and each was measured.

- **IT IS TRIGGERED.** Drawing the newest N samples every frame makes the waveform slide sideways at
  the difference between the frame rate and the music's own period — unreadable within a second.
  Each frame hunts backwards for the last rising zero crossing and starts its window there.
  Measured on a sustained tone, the trace moves **0.007 px a frame triggered against 86.5 px
  free-running**.
- **The trigger is LOW-PASSED** (one pole at 320 Hz), which is what makes it lock to the music
  instead of to the cymbals: a bright master's raw zero crossings are dominated by a top end that
  has no stable period at all. Same idea as a scope's HF-reject coupling. The gate is a Schmitt one
  whose hysteresis scales with the trigger signal's own weight, so it is not a number that suits one
  master.
- **ONE TIMEBASE FOR BOTH CHANNELS.** The trigger runs on the mono sum and its offset is applied to
  both traces, because the whole point of two traces is reading one against the other — a
  hard-panned stab, a mono bass under a stereo lead, a phase problem. Two independent triggers would
  slide the channels against each other and destroy the only thing they are there to show.
- **The tap is PER CHANNEL, and it had to be new.** An `AnalyserNode` downmixes to mono before it
  measures anything, so the engine's two existing analysers cannot answer this at all.
  `graph.js#requestScope` adds a `ChannelSplitter` after the output with one analyser per channel,
  read with `getFloatTimeDomainData`. It taps BEFORE the look-ahead delay like the others (both
  screens must draw the same instant), it is **refcounted and built on demand** — two analysers copy
  every render quantum into their ring buffers whether or not anyone reads them — and a mono source
  is up-mixed rather than left with a dead second output, so it shows two identical traces, which is
  what a real scope with both probes on one signal shows.

**On the GPU it is an INSTRUMENT, not a world**: it is not in the catalogue and no genre can land on
it (`worlds/index.js#INSTRUMENTS`), only the scope mode. `viz_scope.rs` computes the trace; its two
channels' `[lo, hi]` columns go up as an RG32F data texture (`def.data` → `renderer.dataTexture`,
sampler `uData`, uploaded straight from the core's memory) and are drawn as instanced capsule
segments — one per column and one joining it to the next — blended by MAX, so a joint is not twice
as bright as the stroke (`particles.blendMax`; and `exact`: every instance is a piece of one trace,
so the tier's particle share does not apply). The phosphor is the feedback target decaying on a
time constant, and the face — graticule, trigger marker, the G / D channel glyphs — is signed
distance fields in the world's fragment. Measured under SwiftShader at the high tier it costs what
its neighbours do (665 ms a picture against spectrum's 527 and aurora's 2 211 — software GL, so only
the ratios mean anything).

**PRECISION is the quality setting; the TIMEBASE is not.** Every tier shows the same ~42 ms slice,
because eight times as much waveform at ultra would not be more precision, it would be an unreadable
picture. What the tier moves (`scope` in `quality.js`) is how much of that slice survives to the
screen: the trigger's search room (25 ms → 250 ms, and more of it is strictly more stable — it is
what still finds an edge under a held pad), the column ceiling (**256 / 512 / 2048 / 4044** columns
measured on a 4K-wide lane), per-column **min/max** instead of peak-preserving decimation, and the
sub-sample trigger. That last one is where the trap was: `exact` takes min/max over the whole samples
in each column, and `ceil()` rounded the fractional trigger straight back off, so `fine` did nothing
until the column's **fractional ends** were read by interpolation too. That is now the entire
difference between the tiers that interpolate the trigger and the tiers that do not — **1.03 px of
frame-to-frame drift against 0.007 px**, a factor of 158 — and it closes the hairline gap between one
column and the next for free.

Everything else follows the house rules. The **auto-range compresses rather than normalises**
(`gain = (target/ref)^0.6`): raising a quiet passage to full height would throw away the one thing a
waveform is best at showing, so 20 dB down draws at 40% of the loud part instead of 10% — visibly
quieter, never a dead line. It is **shared between the channels**, or a mix that is louder on one
side would look centred. And its reference is deliberately **not the peak**: a peak envelope is a
scale set by the loudest instant and held there, which measured out at a reference of 0.85 while most
windows held 0.09 and drew the trace at six per cent of its lane — honest, unreadable. A **slow
attack** (0.35 s) fixes it with the envelope that already existed: a 0.15 s kick can only pull it
part of the way up, so the scale lands on what the music spends its time at (measured, 0.53 of full
deflection on average) and the transients clip to the rails, which is what a scope does and what they
should look like. The phosphor is a **time constant**, and the stroke alphas are multiplied by the
wash they settle against (steady state is `alpha/wash` on a trace that redraws in the same place), so
persistence and exposure are identical at a 30 fps cap and at 144. The two lanes take the **free
strips around the artwork** — above and below it, or beside it — the same answer aurora gives its
ribbons and for the same reason.

**The beam does not dim with the tier, and that is the one place this scene parts company with the
others.** Their `preset.glow` is a brightness ladder (0.45 at low against 1.25 at ultra) because what
it scales is atmosphere; here it would scale the SIGNAL, and at 0.45 with no post pass behind it
(`POST.low` is null) the trace was very nearly invisible. So `glow` is read as the halo budget it
really is — the part the bloom duplicates anyway — floored, and the core and the graticule are the
same at every tier. The beam does get **wider as the columns get coarser** (by the square root of the
ratio): the same alpha laid along 256 long diagonal segments puts far less ink on any one pixel than
along 1548 short ones, so a low tier drew a trace that was there and could not be seen — and a coarse
trace *should* read as a fatter, softer beam, which is exactly what a scope with less resolution
looks like.

**Two settings, in Réglages → Animations, shown when the scope is the scene on either screen**:
the **orientation** (two bands stacked, or two columns side by side) and how the **two channels are
coloured** (the palette's two ends, one hue, or the hue walking along the trace exactly as it walks
across the bars). Both are a LEAN on the palette SOURCE the user already picked, never a replacement,
and both are pushed into the live scene rather than rebuilding it — flipping the orientation should
move the lanes, not restart a trigger lock and an auto-range that took a second to settle.

**The raw samples are not an analysis LEVEL, they are orthogonal to all three.** A scope wants the
waveform and none of the ladder; a smart scene wants the whole ladder and no waveform. So
`subscribeFrames(fn, level, { wave: samples })` asks for them per subscriber and the engine takes the
largest window anyone wants, exactly as it takes the deepest level — two scopes on screen share one
splitter. On the projector the window crosses the channel **whole**, as Int16: a waveform reduced
before it crosses is one the projector cannot trigger. It is strictly opt-in and sized by the VIEWER
(`wv` on its hello), so a projector on any other scene still costs the ~800 bytes a frame it always
did and one on the scope costs up to 32 kB — a memcpy inside one browser process. A viewer that does
not ask is sent nothing; a publisher that cannot answer leaves the projector's scope with no probe on
it, drawing its graticule and a flat line, which is the truth rather than a broken picture.

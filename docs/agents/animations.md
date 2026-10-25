# Animations (viz): worlds, skins, scope, projector

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).

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

**THE ANIMATIONS ARE SHADERS, AND THAT WAS THE WHOLE FIX** (`lib/viz/gl/`, `lib/viz/scenes/gl.js`).
They used to be 2D-canvas scenes — additive strokes over a translucent wash — and every one of them
looked like what it was: hairlines on black, eight-bit trails you could count, a bloom bolted on
after the fact on a second canvas. No amount of care inside the scenes could fix that, because the
medium was the ceiling. Every full-screen animation except the oscilloscope is now a fragment
shader, drawn by one WebGL2 engine in four files:

- `gl/renderer.js` — one context per CANVAS (not per scene: a mode change must not recompile the
  shaders it already has), **HDR** render targets (RGBA16F; RGBA8 with the scene scaled by
  `uHeadroom` where float targets are missing, so the bloom and the tone map still see values above
  one), a program cache, and the four things a device WILL do to it: lose the context (prevented,
  then every object rebuilt on restore and programs recompiled lazily from their source — a world
  never knows), lack float targets, compile slowly (`KHR_parallel_shader_compile`, polled, so a first
  switch to a world is never a frozen frame) and be too slow (`EXT_disjoint_timer_query_webgl2`: the
  GPU's own time per frame, because timing the JavaScript that issues the calls measures nothing).
- `gl/glsl.js` — the **Music block**: one std140 uniform block carrying the whole musical state, the
  palette and the frame, uploaded ONCE per frame however many programs read it. Its layout is
  declared once (`MUSIC_SLOTS`) and generates both the GLSL and the JS offsets, because a writer and
  a reader that disagree by one vec4 do not fail — they silently feed every world the wrong numbers.
  **There is no wall-clock time in it.** A world's clocks are beats, bars and phrases (`uClock`), so
  "no constant that should be musical" is a property of the interface rather than a rule to police;
  the one thing that needs seconds, the film grain, lives in the post pass. Also here: the library
  chunks a world pulls in by name (`uses`: noise, fbm, sdf, voronoi, caustics, `crowd` — the person seen from behind that lasers and stage share — …, with dependencies),
  and the assembly of a world's fragment and particle programs.
- `gl/postfx.js` — what runs after a world has drawn: the **dissolve** between two worlds, the
  **bloom** (the Jimenez/CoD 13-tap downsample with a Karis average on the first step and a tent on
  the way up — the filter that does not shimmer when a bright line moves), the **AgX** tone map
  (a hot neon rolls toward white THROUGH its own hue instead of clipping to a flat cyan blob — in
  scenes built of emissive light that is the difference between lit and clipped), a radial
  chromatic fringe that swells for an instant on an impact, and triangular dither plus grain (an
  8-bit output cannot hold a smooth dark gradient). Deliberately **no vignette**: darkening the
  edges would undo the rule that a picture fills a beamer.
- `scenes/gl.js` — the musical reading turned into uniforms, and the POLICY: which world, dressed
  how. `update` reads the music at analysis rate; `draw` extrapolates the clocks to the instant of
  the frame and computes every envelope from event STAMPS at that instant, so motion is as smooth
  at the projector's 45 Hz of analysis as at 94. A **dynamic resolution governor** steers on the
  GPU time (or the frame interval when there is no timer) between the tier's floor and ceiling.
  **Flashes are the engine's, not the worlds'**: a world calls `flash(power)`, and this file
  decides — never more than three onsets a second whatever the music does (the WCAG general-flash
  threshold, and on a projector in a room full of people the line between a style and a medical
  risk), scaled by the user's setting (`vizFlash`: off / soft / full, one setting for both
  screens), and none at all under `prefers-reduced-motion`. The one exception is **`unleashed`
  ("Débridé")**, for people who are not photosensitive and want the real thing: it is a different
  POLICY rather than a brighter "full" — the worlds only ask for a flash on a drop, once a minute,
  so lifting the cap alone changes nothing — and the engine runs the strobe a lighting desk would
  (`strobePower`: every main kick at the peak of the track, harder on a big kick, the snares of a
  build accelerating into the drop, nothing in a breakdown), up to ten a second. It is only ever
  set through `components/FlashWarning.svelte`, a warning with a box to tick (what it does, who it
  endangers — including people who do not know it — what to do, and the projector's audience,
  who accepted nothing); `vizFlashAck` records the acceptance and `stores.js#flashLevel` plays a
  stored `unleashed` without one as `full`, so the warning is a condition, not a formality.
  `prefers-reduced-motion` still wins over it. `musical.test.mjs` pins it: 27 flashes for the 26
  main kicks of a 200 BPM drop, none in the breakdown.

**A world is one file** (`lib/viz/worlds/<id>.js`), fetched the first time it is on screen:
`{ id, uses, feedback?, params, look, fragment, particles?, create() }`. `params` become `P_NAME`
defines (sixteen at most, packed into four vec4s) that a skin may override; `look` is the world's
grade (exposure, bloom, threshold, saturation), blended during a dissolve; `particles` is a
STATELESS instanced sprite (`particle(id, …)` computes everything from its index and the music, so
thousands cost nothing on the CPU); `create()` returns the DRIVER — the few lines of JavaScript that
integrate what a shader cannot (a camera's travel, a stepped rotation, a runner's stride) into eight
floats of `state` and a ring of eight `(birth, power, a, b)` events (`worlds/kit.js`). The rules,
each of which a world broke once:

- **The driver gets seconds; it must spend beats.** `dt / m.beat`, `m.overBeats(n)`,
  `m.ease(v, target, beats, dt)`. Events are stamped in beats and aged in the shader against
  `uClock.x`. The two deliberate exceptions are perceptual, not musical: a flash's decay, and a
  temporal average's time constant (aurora's denoise is 60 ms at any frame rate — a blend of 0.28
  PER FRAME was a 60 ms average at 60 fps and a 25 ms one at 144).
- **Feedback is a time constant, not a per-frame factor**, for the same reason. The feedback worlds
  (`flow`, `ink`, `aurora`) get their dt from the driver.
- **Anti-alias against the real footprint, in pixels.** `uFrame.w` is one pixel in p-space. A line's
  width is its screen width at every depth, and where lines pack tighter than the pixels can hold
  they fade into their average light instead of shimmering. The footprint is the WHOLE gradient:
  `horizon`'s road lines run almost flat toward the horizon at the sides, and there it is the
  vertical change in x that decides how many a pixel covers — reading one axis drew a band of
  coloured moiré under the sun. `pixels` only draws its aperture grille where a virtual pixel is
  big enough to carry one; a mask finer than the screen's own pixels is moiré, not texture.
- **Draw on the frame, around the artwork.** p-space is y −1..1 and x −aspect..aspect; `uHole` is the
  artwork's centre and half extents, **measured from the DOM** (`Visualizer.svelte`'s `occluder`,
  through `lib/viz/geometry.js`), and `clearOfHole` dims what falls under it. It is the artwork's
  OWN box (`hx/hy/ahw/ahh`), not the frame-centred one geometry.js grows for the scope's polar
  primitives: the mobile cover sits above the middle, and the grown box centred every world 7% of
  the frame below the cover it was framing. A world puts its motif in the band the artwork leaves
  free (the pixel runner stands on a ground line under the cover; horizon's floor and storm's lake
  start there and the synthwave sun rises from behind it; the spectrum runs one row of capsules in
  the band below it and one in the band above) and fills a 16:9 beamer to all four edges. A world CENTRED on the
  artwork (galaxy, kaleido) dims under it harder than the house third and lifts what is outside: the
  core is hidden by definition, so the light goes to the arms that are seen. On a PHONE the cover
  spans nearly the width, so "beside the artwork" is off the screen: a world whose subject would sit
  behind it moves its camera instead (the night drive's horizon drops to the cover's bottom edge so
  the car ahead is under it, the warehouse's hall vanishes in its top half, the lasers' stage and the
  rock stage's deck stand under it), and a world that scatters things beside the cover scatters them
  above and below it when there is no room at the sides (ink's drops, neon's slots). `run.mjs
  --phone` for every world after touching one — two of these were only found by looking.
- **A long clock wraps at a period its shader is exactly periodic in.** Uniforms are float32: the
  wobble's LFO phase reached 3.4e4 in ten minutes at 250 BPM, which a few hours on is a visible
  stutter. It now wraps at 200π (both its oscillators close there); the night drive at a multiple of
  its lamp and dash spacing; the pixel runner's ground, skyline and stars each at their own.
- **A spring is substepped against its own period.** The `slices` jump was a stiff spring integrated
  in fixed 1/60 s steps; at 250 BPM its period is 84 ms, past where semi-implicit Euler is stable,
  and the position ran to −Infinity in seven seconds — a black world for the rest of the night.
- **Never name a variable after a GLSL built-in.** `float all = …` compiles, and the `all(…)` three
  lines later does not; the world renders black. Tested — and it has caught `round`, `step` and
  `all` since.
- **Nothing oscillates faster than a frame can show.** Rain's pane "shivered" on the kick at 80
  radians a beat — faster than any refresh rate — which aliased into jitter; it is one thump now.
  And nothing moves at a speed the thing it depicts never has: the record turns a revolution a
  bar (32 rpm at 128 BPM, a real 33), not every two beats (a blur at 180).

**The catalogue: 50 worlds on eleven shelves** (`worlds/catalogue.js` — names and blurbs, no shader,
so naming a world costs nothing; `worlds/index.js` — one LITERAL `import()` per world, so each is its
own chunk: a session of techno never downloads the rawstyle forge).

| shelf | worlds |
|---|---|
| Hard | `forge` (rawstyle's hammer — the pitched, overdriven kick rawpvc makes: a shaded anvil struck on the kick, spark fountains skittering across a lit floor, the anthem as gold satin), `cymatics` (frenchcore, melodic but hammering: a Chladni plate struck under the artwork — the lead's pitch picks the mode, a held note holds it and a change morphs the sand; main kicks send a shock front that throws the grains, a roll makes them chatter, the drop blows the sand off and lands it on a new figure; grains on brushed steel), `shatter` (the frame in refracting glass shards), `lasers` (laser fans in smoke over a crowd whose hands go up on the drop, flame columns on big kicks, a liquid sky in the breakdown), `bounce` (a soft matte orb squashed on the kick, a ring of spectrum capsules round it, on a seamless studio cove), `saw` (a spinning blade and sawtooth lasers — zaag, literally), `stairs` (a raymarched helix whose steps light with the arpeggio), `pingpong` (a neon rally: glass paddles that glide to meet the ball on the beat, one bounce on the far half), `soundsystem` (a speaker wall whose cones pump), `static` (the artwork's own signal torn apart: bands, pixel-sort streaks, chroma-error blocks), `microwave` (the buzzing kick as the oven it sounds like: the cavity seen through the door's perforated screen, the lamp surging on the kick, the standing wave's hot spots hopping on every main kick, a VFD timer counting the phrase down to "End" — and a SHAPE switch, `dish`, for what is cooking: Deutscher Krach's gilt plate throwing arcs, zaag's circular saw biting on every main kick (drawn as its swept ring once it turns faster than a frame can show, instead of aliasing), uptempo's popcorn popping on the kicks and the rolls), `fireworks` (shells aimed at the NEXT beat, in a real show's colours turned to the palette, over a skyline and water that catch every burst) |
| Techno & machines | `tunnel` (a panelled corridor lit only by its ring fixtures, a light running down it on every beat, a polished floor mirroring the ceiling), `warehouse` (concrete pillars, sodium lamps, moving heads sweeping the haze and pooling on a wet floor, strobes that are flashes), `ridges` (Unknown Pleasures), `lattice` (a cone-marched chrome space frame carrying a current), `circuit` |
| Trance & psy | `hyperspace`, `kaleido` (line-art KIFS), `galaxy`, `flow` |
| Bass & breaks | `wobble` (the LFO's own shape, with its wake and current crackling along it), `chrome` (liquid metal), `slices` |
| Urbain | `vinyl`, `halo` (the spectrum as a breathing crown round the artwork, its echoes going out through smoke the 808 pushes aside), `nightdrive` (the wet motorway behind a car whose brake lights flare on the kick), `neon` (a wet street under ten real neon signs — a heart, a martini, a bolt, a moon, notes… — laid out on slots the artwork never hides) |
| Pop & groove | `bokeh` (lens bokeh in a luminous room, with glitter the one thing in focus), `discoball`, `silk`, `artwork` (the cover's own colours), `plasma` |
| Rock & metal | `stage` (the band backlit against an LED wall showing the artwork, beams on a lighting desk's cues, the crowd), `inferno`, `storm` (a cloud deck lit from below by the last light, over a lake that mirrors every strike) |
| Calme | `nebula`, `aurora`, `piano` (for piano music: a keyboard of light with the tune rising above it as a piano roll READ FROM THE SPECTRUM — a key sounds when its band is a peak, the local maximum a semitone either side and clear of the bands two and a half out, so one note lights one key and a drum lights none — the chord's pitch classes as columns of light round the melody's register), `ocean`, `cathedral` (a Gothic rose of pointed lancets and leaded glass, down a nave of fluted columns), `ink`, `rain` (every drop a lens refracting the city), `fireflies` (a meadow whose fireflies fall into step on the drop) |
| Monde | `carnival` (polyrhythm as rings of beads, under festoons of bulbs chasing the beat), `tropics` |
| Rétro | `horizon` (the banded sun over a true ground plane), `pixels` (a CRT raster, a runner on a real gait, a brick equaliser whose caps fall under gravity) |
| Classiques | `pulse`, `spectrum` — also the fixed `pulse` and `bars` modes |

**THE HOUSE STYLE IS TODAY'S, NOT 2005's.** Premium twenty years ago is dated now, and the user said
so about the default mode in so many words: the bars "look like Windows XP". They were glass tubes —
a rim light down each edge, a specular stripe, a hot top, hairline peak caps hanging above, a
mirror-polished floor — and every one of those is a desktop-theme idea from that era. The rules that
replaced them, for any world:

- **Shape over sheen.** A bar is a fully rounded capsule, mirrored about its axis as ONE shape (two
  rounded bars meeting in the middle drew a dark pinch along the axis) and a DOT at rest; a sphere is
  matte under one big soft key light with a broad highlight and a thin rim, never a pin-point
  specular over a reflected studio. No glass rims, no specular stripes, no mirror floors: a soft
  contact shadow and colour bleeding onto a seamless cove say "object on a floor" better.
- **Colour as fields, not lines.** `pulse` was caustic folds lit by lobes and read as a purple web;
  it is now a mesh gradient (six band fields that BLEND by weight rather than add up) under liquid
  glass — a beat is a ripple that refracts the colour, shades like a lens and catches one highlight.
- **No resting chromatic fringe.** The lens split is an impact (a big kick, a drop) and nothing at
  rest (`scenes/gl.js`): a permanent red/cyan edge on every thin line was the cheapest-looking thing
  in the catalogue. Worlds built of thin light (`spectrum`, `pulse`, `bounce`, `aurora`) set `ca: 0`.
- **Level is information here too.** The spectrum's zone gains keep every register alive, but its
  heights are also scaled by the track's dynamics, so a breakdown is a row of small capsules instead
  of the drop renormalised to the same height.
- **The strip renders at full resolution** (`scenes/gl.js#gq`): it is 40 px tall, cheaper than any
  full-screen world at its floor, and its capsules are a few pixels wide — a governed scale smeared
  every edge into the next. The canvas twin (`scenes/bars.js`) draws the same capsules.
- **Light things; don't outline them.** `stairs` was neon wireframe slabs round a black void,
  every edge flashed on the kick — a 2000s screensaver. Its slabs are matte stone now, LIT by the
  column they turn round (diffuse falling off with distance, a hemisphere ambient, a soft sheen), the
  sounding step glowing from its tread, the kick pulsing the column and so the light on every slab;
  the edge is a hairline bevel.
- **Accents stay in the family.** The palette's complement (`uPalAcc`) at full strength on a grid
  (soundsystem's cabinet seams on every kick) drew a green wireframe over a purple scene; an accent
  is mixed toward the lamps' own colour and kept to a hairline.
- **A lens is round, and what is in focus is a point.** `bokeh` drew hexagonal apertures with a hard
  rim, a red/blue fringe and four-point star glints on the glitter — a 2000s lens flare. Its discs
  are round by default (`blades` is a skin's choice), softer the further out of focus the layer is,
  with a gentle rim and no fringe; the glitter is a pixel-sized point with a faint halo.

**A world is machinery; a SKIN is what one genre does with it** (`lib/viz/skins.js`). 226 rows, one
per genre, each naming its world, how its palette leans (`hue` / `sat` / `light`, applied by
`palette.js#setSkin` on top of the source the user picked, never replacing it), its `speed` and
`energy`, and a bag of world parameters. The bag carries two kinds of parameter and only one of them
is worth the table's length: a SCALING one (`sparks`, `shards`, `count`) says how much of the motif
there is; a SHAPE one changes what the motif IS — `kaleido`'s `mirror` 0 is a pinwheel (goa) and
`web` 1 a web (darkpsy, forest), `wobble`'s `wave` is the LFO's shape (sine / square / saw: melodic
dubstep, riddim, brostep), `lasers`' `raw` goes from euphoric sweeps to raw red fire, `slices`' `axis`
turns bands into falling columns (jungle), `tunnel`'s `sides` / `twist` / `dash` make a hexagon, a
helix or strobing rings (EBM, peaktime), `vinyl`'s `rpm` turns a 78 faster than a 33 (swing). The
anchor rows (techno, house, ambient, pop, hardstyle, rock, electronic) override almost nothing: they
ARE the default each world was written around. `skinFor(name, archetype)` normalises whatever it is
handed (an id, a French label, a hand-typed tag with spaces, accents or hyphens) through `ALIASES`
and falls back to the archetype's anchor, which is the same world `catalogue.worldFor` names. A
**pinned** world (`vizWorld` / `vizScreenWorld`, one per screen) keeps the playing genre's colours,
and its parameters only when that genre lives on the pinned world.

**The studio's vocabulary is the same vocabulary** (`analysis.EXTRA_GENRES` + `known_genres()`). The
live classifier honestly separates ~54 families, so a *tag* is where a sub-genre name comes from —
and a label the studio offers that the animation cannot resolve is a track somebody tagged carefully
and then watched get animated generically. The two lists are written in different languages; a test
reads the Python one and requires every label to reach a row of its own, not the archetype floor.
The ANALYSER has to hear them too: a tag or the trained head's verdict is served under the label's
own name ("Schranz", "Deutscher Krach"), and the look, the bar model and the tempo band were keyed by
family id only — so a track the model named "Gabber" had its bar read the generic way and no genre
look, and a word-by-word guess gave "Garage rock" UK garage's tempo and "Drumfunk" funk's.
`style.js#genreOf` now resolves every name once to `{ family, band, groove }` (`GENRE_ALIASES`: a
sub-genre's own band where it is written at a tempo of its own — hitech, hard house, nu metal, doom
—, null where the name spans octaves, and a groove only where it builds its beat unlike its family),
and `familyLook`, `grooveOf` and `tempoRangeFor` all read it. `viz.test.mjs` holds every studio label
to being known BY NAME, never from a word in it. A chosen genre (tag or model) sets the groove even
where it has no band.

**Nothing hard-switches.** style.rs refuses to rename the dominant family until a challenger has led
by a clear margin for a second and a half, and a change of world is a **dissolve**: the new world is
fetched and compiled while the old one keeps playing, and only once it is READY does a noise-edged
burn carry the new picture through the old over one bar (`DISSOLVE_FS`) — so a first visit to a world
is never a black frame. A second change while the first is still dissolving drops the one that was
leaving: three worlds on screen is not a crossfade, and it is three times the work.

**`lib/viz/geometry.js`** is what is left of the canvas-era geometry: it measures the occluder for
`uHole`, and it is the primitives the oscilloscope is drawn on (`place(angle, radial)`, where radial 1
is the frame's own edge rather than a circle inscribed in it, and the expanding `ringRx/ringRy`).
**`place` returns ONE shared array**, reused on every call so a 94 Hz loop makes no garbage: a caller
holding two results at once holds the same array twice, and the segment between them collapses to a
point with no error anywhere. Read the first point's numbers out before asking for the second.

**`lib/viz/post.js` is the CANVAS scenes' post pass** (the scope's bloom and grain) — the GL engine
has its own. What it learned still stands: the bloom is a second, small canvas over the first,
blended by CSS (the obvious build, reading the scene canvas and upscaling on the CPU side, measured
45–52 ms a frame against 0.26 ms for the scene); every `ctx.filter` runs on a small buffer, because
a filter applies over the area drawn INTO; and it times its own first frames and steps down a level
at a time. `webapp/test/post.test.mjs` pins it.

**How the animations are tested — two places, because only one of them has a GPU.**

- **`webapp/test/render/run.mjs`, the render bench** (not part of `npm test`: it needs a browser).
  It starts the Vite dev server, opens `test/render/bench.html` in headless Chromium (Playwright on
  SwiftShader, so no GPU is needed), drives each world through a synthetic arrangement
  (`music.mjs`: intro, builds, drops, a breakdown, at any BPM and genre) and writes a contact sheet
  per world to `test/render/out/` (git-ignored) — the only honest way to review a shader is to look
  at it. `--check` holds every world to the contracts: all four edges carry light in the drop; the
  drop is neither black nor washed out and almost nothing clips; the drop and the breakdown are
  measurably different pictures; on the phone layout under a centred cover, less than a quarter of
  the light sits behind it; and the picture moves materially more over the same two seconds at 180
  BPM than at 90 (`--tempo`). That last one is read three ways and the strongest counts — frame to
  frame on 24×14 blocks (grain and dither cancel; a fast world saturates), over the whole window (a
  calm world's slow drift only shows there) and pixel by pixel (a sea's small waves average out of
  every block) — because a single pair of frames right on a kick measures the kick's envelope, and
  most worlds scored ~1.0 on it. A clock in seconds scores ~1.0 on all three. Feedback worlds are
  warmed for ten seconds before they are judged: they are their own history. The dev server runs
  with no watcher and no hot reload: editing a world during a sweep used to reload the bench page
  under it, and every world after that "crashed" with `window.bench` undefined. By default a world
  runs on its OWN defaults (`fixed`), which is what the contracts are about; `--skin` pins it the
  way the smart engine does, so it wears `--genre`'s skin — the only way to see a shape switch
  (`tunnel` as ebm's helix, as peaktime's dashes) before a user does. `--pscale 2` renders the phone
  layout at twice the size, to read detail. `--strip` photographs the players' 40 px bar strip
  instead (390×40 CSS px at `--pscale` density, default 3, over the blurred cover under its scrim —
  a transparent layout can only be judged on what it sits on), and `--nograin` turns the post pass's
  film grain off, to tell a world's own noise from the grain laid over every world.
- **`webapp/test/viz.test.mjs` and `musical.test.mjs`** (node, in `npm test`) pin everything that can
  be decided without a GPU and that a GPU would only ever report as a black screen: the loader, the
  catalogue and the skins agree; every classifier family resolves by id AND by French label, and
  every studio sub-genre to a row of its own; every skin names a real world with parameters that
  world declares, and every world is some genre's picture; neighbours sharing a world (goa/darkpsy,
  dubstep/brostep, gabber/speedcore…) differ on a SHAPE switch; every `P_` define and every uniform a
  shader names is one the engine declares, and no variable shadows a GLSL built-in; the engine
  exposes no seconds clock. Then every world's DRIVER is run at 90 and 180 BPM over the same wall
  clock — measured 1.82x (flow) to 2.31x (forge) as far; a rate in seconds scores 1.00 — for ten
  minutes at 60 and at 250 BPM with quarter-second hitches (no NaN, no state past 1e4), and must
  stamp its events in beats near now. It found both faults above the day it was written: the
  diverging spring and the unbounded clocks. The oscilloscope's own tests (the trace against real
  samples) are unchanged and live there too. Both load the animation core from the shipped binary
  (`vizCoreFromBytes`): the reading every driver is handed is the Rust one.

**No constant that should be musical** (`lib/viz/musical.js`) is still the layer every driver reads:
`m.overBeats(n)` is a lifetime, `m.perBeat(n)` a rate, `m.ease(v, target, beats, dt)` a smoothing,
and the shape of the moment comes off `m.drive` / `m.weight` / `m.build` / `m.breakdown` /
`m.dropped`, plus the stamps (`m.stamp.main`, `.snare`, `.drop`, …) a driver turns into events. The
old canvas scenes had to be policed into it by a stopwatch test; the shaders cannot break it, and
the drivers are held to it by the test above.

**ANALYSIS AND RENDERING ARE DIFFERENT THINGS, and `lib/viz/bridge.js` is the line between them.**
The sound is analysed ONCE, in the tab that has the audio — one beat tracker, one classifier — so
the genre, the tempo and the grid are decided once and both screens agree by construction. What
crosses the channel is that analysis. What each side does with it is its own business: the player
and the projector pick their own scene (`vizMode` / `vizScreenMode`), their own quality tier and
their own frame rate, and neither waits for the other. The player can sit on "Aucune" while the
projector runs, which is a supported arrangement and now has a button for it.

The level the analysis runs AT is the only thing that must be shared, and it is **the most demanding
of the two**: the viewer announces what its scene needs (`lv` on its hello, re-announced when the
projector's mode changes), `host.js` subscribes at that level, and the engine's own
`recomputeLevel` maxes it with whatever this tab wants — so the rule falls out of machinery that
already existed.

**Why the two screens used to drift apart** — it was never a clock problem, it was a sampling one.
The engine runs at ~94 Hz and the channel publishes at 45, so a beat, which is true on exactly ONE
analysis frame, had a better than even chance of landing in a frame the throttle dropped: the
projector was missing about half of every track's beats, kicks and downbeats. Continuous values can
be sampled; **events have to be latched**. `beat`, `downbeat`, `kickHit`, the style kick's `hit` and
the peak `onset` are accumulated across the dropped frames and cleared once sent. `kickHit` was also
simply absent from the payload, so every animation that fires on a kick never fired at all on the
second screen — which was every animation built on the kick. `webapp/test/bridge.test.mjs` pins both halves:
no event lost to the throttle, and no event reported twice.

**The projector window** (`routes/Viz.svelte`, `lib/viz/bridge.js`, `lib/viz/host.js`) is the same
SPA on `#/viz`, opened in a second tab to be dragged onto a beamer. It plays **nothing**: a second
`<audio>` would be a second stream, a second decode and a second playhead drifting out of sync with
the room within a minute. The playing tab publishes its analysis frames over a BroadcastChannel
(~800 bytes at 45 Hz — the melodic channel, the dynamics gate and the `look` vector are in there
too; without them the projector ran the same scenes with no quiet passages, no melody layer and the
neutral default look, which is most of why the second screen looked more generic than the player it
mirrors) and the projector renders them — one decode, one analysis, one timeline. A
live viewer is also what tells the engine to keep running while the player tab is hidden. That
window never writes the playback session back (`DISPLAY_ONLY` in `stores.js`): its snapshot is
frozen at the moment it opened, and writing it would roll the real player's position back to then.

Three things keep that link alive, and each fixes a way it used to die:
- the engine's **upgrade to the audio-thread clock is retried**, not attempted once. An AudioWorklet
  needs an AudioContext, and the context only exists once something wired the player's element into
  the graph — which normally happens *after* a projector window has subscribed. Giving up on the
  first look left the engine on rAF for the session, and rAF stops in a hidden tab: the projector
  froze the moment the player went behind it.
- liveness is a **transport heartbeat**, not the frames. A paused player sends no frames and is
  still very much there, and the viewer's own ping is a `setInterval` in a window browsers throttle
  to once a minute — so the timeout is generous (90 s), a closing window says goodbye, and a
  re-woken one re-announces at once.
- **more than one tab can publish.** Leaving the app open twice is ordinary, and both tabs answered
  a projector's hello, so it showed whichever landed last — for an idle second tab, "nothing
  playing" over the top of a tab that was playing. Every message carries its sender and the
  projector follows ONE: it prefers a tab reporting playback and only lets another take over once
  that one goes quiet.

**Animations stop when the music does.** `Visualizer.svelte` takes a `paused` prop: it keeps drawing
through a 600 ms fade so the scene winds down rather than freezing, then stops the loop, drops its
engine subscription and clears the canvas. The projector learns the transport state from the
heartbeat and does the same.

**Reloading from scratch** (`lib/hardreload.js`, `components/HardReload.svelte`, Réglages →
*Recharger l'application*). After a GPU crash Chromium refuses WebGL to the page, the visualizer falls
back to the 2D canvas for good (bars for every mode, the scope for the scope) and nothing inside the
document can undo it. The button forgets what the DEVICE learnt (verdicts, silence bounds, the
convicted audio outputs, the learnt look-ahead), unregisters the service worker, empties Cache
Storage (only the shell lives there) and reloads past every cache; settings, the session and
IndexedDB (downloads, offline copies) are kept. `lib/viz/glstatus.js` records a refused context and
the animation settings then show the button with what happened.

**Eco mode** (`ecoMode` in stores.js, `EcoToggle.svelte`) is the switch above all of them: no
animation anywhere on the device — the visualizer, the backdrop's crossfades and the live lyric line
— without destroying the setup underneath, so turning it off restores exactly what was there. It
lives in the full-screen player footers next to the quality chip: one tap away, and taking no place
in the transport row. `effectiveMode` returns `"off"` for it, and **"off" means no canvas anywhere**,
the settings preview included — a preview that kept a canvas alive to show what was just switched
off would be precisely the waste the setting exists to stop.

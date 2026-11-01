# Animations: WebGL engine, worlds, catalogue, skins, house style

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching lib/viz/gl, scenes/gl.js, any worlds/*.js shader, skins.js, the catalogue, flashes, or post.js.

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

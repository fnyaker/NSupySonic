# Animations: testing, musical time, projector bridge, eco mode

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: running/adding viz tests, the render bench, bridge.js/host.js/Viz.svelte (second screen), eco mode, or paused behaviour.

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

**Eco mode** (`ecoMode` in stores.js, `EcoToggle.svelte`) is the switch above all of them: no
animation anywhere on the device — the visualizer, the backdrop's crossfades and the live lyric line
— without destroying the setup underneath, so turning it off restores exactly what was there. It
lives in the full-screen player footers next to the quality chip: one tap away, and taking no place
in the transport row. `effectiveMode` returns `"off"` for it, and **"off" means no canvas anywhere**,
the settings preview included — a preview that kept a canvas alive to show what was just switched
off would be precisely the waste the setting exists to stop.

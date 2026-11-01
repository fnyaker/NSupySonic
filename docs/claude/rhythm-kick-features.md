# Rhythm analyser: features.rs and the kick detector

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching features.rs, kick.rs, SuperFlux, level/dynamics, the melody/chroma, rolls/buzz.

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

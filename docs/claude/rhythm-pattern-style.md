# Rhythm analyser: pattern, style classifier, piep, genre channel

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching pattern.rs, style.rs, family/archetype/look, DOWN_MODELS, piep, genre.rs.

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

# Rhythm analyser: tempo, beat grid, served tempo, bar models

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching tempo.rs, beat.rs, seeding/locking by the server verdict, tempo ranges, breakdown holds.

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
prior's plateau to it, and `engine.js#applyTempoRange` feeds it in from the verdict or, failing
that, from the live classifier once it is confident. The ranges are deliberately WIDE: they set a
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

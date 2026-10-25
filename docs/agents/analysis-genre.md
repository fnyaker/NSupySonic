# Whole-track analysis and the genre studio

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).

**Whole-track analysis is the SERVER's job** (`supysonic/deezer/analysis.py`, served by
`supysonic/webui/analysis.py`, consumed by `webapp/src/lib/analysis.js`). The tempo and the style
are properties of the whole piece, and a detector working them out live spends the first fifteen
seconds of every track converging — through the intro, which is the least representative part of it
— and pays that cost again on every device, on every play. Same reasoning as the loudness: the audio
does not change, so neither does the answer. Measure once, keep it in `track_analysis`, serve it.

- The TEMPO is **beat-tracked from the file** (`deezer/beats.py`, `ANALYSIS_VERSION` 5): a numpy port
  of the analyser Mixxx ships as its default — qm-dsp's complex-spectral-difference onsets (44.1 kHz,
  1024/512) and TempoTrackV2 (comb filter bank + Viterbi for the period, Ellis-style dynamic
  programming for the beats), then Mixxx's BeatUtils (constant regions within 25 ms, the longest
  joined to those agreeing in tempo and phase, rounded to the simplest value its error bars allow).
  GPL-2.0-or-later code, credited in the file. The envelope estimator it replaced read 154 for a 150
  BPM record and 133 for 132 (2.7%: a beat lost every nine seconds); on the 28 arranged records
  (`tools/tempo_eval.py`) it was 17/26 within 3.5%, the tracker is **23/26 exact** and 26/26 with
  Deezer's figure as witness, ~1 s for a five-minute file. And Deezer has NO figure for nearly all
  of a hard-dance library (2 of 3 462 files here carried a non-zero one), so the estimator was what
  everybody got. Three rules sit on top, each measured:
  - **Hardcore is doubled back**: the Rayleigh weighting centres on 120 BPM and tracks a 200 BPM
    kick on every other beat (Mixxx's own failure). When the half beats strike as hard as the
    beats — both in the kick band (43-129 Hz) and across the spectrum, between 0.85 and 1.3 of the
    beats — the tempo is doubled (frenchcore, Krach, speedcore read 0.93-1.06; nothing tracked right
    falls in the window; hard house's offbeat donk took the phase and read 13.7, hence the cap).
  - **No beat, no tempo**: the old attack gate (`_attack_rate`, 40 rises a minute in the bass) and
    the beats' salience against the quarter-beat positions ≥ 1.12 (real masters 1.16-3.3, pads
    1.01-1.07 — a thin margin, stated; the player's locked grid re-checks presence anyway).
  - **Deezer's figure only witnesses the OCTAVE** (`_reconcile_tracked`): Deezer at twice the
    tracked tempo moves it up (dnb at 87/174, double-kick metal); at half it is Deezer's hardcore
    listing and ignored, unless alternate beats are unequal in the bass (< 0.3: a one-drop tracked
    at double time) — then it halves; any other disagreement follows the tracker's confidence.
  **Without any Deezer figure** (`python tools/tempo_eval.py --no-deezer DIR`, 26 arranged records
  with a beat): the tracker alone is exact on 23, its three misses octaves (dnb 87/174, metal 90/180,
  reggae 152/76); with a perfect Deezer witness 25 (only reggae stays). The server does not need Deezer's
  BPM for hard dance, where Deezer publishes none anyway.
  Without numpy the envelope estimator below still answers. A version bump re-measures the library
  on boot (`webui/analysis.reanalyse_if_stale`) instead of waiting for the button.
- The fallback envelope estimator measures a low-passed envelope — ffmpeg decimates to 1 kHz u8 and
  the per-frame peak is a `max`/`min` over a ten-byte slice — **and only when something in
  that band STRIKES** (`_attack_rate`, `ANALYSIS_VERSION` 3). The block peak of a steady note
  ripples with its phase, and the normalised autocorrelation turned that ripple into a confident
  beat: a held 82 Hz note read 240 BPM at 0.79, a held chord 231 at 0.50, and the player anchored
  on it. The same bytes, squared and smoothed, now have to rise 1 dB within 30 ms at least 40 times
  a minute (held tones and chords: 0; the sparsest record with a beat: 99.7). The rise is small on
  purpose — a limitered hard kick's tail sits 2 dB under its attack, and 3 dB lost those.
- The DESCRIPTORS come from ffmpeg's `aspectralstats` and `ebur128`: centroid, spread, flatness,
  entropy, rolloff and flux per frame, plus integrated loudness and **loudness range**. LRA is the
  single best "how squashed is this" axis there is — a limitered hardcore master sits near 3 LU, a
  live quartet near 15 — and it replaces the client's spectral crest, whose scale could not be
  reconciled across the two implementations. **No new Python dependency**: no numpy, no model,
  nothing to install on a server that already has ffmpeg.
- Everything it classifies on is **physical or scale-free** (BPM, hertz, decibels, 0..1 ratios), on
  purpose: the client's live classifier works on its own normalized feature scales and the two must
  not be expected to share a threshold. **Once served, the server's genre and measured tempo ARE the
  answer**: the client pins the family and locks the tempo (see *The server's answers are locked* in [rhythm.md](rhythm.md)
  ) and classifies or estimates neither again. **And with none served there is NO genre**: the
  player runs no classifier of its own any more (`style.rs` `classify`, off from `engine.js`; the rules
  stay, on by default, for the eval tools) — "si le serveur n'a rien, on a rien". That is why a
  client's ask (`request_analysis`) is no longer gated on a head or the extractor: the server's
  measurement is the only genre and tempo a track will get.
- **Local files go down the same road, by their UUID.** `/api/analyses` and `/api/analysis/<id>`
  accepted Deezer's numeric ids only, and so did `lib/analysis.js#primeAnalyses` and the tag sheet's
  refresh — an upload never had a verdict, measured, tagged or not. Both take the row's UUID now
  (`webui/analysis.py#_key`, `analysis.js#verdictId`), a local row only for whoever may read it. An
  upload is measured as it lands (`/api/upload` → `queue_analysis`). And the genre its owner wrote
  INTO the file is served (`analysis.file_genre`, `styleSource: "file"`: below a studio tag, above the
  head and the rules, matched against the vocabulary with case and accents folded, junk like "Other"
  ignored) — only for local files: Deezer's archives carry its broad album genre.
- **A verdict reaches the player wherever it was set.** A label moves the verdict generation
  (`genre._tell_devices`), a device re-asks the track starting when it has not heard the server for
  30 s (`REVALIDATE_MS`: a queue fully cached asked nothing, so a bump never reached it), and a MISS
  is kept 5 minutes, not a day.
- **Its rules were never measured against its own measures, and on the arranged records it named 0
  of 28** — every hard record jazz, strings or dnb. Two faults, both fixed and pinned by
  `tests/base/test_analysis.py` on MEASURED features (the drawn ones it had were on the imagined
  scale): the beat folds (`_grid_share`, `_fold_half_ratio`) folded the whole track modulo a period
  ROUNDED to a whole 10 ms frame, which slides half a frame a beat at 132 BPM, so after a few
  hundred beats the fold was flat — a four-on-the-floor kick read a grid share of 0.06, and the
  octave check took the flat fold for "bass between the beats" and doubled trance and psytrance.
  They now fold by exact phase, per 8-second window. And the rules asked for flatness 0.4-0.75 where
  a file reads 0.01-0.34: the hard families are rewritten on what this side can actually hear —
  the tempo band, and a CLEAN kick (spectral entropy 0.32-0.45) against a NOISY one (0.59-0.78) —
  which names hardstyle, frenchcore, uptempo, Krach and speedcore right; the subgenre past that is
  the live reading's. The confidence is backed by how much the specific rules found at all (a share
  of next to nothing used to read 1.00). The converse octave branch — the bass skipping every other
  beat, so halve — is gone on purpose: a kick on one and three does exactly that at the right tempo.
  `ANALYSIS_VERSION` 4.
- Event-driven like the rest: `archive._finalize_archive` queues it on a daemon thread behind a
  one-at-a-time semaphore, so it is never why an archive, a stream or a shutdown waits.
  `deezer analyze` is the catch-up and the way to re-measure after `ANALYSIS_VERSION` moves. The
  endpoint **never measures** — the player asks about tracks it is *about* to play, and a request
  that started a three-second ffmpeg pass would answer long after it mattered while holding a thread.
- **The catch-up is a button too, and it finishes whatever the library.** The Étiquetage tab starts
  the same `backfill` the CLI runs (`POST /api/analysis/backfill`, admin-only, worker + poll), with
  a **Reclasser tout** toggle (`force`) and a **Parallèle** count where **0 means auto** (persisted
  in `Meta`; `analysis.auto_workers` → `workload.cpu_workers`, half the machine's cores). Above one
  worker the Deezer bpm lookup is skipped on purpose — its session is not meant to be hammered from
  several threads — and the tempo is measured from the files. Each pool thread takes and returns its
  own peewee connection; the work is ffmpeg, so the box bounds it, not Python.
- **A crashed ffmpeg is not the same as a failed measurement.** Some ffmpeg builds trip
  `av_assert0(best_input >= 0)` in the CLI's filtergraph scheduler (`ffmpeg_filter.c`) while
  flushing at END OF STREAM: the process dies of SIGABRT (`returncode -6`) having already decoded
  the whole track and printed every frame of it. Judging the run by its exit code threw a COMPLETE
  measurement away and called four perfectly healthy FLACs broken. So `_spectral` parses FIRST and
  judges after: a run that produced at least `MIN_SALVAGE_FRAMES` is a measurement whatever killed
  the process, and `lufs`/`lra` come from ebur128's **running** per-frame line (`_EBUR_RUNNING`)
  when the abort took the Summary block with it — the same two numbers, since the integrated value
  at the last frame IS the whole-stream one. With nothing salvageable and a death by signal it
  retries once **without `ebur128`** (`_spectral_cmd(loudness=False)`): the loudness meter is the
  droppable half — `lra` has a default — while without `aspectralstats` there is no verdict at all.
  `-t` also moved BEFORE `-i`, so the read limit ends the demuxer and the graph gets an ordinary
  end of stream instead of an output-side trim. And `ffmpeg_tail` skips per-frame filter telemetry
  (`_EBUR_PROGRESS`): ebur128 prints a line every 100 ms, so quoting the last three lines buried
  the assertion that explained the crash under two progress dumps.
- **A failure must name its CAUSE, never just its count.** This is a rule about every batch job,
  not a detail of this one. The analysis used to report `"<file>: analysis failed"` — one filename,
  no reason, and only the first of them — because four layers each dropped a little more: ffmpeg
  printed `Invalid data found when processing input` on stderr, `_spectral` raised
  `"ffmpeg exited 1"` and discarded the text it was holding, `analyze_track` turned that into
  `None`, and the job turned `None` into the word "failed". The reason existed at every step and
  survived none of them, so the only way to debug a library job was to read the container log —
  which is exactly what somebody running the app from a phone cannot do. So: `ffmpeg_tail` keeps
  ffmpeg's own words (and drops the banner, which is never the reason); `analyze_track_verbose`
  returns `(row, reason)` — the same contract as `embedding.embed_file_verbose` — naming the STAGE
  (`spectral pass:`, `classify:`, `database:`, `file missing from the archive`) and quoting what it
  said; `_record_failure` keeps a bounded per-track ledger (`failures`, capped at
  `FAILURE_SAMPLE_MAX`) plus a full tally (`failure_reasons`), so the one-line summary names the
  cause that DOMINATES the run rather than whichever file happened to be first. Both backfills and
  both job endpoints carry it, `components/JobFailures.svelte` shows it with a copy button, and the
  CLI prints it. The job dicts are snapshotted at the web boundary (`_job_snapshot`) because the
  ledger belongs to the worker threads and a status poll must never iterate a list being appended
  to. Re-running the backfill without "Reclasser tout" retries exactly the failures, since anything
  with a current verdict is skipped — so a diagnosis costs one button, not a whole library.
- **It walks the library by page and CHECKPOINTS, never `list()`s it.** `analysis._walk_library`
  keyset-paginates by primary key (`PAGE_SIZE`) and writes the cursor to `Meta` after every page
  (`analysis_cursor` / `embed_cursor`, cleared at the end, ignored past `RESUME_MAX_AGE` or when the
  `force` flag differs). Materialising the library built every Track object before the first
  measurement ran, and a restart lost the whole run — which is what "it stops around ten thousand
  tracks" was. `webui/analysis.resume_if_interrupted` / `webui/genre.resume_if_interrupted` restart
  an interrupted job on boot without being asked, so "analyse everything" means everything, across
  as many restarts as it takes.
- **The mel front-end only transforms the patches it embeds** (`embedding.patch_offsets` +
  `_log_mel_patches`). Building the whole file's spectrogram and keeping a sixtieth of it made the
  cost *and* the peak memory scale with the track's length — numpy's rfft returns complex128
  whatever it is fed, so an hour-long set reached the better part of a gigabyte of temporaries for
  sixty patches. A one-minute track and a two-hour one now cost the same.
- **A model that will not load is retried, not condemned.** `embedding._session_retry_at` holds a
  load failure for `SESSION_RETRY_DELAY` and then forgets it. The old permanent flag meant one bad
  second ended every extraction for the life of the process — and it is also how uploading the model
  fixes a running server.

- **A first play gets Deezer's figure, flagged PROVISIONAL.** The verdict is measured from the
  archived file, and the first play is the one that archives it — so a track heard for the first
  time used to get no served tempo at all. Deezer's public API publishes a `bpm` per track and that
  needs no file: `analysis.tempo_hints` looks it up in the background (one worker, one request at a
  time, a bounded queue, the answer cached a day — two minutes when Deezer could not be reached) and
  `provisional_payload` serves it RAW, flagged, until the measurement replaces it (which then reuses
  the cached figure instead of asking again). The client keeps polling a provisional id until the
  measured verdict lands and keeps the published tempo if it never does. A figure Deezer lists at
  half the real tempo is the tracker's to correct, by its one-sided rule: a served tempo may be
  DOUBLED by the kicks, never halved. `supysonic-cli deezer bpm-audit` answers "are Deezer's BPMs
  right?" on the operator's own library — Deezer's figure against the file's measured tempo, per
  style, every disagreement listed.

The client takes the global answers and keeps the per-moment ones. `engine.js` primes the verdicts
for the queue window (one call, like `/api/gains`) and **seeds the beat tracker** with the served
BPM, so the grid starts locked and only the phase has to be found — the first bar is on the beat
instead of the fourth. It never seeds the same tempo twice for a track: a second seed would undo a
correction the kicks already made. The kick, the onsets and the transients stay live: no whole-file
average can stand in for an event.

**The genre studio** (`supysonic/deezer/embedding.py` + `genre.py`, `supysonic/webui/genre.py`,
`webapp/src/lib/genre/`, `routes/Genres.svelte`) is the answer to "the classifier does not know MY
genres". The heuristic above knows the styles it was written with; this teaches it yours.

- **The studio opens onto a vocabulary WIDER than the detector.** The first admin visit seeds a
  `GenreTag` per entry in `analysis.known_genres()` — the ~54 families the live classifier can name
  (`FAMILIES`) plus `EXTRA_GENRES`, ~170 sub-genres it cannot, from detroit to drumfunk and from
  rawphase to bossa nova — so tagging starts by CONFIRMING a guess instead of typing the vocabulary
  first, and a sub-genre the heuristic could never guess is still one click away. Nothing in
  `EXTRA_GENRES` is ever *returned* by `classify`; it is there to be hand-applied and then predicted
  by the trained head. Every label is chosen so the animation engine resolves it
  (`viz/skins.js#skinId` lowercases and strips everything but letters and digits), and a test in
  `webapp/test/viz.test.mjs` reads this Python list and fails if any label has no skin. It is additive and version-aware (a `Meta` value remembers how many the engine
  knew): a release that adds families re-syncs them on the next admin visit, a genre you delete
  stays deleted as long as the vocabulary has not changed, and the *Genres du moteur* button brings
  back just the missing ones. Only the admin seeds; a guest reading `/genre/status` writes nothing.
- **Measuring the library is a button, not a shell.** The Étiquetage tab starts the very backfill
  the CLI runs (`POST /genre/embed`, admin-only, worker + poll): every archived track without a
  vector is decoded once, so pressing it again only picks up what has been archived since. The
  counters stream back as it goes — it is minutes to hours of work and must never hold a request.
  `backfill_embeddings(on_stats=…)` is the one implementation, shared with `deezer embed`.
- **The big model is FROZEN and only ever extracts.** Fine-tuning something trained on millions of
  recordings with two hundred of your own mostly destroys what it knew. So `discogs-effnet` (ONNX,
  via onnxruntime) turns each two-second patch into one 1280-d vector and nothing else, and every
  bit of learning happens in a small head on top — a few hundred examples by a few thousand
  dimensions, which trains in a browser tab. It is also exactly how the model's licence asks to be
  used: unmodified.
- **A stored vector is three summaries of the patches** (`embedding._aggregate`, v3, 3840): their
  mean, their spread (v2 stopped at those two) and the mean over the LOUD HALF of them — the patches
  at or above the upper median RMS (`patch_loudness`, `loud_half`), by rank because a drop sits only
  ~3 dB over a kick-only intro under the same limiter (measured on an arranged track through the
  real front-end, `test_the_loud_half_is_the_drops`: every patch inside a drop picked, none outside).
  A genre is decided where the music is IN; the whole-track mean spends as much of itself on the
  intro, the breakdown and the outro. The first 2560 numbers ARE the v2 vector, value for value,
  and the loud block weighs what the mean block does — so a v2 head reads a v3 vector's prefix
  (`genre._PREFIX_OK`), the prototypes compare the shared part (`embedding.common_part`), and
  `/genre/embeddings` serves v2 and v3 at their own widths. The studio trains on ONE width: the loud
  block is a candidate only when every labelled row has it, and is kept on a point of gain over the
  prefix alone (quick linear heads, same folds and seed), before tempo and construction are judged
  on top of the width that won. v2 vectors are re-extracted by the library backfill like v1 ones were.
- **The model is never vendored and never fetched silently.** It is a third-party artefact with its
  own licence (CC BY-NC-ND), so the operator supplies a copy they obtained themselves — imported
  from the studio's **Extracteur** card (`POST /api/genre/extractor`, admin-only, stored in
  `<cache_dir>/models/discogs-effnet-bsdynamic-1.onnx`) or pointed at with `[deezer] embed_model`.
  It must be the **dynamic-batch** ONNX export
  (`https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bsdynamic-1.onnx`):
  the front-end feeds however many patches a track yields, and the `-bs64` export declares a fixed
  batch of 64, which onnxruntime refuses — `validate_model` rejects it with that sentence rather than
  letting it fail at inference. onnxruntime is an optional dependency
  (`pip install 'supysonic[embedding]'`, and in the Docker image): without it the module reports
  itself unavailable and the heuristic classifier keeps doing its job unchanged.
- **The front-end is the dangerous part.** A mel-spectrogram with the wrong window, scale or
  normalization yields vectors that look perfectly healthy and mean nothing. The parameters are the
  published MusiCNN ones (16 kHz mono, 512-sample Hann, hop 256, 96 Slaney mel bands,
  `log10(10000·x + 1)`, 128-frame patches), and since "looks healthy but is wrong" is the failure
  mode, `deezer embed --self-test` checks it without a reference implementation: two halves of the
  SAME track must embed closer to each other than to other tracks.
- **Extracting needs the optional dependency; USING what was extracted must not.** `load_embedding`,
  `save_embedding` and `encode_embedding` are plain `struct` ("e" is float16), and `genre.predict`
  is plain Python. An archive copied from a server that had onnxruntime is a perfectly good training
  set on one that does not — and that is also why the studio's candidate list is never gated on the
  extractor.
- **Training is the browser's job, in a Worker, on RUST** (`lib/genre/trainer.js` → `worker.js` →
  `core.js` → `webapp/trainer`, compiled to `trainer.wasm` / `trainer-simd.wasm`). Seconds of solid
  arithmetic on the main thread is not a progress bar, it is a freeze. Three modes: a linear softmax
  head (the right default), and a **generic stack of dense layers** for the genres a plane cannot
  separate — hardtekk against frenchcore, zaag against uptempo — with one hidden layer (256) or two
  (2×512): the second bends a boundary the first only bent once. The WHOLE run is in the crate —
  folds, bags, the projection and its retry, the temperature, the confusion matrix — stepped an
  epoch at a time so the worker reports progress, and SEEDED (one generator for the folds, every
  shuffle and every initialisation), so a run repeats exactly. It replaced two JavaScript trainers
  and a C kernel, kept as the ORACLE in `test/reference/genre-*` (`genre.test.mjs` holds the two to
  the same scores, seed for seed). Three things came out of the port, each measured:
  - **Loop minibatch-major.** The per-example loop re-read the whole weight matrix for every example
    (300 KB for thirty genres over the full embedding, MB for a hidden layer) and was bound by
    memory: each weight row is now dotted with four examples per read (`linalg::dot4`/`axpy4`, the
    same sums in the same order), over the batch. Linear head, 12 genres × 15 tracks, full width:
    **9.5 s → 0.66 s**; 30 × 20 with the full-width retry **136 s → 9.3 s**; the dense stack against
    the SIMD C kernel **1.1 s → 0.62 s** (10 × 12, 128 hidden).
  - **A softmax error under 1e-20 is flushed to zero** (`train.rs#TINY`). Once a head is sure, the
    wrong classes' probabilities fall to ~1e-40: SUBNORMAL in f32, and every multiply-add touching
    one takes the processor's slow path — 1 GMAC/s against 8, on exactly the noisy data that trains
    longest. The JavaScript computed in f64 and never met them; each gradient also carries its L2
    term (~1e-5), so nothing measurable is lost.
  - **The bag's held-out logits are AVERAGED, as the shipped head is.** The JavaScript summed a bag's
    members there, so the temperature was fitted on logits three times too large and the head the
    server read came out that much too diffident — its good calls fell under the 0.45 gate. Measured:
    the oracle's T went ~1.2 without a bag and 2.00 with one; the Rust stays at 1.11-1.15 either way.
  Two builds, baseline and SIMD128, computing the SAME bits (the scalar loops keep their partial
  sums where the vector lanes keep theirs; the test trains one head with each and compares weight
  for weight); `build.rs` hashes `src/*.rs` and the test fails on a stale binary, like the analyser.
- **Folds by ARTIST are automatic** whenever most genres have two artists (`health.js#canGroup`,
  `cv::grouped`, `artist_id` on `/genre/labelled`). Two tracks off one album share a production and a mastering chain; with
  plain stratified folds one trains the head and the other then "tests" it, so the score measures
  recognising albums — and the temperature fitted on those easy calls leaves the head over-confident,
  which is what the server gates on. Measured on artists whose own sound outweighs their genre's:
  stratified 0.96-0.98, by artist 0.74-0.83, T 0.60-0.68 against 1.00-1.23. The table then shows
  how many ARTISTS each genre's examples come from; a genre with one cannot be tested on anyone else
  and says so with a recall of zero. `/genre/labelled` is the WHOLE labelled set in one statement:
  it was capped at the 500 newest tags (training silently ignored the rest) and read each row's
  artist and album back lazily (1 022 statements for 510 tags, now 8).
- **Training watches itself, and says so in one verdict** (`lib/genre/health.js`, pinned by
  `test/genrehealth.test.mjs` on trainer runs built to have each fault). BEFORE it trains it removes
  what would bias the head or flatter its score — a genre under 5 tracks (left out, still taggable),
  the same recording tagged twice (`vectorKey`: one copy kept) or tagged two ways (neither), one
  artist over 40% of a genre (its newest tracks kept up to the cap). AFTER, the trainer reports each
  fold's fit on its OWN training rows (`fitBalanced`, `tr_res[10]`) and every row's held-out logits
  (`tr_held`): the gap between the two is memorising (measured: labels unrelated to the audio read
  1.00 trained / 0.21 held out), the stratified-minus-by-artist score is the artist bias (1.00 /
  0.18 on genres that are really artists), and a label the held-out head confidently puts elsewhere
  is offered for review (*Revoir ces titres* runs them through the tagger with their tag shown).
  `assess` turns it into good / à surveiller / peu fiable and at most three remarks with what to do;
  the tables are under *Détails*. The mode is **Automatique**: the linear head, and a 256-wide
  network only with ten tracks a genre and kept only on two points of held-out gain. A "peu fiable"
  model asks before it is sent; `metrics.health` (level + causes) is stored with it.
- The linear trainer's **random projection is decided by the score**, not assumed: it is free on
  clustered data (1.000 at 4× the speed) and costly on marginal data, so it trains projected and
  re-runs at full width when balanced accuracy comes back under 0.8. The deep trainer keeps the same
  code path but defaults it OFF — measured, projecting to 384 cost ten points (0.890 against 0.998)
  to save five seconds, and five seconds is not worth ten points on the one path that exists
  *because* the accuracy was not enough.
- **A stored head reaches the WHOLE library, without a re-measure** (`analysis.reapply_head`,
  `webui/genre.py#start_relabel`, `/genre/relabel`). A verdict used to be frozen at the moment a
  track was measured, so a model trained today reached only what was archived after it — the rest
  took *Reclasser tout*, hours of ffmpeg for an answer that needs none of it. Every input of the
  decision is stored (the measures `classify` reads are in the row's data, the vector is the
  sidecar, the tag is a row), so storing or disabling a head re-decides every verdict from those
  (`redecide`, one decision function `_decide_style` shared with the analysis) on a worker, resumed
  on boot when the library was last re-decided under another head (`relabel_if_stale`, Meta
  `genre_relabeled`). `genre.predict` runs on numpy when it is there (it comes with the extractor):
  a two-layer head is 60.7 ms a track in plain Python and 0.36 ms in numpy (a linear one 2.6 → 0.10),
  the same logits to 1e-15. A tag
  set or removed re-decides its row at once — a removed tag used to leave the row naming the tag's
  genre with the source "tag", served as somebody's choice by nobody. And a head the server cannot
  read back no longer switches the working one off on the way (it was retired before the check).
- **The DEVICES are told** (`analysis.verdict_generation`, `gen` on `/api/analyses`,
  `lib/analysis.js`): the player keeps verdicts in localStorage and never re-asked one it had, so a
  re-decided library never reached a phone. A re-application that changed anything bumps the
  generation, and a device drops everything it kept the moment an answer carries a new one; any
  kept verdict is also asked again after a day.
- **When the head hesitates between SIBLINGS, it serves their family** (`genre.decide`). Rawstyle
  0.45 / Rawphase 0.40 is 85% sure the track is raw and unsure only which raw; the label gate
  (margin < 0.12) sent it to the heuristic, the weakest of the three sources. The studio ships each
  label's family with the model (`metrics.families`, from `style.js#genreOf`); the server sums the
  probabilities per family and serves the family id under the same gate (`styleLevel: "family"`).
  A label with no family, or a family the server does not know, votes for nothing.
- **The head can also read how the track is BUILT, and its tempo** (`lib/genre/construction.js`,
  `deezer/construction.py`, `genre.assemble`). The frozen extractor hears timbre well and tempo
  poorly, and Discogs has no Pieep and no Deutscher Krach — what separates those is what the live
  analyser reads kick by kick. A `ConstructionMeter` averages thirteen of its descriptors (`kickF0`,
  `piep`, `tail`, the lead, the buzz, rolls, four on the floor, the kick-shape weights…) over the
  frames where the grid is locked and the level is up (≥ 1900 of them, ~20 s), fed by the PLAYER at
  the smart level (thirteen additions a frame, posted on the next track to
  `POST /api/analysis/<id>/live`) and by the studio's own measurer (`measure.js` + a worker running
  the same `rhythm.wasm` over a decoded Opus 128 copy, for tagged tracks nobody played that way —
  several tracks at once, one worker each, `measureParallelism`: half the cores, two on a 4 GB
  device, never past the server's four background threads).
  Measured through the shipped binary: piep 0.95 on the pieep record against ≤ 0.10 everywhere else;
  kick pitch 63 Hz on techno against 173-175 on uptempo and Krach; four on the floor 0.90-0.95 on
  every 4/4 record against 0.33 on dnb. The summary is a `<track>.live.json` beside the audio,
  clamped, merged as a frame-weighted mean whose post weight (`MAX_FRAMES_PER_POST`) and stored
  weight (`MAX_WEIGHT`) are capped — once two plays are in, no post moves it more than a third of
  the way — and only for a track the caller may read and that is archived. The head's input is the
  embedding, then `log2(bpm/120)` and the thirteen, each standardised on the training set, clipped
  to ±4 and scaled by **0.3** (measured on genres that differ only by tempo and piep: 0.1 learns
  them partly, 1.0 starts trading the embedding's genres for noise), then ONE flag for "no summary".
  The studio decides whether to use them at all: a quick linear head with and without, same folds
  and seed, kept only on a gain of a point. The layout ships as `metrics.inputs` and the server
  rebuilds it number for number — a shared literal in `construction.test.mjs` and `test_webui.py`
  holds the two to it, and `PUT /genre/model` refuses inputs that do not add up to the head's width.
  A summary arriving re-decides its row at once; the candidate scan JOINS the served tempo.
- **The CSP had to be widened by exactly one token.** `script-src 'self' 'wasm-unsafe-eval'` permits
  WebAssembly compilation and nothing else — not `eval()`, not `new Function`, not inline script.
  Without it `WebAssembly.instantiate` is refused outright and deep training cannot run at all.
- **A model travels as ONE FILE** (`supysonic/webui/genreshare.py`, the *Partager le modèle* card on the
  Modèle tab): `/genre/share/export` writes the genres, every label (genre + Deezer id, YouTube id, or
  artist and title for an upload) and the active head; `/genre/share/preview` then `/genre/share/import`
  read one back. The two halves serve different cases: the head serves at once but only where the
  vectors live in the same space (same extractor, a width this server reads — refused at the preview,
  and `genre.store_head` still stores, re-reads and refuses before the working head is retired); the
  labels outlive any extractor and ADD to the receiver's tags — a track already tagged here keeps its
  tag, a track missing here is made from Deezer's record (no download), Deezer unreachable is
  "non récupéré", never a verdict. Everything in the file is someone else's text: bounded, typed,
  colours and archetypes validated, ids checked. `tests/test_genreshare.py`.
- **The untagged library teaches too, but only where it EARNS it** (self-training: `tr_pseudo` in
  `webapp/trainer`, `/genre/pool`, the *Apprendre aussi des titres non étiquetés* box, on by default).
  The studio fetches up to 600 untagged tracks that have a vector (most played first) and appends them
  as class −1. Per fold, the fold's OWN head labels them (never a head that saw the fold's test rows),
  and a second head trains on the fold plus the pool rows it is ≥ 0.9 sure of — at most 3× a genre's
  own examples, each weighing half a tag. That second head ships only if its held-out balanced
  accuracy beats the first by a point; otherwise the first ships, bit for bit (its tasks run before
  any pool fit, same seed, same folds). Untagged rows change nothing when it is off (pinned in Rust
  and in `genre.test.mjs`). Measured on overlapping synthetic genres, scored on rows neither head saw:
  four tags a genre 0.537 → 0.625; eight and more, within a point — hence the gate.
- **One tag per track, admin-only, one model.** A track labelled both frenchcore and uptempo teaches
  the head that the two describe the same sound; a track that genuinely sits between them is better
  left out. And two users disagreeing about what hardtekk is would train the single shared model
  against itself.
- The studio ships the head as base64 float16 (`encodeHead`: `W, b` for a linear head, `W1, b1, W2,
  b2` for an MLP, `W1, b1, W2, b2, W3, b3` for a two-hidden-layer one) and `PUT /api/genre/model`
  **refuses a head it cannot read back** — it stores, re-reads, and deletes the row if the weights
  do not match the labels and dim given. A model stored but unusable would silently do nothing for
  ever.
- Tagging is **confirming, not typing**: every candidate arrives with the vocabulary RANKED FOR IT
  (`scores`: `[label, score, head, proto]`, `deezer/genre.py#rank_scores` — the head's calibrated
  probability blended 3:1 with a softmax over the prototype similarities, so a genre two tracks old
  ranks before any head knows it; `lib/genre/rank.js` orders the rest by use in the library, never by
  name). The nine best are big buttons on `1`…`9`, `↵` takes the first, `/` searches every genre
  (accents folded, rank kept inside each tier), recent genres sit one tap away, `z` undoes the last
  label, and `GET /genre/track/<id>` gives the tag sheet the same ranking for one track (it used to
  read the whole labelled set to find one row). The candidates come ordered by play count (the labels
  that matter are on the music this library actually plays), `→` skips, `espace` previews, and the
  preview jumps a third of the way into the track — nobody judges a genre from the intro. The
  preview carries a **seek bar that follows the element's own clock**, so it stays true to whatever
  the stream/transcode pipeline is actually delivering: its length falls back to the candidate's
  known duration when the stream reports none, and a seek on a not-yet-seekable source is chased
  and landed as soon as the buffer allows rather than being dropped. The preview shares the
  player's volume, with its own slider. The button is in Réglages → Animations → Analyse rythmique.
- **Tagging is reachable from wherever the track is.** The studio is for a tagging pass; the other
  moment is noticing a wrong genre while listening or scrolling a list, so an admin also gets
  *Étiqueter le genre…* in any track's three-dot menu (`actions.buildTrackMenu` → `openGenreTag`),
  opening the same global sheet over the current screen, plus the quiet tag button in both
  now-playing views.
- **A whole album, playlist or artist is tagged after a REVIEW** (`components/GenreBulkSheet.svelte`,
  loaded on first use; `/genre/bulk/preview` then `/genre/bulk`). A Frenchcore album is Frenchcore
  nearly always, and "nearly" — the intro, the collab, the closing ballad — is exactly what a blind
  bulk tag would teach the head to confuse. The preview says per track what it already wears
  (another tag is a disagreement) and what the head thinks: a disagreement only past the analysis's
  own gate AND for a tag the head knows (a head that never learnt Hardtekk is confidently something
  else on every Hardtekk track), compared at family level when the head is only sure of the family.
  Disagreements come unticked; only the listed tracks are tagged (an artist scope previews every
  library row of that artist but is never APPLIED by scope), one tag per track, in one transaction;
  the verdicts are re-decided on a worker and the devices told through the generation. Tracks not in
  the library are counted, not created — favouriting the album archives them. Statement counts are
  pinned: the tracks, their tags and the head, not a query per row.
- **Each genre can open a short list of its textbook recordings** (`deezer/references.py`,
  `/genre/references`, the disc button on a row of the *Genres* tab), because a genre's first eight
  examples are the hardest to find in a library nobody sorted by genre. The curated list's rule is
  that **nothing in it is a guess**: a pair is there only if that recording exists under that artist
  and the genre's literature names it. The scenes with no sourced list at all (Pieep, Hardtekk,
  Zaag, Uptempo) have NO track list — a test says so — and a few scenes list their established
  artists instead, as links to artist pages where bulk tagging (with its review) takes over.
  **The sub-genre lists are the other half** (`deezer/subgenre_tracks.py`, merged into
  `REFERENCES`): ~120 sub-genres, ~1 090 pairs, hand-written from published essentials, DJ
  tracklists, forum threads (Psynews) and, for Deutscher Krach, the scene's own label's release list
  — each group names its sources and says when it is under ten. They are NOT a canon: no artist is
  filed under a genre from its titles alone (Dr Donk's Bandcamp was, under Zaag, and it was wrong).
  **They are the DEFAULT sounds** (`webui/genre.py#start_sounds_if_due`, `/genre/sounds`): on the
  first admin visit after the lists change, each pair Deezer carries is imported and tagged with its
  sub-genre unless the track already wears a tag — one tag per track, so a sound somebody chose is
  never overwritten — then re-decided in one pass like a bulk tag. Nothing is downloaded (a tagged
  row is archived when played or by the labelled backfill); five Deezer failures in a row stop the
  run, unrecorded, retried after ten minutes. The user tags more on top. Every pair is looked up on Deezer when shown and offered
  only if the artist AND the title match (`references.match`: accents and punctuation folded, the
  title at a word start, a live take or a remix only when nothing else is there, never a cover); a
  pair Deezer does not carry reads "introuvable", never whatever the search returned. Answers are
  kept a day; an unreachable Deezer returns the list unchecked and caches nothing. Importing one
  (`/genre/references/import`) makes the row from Deezer's record, tags it and queues the archive,
  which is where it gets the vector that makes it a training example.
- **The genre chip reads the SERVED verdict** (`webapp/src/lib/trackverdict.js`). It used to read
  the live classifier only, so it needed the analysis engine running, the `smart` scene selected AND
  the classifier past its confidence floor. The served genre is the genre now (the analyser pins it),
  and the only one: a track the server has no genre for shows none.

**Genre hierarchy (multi-provider lot O)** (`supysonic/genretree.py`, `supysonic/deezer/genre_tree.py`,
`webui/genre.py` `/genre/tree*`, `webapp/src/lib/genretree.js`, `components/GenreTree.svelte`, the *Arbre* tab of
the studio). Genres form a DAG: `genre_parent` (weighted multi-parent edges, 1 = outright sub-genre) and `genre_alias`
(schema `20261021`). The engine's *family* is the nearest ancestor that is a `FAMILIES` label. The tree is cached
in the process, rechecked against `Meta genre_tree_v` (30 s TTL); a server whose tree was never seeded answers from a
VIRTUAL tree built from the default data, so verdicts are identical on an upgraded server until the admin edits it
(`seed_tree`, run on the admin's first look, also creates the shelves as tags; the vocabulary seed alone writes no
tree). `genre.decide` climbs ancestors (level `ancestor`, roots excluded) when the head hesitates; `rank_scores(last=)`
lifts the last pick's parent and siblings. Every write bumps the version, tells the devices and relabels only if a
head is active; the undo log is compact per-key `Meta` rows (256-char limit). The SPA mirrors the tree
(`refreshTree` on a verdict-generation change) and `genreOf`/`skinId` fall back to the nearest known ancestor.
`tests/test_multi_o.py` pins statement counts and the unchanged verdicts; `node test/genretree/run.mjs` is the bench.

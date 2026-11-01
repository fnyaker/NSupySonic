# Whole-track analysis (server side)

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching deezer/analysis.py, beats.py, ANALYSIS_VERSION, the analysis backfill, or tempo/genre verdict serving.

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
  Without numpy the envelope estimator below still answers. A version bump no longer re-measures at boot: the stale rows
  are picked up by the nightly window (see *Library maintenance* at the end) or the button.
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
  answer**: the client pins the family and locks the tempo (see *The server's answers are locked*
  below) and classifies or estimates neither again — its live classifier only speaks for a track the
  server has no genre for.
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

## Library maintenance: stamped versions, a nightly window, zero impact

**Every stage of a track's analysis carries the generation that produced it**
(`TrackAnalysis.version` = `ANALYSIS_VERSION`, `embed_version` = `EMBED_VERSION` when the stored
vector is the current layout, `decided_head` = the genre head the verdict was last decided under,
"none" for no head). `webui/analysis.plan()` answers "what is out of date, and at which step" with
SQL counts only (never a file read) — `unmeasured`, `stale_measure`, `stale_embed`, `stale_decide`,
`todo` (distinct tracks), `current` — served at `GET /api/analysis/plan` with the schedule. Rows
written before the stamps (0 / NULL) are stamped by the first pass that finds them current
(`backfill_embeddings`, `redecide`), so they cost no ffmpeg. When the model changes only the LAST
stage re-runs (`reapply_head`, no audio); when the measure changes, the whole track.

**One entry point, `webui/analysis.start_job`**, is what the button, the boot resume and the nightly
window all go through, so they cannot disagree. The job runs the stages in order of cost — measure,
embed, re-decide (`start_relabel`) — each resumable (checkpoint) and each unit gated by a
`workload.Throttle`:

- **The gate (`Throttle.wait`)** blocks while a download a person waits on is running
  (`foreground_busy`), while audio was requested in the last 45 s (`touch_listening`, set by a
  `before_request` hook on `/api/stream/*` and `/rest/stream|download`, prefetches excluded), or
  while the 1-minute load per core is above the mode's ceiling. It is checked BEFORE each unit, so
  at most one 3 s ffmpeg is in flight when somebody presses play. Tracks that are already current
  never touch the gate (a scan of a finished library is not slowed).
- **The duty cycle (`Throttle.spent`)** rests `elapsed × (1/duty − 1)` after each unit. `night`
  (scheduled window) is duty 0.9, load ceiling 0.75, workers auto; `now` (the button, mid-day) is
  duty 0.5, load ceiling 0.6, at most 2 workers.
- **CPU and disk**: `renice` now also puts the thread in the idle I/O class (`ionice_idle`,
  ioprio syscall; x86_64/aarch64 only, silent elsewhere) — ffmpeg children inherit both.
- **Stopping is clean**: `POST /api/analysis/backfill/stop` (or the window closing) makes the gate
  return False; the walk leaves WITHOUT writing the checkpoint for the page in hand, so the next run
  re-walks that page (finished tracks are current and skipped).
- **The nightly window** (`schedule_loop`, Meta `analysis_schedule`, `PUT /api/analysis/schedule`,
  default 03:00 for 6 h, enabled): once per window-day, polled each minute so a settings change
  applies at once and a restart inside the window joins it. A window that crosses midnight belongs to
  the day it opened on. It does nothing when `plan().todo` is 0.

# The genre studio (embeddings, trainer, tagging)

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching embedding.py, genre.py, the Rust trainer, tagging UI, bulk tagging, references/default sounds, or the relabel pipeline.

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
  the same `rhythm.wasm` over a decoded Opus 128 copy, for tagged tracks nobody played that way).
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
  the classifier past its confidence floor. The served genre is the genre now (the analyser pins it);
  the engine's own reading only names a track the server has no genre for.

## Studio layout (redesign, three tabs)

The studio is **Bibliothèque / Étiquetage / Modèle**. There is no *Genres* tab any more: the
vocabulary is the engine's (seeded server-side, see above) and nobody adds or removes genres by
hand. The `/genre/tags` CRUD endpoints still exist (admin-only) but no screen calls them.

- **Bibliothèque** (`components/GenreLibrary.svelte`): one number ("N sur M titres à jour"), a
  stacked bar (à jour / à remettre à jour / jamais analysés), one button (*Analyser maintenant* ↔
  *Arrêter*), the three pipeline steps with their own bars (Mesure → Empreinte → Classement), the
  nightly window (`PUT /analysis/schedule`) and, under *Avancé*, parallelism, "tout remesurer" and
  the extractor (`GenreExtractor.svelte`). Data: `GET /analysis/plan` + `GET /analysis/backfill`
  (`stage`, `paused` = why the gate waits). See *Library maintenance* in `server-analysis.md`.
- **Modèle**: a per-genre readiness chart (examples against the minimum) replaces the prose, then
  mode / train / verdict / send. The "Mesures" and "Extracteur" cards moved to *Bibliothèque*.
- Shared panel styles live in `lib/studio.css` (`st-` prefix, global). Not visually verified in a
  browser in the session that wrote it (no Chrome extension available): check the layout once.

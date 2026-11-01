# Genre graph and genre radios

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching `deezer/genregraph.py`, `deezer/radio.py`, `webui/radio.py`, `routes/Radio.svelte`, or anything that wants "how alike are two genres".

- **`genregraph.py` is data first**: `TREE` (indented hierarchy, 226 vocabulary genres plus a few
  structural groupers like "Hard dance") and `LINKS` (`A | B | weight`, lateral ties). Similarity is
  the best path through both, product of weights (`TREE_W = 0.8` per parent/child hop), so it decays
  with distance. `tests/test_radio.py` fails if a genre of `analysis.known_genres()` is missing from the
  tree, if a name is placed twice, or if a link names an unknown genre. Weights are judgement from
  the scene's own literature (sources in the module docstring), not measurement: adjust them, don't
  treat them as truth. **Adding a genre to `FAMILIES`/`EXTRA_GENRES` means adding it to `TREE`.**
- **`expand(seeds, spread)`** turns a style request into weights: a seed and its whole branch
  (1.0 / 0.9), then neighbours down to `1 - 0.7·spread` (never below 0.3: a full dial still never
  reaches strangers — measured, 0.1 let jazz into a hardcore radio).
- **`radio.build`** reads only the library: `TrackAnalysis.style` (family id or label, mapped by
  `style_label`) with confidence ≥ 0.3, a hand `TrackTag` outranking it. Score = genre weight^1.5 ×
  taste × tempo fit. Taste (`radio.taste`): plays, stars, artist affinity, ×0.2 if played in the last
  two days, its pull shrinking and the unheard gaining as discovery rises. Picking is Gumbel-noise
  weighted sampling without replacement (`randomness` 0 = a plain ranking), then an artist gap of
  4. Discovery also reserves up to 60% of the queue for the neighbours (`pick`), a thin core hands its
  slots over. `seed=` repeats a queue exactly.
- **Endpoints** (`webui/radio.py`): `GET /api/radio/genres` (tree + counts), `GET|POST /api/radio/genre`
  (`seeds`, `discovery`, `randomness`, `count` ≤ 100, `bpm_min/max`, `seed`). Open to every logged-in
  user (guest queues come from their own stars; nothing calls Deezer). Numbers are clamped, seeds
  validated against the graph (≤ 8).
- **SPA**: `/radio` (`routes/Radio.svelte`, in the sidebar): families → sub-genres, three discovery
  notches (0.1 / 0.45 / 0.9).


## The explorer (`deezer/explorer.py`)

- **Only genres the engine knows** (`analysis.known_genres()`), weighted by closeness (graph
  similarity) to what the listener plays and by how little the library holds
  (`target_weights`). Empty library: all equal.
- **Per genre**: Deezer playlists named after it first (curated), then a plain search; unseen
  tracks with a `preview`; sampled at random. Preview = https on `*.dzcdn.net|*.deezer.com` only,
  no redirects, 3 MB cap (`fetch_preview`).
- **Verified, not trusted**: `analysis.analyze_file` (same spectral/tempo/extractor/decision as the
  library) must give a style with graph similarity ≥ 0.75 to the target and confidence ≥ 0.4,
  else the track is stored `rejected` (never fetched again). Keepers are `Discovery` rows with the
  API track dict as payload. **Nothing is archived** — playing one archives it like any play (the
  client's prefetch of the NEXT queue item counts as the play to come); `archive` setting = archive
  at bulk priority as soon as verified.
- **Gate**: `explorer.loop` wakes every 10 min and runs a batch only if the pool is under `pool`,
  no audio was requested for 5 min, no foreground download runs and load/core ≤ 0.5; inside a batch
  every unit goes through a `Throttle` and Deezer calls are 1.5 s apart. Deezer down = stop.
- **Radio**: at discovery d, up to `d × 0.35` of the queue are pool finds matching the style
  (`pick_discoveries` / `mix_discoveries`, flagged `discovery: true`, never first).
- Admin switches: `GET|PUT /api/radio/explorer` (`enabled`, `archive`, `pool`), shown at the foot
  of `/radio` for the admin. Table `discovery` (schema `20261102`).

## Recommendations and track radios from the same engine

- **`GET /api/recommendations/library`** ("Pour vous" on Home, every user): `listener_profile`
  (stars ×3 + log play counts per genre) → `favourite_genres` (weighted DRAW, so each visit differs,
  one per top-level family while possible) → a `radio.build` mix per genre at discovery 0.3 and
  randomness 0.7, plus a wide "Découvertes" mix (0.9) on the favourite family. `?seed=` repeats it.
- **`GET /api/radio/track/<id>`** now BLENDS Deezer's mix with `radio.similar` (same genre, ±8% of the
  track's tempo, the seed excluded, randomness 0.6): ~60% library, Deezer's tracks dealt in at random
  places. Deezer down → the library part alone answers instead of an empty list; an unanalysed seed
  → Deezer's mix unchanged.

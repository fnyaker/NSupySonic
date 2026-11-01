# App core (Rust): sync estimators, track-list index, big-list cost

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: touching webapp/appcore, party/clock/anchor estimators, tracklist.js, TrackList windowing, apicache.js.

**THE APP CORE IS RUST TOO** (`webapp/appcore`, compiled to `src/lib/appcore/appcore.wasm`, reached
through `lib/appcore/core.js`). The interface's own logic — not the DOM, the logic — where the
JavaScript allocated as it went, on the main thread, in the paths that must not stutter:

- **`sync.rs`: every time-sync estimator the app has.** The listen party's NTP clock
  (`party/clock.js#ClockEstimator`), the host's line (`party/anchor.js#AnchorFit`), the guest's
  audio-clock bridge (`party/engine.js#makeClockBridge`) and the output clock the animations, the
  lyric line and the party host share (`audio/latency.js`). Each did its robust statistics the
  obvious way — a median was `[...xs].sort()`, an estimate built and dropped four to six arrays — many
  times a second, in the one subsystem where a collection pause is a late chunk. Now fixed rings,
  nothing allocated once built: an estimate 16.3 → 1.4 µs, the host's add-and-read 1.13 → 0.19 µs.
  What stays in JavaScript is the READING (only the browser can call `getOutputTimestamp()`) and, for
  the output clock, a mirror of its outputs refreshed after each reading, so the dozens of reads a
  second never cross into the module. The timeline's one-line arithmetic (`party/timeline.js`) and the
  engine's Web Audio orchestration stay JavaScript on purpose: a call into wasm costs more than
  `t.p + (S - t.t) / 1000` does, and nodes can only be scheduled from JavaScript.
- **`tracks.rs` + `fold.rs`: the track lists' search and sort** (`lib/tracklist.js`, used by
  `TrackBrowser.svelte` and `Playlist.svelte`). The lists lowercased every title, credit and album of
  every row on EVERY keystroke (12 000+ strings on a 4 000-track favourites page) and again inside the
  sort comparator — and the answer was wrong for a French library: a code-unit comparison put "Éric"
  after "Zazie", and "beyonce" did not find "Beyoncé". Now a list is indexed once when it changes
  (reconcile.js keeps its identity when it did not): every field FOLDED — case and accents dropped,
  ligatures spelled out, typographic quotes made plain — into one buffer, each sort order computed on
  first use and kept, a keystroke one pass over folded bytes. Measured on 4 000 tracks: a keystroke
  0.46 → 0.11 ms, a keystroke under a sort 0.62 → 0.20 ms, for a 2.3 ms build paid once. The
  unfiltered, unsorted view never touches the core — it is the list itself, the same array — and a
  page without WebAssembly still filters and sorts the old way (`tracklist.js#fallback`).

How it is loaded and shipped: **a separate module from the analyser**, on purpose — that one is
200 KB and loads when an animation needs it, this one is 63 KB (23 KB gzipped) and a party guest with
every animation off, or anybody searching their favourites, needs it at once. `main.js` fetches it
once the first screen has painted; hosting and joining a party await it (`routes/Party.svelte` loads
it on the landing screen, since the tap that joins must create the AudioContext synchronously, and a
session started without it starts its clocks a moment later); the output clock simply takes no
reading until it is in, which is what "no mapping yet" always meant. Every object is a HANDLE freed
by `free()`, with a FinalizationRegistry behind it for a handle whose owner was collected unfreed.
No dependencies, `build.rs` stamps a hash of `src/*.rs`, the binary is committed and
`test/appcore.test.mjs` fails when it is stale — the rhythm crate's rules exactly. That test holds
each estimator to its JavaScript ORACLE (`test/reference/sync.js`) number for number on the traces
it exists for (heavy-tailed asymmetric queueing between clocks 60 ppm apart, a device that slept, an
element read from a jittery timer through seeks and stalls, a context rendering in bursts whose
mapping steps and drifts), the index to a model of what folding means (Unicode's own decomposition,
marks stripped) on every sort, direction and query, and both to being faster. `party.test.mjs` and
`latency.test.mjs` run on the Rust; `test/party/run.mjs` and `test/rhythm/run.mjs` were re-run on it
(guest heard −1.1 / +0.1 / +0.1 / −0.3 ms from the host steady / after a seek / a pause / a skip;
frames −0.7..+0.6 ms against the output clock, 100% on time).

**What a big list costs the main thread is measured in a browser too** (`webapp/test/ui/run.mjs`,
long-task time under a 4x CPU throttle, median of five rounds). Two causes came out of it that no
language change would have touched:

- **The window's rows are keyed by POSITION** (`TrackList.svelte`), not by track. Every keystroke of a
  search (and every sort) handed the window a different track at each position, so all ~30 visible
  rows were destroyed and rebuilt — DOM, five store subscriptions, a cover and an artist line each —
  and that, not the filtering, was the keystroke. Recycled, a row just gets a new `track`: `Cover`
  already resets on a new source, and `TrackRow` drops a gesture begun on the previous track so a
  swipe can never commit on the wrong one. Ten letters typed into 4 000 favourites: **470 → 55 ms**.
- **The offline cache stores the response's TEXT** (`apicache.js`). IndexedDB structured-clones what
  it is given, synchronously, and a 4 000-track list is 4 000 nested objects — cloned on every visit.
  The text comes from a `clone()` of the response, read after the caller has its data: `res.json()`
  parses straight from the bytes, and putting `text()` + `JSON.parse` on the critical path measured
  WORSE than the clone it replaced. Records an older build wrote as objects still read. Opening the
  favourites: **315 → 154 ms**; the playlist 304 → 216; a sort 97 → 52.

**Why the DOM stays Svelte.** "As much Rust as possible" stops at the DOM, deliberately: a Rust UI
framework reaches the DOM through JavaScript glue on every node it touches, so it cannot render a list
or a player faster than Svelte's compiled DOM calls — measured frameworks land level with it at best —
and it would put a few hundred kilobytes of wasm in front of the first paint that the code-splitting
work above took out. Rust goes where it wins: arithmetic over many values, state that must not
allocate, work that must be identical everywhere.

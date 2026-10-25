# Commands: tests, benches, builds

Reference notes for agents working on this area. Read [CLAUDE.md](../../CLAUDE.md) first: its process and rules apply here. Other areas: [docs/agents/](./).


```sh
# Python tests (no network). Discovery is driven by tests/__init__.py load_tests.
python -m unittest                                   # whole suite (~55s serially)
python -m unittest tests.test_deezer                 # one module
python -m unittest tests.test_webui.SomeClass.test_x # one test
python -m unittest tests.net.suite                   # network tests (hit real services; weekly in CI)

# Same suite across processes — ~12s on 4 cores. Takes the same test ids. What CI runs.
python tools/partest.py                              # whole suite
python tools/partest.py -j8 tests.test_webui
python tools/partest.py --coverage && coverage combine
NS_REQUIRE_FFMPEG=1 python tools/partest.py          # fail, don't skip, if ffmpeg is missing

# Dev install (a project .venv is expected)
pip install -e . && pip install lxml coverage        # == ci-requirements.txt

# Run the server
supysonic-server                                     # serves on :5722
export FLASK_APP="supysonic.web:create_application()"; flask run   # backend dev server

# Web UI (Svelte SPA)
cd webapp && npm install && npm run build            # -> supysonic/webui/dist (gitignored)
cd webapp && npm run dev                             # hot reload; proxies /api -> localhost:5000
cd webapp && npm test                                # node --test: the shipped rhythm analyser on real audio, the animation core against
                                                     # its JavaScript oracles, the catalogue/skins/drivers, the genre trainers, the cover loader.
                                                     # No test framework — but run the npm install above first: the modules under
                                                     # test reach svelte/store via stores.js, and a pretest guard says so in one line.
cd webapp && npm run wasm                            # rebuild rhythm.wasm + rhythm-simd.wasm from webapp/rhythm, appcore.wasm from
                                                     # webapp/appcore and trainer.wasm + trainer-simd.wasm from webapp/trainer (Rust,
                                                     # target wasm32-unknown-unknown). All five binaries are COMMITTED; npm test
                                                     # fails if they were not built from the sources next to them.
cd webapp/appcore && cargo test --release            # the app core's own unit tests (folding, the estimators' edge cases)
cd webapp/trainer && cargo test --release            # the genre trainer's (artist folds never split an artist, a seed repeats a run)
cd webapp && node test/eval/rhythm-eval.mjs          # the analyser on 28 arranged records with ground truth (beats, kicks, tempo, drops)
cd webapp && node test/eval/family-eval.mjs          # ...which genre the live classifier names on each ([--explain <id>] rule by rule,
                                                     # [--features] the descriptors): analysed once, cached, the rules replayed in JS
cd webapp && node test/rhythm/run.mjs                # ...and end to end in headless Chromium: AudioWorklet, delivery, timing
cd webapp && node test/rhythm/run.mjs --trim -60     # ...on a (simulated) short output path: the automatic look-ahead at work
cd webapp && node test/party/run.mjs [--fmt flac]    # listen party end to end: real server, host + guest, clicks detected on what
                                                     # each one PLAYS, scored on the shared wall clock (seek, pause, skip)
cd webapp && node test/remote/run.mjs [--phone] [--shots <dir>]   # remote control end to end: real server, owner + controller
                                                     # (make a link in the sheet, claim it, drive, drop the network, cut)
cd webapp && node test/render/run.mjs --world piano --genre frenchcore --bpm 200   # render bench: contact sheet in test/render/out/
cd webapp && node test/render/run.mjs --check        # every world, held to the picture contracts (headless Chromium, no GPU needed)
cd webapp && node test/render/run.mjs --strip        # the players' 40 px bar strip, photographed over the blurred cover
cd webapp && node test/ui/run.mjs                    # the lists' main-thread cost in Chromium on a 8000-track library (needs npm run build):
                                                     # open the favourites, type into them, sort, open a 4000-track playlist
cd webapp && node test/queue/run.mjs [--phone]       # the queue's editing in headless Chromium on a 4000-track queue: drag a row (mouse, or real touch
                                                     # events), drag to the far end with the list scrolling under the finger, the keyboard, clear
cd webapp && node test/player/run.mjs                # the sleep timer and the podcast speed on the audio elements the browser really plays (a fake page clock)
cd webapp && node test/output/run.mjs                # the audio path: routed by the full-screen player, the fault simulated (the element's clock 8% fast): convicted
                                                     # in one window, DIRECT on a fresh element and a fresh context, retried at a track change, forgotten when clean
cd webapp && node test/explore/run.mjs [--phone]     # the Explore screen: front page, into a genre, play a chart, back (Deezer's answers put in by the test)
cd webapp && node test/panel/run.mjs [--desktop]     # what is under the full-screen player: the swipe up (touch events), the desktop tab
cd webapp && node test/repeat/run.mjs               # repeat one / all on a 4 s track: an ARCHIVED file served by the real server (byte ranges,
                                                     # tools/perf_api.py --audio) and a live first-play stream, with the trim and the crossfade:
                                                     # every pass reaches its end, none jumps back from the middle, no dead air
cd webapp && node test/skip/run.mjs                 # a crossfaded skip in a HIDDEN page whose timers are throttled (the phone behind a car
                                                     # radio): the next track must be heard at once, graph and direct paths
cd webapp && node test/offline/run.mjs              # downloads kept by the Android app: an old Blob moved in byte for byte, played off
                                                     # /__nsoffline/, a new download, the Réglages list (a stand-in app; needs npm run build)
cd webapp && node test/clicks/run.mjs               # what a click costs before the screen answers (Event Timing, 4x CPU throttle): the
                                                     # nav, opening and closing the full-screen player; PHONE=1, PROFILE="<action>" for
                                                     # its heaviest functions (build with `npx vite build --minify false` to read them)
cd webapp && node test/vizdirect/run.mjs [FADE=1]   # the animations on the DIRECT output through pauses, skips and a reopening: they
                                                     # must still hear the music (the copy's dead-track bug)
cd webapp && node test/import/run.mjs [--phone]       # a shared playlist link: pasted into the search, read, played, kept
cd webapp && node test/requests/run.mjs             # what playing costs in requests: a track the server refuses (Deezer off) is
                                                     # retried at a human pace, not 70 times a second; a missing cover is asked once
cd webapp && node test/fullscreen/run.mjs           # the desktop full-screen player from 700x900 to 1920x1080: every control on screen,
                                                     # inside its column and the element a click at its centre lands on
                                                     # (the four browser tests above start tools/perf_api.py --serve; PYTHON=<venv python>, SHOTS=<dir> keeps pictures)

# Deezer CLI
supysonic-cli deezer login-test                      # check the ARL works
supysonic-cli deezer import <deezer-url|track|album|playlist <id>>
supysonic-cli deezer sync                            # import playlists/favorites/new releases
supysonic-cli deezer lyrics [--overwrite] [--limit N]  # archive synced lyrics for archived tracks
supysonic-cli deezer analyze [--force] [--limit N] [--workers N]  # measure tempo + style for archived tracks
supysonic-cli deezer bpm-audit [--limit N]             # Deezer's published BPM against the files' measured tempo, per style
python tools/tempo_eval.py --render /tmp/tempo          # the server's file tempo on the 28 arranged records + beatless tones
python tools/perf_api.py [--tracks 20000] [--serve]     # every screen's /api route timed on a big synthetic library (Deezer off):
                                                     # median ms, SQL statement count, bytes and gzip bytes per route
supysonic-cli deezer embed [--force] [--limit N]       # extract genre embeddings (needs onnxruntime)
supysonic-cli deezer embed --self-test                 # check the mel front-end without a reference

# Docker (full stack: builds SPA + python image, runs entrypoint that creates admin + auto-sync)
docker compose up --build                            # web player at :5722/app, Subsonic at :5722/rest
docker build -t nsupysonic:dev . && docker/smoke.sh nsupysonic:dev   # what CI checks before pushing
```

Note: the upstream `tests/` are unittest-based; there is no pytest config.
`tests/__init__.py` makes the suite fast in two test-only ways, each guarded by a test: it swaps
argon2 for cheap parameters (hashing was half the wall clock; `tests.managers.test_manager_user`
pins the production defaults), and it compiles each distinct werkzeug URL builder once per process
instead of once per rule per app (~95% of every `create_application`; `tests.test_harness` checks
every rule's URLs against a fresh werkzeug compilation). CI runs seven workflows:
- `tests.yaml` — two jobs, not a version matrix: **image** (Python 3.13, what the Docker image
  ships, with numpy, `NS_REQUIRE_FFMPEG=1`, under coverage, and the image's OWN ffmpeg binary —
  the job reads the pinned `FROM mwader/static-ffmpeg…` line out of the Dockerfile and copies
  `/ffmpeg` from it) and **minimal** (Python 3.10, the oldest `setup.cfg` accepts, bare install).
  Both via `tools/partest.py`, packed by the previous run's timings (Actions cache). A test that
  needs ffmpeg or numpy must RUN in the image job — a skip there is the suite testing less than it
  claims.
- `webapp.yaml` — `npm ci`, `npm test`, `npm run build`.
- `docker.yaml` — a PR builds amd64 only (no QEMU) and runs `docker/smoke.sh` on it; master and
  `v*` tags smoke-test amd64, then build and push both architectures. **ffmpeg in the image is a
  static build** (one file, no shared library): the apt layer that installed Debian's package was
  172 MB of the 281 MB compressed image, for a server that only needs audio. The smoke test checks every filter and
  encoder the app drives BY NAME and writes-then-reads every format it serves; bump the pin (it is
  the multi-arch index digest) and those two lists are what to re-check.
- `network.yaml` — `tests/net` (real third-party services), weekly and on demand.
- `android.yaml` — the native app APK, uploaded as a run artifact / attached to `v*` releases.
- `release.yaml` — on a `v*` tag, attaches `docker-compose.yml` (image pinned to the tag's version, since the checked-in file follows `:latest`) and `.env.example` to the GitHub release; `android.yaml` attaches the APK to the same one, and whichever runs first creates the release.
- `security.yaml` — advisory scanners side by side (CodeQL, Semgrep, Bandit, Trivy over every lockfile + Dockerfile, Gitleaks over the history); each job is `continue-on-error`, so a finding never gates a merge. SARIF goes to the Security tab.

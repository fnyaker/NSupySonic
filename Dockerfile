# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Rhythm builder: compile the real-time rhythm analyser (webapp/rhythm, Rust)
# to WebAssembly — a baseline build and a SIMD128 one, the SPA picks whichever
# the browser supports — and the app core (webapp/appcore) and the genre
# studio's trainer (webapp/trainer) beside it. The output is the same bytes whatever the image's
# architecture, so this runs on the BUILD platform: no emulation for arm64.
# The crate has no dependencies, so nothing is fetched but the toolchain.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM rust:1-slim AS wasmbuilder

RUN rustup target add wasm32-unknown-unknown
WORKDIR /rhythm
COPY webapp/rhythm/ ./
RUN cargo build --release --target wasm32-unknown-unknown --target-dir /out/base \
 && RUSTFLAGS="-C target-feature=+simd128" \
    cargo build --release --target wasm32-unknown-unknown --target-dir /out/simd
# The app core (webapp/appcore): the clocks the listen party, the lyric line
# and the animations share, and the track lists' index. Same rules: no
# dependencies, one baseline build.
WORKDIR /appcore
COPY webapp/appcore/ ./
RUN cargo build --release --target wasm32-unknown-unknown --target-dir /out/appcore
# The genre studio's trainer (webapp/trainer): baseline and SIMD128, like the
# analyser, computing the same bits.
WORKDIR /trainer
COPY webapp/trainer/ ./
RUN cargo build --release --target wasm32-unknown-unknown --target-dir /out/trainer \
 && RUSTFLAGS="-C target-feature=+simd128" \
    cargo build --release --target wasm32-unknown-unknown --target-dir /out/trainer-simd

# ---------------------------------------------------------------------------
# Web builder: compile the Svelte discovery SPA (vite -> supysonic/webui/dist)
# ---------------------------------------------------------------------------
# JavaScript out, like the WebAssembly above: build it natively once. Node 22:
# 20 left maintenance in April 2026, and Vite 7 wants 20.19+/22.12+ anyway.
FROM --platform=$BUILDPLATFORM node:22-slim AS webbuilder

WORKDIR /web/webapp
# Install deps first for layer caching, then build (outDir is ../supysonic/...).
# `npm ci`, not `npm install`: exactly the committed lockfile, and a lockfile
# that disagrees with package.json fails here instead of resolving something
# nobody tested. The cache mount only helps local rebuilds (CI builders start
# empty), but costs nothing.
COPY webapp/package.json webapp/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY webapp/ ./
# The analyser as compiled from the source in THIS build, over the committed
# copies (which exist so a checkout builds without Rust).
COPY --from=wasmbuilder /out/base/wasm32-unknown-unknown/release/rhythm.wasm src/lib/audio/rhythm.wasm
COPY --from=wasmbuilder /out/simd/wasm32-unknown-unknown/release/rhythm.wasm src/lib/audio/rhythm-simd.wasm
COPY --from=wasmbuilder /out/appcore/wasm32-unknown-unknown/release/appcore.wasm src/lib/appcore/appcore.wasm
COPY --from=wasmbuilder /out/trainer/wasm32-unknown-unknown/release/trainer.wasm src/lib/genre/trainer.wasm
COPY --from=wasmbuilder /out/trainer-simd/wasm32-unknown-unknown/release/trainer.wasm src/lib/genre/trainer-simd.wasm
RUN npm run build   # writes /web/supysonic/webui/dist

# ---------------------------------------------------------------------------
# ffmpeg: one static binary, no shared library anywhere
# ---------------------------------------------------------------------------
# The apt layer that installed Debian's ffmpeg was 172 MB of the published
# image's 281 MB (compressed): the package pulls in every library some codec,
# device or filter could want — video encoders, SDL, X11, Vulkan, speech
# synthesis — for a server that decodes audio, runs six audio filters and
# encodes Opus, FLAC, MP3 and AAC. This build is a single ~54 MB (compressed)
# file with everything the app drives in it, which docker/smoke.sh checks by
# name. Measured against Ubuntu 24.04's ffmpeg 6.1 on the app's own jobs, it is
# as fast or faster on every one (Opus 320k -21%, silencedetect -33%, the
# spectral pass identical) and the analysis it feeds comes out the same to 0.1%
# on every record of the tempo eval. The digest is
# the multi-arch INDEX, so amd64 and arm64 come from this one line; the tests
# workflow reads the line too, so the suite runs against the binary shipped.
# Only /ffmpeg is copied: ffprobe (another 141 MB) is never called.
FROM mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg

# ---------------------------------------------------------------------------
# Builder: install supysonic (+ vendored deezerpy) and gunicorn into a venv
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
WORKDIR /src

# 1. The dependencies, from the packaging metadata ALONE. This used to follow
#    `COPY . /src`, so any edit anywhere in the tree — a comment, the SPA, the
#    docs — re-downloaded and re-unpacked ~120 MB of wheels, for both
#    architectures (arm64 under QEMU). Now the layer is reused by every build
#    that leaves setup.cfg alone. setuptools/wheel are here to build the
#    package in step 2 without build isolation (pyproject.toml declares the
#    sdist-only sphinx dependency); they are removed again below.
COPY setup.cfg docker/requirements.py ./
RUN --mount=type=cache,target=/root/.cache/pip \
    python requirements.py postgresql embedding > /tmp/requirements.txt \
 && pip install -r /tmp/requirements.txt gunicorn setuptools wheel

# 2. The package itself — only what the wheel is built from, so an SPA-only
#    change does not rebuild this either (the SPA arrives from webbuilder).
COPY setup.py pyproject.toml MANIFEST.in LICENSE README.md config.sample ./
COPY deezerpy/ deezerpy/
COPY supysonic/ supysonic/
# Bundle the built SPA into the package tree so package_data installs it.
COPY --from=webbuilder /web/supysonic/webui/dist /src/supysonic/webui/dist

# --no-deps: step 1 installed them, and `pip check` fails the build if it
# missed one. The copy block puts the built SPA next to the installed package
# in case package_data didn't pick up the gitignored dist directory (belt +
# braces). Then the build tools go: setuptools, wheel and pip itself are ~25 MB
# the server never runs (the base image's own pip is still there for anyone
# who needs one), and numpy's bundled test suite is another ~10 MB.
RUN pip install --no-deps --no-build-isolation . \
 && pip check \
 && DEST="$(cd / && python -c 'import os, supysonic.webui as w; print(os.path.dirname(w.__file__))')" \
 && if [ "$DEST" != "/src/supysonic/webui" ]; then \
        mkdir -p "$DEST/dist" \
     && cp -r /src/supysonic/webui/dist/. "$DEST/dist/"; \
    fi \
 && test -f "$DEST/dist/index.html" \
 && pip uninstall -y -q setuptools wheel \
 && python -m pip uninstall -y -q pip \
 && find /opt/venv/lib -depth -type d -name tests -path "*/site-packages/*" \
        -exec rm -rf {} +

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS runtime

LABEL org.opencontainers.image.title="NSupySonic" \
      org.opencontainers.image.description="Supysonic Subsonic server with a Deezer proxy (archive + on-the-fly transcoding, two-way playlist/favorite sync)" \
      org.opencontainers.image.source="https://github.com/fnyaker/NSupySonic" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# The codec-specific command-line tools behind config.sample's lame / mpg123 /
# oggdec / flac lines, for a mounted config written from it. Everything the app
# runs itself, and every transcoder in the image's own config, is ffmpeg.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      lame flac vorbis-tools mpg123 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg

COPY --from=builder /opt/venv /opt/venv
# The release this image was built from (CI passes the git tag). The entrypoint
# turns it into [webapp] android_version, so the web player can tell a native
# user their APK is older than the server's release. Empty = nothing claimed.
ARG APP_VERSION=""
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    APP_VERSION="$APP_VERSION"

# Non-root user; all mutable state lives under /data (a volume).
RUN useradd --system --create-home --uid 1000 supysonic \
 && mkdir -p /data/db /data/cache /data/archive /data/music \
 && chown -R supysonic:supysonic /data

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# Baked default config so the container boots without a mounted config; a
# bind-mounted /etc/supysonic overrides it entirely.
COPY docker/default.conf /etc/supysonic
# Gunicorn config (workers/threads/timeout are env-tunable; see the file).
COPY docker/gunicorn.conf.py /etc/gunicorn.conf.py

USER supysonic
WORKDIR /data
VOLUME ["/data"]
EXPOSE 5722

# Liveness: the WSGI port is accepting connections.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import socket; socket.create_connection(('127.0.0.1', 5722), 4).close()"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# gunicorn via the app factory. Concurrency/timeout come from the config file
# (env-tunable). One worker keeps the per-process archive lock / single Deezer
# session effective; threads give concurrency.
CMD ["gunicorn", "-c", "/etc/gunicorn.conf.py", \
     "supysonic.web:create_application()"]

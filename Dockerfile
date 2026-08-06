# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Web builder: compile the Svelte discovery SPA (vite -> supysonic/webui/dist)
# ---------------------------------------------------------------------------
FROM node:20-slim AS webbuilder

WORKDIR /web/webapp
# Install deps first for layer caching, then build (outDir is ../supysonic/...).
COPY webapp/package*.json ./
RUN npm install
COPY webapp/ ./
RUN npm run build   # writes /web/supysonic/webui/dist

# ---------------------------------------------------------------------------
# Builder: install supysonic (+ vendored deezerpy) and gunicorn into a venv
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /src
COPY . /src
# Bundle the built SPA into the package tree so package_data installs it.
COPY --from=webbuilder /web/supysonic/webui/dist /src/supysonic/webui/dist

# setuptools/wheel are enough to build the wheel; --no-build-isolation avoids
# pulling the sdist-only sphinx build dependency declared in pyproject.toml.
# The trailing block copies the built SPA next to the installed package, in case
# package_data didn't pick up the gitignored dist directory (belt + braces).
RUN pip install --upgrade pip setuptools wheel \
 && pip install --no-build-isolation ".[postgresql]" gunicorn \
 && DEST="$(cd / && python -c 'import os, supysonic.webui as w; print(os.path.dirname(w.__file__))')" \
 && if [ "$DEST" != "/src/supysonic/webui" ]; then \
        mkdir -p "$DEST/dist" \
     && cp -r /src/supysonic/webui/dist/. "$DEST/dist/"; \
    fi

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS runtime

LABEL org.opencontainers.image.title="NSupySonic" \
      org.opencontainers.image.description="Supysonic Subsonic server with a Deezer proxy (archive + on-the-fly transcoding, two-way playlist/favorite sync)" \
      org.opencontainers.image.source="https://github.com/fnyaker/NSupySonic" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Transcoders used by the streaming endpoint (ffmpeg covers the generic
# transcoder; the others back the codec-specific lines in config.sample).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg lame flac vorbis-tools mpg123 \
 && rm -rf /var/lib/apt/lists/*

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

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

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

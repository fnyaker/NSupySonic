# Gunicorn config for the NSupySonic container.
#
# Tunables are read from the environment so deployments can scale concurrency
# without rebuilding the image (just set them in docker compose):
#
#   GUNICORN_WORKERS  (default 1)   process count
#   GUNICORN_THREADS  (default 8)   threads per worker  -> concurrent streams
#   GUNICORN_TIMEOUT  (default 120) seconds; first play of a Deezer track
#                                   downloads the full FLAC before responding
#
# Keep WORKERS at 1 unless you know what you are doing: the per-process archive
# lock and the single shared Deezer session live in one process, so multiple
# workers would each open their own session and could double-download a track.
# Concurrency is meant to come from threads, not workers.

import os

bind = "0.0.0.0:5722"
workers = int(os.environ.get("GUNICORN_WORKERS", "1"))
threads = int(os.environ.get("GUNICORN_THREADS", "8"))
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "120"))

# Recycle a worker periodically to shed any slow leaks over very long uptimes.
max_requests = int(os.environ.get("GUNICORN_MAX_REQUESTS", "2000"))
max_requests_jitter = int(os.environ.get("GUNICORN_MAX_REQUESTS_JITTER", "200"))

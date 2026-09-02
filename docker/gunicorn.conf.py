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


# Raise the open-file limit for the workers. Each concurrent stream, transcode
# and outgoing Deezer connection is a file descriptor, and a container's default
# soft limit (often 1024) is low enough that a burst — or a third party leaving
# sockets hanging — ends in "OSError: [Errno 24] Too many open files" while the
# worker is accepting connections, which takes the whole worker down. The master
# sets it before forking, so the workers inherit it.
def _raise_file_limit():
    try:
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        want = min(hard, 65536) if hard != resource.RLIM_INFINITY else 65536
        if soft != resource.RLIM_INFINITY and soft < want:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
    except (ImportError, ValueError, OSError):
        pass  # not fatal: the server runs either way


_raise_file_limit()

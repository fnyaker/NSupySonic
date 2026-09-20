# Gunicorn config for the NSupySonic container.
#
# Tunables are read from the environment so deployments can scale concurrency
# without rebuilding the image (just set them in docker compose):
#
#   GUNICORN_WORKERS  (default 1)   process count
#   GUNICORN_THREADS  (default 16)  threads per worker  -> concurrent streams
#   GUNICORN_TIMEOUT  (default 120) seconds; first play of a Deezer track
#                                   downloads the full FLAC before responding
#
# Keep WORKERS at 1 unless you know what you are doing: the per-process archive
# lock and the single shared Deezer session live in one process, so multiple
# workers would each open their own session and could double-download a track.
# Concurrency is meant to come from threads, not workers.
#
# THREADS is 16, not 8, because almost every thread here is blocked on something
# that is not the CPU: a Deezer download, an ffmpeg pipe, a disk read. Eight was
# few enough that a handful of first plays (each holding a thread for as long as
# a FLAC takes) left nothing for the rest of the app, and requests that had no
# work to do at all sat in the accept queue for half a minute. The reservation
# in supysonic/deezer/workload.py is the other half of that fix: background
# requests may only ever hold a quarter of this.

import os

bind = "0.0.0.0:5722"
workers = int(os.environ.get("GUNICORN_WORKERS", "1"))
threads = int(os.environ.get("GUNICORN_THREADS", "16"))
timeout = int(os.environ.get("GUNICORN_TIMEOUT", "120"))

# Publish the RESOLVED count, so the app's background-request reservation sizes
# itself against the pool that actually exists rather than against a default it
# guessed. The workers inherit this environment.
os.environ["GUNICORN_THREADS"] = str(threads)

# Worker recycling is OFF by default, and that is deliberate rather than an
# oversight. The library-wide analysis and the archive sweep run on threads
# INSIDE the worker and take hours; recycling after N requests killed them
# mid-run, which is what "it stops after ten thousand tracks" was. Those jobs
# now checkpoint and resume, so a recycle is survivable — but there is still no
# reason to interrupt a six-hour job to shed a hypothetical leak. Set
# GUNICORN_MAX_REQUESTS if you have an actual leak to shed.
max_requests = int(os.environ.get("GUNICORN_MAX_REQUESTS", "0"))
max_requests_jitter = int(os.environ.get("GUNICORN_MAX_REQUESTS_JITTER", "0"))


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

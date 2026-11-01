# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Who gets the machine first.

One rule governs everything in here: **a person waiting in front of the app
outranks every background job.** Pressing play must feel instant even while the
server is archiving a 2000-track playlist and measuring a 200 000-track library,
because the person pressing play did not ask for either of those and cannot see
them.

That rule needs three separate mechanisms, because the contention happens in
three different places:

1. **Request threads.** The server serves requests from a small fixed pool
   (gunicorn: one worker, a handful of threads). A first play of a Deezer track
   downloads a whole FLAC before it can answer, which holds one of those threads
   for tens of seconds. When the client PREFETCHES through the same route, a
   handful of prefetches take the entire pool, and every other request — the
   gains, the lyrics, the favourites list — waits behind them. That is not a
   slow server, that is a queue. `admit` keeps background requests to a fraction
   of the pool, so foreground ones always find a thread free.

2. **Download slots.** The archive queue is one queue for three very different
   things: "play this now", "you will hear this in three minutes" and "you
   starred an artist, here is their discography". `Priority` orders them, and
   `quiet_wait` makes the bulk end of it stand down entirely while a person is
   waiting on a download of their own.

3. **CPU.** The library-wide analysis is hours of ffmpeg and inference. It must
   be the first thing the kernel deschedules, never the stream. `renice` asks
   for exactly that.

Nothing here is a throttle. Background work still runs flat out — it simply runs
in what the foreground is not using.
"""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger(__name__)

# --- download priorities ----------------------------------------------------
# Lower is more urgent (``queue.PriorityQueue`` pops the smallest).


class Priority:
    #: Somebody is looking at a spinner. Nothing may go before this.
    USER = 0
    #: The track after the one playing. Wanted soon, not now.
    PREFETCH = 5
    #: "Archive this playlist / artist / library." Wanted eventually.
    BULK = 9


PRIORITY_NAMES = {"user": Priority.USER, "prefetch": Priority.PREFETCH, "bulk": Priority.BULK}


def priority_from_name(name, default=Priority.BULK) -> int:
    """Map a client-supplied reason to a priority, never trusting the number.

    The client says *why* it wants something ("user", "prefetch", "bulk"), not
    how urgent it is — otherwise every caller would claim 0.
    """
    return PRIORITY_NAMES.get(str(name or "").strip().lower(), default)


# --- request admission ------------------------------------------------------


def _thread_budget() -> int:
    """How many request threads this process serves from.

    Read from the same environment variable the gunicorn config uses, so the two
    can never drift apart. The fallback matters: under the development server or
    a foreign WSGI host there is no such variable, and guessing too high would
    disable the reservation entirely.
    """
    for var in ("GUNICORN_THREADS", "WEB_CONCURRENCY_THREADS"):
        try:
            n = int(os.environ.get(var, ""))
            if n > 0:
                return n
        except (TypeError, ValueError):
            continue
    return 16  # the gunicorn config's own default


def _default_background_slots() -> int:
    """Threads background requests may hold at once.

    A quarter of the pool, at least one and at most four. The point is not to
    make prefetching fast — it is that three quarters of the pool is ALWAYS
    there for somebody who is waiting.
    """
    try:
        n = int(os.environ.get("NS_BACKGROUND_SLOTS", ""))
        if n > 0:
            return n
    except (TypeError, ValueError):
        pass
    return max(1, min(4, _thread_budget() // 4))


BACKGROUND_SLOTS = _default_background_slots()
_bg_sem = threading.BoundedSemaphore(BACKGROUND_SLOTS)


def admit_background(timeout: float = 0.0) -> bool:
    """Try to take a background slot. False means "come back later".

    Deliberately a *refusal*, not a wait: a background request that queues is
    still holding the thread it was meant not to hold. The client treats the
    refusal as "not cached yet" and simply tries again on the next track.
    """
    return _bg_sem.acquire(blocking=timeout > 0, timeout=timeout or None)


def release_background() -> None:
    try:
        _bg_sem.release()
    except ValueError:  # pragma: no cover - released more than acquired
        logger.debug("background slot released twice", exc_info=True)


# --- foreground activity ----------------------------------------------------
# Bulk archiving competes with a live download for the same bandwidth, the same
# Deezer session and the same (often mechanical) disk. While somebody is waiting
# on a track, the bulk workers stop taking new ones.

_fg_count = 0
_fg_cond = threading.Condition()


class _Foreground:
    """Context manager marking work a person is waiting on."""

    def __enter__(self):
        global _fg_count
        with _fg_cond:
            _fg_count += 1
        return self

    def __exit__(self, *exc):
        global _fg_count
        with _fg_cond:
            _fg_count = max(0, _fg_count - 1)
            if _fg_count == 0:
                _fg_cond.notify_all()
        return False


def foreground():
    """Mark a block as "somebody is waiting on this"."""
    return _Foreground()


def foreground_busy() -> bool:
    with _fg_cond:
        return _fg_count > 0


def quiet_wait(timeout: float = 5.0) -> None:
    """Block until no foreground work is in flight, or the timeout elapses.

    Bounded on purpose. A foreground download that hangs must slow the bulk
    queue down, never stop it for good.
    """
    deadline = timeout
    with _fg_cond:
        while _fg_count > 0 and deadline > 0:
            step = min(deadline, 1.0)
            if not _fg_cond.wait(step):
                deadline -= step
            else:
                break


# --- CPU priority -----------------------------------------------------------


def renice(delta: int = 10) -> None:
    """Ask the kernel to run THIS thread behind everything else.

    Linux's ``nice`` is per-thread, which is exactly what we need: one thread of
    the web server grinding through ffmpeg must not make the thread next to it —
    the one serving a stream — wait for a time slice. Unavailable or refused
    (a container without the capability, a non-Linux host) is not an error: the
    work still runs, it is simply not deprioritised.
    """
    try:
        os.nice(delta)
    except (AttributeError, OSError, PermissionError):
        pass
    ionice_idle()


def cpu_workers(share: float = 0.5, cap: int = 8) -> int:
    """How many threads a library-wide batch job should use.

    Derived from the box rather than asked of the operator: nobody knows how
    many cores their VM has better than the VM does. Half the cores by default
    — the other half is what keeps streaming, transcoding and the database
    responsive while the batch runs — and never the last core.
    """
    try:
        total = len(os.sched_getaffinity(0))  # respects cgroup/taskset limits
    except (AttributeError, OSError):
        total = os.cpu_count() or 2
    return max(1, min(cap, int(total * share), max(1, total - 1)))


# --- listening activity & the zero-impact gate -------------------------------
# Library maintenance (measuring, embedding, re-deciding) is hours of ffmpeg and
# inference. The rule for it is stricter than "run behind the stream": while
# anybody is LISTENING it does not run at all, and when it does run it leaves
# the machine a clear share. `renice` alone is not enough — it only orders the
# kernel's run queue, it does not stop a disk-bound decode from delaying the
# file a stream is reading, nor a laptop-class CPU from boosting into thermal
# limits mid-song.

_last_listen = 0.0  # monotonic time of the last audio request


def touch_listening() -> None:
    """Note that audio was just requested (a stream, a transcode, a chunk)."""
    global _last_listen
    import time

    _last_listen = time.monotonic()


def listening_for() -> float:
    """Seconds since audio was last requested (inf when never)."""
    import time

    return float("inf") if _last_listen == 0.0 else time.monotonic() - _last_listen


def ionice_idle() -> None:
    """Best effort: put THIS thread (and the ffmpeg it starts) in the idle I/O
    class, so the disk serves it only when nobody else wants it. Linux only;
    anything else, or a refusal, is silently the plain behaviour."""
    try:
        import ctypes
        import platform

        nr = {"x86_64": 251, "aarch64": 30}.get(platform.machine())
        if nr is None:
            return
        libc = ctypes.CDLL(None, use_errno=True)
        # IOPRIO_WHO_PROCESS = 1, pid 0 = the calling thread, class IDLE = 3.
        libc.syscall(nr, 1, 0, 3 << 13)
    except Exception:  # pragma: no cover - platform specific
        pass


def _cores() -> int:
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        return max(1, os.cpu_count() or 1)


def load_per_core() -> float:
    try:
        return os.getloadavg()[0] / _cores()
    except (AttributeError, OSError):
        return 0.0


class Throttle:
    """Makes a background job give way — completely — to the people using the app.

    Call ``wait()`` before each unit of work and ``spent(seconds)`` after it.
    ``wait`` blocks while: a download a person waits on is running; audio was
    requested in the last ``listen_quiet`` seconds; or the 1-minute load per
    core is above ``max_load``. ``spent`` then sleeps so that the job's duty
    cycle never exceeds ``duty`` (0.5 = at most half of one worker's time).
    ``wait`` returns False when ``stop()`` says the job is over (cancelled, or
    its window ended), so the caller leaves cleanly instead of finishing a unit
    it was told to abandon.
    """

    def __init__(self, duty=0.5, listen_quiet=45.0, max_load=0.6, stop=None,
                 sleep=None, poll=2.0):
        import time

        self.duty = min(1.0, max(0.05, float(duty)))
        self.listen_quiet = listen_quiet
        self.max_load = max_load
        self._stop = stop or (lambda: False)
        self._sleep = sleep or time.sleep
        self.poll = poll
        self.waited = 0.0
        self.reason = None  # why it is waiting right now (for the studio)

    def _blocked(self):
        if foreground_busy():
            return "download"
        if listening_for() < self.listen_quiet:
            return "listening"
        if load_per_core() > self.max_load:
            return "load"
        return None

    def wait(self) -> bool:
        while True:
            if self._stop():
                self.reason = None
                return False
            self.reason = self._blocked()
            if self.reason is None:
                return True
            self._sleep(self.poll)
            self.waited += self.poll

    def spent(self, seconds: float) -> None:
        if self.duty >= 1.0 or seconds <= 0:
            return
        self._sleep(min(30.0, seconds * (1.0 / self.duty - 1.0)))

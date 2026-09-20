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

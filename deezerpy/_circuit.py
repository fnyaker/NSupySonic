"""Fail fast while a Deezer host is not answering.

Deezer is a third party on the far side of the internet, and when it stops
answering, the damage is not the error — it is the **wait**. Every call blocks
for the connect timeout, retries, blocks again; each one parks a server thread,
and once every thread is parked the whole app is down, including everything
that never needed Deezer at all (playing archived music, browsing the library,
serving the SPA). That is exactly how a Deezer outage took the app with it.

So every Deezer host gets a circuit breaker. After ``FAILURE_THRESHOLD``
consecutive **transport** failures the circuit opens: further calls to that host
raise ``DeezerUnavailable`` instantly instead of blocking. Once the cooldown
elapses a single request is let through as a probe — it closes the circuit if it
succeeds, or re-opens it with a longer cooldown if it doesn't.

Two deliberate choices:

- **Per host.** api.deezer.com being rate-limited or down must not stop playback
  from the CDN, and a dead podcast host must not stop anything else.
- **Transport failures only.** A connect timeout, a read timeout or a reset
  connection means "this host is not answering". An HTTP error, a gateway error
  payload or an empty result is Deezer *answering*, which says nothing about
  reachability and must never be turned into an outage verdict.
"""

from __future__ import annotations

import threading
import time

from deezerpy.errors import DeezerUnavailable

# Consecutive transport failures before a host is declared down. Small: the
# whole point is to stop paying the timeout, and a single blip costs one
# failure, not a trip.
FAILURE_THRESHOLD = 3
# First cooldown, doubled on every failed probe up to the cap.
BASE_COOLDOWN = 15.0
MAX_COOLDOWN = 300.0
# A probe that never reports back (killed thread, worker recycled) must not hold
# the half-open slot forever.
PROBE_TIMEOUT = 60.0


class _HostState:
    __slots__ = ("failures", "open_until", "cooldown", "probe_started", "last_error")

    def __init__(self):
        self.failures = 0
        self.open_until = 0.0
        self.cooldown = BASE_COOLDOWN
        self.probe_started = 0.0
        self.last_error = None


class CircuitBreaker:
    """Per-host open/half-open/closed state for outgoing Deezer requests."""

    def __init__(
        self,
        threshold: int = FAILURE_THRESHOLD,
        base_cooldown: float = BASE_COOLDOWN,
        max_cooldown: float = MAX_COOLDOWN,
    ):
        self.threshold = threshold
        self.base_cooldown = base_cooldown
        self.max_cooldown = max_cooldown
        self._hosts: dict[str, _HostState] = {}
        self._lock = threading.Lock()

    # -- request lifecycle ------------------------------------------------

    def before_request(self, host: str) -> bool:
        """Raise ``DeezerUnavailable`` if ``host`` is down; else return whether
        this call is the half-open probe."""
        if not host:
            return False
        now = time.monotonic()
        with self._lock:
            state = self._hosts.get(host)
            if state is None or state.open_until <= 0.0:
                return False
            if now < state.open_until:
                raise DeezerUnavailable(self._message(host, state, now))
            # Cooldown elapsed: let exactly one request through to find out.
            if state.probe_started and now - state.probe_started < PROBE_TIMEOUT:
                raise DeezerUnavailable(self._message(host, state, now))
            state.probe_started = now
            return True

    def on_success(self, host: str, probe: bool = False) -> None:
        """The host answered — anything at all. Close the circuit."""
        if not host:
            return
        with self._lock:
            state = self._hosts.get(host)
            if state is None:
                return
            if state.open_until or state.failures:
                state.failures = 0
                state.open_until = 0.0
                state.cooldown = self.base_cooldown
                state.probe_started = 0.0
                state.last_error = None

    def on_failure(self, host: str, exc: BaseException, probe: bool = False) -> None:
        """A transport failure against ``host``. Open the circuit once they add up."""
        if not host:
            return
        now = time.monotonic()
        with self._lock:
            state = self._hosts.get(host)
            if state is None:
                state = self._hosts[host] = _HostState()
            state.last_error = f"{exc.__class__.__name__}: {exc}"[:200]
            state.probe_started = 0.0
            if probe or state.open_until:
                # A failed probe means it is still down: back off further.
                state.cooldown = min(state.cooldown * 2, self.max_cooldown)
                state.open_until = now + state.cooldown
                return
            state.failures += 1
            if state.failures >= self.threshold:
                state.cooldown = self.base_cooldown
                state.open_until = now + state.cooldown

    # -- introspection ----------------------------------------------------

    def is_open(self, host: str) -> bool:
        """Is ``host`` currently short-circuited? (never raises)"""
        return self.retry_after(host) > 0.0

    def retry_after(self, host: str) -> float:
        """Seconds until the next attempt to ``host`` will be let through."""
        if not host:
            return 0.0
        now = time.monotonic()
        with self._lock:
            state = self._hosts.get(host)
            if state is None or state.open_until <= 0.0:
                return 0.0
            return max(0.0, state.open_until - now)

    def any_open(self, hosts=None) -> bool:
        """Is any (of ``hosts``, or of the known hosts) circuit open right now?"""
        if hosts is None:
            with self._lock:
                hosts = list(self._hosts)
        return any(self.is_open(h) for h in hosts)

    def snapshot(self) -> dict:
        """``{host: {"open": bool, "retry_in": s, "failures": n, "error": str}}``."""
        now = time.monotonic()
        out = {}
        with self._lock:
            for host, state in self._hosts.items():
                if not state.failures and not state.open_until:
                    continue
                out[host] = {
                    "open": now < state.open_until,
                    "retry_in": round(max(0.0, state.open_until - now), 1),
                    "failures": state.failures,
                    "error": state.last_error,
                }
        return out

    def reset(self, host: str | None = None) -> None:
        """Forget a host's failures (or every host's). Used by an explicit
        user-driven retry — "check my connection now" must really try."""
        with self._lock:
            if host is None:
                self._hosts.clear()
            else:
                self._hosts.pop(host, None)

    @staticmethod
    def _message(host, state, now) -> str:
        return (
            f"{host} is not answering (last: {state.last_error or 'timeout'}); "
            f"retrying in {max(0.0, state.open_until - now):.0f}s"
        )


# One shared breaker for the process: the provider builds a fresh Deezer client
# (and therefore a fresh requests session) on every re-login, and during an
# outage that happens on *every* request — a per-session breaker would forget
# the host was down and pay the timeout again each time.
breaker = CircuitBreaker()

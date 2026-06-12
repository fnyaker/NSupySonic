"""Shared client-side rate limiter for all Deezer HTTP calls.

The public API (api.deezer.com) enforces a quota (error code 4, "Quota limit
exceeded") around ~50 requests / 5 s per IP, and the private gateway
(gw-light.php) can throttle/ban an over-eager ARL. Since both go through the
same requests.Session (same IP), a single shared limiter keeps the total
request rate to Deezer safely under the quota.
"""

import threading
import time
from collections import deque


class RateLimiter:
    """Thread-safe sliding-window limiter: at most `max_calls` per `period` s."""

    def __init__(self, max_calls: int, period: float):
        self.max_calls = max_calls
        self.period = period
        self._calls = deque()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                while self._calls and now - self._calls[0] >= self.period:
                    self._calls.popleft()
                if len(self._calls) < self.max_calls:
                    self._calls.append(now)
                    return
                wait = self.period - (now - self._calls[0])
            time.sleep(max(wait, 0.01))


# Conservative shared default (~8 req/s), well under the public ~50/5s quota.
limiter = RateLimiter(max_calls=40, period=5.0)

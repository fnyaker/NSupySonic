# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A tiny in-process rate limiter for authentication endpoints.

Tracks failed attempts per key (typically the client IP) in a sliding window
and blocks further attempts once a threshold is reached, to slow down brute
force / credential-stuffing against an internet-exposed instance.

In-process state is sufficient because the server runs as a single Gunicorn
worker (see the Dockerfile CMD). Behind a reverse proxy, deploy ProxyFix so
request.remote_addr is the real client IP rather than the proxy's.
"""

import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, max_attempts=10, window=300):
        """max_attempts failures allowed per `window` seconds before blocking."""
        self.max_attempts = max_attempts
        self.window = window
        self._fails = defaultdict(deque)
        self._lock = threading.Lock()

    def _trim(self, dq, now):
        while dq and now - dq[0] > self.window:
            dq.popleft()

    def is_blocked(self, key):
        now = time.time()
        with self._lock:
            dq = self._fails.get(key)
            if not dq:
                return False
            self._trim(dq, now)
            if not dq:
                del self._fails[key]
                return False
            return len(dq) >= self.max_attempts

    def record_failure(self, key):
        now = time.time()
        with self._lock:
            dq = self._fails[key]
            self._trim(dq, now)
            dq.append(now)

    def reset(self, key):
        with self._lock:
            self._fails.pop(key, None)


# Shared limiter for every authentication path (Subsonic API, web UI, frontend).
auth_limiter = RateLimiter()

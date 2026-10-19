# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The polite third-party HTTP client (MusicBrainz, AcoustID, Cover Art Archive).

Three rules, each a way the public services ban a client:

* identify yourself (``NSupySonic/<version> ( contact )``);
* never exceed a host's rate (MusicBrainz 1 request a second, AcoustID 3) —
  the limiter WAITS, so it may only ever be called from a worker thread, never
  from a request: nothing in a route reaches this module;
* a 503 / 429 is the service asking for quiet: the host is held off for the
  time it names (``Retry-After``), and a call that would have to wait longer
  than ``MAX_WAIT`` raises ``Unavailable`` instead of sleeping on.
"""

import logging
import threading
import time
from urllib.parse import urlsplit

import requests

logger = logging.getLogger(__name__)

#: (connect, read): a scalar would give the whole budget to the connect phase.
TIMEOUT = (5, 15)
#: Minimum seconds between two requests to a host.
RATES = {
    "musicbrainz.org": 1.0,
    "api.acoustid.org": 1 / 3,
    "coverartarchive.org": 0.5,
}
DEFAULT_INTERVAL = 0.5
#: Longest a call sleeps for a held-off host before giving up.
MAX_WAIT = 60.0
DEFAULT_BACKOFF = 30.0
MAX_BACKOFF = 600.0
MAX_REDIRECTS = 3
IMAGE_MAX = 4 * 1024 * 1024


class Unavailable(Exception):
    """The service asked for quiet (503/429) or is held off: try again later."""

    def __init__(self, message, retry_after=0.0):
        super().__init__(message)
        self.retry_after = retry_after


class HttpError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.status = status


def user_agent(contact=None):
    try:
        from importlib.metadata import version

        ver = version("supysonic")
    except Exception:
        ver = "dev"
    return f"NSupySonic/{ver} ( {contact or 'https://github.com/fnyaker/nsupysonic'} )"


def _retry_after(resp):
    raw = (resp.headers or {}).get("Retry-After")
    try:
        secs = float(raw)
    except (TypeError, ValueError):
        secs = DEFAULT_BACKOFF
    return max(1.0, min(secs, MAX_BACKOFF))


class Http:
    def __init__(self, contact=None, *, session=None, clock=time.monotonic,
                 sleep=time.sleep, rates=None):
        self.session = session or requests.Session()
        self.headers = {"User-Agent": user_agent(contact), "Accept": "application/json"}
        self._clock = clock
        self._sleep = sleep
        self.rates = dict(RATES if rates is None else rates)
        self._next = {}  # host -> earliest next request (clock time)
        self._lock = threading.Lock()

    # -- pacing ---------------------------------------------------------

    def _reserve(self, host):
        """Claim the next slot for ``host`` and return how long to wait for it."""
        with self._lock:
            now = self._clock()
            slot = max(now, self._next.get(host, 0.0))
            wait = slot - now
            if wait > MAX_WAIT:
                raise Unavailable(f"{host} is held off for {wait:.0f}s", wait)
            self._next[host] = slot + self.rates.get(host, DEFAULT_INTERVAL)
            return wait

    def _hold(self, host, seconds):
        with self._lock:
            self._next[host] = max(self._next.get(host, 0.0), self._clock() + seconds)

    def _call(self, method, url, **kw):
        host = urlsplit(url).hostname or ""
        wait = self._reserve(host)
        if wait > 0:
            self._sleep(wait)
        try:
            resp = self.session.request(
                method, url, headers=self.headers, timeout=TIMEOUT, **kw
            )
        except requests.RequestException as exc:
            # The network failing says nothing about the data: back off a little.
            self._hold(host, DEFAULT_BACKOFF)
            raise Unavailable(f"{host}: {type(exc).__name__}", DEFAULT_BACKOFF) from exc
        if resp.status_code in (429, 503):
            secs = _retry_after(resp)
            self._hold(host, secs)
            raise Unavailable(f"{host} answered {resp.status_code}", secs)
        return resp

    # -- calls ----------------------------------------------------------

    def get_json(self, url, params=None):
        """The decoded JSON, or None for a 404 (the service answered: no such thing)."""
        resp = self._call("GET", url, params=params)
        return self._json(resp)

    def post_json(self, url, data):
        return self._json(self._call("POST", url, data=data))

    @staticmethod
    def _json(resp):
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise HttpError(resp.status_code)
        try:
            return resp.json()
        except ValueError as exc:
            raise HttpError(resp.status_code) from exc

    def get_image(self, url, allowed=("coverartarchive.org", "archive.org")):
        """Bytes of a JPEG, redirects followed by hand — https only, and only
        to the hosts of ``allowed`` (the Cover Art Archive hands out archive.org
        mirrors) — or None. Bounded in size."""
        for _ in range(MAX_REDIRECTS + 1):
            parts = urlsplit(url)
            host = parts.hostname or ""
            if parts.scheme != "https" or not any(
                host == a or host.endswith("." + a) for a in allowed
            ):
                return None
            resp = self._call("GET", url, stream=True, allow_redirects=False)
            try:
                if resp.status_code in (301, 302, 303, 307, 308):
                    url = resp.headers.get("Location") or ""
                    continue
                if resp.status_code == 404:
                    return None
                if resp.status_code >= 400:
                    raise HttpError(resp.status_code)
                body = bytearray()
                for chunk in resp.iter_content(65536):
                    body += chunk
                    if len(body) > IMAGE_MAX:
                        return None
            finally:
                resp.close()
            data = bytes(body)
            # A JPEG only: it is stored as ``cover.jpg`` and served as one.
            return data if data[:3] == b"\xff\xd8\xff" else None
        return None

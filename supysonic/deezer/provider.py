# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Single ARL-based Deezer backend used by the proxy.

Wraps ``deezerpy`` (RemixDev) for login, metadata, library reads/writes and
recommendations, and implements the streaming side itself: resolving a playable
URL for a Deezer track id and yielding the Blowfish-decrypted bytes (the audio
Deezer serves is encrypted with BF-CBC over 2048-byte stripes, one block in
three).
"""

from __future__ import annotations

import hashlib
import ipaddress
import logging
import socket
import threading
import time
import weakref
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
from requests.utils import get_environ_proxies, select_proxy

try:  # pycryptodome
    from Crypto.Cipher import Blowfish
except ImportError:  # pycryptodomex
    from Cryptodome.Cipher import Blowfish

from deezerpy import Deezer, new_session
from deezerpy.errors import DeezerError as DeezerPyError
from deezerpy.errors import DeezerUnavailable, is_transport_failure
from deezerpy._circuit import breaker
from deezerpy._throttle import limiter

logger = logging.getLogger(__name__)

_SECRET = b"g4el58wc0zvf9na1"
_BF_IV = bytes(range(8))  # b"\x00\x01\x02\x03\x04\x05\x06\x07"
_CHUNK = 2048

COVER_URL = "https://e-cdns-images.dzcdn.net/images/cover/{md5}/{w}x{w}-000000-80-0-0.jpg"

# Always try the requested quality first, then degrade.
QUALITY_FALLBACKS = {
    "FLAC": ["FLAC", "MP3_320", "MP3_128"],
    "MP3_320": ["MP3_320", "MP3_128"],
    "MP3_128": ["MP3_128"],
}
EXT_FOR_FORMAT = {"FLAC": ".flac", "MP3_320": ".mp3", "MP3_128": ".mp3", "MP3_MISC": ".mp3"}
# Nominal bitrate (kbps) used before the real file is on disk.
NOMINAL_BITRATE = {"FLAC": 1000, "MP3_320": 320, "MP3_128": 128}


class DeezerError(Exception):
    """Any failure talking to Deezer."""


class ShowUnavailable(DeezerError):
    """Deezer no longer serves this podcast at all — the whole show, delisted.

    Same distinction as TrackUnavailable: this is Deezer *answering*, not a
    network failure. It is what turns a subscribed show into a local one, so it
    must never be raised on a timeout or a gateway hiccup.
    """


class TrackUnavailable(DeezerError):
    """Deezer has no playable source for this track — and said so.

    Distinct from every other DeezerError on purpose: a network failure, an
    expired token or a gateway hiccup are all "try again later", while this one
    is a verdict about the track itself (rights pulled, delisted, geo-blocked).
    Only this one may make the app give up on a track and offer a replacement.
    """


# Podcast audio URLs come from third-party feed metadata, so they are attacker
# influenced. Only ordinary http(s) to a public address is fetched.
MAX_EPISODE_REDIRECTS = 5

# -- name resolution, with the deadline the system resolver doesn't offer -----
#
# ``socket.getaddrinfo`` takes no timeout. It blocks on the system resolver, and
# glibc's defaults (5s per attempt, 2 attempts, per nameserver in resolv.conf)
# make ONE stalled lookup take 20s or more. ``requests`` folds DNS into its
# connect timeout, so everything going through the session is already covered —
# but the SSRF pre-flight below runs *before* requests is involved, once per
# redirect hop, on a hostname a third-party podcast feed chose. A resolver that
# stops answering therefore parked a worker thread for minutes with nothing to
# show for it: the same failure mode as an unbounded HTTP call, one layer down.
RESOLVE_TIMEOUT = 5.0
# All of a show's episodes come from the same host and a redirect chain usually
# stays within two or three, so re-resolving every hop of every episode is pure
# latency. Short enough that a host which moves is picked up quickly.
RESOLVE_CACHE_TTL = 300.0
# A failure is remembered too, and for much less time: the point is only that
# the next caller doesn't pay the same timeout over again.
RESOLVE_FAILURE_TTL = 30.0
# A lookup runs on its own thread, so a hung resolver parks THAT and not the
# request thread serving somebody. The semaphore caps how many may be in flight
# and is held for as long as the lookup actually runs — not just until we stop
# waiting for it — so wedged lookups genuinely occupy their slot instead of
# piling up behind each other.
_RESOLVE_WORKERS = 4
# How long to wait for one of those slots. Deliberately separate from — and much
# shorter than — the lookup's own budget: a busy pool is a fact about US, and
# spending the lookup's whole deadline queueing would end in "this host timed
# out" being remembered about a host we never actually asked about.
_SLOT_WAIT = 1.0

_resolver_slots = threading.BoundedSemaphore(_RESOLVE_WORKERS)
_resolve_cache: dict[tuple[str, int], tuple[float, "list[str] | None"]] = {}
_resolve_cache_lock = threading.Lock()


def _lookup_async(host: str, port: int):
    """Start ``getaddrinfo`` on a daemon thread; returns ``(done_event, result)``.

    A bare daemon thread rather than a ThreadPoolExecutor, deliberately: a
    lookup wedged inside the system resolver cannot be cancelled, and the
    executor's atexit hook JOINS its workers — so one stuck name would hang the
    shutdown of the very worker being recycled because something is stuck. A
    daemon thread is abandoned at exit, which is the correct outcome here. The
    caller's semaphore slot is released in here, once the lookup really ends —
    not when the caller stops waiting for it.
    """
    done = threading.Event()
    result: dict = {}

    def run():
        try:
            # SOCK_STREAM: without it getaddrinfo returns the same address once
            # per socket type, and the caller would "fail over" between copies
            # of the very same IP.
            seen, addresses = set(), []
            for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
                address = info[4][0]
                if address not in seen:
                    seen.add(address)
                    addresses.append(address)
            result["addresses"] = addresses
        except BaseException as exc:
            # Everything, so the slot below is always released and the caller
            # always gets an answer — a resolver can raise more than gaierror.
            result["error"] = exc
        finally:
            done.set()
            _resolver_slots.release()

    try:
        threading.Thread(target=run, name="dns-check", daemon=True).start()
    except Exception:
        _resolver_slots.release()
        raise
    return done, result


def _cache_resolution(key, addresses, ttl) -> None:
    with _resolve_cache_lock:
        if len(_resolve_cache) > 512:  # bounded: the keys come from feed URLs
            _resolve_cache.clear()
        _resolve_cache[key] = (time.monotonic() + ttl, addresses)


def resolve_addresses(host: str, port: int) -> "list[str]":
    """Every IP ``host`` resolves to, within ``RESOLVE_TIMEOUT``.

    Raises ``DeezerError`` when the name doesn't resolve, or when the resolver
    doesn't answer in time — which is a transport failure like any other, and
    says nothing about the podcast being asked for.
    """
    key = (host, port)
    with _resolve_cache_lock:
        hit = _resolve_cache.get(key)
        if hit is not None and time.monotonic() < hit[0]:
            if hit[1] is None:
                raise DeezerError(f"cannot resolve {host} (cached failure)")
            return hit[1]

    if not _resolver_slots.acquire(timeout=min(_SLOT_WAIT, RESOLVE_TIMEOUT)):
        # Every resolver thread is stuck on some other name. Refusing here is
        # the whole point: the wait stays inside this pool instead of spreading.
        # Nothing is cached — this says nothing about `host`.
        raise DeezerError(
            f"DNS is not answering; refusing {host}"
        ) from DeezerUnavailable("the resolver is not answering")

    done, result = _lookup_async(host, port)
    if not done.wait(RESOLVE_TIMEOUT):
        _cache_resolution(key, None, RESOLVE_FAILURE_TTL)
        # Chained from DeezerUnavailable so is_transport_failure() reads it for
        # what it is: we could not reach the host, and nothing whatsoever about
        # the podcast has been established.
        raise DeezerError(f"timed out resolving {host}") from DeezerUnavailable(
            f"the resolver did not answer for {host}"
        )

    error = result.get("error")
    if error is not None:
        # A name that does not resolve is an ANSWER (NXDOMAIN and friends), so
        # this one is not dressed up as a transport failure: retrying it in a
        # few seconds would be pointless.
        _cache_resolution(key, None, RESOLVE_FAILURE_TTL)
        raise DeezerError(f"cannot resolve {host}: {error}") from error

    addresses = result["addresses"]
    if not addresses:
        _cache_resolution(key, None, RESOLVE_FAILURE_TTL)
        raise DeezerError(f"{host} resolves to no address")
    _cache_resolution(key, addresses, RESOLVE_CACHE_TTL)
    return addresses


def url_port(parts) -> int:
    """The port a URL addresses, default for its scheme. Never raises."""
    try:
        port = parts.port
    except ValueError as exc:  # "https://h:99999/x"
        raise DeezerError(f"refusing episode URL with a bad port: {exc}") from exc
    return port or (443 if parts.scheme == "https" else 80)


def check_public_url(url: str) -> "list[str]":
    """The addresses ``url`` resolves to — raising unless every one is public.

    Blocks the SSRF targets that matter for a self-hosted server: loopback (the
    app's own admin API), link-local (169.254.169.254 cloud metadata) and RFC
    1918 / ULA neighbours on the LAN.

    Returning the addresses is the point, not a convenience: the caller connects
    to one of *these*, rather than handing the hostname back to a resolver that
    is free to answer differently the second time (see ``_PinnedAddressAdapter``).
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise DeezerError(f"refusing non-HTTP episode URL ({parts.scheme or 'none'})")
    host = parts.hostname
    if not host:
        raise DeezerError("refusing episode URL without a host")
    addresses = resolve_addresses(host, url_port(parts))
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise DeezerError(f"refusing episode URL resolving to {ip}")
    return addresses


# How many of a host's addresses a pinned fetch will try. Pinning gives up the
# fail-over that socket.create_connection() does for free over every address
# getaddrinfo returned, so it is done explicitly — bounded, because each attempt
# costs a connect timeout.
MAX_PINNED_ADDRESSES = 4

# requests grew build_connection_pool_key_attributes() in 2.32; it is the
# supported way to say "connect here" without reaching into urllib3. setup.cfg
# requires a new enough requests, so this only guards a forced downgrade.
_CAN_PIN_ADDRESS = hasattr(
    requests.adapters.HTTPAdapter, "build_connection_pool_key_attributes"
)
_warned_no_pinning = False


class _PinnedAddressAdapter(requests.adapters.HTTPAdapter):
    """Connects to one already-validated IP, whatever DNS says at connect time.

    ``check_public_url`` resolves a name and decides it is public — and then
    requests used to resolve it AGAIN before connecting. Two lookups, two
    chances to answer: a hostile resolver returns a public address for the check
    and 127.0.0.1 (or the cloud metadata service) for the fetch, and the body of
    whatever answers gets archived and served back by /api/stream. That is DNS
    rebinding, and no amount of checking the *name* fixes it — the only fix is to
    connect to the address we actually validated.

    This is not a weakening of TLS. The pinned address is used for the TCP
    connection alone: SNI, certificate validation and the Host header all still
    carry the real hostname (urllib3 prefers ``server_hostname`` over the
    connection's host for both SNI and the certificate match), so the server
    still has to prove it is that host.
    """

    def __init__(self, address: str, **kwargs):
        self.address = address
        super().__init__(**kwargs)

    def build_connection_pool_key_attributes(self, request, verify, cert=None):
        host_params, pool_kwargs = super().build_connection_pool_key_attributes(
            request, verify, cert
        )
        hostname = host_params["host"]
        host_params = dict(host_params, host=self.address)
        if host_params.get("scheme") == "https":
            pool_kwargs = dict(pool_kwargs, server_hostname=hostname)
        return host_params, pool_kwargs


def host_header(parts) -> str:
    """The ``Host:`` a URL implies — sent explicitly, since we address by IP."""
    host = parts.hostname or ""
    if ":" in host:  # an IPv6 literal, which the header wants in brackets
        host = f"[{host}]"
    port = url_port(parts)
    default = 443 if parts.scheme == "https" else 80
    return host if port == default else f"{host}:{port}"


def _warn_once_about_pinning() -> None:
    global _warned_no_pinning
    if not _CAN_PIN_ADDRESS and not _warned_no_pinning:
        _warned_no_pinning = True
        logger.warning(
            "requests is too old to pin an episode fetch to a validated address; "
            "podcast downloads keep the pre-flight SSRF check only. Upgrade requests."
        )


def blowfish_key(track_id) -> bytes:
    """Per-track Blowfish key: md5(track_id) folded with the static secret."""
    md5 = hashlib.md5(str(track_id).encode()).hexdigest()
    return bytes(ord(md5[i]) ^ ord(md5[i + 16]) ^ _SECRET[i] for i in range(16))


class DeezerProvider:
    def __init__(self, arl: str, archive_dir: str, default_quality: str = "FLAC"):
        self.arl = arl
        self.archive_dir = archive_dir
        self.default_quality = (
            default_quality if default_quality in QUALITY_FALLBACKS else "FLAC"
        )
        self._dz: Deezer | None = None
        self._login_lock = threading.Lock()
        # Weak values so a per-track lock is garbage-collected once nothing
        # holds it anymore. A plain dict here grew without bound (one entry per
        # distinct Deezer track ever played) — a slow memory leak in long runs.
        self._track_locks: "weakref.WeakValueDictionary[str, threading.Lock]" = (
            weakref.WeakValueDictionary()
        )
        self._track_locks_guard = threading.Lock()
        # Last time a resolve failure forced a re-login (see resolve): rate-
        # limited so a genuinely unavailable track can't spam login calls.
        # -inf, not 0.0: time.monotonic() counts from boot, so 0.0 reads as
        # "re-logged in at boot" and suppressed the very first retry for the
        # machine's first minute of uptime.
        self._last_relogin = float("-inf")
        # (checksum, tracks) cache for the favorites list — see
        # get_my_favorite_tracks. The expensive part is fetching full metadata
        # for every favorite; Deezer hands back a cheap checksum of the set, so
        # we only refetch when it actually changed.
        self._fav_cache: tuple[str | None, list] | None = None
        # Why the last login attempt failed: ("arl", msg) — Deezer rejected the
        # credential, the admin must paste a new one — or ("network", msg), which
        # says nothing about the ARL. None once a login has succeeded. Read by
        # the status endpoint so the UI can tell the two apart.
        self._login_error: tuple[str, str] | None = None
        self._last_check = 0.0
        # Until when a failed login is not worth re-attempting. Logging in costs
        # a gateway round-trip, and ``dz`` is touched by nearly every request:
        # without this, an outage made every single request pay a fresh login
        # attempt. The circuit breaker covers the socket, this covers the rest
        # (and gives the UI an instant answer).
        self._login_retry_at = 0.0

    @classmethod
    def from_config(cls, cfg: dict) -> "DeezerProvider | None":
        """Build a provider from the ``DEEZER`` config dict, or None if off."""
        if not cfg or not cfg.get("enabled"):
            return None
        arl = cfg.get("arl")
        archive = cfg.get("archive_dir")
        if not arl or not archive:
            logger.warning(
                "Deezer proxy enabled but 'arl' and/or 'archive_dir' are missing; "
                "disabling."
            )
            return None
        return cls(arl, archive, cfg.get("default_quality", "FLAC"))

    # -- session ---------------------------------------------------------

    # How long a failed login is remembered before another attempt is made.
    # Short for a network blip (it may already be over), longer for a rejected
    # credential (only the admin pasting a new ARL can fix that, and doing so
    # calls ``set_arl``, which clears the backoff immediately).
    _LOGIN_RETRY_NETWORK = 20.0
    _LOGIN_RETRY_ARL = 120.0

    @property
    def dz(self) -> Deezer:
        if self._dz is None:
            with self._login_lock:
                if self._dz is None:
                    if time.monotonic() < self._login_retry_at:
                        reason, detail = self._login_error or ("network", "login failed")
                        failure = DeezerError(f"Deezer login unavailable ({reason}): {detail}")
                        if reason != "network":
                            raise failure
                        # Chained so callers can tell this apart with
                        # is_transport_failure(): it is Deezer not answering,
                        # remembered, and it must read as such everywhere —
                        # never as a verdict, never as a stack trace per request.
                        raise failure from DeezerUnavailable(detail)
                    dz = Deezer()
                    try:
                        ok = dz.login_via_arl(self.arl)
                    except Exception as exc:
                        # Deezer unreachable / gateway hiccup. This says nothing
                        # about the ARL, so it must NOT be reported as "your
                        # credential is dead" — that sends the admin chasing a
                        # perfectly good ARL during a network blip.
                        dz.close()
                        self._login_error = ("network", str(exc) or exc.__class__.__name__)
                        self._last_check = time.monotonic()
                        self._login_retry_at = time.monotonic() + self._LOGIN_RETRY_NETWORK
                        raise DeezerError(f"Deezer unreachable: {exc}") from exc
                    if not ok:
                        dz.close()
                        self._login_error = (
                            "arl",
                            "Deezer rejected the ARL (expired, revoked or mistyped)",
                        )
                        self._last_check = time.monotonic()
                        self._login_retry_at = time.monotonic() + self._LOGIN_RETRY_ARL
                        raise DeezerError("ARL login failed (empty/expired cookie?)")
                    self._dz = dz
                    self._login_error = None
                    self._login_retry_at = 0.0
                    self._last_check = time.monotonic()
                    logger.info(
                        "Deezer login OK as %s (lossless=%s)",
                        dz.current_user.get("name"),
                        dz.current_user.get("can_stream_lossless"),
                    )
        return self._dz

    def _drop_session(self) -> None:
        """Forget the current client and release its sockets.

        Always under ``_login_lock``. Closing matters: a re-login builds a whole
        new ``Deezer`` (and a whole new connection pool), and during an outage
        that happens often — leaving the old pools to the garbage collector is
        how a server ends up with "Too many open files".
        """
        old, self._dz = self._dz, None
        closer = getattr(old, "close", None)
        if closer is not None:
            try:
                closer()
            except Exception:
                pass

    def relogin(self) -> Deezer:
        with self._login_lock:
            self._drop_session()
            # An explicit re-login is a deliberate "try again now": don't let a
            # backoff from the previous failure veto it.
            self._login_retry_at = 0.0
        return self.dz

    # Hosts whose reachability decides whether Deezer is usable at all: the
    # private gateway (metadata, library, tokens) and the public API (search,
    # charts). The CDNs are deliberately excluded — a stalled image host says
    # nothing about the catalogue.
    _CORE_HOSTS = ("www.deezer.com", "api.deezer.com")

    def available(self) -> bool:
        """Is it worth talking to Deezer at all right now? (instant, never raises)

        A pure state read — no network, no lock. Callers use it to skip straight
        to the local library instead of queueing behind a call that is already
        known to fail, which is what keeps a Deezer outage from being felt as
        app-wide slowness.
        """
        # The backoff is about LOGGING IN, so it only counts when there is no
        # session to use: a client we already hold stays usable while an old
        # failed login attempt is still cooling down.
        if self._dz is None and time.monotonic() < self._login_retry_at:
            return False
        return not breaker.any_open(self._CORE_HOSTS)

    def outage(self) -> dict | None:
        """Details of the current outage, or None. For the status endpoint."""
        if self.available():
            return None
        hosts = {h: breaker.retry_after(h) for h in self._CORE_HOSTS if breaker.is_open(h)}
        backoff = self._login_retry_at - time.monotonic() if self._dz is None else 0.0
        retry_in = max([backoff, *hosts.values()] or [0.0])
        return {
            "hosts": sorted(hosts),
            "retry_in": round(max(0.0, retry_in), 1),
            "detail": (self._login_error or (None, None))[1],
        }

    # How long a login verdict is trusted before ``check_login`` re-tests it.
    _CHECK_TTL = 120.0

    def check_login(self, force: bool = False) -> dict:
        """Cheap, cached health check of the Deezer session.

        Returns ``{"ok", "reason", "detail", "account"}`` where ``reason`` is
        ``None``, ``"arl"`` (the credential is dead — admin action needed) or
        ``"network"``. Never raises: this is what the UI polls, and a status
        endpoint that throws is worse than useless.
        """
        fresh = time.monotonic() - self._last_check < self._CHECK_TTL
        if not force and self._dz is not None and fresh:
            return {"ok": True, "reason": None, "detail": None,
                    "account": self._dz.current_user.get("name")}
        if force:
            # An explicit "check now" from the admin: wipe every reason we might
            # have to answer from memory — the backoff, and the breaker's verdict
            # on the hosts — so the button really does re-test the connection.
            with self._login_lock:
                self._drop_session()
                self._login_retry_at = 0.0
            for host in self._CORE_HOSTS:
                breaker.reset(host)
        elif not self.available():
            # Known-down: answer instantly from what we already learned instead
            # of queueing behind a call that is going to fail anyway. The UI
            # polls this, and an outage must never make polling it slow.
            #
            # Which verdict: a live login backoff carries the reason the login
            # actually failed (a rejected ARL is a rejected ARL). An open circuit
            # is by construction a transport failure, and must never be reported
            # as a dead credential — that sends the admin chasing a good ARL.
            if (
                self._dz is None
                and time.monotonic() < self._login_retry_at
                and self._login_error
            ):
                reason, detail = self._login_error
            else:
                reason, detail = "network", "Deezer is not answering"
            return {"ok": False, "reason": reason, "detail": detail, "account": None}
        elif self._dz is not None and not self._live_session():
            # We hold a session object, but the account behind it may have been
            # revoked hours ago — an ARL that expires mid-run breaks everything
            # while the process happily believes it is logged in. Re-login so the
            # verdict below is about the credential as it is NOW.
            with self._login_lock:
                self._drop_session()
        try:
            dz = self.dz
        except DeezerError:
            reason, detail = self._login_error or ("network", "login failed")
            return {"ok": False, "reason": reason, "detail": detail, "account": None}
        except Exception as exc:  # never let the health check itself blow up
            return {"ok": False, "reason": "network", "detail": str(exc), "account": None}
        # Verdict cached, so polling this endpoint costs one gateway call every
        # _CHECK_TTL at most — not one per poll.
        self._last_check = time.monotonic()
        return {"ok": True, "reason": None, "detail": None,
                "account": dz.current_user.get("name")}

    def _live_session(self) -> bool:
        """Is the current session still authenticated? (one cheap gateway call)

        Returns True when we can't tell — an unknown transport (tests) or a
        network error must never be reported as a dead credential.
        """
        dz = self._dz
        probe = getattr(getattr(dz, "gw", None), "get_user_data", None)
        if probe is None:
            return True
        try:
            data = probe() or {}
        except Exception:
            return True  # network trouble, not a verdict on the ARL
        try:
            return bool(int(data.get("USER", {}).get("USER_ID") or 0))
        except (AttributeError, TypeError, ValueError):
            return True

    def set_arl(self, arl: str) -> None:
        """Swap the account credential and drop everything derived from it."""
        arl = (arl or "").strip()
        with self._login_lock:
            self.arl = arl
            self._drop_session()
            self._fav_cache = None
            self._login_error = None
            self._last_check = 0.0
            self._last_relogin = float("-inf")
            # A new credential deserves a real attempt, whatever the old one did.
            self._login_retry_at = 0.0

    @property
    def user_id(self):
        return self.dz.current_user.get("id")

    @property
    def can_lossless(self) -> bool:
        return bool(self.dz.current_user.get("can_stream_lossless"))

    @property
    def loved_playlist_id(self):
        return self.dz.current_user.get("loved_tracks")

    def track_lock(self, deezer_id) -> threading.Lock:
        key = str(deezer_id)
        with self._track_locks_guard:
            lock = self._track_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._track_locks[key] = lock
            return lock

    # -- metadata (delegate to deezerpy gw) ------------------------------

    def get_track_info(self, sng_id) -> dict:
        return self.dz.gw.get_track(sng_id)

    def get_album(self, alb_id) -> dict:
        return self.dz.gw.get_album(alb_id)

    def get_album_tracks(self, alb_id) -> list[dict]:
        return self.dz.gw.get_album_tracks(alb_id)

    def get_artist(self, art_id) -> dict:
        return self.dz.gw.get_artist(art_id)

    def get_playlist_tracks(self, playlist_id) -> list[dict]:
        return self.dz.gw.get_playlist_tracks(playlist_id)

    def get_smart_tracklist(self, smarttracklist_id) -> dict:
        return self.dz.gw.get_smart_tracklist(smarttracklist_id)

    def get_album_page(self, alb_id) -> dict:
        return self.dz.gw.get_album_page(alb_id)

    def get_artist_page(self, art_id) -> dict:
        return self.dz.gw.get_artist_page(art_id)

    def get_playlist_page(self, playlist_id) -> dict:
        return self.dz.gw.get_playlist_page(playlist_id)

    def get_artist_discography(self, art_id) -> dict:
        return self.dz.gw.get_artist_discography_tabs(art_id)

    def get_artist_top(self, art_id, limit: int = 15) -> list[dict]:
        """The artist's most-played tracks, public API (typed, with `id`)."""
        return (self.dz.api.get_artist_top(art_id, limit=limit) or {}).get("data") or []

    def get_lyrics(self, sng_id) -> dict:
        return self.dz.gw.get_track_lyrics(sng_id)

    # -- Flow / radio / mixes --------------------------------------------

    def get_flow(self) -> dict:
        return self.dz.gw.get_user_radio(self.user_id)

    def get_track_mix(self, sng_id) -> dict:
        return self.dz.gw.get_track_mix(sng_id)

    def get_artist_radio(self, art_id) -> dict:
        return self.dz.gw.get_artist_radio(art_id)

    # -- podcasts (shows / episodes) -------------------------------------

    def get_show_page(self, show_id, nb=40, start=0) -> dict:
        """The show page, or ``ShowUnavailable`` if Deezer no longer has it.

        A delisted show comes back either as a gateway error (a structured
        answer) or as a page whose DATA carries no SHOW_ID. Both mean "Deezer
        answered, and this show is gone"; anything else — a timeout, a reset —
        propagates untouched, because it says nothing about the show.
        """
        try:
            page = self.dz.gw.get_show_page(show_id, nb=nb, start=start)
        except DeezerUnavailable:
            # Deezer is not answering. That is not Deezer saying the show is
            # gone, and ShowUnavailable is what retires a subscription — so it
            # propagates untouched, exactly like a timeout.
            raise
        except DeezerPyError as exc:
            raise ShowUnavailable(f"Deezer has no show {show_id}: {exc}") from exc
        if not (page or {}).get("DATA", {}).get("SHOW_ID"):
            raise ShowUnavailable(f"Deezer returned no data for show {show_id}")
        return page

    def get_show_episodes(self, show_id) -> list[dict]:
        return self.dz.gw.get_show_episodes(show_id)

    def search_podcasts(self, query, limit=25) -> list[dict]:
        """Search podcasts via the public API (typed, returns image URLs)."""
        res = self.dz.api.search_podcast(query, limit=limit)
        return (res or {}).get("data", []) or []

    def get_user_shows(self) -> list[dict]:
        """The user's favorite podcasts (shows) from their Deezer profile."""
        return self.dz.gw.get_user_shows(self.user_id)

    def add_favorite_show(self, show_id):
        return self.dz.gw.add_show_to_favorites(show_id)

    def remove_favorite_show(self, show_id):
        return self.dz.gw.remove_show_from_favorites(show_id)

    def resolve_episode(self, episode) -> str:
        """Return a playable URL for a podcast episode.

        Podcasts are ``SHOW_IS_DIRECT_STREAM=1``: the episode's
        ``EPISODE_DIRECT_STREAM_URL`` (captured at import) is a plain MP3 served
        by the podcast host — no token, no Blowfish. We stored it on the row, so
        resolution is a no-op lookup. (A Deezer-hosted exclusive show would need
        the media.deezer.com token path; none observed in practice.)
        """
        url = getattr(episode, "stream_url", None)
        if not url:
            raise DeezerError(f"no stream URL for episode {getattr(episode, 'deezer_id', '?')}")
        return url

    def _open_validated(self, url: str, headers: dict, timeout):
        """GET ``url``, connecting only to an address we have just validated.

        Returns ``(session, response)``. The caller owns both and must close the
        session once it is done reading the body — the session exists for this
        one fetch because the address it is pinned to is specific to this hop.
        """
        addresses = check_public_url(url)
        parts = urlsplit(url)
        request_headers = dict(headers)

        if not _CAN_PIN_ADDRESS or select_proxy(url, get_environ_proxies(url)):
            # Either egress goes through a proxy — which does its own resolving,
            # so pinning here would pin the wrong end of the connection, and the
            # operator's proxy is the boundary — or requests is too old to say
            # "connect here" (see _CAN_PIN_ADDRESS). The pre-flight check above
            # stands on its own; it just no longer closes the rebinding window.
            _warn_once_about_pinning()
            session = new_session()
            return session, session.get(
                url, headers=request_headers, stream=True,
                timeout=timeout, allow_redirects=False,
            )

        # Sent explicitly: the connection is addressed by IP, so urllib3 would
        # otherwise put that IP in the Host header and the CDN would not know
        # which site is being asked for.
        request_headers["Host"] = host_header(parts)

        last = None
        for address in addresses[:MAX_PINNED_ADDRESSES]:
            session = new_session()
            adapter = _PinnedAddressAdapter(address)
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            try:
                return session, session.get(
                    url, headers=request_headers, stream=True,
                    timeout=timeout, allow_redirects=False,
                )
            except requests.RequestException as exc:
                # One address out of several can simply be down. This is the
                # fail-over create_connection() used to do over the whole list.
                session.close()
                last = exc
        raise DeezerError(f"could not reach {parts.hostname}: {last}") from last

    def iter_episode(self, url: str):
        """Yield a podcast episode's MP3 bytes from its host.

        Plain HTTP, no decryption. A Referer matching the web player is sent
        since some hosts gate on it.

        The URL comes from third-party podcast metadata and the result is
        archived and then served back by /api/stream, so an unchecked fetch is a
        readable SSRF: a redirect chain ending at 169.254.169.254 or at this
        very server would be stored and handed to the client. Redirects are
        therefore followed one hop at a time, every hop is validated (scheme +
        resolved IP), and the fetch then connects to the very address that was
        validated rather than resolving the name a second time.
        """
        headers = dict(self.dz.http_headers)
        headers["Referer"] = "https://www.deezer.com/"
        current = url
        for _ in range(MAX_EPISODE_REDIRECTS + 1):
            session, response = self._open_validated(current, headers, (10, 120))
            try:
                with response as resp:
                    if resp.is_redirect or resp.is_permanent_redirect:
                        location = resp.headers.get("Location")
                        if not location:
                            raise DeezerError("redirect without a Location header")
                        current = urljoin(current, location)
                        continue
                    resp.raise_for_status()
                    for chunk in resp.iter_content(65536):
                        if chunk:
                            yield chunk
                    return
            finally:
                session.close()
        raise DeezerError(f"too many redirects fetching {url}")

    def download_episode_to(self, url: str, dest: Path) -> None:
        """Stream a podcast episode's MP3 into ``dest`` (atomic .part temp file)."""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        with open(tmp, "wb") as fh:
            for chunk in self.iter_episode(url):
                fh.write(chunk)
        tmp.replace(dest)

    def set_episode_position(self, episode_id, offset, duration, is_heard=False) -> bool:
        """Best-effort push of an episode playback position to Deezer."""
        try:
            self.dz.gw.set_episode_bookmark(episode_id, offset, duration, is_heard)
            return True
        except Exception:
            logger.debug("episode.bookmarkSet failed for %s", episode_id, exc_info=True)
            return False

    # -- customizable Flow (GraphQL pipe.deezer.com) ---------------------

    def flow_clusters(self) -> list:
        return self.dz.gql.get_flow_clusters()

    def set_flow_clusters(self, clusters) -> dict:
        return self.dz.gql.update_flow_clusters(clusters)

    # -- channels (genre/mood landing pages, gateway page.get) -----------

    def get_channels(self) -> dict:
        return self.dz.gw.get_channels()

    def get_channel(self, name) -> dict:
        return self.dz.gw.get_channel(name)

    # -- library reads ----------------------------------------------------

    def get_user_playlists(self, limit=200) -> list[dict]:
        return self.dz.gw.get_user_playlists(self.user_id, limit=limit)

    def get_my_favorite_tracks(self, limit=10000) -> list[dict]:
        # Cheap call: ids + a checksum of the favorites set. If the checksum is
        # unchanged we serve the cached tracks instead of re-fetching metadata
        # for thousands of songs (the slow part).
        ids_raw = self.dz.gw.get_user_favorite_ids(limit=limit)
        checksum = ids_raw.get("checksum") if isinstance(ids_raw, dict) else None
        if checksum and self._fav_cache and self._fav_cache[0] == checksum:
            return self._fav_cache[1]
        tracks = self.dz.gw.get_my_favorite_tracks(limit=limit)
        self._fav_cache = (checksum, tracks)
        return tracks

    def invalidate_favorites_cache(self):
        """Drop the cached favorites (after a star/unstar from the web UI)."""
        self._fav_cache = None

    def get_user_albums(self, limit=200) -> list[dict]:
        return self.dz.gw.get_user_albums(self.user_id, limit=limit)

    def get_user_artists(self, limit=200) -> list[dict]:
        return self.dz.gw.get_user_artists(self.user_id, limit=limit)

    def report_listen(self, deezer_id, listened=0, next_id=None, context=None,
                      is_shuffle=False) -> bool:
        """Best-effort play report to Deezer (feeds recommendations/Flow)."""
        try:
            self.dz.gw.log_listen(
                deezer_id,
                listened=listened,
                next_id=next_id,
                context=context,
                is_shuffle=is_shuffle,
            )
            return True
        except Exception:
            logger.debug("log.listen failed for %s", deezer_id, exc_info=True)
            return False

    # -- library writes ---------------------------------------------------

    def add_favorite_track(self, sng_id):
        return self.dz.gw.add_song_to_favorites(sng_id)

    def remove_favorite_track(self, sng_id):
        return self.dz.gw.remove_song_from_favorites(sng_id)

    def add_favorite_album(self, alb_id):
        return self.dz.gw.add_album_to_favorites(alb_id)

    def remove_favorite_album(self, alb_id):
        return self.dz.gw.remove_album_from_favorites(alb_id)

    def add_favorite_artist(self, art_id):
        return self.dz.gw.add_artist_to_favorites(art_id)

    def remove_favorite_artist(self, art_id):
        return self.dz.gw.remove_artist_from_favorites(art_id)

    def add_favorite_playlist(self, playlist_id):
        return self.dz.gw.add_playlist_to_favorites(playlist_id)

    def remove_favorite_playlist(self, playlist_id):
        return self.dz.gw.remove_playlist_from_favorites(playlist_id)

    def create_playlist(self, title, description=None, songs=None):
        return self.dz.gw.create_playlist(title, description=description, songs=songs or [])

    def edit_playlist(self, playlist_id, title=None, description=None):
        return self.dz.gw.edit_playlist(playlist_id, title, description=description)

    def add_songs_to_playlist(self, playlist_id, songs):
        return self.dz.gw.add_songs_to_playlist(playlist_id, songs)

    def remove_songs_from_playlist(self, playlist_id, songs):
        return self.dz.gw.remove_songs_from_playlist(playlist_id, songs)

    def delete_playlist(self, playlist_id):
        return self.dz.gw.delete_playlist(playlist_id)

    # -- resolve a playable, possibly-degraded stream URL ----------------

    # Minimum delay between two failure-driven re-logins. Within the window a
    # failing resolve is a genuine "track unavailable", not a stale session.
    _RELOGIN_INTERVAL = 60.0

    def resolve(self, sng_id, quality: str | None = None):
        """Return ``(url, fmt, gw_info, used_id)`` for a playable source.

        The Deezer media license token (minted at login) silently expires after
        a while; when it does, ``get_track_url`` fails for EVERY quality and
        every not-yet-archived track becomes unplayable until the process
        restarts — while archived ones keep working. So a resolve that fails
        outright re-logs in once (rate-limited) and retries with fresh tokens.
        """
        quality = quality or self.default_quality
        try:
            return self._resolve_once(sng_id, quality)
        except Exception as exc:
            if is_transport_failure(exc):
                # Deezer did not answer. Uniform, never-a-verdict failure: every
                # caller of resolve() reads TrackUnavailable as "condemn this
                # track", so nothing that merely failed to reach Deezer may
                # arrive as one — nor as a raw socket error each caller would
                # have to recognise for itself.
                raise DeezerError(
                    f"cannot reach Deezer to resolve track {sng_id}: {exc}"
                ) from exc
            if not isinstance(exc, (DeezerError, DeezerPyError)):
                raise
            # NOTE: TrackUnavailable deliberately does NOT short-circuit here.
            # An expired media license token makes get_track_url fail for every
            # quality, which looks *exactly* like "this track has no source" —
            # so a verdict is only trustworthy once a fresh session has said the
            # same thing. The re-login below is what tells the two apart.
            verdict = isinstance(exc, TrackUnavailable)
            if time.monotonic() - self._last_relogin < self._RELOGIN_INTERVAL:
                raise  # a fresh session already said so — the track really is gone
            logger.info(
                "Resolve failed for %s (%s) — re-logging into Deezer and retrying",
                sng_id, exc,
            )
            try:
                self.relogin()
            except Exception as login_exc:
                # We could not even ASK a fresh session. An unconfirmed verdict
                # is not a verdict: downgraded to an ordinary failure, or an
                # outage would condemn every cold track anyone pressed play on
                # — and a condemned track is offered for replacement/deletion.
                if verdict:
                    raise DeezerError(
                        f"cannot confirm that track {sng_id} is unavailable: "
                        f"Deezer is unreachable ({login_exc})"
                    ) from exc
                raise exc  # ARL dead / network down: surface the original error
            # Only a login that actually succeeded starts the trust window above.
            self._last_relogin = time.monotonic()
            return self._resolve_once(sng_id, quality)

    def _resolve_once(self, sng_id, quality: str):
        """One resolve attempt against the current session (see ``resolve``).

        Falls back to the gateway-provided alternative (``FALLBACK.SNG_ID``)
        when the requested track has no playable source.
        """
        info = self.get_track_info(sng_id)
        url, fmt = self._url_from_info(info, quality)
        if url:
            return url, fmt, info, info.get("SNG_ID", sng_id)

        fallback_id = (info.get("FALLBACK") or {}).get("SNG_ID")
        if fallback_id and str(fallback_id) != str(sng_id):
            alt = self.get_track_info(fallback_id)
            url, fmt = self._url_from_info(alt, quality)
            if url:
                return url, fmt, alt, alt.get("SNG_ID", fallback_id)

        # Deezer answered, and the answer is "there is nothing to play here" —
        # not a transport failure. Callers act on this: it is what condemns a
        # track and offers the user a replacement.
        raise TrackUnavailable(f"no playable source for track {sng_id}")

    def _url_from_info(self, info: dict, quality: str):
        """The first playable URL among the quality fallbacks, or (None, None).

        (None, None) means Deezer ANSWERED and had nothing — the caller turns
        that into ``TrackUnavailable``, which condemns the track and offers the
        user a replacement. So a failure to *reach* Deezer must never end up
        here: it is raised as a plain ``DeezerError`` instead. Degrading to the
        next quality would only ask the same unreachable host again anyway.
        """
        token = info.get("TRACK_TOKEN")
        if not token:
            return None, None
        for fmt in QUALITY_FALLBACKS.get(quality, ["MP3_128"]):
            try:
                url = self.dz.get_track_url(token, fmt)
            except (DeezerUnavailable, requests.RequestException) as exc:
                raise DeezerError(f"cannot reach Deezer to resolve a stream: {exc}") from exc
            except DeezerPyError:
                url = None  # WrongLicense / WrongGeolocation / a per-track error
            except Exception:
                url = None
            if url:
                return url, fmt
        return None, None

    # -- streaming download + decryption ---------------------------------

    def iter_decrypted(self, url: str, track_id):
        """Yield decrypted audio bytes from a Deezer stream URL."""
        key = blowfish_key(track_id)
        with self.dz.session.get(
            url, headers=self.dz.http_headers, stream=True, timeout=(10, 120)
        ) as resp:
            resp.raise_for_status()
            for i, chunk in enumerate(resp.iter_content(_CHUNK)):
                if i % 3 == 0 and len(chunk) == _CHUNK:
                    chunk = Blowfish.new(key, Blowfish.MODE_CBC, _BF_IV).decrypt(chunk)
                yield chunk

    def download_to(self, url: str, track_id, dest: Path) -> None:
        """Stream-decrypt `url` into `dest` (atomic via a .part temp file)."""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        with open(tmp, "wb") as fh:
            for chunk in self.iter_decrypted(url, track_id):
                fh.write(chunk)
        tmp.replace(dest)

    def fetch_cover(self, md5_image: str, size: int = 1000) -> bytes | None:
        # Album covers come straight from the image CDN (not rate-limited).
        if not md5_image:
            return None
        try:
            resp = self.dz.session.get(
                COVER_URL.format(md5=md5_image, w=size),
                headers=self.dz.http_headers,
            )
            resp.raise_for_status()
            return resp.content
        except (requests.RequestException, DeezerError):
            # Art is decoration: a stalled CDN, an open circuit or a failed
            # login must cost a missing cover, never the caller's request.
            return None

    def fetch_image(self, kind: str, deezer_id, size: str = "xl") -> bytes | None:
        """Artist/playlist/album image via Deezer's public image endpoint.

        Goes through the shared limiter since it hits api.deezer.com.
        """
        if not deezer_id:
            return None
        limiter.acquire()
        try:
            resp = self.dz.session.get(
                f"https://api.deezer.com/{kind}/{deezer_id}/image",
                params={"size": size},
                headers=self.dz.http_headers,
            )
            resp.raise_for_status()
            if "image" in resp.headers.get("content-type", ""):
                return resp.content
            return None
        except (requests.RequestException, DeezerError):
            return None

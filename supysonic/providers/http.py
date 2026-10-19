# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The HTTP every provider shares: one timeout, one circuit breaker per host.

``deezerpy._circuit`` already keeps a breaker per HOST on the ``_Session`` the
Deezer client uses. This module makes that a service of the providers: a
provider asks ``session(provider_id, hosts)`` for its session, and the hosts it
names are remembered so ``reachable(provider_id)`` can say, instantly and
without a request, whether it is worth calling. A bare ``requests.Session()``
has neither the default timeout nor the breaker, and one black-holed socket
then parks a server thread until the worker is killed.
"""

import threading

from deezerpy import DEFAULT_TIMEOUT, new_session
from deezerpy._circuit import breaker
from deezerpy.errors import is_transport_failure

__all__ = [
    "DEFAULT_TIMEOUT",
    "hosts",
    "is_transport_failure",
    "register_hosts",
    "reachable",
    "retry_in",
    "session",
]

_hosts: dict = {}
_lock = threading.Lock()


def register_hosts(provider_id, hosts_):
    """Remember that ``provider_id`` talks to ``hosts_`` (lowercase names)."""
    names = tuple(sorted({str(h).lower() for h in hosts_ if h}))
    with _lock:
        known = _hosts.get(provider_id, ())
        _hosts[provider_id] = tuple(sorted(set(known) | set(names)))


def hosts(provider_id) -> tuple:
    return _hosts.get(provider_id, ())


def session(provider_id, hosts_=()):
    """A session with the default timeout and the per-host breaker, for a
    provider that names the hosts it will call."""
    register_hosts(provider_id, hosts_)
    return new_session()


def reachable(provider_id) -> bool:
    """True unless a host the provider uses has its circuit open (no network)."""
    names = hosts(provider_id)
    return not (names and breaker.any_open(names))


def retry_in(provider_id) -> float:
    """Seconds until the last open circuit of the provider is probed again."""
    left = [breaker.retry_after(h) for h in hosts(provider_id) if breaker.is_open(h)]
    return round(max(left), 1) if left else 0.0

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Which providers exist, which are on, and in what order they are asked.

``app.providers`` is one ``Registry``. Built-in providers register themselves
when the application is created, third parties through the
``supysonic.providers`` entry-point group, so a provider can be added without
touching this repository. The order and the on/off switches live in ``Meta``
(``prov.order``, ``prov.<id>.on``; keys stay under 32 characters) and survive a
restart. Switching a provider off erases nothing: what is archived plays.
"""

import logging
import threading
import time
from importlib import metadata

from .base import Provider, check_declared
from .errors import CapabilityMissing

logger = logging.getLogger(__name__)

ENTRY_POINT_GROUP = "supysonic.providers"
ORDER_KEY = "prov.order"
CACHE_SECONDS = 1.0


def _on_key(provider_id):
    return f"prov.{provider_id}.on"


class MetaStore:
    """Settings in the ``Meta`` table (the default, what the server uses)."""

    def get(self, key):
        from ..db import Meta

        row = Meta.get_or_none(Meta.key == key)
        return row.value if row is not None else None

    def set(self, key, value):
        from ..db import Meta

        row = Meta.get_or_none(Meta.key == key)
        if row is None:
            Meta.create(key=key, value=value)
        else:
            row.value = value
            row.save()


class MemoryStore:
    """Settings in a dict, for tests and for code that has no database."""

    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value):
        self.values[key] = value


class Registry:
    def __init__(self, store=None):
        self._store = store if store is not None else MetaStore()
        self._providers = {}  # id -> Provider, in registration order
        self._lock = threading.Lock()
        self._cache = None  # (when, order list, {id: bool or None})

    # -- registration ----------------------------------------------------------

    def register(self, provider):
        """Register a ``Provider`` instance, or a class that takes no argument.
        A second provider under the same id is refused."""
        if isinstance(provider, type):
            provider = provider()
        check_declared(provider)
        with self._lock:
            if provider.id in self._providers:
                raise ValueError(f"provider {provider.id!r} is already registered")
            self._providers[provider.id] = provider
        self._cache = None
        return provider

    def load_entry_points(self):
        """Register what the ``supysonic.providers`` group offers. A module that
        fails to load, or that is malformed, is logged and skipped: a broken
        third-party package must not stop the server from starting."""
        try:
            points = metadata.entry_points(group=ENTRY_POINT_GROUP)
        except Exception:
            logger.exception("could not list the %s entry points", ENTRY_POINT_GROUP)
            return []
        loaded = []
        for point in points:
            try:
                loaded.append(self.register(point.load()))
            except Exception:
                logger.exception("provider entry point %r ignored", point.name)
        return loaded

    # -- lookup ----------------------------------------------------------------

    def get(self, provider_id):
        return self._providers.get(provider_id)

    def all(self):
        """Every registered provider, enabled or not, in registration order."""
        return list(self._providers.values())

    def ordered(self):
        """Every registered provider in the person's order; the ones the order
        does not name follow, in registration order."""
        order, _ = self._settings()
        rank = {pid: i for i, pid in enumerate(order)}
        tail = len(rank)
        return sorted(
            self._providers.values(), key=lambda p: rank.get(p.id, tail)
        )

    def enabled(self):
        """The ordered providers that are switched on."""
        return [p for p in self.ordered() if self.is_enabled(p.id)]

    def is_enabled(self, provider_id):
        provider = self._providers.get(provider_id)
        if provider is None:
            return False
        _, flags = self._settings()
        flag = flags.get(provider_id)
        if flag is not None:
            return flag
        # Never switched by anybody: on, unless it needs a credential nobody
        # has given yet.
        return not provider.requires_credentials or provider.available()

    def require(self, provider_id, capability):
        """The provider ``provider_id``, which must declare ``capability``."""
        provider = self._providers.get(provider_id)
        if provider is None:
            raise CapabilityMissing(f"no provider {provider_id!r}", provider=provider_id)
        if capability not in provider.capabilities:
            raise CapabilityMissing(
                f"{provider_id} does not provide {capability!r}", provider=provider_id
            )
        return provider

    def with_capability(self, capability):
        """The enabled providers, in order, that declare ``capability``."""
        return [p for p in self.enabled() if capability in p.capabilities]

    # -- settings --------------------------------------------------------------

    def set_order(self, provider_ids):
        ids = []
        for pid in provider_ids:
            if pid in self._providers and pid not in ids:
                ids.append(pid)
        # Meta.value is 256 characters: 16 + a comma per id, so fourteen ids.
        value = ",".join(ids)
        if len(value) > 256:
            raise ValueError("too many providers in the order")
        self._store.set(ORDER_KEY, value)
        self._cache = None

    def set_enabled(self, provider_id, on):
        if provider_id not in self._providers:
            raise KeyError(provider_id)
        self._store.set(_on_key(provider_id), "1" if on else "0")
        self._cache = None

    def _settings(self):
        """``(order, {id: bool})`` read from the store, kept a second: it is
        read for every provider on every search."""
        cached = self._cache
        now = time.monotonic()
        if cached is not None and now - cached[0] < CACHE_SECONDS:
            return cached[1], cached[2]
        raw = self._store.get(ORDER_KEY) or ""
        order = [x for x in raw.split(",") if x]
        flags = {}
        for pid in self._providers:
            value = self._store.get(_on_key(pid))
            flags[pid] = None if value is None else value == "1"
        self._cache = (now, order, flags)
        return order, flags

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Helpers shared by the multi-provider tests (never the network)."""

from supysonic.providers.fake import FakeProvider
from supysonic.providers.registry import MemoryStore, Registry


def registry_with(*fakes):
    """A registry holding ``fakes``, with settings in memory (no database)."""
    registry = Registry(store=MemoryStore())
    for fake in fakes:
        registry.register(fake)
    return registry


def hit(title, artist="Artist", duration=200, **extra):
    """A normalised track hit, the shape every provider returns."""
    out = {
        "title": title,
        "artists": [{"name": artist, "ref": f"a-{artist.lower()}"}],
        "album": {"name": "Album", "ref": "alb"},
        "duration": duration,
        "number": 1,
        "disc": 1,
    }
    out.update(extra)
    return out


def assert_calls(fake, **expected):
    """The fake was called exactly ``expected`` times per method (``{}`` means
    not at all). Counts, never time: the tests are machine independent."""
    got = {k: v for k, v in fake.calls.items() if v}
    want = {k: v for k, v in expected.items() if v}
    assert got == want, f"{fake.id} was called {got}, expected {want}"

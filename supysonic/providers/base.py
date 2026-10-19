# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The interface of a provider: a source of SOUND and of catalogue FACTS.

A provider declares an ``id`` (lowercase letters and digits, at most 16: it is a
database key), a ``role`` and a set of ``capabilities``, and implements only the
methods of the capabilities it declares. The application hides the rest.

The values exchanged are plain dicts (``TypedDict``s here, for the reader):
they serialise for free and the application stores them without knowing which
provider they came from.
"""

import re
from typing import TypedDict

# -- capabilities --------------------------------------------------------------

SEARCH = "search"
AUDIO = "audio"
CATALOG = "catalog"
ACCOUNT = "account"
LINKS = "links"
PODCASTS = "podcasts"

CAPABILITIES = frozenset({SEARCH, AUDIO, CATALOG, ACCOUNT, LINKS, PODCASTS})

# Which methods a declared capability promises (checked by the registry's
# ``require`` and by the tests: a declared capability with a method missing is
# a bug in the provider, found at registration rather than at the first click).
METHODS = {
    SEARCH: ("search",),
    AUDIO: ("offers", "fetch", "open_stream", "fetch_cover"),
    CATALOG: ("get_track", "get_album", "get_artist", "get_artist_albums", "get_playlist"),
    ACCOUNT: ("account", "import_account"),
    LINKS: ("parse_link",),
    PODCASTS: ("search_shows", "get_show", "get_episodes"),
}

MAIN = "main"
FALLBACK = "fallback"

KINDS = ("track", "album", "artist", "playlist", "show")

ID_RE = re.compile(r"^[a-z0-9]{1,16}$")
REF_MAX = 128


# -- exchanged values ----------------------------------------------------------


class Ref(TypedDict):
    provider: str
    kind: str  # one of KINDS
    ref: str  # opaque, at most REF_MAX characters, validated by the provider


class Offer(TypedDict, total=False):
    """What a provider CAN deliver for a track (not what we hold)."""

    quality: int  # the quality scale's class (lot C); higher is better
    fmt: str  # "flac", "opus", "m4a", "mp3"...
    bitrate: int  # kbit/s
    lossless: bool
    bit_depth: int
    sample_rate: int


class NamedRef(TypedDict, total=False):
    name: str
    ref: str


class TrackHit(TypedDict, total=False):
    ref: str
    title: str
    artists: list  # [NamedRef]
    album: NamedRef
    duration: int
    isrc: str
    number: int
    disc: int
    release_date: str
    cover_url: str
    explicit: bool
    offers: list  # [Offer], when the search knows them


class SearchResult(TypedDict, total=False):
    tracks: list
    albums: list
    artists: list
    playlists: list


class Health(TypedDict, total=False):
    status: str  # "ok" | "auth" | "network"
    retry_in: float  # seconds, when the status says to wait
    detail: str


HEALTH_OK = "ok"
HEALTH_AUTH = "auth"
HEALTH_NETWORK = "network"


def health(status=HEALTH_OK, retry_in=None, detail=None) -> Health:
    out: Health = {"status": status}
    if retry_in is not None:
        out["retry_in"] = retry_in
    if detail:
        out["detail"] = detail
    return out


class Provider:
    """Base class of every provider. An ordinary class, not an ABC: a method of
    a capability the provider does not declare simply raises."""

    id = ""
    name = ""
    role = MAIN
    capabilities = frozenset()
    # True when the provider cannot work without a credential the person gives
    # (it is then enabled by default only once ``available()``).
    requires_credentials = False
    # How much each kind of fact is believed (plan §6); filled by the lots that
    # use it. Absent kind: not trusted more than the file's own tags.
    trust = {}

    def available(self) -> bool:
        """Instant, no network: is it worth calling this provider at all?"""
        return True

    def configured(self) -> bool:
        """Does it have what it needs (credentials, a dependency) to work at
        all? Instant, no network, and NOT "reachable right now": an outage must
        not read as a provider that was never set up. Decides whether a
        provider nobody ever switched is on."""
        return self.available()

    def switch(self):
        """The provider's own on/off switch when it predates the registry
        (YouTube's ``yt.enabled``): True / False, or None for "the registry
        decides"."""
        return None

    def toggle(self, on) -> bool:
        """Flip that switch; False when the provider has none."""
        return False

    def health(self, force=False) -> Health:
        return health()

    def config_schema(self) -> list:
        """The fields the person fills in: ``{"key", "type", "masked", "help"}`` (masked: never shown back)."""
        return []

    def has(self, capability) -> bool:
        return capability in self.capabilities

    def _missing(self, name):
        raise NotImplementedError(f"{self.id}: {name} is not provided")

    # SEARCH
    def search(self, query, kinds=("track",), limit=20) -> SearchResult:
        self._missing("search")

    # AUDIO
    def offers(self, ref) -> list:
        self._missing("offers")

    def fetch(self, ref, offer, dest) -> None:
        self._missing("fetch")

    def open_stream(self, ref, offer):
        self._missing("open_stream")

    def fetch_cover(self, ref, size=1000) -> bytes:
        self._missing("fetch_cover")

    # CATALOG
    def get_track(self, ref) -> TrackHit:
        self._missing("get_track")

    def get_album(self, ref) -> dict:
        self._missing("get_album")

    def get_artist(self, ref) -> dict:
        self._missing("get_artist")

    def get_artist_albums(self, ref) -> list:
        self._missing("get_artist_albums")

    def get_playlist(self, ref) -> dict:
        self._missing("get_playlist")

    # ACCOUNT
    def account(self) -> dict:
        self._missing("account")

    def import_account(self):
        self._missing("import_account")

    # LINKS
    def parse_link(self, url):
        self._missing("parse_link")

    # PODCASTS
    def search_shows(self, query, limit=20) -> list:
        self._missing("search_shows")

    def get_show(self, ref) -> dict:
        self._missing("get_show")

    def get_episodes(self, ref) -> list:
        self._missing("get_episodes")


def check_declared(provider: Provider) -> None:
    """Refuse a provider that is malformed: a bad id, an unknown capability, or
    a declared capability whose methods are not overridden."""
    if not ID_RE.match(provider.id or ""):
        raise ValueError(f"provider id {provider.id!r}: lowercase letters and digits, 1 to 16")
    if provider.role not in (MAIN, FALLBACK):
        raise ValueError(f"{provider.id}: role must be 'main' or 'fallback'")
    unknown = set(provider.capabilities) - CAPABILITIES
    if unknown:
        raise ValueError(f"{provider.id}: unknown capabilities {sorted(unknown)}")
    cls = type(provider)
    for cap in provider.capabilities:
        for name in METHODS[cap]:
            if getattr(cls, name, None) is getattr(Provider, name):
                raise ValueError(f"{provider.id} declares {cap!r} but does not implement {name}()")

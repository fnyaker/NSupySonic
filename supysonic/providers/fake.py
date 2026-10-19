# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A deterministic provider for tests: no network, a catalogue of dicts, real
(tiny) audio, and every failure a real provider can have.

Every method counts its calls (``calls``) so a test can assert that a click
asked nobody, or asked exactly once. ``fake.gone`` names the refs the
"provider" answers are removed; ``fake.fail`` makes methods raise.
"""

import io
import struct
import wave
from collections import Counter

from . import base
from .errors import Gone, NotFound, ProviderUnavailable

ALL = frozenset(base.CAPABILITIES)

# A track the fake knows by default.
DEFAULT_OFFER = {"quality": 100, "fmt": "wav", "bitrate": 1411, "lossless": True}


def tiny_wav(seconds=0.2, rate=8000, tone=440.0) -> bytes:
    """A real WAV a decoder opens (a sine), small enough to write per call."""
    import math

    frames = int(seconds * rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(12000 * math.sin(2 * math.pi * tone * i / rate)))
                for i in range(frames)
            )
        )
    return buf.getvalue()


class FakeProvider(base.Provider):
    def __init__(
        self,
        id="fake",
        catalog=None,
        offers=None,
        *,
        name=None,
        role=base.MAIN,
        capabilities=ALL,
        fail=None,
        requires_credentials=False,
        ready=True,
    ):
        self.id = id
        self.name = name or id.title()
        self.role = role
        self.capabilities = frozenset(capabilities)
        self.requires_credentials = requires_credentials
        self.catalog = dict(catalog or {})  # track ref -> TrackHit
        self.albums = {}  # ref -> {"title", "artists", "tracks": [refs]}
        self.artists = {}
        self.playlists = {}
        self.offers_by_ref = dict(offers or {})  # ref -> [Offer]
        self.gone = set()  # refs the provider answers are removed
        self.fail = fail  # None | Exception | {method: Exception}
        self.ready = ready  # what available() says
        self.status = base.HEALTH_OK
        self.links = {}  # url -> Ref
        self.account_info = {"name": "fake", "status": "ok"}
        self.imported = []  # what import_account yields
        self.calls = Counter()

    # -- plumbing ---------------------------------------------------------------

    def _enter(self, method, ref=None):
        self.calls[method] += 1
        fail = self.fail
        if isinstance(fail, dict):
            fail = fail.get(method, fail.get("*"))
        if fail is not None:
            raise fail
        if ref is not None and ref in self.gone:
            raise Gone(ref, provider=self.id)

    def _track(self, ref):
        try:
            return self.catalog[ref]
        except KeyError:
            raise NotFound(ref, provider=self.id) from None

    def go_down(self):
        self.fail = ProviderUnavailable("down", provider=self.id)

    def come_back(self):
        self.fail = None

    # -- common -----------------------------------------------------------------

    def available(self):
        return self.ready

    def health(self, force=False):
        self.calls["health"] += 1
        return base.health(self.status)

    def config_schema(self):
        return [{"key": "access", "type": "text", "masked": True, "help": "test"}]

    # -- SEARCH -----------------------------------------------------------------

    def search(self, query, kinds=("track",), limit=20):
        self._enter("search")
        q = (query or "").lower()
        hits = [
            dict(h, ref=ref)
            for ref, h in self.catalog.items()
            if q in h.get("title", "").lower()
            or any(q in a.get("name", "").lower() for a in h.get("artists") or [])
        ][:limit]
        return {"tracks": hits if "track" in kinds else [], "albums": [], "artists": [], "playlists": []}

    # -- AUDIO ------------------------------------------------------------------

    def offers(self, ref):
        self._enter("offers", ref)
        self._track(ref)
        return [dict(o) for o in self.offers_by_ref.get(ref, [DEFAULT_OFFER])]

    def fetch(self, ref, offer, dest):
        self._enter("fetch", ref)
        self._track(ref)
        with open(dest, "wb") as fh:
            fh.write(tiny_wav())

    def open_stream(self, ref, offer):
        self._enter("open_stream", ref)
        self._track(ref)
        data = tiny_wav()
        return iter([data[i : i + 1024] for i in range(0, len(data), 1024)])

    def fetch_cover(self, ref, size=1000):
        self._enter("fetch_cover", ref)
        self._track(ref)
        return b"\xff\xd8fake-cover\xff\xd9"

    # -- CATALOG ----------------------------------------------------------------

    def get_track(self, ref):
        self._enter("get_track", ref)
        return dict(self._track(ref), ref=ref)

    def get_album(self, ref):
        self._enter("get_album", ref)
        if ref not in self.albums:
            raise NotFound(ref, provider=self.id)
        album = self.albums[ref]
        return dict(album, ref=ref, tracks=[self.get_track_quiet(r) for r in album.get("tracks", [])])

    def get_track_quiet(self, ref):
        return dict(self._track(ref), ref=ref)

    def get_artist(self, ref):
        self._enter("get_artist", ref)
        if ref not in self.artists:
            raise NotFound(ref, provider=self.id)
        return dict(self.artists[ref], ref=ref)

    def get_artist_albums(self, ref):
        self._enter("get_artist_albums", ref)
        return [dict(a, ref=r) for r, a in self.albums.items() if ref in {x.get("ref") for x in a.get("artists", [])}]

    def get_playlist(self, ref):
        self._enter("get_playlist", ref)
        if ref not in self.playlists:
            raise NotFound(ref, provider=self.id)
        pl = self.playlists[ref]
        return dict(pl, ref=ref, tracks=[self.get_track_quiet(r) for r in pl.get("tracks", [])])

    # -- ACCOUNT ----------------------------------------------------------------

    def account(self):
        self._enter("account")
        return dict(self.account_info)

    def import_account(self):
        self._enter("import_account")
        yield from self.imported

    # -- LINKS ------------------------------------------------------------------

    def parse_link(self, url):
        self._enter("parse_link")
        return self.links.get(url)

    # -- PODCASTS ---------------------------------------------------------------

    def search_shows(self, query, limit=20):
        self._enter("search_shows")
        return []

    def get_show(self, ref):
        self._enter("get_show", ref)
        raise NotFound(ref, provider=self.id)

    def get_episodes(self, ref):
        self._enter("get_episodes", ref)
        return []

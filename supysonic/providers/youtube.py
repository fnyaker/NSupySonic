# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""YouTube behind the provider interface: the FALLBACK, never a second catalogue.

Nothing here adds a request. ``search`` is the one YouTube Music request
``deezer.youtube.search`` already makes (kept a day, empty answers too),
``offers`` answers from what YouTube always sends (Opus ~133k) and asks nobody,
and the audio is downloaded only by ``fetch`` / ``open_stream``, i.e. on a play.
The module's own rules stay where they are: serialised downloads, the hold
after a network failure (a minute) or a refusal (fifteen), and the rule that
only YouTube answering that a video is gone may call it gone.

The admin's switch (``yt.enabled`` in ``Meta``, Réglages → *Source de secours :
YouTube*) is the provider's own switch: it keeps commanding ``enabled()``.
"""

import os
import re
import shutil
import tempfile
import time
from urllib.parse import parse_qs, urlsplit

from ..deezer import youtube as yt
from . import base, quality
from .errors import Gone, ProviderError, ProviderHeld, ProviderUnavailable

ID = "youtube"
ENABLED_KEY = "yt.enabled"  # the same key as webui/youtube.py#ENABLED_KEY
SWITCH_CACHE = 1.0
CHUNK = 64 * 1024

# What format 251 is, and what a hit promises before anything is downloaded.
OPUS_OFFER = {"fmt": "opus", "bitrate": 133, "lossless": False}
_PLAYLIST = re.compile(r"\A[A-Za-z0-9_-]{10,64}\Z")
_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}


def hit_from_youtube(raw: dict) -> dict:
    """A ``youtube.normalize_hit`` dict as a TrackHit."""
    hit = {
        "ref": raw["video_id"],
        "title": raw.get("title") or raw["video_id"],
        "artists": [{"ref": a.get("id") or "", "name": a.get("name") or ""} for a in raw.get("artists") or []],
        "album": {"ref": raw.get("album_id") or "", "name": raw.get("album") or ""},
        "duration": int(raw.get("duration") or 0),
        "explicit": bool(raw.get("explicit")),
        "offers": [YoutubeAdapter._offer()],
    }
    if raw.get("thumb"):
        hit["cover_url"] = raw["thumb"]
    return hit


class YoutubeAdapter(base.Provider):
    id = ID
    name = "YouTube"
    role = base.FALLBACK
    capabilities = frozenset({base.SEARCH, base.AUDIO, base.LINKS})
    requires_credentials = True  # needs the optional extra to be installed
    trust = {}  # a video's title says little: the file's own tags win

    def __init__(self):
        self._switch = (0.0, None)

    # -- the admin's switch -----------------------------------------------------

    def switch(self):
        """``yt.enabled`` (on by default) once the optional extra is installed."""
        if not yt.installed():
            return False
        at, value = self._switch
        now = time.monotonic()
        if now - at < SWITCH_CACHE:
            return value
        try:
            from ..db import Meta

            row = Meta.get_or_none(Meta.key == ENABLED_KEY)
            value = row is None or row.value != "0"
        except Exception:
            value = True  # no database to ask (a tool): the default
        self._switch = (now, value)
        return value

    def toggle(self, on):
        from ..db import Meta

        row = Meta.get_or_none(Meta.key == ENABLED_KEY)
        if row is None:
            Meta.create(key=ENABLED_KEY, value="1" if on else "0")
        else:
            row.value = "1" if on else "0"
            row.save()
        self._switch = (0.0, None)
        return True

    # -- common -----------------------------------------------------------------

    def configured(self):
        return yt.installed()

    def available(self):
        if not yt.installed() or self.switch() is False:
            return False
        return not yt.held()[0]

    def health(self, force=False):
        if not yt.installed():
            return base.health(base.HEALTH_NETWORK, detail="supysonic[youtube] is not installed")
        is_held, left, why = yt.held()
        if is_held:
            return base.health(base.HEALTH_NETWORK, retry_in=left, detail=why)
        return base.health()

    # -- errors -----------------------------------------------------------------

    def _error(self, exc, ref=None):
        """YouTube's exceptions as provider errors. ``Gone`` only when YouTube
        ANSWERED that the video cannot be played."""
        if isinstance(exc, yt.YoutubeUnavailable):
            return Gone(ref or "", provider=ID)
        is_held, left, why = yt.held()
        if isinstance(exc, yt.YoutubeHeld) or is_held:
            return ProviderHeld(why or str(exc), provider=ID, retry_in=left or None)
        return ProviderUnavailable(str(exc), provider=ID)

    def _check(self, ref):
        ref = str(ref or "")
        if not yt.valid_video_id(ref):
            raise ProviderError(f"not a YouTube video id: {ref[:40]!r}", provider=ID)
        return ref

    # -- SEARCH -----------------------------------------------------------------

    def search(self, query, kinds=("track",), limit=20):
        out = {"tracks": [], "albums": [], "artists": [], "playlists": []}
        if "track" not in kinds:
            return out
        try:
            hits = yt.search(query, limit=limit)
        except yt.YoutubeError as exc:
            raise self._error(exc) from exc
        out["tracks"] = [hit_from_youtube(h) for h in hits]
        return out

    # -- AUDIO ------------------------------------------------------------------

    @staticmethod
    def _offer():
        offer = dict(OPUS_OFFER)
        offer["quality"] = quality.from_offer(offer).cls
        return offer

    def offers(self, ref):
        self._check(ref)
        return [self._offer()]  # nobody is asked: the file tells the rest

    def _download(self, ref, workdir):
        try:
            return yt.download_audio(ref, workdir)
        except yt.YoutubeError as exc:
            raise self._error(exc, ref) from exc

    def fetch(self, ref, offer, dest):
        ref = self._check(ref)
        dest = os.fspath(dest)
        parent = os.path.dirname(dest) or "."
        os.makedirs(parent, exist_ok=True)
        workdir = tempfile.mkdtemp(prefix=f"{ref}.", dir=parent)
        try:
            produced = self._download(ref, workdir)
            with open(produced, "rb") as fh:
                if not yt.looks_like_audio(fh.read(16)):
                    raise ProviderUnavailable("YouTube sent something that is not audio", provider=ID)
            os.replace(produced, dest)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def open_stream(self, ref, offer):
        ref = self._check(ref)
        workdir = tempfile.mkdtemp(prefix=f"{ref}.")
        try:
            produced = self._download(ref, workdir)
            with open(produced, "rb") as fh:
                while True:
                    chunk = fh.read(CHUNK)
                    if not chunk:
                        break
                    yield chunk
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def fetch_cover(self, ref, size=1000):
        ref = self._check(ref)
        hit = yt.recall(yt.track_uuid(ref))
        data = yt.fetch_thumbnail((hit or {}).get("thumb"))
        if not data:
            raise ProviderError(f"no cover for {ref}", provider=ID)
        return data

    # -- LINKS ------------------------------------------------------------------

    def parse_link(self, url):
        try:
            parts = urlsplit(str(url or "").strip())
        except ValueError:
            return None
        if parts.scheme.lower() not in ("http", "https"):
            return None
        host = (parts.hostname or "").lower()
        query = parse_qs(parts.query)
        if host == "youtu.be":
            vid = parts.path.strip("/")
            return {"provider": ID, "kind": "track", "ref": vid} if yt.valid_video_id(vid) else None
        if host not in _HOSTS:
            return None
        vid = (query.get("v") or [""])[0]
        if yt.valid_video_id(vid):
            return {"provider": ID, "kind": "track", "ref": vid}
        lid = (query.get("list") or [""])[0]
        if _PLAYLIST.match(lid):
            return {"provider": ID, "kind": "playlist", "ref": lid}
        return None

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The providers that give FACTS and never sound: MusicBrainz, AcoustID, LRCLIB.

They wrap what already exists (``supysonic/enrich``, ``deezer/lyrics.py``) with
its politeness rules: MusicBrainz and AcoustID go through the rate-limited
client whose limiter WAITS, so ``info`` is for worker threads only, like the
enrichment it wraps. Their role is ``info``: the search and the player never
ask them.
"""

from . import base
from .errors import ProviderError, ProviderHeld, ProviderUnavailable


def _translated(fn):
    """The enrichment client's errors in the providers' words."""

    def wrapper(self, feature, query):
        from ..enrich.http import HttpError, Unavailable

        try:
            return fn(self, feature, query or {})
        except Unavailable as exc:
            raise ProviderHeld(str(exc), provider=self.id, retry_in=exc.retry_after) from exc
        except HttpError as exc:
            if exc.status >= 500:
                raise ProviderUnavailable(str(exc), provider=self.id) from exc
            raise ProviderError(str(exc), provider=self.id) from exc
        except OSError as exc:
            raise ProviderUnavailable(str(exc), provider=self.id) from exc

    return wrapper


def _http():
    from ..enrich import queue

    return queue.get_http()


class MusicBrainzProvider(base.Provider):
    id = "musicbrainz"
    name = "MusicBrainz"
    role = base.INFO_ROLE
    capabilities = frozenset({base.INFO})
    trust = {"date": 2, "isrc": 2}
    features = {
        "track_info": {
            "auth": "none",
            "fields": ["isrc", "first_release", "mbid", "composer", "lyricist", "producer"],
        },
    }

    @_translated
    def info(self, feature, query):
        from ..enrich import musicbrainz as mb

        if feature != "track_info":
            return {}
        http = _http()
        mbid = mb.valid_mbid(query.get("mbid"))
        out = {}
        if not mbid and query.get("isrc"):
            found = mb.lookup_isrc(http, query["isrc"], query.get("duration"))
            if not found:
                return {}
            mbid = found["mbid"]
            out["isrc"] = mb.clean_isrc(query["isrc"])
            if found.get("date"):
                out["first_release"] = found["date"]
        if not mbid:
            return {}
        out["mbid"] = mbid
        out.update(mb.credits(http, mbid))
        return out


class AcoustidProvider(base.Provider):
    id = "acoustid"
    name = "AcoustID"
    role = base.INFO_ROLE
    capabilities = frozenset({base.INFO})
    requires_credentials = True
    features = {"track_info": {"auth": "none", "fields": ["mbid", "fingerprint"]}}
    auth_modes = (
        {
            "id": "key",
            "label": "Clé d'application",
            "help": "La clé d'application AcoustID de l'opérateur (Réglages → Enrichissement).",
        },
    )

    def _key(self):
        from ..enrich import queue

        return queue.options().get("acoustid_key")

    def configured(self):
        from ..enrich import acoustid

        return acoustid.available(self._key())

    available = configured

    @_translated
    def info(self, feature, query):
        from ..enrich import acoustid

        path = query.get("path")
        if feature != "track_info" or not path or not self.configured():
            return {}
        fp = acoustid.fingerprint(path)
        if fp is None:
            return {}
        mbid = acoustid.lookup(_http(), self._key(), fp[0], fp[1])
        return {"mbid": mbid, "fingerprint": True} if mbid else {}


class LrclibProvider(base.Provider):
    id = "lrclib"
    name = "LRCLIB"
    role = base.INFO_ROLE
    capabilities = frozenset({base.INFO})
    features = {"lyrics": {"auth": "none", "fields": ["plain", "synced"]}}

    def info(self, feature, query):
        from ..deezer import lyrics

        if feature != "lyrics" or not query or not query.get("title") or not query.get("artist"):
            return {}
        found, answered = lyrics._fetch(
            query["title"], query["artist"], query.get("album"), query.get("duration")
        )
        if not answered:
            raise ProviderUnavailable("LRCLIB did not answer", provider=self.id)
        if not found:
            return {}
        out = {}
        if found.get("synced"):
            out["synced"] = found["synced"]
        if found.get("text"):
            out["plain"] = found["text"]
        return out

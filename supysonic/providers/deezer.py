# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Deezer behind the provider interface.

The adapter WRAPS ``DeezerProvider`` (login, stream decryption, the gateway and
the public API stay where they are, with their resilience rules) and only
translates: Deezer's dicts into the normalised hits, its exceptions into the
provider errors. ``app.deezer`` is untouched and is what the adapter reads on
every call, so a new ARL saved by the admin (``setup_deezer`` swaps the object)
reaches it with no re-registration.

The rule of the translation is CLAUDE.md's: a failure to reach Deezer is never a
verdict. ``Gone`` is raised only from ``TrackUnavailable`` / ``ShowUnavailable``,
which Deezer raises only when it ANSWERED; transport trouble (walking the cause
chain, as ``is_transport_failure`` does) is ``ProviderUnavailable``, a dead
ARL is ``ProviderAuth`` and anything else Deezer said is a plain
``ProviderError``, which condemns nothing.
"""

import contextlib
import re
from pathlib import Path

from deezerpy.errors import DeezerError as DeezerPyError
from deezerpy.errors import is_transport_failure

from ..deezer import library
from ..deezer.provider import (
    COVER_URL,
    DeezerError,
    DeezerProvider,
    ShowUnavailable,
    TrackUnavailable,
)
from . import base, http, quality
from .errors import Gone, ProviderAuth, ProviderError, ProviderUnavailable

ID = "deezer"
HOSTS = DeezerProvider._CORE_HOSTS + ("e-cdns-images.dzcdn.net",)

# Deezer's ids are numbers (a playlist's too); a ref comes from a client or a
# link, so it is checked before it reaches a request path.
_NUM = re.compile(r"\A\d{1,20}\Z")
_LINK = re.compile(
    r"\A/(?:[a-z]{2}(?:-[a-z]{2})?/)?(track|album|artist|playlist|show)/(\d{1,20})/?\Z", re.I
)
_LINK_HOSTS = {"deezer.com", "www.deezer.com"}

# What a stream of each format is, for the quality scale.
_FORMATS = (
    # (gateway FILESIZE key, Deezer format name, offer)
    ("FILESIZE_FLAC", "FLAC", {"fmt": "flac", "bitrate": 1000, "lossless": True,
                                "bit_depth": 16, "sample_rate": 44100}),
    ("FILESIZE_MP3_320", "MP3_320", {"fmt": "mp3", "bitrate": 320, "lossless": False}),
    ("FILESIZE_MP3_128", "MP3_128", {"fmt": "mp3", "bitrate": 128, "lossless": False}),
)
_QUALITY_OF_FMT = {"flac": "FLAC", "mp3": "MP3_320"}


def _ref(value):
    value = str(value if value is not None else "").strip()
    if not _NUM.match(value):
        raise ProviderError(f"not a Deezer id: {value[:40]!r}", provider=ID)
    return value


def _named(ref, name):
    return {"ref": str(ref) if ref not in (None, "") else "", "name": str(name or "")}


def cover_url(md5, size=1000):
    return COVER_URL.format(md5=md5, w=size) if md5 else None


def hit_from_gw(t: dict) -> dict:
    """A gateway track (song.getData, a playlist or album list) as a TrackHit."""
    norm = library.normalize_track(t)
    artists = [_named(c[0], c[1]) for c in norm["credits"]] or [
        _named(norm["art_id"] if t.get("ART_ID") else "", t.get("ART_NAME"))
    ]
    hit = {
        "ref": norm["sng_id"],
        "title": norm["title"],
        "artists": artists,
        "album": _named(norm["alb_id"] if t.get("ALB_ID") else "", t.get("ALB_TITLE")),
        "duration": norm["duration"],
        "number": norm["number"],
        "disc": norm["disc"],
        "explicit": str(t.get("EXPLICIT_LYRICS") or "0") == "1",
    }
    if t.get("ISRC"):
        hit["isrc"] = str(t["ISRC"])
    if norm["release_date"]:
        hit["release_date"] = norm["release_date"]
    url = cover_url(norm["cover_md5"])
    if url:
        hit["cover_url"] = url
    return hit


def hit_from_api(t: dict) -> dict:
    """A public-API track (search, charts, top tracks) as a TrackHit."""
    artist = t.get("artist") or {}
    album = t.get("album") or {}
    hit = {
        "ref": str(t.get("id")),
        "title": str(t.get("title") or ""),
        "artists": [_named(artist.get("id"), artist.get("name"))],
        "album": _named(album.get("id"), album.get("title")),
        "duration": int(t.get("duration") or 0),
        "explicit": bool(t.get("explicit_lyrics")),
    }
    if t.get("isrc"):
        hit["isrc"] = str(t["isrc"])
    url = album.get("cover_xl") or album.get("cover_big") or album.get("cover")
    if url:
        hit["cover_url"] = url
    return hit


def _album_from_api(a: dict) -> dict:
    artist = a.get("artist") or {}
    return {
        "ref": str(a.get("id")),
        "title": str(a.get("title") or ""),
        "artists": [_named(artist.get("id"), artist.get("name"))],
        "cover_url": a.get("cover_xl") or a.get("cover_big") or a.get("cover"),
        "tracks_count": int(a.get("nb_tracks") or 0),
    }


def _artist_from_api(a: dict) -> dict:
    return {
        "ref": str(a.get("id")),
        "name": str(a.get("name") or ""),
        "cover_url": a.get("picture_xl") or a.get("picture_big") or a.get("picture"),
        "fans": int(a.get("nb_fan") or 0),
    }


def _playlist_from_api(p: dict) -> dict:
    return {
        "ref": str(p.get("id")),
        "title": str(p.get("title") or ""),
        "cover_url": p.get("picture_xl") or p.get("picture_big") or p.get("picture"),
        "tracks_count": int(p.get("nb_tracks") or 0),
        "owner": str((p.get("user") or {}).get("name") or ""),
    }


class DeezerAdapter(base.Provider):
    id = ID
    name = "Deezer"
    role = base.MAIN
    capabilities = frozenset(
        {base.SEARCH, base.AUDIO, base.CATALOG, base.ACCOUNT, base.LINKS, base.PODCASTS,
         base.RELATED, base.INFO, base.LIBRARY}
    )
    requires_credentials = True
    # What Deezer itself needs (plan §15): its public API answers the catalogue
    # without an account; the sound, the podcasts and the account's own library
    # need one. (The adapter still reaches all of it through the server's
    # account: an anonymous path is lot P3.)
    features = {
        "search": {"auth": "none"},
        "browse": {"auth": "none"},
        "links": {"auth": "none"},
        "related": {"auth": "none"},
        "stream": {"auth": "account"},
        "podcasts": {"auth": "account"},
        "track_info": {
            "auth": "none",
            "fields": ["title", "artists", "album", "duration", "isrc", "release_date",
                       "contributors", "label", "explicit", "cover"],
        },
        "artist_info": {"auth": "none", "fields": ["name", "picture", "fans"]},
        "album_info": {
            "auth": "none",
            "fields": ["title", "cover", "tracks", "release_date"],
        },
        "my_tracks": {"auth": "account"},
        "my_albums": {"auth": "account"},
        "my_artists": {"auth": "account"},
        "my_playlists": {"auth": "account"},
    }
    anonymous_use = False
    auth_modes = (
        {
            "id": "browser",
            "label": "Identifiant et mot de passe Deezer",
            "help": "Sur la page de connexion de Deezer, dans l'application Android : "
            "le mot de passe ne passe jamais par le serveur, seul l'ARL revient.",
            "app_only": True,
        },
        {
            "id": "arl",
            "label": "ARL",
            "help": "Le cookie arl d'une session Deezer ouverte dans un navigateur.",
        },
    )
    # Deezer's own facts are exact (dates, ISRC, ids); its genre and BPM are not
    # believed over what is measured (plan §6).
    trust = {"date": 3, "isrc": 3, "artist": 3, "bpm": 1}

    def __init__(self, get_provider):
        """``get_provider()`` returns the live ``DeezerProvider`` or None (the
        proxy is off or has no ARL). Called on every use, never cached."""
        self._get = get_provider
        http.register_hosts(ID, HOSTS)

    # -- plumbing ---------------------------------------------------------------

    def _p(self) -> DeezerProvider:
        provider = self._get()
        if provider is None:
            raise ProviderUnavailable("Deezer is not configured", provider=ID)
        return provider

    @contextlib.contextmanager
    def _translated(self, ref=None):
        """Run a block of Deezer calls; whatever it raises becomes a provider
        error that says exactly as much as Deezer did."""
        try:
            yield
        except ProviderError:
            raise
        except Exception as exc:
            if is_transport_failure(exc):
                raise ProviderUnavailable(
                    str(exc), provider=ID, retry_in=http.retry_in(ID) or None
                ) from exc
            if isinstance(exc, (TrackUnavailable, ShowUnavailable)):
                raise Gone(ref or "", provider=ID) from exc
            if isinstance(exc, (DeezerError, DeezerPyError)):
                provider = self._get()
                login = getattr(provider, "_login_error", None)
                if login and login[0] == "arl":
                    raise ProviderAuth(login[1], provider=ID) from exc
                raise ProviderError(str(exc), provider=ID) from exc
            raise

    # -- common -----------------------------------------------------------------

    def configured(self):
        return self._get() is not None

    def available(self):
        provider = self._get()
        return provider is not None and provider.available()

    def health(self, force=False):
        provider = self._get()
        if provider is None:
            return base.health(base.HEALTH_AUTH, detail="no ARL")
        result = provider.check_login(force=force)
        if result.get("ok"):
            return base.health()
        if result.get("reason") == "arl":
            return base.health(base.HEALTH_AUTH, detail=result.get("detail"))
        outage = provider.outage() or {}
        return base.health(
            base.HEALTH_NETWORK, retry_in=outage.get("retry_in"), detail=result.get("detail")
        )

    def config_schema(self):
        return [
            {
                "key": "arl",
                "type": "arl-cookie",
                "masked": True,
                "help": "Le cookie arl de votre compte Deezer (jamais renvoyé).",
            }
        ]

    # -- SEARCH -----------------------------------------------------------------

    def search(self, query, kinds=("track",), limit=20):
        out = {"tracks": [], "albums": [], "artists": [], "playlists": []}
        with self._translated():
            api = self._p().dz.api
            if "track" in kinds:
                rows = (api.search_track(query, limit=limit) or {}).get("data") or []
                out["tracks"] = [hit_from_api(t) for t in rows if t.get("id")]
            if "album" in kinds:
                rows = (api.search_album(query, limit=limit) or {}).get("data") or []
                out["albums"] = [_album_from_api(a) for a in rows if a.get("id")]
            if "artist" in kinds:
                rows = (api.search_artist(query, limit=limit) or {}).get("data") or []
                out["artists"] = [_artist_from_api(a) for a in rows if a.get("id")]
            if "playlist" in kinds:
                rows = (api.search_playlist(query, limit=limit) or {}).get("data") or []
                out["playlists"] = [_playlist_from_api(p) for p in rows if p.get("id")]
        return out

    # -- AUDIO ------------------------------------------------------------------

    def offers(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            provider = self._p()
            info = provider.get_track_info(ref)
            lossless = provider.can_lossless
        offers = []
        for key, _fmt, template in _FORMATS:
            if not template["lossless"] or lossless:
                try:
                    present = int(info.get(key) or 0) > 0
                except (TypeError, ValueError):
                    present = False
                if present:
                    offers.append(self._offer(template))
        if not offers:
            # Deezer lists no file size for this track: what the account may
            # stream is the honest answer (the stream request has the last word).
            nominal = _FORMATS if lossless else _FORMATS[1:]
            offers = [self._offer(t) for _k, _f, t in nominal]
        return offers

    @staticmethod
    def _offer(template):
        offer = dict(template)
        offer["quality"] = quality.from_offer(offer).cls
        return offer

    def _resolve(self, ref, offer):
        wanted = _QUALITY_OF_FMT.get(str((offer or {}).get("fmt") or "").lower(), "FLAC")
        if wanted == "MP3_320" and int((offer or {}).get("bitrate") or 320) <= 128:
            wanted = "MP3_128"
        url, _fmt, _info, used = self._p().resolve(ref, wanted)
        return url, used

    def fetch(self, ref, offer, dest):
        ref = _ref(ref)
        with self._translated(ref):
            provider = self._p()
            url, used = self._resolve(ref, offer)
            provider.download_to(url, used, Path(dest))

    def open_stream(self, ref, offer):
        ref = _ref(ref)
        with self._translated(ref):
            provider = self._p()
            url, used = self._resolve(ref, offer)
            first = provider.iter_decrypted(url, used)
            head = next(first, b"")
        return self._chain(head, first, ref)

    def _chain(self, head, rest, ref):
        if head:
            yield head
        with self._translated(ref):
            yield from rest

    def fetch_cover(self, ref, size=1000):
        ref = _ref(ref)
        with self._translated(ref):
            provider = self._p()
            md5 = provider.get_track_info(ref).get("ALB_PICTURE")
            data = provider.fetch_cover(md5, size) if md5 else None
        if not data:
            raise ProviderError(f"no cover for {ref}", provider=ID)
        return data

    # -- CATALOG ----------------------------------------------------------------

    def get_track(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            return hit_from_gw(self._p().get_track_info(ref))

    def get_album(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            provider = self._p()
            data = (provider.get_album_page(ref) or {}).get("DATA") or {}
            tracks = provider.get_album_tracks(ref)  # the FULL list, never the page's
        return {
            "ref": ref,
            "title": str(data.get("ALB_TITLE") or ""),
            "artists": [_named(data.get("ART_ID"), data.get("ART_NAME"))],
            "cover_url": cover_url(data.get("ALB_PICTURE")),
            "release_date": library.release_date_of(data),
            "tracks": [hit_from_gw(t) for t in tracks],
        }

    def get_artist(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            data = self._p().get_artist(ref) or {}
        return {
            "ref": ref,
            "name": str(data.get("ART_NAME") or ""),
            "cover_url": (
                f"https://e-cdns-images.dzcdn.net/images/artist/{data['ART_PICTURE']}/1000x1000-000000-80-0-0.jpg"
                if data.get("ART_PICTURE")
                else None
            ),
            "fans": int(data.get("NB_FAN") or 0),
        }

    def get_artist_albums(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            tabs = self._p().get_artist_discography(ref) or {}
        out = []
        for a in tabs.get("all") or []:
            if not a.get("ALB_ID"):
                continue
            out.append(
                {
                    "ref": str(a["ALB_ID"]),
                    "title": str(a.get("ALB_TITLE") or ""),
                    "artists": [_named(a.get("ART_ID") or ref, a.get("ART_NAME"))],
                    "cover_url": cover_url(a.get("ALB_PICTURE")),
                    "release_date": library.release_date_of(a),
                }
            )
        return out

    def get_playlist(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            provider = self._p()
            data = (provider.get_playlist_page(ref) or {}).get("DATA") or {}
            tracks = provider.get_playlist_tracks(ref)  # the FULL list
        return {
            "ref": ref,
            "title": str(data.get("TITLE") or ""),
            "description": str(data.get("DESCRIPTION") or ""),
            "owner": str(data.get("PARENT_USERNAME") or ""),
            "tracks": [hit_from_gw(t) for t in tracks],
        }

    # -- ACCOUNT (read only) ----------------------------------------------------

    def account(self):
        provider = self._get()
        if provider is None:
            return {"name": None, "status": base.HEALTH_AUTH}
        result = provider.check_login()
        status = (
            base.HEALTH_OK
            if result.get("ok")
            else base.HEALTH_AUTH if result.get("reason") == "arl" else base.HEALTH_NETWORK
        )
        return {"name": result.get("account"), "status": status}

    def import_account(self):
        """The account's playlists then its favourites, read and never written:
        the very calls of the one-off import (the guard test lists them)."""
        with self._translated():
            provider = self._p()
            gw = provider.dz.gw
            playlists = gw.get_user_playlists(provider.user_id, limit=1000)
        for pl in playlists:
            with self._translated(str(pl.get("id"))):
                raw = gw.get_playlist_tracks(pl["id"])
            yield {
                "kind": "playlist",
                "ref": str(pl["id"]),
                "title": str(pl.get("title") or "Playlist"),
                "description": str(pl.get("description") or ""),
                "tracks": [hit_from_gw(t) for t in raw],
            }
        with self._translated():
            raw_ids = gw.get_user_favorite_ids(limit=100000)
            sng_ids = [x["SNG_ID"] for x in raw_ids.get("data", [])]
            tracks = []
            for i in range(0, len(sng_ids), 200):
                tracks.extend(gw.get_tracks(sng_ids[i : i + 200]))
        yield {"kind": "favorites", "tracks": [hit_from_gw(t) for t in tracks]}

    # -- INFO -------------------------------------------------------------------

    def info(self, feature, query):
        ref = (query or {}).get("ref")
        if not ref:
            return {}  # Deezer is asked about its own records only
        if feature == "track_info":
            ref = _ref(ref)
            with self._translated(ref):
                raw = self._p().get_track_info(ref)
            out = dict(hit_from_gw(raw))
            roles = raw.get("SNG_CONTRIBUTORS")
            if isinstance(roles, dict):
                out["contributors"] = {
                    str(k)[:40]: [str(n)[:160] for n in (v or [])[:40]]
                    for k, v in list(roles.items())[:40]
                    if isinstance(v, list)
                }
            if raw.get("LABEL_NAME"):
                out["label"] = str(raw["LABEL_NAME"])[:160]
            if out.get("cover_url"):
                out["cover"] = out.pop("cover_url")
            return out
        if feature == "artist_info":
            got = self.get_artist(ref)
            return {"name": got["name"], "picture": got["cover_url"], "fans": got["fans"]}
        if feature == "album_info":
            got = self.get_album(ref)
            return {
                "title": got["title"],
                "cover": got["cover_url"],
                "tracks": got["tracks"],
                "release_date": got["release_date"],
            }
        return {}

    # -- LIBRARY (read only, the holder's) -----------------------------------------

    _TABS = {"artists": "artists", "albums": "albums"}

    def library(self, kind, account=None):
        """The account's own favourites, read and never written. ``account``
        is a ``DeezerProvider`` signed in as somebody (lot P2); None is the
        server's account."""
        with self._translated():
            provider = account if account is not None else self._p()
            gw = provider.dz.gw
            uid = provider.user_id
        if kind == "tracks":
            with self._translated():
                raw_ids = gw.get_user_favorite_ids(limit=100000)
                sng_ids = [x["SNG_ID"] for x in (raw_ids or {}).get("data", [])]
            for i in range(0, len(sng_ids), 200):
                with self._translated():
                    chunk = gw.get_tracks(sng_ids[i : i + 200])
                for t in chunk:
                    yield hit_from_gw(t)
        elif kind == "playlists":
            with self._translated():
                found = gw.get_user_playlists(uid, limit=1000)
            for pl in found:
                yield {
                    "ref": str(pl.get("id")),
                    "title": str(pl.get("title") or "Playlist"),
                    "description": str(pl.get("description") or ""),
                    "tracks_count": int(pl.get("nb_tracks") or 0),
                    "cover_url": pl.get("picture_xl") or pl.get("picture_big") or None,
                }
        elif kind in self._TABS:
            tab = self._TABS[kind]
            with self._translated():
                page = gw.get_user_profile_page(uid, tab, limit=10000) or {}
            rows = ((page.get("TAB") or {}).get(tab) or {}).get("data") or []
            for row in rows:
                if kind == "artists" and row.get("ART_ID"):
                    yield {
                        "ref": str(row["ART_ID"]),
                        "name": str(row.get("ART_NAME") or ""),
                        "cover_url": (
                            f"https://e-cdns-images.dzcdn.net/images/artist/{row['ART_PICTURE']}/500x500-000000-80-0-0.jpg"
                            if row.get("ART_PICTURE")
                            else None
                        ),
                    }
                elif kind == "albums" and row.get("ALB_ID"):
                    yield {
                        "ref": str(row["ALB_ID"]),
                        "title": str(row.get("ALB_TITLE") or ""),
                        "artists": [_named(row.get("ART_ID"), row.get("ART_NAME"))],
                        "cover_url": cover_url(row.get("ALB_PICTURE")),
                    }

    # -- LINKS ------------------------------------------------------------------

    def parse_link(self, url):
        from urllib.parse import urlsplit

        try:
            parts = urlsplit(str(url or "").strip())
        except ValueError:
            return None
        if parts.scheme.lower() not in ("http", "https") or (parts.hostname or "").lower() not in _LINK_HOSTS:
            return None
        m = _LINK.match(parts.path or "/")
        if not m:
            return None
        return {"provider": ID, "kind": m.group(1).lower(), "ref": m.group(2)}

    # -- PODCASTS ---------------------------------------------------------------

    def search_shows(self, query, limit=20):
        with self._translated():
            rows = self._p().search_podcasts(query, limit=limit)
        return [
            {
                "ref": str(r.get("id")),
                "title": str(r.get("title") or ""),
                "cover_url": r.get("picture_xl") or r.get("picture_big") or r.get("picture"),
            }
            for r in rows
            if r.get("id")
        ]

    def get_show(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            page = self._p().get_show_page(ref)
        data = page.get("DATA") or {}
        return {
            "ref": ref,
            "title": str(data.get("SHOW_NAME") or ""),
            "description": str(data.get("SHOW_DESCRIPTION") or ""),
        }

    def get_episodes(self, ref):
        ref = _ref(ref)
        with self._translated(ref):
            rows = self._p().get_show_episodes(ref)
        return [
            {"ref": str(e.get("EPISODE_ID")), "title": str(e.get("EPISODE_TITLE") or ""),
             "duration": int(e.get("DURATION") or 0)}
            for e in rows or []
            if e.get("EPISODE_ID")
        ]

    # -- RELATED (catalogue facts, read by the background job only) -------------

    def artist_releases(self, ref, limit=50):
        ref = _ref(ref)
        with self._translated(ref):
            rows = self._p().get_artist_releases(ref, limit=max(limit, 100))
        out = []
        for a in rows:
            if not isinstance(a, dict) or not a.get("id"):
                continue
            date = str(a.get("release_date") or "")[:10]
            out.append(
                {
                    "ref": str(a["id"]),
                    "title": str(a.get("title") or ""),
                    "cover_url": a.get("cover_xl") or a.get("cover_big") or a.get("cover"),
                    "release_date": date if len(date) == 10 else None,
                    "kind": str(a.get("record_type") or "album")[:12],
                    "tracks_count": int(a.get("nb_tracks") or 0) or None,
                }
            )
        out.sort(key=lambda r: r["release_date"] or "", reverse=True)
        return out[:limit]

    def similar_artists(self, ref, limit=20):
        ref = _ref(ref)
        with self._translated(ref):
            rows = self._p().get_artist_related(ref, limit=limit)
        return [_artist_from_api(a) for a in rows if isinstance(a, dict) and a.get("id")][:limit]

    def artist_top(self, ref, limit=5):
        ref = _ref(ref)
        with self._translated(ref):
            rows = self._p().get_artist_top(ref, limit=limit)
        return [hit_from_api(t) for t in rows if isinstance(t, dict) and t.get("id")][:limit]

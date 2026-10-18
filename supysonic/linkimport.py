# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""A shared playlist link → a plain tracklist.

Somebody sends a Deezer, Spotify, YouTube or Apple Music link; what we keep of
it is what a person would read off the screen — the playlist's name and cover,
and per track its title, its artists, its album and its length (plus an ISRC
where the source gives one). Nothing here plays anything or touches the
database: matching each line to a sound we can play is the caller's business
(``webui/playlist_import.py``).

**What is fetched is built from the parsed id, never the pasted URL.** The text
a user pastes is only ever read by the regexes below; every request goes to a
fixed host with a path made of a validated id. The one exception is a SHORT
link (``link.deezer.com/s/…``, ``spotify.link/…``): it is asked for its
redirect without following it, and the target must itself parse as a link of
the same service before anything else is fetched — so a pasted URL can never
point this server at an address of the paster's choosing.

No credentials anywhere. Spotify's tracklist comes from its public embed page,
Apple Music's from the page its share link opens, YouTube's from YouTube
Music's own API (``ytmusicapi``, the optional extra the YouTube fallback
already uses), Deezer's from its public API. Each of those pages may change
shape: the parsers walk the data for what a track looks like rather than
trusting one path, and a page they cannot read is an error that says so.
"""

from __future__ import annotations

import html
import json
import re
from urllib.parse import parse_qs, urljoin, urlsplit

# A playlist longer than this is cut (and says so): matching is one search per
# line, and nobody listens to the 4 001st track of a link somebody sent them.
MAX_TRACKS = 1000
MAX_URL = 2048
MAX_PAGE = 8 * 1024 * 1024  # bytes read of a page, at most

SOURCES = ("deezer", "spotify", "youtube", "apple")
LABELS = {"deezer": "Deezer", "spotify": "Spotify", "youtube": "YouTube", "apple": "Apple Music"}

# A real browser's user agent: the embed / share pages answer a bare client
# with a consent wall or a stripped page.
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36"
)


class LinkError(Exception):
    """The link could not be read. ``str()`` is shown to the user (French)."""


# -- parsing ----------------------------------------------------------------------

_URL_RE = re.compile(r"(?:https?://|spotify:)[^\s\"'<>]+", re.IGNORECASE)

_DEEZER_HOSTS = {"deezer.com", "www.deezer.com"}
_DEEZER_SHORT = {"link.deezer.com", "deezer.page.link", "dzr.page.link"}
_DEEZER_PATH = re.compile(r"\A/(?:[a-z]{2}(?:-[a-z]{2})?/)?(playlist|album)/(\d{1,20})/?\Z", re.I)

_SPOTIFY_HOSTS = {"open.spotify.com", "play.spotify.com"}
_SPOTIFY_SHORT = {"spotify.link", "spoti.fi"}
_SPOTIFY_PATH = re.compile(
    r"\A/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(?:embed/)?(playlist|album)/([A-Za-z0-9]{22})/?\Z", re.I
)
_SPOTIFY_URI = re.compile(r"\Aspotify:(playlist|album):([A-Za-z0-9]{22})\Z", re.I)

_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
_YOUTUBE_SHORT = {"youtu.be"}
_YT_LIST = re.compile(r"\A[A-Za-z0-9_-]{10,64}\Z")
_YT_BROWSE = re.compile(r"\A/browse/VL([A-Za-z0-9_-]{10,64})/?\Z")

_APPLE_HOSTS = {"music.apple.com", "embed.music.apple.com", "itunes.apple.com"}
_APPLE_PATH = re.compile(
    r"\A/([a-z]{2})/(playlist|album)/(?:([^/]{1,200})/)?(pl\.[A-Za-z0-9._-]{4,80}|\d{1,20})/?\Z",
    re.I,
)
_SLUG_SAFE = re.compile(r"[^A-Za-z0-9%._~-]")


def find_url(text) -> str | None:
    """The first link in ``text`` (people paste "écoute ça : https://…")."""
    text = str(text or "")[:MAX_URL * 2]
    m = _URL_RE.search(text)
    if not m:
        return None
    url = m.group(0).rstrip(").,;!?»\"'")
    return url[:MAX_URL]


def parse(text) -> dict | None:
    """``{source, kind, id, …}`` for a link this module can read, else None.

    ``kind`` is "playlist" or "album", or "short" for a short link whose target
    has to be asked first (``resolve_short``).
    """
    url = find_url(text)
    if not url:
        return None
    m = _SPOTIFY_URI.match(url)
    if m:
        return {"source": "spotify", "kind": m.group(1).lower(), "id": m.group(2)}
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https"):
        return None
    host = (parts.hostname or "").lower()
    path = parts.path or "/"

    if host in _DEEZER_HOSTS:
        m = _DEEZER_PATH.match(path)
        if m:
            return {"source": "deezer", "kind": m.group(1).lower(), "id": m.group(2)}
        return None
    if host in _DEEZER_SHORT:
        return {"source": "deezer", "kind": "short", "url": f"https://{host}{_safe_path(path)}"}

    if host in _SPOTIFY_HOSTS:
        m = _SPOTIFY_PATH.match(path)
        if m:
            return {"source": "spotify", "kind": m.group(1).lower(), "id": m.group(2)}
        return None
    if host in _SPOTIFY_SHORT:
        return {"source": "spotify", "kind": "short", "url": f"https://{host}{_safe_path(path)}"}

    if host in _YOUTUBE_HOSTS or host in _YOUTUBE_SHORT:
        lid = (parse_qs(parts.query).get("list") or [""])[0]
        if not lid:
            m = _YT_BROWSE.match(path)
            lid = m.group(1) if m else ""
        if _YT_LIST.match(lid):
            return {"source": "youtube", "kind": "playlist", "id": lid}
        return None

    if host in _APPLE_HOSTS:
        m = _APPLE_PATH.match(path)
        if m:
            slug = _SLUG_SAFE.sub("", m.group(3) or "") or "x"
            return {
                "source": "apple",
                "kind": m.group(2).lower(),
                "id": m.group(4),
                "country": m.group(1).lower(),
                "slug": slug[:200],
            }
        return None
    return None


def _safe_path(path: str) -> str:
    """A short link's path, with nothing in it that could steer the request."""
    clean = re.sub(r"[^A-Za-z0-9/_.-]", "", path or "/")
    return "/" + clean.lstrip("/")[:200]


def resolve_short(session, link: dict, hops: int = 4) -> dict:
    """Follow a short link's redirects by hand, each one checked.

    Every hop must land on a host of the SAME service; the first one that parses
    as a full link is the answer. Raises ``LinkError`` otherwise.
    """
    url = link["url"]
    source = link["source"]
    for _ in range(hops):
        try:
            resp = session.get(
                url, allow_redirects=False, headers={"User-Agent": BROWSER_UA}, stream=True
            )
            location = resp.headers.get("Location")
            body = b""
            if not location and resp.status_code == 200:
                # Firebase dynamic links (deezer.page.link) answer a page that
                # carries the target instead of redirecting to it.
                body = _read(resp, 256 * 1024)
            resp.close()
        except Exception as exc:
            raise LinkError(f"Le lien court ne répond pas ({_short_cause(exc)})") from exc
        if not location and body:
            text = body.decode("utf-8", "replace")
            for candidate in _URL_RE.findall(html.unescape(text)):
                got = parse(candidate)
                if got and got["source"] == source and got["kind"] != "short":
                    return got
        if not location:
            break
        url = urljoin(url, location)
        got = parse(url)
        if got is None or got["source"] != source:
            break
        if got["kind"] != "short":
            return got
        url = got["url"]
    raise LinkError("Ce lien court ne mène à aucune playlist reconnue")


def _short_cause(exc) -> str:
    return type(exc).__name__


# -- reading ------------------------------------------------------------------------


def _read(resp, limit=MAX_PAGE) -> bytes:
    out = bytearray()
    for chunk in resp.iter_content(64 * 1024):
        out += chunk
        if len(out) > limit:
            break
    return bytes(out)


def _get_page(session, url: str, what: str) -> str:
    try:
        resp = session.get(
            url,
            headers={"User-Agent": BROWSER_UA, "Accept-Language": "fr,en;q=0.8"},
            stream=True,
        )
    except Exception as exc:
        raise LinkError(f"{what} ne répond pas ({_short_cause(exc)})") from exc
    try:
        if resp.status_code == 404:
            raise LinkError(f"Playlist introuvable sur {what} (supprimée ou privée ?)")
        if resp.status_code >= 400:
            raise LinkError(f"{what} a refusé la demande (HTTP {resp.status_code})")
        return _read(resp).decode("utf-8", "replace")
    finally:
        resp.close()


def entry(title, artists=(), album=None, duration=0, isrc=None, **extra) -> dict | None:
    """One line of a tracklist, every field bounded (it is third-party text)."""
    title = " ".join(str(title or "").split())[:300]
    if not title:
        return None
    names = []
    for a in artists or ():
        name = " ".join(str(a or "").split())[:200]
        if name and name not in names:
            names.append(name)
    try:
        duration = max(0, min(int(duration or 0), 24 * 3600))
    except (TypeError, ValueError):
        duration = 0
    isrc = str(isrc or "").strip().upper()
    out = {
        "title": title,
        "artists": names[:10],
        "album": (" ".join(str(album or "").split())[:300]) or None,
        "duration": duration,
        "isrc": isrc if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}\d{7}", isrc) else None,
    }
    out.update(extra)
    return out


def _result(name, cover, tracks, total=None) -> dict:
    tracks = [t for t in tracks if t]
    truncated = len(tracks) > MAX_TRACKS or (total is not None and total > len(tracks))
    return {
        "name": " ".join(str(name or "").split())[:300] or "Playlist importée",
        "cover": cover if isinstance(cover, str) and cover.startswith("https://") else None,
        "tracks": tracks[:MAX_TRACKS],
        "total": max(int(total or 0), len(tracks)),
        "truncated": truncated,
    }


# Deezer ----------------------------------------------------------------------------


def read_deezer(api, link: dict) -> dict:
    """Through the public API client (``deezerpy.API``): it pages, and each
    track comes back in the shape the rest of the app already reads (``raw``)."""
    kind, ident = link["kind"], link["id"]
    try:
        meta = (api.get_album(ident) if kind == "album" else api.get_playlist(ident)) or {}
    except Exception as exc:
        raise LinkError(_deezer_cause(exc)) from exc
    if not isinstance(meta, dict) or not meta.get("id"):
        raise LinkError("Playlist introuvable sur Deezer (supprimée ou privée ?)")
    album = {"id": meta.get("id"), "title": meta.get("title"), "cover_medium": meta.get("cover_medium"),
             "cover_big": meta.get("cover_big")} if kind == "album" else None
    raws, index, total = [], 0, None
    while len(raws) < MAX_TRACKS + 1:
        try:
            page = (
                api.get_album_tracks(ident, index=index, limit=100)
                if kind == "album"
                else api.get_playlist_tracks(ident, index=index, limit=100)
            ) or {}
        except Exception as exc:
            if raws:
                break  # keep what was read: a long list cut short still plays
            raise LinkError(_deezer_cause(exc)) from exc
        data = [t for t in (page.get("data") or []) if isinstance(t, dict) and t.get("id")]
        if total is None and isinstance(page.get("total"), int):
            total = page["total"]
        raws += data
        index += 100
        if not data or not page.get("next"):
            break
    tracks = []
    for raw in raws:
        if album is not None and not raw.get("album"):
            raw = dict(raw, album=album)
        art = raw.get("artist") or {}
        tracks.append(
            entry(
                raw.get("title") or raw.get("title_short"),
                [art.get("name")],
                (raw.get("album") or {}).get("title"),
                raw.get("duration"),
                raw.get("isrc"),
                raw=raw,
            )
        )
    cover = meta.get("picture_xl") or meta.get("picture_big") or meta.get("cover_xl") or meta.get("cover_big")
    return _result(meta.get("title"), cover, tracks, total)


def _deezer_cause(exc) -> str:
    from deezerpy.errors import is_transport_failure

    if is_transport_failure(exc):
        return "Deezer est injoignable"
    text = str(exc)
    if "DataException" in type(exc).__name__ or "no data" in text.lower():
        return "Playlist introuvable sur Deezer (supprimée ou privée ?)"
    return f"Deezer n'a pas répondu ({type(exc).__name__})"


# Spotify ---------------------------------------------------------------------------

_NEXT_DATA = re.compile(
    r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S | re.I
)


def read_spotify(session, link: dict) -> dict:
    """The embed player's page: it carries the whole tracklist as JSON, with no
    token and no account (the Web API needs both since 2024)."""
    url = f"https://open.spotify.com/embed/{link['kind']}/{link['id']}"
    return parse_spotify(_get_page(session, url, "Spotify"))


def parse_spotify(page: str) -> dict:
    m = _NEXT_DATA.search(page)
    if not m:
        raise LinkError("Page Spotify illisible (format inattendu)")
    try:
        data = json.loads(m.group(1))
    except ValueError as exc:
        raise LinkError("Page Spotify illisible (JSON invalide)") from exc
    entity = _dig(data, "props", "pageProps", "state", "data", "entity")
    if not isinstance(entity, dict):
        entity = _find_dict(data, lambda d: isinstance(d.get("trackList"), list))
    if not isinstance(entity, dict) or not isinstance(entity.get("trackList"), list):
        raise LinkError("Playlist introuvable sur Spotify (supprimée ou privée ?)")
    tracks = []
    for t in entity["trackList"]:
        if not isinstance(t, dict):
            continue
        if t.get("entityType") not in (None, "track"):
            continue  # an episode in a playlist
        artists = [a.strip() for a in str(t.get("subtitle") or "").replace(" ", " ").split(",")]
        tracks.append(
            entry(t.get("title"), artists, None, round((t.get("duration") or 0) / 1000), None)
        )
    cover = None
    sources = _dig(entity, "coverArt", "sources") or _dig(entity, "visualIdentity", "image") or []
    if isinstance(sources, list):
        best = max(
            (s for s in sources if isinstance(s, dict) and str(s.get("url", "")).startswith("https://")),
            key=lambda s: s.get("width") or s.get("maxWidth") or 0,
            default=None,
        )
        cover = best.get("url") if best else None
    return _result(entity.get("name") or entity.get("title"), cover, tracks)


# YouTube ---------------------------------------------------------------------------

# What a video title adds to the song's: "(Official Video)", "[Clip officiel]",
# "| Lyrics"… A real version word (remix, live) is left alone.
_VIDEO_NOISE = re.compile(
    r"[\(\[][^\)\]]*\b(?:official|officiel(?:le)?|clip|video|vid[ée]o|audio|lyrics?|paroles|"
    r"visuali[sz]er|hd|hq|4k|mv)\b[^\)\]]*[\)\]]|\s[|｜].*\Z",
    re.I,
)
_CHANNEL_NOISE = re.compile(r"(?:\s*-\s*topic|vevo|\s+official)\Z", re.I)


def clean_video_title(title: str, artists: list) -> tuple[str, list]:
    """``(title, artists)`` of a plain YouTube video, as a song would be named.

    A YouTube Music track already is; a video uploaded on a channel is usually
    "Artist - Title (Official Video)", credited to the channel."""
    title = " ".join(_VIDEO_NOISE.sub(" ", title or "").split()) or (title or "")
    artists = [_CHANNEL_NOISE.sub("", a).strip() for a in artists if a]
    artists = [a for a in artists if a]
    if " - " in title:
        left, right = (s.strip() for s in title.split(" - ", 1))
        fold_left = left.lower()
        if left and right and (not artists or any(a.lower() in fold_left or fold_left in a.lower() for a in artists)):
            names = [n.strip() for n in re.split(r",|&|\bfeat\.?|\bft\.?|\bx\b", left, flags=re.I)]
            return right, [n for n in names if n] or artists
    return title, artists


def read_youtube(link: dict) -> dict:
    """YouTube Music's own API (``ytmusicapi``), without an account: every song
    of the playlist, each already in the shape a YouTube search hit has — so a
    line nothing else matches can still be played from YouTube itself."""
    from .deezer import youtube as yt

    if not yt.installed():
        raise LinkError("La lecture des playlists YouTube n'est pas installée sur ce serveur")
    try:
        yt._check_held()
        raw = yt._client().get_playlist(link["id"], limit=MAX_TRACKS + 1) or {}
    except yt.YoutubeHeld as exc:
        raise LinkError("YouTube refuse les demandes pour l'instant, réessaie plus tard") from exc
    except Exception as exc:
        yt._hold_for(exc)
        text = str(exc).lower()
        if "404" in text or "not found" in text or "does not exist" in text or "private" in text:
            raise LinkError("Playlist introuvable sur YouTube (supprimée ou privée ?)") from exc
        raise LinkError(f"YouTube n'a pas répondu ({type(exc).__name__})") from exc
    return parse_youtube(raw)


def parse_youtube(raw: dict) -> dict:
    from .deezer import youtube as yt

    tracks = []
    for t in raw.get("tracks") or []:
        hit = yt.normalize_hit(t)
        if hit is None or t.get("isAvailable") is False:
            continue
        title, artists = clean_video_title(hit["title"], [a["name"] for a in hit["artists"]])
        tracks.append(entry(title, artists, hit.get("album"), hit.get("duration"), None, yt=hit))
    thumbs = raw.get("thumbnails") or []
    cover = yt._best_thumb(thumbs) if thumbs else None
    total = raw.get("trackCount") if isinstance(raw.get("trackCount"), int) else None
    return _result(raw.get("title"), cover, tracks, total)


# Apple Music -------------------------------------------------------------------------

_SERVER_DATA = re.compile(
    r'<script[^>]*id="serialized-server-data"[^>]*>(.*?)</script>', re.S | re.I
)
_LD_JSON = re.compile(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.S | re.I)
_OG = re.compile(r'<meta[^>]*property="og:(title|image)"[^>]*content="([^"]*)"', re.I)
_ISO_DURATION = re.compile(r"\AP(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?\Z")


def read_apple(session, link: dict) -> dict:
    """The page an Apple Music share link opens: it is rendered on the server,
    so the tracklist is in it as JSON, with no developer token."""
    url = f"https://music.apple.com/{link['country']}/{link['kind']}/{link['slug']}/{link['id']}"
    return parse_apple(_get_page(session, url, "Apple Music"))


def _iso_seconds(value) -> int:
    m = _ISO_DURATION.match(str(value or ""))
    if not m:
        return 0
    h, mi, s = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + int(float(s or 0))


def parse_apple(page: str) -> dict:
    name = cover = None
    ld_tracks, ld_total = [], None
    for blob in _LD_JSON.findall(page):
        try:
            data = json.loads(blob)
        except ValueError:
            continue
        for d in data if isinstance(data, list) else [data]:
            if not isinstance(d, dict) or d.get("@type") not in ("MusicPlaylist", "MusicAlbum"):
                continue
            name = name or d.get("name")
            image = d.get("image")
            cover = cover or (image if isinstance(image, str) else None)
            if isinstance(d.get("numTracks"), int):
                ld_total = d["numTracks"]
            by_album = d.get("byArtist")
            album_artists = [
                a.get("name") for a in (by_album if isinstance(by_album, list) else [by_album])
                if isinstance(a, dict)
            ]
            for t in d.get("track") or []:
                if not isinstance(t, dict):
                    continue
                if t.get("@type") == "ListItem" and isinstance(t.get("item"), dict):
                    t = t["item"]
                by = t.get("byArtist")
                names = [a.get("name") for a in (by if isinstance(by, list) else [by]) if isinstance(a, dict)]
                album = t.get("inAlbum") if isinstance(t.get("inAlbum"), dict) else {}
                ld_tracks.append(
                    entry(
                        t.get("name"),
                        names or album_artists,
                        album.get("name") or (d.get("name") if d.get("@type") == "MusicAlbum" else None),
                        _iso_seconds(t.get("duration")),
                        t.get("isrcCode"),
                    )
                )
    for prop, value in _OG.findall(page):
        if prop.lower() == "title" and not name:
            name = re.sub(r"\s+(?:on|sur|auf|en)\s+Apple\s+Music\Z", "", html.unescape(value), flags=re.I)
        elif prop.lower() == "image" and not cover:
            cover = html.unescape(value)

    tracks = []
    m = _SERVER_DATA.search(page)
    if m:
        try:
            data = json.loads(m.group(1))
        except ValueError:
            data = None
        seen = set()
        for d in _walk_dicts(data):
            # A track row: a title, its artist and a length. The page header
            # (the playlist itself) has no length, so it is never taken for one.
            if not (isinstance(d.get("title"), str) and isinstance(d.get("artistName"), str)):
                continue
            ms = d.get("duration") if isinstance(d.get("duration"), (int, float)) else None
            if ms is None:
                continue
            key = str(_dig(d, "contentDescriptor", "identifiers", "storeAdamID") or d.get("id") or "") or (
                d["title"], d["artistName"], ms
            )
            if key in seen:
                continue
            seen.add(key)
            tracks.append(
                entry(d["title"], _split_artists(d["artistName"]), d.get("albumName"), round(ms / 1000), d.get("isrc"))
            )
    if not tracks:
        tracks = ld_tracks
    if not tracks:
        raise LinkError("Page Apple Music illisible (format inattendu, ou playlist privée)")
    if cover:
        cover = re.sub(r"/\d+x\d+[a-z]*(\.\w+)\Z", r"/600x600bb\1", cover)
    return _result(name, cover, tracks, ld_total)


def _split_artists(text: str) -> list:
    """"A, B & C" → [A, B, C] (Apple joins every credit into one string)."""
    return [p.strip() for p in re.split(r",|&| x ", text or "") if p.strip()]


# helpers -----------------------------------------------------------------------------


def _dig(data, *path):
    for key in path:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data


def _walk_dicts(data, depth=0):
    """Every dict in a JSON document, depth first (bounded: it is a page's)."""
    if depth > 40:
        return
    if isinstance(data, dict):
        yield data
        for v in data.values():
            yield from _walk_dicts(v, depth + 1)
    elif isinstance(data, list):
        for v in data:
            yield from _walk_dicts(v, depth + 1)


def _find_dict(data, pred):
    for d in _walk_dicts(data):
        if pred(d):
            return d
    return None

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
import logging
import threading
import weakref
from pathlib import Path

import requests

try:  # pycryptodome
    from Crypto.Cipher import Blowfish
except ImportError:  # pycryptodomex
    from Cryptodome.Cipher import Blowfish

from deezerpy import Deezer
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
        # (checksum, tracks) cache for the favorites list — see
        # get_my_favorite_tracks. The expensive part is fetching full metadata
        # for every favorite; Deezer hands back a cheap checksum of the set, so
        # we only refetch when it actually changed.
        self._fav_cache: tuple[str | None, list] | None = None

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

    @property
    def dz(self) -> Deezer:
        if self._dz is None:
            with self._login_lock:
                if self._dz is None:
                    dz = Deezer()
                    if not dz.login_via_arl(self.arl):
                        raise DeezerError("ARL login failed (empty/expired cookie?)")
                    self._dz = dz
                    logger.info(
                        "Deezer login OK as %s (lossless=%s)",
                        dz.current_user.get("name"),
                        dz.current_user.get("can_stream_lossless"),
                    )
        return self._dz

    def relogin(self) -> Deezer:
        with self._login_lock:
            self._dz = None
        return self.dz

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
        return self.dz.gw.get_show_page(show_id, nb=nb, start=start)

    def get_show_episodes(self, show_id) -> list[dict]:
        return self.dz.gw.get_show_episodes(show_id)

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

    def download_episode_to(self, url: str, dest: Path) -> None:
        """Stream a podcast episode's MP3 into ``dest`` (atomic .part temp file).

        Plain HTTP: follows redirects (rss.com -> CDN), no decryption. A Referer
        matching the web player is sent since some hosts gate on it.
        """
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        headers = dict(self.dz.http_headers)
        headers["Referer"] = "https://www.deezer.com/"
        with self.dz.session.get(
            url, headers=headers, stream=True, timeout=(10, 120), allow_redirects=True
        ) as resp:
            resp.raise_for_status()
            with open(tmp, "wb") as fh:
                for chunk in resp.iter_content(65536):
                    if chunk:
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

    def resolve(self, sng_id, quality: str | None = None):
        """Return ``(url, fmt, gw_info, used_id)`` for a playable source.

        Falls back to the gateway-provided alternative (``FALLBACK.SNG_ID``)
        when the requested track has no playable source.
        """
        quality = quality or self.default_quality
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

        raise DeezerError(f"no playable source for track {sng_id}")

    def _url_from_info(self, info: dict, quality: str):
        token = info.get("TRACK_TOKEN")
        if not token:
            return None, None
        for fmt in QUALITY_FALLBACKS.get(quality, ["MP3_128"]):
            try:
                url = self.dz.get_track_url(token, fmt)
            except Exception:  # WrongLicense / WrongGeolocation / network
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
                timeout=30,
            )
            resp.raise_for_status()
            return resp.content
        except requests.RequestException:
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
                timeout=30,
            )
            resp.raise_for_status()
            if "image" in resp.headers.get("content-type", ""):
                return resp.content
            return None
        except requests.RequestException:
            return None

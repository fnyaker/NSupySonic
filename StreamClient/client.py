"""StreamClient - Client Deezer simple, API synchrone."""

import asyncio
from dataclasses import dataclass
from typing import Literal

from streamrip.client import DeezerClient
from streamrip.config import Config
from streamrip.db import Database, Dummy
from streamrip.media import PendingAlbum, PendingArtist, PendingPlaylist, PendingSingle

MediaType = Literal["track", "album", "artist", "playlist"]


@dataclass
class StreamClient:
    """Client Deezer simplifié - API synchrone."""

    arl: str
    download_folder: str = "./downloads"
    quality: int = 2  # 0=MP3_128, 1=MP3_320, 2=FLAC

    def __post_init__(self):
        self.config = Config.defaults()
        self.config.session.deezer.arl = self.arl
        self.config.session.deezer.quality = self.quality
        self.config.session.downloads.folder = self.download_folder
        self._client = DeezerClient(self.config)
        self._db = Database(downloads=Dummy(), failed=Dummy())
        self._logged_in = False
        # Créer une seule boucle événementielle pour toute la durée de vie du client
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

    def _run_async(self, coro):
        """Exécute une coroutine avec la boucle du client."""
        return self._loop.run_until_complete(coro)

    def __del__(self):
        """Ferme proprement la boucle événementielle."""
        if hasattr(self, '_loop') and self._loop and not self._loop.is_closed():
            self._loop.close()

    @property
    def logged_in(self) -> bool:
        return self._logged_in

    @property
    def api(self):
        """Accès direct à l'API deezerpy (méthodes synchrones: search_*, get_user_*, etc.)."""
        return self._client.client.api

    def login(self) -> bool:
        """Connexion via ARL."""
        self._run_async(self._client.login())
        self._logged_in = self._client.logged_in
        return self._logged_in

    # ── RECHERCHE (délègue à deezerpy.api - déjà synchrone) ────

    def search(self, query: str, type: MediaType = "track", limit: int = 25) -> list[dict]:
        """Recherche track/album/artist/playlist."""
        method = getattr(self.api, f"search_{type}" if type != "track" else "search_track")
        result = method(query, limit=limit)
        return result.get("data", [])

    # ── TÉLÉCHARGEMENT ──────────────────────────────────────────

    def download(self, item_id: str, type: MediaType) -> None:
        """Télécharge track/album/artist/playlist par ID."""
        async def _download():
            pending_cls = {"track": PendingSingle, "album": PendingAlbum, "artist": PendingArtist, "playlist": PendingPlaylist}[type]
            media = await pending_cls(item_id, self._client, self.config, self._db).resolve()
            if media:
                await media.rip()
        self._run_async(_download())

    # ── DONNÉES UTILISATEUR (délègue à deezerpy.api - déjà synchrone) ──

    def get_user_data(self, user_id: str, data_type: str, limit: int = -1) -> list[dict]:
        """data_type: tracks, albums, artists, playlists, flow, following, followers."""
        method = getattr(self.api, f"get_user_{data_type}")
        result = method(user_id, limit=limit)
        return result.get("data", [])

    # ── MÉTADONNÉES ─────────────────────────────────────────────

    def get_metadata(self, item_id: str, type: MediaType) -> dict:
        """Récupère métadonnées track/album/artist/playlist."""
        return self._run_async(self._client.get_metadata(item_id, type))


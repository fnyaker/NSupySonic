# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Import Deezer library + recommendations into supysonic rows (Deezer -> Subsonic).

Everything is materialized as regular DB rows so the existing Subsonic
endpoints expose it unchanged:
  * Deezer playlists  -> supysonic Playlist + PlaylistTrack
  * Deezer favorites  -> StarredTrack for the configured user
  * New releases/Flow -> synthetic "Deezer · ..." playlists

Writes go straight to the DB (not through the REST endpoints), so importing
never echoes back to Deezer through the Phase 3 push hooks.
"""

from __future__ import annotations

import logging
import os.path
import re
from uuid import uuid4

from ..db import (
    Playlist,
    PlaylistTrack,
    PodcastChannel,
    StarredTrack,
    Track,
    User,
    db,
    now,
)
from . import ids, library

logger = logging.getLogger(__name__)

# How many track ids to resolve per gateway call when fetching favorites.
_FAV_CHUNK = 200

# Stable local id for the synthetic Flow playlist.
RECO_FLOW = "reco:flow"

# Personalized "smart tracklists" exposed as "Deezer · <title>" playlists.
# Each is one gateway call returning ready-to-use tracks (SONGS.data).
DEFAULT_SMART_TRACKLISTS = [
    "new-releases",
    "discovery",
    "monthly-top",
    "inspired-by-1",
    "inspired-by-2",
    "inspired-by-3",
    "inspired-by-4",
    "inspired-by-5",
]


def smart_ids_from_config(cfg) -> list:
    raw = cfg.get("smart_tracklists")
    if not raw:
        return list(DEFAULT_SMART_TRACKLISTS)
    if isinstance(raw, str):
        return [x for x in re.split(r"[,\s]+", raw.strip()) if x]
    return list(raw)


class DeezerImporter:
    def __init__(self, provider, sync_user_name: str, progress=None):
        self.provider = provider
        self.user = User.get(name=sync_user_name)  # raises User.DoesNotExist
        self.root = library.get_root_folder(provider.archive_dir)
        # Optional callback(str) for human-facing progress (e.g. click.echo).
        self._progress = progress or (lambda *_a: None)
        # Shared across the whole run so artists/albums/folders are looked up once.
        self.cache = library.ImportCache()

    # -- helpers ---------------------------------------------------------

    def _upsert_tracks(self, raw_tracks) -> list[Track]:
        out = []
        for t in raw_tracks:
            if not t or not t.get("SNG_ID") or str(t.get("SNG_ID")) == "0":
                continue
            out.append(
                library.upsert_track(
                    t, self.root, self.provider.default_quality, cache=self.cache
                )
            )
        return out

    def _materialize_playlist(self, local_id, name, deezer_id, raw_tracks, comment=None):
        """Create/refresh a supysonic Playlist mirroring an ordered track list.

        Done in a single transaction with a bulk PlaylistTrack insert, so a
        thousand-track playlist is one commit instead of thousands of fsyncs.
        """
        dz = str(deezer_id) if deezer_id else None
        with db.atomic():
            # Collapse split-brain duplicates: stray rows pointing at the same
            # Deezer playlist under a different (e.g. client-generated) id, from
            # before client-created playlists adopted the canonical uuid5 id.
            if dz:
                for stray in Playlist.select().where(
                    (Playlist.deezer_id == dz) & (Playlist.id != local_id)
                ):
                    stray.delete_instance(recursive=True)

            # For a real Deezer playlist (the synthetic recommendation lists have
            # no deezer_id and are meant to refresh wholesale), snapshot the
            # tracks it currently holds. Deezer sometimes stops returning a track
            # that went *unavailable* (rights pulled, geo-blocked) — in the
            # response that's indistinguishable from a real removal — and a blind
            # mirror would drop it. We keep any vanished track we've already
            # archived on disk, so a downloaded track is never lost from your
            # playlist just because Deezer hid the source.
            old_tracks = []
            if dz:
                try:
                    old_tracks = Playlist[local_id].get_tracks()
                except Playlist.DoesNotExist:
                    old_tracks = []

            tracks = self._upsert_tracks(raw_tracks)
            new_ids = {t.id for t in tracks}
            preserved = [
                ot
                for ot in old_tracks
                if ot.id not in new_ids and ot.deezer_id and os.path.isfile(ot.path)
            ]
            if preserved:
                logger.info(
                    "Playlist %s: keeping %d archived track(s) Deezer no longer returns",
                    name,
                    len(preserved),
                )

            try:
                playlist = Playlist[local_id]
                playlist.name = name
                playlist.comment = comment
                playlist.deezer_id = dz
                playlist.clear()
                playlist.save()
            except Playlist.DoesNotExist:
                playlist = Playlist.create(
                    id=local_id, user=self.user, name=name, comment=comment, deezer_id=dz
                )

            # Deezer's current order first, then the preserved-but-vanished
            # archived tracks appended (their original slot is unknown once
            # Deezer drops them).
            final = tracks + preserved
            rows = [
                {
                    "id": uuid4(),
                    "playlist": playlist.id,
                    "track": t.id,
                    "index": i,
                }
                for i, t in enumerate(final)
            ]
            if rows:
                PlaylistTrack.insert_many(rows).execute()
        return playlist, len(final)

    # -- playlists -------------------------------------------------------

    def sync_playlists(self) -> int:
        self._progress("Fetching your Deezer playlists...")
        playlists = self.provider.dz.gw.get_user_playlists(
            self.provider.user_id, limit=1000
        )
        self._progress(f"  {len(playlists)} playlist(s) found")
        count = 0
        for pl in playlists:
            did = pl["id"]
            try:
                raw = self.provider.dz.gw.get_playlist_tracks(did)
                _, n = self._materialize_playlist(
                    ids.playlist_uuid(did),
                    pl.get("title", "Playlist"),
                    did,
                    raw,
                    comment=pl.get("description") or None,
                )
                self._progress(f"  • {pl.get('title', 'Playlist')} ({n} tracks)")
                count += 1
            except Exception as exc:  # one bad playlist shouldn't abort the sync
                logger.warning("Failed to import Deezer playlist %s: %s", did, exc)
                self._progress(f"  ! playlist {did} failed: {exc}")
        return count

    # -- favorites -------------------------------------------------------

    def sync_favorites(self) -> int:
        self._progress("Fetching your Deezer favorites...")
        raw_ids = self.provider.dz.gw.get_user_favorite_ids(limit=100000)
        sng_ids = [x["SNG_ID"] for x in raw_ids.get("data", [])]
        self._progress(f"  {len(sng_ids)} favorite track(s); fetching metadata...")

        raw = []
        for i in range(0, len(sng_ids), _FAV_CHUNK):
            raw.extend(self.provider.dz.gw.get_tracks(sng_ids[i : i + _FAV_CHUNK]))
            self._progress(f"  ...{min(i + _FAV_CHUNK, len(sng_ids))}/{len(sng_ids)}")

        with db.atomic():
            tracks = self._upsert_tracks(raw)
            wanted = {t.id for t in tracks}

            existing = {
                s.starred_id
                for s in StarredTrack.select(StarredTrack.starred).where(
                    StarredTrack.user == self.user
                )
            }
            new_rows = [
                {"user": self.user.id, "starred": t.id, "date": now()}
                for t in tracks
                if t.id not in existing
            ]
            if new_rows:
                StarredTrack.insert_many(new_rows).execute()

            # Drop stars on Deezer tracks that are no longer loved.
            deezer_starred = {
                s.starred_id
                for s in StarredTrack.select(StarredTrack.starred)
                .join(Track, on=(StarredTrack.starred == Track.id))
                .where(StarredTrack.user == self.user, Track.deezer_id.is_null(False))
            }
            stale = deezer_starred - wanted
            if stale:
                StarredTrack.delete().where(
                    StarredTrack.user == self.user,
                    StarredTrack.starred.in_(list(stale)),
                ).execute()
        return len(tracks)

    # -- smart tracklists & recommendations ------------------------------

    def sync_smart_tracklists(self, stl_ids) -> dict:
        """Materialize each Deezer smart tracklist as a 'Deezer · <title>' playlist."""
        out = {}
        for stl_id in stl_ids:
            try:
                res = self.provider.get_smart_tracklist(stl_id)
                songs = ((res or {}).get("SONGS") or {}).get("data", []) or []
                if not songs:
                    self._progress(f"  • {stl_id}: empty, skipped")
                    continue
                title = ((res or {}).get("DATA") or {}).get("TITLE") or stl_id
                _, n = self._materialize_playlist(
                    ids.playlist_uuid("smart:" + stl_id),
                    f"Deezer · {title}",
                    None,
                    songs,
                )
                out[stl_id] = n
                self._progress(f"  • {title} ({n} tracks)")
            except Exception as exc:
                logger.warning("Smart tracklist %s failed: %s", stl_id, exc)
                self._progress(f"  ! {stl_id} failed: {exc}")
        return out

    def sync_flow(self) -> int:
        self._progress("Fetching your Deezer Flow...")
        data = self.provider.dz.api.get_user_flow(self.provider.user_id, limit=50)
        flow_ids = [t["id"] for t in (data or {}).get("data", []) if t.get("id")]
        raw = self.provider.dz.gw.get_tracks(flow_ids) if flow_ids else []
        if not raw:
            return 0
        _, n = self._materialize_playlist(
            ids.playlist_uuid(RECO_FLOW), "Deezer · Flow", None, raw
        )
        return n

    def _purge_playlist(self, local_id):
        try:
            pl = Playlist[local_id]
            pl.clear()
            pl.delete_instance()
        except Playlist.DoesNotExist:
            pass

    def sync_recommendations(self, smart_ids=None, flow=True) -> dict:
        result = {}
        if smart_ids:
            # Remove the pre-smart-tracklist "Nouveautés" playlist if it lingers.
            self._purge_playlist(ids.playlist_uuid("reco:newreleases"))
            self._progress("Fetching your Deezer smart playlists...")
            result["smart"] = self.sync_smart_tracklists(smart_ids)
        if flow:
            try:
                result["flow"] = self.sync_flow()
            except Exception as exc:
                logger.warning("Flow import failed (needs OAuth on some accounts): %s", exc)
        return result

    # -- podcasts --------------------------------------------------------

    def sync_podcasts(self, episode_limit=30) -> int:
        """Refresh every subscribed podcast's metadata + recent episodes.

        The local PodcastChannel rows are the source of truth for subscriptions
        (added via createPodcastChannel / CLI import); this just re-fetches each
        show's latest episodes. Audio is still fetched on demand.
        """
        from .archive import import_show

        channels = list(
            PodcastChannel.select().where(PodcastChannel.user == self.user)
        )
        if channels:
            self._progress(f"Refreshing {len(channels)} podcast(s)...")
        count = 0
        for channel in channels:
            if not channel.deezer_id:
                continue
            try:
                import_show(
                    self.provider, self.user, channel.deezer_id,
                    episode_limit=episode_limit,
                )
                self._progress(f"  • {channel.title}")
                count += 1
            except Exception as exc:  # one bad show shouldn't abort the sync
                logger.warning("Failed to refresh podcast %s: %s", channel.deezer_id, exc)
                channel.error_message = str(exc)[:255]
                channel.save()
                self._progress(f"  ! podcast {channel.deezer_id} failed: {exc}")
        return count

    # -- orchestration ---------------------------------------------------

    def sync(self, cfg: dict) -> dict:
        out = {}
        if cfg.get("sync_playlists"):
            out["playlists"] = self.sync_playlists()
        if cfg.get("sync_favorites"):
            out["favorites"] = self.sync_favorites()
        if cfg.get("sync_podcasts"):
            out["podcasts"] = self.sync_podcasts(int(cfg.get("podcast_episodes") or 30))
        if cfg.get("import_new_releases") or cfg.get("import_flow"):
            out["recommendations"] = self.sync_recommendations(
                smart_ids=smart_ids_from_config(cfg) if cfg.get("import_new_releases") else None,
                flow=cfg.get("import_flow", False),
            )
        return out

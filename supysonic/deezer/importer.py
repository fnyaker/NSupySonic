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
from datetime import timedelta
from uuid import uuid4

from peewee import fn

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

# How long a "this show is gone from Deezer" verdict stands before the sync
# re-tests it. Shows come back (a licensing gap, a feed migration), so the
# channel is kept local in the meantime rather than condemned.
GONE_RECHECK = timedelta(days=7)

# Stable local id for the synthetic Flow playlist.
RECO_FLOW = "reco:flow"
# ...and for "Nouveautés pour toi"'s albums, all in one playlist.
RECO_NEW_ALBUMS = "reco:newalbums"
NEW_ALBUMS_NAME = "Deezer · Nouveautés en vrac"
# Albums, not tracks: the module lists ~100, each fetched whole.
NEW_ALBUMS_MAX = 100

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

    def _materialize_playlist(
        self, local_id, name, deezer_id, raw_tracks, comment=None, merge=False
    ):
        """Create/refresh a supysonic Playlist mirroring an ordered track list.

        Done in a single transaction with a bulk PlaylistTrack insert, so a
        thousand-track playlist is one commit instead of thousands of fsyncs.

        ``merge`` keeps an existing local playlist as it is (name, comment and
        every track in place) and only appends the tracks it does not hold yet:
        once the account is imported, the local playlist is the one that counts.
        """
        dz = str(deezer_id) if deezer_id else None
        with db.atomic():
            if merge:
                existing = Playlist.get_or_none(Playlist.id == local_id)
                if existing is not None:
                    return self._merge_playlist(existing, raw_tracks)
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

    def _merge_playlist(self, playlist, raw_tracks):
        """Append the tracks ``playlist`` lacks, in Deezer's order; touch nothing else."""
        tracks = self._upsert_tracks(raw_tracks)
        have = {
            r.track_id
            for r in PlaylistTrack.select(PlaylistTrack.track).where(
                PlaylistTrack.playlist == playlist.id
            )
        }
        last = (
            PlaylistTrack.select(fn.MAX(PlaylistTrack.index))
            .where(PlaylistTrack.playlist == playlist.id)
            .scalar()
        )
        index = -1 if last is None else last
        rows = []
        for t in tracks:
            if t.id in have:
                continue
            have.add(t.id)
            index += 1
            rows.append(
                {"id": uuid4(), "playlist": playlist.id, "track": t.id, "index": index}
            )
        if rows:
            PlaylistTrack.insert_many(rows).execute()
        return playlist, len(have)

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
                    merge=True,
                )
                self._progress(f"  • {pl.get('title', 'Playlist')} ({n} tracks)")
                count += 1
            except Exception as exc:  # one bad playlist shouldn't abort the sync
                logger.warning("Failed to import Deezer playlist %s: %s", did, exc)
                self._progress(f"  ! playlist {did} failed: {exc}")
        return count

    # -- favorites -------------------------------------------------------

    def sync_favorites(self, prune=False) -> int:
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

            # Drop stars on Deezer tracks that are no longer loved (only when
            # asked: an import never removes anything we already hold).
            deezer_starred = set() if not prune else {
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

    def sync_new_albums(self, limit=NEW_ALBUMS_MAX) -> int:
        """Every album of "Nouveautés pour toi", whole and in Deezer's order,
        as one local playlist. The smart "Nouveautés" mix picks a few tracks;
        this is the rest of the page, the albums "en vrac".

        Each album is its FULL tracklist (``get_album_tracks``, never the page's
        first ten). An album that fails is skipped, and a run that found no
        album at all leaves the previous playlist alone — an outage is not an
        empty week.
        """
        self._progress("Fetching Deezer's new albums...")
        albums = self.provider.get_new_release_albums(limit=limit)
        if not albums:
            self._progress("  • no new album found, playlist kept")
            return 0
        raw, seen, failed = [], set(), 0
        for alb in albums:
            try:
                tracks = self.provider.dz.gw.get_album_tracks(alb["id"]) or []
            except Exception as exc:
                failed += 1
                logger.warning("New album %s failed: %s", alb["id"], exc)
                continue
            for t in tracks:
                sid = str((t or {}).get("SNG_ID") or "")
                if sid and sid != "0" and sid not in seen:
                    seen.add(sid)
                    raw.append(t)
        if not raw:
            self._progress("  • the new albums could not be read, playlist kept")
            return 0
        names = []
        for a in albums[:3]:
            if a.get("artist") and a["artist"] not in names:
                names.append(a["artist"])
        comment = f"{len(albums) - failed} nouveaux albums"
        if names:
            comment += " — avec " + ", ".join(names)
        _, n = self._materialize_playlist(
            ids.playlist_uuid(RECO_NEW_ALBUMS), NEW_ALBUMS_NAME, None, raw, comment=comment
        )
        self._progress(f"  • {NEW_ALBUMS_NAME} ({len(albums) - failed} albums, {n} tracks)")
        return n

    def _purge_playlist(self, local_id):
        try:
            pl = Playlist[local_id]
            pl.clear()
            pl.delete_instance()
        except Playlist.DoesNotExist:
            pass

    def sync_recommendations(self, smart_ids=None, flow=True, new_albums=False) -> dict:
        result = {}
        if smart_ids:
            # Remove the pre-smart-tracklist "Nouveautés" playlist if it lingers.
            self._purge_playlist(ids.playlist_uuid("reco:newreleases"))
            self._progress("Fetching your Deezer smart playlists...")
            result["smart"] = self.sync_smart_tracklists(smart_ids)
        if new_albums:
            try:
                result["new_albums"] = self.sync_new_albums()
            except Exception as exc:
                logger.warning("New albums import failed: %s", exc)
                self._progress(f"  ! new albums failed: {exc}")
        if flow:
            try:
                result["flow"] = self.sync_flow()
            except Exception as exc:
                logger.warning("Flow import failed (needs OAuth on some accounts): %s", exc)
        return result

    # -- podcasts --------------------------------------------------------

    def sync_podcasts(self, episode_limit=30) -> int:
        """Import/refresh subscribed podcasts + their recent episodes.

        Subscriptions are the local PodcastChannel rows only (added via
        createPodcastChannel / CLI / web UI); the Deezer account is not read.
        Audio is still fetched on demand.
        """
        from .archive import import_show
        from .provider import ShowUnavailable

        show_ids = []
        seen = set()

        def _add(sid):
            sid = str(sid or "")
            if sid and sid not in seen:
                seen.add(sid)
                show_ids.append(sid)

        for channel in PodcastChannel.select().where(
            (PodcastChannel.user == self.user) & (PodcastChannel.subscribed == True)  # noqa: E712
        ):
            # A show Deezer has dropped is left alone until the verdict ages out
            # — no point asking every night for something we keep locally anyway.
            if channel.gone is not None and (now() - channel.gone) < GONE_RECHECK:
                continue
            _add(channel.deezer_id)

        if show_ids:
            self._progress(f"Refreshing {len(show_ids)} podcast(s)...")
        count = 0
        for sid in show_ids:
            try:
                channel = import_show(
                    self.provider, self.user, sid, episode_limit=episode_limit
                )
                # It answered: whatever we thought before, this show is alive.
                if channel.gone is not None:
                    channel.gone = None
                    channel.save()
                self._progress(f"  • {channel.title}")
                count += 1
            except ShowUnavailable as exc:
                # Deezer no longer has the show AT ALL. Everything archived stays
                # exactly where it is and keeps working — the channel simply
                # becomes local, and we stop asking Deezer about it.
                channel = PodcastChannel.get_or_none(
                    (PodcastChannel.deezer_id == str(sid))
                    & (PodcastChannel.user == self.user)
                )
                if channel is not None and channel.gone is None:
                    channel.gone = now()
                    channel.save()
                    logger.info("Podcast %s is gone from Deezer; kept locally", sid)
                self._progress(f"  • podcast {sid} is gone from Deezer (kept locally)")
            except Exception as exc:  # one bad show shouldn't abort the sync
                logger.warning("Failed to refresh podcast %s: %s", sid, exc)
                self._progress(f"  ! podcast {sid} failed: {exc}")
        return count

    # -- orchestration ---------------------------------------------------

    def import_account(self) -> dict:
        """One-off import of the Deezer account: playlists and favourites are
        added to what we hold, never removed from it."""
        out = {"playlists": 0, "favorites": 0, "failed": []}
        for key, fn_ in (
            ("playlists", self.sync_playlists),
            ("favorites", lambda: self.sync_favorites(prune=False)),
        ):
            try:
                out[key] = fn_()
            except Exception as exc:
                logger.warning("Deezer account import (%s) failed: %s", key, exc)
                out["failed"].append(f"{key}: {exc}")
        return out

    def sync(self, cfg: dict) -> dict:
        """The scheduled refresh: subscribed podcasts only."""
        out = {}
        if cfg.get("sync_podcasts"):
            out["podcasts"] = self.sync_podcasts(int(cfg.get("podcast_episodes") or 30))
        return out

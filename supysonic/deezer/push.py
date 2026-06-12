# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Mirror Subsonic-side changes back to Deezer (Subsonic -> Deezer).

These helpers are called from the playlist and annotation endpoints. They are
deliberately fail-soft: a Deezer/network error must never break (or roll back)
the local operation, so everything is wrapped and only logged.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_FAVORITE_METHODS = {
    "Track": ("add_song_to_favorites", "remove_song_from_favorites"),
    "Album": ("add_album_to_favorites", "remove_album_from_favorites"),
    "Artist": ("add_artist_to_favorites", "remove_artist_from_favorites"),
}


def push_favorite(provider, kind: str, deezer_id, add: bool) -> None:
    """Add/remove a Deezer favorite for a Track/Album/Artist."""
    methods = _FAVORITE_METHODS.get(kind)
    if not methods or not deezer_id:
        return
    method = methods[0] if add else methods[1]
    try:
        getattr(provider.dz.gw, method)(deezer_id)
    except Exception as exc:
        logger.warning("Deezer %s(%s) failed: %s", method, deezer_id, exc)


def reconcile_playlist(provider, playlist) -> None:
    """Make the mirrored Deezer playlist's membership match `playlist`.

    Creates the Deezer playlist on first push (storing its id back), otherwise
    diffs membership and adds/removes the changed Deezer tracks. Only tracks
    that have a ``deezer_id`` are pushed; purely-local tracks are ignored.
    """
    try:
        local_ids = [t.deezer_id for t in playlist.get_tracks() if t.deezer_id]

        if not playlist.deezer_id:
            # Don't turn the synthetic "Deezer · ..." recommendation playlists
            # into real Deezer playlists.
            if (playlist.name or "").startswith("Deezer · "):
                return
            new_id = provider.dz.gw.create_playlist(
                playlist.name or "Supysonic", songs=local_ids
            )
            # playlist.create returns the new playlist id (int or str)
            playlist.deezer_id = str(new_id)
            playlist.save()
            return

        current = [
            str(t["SNG_ID"])
            for t in provider.dz.gw.get_playlist_tracks(playlist.deezer_id)
        ]
        local_set, current_set = set(local_ids), set(current)
        to_add = [i for i in local_ids if i not in current_set]
        to_remove = [i for i in current if i not in local_set]
        if to_add:
            provider.dz.gw.add_songs_to_playlist(playlist.deezer_id, to_add)
        if to_remove:
            provider.dz.gw.remove_songs_from_playlist(playlist.deezer_id, to_remove)
    except Exception as exc:
        logger.warning("Deezer playlist reconcile failed for %s: %s", playlist.id, exc)


def delete_playlist(provider, deezer_id) -> None:
    if not deezer_id:
        return
    try:
        provider.dz.gw.delete_playlist(deezer_id)
    except Exception as exc:
        logger.warning("Deezer delete_playlist(%s) failed: %s", deezer_id, exc)

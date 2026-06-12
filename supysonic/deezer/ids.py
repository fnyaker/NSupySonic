# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Deterministic mapping from Deezer ids to supysonic UUIDs.

Deezer entities are stored as regular supysonic rows. To keep imports
idempotent (re-syncing must not create duplicates) and the ids stable for
clients, every supysonic UUID is derived deterministically from the Deezer id
with ``uuid5``. This keeps ids valid UUIDs, so the existing ``get_entity`` /
``get_entity_id`` code keeps working unchanged.
"""

import uuid

# Fixed root namespace for everything Deezer in supysonic.
NS_DEEZER = uuid.uuid5(uuid.NAMESPACE_URL, "deezer.com/supysonic")
NS_TRACK = uuid.uuid5(NS_DEEZER, "track")
NS_ALBUM = uuid.uuid5(NS_DEEZER, "album")
NS_ARTIST = uuid.uuid5(NS_DEEZER, "artist")
NS_PLAYLIST = uuid.uuid5(NS_DEEZER, "playlist")


def track_uuid(deezer_id) -> uuid.UUID:
    return uuid.uuid5(NS_TRACK, str(deezer_id))


def album_uuid(deezer_id) -> uuid.UUID:
    return uuid.uuid5(NS_ALBUM, str(deezer_id))


def artist_uuid(deezer_id) -> uuid.UUID:
    return uuid.uuid5(NS_ARTIST, str(deezer_id))


def playlist_uuid(deezer_id) -> uuid.UUID:
    return uuid.uuid5(NS_PLAYLIST, str(deezer_id))


# Local (non-Deezer) files dropped in the archive: deterministic ids too, so a
# rescan never duplicates. Tracks are keyed by path; albums/artists by name.
NS_LOCAL = uuid.uuid5(NS_DEEZER, "local")
NS_LOCAL_TRACK = uuid.uuid5(NS_LOCAL, "track")
NS_LOCAL_ALBUM = uuid.uuid5(NS_LOCAL, "album")
NS_LOCAL_ARTIST = uuid.uuid5(NS_LOCAL, "artist")


def local_track_uuid(path) -> uuid.UUID:
    return uuid.uuid5(NS_LOCAL_TRACK, str(path))


def local_album_uuid(artist_name, album_name) -> uuid.UUID:
    key = (artist_name or "").strip().lower() + "\x00" + (album_name or "").strip().lower()
    return uuid.uuid5(NS_LOCAL_ALBUM, key)


def local_artist_uuid(name) -> uuid.UUID:
    return uuid.uuid5(NS_LOCAL_ARTIST, (name or "").strip().lower())

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Cover Art Archive: a front cover for an upload that has none."""

from . import musicbrainz as mb

BASE = "https://coverartarchive.org"


def front(http, release_mbid):
    """JPEG bytes of the release's front cover (500 px), or None."""
    release = mb.valid_mbid(release_mbid)
    if not release:
        return None
    return http.get_image(f"{BASE}/release/{release}/front-500")


def wanted(track):
    """An upload (no Deezer, no YouTube id) with no cover of its own."""
    if track.deezer_id or track.youtube_id or track.has_art:
        return False
    return not (track.folder is not None and track.folder.cover_art)

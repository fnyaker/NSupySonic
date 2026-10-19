# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The files this server already holds, as a provider.

A pseudo-provider so a source list can say "local" for an upload: AUDIO only,
never searched and never asked online, and no ``track_source`` row is ever
written for it (the row's file IS the source). Its ``ref`` is the Track's UUID;
the file is read from the database's own path, never from the client's.
"""

import os
import shutil
from uuid import UUID

from ..db import Track
from . import base, quality
from .errors import NotFound, ProviderError

ID = "local"
CHUNK = 64 * 1024


class LocalProvider(base.Provider):
    id = ID
    name = "Local"
    role = base.MAIN
    capabilities = frozenset({base.AUDIO})

    # -- the file ---------------------------------------------------------------

    def _path(self, ref):
        try:
            uid = UUID(str(ref))
        except ValueError:
            raise ProviderError(f"not a track id: {str(ref)[:40]!r}", provider=ID) from None
        track = Track.get_or_none(Track.id == uid)
        if track is None or not track.path or not os.path.isfile(track.path):
            raise NotFound(str(ref), provider=ID)
        return track.path

    # -- AUDIO ------------------------------------------------------------------

    def offers(self, ref):
        note = quality.from_file(self._path(ref))
        if note is None:
            return []
        return [
            {
                "quality": note.cls,
                "fmt": note.fmt,
                "bitrate": note.bitrate,
                "lossless": note.lossless,
                "bit_depth": note.bit_depth,
                "sample_rate": note.sample_rate,
            }
        ]

    def fetch(self, ref, offer, dest):
        shutil.copyfile(self._path(ref), dest)

    def open_stream(self, ref, offer):
        with open(self._path(ref), "rb") as fh:
            while True:
                chunk = fh.read(CHUNK)
                if not chunk:
                    break
                yield chunk

    def fetch_cover(self, ref, size=1000):
        folder = os.path.dirname(self._path(ref))
        for name in ("cover.jpg", "cover.png", "folder.jpg"):
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                with open(path, "rb") as fh:
                    return fh.read()
        raise NotFound(str(ref), provider=ID)

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The providers that ship with the server: Deezer, YouTube and the local files
for sound; MusicBrainz, AcoustID and LRCLIB for facts."""

from .deezer import DeezerAdapter
from .info import AcoustidProvider, LrclibProvider, MusicBrainzProvider
from .local import LocalProvider
from .youtube import YoutubeAdapter


def register_builtin(registry, get_deezer):
    """Register the built-ins on ``registry``. ``get_deezer()`` returns the live
    ``DeezerProvider`` (``app.deezer``, which an admin saving a new ARL swaps)
    or None; it is called at every use, so nothing is registered twice."""
    registry.register(DeezerAdapter(get_deezer))
    registry.register(YoutubeAdapter())
    registry.register(LocalProvider())
    registry.register(MusicBrainzProvider())
    registry.register(AcoustidProvider())
    registry.register(LrclibProvider())
    return registry

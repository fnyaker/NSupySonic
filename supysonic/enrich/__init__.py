# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Completing a track's facts from outside Deezer, in the background.

Deezer states some things with certainty (the oldest release date, the ISRC,
the label) and those stay Deezer's. What it does not state, or never did for a
file that came from elsewhere, MusicBrainz often knows: the first release date,
who composed, wrote and produced. Nothing here is ever on the path of a click:
a track is *queued* when it becomes ours (archived, uploaded) and one worker,
niced behind everything else, asks the third parties at their own pace.

``http.py`` is the polite client, ``musicbrainz.py`` / ``search.py`` /
``acoustid.py`` / ``cover.py`` the sources, ``queue.py`` the worker and the
per-track decision, ``backfill.py`` the library-wide catch-up.
"""

DEFAULTS = {
    "enabled": True,
    # AcoustID needs an application key (https://acoustid.org/new-application)
    # and the ``fpcalc`` binary; without both only ISRC and search are tried.
    "acoustid_key": None,
    # Added to the User-Agent so MusicBrainz can reach the operator.
    "contact": "https://github.com/fnyaker/nsupysonic",
}


def settings(config=None):
    """The ``[enrich]`` options over their defaults (``config`` is a mapping)."""
    out = dict(DEFAULTS)
    if config:
        out.update({k: v for k, v in dict(config).items() if v is not None})
    return out

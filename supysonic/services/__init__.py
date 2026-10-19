# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Other streaming services, seen from this server: where a playlist can go.

Each service module answers the same three questions — find the service's copy
of one of OUR tracks (``find``), make a playlist there (``create_playlist``),
and say which account it is (``account``) — so the export job in
``supysonic/webui/services.py`` is written once. What a service needs to be
reached (an OAuth app, a browser session, the server's own Deezer account) and
what it cannot do is in its own module; ``docs/playlist-export.md`` is the
survey of all of them, Apple Music included (no export without a paid Apple
developer membership — the list file is the route there).

Matching goes from the most exact key to the least: the service's own id when
the track came from it, the ISRC (one recording, the same on every service),
then a text search judged by ``match.pick`` — the very rules the replacement
sheet uses to offer a one-click stand-in, so "found" means the same recording,
never the artist's other song or somebody's cover.
"""

from __future__ import annotations


class ServiceError(Exception):
    """The service could not be asked, or refused (said in words a person reads)."""


class ServiceAuthError(ServiceError):
    """The credential is gone (revoked, expired for good): link the account again."""


SERVICES = ("spotify", "youtube", "deezer")

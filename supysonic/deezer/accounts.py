# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Which Deezer serves a person (multi-provider §15, lot P3).

``access.Snapshot.serving`` says which accounts MAY serve somebody for a
feature, best first; this turns the first one that can into the object the
routes already speak to:

- the server's account is ``app.deezer``, as it always was;
- a person's own account (or one lent to them) is a ``DeezerProvider`` signed
  in with that account's ARL, kept per account (``libraryimport``'s clients);
- the anonymous use is the PUBLIC API alone (``public_api``): no login, so only
  what api.deezer.com answers to anybody — search, artist, album and playlist
  pages. A route that needs the private gateway has no anonymous answer.

One rule is not the grants' to decide: an account that cannot stream lossless
(a Deezer Free one) never fetches the sound. The archive is everybody's and
forever, and it is FLAC; Deezer would hand such an account MP3 for every track,
so the next account in line fetches it instead.
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

STREAM = "stream"

_public = None
_public_lock = threading.Lock()


def public_api():
    """The api.deezer.com client nobody is signed in to, shared by the
    process. It rides the same session class as every Deezer call (timeout,
    per-host breaker) and the API's own quota retry."""
    global _public
    if _public is None:
        with _public_lock:
            if _public is None:
                from deezerpy import Deezer

                _public = Deezer().api
    return _public


def _row(account_id):
    from ..db import ProviderAccount

    try:
        return ProviderAccount.get_or_none(ProviderAccount.id == account_id)
    except Exception:
        return None


def lossless(app, row, client) -> bool:
    """May this account fetch FLAC? Remembered on the account (read when it
    was linked); an account linked before that is asked once, which signs it
    in. Unknown (Deezer not answering) is no."""
    from .. import libraryimport as li

    opts = li.options(row)
    if opts.get("lossless") is not None:
        return opts["lossless"]
    try:
        value = bool(client.dz.current_user.get("can_stream_lossless"))
    except Exception:
        logger.debug("deezer: could not read the account's offer", exc_info=True)
        return False
    opts["lossless"] = value
    li._save_options(row, opts)
    return value


def client_for(app, account_id, feature):
    """The provider object serving through ``account_id`` for ``feature``, or
    None when that account cannot (no ARL any more, not lossless for the
    sound): the caller then tries the next one."""
    from ..access import SERVER
    from .. import libraryimport as li

    row = _row(account_id)
    if row is None:
        return None
    if row.mode == SERVER:
        return getattr(app, "deezer", None)
    try:
        client = li._deezer_client(app, row)
    except Exception:
        logger.debug("deezer: account %s unusable", account_id, exc_info=True)
        return None
    login = getattr(client, "_login_error", None)
    if login and login[0] == "arl":
        # Deezer refused this ARL at its last sign-in: the next account serves
        # until the person links it again (the import marks it refused too).
        return None
    if feature == STREAM and not lossless(app, row, client):
        return None
    return client


def serving(app, user, feature):
    """``(provider, anonymous)`` for ``user`` and ``feature``: the first
    account in ``access``'s order that can serve, else None — with
    ``anonymous`` true when the public API may still answer for them."""
    from .. import access

    if getattr(app, "deezer", None) is None:
        # Deezer switched off on this server: no account and no public API.
        return None, False
    if user is None:
        return app.deezer, False
    uid = str(getattr(user, "id", user))
    for acc in access.snapshot().serving(uid, "deezer", feature):
        if acc == access.ANONYMOUS:
            return None, True
        if acc == access.SERVER:  # the fallback snapshot: no row to read
            provider = getattr(app, "deezer", None)
        else:
            provider = client_for(app, acc, feature)
        if provider is not None:
            return provider, False
    return None, False

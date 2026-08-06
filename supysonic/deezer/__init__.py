# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Deezer proxy layer: virtual library + archive-on-play streaming."""

import logging
import re

from .provider import DeezerProvider, DeezerError

__all__ = [
    "DeezerProvider",
    "DeezerError",
    "get_provider",
    "stored_arl",
    "store_arl",
    "valid_arl",
    "ARL_META_KEY",
]

logger = logging.getLogger(__name__)

# The admin-set ARL lives in the Meta key/value table and OVERRIDES the one from
# the config file / docker-compose environment: a credential that expires every
# few months has to be replaceable without editing a file and restarting the
# container. Meta.value is a CharField(256), which comfortably fits an ARL
# (192 hex characters).
ARL_META_KEY = "deezer_arl"

# An ARL is an opaque session cookie value: a long run of hex. Validated before
# it is ever stored or sent, because it goes out as a Cookie header — a stray
# newline or semicolon there is header injection, and the surrounding code has
# no business trusting an admin-pasted string blindly.
_ARL_RE = re.compile(r"\A[0-9A-Za-z._-]{32,255}\Z")


def valid_arl(value) -> bool:
    """Whether `value` is shaped like a Deezer ARL (safe to store and send)."""
    return bool(value and _ARL_RE.fullmatch(str(value).strip()))


def stored_arl() -> "str | None":
    """The admin-set ARL from the database, or None when there isn't one."""
    from ..db import Meta

    try:
        row = Meta.get_or_none(Meta.key == ARL_META_KEY)
    except Exception:  # DB not ready (very early boot) — fall back to config
        logger.debug("Could not read the stored ARL", exc_info=True)
        return None
    value = (row.value or "").strip() if row is not None else ""
    if value and not valid_arl(value):
        logger.warning("Ignoring a malformed stored ARL")
        return None
    return value or None


def store_arl(value) -> None:
    """Persist (or clear, with a falsy value) the admin-set ARL."""
    from ..db import Meta

    value = (value or "").strip()
    if value and not valid_arl(value):
        raise ValueError("malformed ARL")
    row = Meta.get_or_none(Meta.key == ARL_META_KEY)
    if not value:
        if row is not None:
            row.delete_instance()
        return
    if row is None:
        Meta.create(key=ARL_META_KEY, value=value)
    else:
        row.value = value
        row.save()


def _section(config) -> dict:
    if isinstance(config, dict):
        return config.get("DEEZER", config)
    if hasattr(config, "DEEZER"):
        return config.DEEZER
    return config["DEEZER"]


def get_provider(config) -> "DeezerProvider | None":
    """Build a provider from a supysonic config object, Flask config, or dict.

    Accepts either the whole config (``.DEEZER`` / ``["DEEZER"]``) or the
    ``DEEZER`` section dict directly. A stored (admin-set) ARL wins over the
    configured one, and is itself enough to turn the proxy on — saving an ARL in
    the admin UI is as explicit an "enable this" as setting it in the config.
    """
    cfg = _section(config)
    override = stored_arl()
    if override:
        cfg = dict(cfg or {})
        cfg["arl"] = override
        cfg["enabled"] = True
        logger.info("Using the admin-set Deezer ARL from the database")
    return DeezerProvider.from_config(cfg)

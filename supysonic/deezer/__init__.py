# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Deezer proxy layer: virtual library + archive-on-play streaming."""

from .provider import DeezerProvider, DeezerError

__all__ = ["DeezerProvider", "DeezerError", "get_provider"]


def get_provider(config) -> "DeezerProvider | None":
    """Build a provider from a supysonic config object, Flask config, or dict.

    Accepts either the whole config (``.DEEZER`` / ``["DEEZER"]``) or the
    ``DEEZER`` section dict directly.
    """
    if isinstance(config, dict):
        cfg = config.get("DEEZER", config)
    elif hasattr(config, "DEEZER"):
        cfg = config.DEEZER
    else:
        cfg = config["DEEZER"]
    return DeezerProvider.from_config(cfg)

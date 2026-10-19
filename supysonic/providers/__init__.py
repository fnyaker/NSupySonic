# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Providers: the sources of sound and of catalogue facts (plan multi-provider)."""

from . import base, errors, registry
from .base import Provider
from .errors import (
    CapabilityMissing,
    Gone,
    NotFound,
    ProviderAuth,
    ProviderError,
    ProviderHeld,
    ProviderUnavailable,
)
from .registry import Registry

__all__ = [
    "base",
    "errors",
    "registry",
    "Provider",
    "Registry",
    "CapabilityMissing",
    "Gone",
    "NotFound",
    "ProviderAuth",
    "ProviderError",
    "ProviderHeld",
    "ProviderUnavailable",
]

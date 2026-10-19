# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What a provider can answer, and what each answer is allowed to mean.

The rule is CLAUDE.md's "a failure to reach a provider is never a verdict about
the data": only ``NotFound`` / ``Gone`` say that something no longer exists, and
they may only be raised when the provider ANSWERED. Transport trouble, a dead
credential and a refusal are never a reason to condemn a track or a source.
"""


class ProviderError(Exception):
    """Base of everything a provider raises on purpose."""

    def __init__(self, message="", *, provider=None, retry_in=None):
        super().__init__(message)
        self.provider = provider
        self.retry_in = retry_in


class ProviderUnavailable(ProviderError):
    """Transport: timeout, DNS, an open circuit breaker, a 5xx. No verdict."""


class ProviderAuth(ProviderError):
    """The credential is dead. The person's to fix; says nothing about a track."""


class ProviderHeld(ProviderError):
    """The provider refused US (rate limit, "confirm you are not a bot"). It is
    left alone until ``retry_in`` has passed; still no verdict."""


class NotFound(ProviderError):
    """The provider answered that the thing is not there."""

    def __init__(self, ref="", *, provider=None):
        super().__init__(f"not found: {ref}", provider=provider)
        self.ref = ref


class Gone(NotFound):
    """The provider answered that the thing used to exist and was removed. The
    only answer that may mark a SOURCE unavailable (never the title itself)."""


class CapabilityMissing(ProviderError):
    """Asked a provider for something it does not declare."""

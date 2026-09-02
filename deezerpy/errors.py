import requests


class DeezerError(Exception):
    """Base class for Deezer exceptions"""


class DeezerUnavailable(DeezerError, requests.exceptions.ConnectionError):
    """Deezer's host is not answering — a transport failure, never a verdict.

    Raised both for a real connection failure and, instantly, while a host's
    circuit breaker is open (see ``deezerpy._circuit``). It deliberately
    subclasses ``requests.ConnectionError`` so that every existing
    ``except requests.RequestException`` / ``except (ConnectionError, Timeout)``
    handler in the app keeps catching it unchanged.

    It says NOTHING about the data being asked for: a track, an album or a show
    must never be declared gone because this was raised.
    """

class WrongLicense(DeezerError):
    def __init__(self, track_format):
        super().__init__()
        self.message = f"Your account doesn't have the license to stream {track_format}"
        self.format = track_format

class WrongGeolocation(DeezerError):
    def __init__(self, country):
        super().__init__()
        self.message = f"The track you requested can't be streamed in country {country}"
        self.country = country

class APIError(DeezerError):
    """Base class for Deezer api exceptions"""

class ItemsLimitExceededException(APIError):
    pass

class PermissionException(APIError):
    pass

class InvalidTokenException(APIError):
    pass

class WrongParameterException(APIError):
    pass

class MissingParameterException(APIError):
    pass

class InvalidQueryException(APIError):
    pass

class DataException(APIError):
    pass

class IndividualAccountChangedNotAllowedException(APIError):
    pass

class GWAPIError(DeezerError):
    """Base class for Deezer gw api exceptions"""


def is_transport_failure(exc) -> bool:
    """Did ``exc`` (or anything it was raised from) mean "Deezer did not answer"?

    Failures get wrapped on their way up — a connect timeout becomes a
    ``DeezerError("cannot reach Deezer: ...")`` a couple of frames later — so a
    plain isinstance check on the outermost exception misses most of them. This
    walks the cause/context chain instead.

    It is the test for "try again later" as opposed to "Deezer answered": no
    verdict about a track, an album or a show may ever be recorded when this is
    true.
    """
    seen = set()
    while exc is not None and id(exc) not in seen:
        if isinstance(
            exc,
            (
                DeezerUnavailable,
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout,
            ),
        ):
            return True
        seen.add(id(exc))
        exc = exc.__cause__ or exc.__context__
    return False

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Keep request-supplied text from forging log lines.

Log calls interpolate names, titles, ids and paths that a client chose; one
carrying a newline would start a line of its own in the log, looking exactly
like one the server wrote. Rather than wrap every such call, the arguments of
every record this package logs have their line breaks escaped once, where the
record is made. The format strings are the code's own and are left alone, as
are tracebacks."""

import logging

_PACKAGE = __package__ or "supysonic"
_TABLE = str.maketrans(
    {
        "\r": "\\r",
        "\n": "\\n",
        "\x85": "\\x85",
        " ": "\\u2028",
        " ": "\\u2029",
    }
)


def _clean(value):
    if isinstance(value, str):
        return value.translate(_TABLE)
    # An exception's message often quotes what it was handed.
    if isinstance(value, BaseException):
        return str(value).translate(_TABLE)
    return value


def install():
    """Wrap the record factory (idempotent)."""
    previous = logging.getLogRecordFactory()
    if getattr(previous, "_supysonic_logsafe", False):
        return

    def factory(*args, **kwargs):
        record = previous(*args, **kwargs)
        if record.args and (
            record.name == _PACKAGE or record.name.startswith(_PACKAGE + ".")
        ):
            if isinstance(record.args, tuple):
                record.args = tuple(_clean(a) for a in record.args)
            elif isinstance(record.args, dict):
                record.args = {k: _clean(v) for k, v in record.args.items()}
        return record

    factory._supysonic_logsafe = True
    logging.setLogRecordFactory(factory)

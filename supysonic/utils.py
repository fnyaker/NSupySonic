# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2019-2022 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

from base64 import b64encode, b64decode
from hashlib import sha256
from os import environ, urandom

from supysonic.db import Meta


__key_cache = {}

# The shortest search term we're willing to run a full-table LIKE scan for.
LIKE_MIN_LENGTH = 2


def like_term(raw, minimum=LIKE_MIN_LENGTH):
    """Normalise a client search string before it reaches a LIKE query.

    peewee's ``.contains()`` interpolates the term into ``LIKE '%term%'`` with
    no ESCAPE clause, so a client-supplied ``%`` is a wildcard: ``?q=%`` matched
    — and serialised — the *entire* library for the cost of one request. Adding
    backslash escapes is not an option (SQLite defines no default escape
    character, so ``\\%`` would then stop matching a literal "50%"), so the
    multi-character wildcard is simply dropped.

    ``_`` is left alone on purpose: it matches any single character, so it can
    only over-match by the term's own length — no amplification — and stripping
    it would break searching for names that really contain an underscore.

    Returns None when nothing worth scanning for is left.
    """
    term = str(raw or "").replace("%", "").strip()
    if len(term) < minimum:
        return None
    return term


def get_secret_key(keyname):
    """Return a server secret by name.

    Resolution order:
      1. Environment variable ``SUPYSONIC_SECRET_<KEYNAME>`` (recommended for
         internet-exposed deployments): keeps the secret out of the database, so
         a database leak alone can't decrypt anything derived from it (e.g. the
         reversible password store). Any string is accepted and stretched with
         SHA-256 so it doesn't have to be a specific length.
      2. The ``Meta`` table in the database (auto-generated on first use).
    """
    if keyname in __key_cache:
        return __key_cache[keyname]

    env_val = environ.get("SUPYSONIC_SECRET_" + keyname.upper())
    if env_val:
        key = sha256(env_val.encode("utf-8")).digest()
    else:
        try:
            key = b64decode(Meta[keyname].value)
        except Meta.DoesNotExist:
            key = urandom(128)
            Meta.create(key=keyname, value=b64encode(key).decode())

    __key_cache[keyname] = key
    return key

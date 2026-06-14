# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2023 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

API_VERSION = "1.12.0"

import binascii
import logging
import uuid
from flask import request, current_app
from flask import Blueprint
from peewee import IntegrityError

from ..db import ClientPrefs, Folder
from ..managers.user import UserManager
from ..ratelimit import auth_limiter

from .exceptions import GenericError, Unauthorized, NotFound
from .formatters import JSONFormatter, JSONPFormatter, XMLFormatter

api = Blueprint("api", __name__)
logger = logging.getLogger(__name__)


def api_routing(endpoint):
    def decorator(func):
        viewendpoint = f"{endpoint}.view"
        api.add_url_rule(endpoint, view_func=func, methods=["GET", "POST"])
        api.add_url_rule(viewendpoint, view_func=func, methods=["GET", "POST"])
        return func

    return decorator


@api.before_request
def set_formatter():
    """Return a function to create the response."""
    f, callback = map(request.values.get, ("f", "callback"))
    if f == "jsonp":
        request.formatter = JSONPFormatter(callback)
    elif f == "json":
        request.formatter = JSONFormatter()
    else:
        request.formatter = XMLFormatter()


def decode_password(password):
    if not password.startswith("enc:"):
        return password

    try:
        return binascii.unhexlify(password[4:].encode("utf-8")).decode("utf-8")
    except ValueError:
        return password


def _auth_rate_limited():
    return not current_app.testing and auth_limiter.is_blocked(request.remote_addr)


def _record_auth_failure(username):
    logger.error(
        "Failed login attempt for user %s (IP: %s)", username, request.remote_addr
    )
    if not current_app.testing:
        auth_limiter.record_failure(request.remote_addr)


@api.before_request
def authorize():
    if _auth_rate_limited():
        raise Unauthorized()

    if request.authorization:
        username = request.authorization.username
        user = UserManager.try_auth(username, request.authorization.password)
        if user is not None:
            auth_limiter.reset(request.remote_addr)
            request.user = user
            return

        _record_auth_failure(username)
        raise Unauthorized()

    username = request.values["u"]

    token, salt = map(request.values.get, ("t", "s"))
    if token and salt and "p" not in request.values:
        # Subsonic token authentication (t = md5(password + s))
        user = UserManager.try_auth_token(username, token, salt)
    else:
        password = decode_password(request.values["p"])
        user = UserManager.try_auth(username, password)

    if user is None:
        _record_auth_failure(username)
        raise Unauthorized()

    auth_limiter.reset(request.remote_addr)
    request.user = user


@api.before_request
def get_client_prefs():
    client = request.values["c"]
    try:
        request.client = ClientPrefs[request.user, client]
    except ClientPrefs.DoesNotExist:
        try:
            request.client = ClientPrefs.create(user=request.user, client_name=client)
        except IntegrityError:
            # We might have hit a race condition here, another request already created
            # the ClientPrefs. Issue #220
            request.client = ClientPrefs[request.user, client]


def get_entity(cls, param="id"):
    eid = request.values[param]
    if cls == Folder:
        eid = int(eid)
    else:
        eid = uuid.UUID(eid)
    return cls[eid]


def get_entity_id(cls, eid):
    """Return the entity ID as its proper type."""
    if cls == Folder:
        if isinstance(eid, uuid.UUID):
            raise GenericError("Invalid ID")
        try:
            return int(eid)
        except ValueError as e:
            raise GenericError("Invalid ID") from e
    try:
        return uuid.UUID(eid)
    except (AttributeError, ValueError) as e:
        raise GenericError("Invalid ID") from e


def get_root_folder(id):
    if id is None:
        return None

    try:
        fid = int(id)
    except ValueError as e:
        raise ValueError("Invalid folder ID") from e

    try:
        return Folder.get(id=fid, root=True)
    except Folder.DoesNotExist as e:
        raise NotFound("Folder") from e


from .errors import *

from .system import *
from .browse import *
from .user import *
from .albums_songs import *
from .media import *
from .annotation import *
from .chat import *
from .search import *
from .playlists import *
from .jukebox import *
from .radio import *
from .unsupported import *
from .scan import *

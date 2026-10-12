# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2019-2022 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import math
import uuid

from flask import current_app, request

from ..daemon import DaemonClient
from ..daemon.exceptions import DaemonUnavailableError
from ..db import Track

from . import api_routing
from .exceptions import GenericError, MissingParameter, Forbidden


@api_routing("/jukeboxControl")
def jukebox_control():
    if not request.user.jukebox and not request.user.admin:
        raise Forbidden()

    action = request.values["action"]

    index = request.values.get("index")
    offset = request.values.get("offset")
    id = request.values.getlist("id")
    gain = request.values.get("gain")

    if action not in (
        "get",
        "status",
        "set",
        "start",
        "stop",
        "skip",
        "add",
        "clear",
        "remove",
        "shuffle",
        "setGain",
    ):
        raise GenericError("Unknown action")

    args = ()
    if action == "set":
        if id:
            args = [uuid.UUID(i) for i in id]
    elif action == "skip":
        if not index:
            raise MissingParameter("index")
        if offset:
            args = (int(index), int(offset))
        else:
            args = (int(index), 0)
    elif action == "add":
        if not id:
            raise MissingParameter("id")
        else:
            args = [uuid.UUID(i) for i in id]
    elif action == "remove":
        if not index:
            raise MissingParameter("index")
        else:
            args = (int(index),)
    elif action == "setGain":
        if not gain:
            raise MissingParameter("gain")
        else:
            # Subsonic's gain is 0.0..1.0. float() also accepts "nan" and
            # "inf", which would reach the player as a volume.
            gain = float(gain)
            if not math.isfinite(gain):
                raise GenericError("Invalid gain")
            args = (min(max(gain, 0.0), 1.0),)

    try:
        status = DaemonClient(current_app.config["DAEMON"]["socket"]).jukebox_control(
            action, *args
        )
    except DaemonUnavailableError:
        raise GenericError("Jukebox unavaliable")

    rv = {
        "currentIndex": status.index,
        "playing": status.playing,
        "gain": status.gain,
        "position": status.position,
    }
    if action == "get":
        playlist = []
        for path in status.playlist:
            try:
                playlist.append(Track.get(path=path))
            except Track.DoesNotExist:
                pass
        rv["entry"] = [
            t.as_subsonic_child(request.user, request.client) for t in playlist
        ]
        return request.formatter("jukeboxPlaylist", rv)
    else:
        return request.formatter("jukeboxStatus", rv)

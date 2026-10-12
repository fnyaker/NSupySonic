# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2025 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import re
import uuid

from flask import Response, flash, redirect, render_template, request, url_for
from functools import wraps
from urllib.parse import quote

from ..db import Playlist, PlaylistTrack

from . import frontend


@frontend.route("/playlist")
def playlist_index():
    return render_template(
        "playlists.html",
        mine=Playlist.select().where(Playlist.user == request.user),
        others=Playlist.select().where(Playlist.user != request.user, Playlist.public),
    )


def resolve_and_inject_playlist(func):
    @wraps(func)
    def decorated(uid):
        try:
            uid = uuid.UUID(uid)
        except ValueError:
            flash("Invalid playlist id", "warning")
            return redirect(url_for("frontend.playlist_index"))

        try:
            playlist = Playlist[uid]
        except Playlist.DoesNotExist:
            flash("Unknown playlist", "warning")
            return redirect(url_for("frontend.playlist_index"))

        return func(uid, playlist)

    return decorated


@frontend.route("/playlist/<uid>")
@resolve_and_inject_playlist
def playlist_details(uid, playlist):
    return render_template("playlist.html", playlist=playlist)


@frontend.route("/playlist/<uid>/export")
@resolve_and_inject_playlist
def playlist_export(uid, playlist):
    return Response(
        render_template("playlist_export.m3u", playlist=playlist),
        mimetype="audio/mpegurl",
        # The name is the user's: a quote, a semicolon or a newline in it must
        # not reach the header raw. RFC 6266 form, with an ASCII fallback.
        headers={
            "Content-disposition": "attachment; filename=\"{}.m3u\"; "
            "filename*=UTF-8''{}.m3u".format(
                re.sub(r'[^A-Za-z0-9 ._-]', "_", playlist.name) or "playlist",
                quote(playlist.name, safe=""),
            )
        },
    )


@frontend.route("/playlist/<uid>", methods=["POST"])
@resolve_and_inject_playlist
def playlist_update(uid, playlist):
    if playlist.user_id != request.user.id:
        flash("You're not allowed to edit this playlist", "danger")
    elif not request.form.get("name"):
        flash("Missing playlist name", "danger")
    else:
        playlist.name = request.form.get("name")
        playlist.public = request.form.get("public") in (
            True,
            "True",
            1,
            "1",
            "on",
            "checked",
        )
        playlist.save()
        flash("Playlist updated.", "success")

    return playlist_details(str(uid))


@frontend.route("/playlist/del/<uid>", methods=["POST"])
@resolve_and_inject_playlist
def playlist_delete(uid, playlist):
    if playlist.user_id != request.user.id:
        flash("You're not allowed to delete this playlist", "danger")
    else:
        PlaylistTrack.delete().where(PlaylistTrack.playlist == playlist).execute()
        playlist.delete_instance()
        flash("Playlist deleted", "success")

    return redirect(url_for("frontend.playlist_index"))

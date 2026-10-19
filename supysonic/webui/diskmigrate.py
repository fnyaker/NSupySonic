# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Réglages → Archive: bring the archives already on disk to the current format.

The work is ``supysonic/deezer/diskmigrate.py`` (a resumable library job on a
worker thread); this is the button and its progress. Admin only: it rewrites
files.
"""

from flask import current_app, jsonify, request

from . import admin_required, login_required, webapi


@webapi.route("/archive/migrate", methods=["POST"])
@login_required
@admin_required
def archive_migrate_start():
    from ..deezer import diskmigrate

    data = request.get_json(silent=True) or {}
    started = diskmigrate.start(current_app._get_current_object(), force=bool(data.get("force")))
    return jsonify({"ok": True, "started": started, **diskmigrate.status()})


@webapi.route("/archive/migrate")
@login_required
@admin_required
def archive_migrate_status():
    from ..deezer import diskmigrate

    return jsonify(diskmigrate.status())

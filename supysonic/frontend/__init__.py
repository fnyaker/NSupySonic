# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2022 Alban 'spl0k' Féron
#                    2017 Óscar García Amor
#
# Distributed under terms of the GNU AGPLv3 license.

import hmac
import secrets

from flask import (
    current_app,
    flash,
    redirect,
    request,
    render_template,
    session,
    url_for,
)
from flask import Blueprint
from functools import wraps

from .. import VERSION, DOWNLOAD_URL
from ..daemon.client import DaemonClient
from ..daemon.exceptions import DaemonUnavailableError
from ..db import Artist, Album, Track, User
from ..managers.user import UserManager

frontend = Blueprint("frontend", __name__)

CSRF_FIELD = "_csrf"
CSRF_SESSION_KEY = "_csrf_token"


def csrf_token():
    """The per-session CSRF token, minted on first use.

    Templates embed it (see ``layout.html``'s ``<meta name="csrf-token">`` and
    the hidden field in every form); ``csrf_check`` below rejects any state
    changing request that doesn't echo it back.
    """
    token = session.get(CSRF_SESSION_KEY)
    if not token:
        token = secrets.token_urlsafe(32)
        session[CSRF_SESSION_KEY] = token
    return token


@frontend.context_processor
def inject_metadata():
    return {
        "version": VERSION,
        "download_url": DOWNLOAD_URL,
        "csrf_token": csrf_token,
    }


@frontend.before_request
def csrf_check():
    """Reject cross-site state changes on the admin UI.

    Every mutating endpoint is POST-only (deletes, scans and unlinks used to be
    plain GET links, which an <img> tag on any page the admin visited could
    fire), and every POST must carry the session's token.
    """
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    expected = session.get(CSRF_SESSION_KEY)
    sent = request.form.get(CSRF_FIELD) or request.headers.get("X-CSRF-Token") or ""
    if not expected or not hmac.compare_digest(str(expected), str(sent)):
        return "Invalid or expired form token. Reload the page and try again.", 400


@frontend.before_request
def login_check():
    request.user = None
    should_login = True
    if session.get("userid"):
        try:
            user = UserManager.get(session.get("userid"))
            # A signed cookie can't be revoked, so compare the epoch it was
            # minted with against the user's current one: a password change or
            # a role change bumps it and kills every outstanding session.
            if session.get("epoch", 0) != (user.session_epoch or 0):
                session.clear()
            else:
                request.user = user
                should_login = False
        except (ValueError, User.DoesNotExist):
            session.clear()

    if should_login and request.endpoint != "frontend.login":
        flash("Please login")
        return redirect(
            url_for(
                "frontend.login",
                returnUrl=request.script_root
                + request.url[len(request.url_root) - 1 :],
            )
        )


@frontend.before_request
def scan_status():
    if not request.user or not request.user.admin:
        return

    try:
        scanned = DaemonClient(
            current_app.config["DAEMON"]["socket"]
        ).get_scanning_progress()
        if scanned is not None:
            flash(f"Scanning in progress, {scanned} files scanned.")
    except DaemonUnavailableError:
        pass


@frontend.route("/")
def index():
    stats = {
        "artists": Artist.select().count(),
        "albums": Album.select().count(),
        "tracks": Track.select().count(),
    }
    return render_template("home.html", stats=stats)


def admin_only(f):
    @wraps(f)
    def decorated_func(*args, **kwargs):
        if not request.user or not request.user.admin:
            return redirect(url_for("frontend.index"))
        return f(*args, **kwargs)

    return decorated_func


from .user import *
from .folder import *
from .playlist import *

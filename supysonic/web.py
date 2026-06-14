# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2023 Alban 'spl0k' Féron
#               2018-2019 Carey 'pR0Ps' Metcalfe
#                    2017 Óscar García Amor
#
# Distributed under terms of the GNU AGPLv3 license.

import logging
import mimetypes

from flask import Flask
from logging.handlers import TimedRotatingFileHandler
from os import makedirs, path

from .config import IniConfig
from .cache import Cache
from .db import init_database, open_connection, close_connection
from .utils import get_secret_key

logger = logging.getLogger(__package__)


def create_application(config=None):
    global app

    # Flask!
    app = Flask(__name__)
    app.config.from_object("supysonic.config.DefaultConfig")

    if not config:  # pragma: nocover
        config = IniConfig.from_common_locations()
    app.config.from_object(config)

    # Set loglevel
    logfile = app.config["WEBAPP"]["log_file"]
    if logfile:  # pragma: nocover
        if app.config["WEBAPP"]["log_rotate"]:
            handler = TimedRotatingFileHandler(logfile, when="midnight")
        else:
            handler = logging.FileHandler(logfile)
        handler.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        )
        logger.addHandler(handler)
    loglevel = app.config["WEBAPP"]["log_level"]
    if loglevel:
        logger.setLevel(getattr(logging, loglevel.upper(), logging.NOTSET))

    # Initialize database
    init_database(app.config["BASE"]["database_uri"])
    if not app.testing:

        def open_conn():  # Just to discard the return value
            open_connection()

        app.before_request(open_conn)
        app.teardown_request(lambda exc: close_connection())

    # Insert unknown mimetypes
    for k, v in app.config["MIMETYPES"].items():
        extension = "." + k.lower()
        if extension not in mimetypes.types_map:
            mimetypes.add_type(v, extension, False)

    # Initialize Cache objects
    # Max size is MB in the config file but Cache expects bytes
    cache_dir = app.config["WEBAPP"]["cache_dir"]
    max_size_cache = app.config["WEBAPP"]["cache_size"] * 1024**2
    max_size_transcodes = app.config["WEBAPP"]["transcode_cache_size"] * 1024**2
    app.cache = Cache(path.join(cache_dir, "cache"), max_size_cache)
    app.transcode_cache = Cache(path.join(cache_dir, "transcodes"), max_size_transcodes)

    # Initialize the optional Deezer proxy (lazy login on first use)
    from .deezer import get_provider

    app.deezer = get_provider(app.config)
    app.deezer_prefetch = None
    if app.deezer is not None and app.config["DEEZER"].get("preload"):
        from .deezer.prefetch import DeezerPrefetcher

        count = int(app.config["DEEZER"].get("preload_count") or 2)
        app.deezer_prefetch = DeezerPrefetcher(app.deezer, workers=min(max(1, count), 4))

    if app.deezer is not None and not app.testing:
        from .deezer.scheduler import maybe_start

        maybe_start(app)

    # Test for the cache directory
    cache_path = app.config["WEBAPP"]["cache_dir"]
    if not path.exists(cache_path):
        makedirs(cache_path)  # pragma: nocover

    # Read or create secret key
    app.secret_key = get_secret_key("cookies_secret")

    # Harden the web UI session cookie (the Subsonic API uses its own per-request
    # auth, so this only affects the /api + /app session). SameSite=Lax blocks the
    # cookie on cross-site POSTs, mitigating CSRF on the mutating /api endpoints.
    app.config.setdefault("SESSION_COOKIE_HTTPONLY", True)
    app.config.setdefault("SESSION_COOKIE_SAMESITE", "Lax")
    # Set the Secure flag when served behind TLS (recommended for internet
    # exposure). Off by default so plain-HTTP LAN setups keep working; enable
    # via [webapp] session_cookie_secure = yes.
    app.config.setdefault(
        "SESSION_COOKIE_SECURE",
        bool(app.config["WEBAPP"].get("session_cookie_secure", False)),
    )

    # Baseline security response headers for the admin UI and the bundled SPA.
    # CSP: scripts are served from this origin (admin assets are local, the
    # Svelte build emits external bundles), Deezer cover art / audio come over
    # https, and Svelte injects scoped <style> blocks (style 'unsafe-inline').
    csp = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; "
        "media-src 'self' blob: https:; "
        "connect-src 'self' https:; "
        "font-src 'self' data:; "
        "frame-ancestors 'self'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )

    @app.after_request
    def set_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("Content-Security-Policy", csp)
        return response

    # Honour X-Forwarded-* from a trusted reverse proxy so request.remote_addr
    # (rate limiting, logs) and request.is_secure (Secure cookie) reflect the
    # real client. Opt-in only: enabling this when the app is reachable directly
    # would let clients spoof those headers. proxy_fix_hops = number of proxies.
    try:
        hops = int(app.config["WEBAPP"].get("proxy_fix_hops") or 0)
    except (TypeError, ValueError):
        hops = 0
    if hops > 0:
        from werkzeug.middleware.proxy_fix import ProxyFix

        # Only trust X-Forwarded-For (client IP) and -Proto (http/https). NOT
        # -Host / -Prefix: rewriting those breaks URL generation if any upstream
        # sends them, and they're not needed for rate limiting or the cookie.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=hops, x_proto=hops)

    # Import app sections
    if app.config["WEBAPP"]["mount_webui"]:
        from .frontend import frontend

        app.register_blueprint(frontend)
    if app.config["WEBAPP"]["mount_api"]:
        from .api import api

        app.register_blueprint(api, url_prefix="/rest")

    if app.config["WEBAPP"]["mount_webui"]:
        # Custom Deezer-native JSON API for the bundled discovery web UI.
        from .webui import webapi

        app.register_blueprint(webapi, url_prefix="/api")

        if app.config["WEBAPP"].get("mount_spa", True):
            # Bundled Svelte discovery app, served at /app (hash-routed).
            from .webui.spa import spa

            app.register_blueprint(spa)

    if not app.testing:
        close_connection()

    return app

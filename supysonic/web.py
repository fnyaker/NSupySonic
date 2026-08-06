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

from datetime import timedelta
from flask import Flask, request
from logging.handlers import TimedRotatingFileHandler
from os import makedirs, path

from .config import IniConfig, app_config_from
from .cache import Cache
from .db import init_database, open_connection, close_connection
from .utils import get_secret_key

logger = logging.getLogger(__package__)


def setup_deezer(app):
    """(Re)build the Deezer proxy, its prefetcher and the auto-sync thread.

    Called at startup and again whenever an admin saves a new ARL, so a fresh
    credential takes effect without restarting the container — including the
    case where the proxy was off at boot (no ARL configured at all) and the
    admin has just supplied one.
    """
    from .deezer import get_provider

    app.deezer = get_provider(app.config)
    app.deezer_prefetch = None
    if app.deezer is not None and app.config["DEEZER"].get("preload"):
        from .deezer.prefetch import DeezerPrefetcher

        count = int(app.config["DEEZER"].get("preload_count") or 2)
        # Parallel workers for explicit "download this now" requests (whole
        # album/playlist pre-archiving). Higher than the play-ahead preloader so
        # a batch download of a playlist finishes in a fraction of the time.
        dl_count = int(app.config["DEEZER"].get("download_workers") or 4)
        app.deezer_prefetch = DeezerPrefetcher(
            app.deezer,
            workers=min(max(1, count), 4),
            dl_workers=min(max(1, dl_count), 8),
        )

    # The sync thread reads app.deezer on every run, so it survives a swap; it
    # just must not be started twice.
    if (
        app.deezer is not None
        and not app.testing
        and not getattr(app, "_deezer_scheduler", None)
    ):
        from .deezer.scheduler import maybe_start

        app._deezer_scheduler = maybe_start(app)
    return app.deezer


def create_application(config=None):
    global app

    # Flask!
    app = Flask(__name__)
    app.config.from_object("supysonic.config.DefaultConfig")

    if not config:  # pragma: nocover
        config = IniConfig.from_common_locations()
    # Allowlist, not from_object(): that copies every uppercase attribute, so a
    # stray (or malicious) section in a config file could overwrite a Flask
    # setting — SECRET_KEY included.
    app.config.update(app_config_from(config))

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
    setup_deezer(app)

    # Test for the cache directory
    cache_path = app.config["WEBAPP"]["cache_dir"]
    if not path.exists(cache_path):
        makedirs(cache_path)  # pragma: nocover

    # Read or create secret key
    app.secret_key = get_secret_key("cookies_secret")

    # Harden the web UI session cookie (the Subsonic API uses its own per-request
    # auth, so this only affects the /api + /app session). SameSite=Lax blocks the
    # cookie on cross-site POSTs, mitigating CSRF on the mutating /api endpoints.
    #
    # These MUST be plain assignments: Flask's own default_config already defines
    # every SESSION_COOKIE_* key, so `setdefault` silently did nothing and neither
    # SameSite nor Secure ever reached the wire (session_cookie_secure = yes was a
    # placebo). Verified by tests/test_security.py against the real Set-Cookie.
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    # Set the Secure flag when served behind TLS (recommended for internet
    # exposure). Off by default so plain-HTTP LAN setups keep working; enable
    # via [webapp] session_cookie_secure = yes.
    app.config["SESSION_COOKIE_SECURE"] = bool(
        app.config["WEBAPP"].get("session_cookie_secure", False)
    )
    # Signed cookies can't be revoked server-side, so a stolen one stays valid
    # for its whole lifetime. Flask's default is 31 days; cut it to a week (and
    # see User.session_epoch in db.py, which does make sessions revocable on a
    # password change or a role downgrade).
    try:
        session_days = int(app.config["WEBAPP"].get("session_lifetime_days") or 7)
    except (TypeError, ValueError):
        session_days = 7
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(
        days=max(1, min(session_days, 31))
    )

    # Bound request body size (the /api/upload endpoint accepts audio files from
    # any logged-in user — unbounded, one request could fill the disk). Flask
    # rejects oversized bodies with 413.
    try:
        upload_max = int(app.config["WEBAPP"].get("upload_max_size") or 0)
    except (TypeError, ValueError):
        upload_max = 0
    if upload_max > 0:
        app.config["MAX_CONTENT_LENGTH"] = upload_max * 1024**2

    # Baseline security response headers for the admin UI and the bundled SPA.
    # CSP: scripts are served from this origin (admin assets are local, the
    # Svelte build emits external bundles) and Svelte injects scoped <style>
    # blocks (style 'unsafe-inline').
    #
    # img-src/connect-src are pinned to the hosts actually used rather than a
    # blanket `https:`: a wildcard turns any injection (or the JSONP gadget on
    # /rest) into an exfiltration channel to the whole HTTPS internet. Audio is
    # always same-origin (/api/stream proxies + transcodes everything), and the
    # only remote images are Deezer's art CDN plus api.deezer.com's redirecting
    # /image endpoints — everything else already goes through /api/cover.
    csp = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https://*.dzcdn.net https://api.deezer.com; "
        "media-src 'self' blob:; "
        "connect-src 'self'; "
        "font-src 'self' data:; "
        "object-src 'none'; "
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
        response.headers.setdefault(
            "Permissions-Policy", "geolocation=(), camera=(), microphone=()"
        )
        # Only over a real TLS connection: sending HSTS on plain HTTP is a no-op
        # per spec, but pinning a LAN host to https:// would lock users out.
        if request.is_secure:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        return response

    # gzip the JSON API responses (playlists/favorites track lists are large and
    # highly repetitive — this cuts the bytes on the wire ~5-10x, so big lists
    # load much faster). Streamed audio/cover responses (direct_passthrough) and
    # small/already-encoded ones are left untouched.
    import gzip as _gzip

    @app.after_request
    def compress_response(response):
        try:
            if (
                response.direct_passthrough
                or response.status_code < 200
                or response.status_code >= 300
                or response.headers.get("Content-Encoding")
            ):
                return response
            accept = request.headers.get("Accept-Encoding", "")
            if "gzip" not in accept.lower():
                return response
            ctype = (response.content_type or "").split(";", 1)[0].strip()
            if not (ctype == "application/json" or ctype.startswith("text/")):
                return response
            data = response.get_data()
            if len(data) < 1024:  # not worth the CPU / header overhead
                return response
            packed = _gzip.compress(data, compresslevel=6)
            response.set_data(packed)
            response.headers["Content-Encoding"] = "gzip"
            response.headers["Content-Length"] = str(len(packed))
            response.headers.add("Vary", "Accept-Encoding")
        except Exception:  # compression must never break a response
            logger.debug("response compression skipped", exc_info=True)
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

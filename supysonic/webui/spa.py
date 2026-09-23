# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Serve the bundled Svelte discovery SPA at ``/app``.

The SPA is built (``npm run build`` in ``webapp/``) into ``supysonic/webui/dist``
with Vite ``base: '/app/'``. Routing is hash-based, so any deep link still loads
``index.html`` and no server-side catchall is required; we only need to serve the
build directory and fall back to ``index.html`` for unknown paths.

If the build directory is absent (SPA not built), ``/app`` returns a short notice
instead of a 404 so the rest of the server keeps working.
"""

from __future__ import annotations

import html
import os.path
import re

from flask import Blueprint, abort, make_response, send_from_directory

DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")

spa = Blueprint("spa", __name__)

_NOT_BUILT = (
    "<!doctype html><meta charset=utf-8><title>Deezer web UI</title>"
    "<body style='font-family:sans-serif;max-width:40em;margin:4em auto;padding:0 1em'>"
    "<h1>Web UI not built</h1>"
    "<p>The Svelte discovery app hasn't been built yet. From the repo root run:</p>"
    "<pre>cd webapp &amp;&amp; npm install &amp;&amp; npm run build</pre>"
    "<p>or use the Docker image, which builds it automatically.</p>",
    503,
)


# Force the Content-Type by extension instead of trusting the host's mimetypes
# registry: a slim base image without /etc/mime.types can return an empty/wrong
# type, and a JS module served without a JavaScript MIME type is blocked by the
# browser under the global X-Content-Type-Options: nosniff header.
_MIME_BY_EXT = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
}


def _has_build() -> bool:
    return os.path.isfile(os.path.join(DIST_DIR, "index.html"))


@spa.route("/app/")
@spa.route("/app/<path:path>")
def serve(path: str = ""):
    if not _has_build():
        return _NOT_BUILT
    if path:
        if os.path.isfile(os.path.join(DIST_DIR, path)):
            mimetype = _MIME_BY_EXT.get(os.path.splitext(path)[1].lower())
            response = send_from_directory(DIST_DIR, path, mimetype=mimetype)
            # Vite asset filenames are content-hashed, so they're immutable.
            if path.startswith("assets/"):
                response.headers["Cache-Control"] = (
                    "public, max-age=31536000, immutable"
                )
            elif path == "version.json":
                # The update signal itself. A cached copy of it would pin the app
                # to whatever build it named — the one file that must always be
                # answered live, through every proxy in between.
                response.headers["Cache-Control"] = "no-store"
            return response
        # A missing *file* request (it has an extension, e.g. a stale asset
        # hash) must 404 — never fall through to index.html. Serving HTML for a
        # .js/.css gets blocked by the browser as a forbidden MIME type because
        # of the global X-Content-Type-Options: nosniff header.
        if os.path.splitext(path)[1]:
            abort(404)
    # Hash-routing fallback: any unknown route serves the SPA entry point.
    # Never cache it, so a redeploy's new asset references are picked up
    # immediately (a stale index.html points at assets that no longer exist).
    response = send_from_directory(
        DIST_DIR, "index.html", mimetype="text/html; charset=utf-8"
    )
    response.headers["Cache-Control"] = "no-cache"
    return response


# The listen party's link: short enough to read out or put in a QR code, and a
# real page rather than a bare redirect so messaging apps render a proper
# preview ("Listen party — Alice") instead of the SPA's generic title. The page
# itself only forwards into the app, with a meta refresh because the CSP (rightly)
# refuses inline script.
_PARTY_ID = re.compile(r"\A[A-Za-z0-9_-]{16,64}\Z")


@spa.route("/party/<pid>")
def party_link(pid: str):
    if not _PARTY_ID.fullmatch(pid):
        abort(404)
    from .party import _get

    party = _get(pid)
    host = html.escape(party.owner_name) if party else ""
    title = f"Listen party de {host}" if host else "Listen party"
    desc = (
        "Rejoins l'écoute : la même musique, au même instant, sur ton appareil."
        if party
        else "Cette listen party est terminée."
    )
    target = f"/app/#/party/{pid}"
    page = (
        "<!doctype html><html lang=fr><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title>"
        f"<meta property='og:title' content='{title}'>"
        f"<meta property='og:description' content='{desc}'>"
        "<meta property='og:type' content='music.radio_station'>"
        "<meta name=theme-color content='#0f0d13'>"
        f"<meta http-equiv=refresh content='0;url={target}'>"
        "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;"
        "background:#0f0d13;color:#f3f0f7;font:16px system-ui,sans-serif}"
        "a{color:#a238ff}</style></head>"
        f"<body><a href='{target}'>{title}</a></body></html>"
    )
    resp = make_response(page)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    # The page names the host; keep it out of search engines.
    resp.headers["X-Robots-Tag"] = "noindex"
    return resp

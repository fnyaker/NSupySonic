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

import os.path

from flask import Blueprint, abort, send_from_directory

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

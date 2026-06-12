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

from flask import Blueprint, send_from_directory

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


def _has_build() -> bool:
    return os.path.isfile(os.path.join(DIST_DIR, "index.html"))


@spa.route("/app/")
@spa.route("/app/<path:path>")
def serve(path: str = ""):
    if not _has_build():
        return _NOT_BUILT
    if path and os.path.isfile(os.path.join(DIST_DIR, path)):
        return send_from_directory(DIST_DIR, path)
    # Hash-routing fallback: any unknown path serves the SPA entry point.
    return send_from_directory(DIST_DIR, "index.html")

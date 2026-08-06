# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Build identity of the served web app (+ the published Android app).

The SPA is a long-lived install: a phone can keep a months-old bundle alive in
its service worker cache and never notice a redeploy. So the server publishes
exactly what it is serving right now, and the client compares.

``dist/version.json`` is written by the Vite build (see ``webapp/vite.config.js``)
and holds the same build id that is compiled *into* the bundle, so "what the
browser is running" and "what the server has" are directly comparable. When it's
missing (a dev build, or a dist from before this existed) we fall back to a hash
of ``index.html`` — which references the content-hashed asset filenames, so it
changes on every real rebuild too.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os.path
import threading

from .spa import DIST_DIR

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_cache: tuple[float, dict] | None = None  # (index.html mtime, payload)

# Where to send someone whose Android app is out of date. Overridable via
# [webapp] android_url for forks / private builds.
DEFAULT_ANDROID_URL = "https://github.com/fnyaker/NSupySonic/releases/latest"


def _read_build() -> dict:
    """``{"build": str, "version": str|None}`` for the SPA currently on disk."""
    index = os.path.join(DIST_DIR, "index.html")
    try:
        with open(os.path.join(DIST_DIR, "version.json"), "rb") as fh:
            data = json.loads(fh.read().decode("utf-8"))
        build = str(data.get("build") or "").strip()
        if build:
            return {"build": build, "version": data.get("version")}
    except (OSError, ValueError, TypeError):
        pass
    try:
        with open(index, "rb") as fh:
            digest = hashlib.sha1(fh.read()).hexdigest()[:16]
        return {"build": digest, "version": None}
    except OSError:
        return {"build": None, "version": None}


def spa_build() -> dict:
    """Cached ``_read_build``, re-read whenever index.html changes on disk."""
    global _cache
    try:
        mtime = os.path.getmtime(os.path.join(DIST_DIR, "index.html"))
    except OSError:
        mtime = 0.0
    with _lock:
        if _cache is not None and _cache[0] == mtime:
            return _cache[1]
        payload = _read_build()
        _cache = (mtime, payload)
        return payload


def android_release(webapp_config: dict) -> dict:
    """The Android build this server expects clients to be running.

    ``version`` is None unless the deployment declares one ([webapp]
    android_version, or ANDROID_VERSION_NAME / APP_VERSION in the container) —
    the app must never claim an update exists on a guess.
    """
    version = (webapp_config.get("android_version") or "").strip() or None
    url = (webapp_config.get("android_url") or "").strip() or DEFAULT_ANDROID_URL
    # Only ever hand the client an http(s) link: this ends up in an anchor.
    if not url.startswith(("http://", "https://")):
        url = DEFAULT_ANDROID_URL
    return {"version": version, "url": url}

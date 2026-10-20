# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The Android app's own update, served by this server.

The app used to send the user to a GitHub page: leave the app, find the asset,
download it in a browser, open it from the notifications. Now the app asks THIS
server for the APK (``GET /api/android/apk``), checks it is a newer build of
itself signed with its own key, and hands it to Android's installer — one tap.

Where the file comes from, best first:

- ``[webapp] android_apk``: a local file the operator put there (a private or
  fork build). Served as is.
- the GitHub release of the declared ``android_version``, on the repository
  ``android_url`` points at (the project's by default). Downloaded once, on the
  first request for that version, and kept under ``<cache_dir>/android/``.

Nothing here is a trust decision: Android refuses to install an update that is
not signed with the installed app's certificate, and the app checks that itself
before asking (so it can say why rather than failing in the installer). The
server only has to never be a way to fetch anything but that one file.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from urllib.parse import urlsplit

import requests
from flask import current_app, jsonify, send_file

from . import login_required, webapi

logger = logging.getLogger(__name__)

APK_NAME = "nsupysonic.apk"
APK_MIME = "application/vnd.android.package-archive"
# A release APK is ~10 MB; anything past this is not one.
MAX_APK_BYTES = 200 * 1024 * 1024
# Connect, then between two reads: a stalled GitHub must not hold the thread.
TIMEOUT = (10, 60)
# What a tag may look like before it goes into a URL path.
_VERSION_RE = re.compile(r"\Av?[0-9A-Za-z][0-9A-Za-z._-]{0,39}\Z")
# github.com/<owner>/<repo>/...: the repository a release link points at.
_REPO_RE = re.compile(r"\A/([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})(?:/|\Z)")
# Hosts a release asset download may land on (GitHub redirects to its CDN).
_ASSET_HOSTS = ("github.com", "objects.githubusercontent.com",
                "release-assets.githubusercontent.com")
DEFAULT_REPO = ("fnyaker", "NSupySonic")

_lock = threading.Lock()


def declared_version(cfg: dict) -> str | None:
    version = (cfg.get("android_version") or "").strip()
    return version if _VERSION_RE.match(version) else None


def _repo_of(url: str | None) -> tuple[str, str] | None:
    if not url:
        return DEFAULT_REPO
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "github.com":
        return None
    m = _REPO_RE.match(parts.path)
    return (m.group(1), m.group(2)) if m else None


def apk_source(cfg: dict) -> tuple[str, str] | None:
    """``("file", path)``, ``("github", url)`` or None when there is no APK to offer."""
    local = (cfg.get("android_apk") or "").strip()
    if local:
        return ("file", local) if os.path.isfile(local) else None
    version = declared_version(cfg)
    repo = _repo_of((cfg.get("android_url") or "").strip() or None)
    if not version or not repo:
        return None
    owner, name = repo
    return (
        "github",
        f"https://github.com/{owner}/{name}/releases/download/{version}/{APK_NAME}",
    )


def _cache_path(cfg: dict, version: str) -> str:
    return os.path.join(cfg["cache_dir"], "android", f"nsupysonic-{version}.apk")


def _download(url: str, dest: str) -> None:
    """Fetch the release asset into ``dest``; raises on anything but an APK."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    part = dest + ".part"
    try:
        with requests.get(url, stream=True, timeout=TIMEOUT) as rv:
            final = urlsplit(rv.url)
            if final.scheme != "https" or final.hostname not in _ASSET_HOSTS:
                raise OSError(f"redirected off GitHub ({final.hostname})")
            rv.raise_for_status()
            size = 0
            with open(part, "wb") as fh:
                for chunk in rv.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > MAX_APK_BYTES:
                        raise OSError("larger than any APK")
                    fh.write(chunk)
        with open(part, "rb") as fh:
            # An APK is a zip; a GitHub error page is not.
            if fh.read(4) != b"PK\x03\x04":
                raise OSError("not an APK")
        os.replace(part, dest)
    finally:
        if os.path.exists(part):
            os.remove(part)
    # Older versions are never served again.
    folder = os.path.dirname(dest)
    for entry in os.listdir(folder):
        path = os.path.join(folder, entry)
        if path != dest and entry.startswith("nsupysonic-") and entry.endswith(".apk"):
            try:
                os.remove(path)
            except OSError:
                pass


def ensure_apk(cfg: dict) -> str | None:
    """Path of the APK to serve, downloading it first if needed; None if there is none."""
    source = apk_source(cfg)
    if source is None:
        return None
    kind, where = source
    if kind == "file":
        return where
    dest = _cache_path(cfg, declared_version(cfg))
    with _lock:  # two taps, one download
        if not os.path.isfile(dest):
            _download(where, dest)
    return dest


@webapi.route("/android/apk")
@login_required
def android_apk():
    cfg = current_app.config["WEBAPP"]
    try:
        path = ensure_apk(cfg)
    except (OSError, requests.RequestException) as exc:
        logger.warning("Android update unavailable: %s", exc)
        return jsonify({"error": "Impossible de récupérer la mise à jour"}), 502
    if path is None:
        return jsonify({"error": "Aucune mise à jour Android publiée"}), 404
    response = send_file(
        path, mimetype=APK_MIME, as_attachment=True, download_name=APK_NAME,
        conditional=True,
    )
    version = declared_version(cfg)
    if version:
        response.headers["X-NS-Version"] = version
    return response

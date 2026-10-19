# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""AcoustID: identify a file by its audio, through Chromaprint's ``fpcalc``.

Needs the binary AND the operator's application key (``[enrich] acoustid_key``,
never committed). Without either, ``available`` is False and nothing is tried.
"""

import json
import logging
import shutil
import subprocess  # nosec B404 - fpcalc, a fixed binary, argument list, no shell

from . import musicbrainz as mb

logger = logging.getLogger(__name__)

URL = "https://api.acoustid.org/v2/lookup"
MIN_SCORE = 0.9
#: Seconds of audio fingerprinted; AcoustID itself looks at the first two minutes.
FP_SECONDS = 120


def available(key):
    return bool(key) and shutil.which("fpcalc") is not None


def fingerprint(path):
    """``(duration, fingerprint)`` or None. A decode taking over a minute is dropped."""
    exe = shutil.which("fpcalc")
    if not exe:
        return None
    try:
        out = subprocess.run(  # nosec B603 - exe is shutil.which('fpcalc'); the path follows '--'
            [exe, "-json", "-length", str(FP_SECONDS), "--", path],
            capture_output=True, timeout=60, check=False,
        )
        data = json.loads(out.stdout or b"{}")
        return float(data["duration"]), str(data["fingerprint"])
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        logger.debug("acoustid: fpcalc failed on %s", path, exc_info=True)
        return None


def lookup(http, key, duration, fp):
    """The MusicBrainz recording id AcoustID is sure of (score >= 0.9), or None."""
    data = http.post_json(
        URL,
        {
            "client": key, "meta": "recordings", "format": "json",
            "duration": int(duration), "fingerprint": fp,
        },
    )
    for res in sorted((data or {}).get("results") or [], key=lambda r: -float(r.get("score") or 0)):
        if float(res.get("score") or 0) < MIN_SCORE:
            break
        for rec in res.get("recordings") or []:
            mbid = mb.valid_mbid(rec.get("id")) if isinstance(rec, dict) else None
            if mbid:
                return mbid
    return None

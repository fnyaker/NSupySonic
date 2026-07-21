# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Fetch and **archive** synchronized lyrics for library tracks.

Lyrics used to be a live Deezer-only nicety (fetched on every view, stored
nowhere). This module makes them a first-class archived asset, exactly like the
``cover.jpg`` sidecar the audio already gets:

* Every archived track can carry a ``.lrc`` sidecar next to its audio file
  holding time-synced lyrics (standard `LRC` format), served locally and
  offline by the web player and embedded (plain) in the file's tags so plain
  Subsonic clients see them too.
* Two sources feed it, best-first: **Deezer's own** (often synced) lyrics, then
  the public **LRCLIB** API (https://lrclib.net) — a free, crowdsourced,
  synced-lyrics database purpose-built for FOSS players. Whichever yields
  *synced* lyrics wins; a plain hit is only kept when nothing synced is found.

The canonical in-memory shape shared with the web layer is::

    {"text": str, "synced": [{"time": <ms:int>, "text": str}], "source": str}
"""

from __future__ import annotations

import logging
import os
import os.path
import re

import requests

from ..db import Track

logger = logging.getLogger(__name__)

# Public LRCLIB API. It asks clients to identify themselves with a descriptive
# User-Agent (see https://lrclib.net/docs); no key or auth is required.
LRCLIB_BASE = "https://lrclib.net/api"
USER_AGENT = "NSupySonic (https://github.com/fnyaker/nsupysonic)"
_HEADERS = {"User-Agent": USER_AGENT}
_TIMEOUT = 12

# `[mm:ss.xx]` / `[mm:ss.xxx]` (fraction optional) LRC timestamp.
_LRC_TS = re.compile(r"\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]")


# -- LRC (synced-lyrics text) <-> normalized list --------------------------


def parse_lrc(text: str) -> list[dict]:
    """Parse LRC text into ``[{"time": ms, "text": str}]`` sorted by time.

    A line may carry several timestamps (repeated refrains); each yields an
    entry. Metadata tags such as ``[ar:...]`` / ``[ti:...]`` don't match the
    timestamp shape and are ignored.
    """
    if not text:
        return []
    out: list[dict] = []
    for raw in text.splitlines():
        stamps = list(_LRC_TS.finditer(raw))
        if not stamps:
            continue
        body = _LRC_TS.sub("", raw).strip()
        for m in stamps:
            minutes, seconds, frac = int(m.group(1)), int(m.group(2)), m.group(3)
            if frac is None:
                ms = 0
            elif len(frac) == 3:
                ms = int(frac)
            else:  # 1-2 digits -> centiseconds
                ms = int(frac.ljust(2, "0")) * 10
            out.append({"time": minutes * 60000 + seconds * 1000 + ms, "text": body})
    out.sort(key=lambda item: item["time"])
    return out


def synced_to_lrc(synced: list[dict]) -> str:
    """Render a normalized synced list back to standard ``[mm:ss.cc]`` LRC."""
    lines = []
    for item in synced:
        cs = round(int(item.get("time") or 0) / 10)  # centiseconds
        minutes, rem = divmod(cs, 6000)
        seconds, centis = divmod(rem, 100)
        lines.append(f"[{minutes:02d}:{seconds:02d}.{centis:02d}] {item.get('text', '')}".rstrip())
    return "\n".join(lines)


# -- source normalizers -----------------------------------------------------


def normalize_gw_lyrics(raw: dict | None) -> dict | None:
    """Normalize Deezer ``song.getLyrics`` output to the canonical shape."""
    if not raw:
        return None
    synced = []
    for line in raw.get("LYRICS_SYNC_JSON") or []:
        ms = line.get("milliseconds")
        if ms is None:
            continue
        synced.append({"time": int(ms), "text": line.get("line", "")})
    text = raw.get("LYRICS_TEXT") or ""
    if not text and not synced:
        return None
    return {
        "text": text,
        "synced": synced,
        "source": "deezer",
        "copyright": raw.get("LYRICS_COPYRIGHTS") or "",
        "writers": raw.get("LYRICS_WRITERS") or "",
    }


def _lrclib_to_lyrics(data: dict | None) -> dict | None:
    if not data or data.get("instrumental"):
        return None
    synced = parse_lrc(data.get("syncedLyrics") or "")
    plain = (data.get("plainLyrics") or "").strip()
    if not synced and not plain:
        return None
    return {
        "text": plain or "\n".join(line["text"] for line in synced),
        "synced": synced,
        "source": "lrclib",
        "copyright": "",
        "writers": "",
    }


# -- LRCLIB client ----------------------------------------------------------


def _lrclib_search_best(session, title, artist, album, duration):
    """Fuzzy fallback when the exact signature misses (usually a duration diff):
    pick the closest hit, preferring one that actually has synced lyrics."""
    params = {"track_name": title, "artist_name": artist}
    r = session.get(f"{LRCLIB_BASE}/search", params=params, timeout=_TIMEOUT, headers=_HEADERS)
    if r.status_code != 200:
        return None
    results = r.json() or []
    if not results:
        return None

    def score(item):
        no_sync = 0 if item.get("syncedLyrics") else 1
        delta = abs((item.get("duration") or 0) - duration) if duration else 0
        return (no_sync, delta)

    return min(results, key=score)


def fetch_lrclib(title, artist, album=None, duration=None, *, session=None) -> dict | None:
    """Look a track up on LRCLIB by (title, artist, [album], [duration]).

    Tries the exact ``/get`` signature first, then falls back to ``/search``.
    Returns the canonical lyrics dict, or None on a miss / any network error
    (lyrics are best-effort — never let a lookup break the caller).
    """
    if not title or not artist:
        return None
    sess = session or requests
    params = {"track_name": title, "artist_name": artist}
    if album:
        params["album_name"] = album
    if duration:
        params["duration"] = int(duration)
    try:
        r = sess.get(f"{LRCLIB_BASE}/get", params=params, timeout=_TIMEOUT, headers=_HEADERS)
        if r.status_code == 200:
            data = r.json()
        elif r.status_code == 404:
            data = _lrclib_search_best(sess, title, artist, album, duration or 0)
        else:
            return None
    except requests.RequestException as exc:
        logger.debug("LRCLIB lookup failed for %s - %s: %s", artist, title, exc)
        return None
    except ValueError:  # malformed JSON
        return None
    return _lrclib_to_lyrics(data)


# -- sidecar storage --------------------------------------------------------


def sidecar_path(track: Track) -> str:
    """The ``.lrc`` sidecar path for a track's archived audio file."""
    return os.path.splitext(track.path)[0] + ".lrc"


def read_sidecar(track: Track) -> dict | None:
    """Read an archived ``.lrc`` sidecar into the canonical shape, or None."""
    path = sidecar_path(track)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    synced = parse_lrc(text)
    if synced:
        return {"text": "\n".join(s["text"] for s in synced), "synced": synced, "source": "archive"}
    stripped = text.strip()
    if not stripped:
        return None
    return {"text": stripped, "synced": [], "source": "archive"}


def write_sidecar(track: Track, lyrics: dict | None) -> str | None:
    """Persist lyrics as a ``.lrc`` sidecar next to the audio (atomic, idempotent
    write). Synced lyrics are stored as timestamped LRC; plain lyrics as text."""
    if not lyrics:
        return None
    content = synced_to_lrc(lyrics["synced"]) if lyrics.get("synced") else (lyrics.get("text") or "")
    if not content.strip():
        return None
    path = sidecar_path(track)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.part"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning("Writing lyrics sidecar failed for %s: %s", path, exc)
        return None
    return path


def _better(a: dict | None, b: dict | None) -> dict | None:
    """Pick the richer of two candidates: synced beats plain; else keep the
    first (Deezer is tried before LRCLIB, so its result wins on a tie)."""
    if a is None:
        return b
    if b is None:
        return a
    if bool(b.get("synced")) and not a.get("synced"):
        return b
    return a


# -- the two public entry points -------------------------------------------


def ensure_lyrics(
    provider, track: Track, *, session=None, overwrite=False, embed=True, allow_lrclib=True
) -> dict | None:
    """Return a track's archived lyrics, fetching + archiving them on first need.

    Order of preference: an existing ``.lrc`` sidecar, then Deezer's own
    (frequently synced) lyrics, then LRCLIB. The first source yielding *synced*
    lyrics wins. The chosen lyrics are written to the sidecar and (best-effort)
    embedded as plain text in the audio tags. Returns None when no source has
    anything, leaving nothing on disk so a later run retries.

    ``allow_lrclib=False`` restricts lookups to Deezer, keeping the hot archive
    path from fanning out to a second external service on every track; the
    LRCLIB gap-fill then happens lazily on first view or via the backfill CLI.
    """
    if track is None:
        return None
    if not overwrite:
        existing = read_sidecar(track)
        if existing:
            return existing

    best = None
    if provider is not None and track.deezer_id:
        try:
            best = normalize_gw_lyrics(provider.get_lyrics(track.deezer_id))
        except Exception as exc:  # network / auth — fall through to LRCLIB
            logger.debug("Deezer lyrics lookup failed for %s: %s", track.deezer_id, exc)

    if allow_lrclib and (best is None or not best.get("synced")):
        artist = _safe_name(lambda: track.artist.name)
        album = _safe_name(lambda: track.album.name)
        best = _better(best, fetch_lrclib(track.title, artist, album, track.duration, session=session))

    if best is None:
        return None
    write_sidecar(track, best)
    if embed:
        _try_embed(track, best)
    return best


def backfill_archived_lyrics(
    provider, *, overwrite=False, limit=None, progress=None, sleep=0.2, session=None
) -> dict:
    """Fetch + archive lyrics for every **archived** track missing a sidecar.

    "Archived" means the audio file is on disk; not-yet-fetched Deezer tracks
    are skipped (nothing to sit a sidecar next to). Returns a stats dict and,
    if given, calls ``progress(str)`` once per processed track. Politely paced
    with ``sleep`` seconds between network lookups.
    """
    import time

    sess = session or requests.Session()
    stats = {"scanned": 0, "synced": 0, "plain": 0, "missing": 0, "skipped": 0}
    done = 0
    for track in _iter_archived_tracks():
        if not overwrite and os.path.isfile(sidecar_path(track)):
            stats["skipped"] += 1
            continue
        stats["scanned"] += 1
        try:
            lyr = ensure_lyrics(provider, track, session=sess, overwrite=overwrite)
        except Exception as exc:
            logger.warning("Lyrics backfill failed for %s: %s", track.path, exc)
            lyr = None
        if lyr is None:
            stats["missing"] += 1
            label = "no lyrics found"
        elif lyr.get("synced"):
            stats["synced"] += 1
            label = f"synced ({lyr.get('source', '?')})"
        else:
            stats["plain"] += 1
            label = f"plain ({lyr.get('source', '?')})"
        if progress:
            progress(f"  {_safe_name(lambda: track.artist.name)} - {track.title}: {label}")
        done += 1
        if limit and done >= limit:
            break
        if sleep:
            time.sleep(sleep)
    return stats


# -- helpers ----------------------------------------------------------------


def _iter_archived_tracks():
    """Yield every Track whose audio is actually on disk (Deezer or local)."""
    for track in Track.select():
        if track.path and os.path.isfile(track.path):
            yield track


def _safe_name(getter) -> str:
    try:
        return getter() or ""
    except Exception:
        return ""


def _try_embed(track: Track, lyrics: dict) -> None:
    text = lyrics.get("text") or ""
    if not text.strip():
        return
    try:
        from .metadata import embed_lyrics

        embed_lyrics(track.path, text)
    except Exception as exc:  # tagging is best-effort, never fatal
        logger.debug("Embedding lyrics failed for %s: %s", track.path, exc)

"""Find, BY EAR, a stand-in for an unavailable track.

The reference is the only audio of a dead track left anywhere: the 30-second
preview Deezer's public API may still serve for it. No preview, no auto-match —
that track stays for a person to deal with (a decision of the user's: the audio
or nothing, no ISRC shortcut).

The candidates, cheapest first, each only after a METADATA gate (same title
once brackets and " - ..." are set aside, the same main artist, a length
within ``MAX_DURATION_DELTA``) so the ears are spent on plausible ones:

1. a file already on disk (an upload or an archived pressing): free, and it can
   never vanish again;
2. Deezer's own search, at most ``DEEZER_CANDIDATES``: first its preview
   against ours (one small MP3, and two previews of one master are usually
   cut from the same place), then — only if that was not conclusive — its whole
   audio, streamed and decrypted straight into ffmpeg, NOT archived;
3. YouTube, only when Deezer had nothing that matched, at most
   ``YOUTUBE_CANDIDATES`` downloads (into a staging directory, deleted unless
   the candidate wins — then it is archived without a second download).

The first candidate at or over ``audiomatch.THRESHOLD`` wins. The verdict is
returned, never applied here: replacing is the web layer's (it owns the
playlists' and favourites' scope and the job reporting).

Every outcome names its CAUSE (``reason``), because this runs unattended over a
whole library and "no match" for twenty different reasons is not a report.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
import unicodedata
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from deezerpy.errors import DataException, is_transport_failure

from ..db import Album, Artist, Track
from . import audiomatch

logger = logging.getLogger(__name__)

DEEZER_CANDIDATES = 3
YOUTUBE_CANDIDATES = 2
MAX_DURATION_DELTA = 20  # seconds: a version that much longer is a different cut
PREVIEW_MAX_BYTES = 4 * 1024 * 1024
STAGING_DIR = ".automatch-staging"  # a dot-directory: the local scanner skips it


@dataclass
class Candidate:
    source: str              # "local" | "deezer" | "youtube"
    id: str                  # Track.id (local), Deezer id, YouTube video id
    title: str
    artist: str
    duration: int = 0
    album: str = ""
    preview: str | None = None
    hit: dict | None = None  # the YouTube search hit
    path: str | None = None  # local file, or the YouTube download


@dataclass
class Verdict:
    status: str              # "match" | "no_reference" | "no_candidate" | "no_match" | "error"
    reason: str = ""
    best: Candidate | None = None
    score: float = 0.0
    tried: list = field(default_factory=list)  # [(candidate label, score or cause)]


# -- causes ----------------------------------------------------------------------

_URL_RE = re.compile(r"(https?)://([^/\s'\"]+)[^\s'\"]*", re.IGNORECASE)


def cause(exc, prefix: str = "") -> str:
    """An exception as a cause a report may carry: its type and message, with
    every URL cut down to its host — a Deezer stream URL carries a signed
    token, and this text ends up in a JSON report and on the admin's screen."""
    text = _URL_RE.sub(lambda m: f"{m.group(1)}://{m.group(2)}/…", str(exc))
    return (prefix + f"{type(exc).__name__}: {text}")[:200]


# -- names -------------------------------------------------------------------------

_BRACKETS_RE = re.compile(r"[\(\[][^\)\]]*[\)\]]")


def fold(text) -> str:
    s = unicodedata.normalize("NFKD", str(text or "")).lower()
    s = "".join(ch if ch.isalnum() else " " for ch in s if not unicodedata.combining(ch))
    return " ".join(s.split())


def core_title(title) -> str:
    """The title without "(Remastered 2011)", "[Live]" or " - Radio Edit"."""
    t = _BRACKETS_RE.sub(" ", str(title or ""))
    if " - " in t:
        t = t.split(" - ", 1)[0]
    return fold(t)


_CREDIT_SPLIT_RE = re.compile(r",|&|\bfeat\.?|\bft\.?|\bwith\b|\bx\b", re.IGNORECASE)


def _names(*values) -> set:
    out = set()
    for v in values:
        for part in _CREDIT_SPLIT_RE.split(str(v or "")):
            if fold(part):
                out.add(fold(part))
    return out


def plausible(track: Track, c: Candidate) -> bool:
    """The metadata gate: worth listening to at all?"""
    if not core_title(track.title) or core_title(track.title) != core_title(c.title):
        return False
    artist = fold(track.artist.name if track.artist else "")
    if not artist or artist not in _names(c.artist):
        return False
    if track.duration and c.duration and abs(track.duration - c.duration) > MAX_DURATION_DELTA:
        return False
    return True


def _rank(track: Track, cands: list) -> list:
    """Closest length first (a version of another length scores lower anyway)."""
    d0 = track.duration or 0
    return sorted(cands, key=lambda c: abs((c.duration or d0) - d0))


# -- the reference -------------------------------------------------------------------

def _preview_url_ok(url) -> bool:
    try:
        parts = urlsplit(str(url or ""))
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and (host == "dzcdn.net" or host.endswith(".dzcdn.net"))


def fetch_preview(provider, url: str, dest: str) -> None:
    """Download a Deezer preview (an MP3 on Deezer's CDN, never anywhere else)."""
    if not _preview_url_ok(url):
        raise audiomatch.MatchError("preview URL is not on Deezer's CDN")
    resp = provider.dz.api.session.get(url, stream=True)
    try:
        resp.raise_for_status()
        size = 0
        with open(dest, "wb") as fh:
            for chunk in resp.iter_content(64 * 1024):
                size += len(chunk)
                if size > PREVIEW_MAX_BYTES:
                    raise audiomatch.MatchError("preview larger than any preview")
                fh.write(chunk)
    finally:
        resp.close()


def reference_url(provider, deezer_id) -> tuple[str | None, str]:
    """``(url, reason)``: the dead track's preview, or why there is none."""
    try:
        data = provider.dz.api.get_track(deezer_id) or {}
    except DataException:
        return None, "Deezer no longer knows the track"
    except Exception as exc:
        if is_transport_failure(exc):
            raise  # not a verdict: the caller tries again later
        return None, cause(exc, "Deezer refused the lookup: ")
    url = data.get("preview") or ""
    if not url:
        return None, "Deezer serves no preview for it"
    return url, ""


# -- the candidates ------------------------------------------------------------------

def local_candidates(track: Track) -> list:
    """Rows playable from disk with the same title, never the track itself."""
    from ..utils import like_term

    like = like_term(core_title(track.title) or track.title)
    if like is None:
        return []
    rows = (
        Track.select(Track, Album, Artist)
        .join(Album).switch(Track).join(Artist)
        .where(
            Track.title.contains(like)
            & (Track.id != track.id)
            & Track.unavailable.is_null(True)
            & (
                (Track.deezer_id.is_null(True) & Track.youtube_id.is_null(True))
                | (Track.last_modification > 0)
            )
        )
        .limit(40)
    )
    out = []
    for r in rows:
        if not r.path or not os.path.isfile(r.path):
            continue
        out.append(Candidate("local", str(r.id), r.title, r.artist.name, r.duration or 0,
                             r.album.name if r.album else "", path=r.path))
    return out


def deezer_candidates(provider, track: Track) -> list:
    artist = track.artist.name if track.artist else ""
    query = f"{artist} {core_title(track.title)}".strip()
    results = provider.dz.api.search(query, limit=25) or {}
    out = []
    for raw in results.get("data", []) or []:
        sid = str(raw.get("id") or "")
        if not sid or sid == str(track.deezer_id):
            continue
        out.append(Candidate(
            "deezer", sid, str(raw.get("title") or ""),
            str((raw.get("artist") or {}).get("name") or ""),
            int(raw.get("duration") or 0),
            str((raw.get("album") or {}).get("title") or ""),
            preview=raw.get("preview") or None,
        ))
    return out


def youtube_candidates(track: Track, store=None) -> list:
    from . import youtube as yt

    artist = track.artist.name if track.artist else ""
    hits = yt.search(f"{artist} {core_title(track.title)}".strip(), yt.SEARCH_LIMIT, store)
    return [
        Candidate("youtube", h["video_id"], h["title"],
                  ", ".join(a["name"] for a in h.get("artists") or []),
                  int(h.get("duration") or 0), h.get("album") or "", hit=h)
        for h in hits
    ]


# -- the whole decision ----------------------------------------------------------------

def _label(c: Candidate) -> str:
    return f"{c.source}:{c.id}"


def decide(provider, track: Track, archive_dir: str, *, youtube_enabled=False,
           store=None, dead=frozenset()) -> Verdict:
    """Listen to the plausible candidates for ``track``; return the first match.

    ``dead``: Deezer ids already known to be unavailable (never a candidate).
    Raises nothing for a candidate that fails — that is recorded in ``tried``
    and the next one is heard — but a transport failure on the REFERENCE
    propagates: it says nothing about the track, and the run should stop
    asking Deezer.
    """
    if not track.deezer_id:
        return Verdict("no_reference", "not a Deezer track: no preview to listen to")
    url, why = reference_url(provider, track.deezer_id)
    if not url:
        return Verdict("no_reference", why)

    staging = os.path.join(archive_dir, STAGING_DIR)
    os.makedirs(staging, exist_ok=True)
    work = tempfile.mkdtemp(prefix=f"{track.deezer_id}.", dir=staging)
    verdict = Verdict("no_candidate", "nothing with the same title and artist")
    try:
        ref_path = os.path.join(work, "reference.mp3")
        try:
            fetch_preview(provider, url, ref_path)
            ref = audiomatch.decode(ref_path, seconds=120)
        except Exception as exc:
            if is_transport_failure(exc):
                raise
            return Verdict("no_reference", cause(exc, "preview unreadable: "))

        def hear(c: Candidate, samples) -> float:
            score, _, overlap = audiomatch.match(ref, samples)
            verdict.tried.append((_label(c), round(score, 4)))
            if score > verdict.score:
                verdict.score, verdict.best = score, c
            return score

        def fail(c: Candidate, exc) -> None:
            verdict.tried.append((_label(c), cause(exc)))

        # 1. On disk.
        for c in _rank(track, [c for c in local_candidates(track) if plausible(track, c)]):
            try:
                if hear(c, audiomatch.decode(c.path)) >= audiomatch.THRESHOLD:
                    return _won(verdict, c)
            except Exception as exc:
                fail(c, exc)

        # 2. Deezer.
        try:
            found = deezer_candidates(provider, track)
        except Exception as exc:
            if is_transport_failure(exc):
                raise
            found = []
            verdict.tried.append(("deezer:search", cause(exc)))
        found = [c for c in found if c.id not in dead and plausible(track, c)]
        for c in _rank(track, found)[:DEEZER_CANDIDATES]:
            try:
                if c.preview:
                    p = os.path.join(work, f"dz-{c.id}.mp3")
                    fetch_preview(provider, c.preview, p)
                    if hear(c, audiomatch.decode(p)) >= audiomatch.THRESHOLD:
                        return _won(verdict, c)
                stream_url, _fmt, _info, used = provider.resolve(c.id)
                chunks = provider.iter_decrypted(stream_url, used)
                if hear(c, audiomatch.decode(chunks=chunks)) >= audiomatch.THRESHOLD:
                    return _won(verdict, c)
            except Exception as exc:
                if is_transport_failure(exc):
                    raise
                fail(c, exc)

        # 3. YouTube, only when Deezer had nothing.
        if youtube_enabled:
            from . import youtube as yt

            try:
                yfound = [c for c in youtube_candidates(track, store) if plausible(track, c)]
            except yt.YoutubeError as exc:
                yfound = []
                verdict.tried.append(("youtube:search", cause(exc)))
            for c in _rank(track, yfound)[:YOUTUBE_CANDIDATES]:
                try:
                    c.path = yt.download_audio(c.id, tempfile.mkdtemp(dir=work))
                    if hear(c, audiomatch.decode(c.path)) >= audiomatch.THRESHOLD:
                        # Survives the cleanup below: it becomes the archive.
                        keep = os.path.join(staging, f"won-{c.id}{os.path.splitext(c.path)[1]}")
                        shutil.move(c.path, keep)
                        c.path = keep
                        return _won(verdict, c)
                except yt.YoutubeHeld as exc:
                    fail(c, exc)
                    break  # YouTube asked us to stop: we stop
                except Exception as exc:
                    fail(c, exc)

        if verdict.tried:
            verdict.status = "no_match"
            verdict.reason = (
                f"closest {verdict.score * 100:.1f} % ({_label(verdict.best)})"
                if verdict.best else "no candidate could be heard"
            )
        return verdict
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _won(v: Verdict, c: Candidate) -> Verdict:
    v.status, v.best, v.reason = "match", c, ""
    return v

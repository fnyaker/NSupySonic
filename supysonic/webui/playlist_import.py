# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Import a playlist somebody shared (Deezer, Spotify, YouTube, Apple Music).

Pasting the link reads its tracklist (``supysonic.linkimport``) and matches
every line to a sound this server can play, best source first:

1. **the library** — a file already on disk (an upload, an archived track) is
   the one answer that costs nothing and can never vanish;
2. **Deezer** — the FLAC source: its ISRC when the link gave one, else a search
   on the artist and the title. A Deezer link's own tracks ARE that answer;
3. **YouTube** — the fallback, as everywhere: a YouTube link's own video, or
   one search on YouTube Music when Deezer had nothing.

A line is only matched to something that is the same song by the replacement
sheet's own rule (``availability.match_score``: same title once versions are
set aside, same main artist, no remix/live the line did not have, the length
within 15 s), or — ``sure: false`` — to something that looks very close to it
(``closeness``, the artist credited). Anything less stays unmatched: a wrong
song in a playlist is worse than a hole.

The result is TEMPORARY: it lives in this process's memory (a job, polled) and
in the page, and plays as it is — a Deezer id or a YouTube hit plays through
``/api/stream`` like a search result. Nothing is written until the user asks
to keep it (``/save``), which makes a LOCAL playlist (not created on the Deezer
account) and queues its tracks for archiving.

All of it runs on a worker thread: one search per line is minutes for a long
playlist, and must never hold a request thread.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from flask import current_app, jsonify, request

from .. import linkimport
from ..db import Album, Artist, Playlist, Track
from ..utils import like_term
from . import (
    _db_tracks,
    _provider,
    _track_api,
    _valid_id,
    admin_required,
    login_required,
    webapi,
)
from .availability import PLAUSIBLE, _artist_names, _core_title, _fold, closeness, match_score

logger = logging.getLogger(__name__)

JOBS_MAX = 32          # jobs kept in memory (oldest finished ones go first)
JOB_TTL = 3 * 3600     # s a finished import stays listenable without saving it
RUNNING_PER_USER = 2   # imports one user may have running at once
MATCH_WORKERS = 4      # searches in flight for one import (Deezer allows ~10/s)
TITLE_MAX = 200

_jobs: "OrderedDict[str, dict]" = OrderedDict()
_lock = threading.Lock()


# -- jobs ---------------------------------------------------------------------------


def _prune(now: float) -> None:
    for jid in [j for j, job in _jobs.items() if job["state"] in _FINAL and now - job["updated"] > JOB_TTL]:
        _jobs.pop(jid, None)
    while len(_jobs) > JOBS_MAX:
        victim = next((j for j, job in _jobs.items() if job["state"] in _FINAL), None)
        if victim is None:
            break
        _jobs.pop(victim)


_FINAL = ("done", "error", "saved")
_RUNNING = ("reading", "matching", "saving")


def _job_for(job_id):
    """The caller's own job, or None (another user's job does not exist)."""
    with _lock:
        job = _jobs.get(str(job_id))
    if job is None or job["user_id"] != request.webuser.id:
        return None
    return job


def _update(job, **fields):
    with _lock:
        job.update(fields)
        job["updated"] = time.time()


def _snapshot(job) -> dict:
    """What a poll reads. The item list only once it is complete: a 1000-line
    import polled every second would otherwise re-send itself as it grows."""
    with _lock:
        out = {
            k: job[k]
            for k in (
                "id", "state", "source", "source_label", "kind", "url", "name", "cover",
                "total", "truncated", "done", "matched", "error", "playlist_id",
            )
        }
        # Not while saving either: the list does not change then, and a save of a
        # long import polled every 0.7 s re-sent and re-rendered it each time.
        if job["state"] in ("done", "saved"):
            out["items"] = list(job["items"])
        out["counts"] = dict(job["counts"])
    return out


# -- matching -----------------------------------------------------------------------


def _line_track(line):
    """A tracklist line in the shape ``match_score`` / ``closeness`` read."""
    artist = SimpleNamespace(name=line["artists"][0]) if line["artists"] else None
    return SimpleNamespace(title=line["title"], duration=line["duration"], artist=artist)


def _pick(line, candidates):
    """``(candidate, sure)`` — the safest of ``candidates`` for ``line``, or None."""
    if not candidates:
        return None
    probe = _line_track(line)
    if probe.artist is not None:
        scored = [(match_score(probe, c), i, c) for i, c in enumerate(candidates)]
        scored = [x for x in scored if x[0] is not None]
        if scored:
            scored.sort(key=lambda x: (-x[0], x[1]))
            return scored[0][2], True
        artist = _fold(probe.artist.name)
        near = [
            (closeness(probe, c), i, c)
            for i, c in enumerate(candidates)
            if artist and any(artist in n or n in artist for n in _artist_names(c))
        ]
        near = [x for x in near if x[0] >= PLAUSIBLE]
        if near:
            near.sort(key=lambda x: (-x[0], x[1]))
            return near[0][2], False
        return None
    # No artist given (a page that only listed titles): the same title and the
    # same length to 3 s, and never called sure.
    core = _fold(_core_title(line["title"]))
    for c in candidates:
        d0, d1 = line["duration"], c.get("duration") or 0
        if core and core == _fold(_core_title(c.get("title"))) and d0 and d1 and abs(d0 - d1) <= 3:
            return c, False
    return None


def _query(line) -> str:
    artist = line["artists"][0] if line["artists"] else ""
    return f"{artist} {_core_title(line['title']) or line['title']}".strip()


def _local_candidates(line, visible) -> list:
    """Library rows playable without asking anybody, with a title like the line's."""
    like = like_term(_core_title(line["title"]) or line["title"])
    if like is None:
        return []
    q = (
        Track.select(Track, Album, Artist)
        .join(Album)
        .switch(Track)
        .join(Artist)
        .where(
            Track.title.contains(like)
            & (
                (Track.deezer_id.is_null(True) & Track.youtube_id.is_null(True))
                | (Track.last_modification > 0)
            )
            & Track.unavailable.is_null(True)
        )
    )
    if visible is not None:
        q = q.where(visible)
    return _db_tracks(q.order_by(Track.title).limit(25))


class _Matcher:
    """The network half of matching, shared by an import's worker threads."""

    def __init__(self, api, yt_on, store, dead):
        self.api = api
        self.yt_on = yt_on
        self.store = store
        self.dead = dead
        self.deezer_down = False
        self.yt_down = False

    def deezer(self, line):
        if self.api is None or self.deezer_down:
            return None
        from deezerpy.errors import is_transport_failure

        if line.get("isrc"):
            # Its own try: Deezer not knowing an ISRC is an error answer (800),
            # and it must leave the title search to be tried, not skip it.
            try:
                raw = self.api.get_track_by_ISRC(line["isrc"])
            except Exception as exc:
                if is_transport_failure(exc):
                    self.deezer_down = True
                    logger.info("Import: Deezer unreachable for %r", line["title"], exc_info=True)
                    return None
                raw = None
            cand = _track_api(raw) if isinstance(raw, dict) else None
            # An ISRC names one recording; the title is only checked loosely
            # (a store may spell it its own way).
            if cand and cand["deezer_id"] not in self.dead and closeness(_line_track(line), cand) >= 0.6:
                return cand, True
        try:
            seen, found = set(), None
            for query in (_query(line), _core_title(line["title"])):
                if not query or query in seen:
                    continue
                seen.add(query)
                res = self.api.search(query, limit=15) or {}
                cands = [c for c in (_track_api(r) for r in res.get("data") or []) if c]
                cands = [c for c in cands if c["deezer_id"] not in self.dead]
                found = _pick(line, cands)
                if found:
                    return found
        except Exception as exc:
            if is_transport_failure(exc):
                self.deezer_down = True  # stop paying the timeout on every line
            logger.info("Import: Deezer search failed for %r", line["title"], exc_info=True)
        return None

    def youtube(self, line):
        from ..deezer import youtube as yt
        from .youtube import hit_track

        own = line.get("yt")
        if own is not None:
            # A YouTube link's own video: kept as the fallback, no request.
            yt.remember(own, self.store)
            return hit_track(own), True
        if not self.yt_on or self.yt_down:
            return None
        try:
            hits = yt.search(_query(line), store=self.store)
        except yt.YoutubeError:
            self.yt_down = True  # held or unreachable: leave it alone for this import
            return None
        return _pick(line, [hit_track(h) for h in hits])

    def network(self, line):
        """``(track, via, sure)`` for a line the library did not have."""
        raw = line.get("raw")
        if raw is not None:  # a Deezer link: the line IS a Deezer track
            cand = _track_api(raw)
            if cand and cand["deezer_id"] not in self.dead:
                return cand, "deezer", True
        got = self.deezer(line)
        if got:
            return got[0], "deezer", got[1]
        got = self.youtube(line)
        if got:
            return got[0], "youtube", got[1]
        return None, None, False


def _public_line(line) -> dict:
    return {k: line[k] for k in ("title", "artists", "album", "duration")}


def _run_import(app, job, link, user_id, admin):
    from ..db import close_connection, open_connection

    try:
        with app.app_context():
            open_connection(reuse=True)
            try:
                _do_import(app, job, link, user_id, admin)
            finally:
                close_connection()
    except linkimport.LinkError as exc:
        _update(job, state="error", error=str(exc))
    except Exception as exc:
        logger.warning("Playlist import failed for %s", job.get("url"), exc_info=True)
        _update(job, state="error", error=f"L'import a échoué ({type(exc).__name__})")


def _session():
    from deezerpy import _Session

    return _Session()


def _do_import(app, job, link, user_id, admin):
    from . import youtube as ytweb

    provider = getattr(app, "deezer", None)
    api = None
    if provider is not None and (getattr(provider, "available", None) is None or provider.available()):
        try:
            api = provider.dz.api
        except Exception:
            logger.info("Import: Deezer client unavailable", exc_info=True)

    session = _session()
    try:
        if link["kind"] == "short":
            link = linkimport.resolve_short(session, link)
        source = link["source"]
        if source == "deezer":
            if api is None:
                raise linkimport.LinkError(
                    "Deezer est injoignable" if provider is not None else "Deezer n'est pas configuré sur ce serveur"
                )
            playlist = linkimport.read_deezer(api, link)
        elif source == "spotify":
            playlist = linkimport.read_spotify(session, link)
        elif source == "apple":
            playlist = linkimport.read_apple(session, link)
        else:
            if not ytweb.enabled():
                raise linkimport.LinkError("YouTube est désactivé sur ce serveur")
            playlist = linkimport.read_youtube(link)
    finally:
        session.close()

    lines = playlist["tracks"]
    if not lines:
        raise linkimport.LinkError("Cette playlist est vide")
    _update(
        job,
        state="matching",
        kind=link["kind"],
        name=playlist["name"],
        cover=playlist["cover"],
        total=len(lines),
        truncated=playlist["truncated"],
    )

    visible = None if admin else (Track.owner.is_null(True) | (Track.owner == user_id))
    results = [None] * len(lines)
    rest = []
    for i, line in enumerate(lines):
        got = _pick(line, _local_candidates(line, visible))
        if got:
            results[i] = (got[0], "local", got[1])
            _progress(job, "local")
        else:
            rest.append(i)

    dead = {
        str(d)
        for (d,) in Track.select(Track.deezer_id)
        .where(Track.unavailable.is_null(False) & Track.deezer_id.is_null(False))
        .tuples()
    }
    matcher = _Matcher(api, ytweb.enabled(), getattr(app, "cache", None), dead)

    def one(i):
        try:
            got = matcher.network(lines[i])
        except Exception:
            logger.info("Import: matching failed for %r", lines[i]["title"], exc_info=True)
            got = (None, None, False)
        results[i] = got
        _progress(job, got[1])

    if rest:
        with ThreadPoolExecutor(MATCH_WORKERS, thread_name_prefix="playlist-import") as pool:
            list(pool.map(one, rest))

    items = []
    for i, line in enumerate(lines):
        track, via, sure = results[i] or (None, None, False)
        items.append({"line": _public_line(line), "track": track, "via": via, "sure": bool(sure)})
    notes = []
    if matcher.deezer_down:
        notes.append("Deezer ne répondait pas : certains titres n'ont pas pu être cherchés")
    _update(job, state="done", items=items, error=" · ".join(notes) or None)


def _progress(job, via):
    with _lock:
        job["done"] += 1
        if via:
            job["matched"] += 1
            job["counts"][via] = job["counts"].get(via, 0) + 1
        job["updated"] = time.time()


# -- saving -------------------------------------------------------------------------


def _rows_for(provider, ids, user_id, admin) -> list:
    """Track rows for the kept items, in order. Same rules as adding to a
    playlist: a UUID is a library row (someone else's upload is refused) or a
    remembered YouTube hit, a number a Deezer track whose row is made now."""
    from ..deezer import archive, library
    from . import _ensure_track_row
    from . import youtube as ytweb

    root, cache, out = None, library.ImportCache(), []
    for sid in ids:
        sid = str(sid)
        try:
            tid = uuid.UUID(sid)
        except ValueError:
            tid = None
        if tid is not None:
            row = Track.get_or_none(Track.id == tid)
            if row is None:
                row = ytweb.materialize(sid)
            elif row.owner_id is not None and not admin and row.owner_id != user_id:
                row = None
            if row is not None:
                out.append(row)
            continue
        if not _valid_id(sid):
            continue
        row = archive.find_local_track(sid)
        if row is None and provider is not None:
            try:
                if root is None:
                    root = library.get_root_folder(provider.archive_dir)
                row = _ensure_track_row(provider, sid, root, cache)
            except Exception:
                logger.warning("Import: could not create the row for Deezer %s", sid, exc_info=True)
        if row is not None:
            out.append(row)
    return out


def _run_save(app, job, ids, title, user_id, admin):
    from ..db import User, close_connection, open_connection
    from ..deezer import backfill

    try:
        with app.app_context():
            open_connection(reuse=True)
            try:
                rows = _rows_for(getattr(app, "deezer", None), ids, user_id, admin)
                if not rows:
                    raise RuntimeError("no playable track")
                pl = Playlist.create(user=User[user_id], name=title, comment=_comment(job))
                for row in rows:
                    pl.add(row)
                try:
                    backfill.archive_tracks(app, rows, event="on_playlist_add")
                except Exception:
                    logger.info("Import: archiving the saved playlist failed", exc_info=True)
                _update(job, state="saved", playlist_id=str(pl.id), saved=len(rows))
            finally:
                close_connection()
    except Exception as exc:
        logger.warning("Saving imported playlist failed", exc_info=True)
        _update(job, state="done", error=f"L'enregistrement a échoué ({type(exc).__name__})")


def _comment(job) -> str:
    return f"Importée depuis {job['source_label']}"[:255]


# -- routes -------------------------------------------------------------------------


def _start(target, args, name):
    worker = threading.Thread(target=target, args=args, name=name, daemon=True)
    worker.start()
    if args[0].testing:
        worker.join()  # tests read the outcome straight after the request


@webapi.route("/import/playlist", methods=["POST"])
@login_required
def import_playlist_start():
    """Start reading + matching a shared link. ``{url}`` → ``{id}`` (a job)."""
    data = request.get_json(silent=True) or {}
    text = data.get("url")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "missing url"}), 400
    link = linkimport.parse(text)
    if link is None:
        return jsonify(
            {"error": "Lien non reconnu : colle le lien d'une playlist Deezer, Spotify, YouTube ou Apple Music"}
        ), 400
    if link["source"] == "deezer" and _provider() is None:
        return jsonify({"error": "Deezer n'est pas configuré sur ce serveur"}), 400

    user = request.webuser
    now = time.time()
    with _lock:
        _prune(now)
        running = sum(1 for j in _jobs.values() if j["user_id"] == user.id and j["state"] in _RUNNING)
        if running >= RUNNING_PER_USER:
            return jsonify({"error": "Un import est déjà en cours, attends qu'il finisse"}), 429
        jid = secrets.token_urlsafe(12)
        job = {
            "id": jid,
            "user_id": user.id,
            "state": "reading",
            "source": link["source"],
            "source_label": linkimport.LABELS[link["source"]],
            "kind": link["kind"],
            "url": linkimport.find_url(text),
            "name": None,
            "cover": None,
            "total": 0,
            "truncated": False,
            "done": 0,
            "matched": 0,
            "counts": {},
            "items": [],
            "error": None,
            "playlist_id": None,
            "created": now,
            "updated": now,
        }
        _jobs[jid] = job
    app = current_app._get_current_object()
    args = (app, job, link, user.id, bool(user.admin))
    _start(_run_import, args, "playlist-import")
    return jsonify({"id": jid})


@webapi.route("/import/playlist/<job_id>")
@login_required
def import_playlist_status(job_id):
    job = _job_for(job_id)
    if job is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(_snapshot(job))


@webapi.route("/import/playlist/<job_id>/save", methods=["POST"])
@login_required
@admin_required
def import_playlist_save(job_id):
    """Keep an import as a local playlist. ``{title?, keep?: [item index]}``
    (every matched line when ``keep`` is absent)."""
    job = _job_for(job_id)
    if job is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(silent=True) or {}
    with _lock:
        if job["state"] != "done":
            return jsonify({"error": "not ready", "state": job["state"]}), 409
        items = job["items"]
        keep = data.get("keep")
        if keep is None:
            picked = [it for it in items if it["track"]]
        elif isinstance(keep, list):
            idx = []
            for k in keep[: len(items)]:
                if isinstance(k, int) and not isinstance(k, bool) and 0 <= k < len(items) and k not in idx:
                    idx.append(k)
            picked = [items[k] for k in idx if items[k]["track"]]
        else:
            return jsonify({"error": "bad keep"}), 400
        if not picked:
            return jsonify({"error": "Aucun titre à enregistrer"}), 400
        title = data.get("title")
        title = " ".join(title.split())[:TITLE_MAX] if isinstance(title, str) else ""
        title = title or (job["name"] or "Playlist importée")[:TITLE_MAX]
        ids = [it["track"]["deezer_id"] for it in picked]
        job["state"] = "saving"
        job["error"] = None
        job["updated"] = time.time()
    user = request.webuser
    app = current_app._get_current_object()
    args = (app, job, ids, title, user.id, bool(user.admin))
    _start(_run_save, args, "playlist-import-save")
    return jsonify({"ok": True})

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Unavailable tracks, and replacing them.

A Deezer track can stop being playable at any time — rights pulled, delisted,
geo-blocked — and there is nothing the server can do about it. What it *can* do
is (1) know it, definitively and quickly, so the player moves on instead of
retrying a corpse, and (2) let you put something else in its place everywhere it
appears, without hunting through every playlist by hand.

The verdict lives on ``Track.unavailable`` as a timestamp, not a flag: rights
come back, so an old verdict is re-tested rather than condemning the track for
good.
"""

from __future__ import annotations

import logging
import re
import threading
import uuid as uuidlib
from datetime import timedelta

from flask import current_app, jsonify, request

from ..db import (
    Album,
    Artist,
    Playlist,
    PlaylistTrack,
    StarredTrack,
    Track,
    db,
    now,
)
from ..deezer.provider import DeezerError, TrackUnavailable
from . import (
    _CDN,
    _is_admin,
    _local_search_tracks,
    _local_track,
    _may_access_track,
    _need_provider,
    _provider,
    _track_api,
    _valid_id,
    _visible_tracks,
    login_required,
    webapi,
)

logger = logging.getLogger(__name__)

# How long an "unavailable" verdict stands before the next probe re-tests it.
# Long enough that a dead track stays out of the way, short enough that a track
# whose rights came back isn't stuck behind a stale verdict.
VERDICT_TTL = timedelta(days=7)


# The primitives live in the DB layer (deezer/library.py), because every path
# that discovers the answer records it — the live stream, the background
# archiver, the download queue, the CLI — and none of them may depend on the web
# layer. Re-exported here so the endpoints below read naturally.
from ..deezer.library import (  # noqa: E402  isort:skip
    clear_unavailable,
    mark_unavailable,
)


def is_stale(track) -> bool:
    """Whether a recorded verdict is old enough to be worth re-testing."""
    stamp = getattr(track, "unavailable", None)
    return stamp is not None and (now() - stamp) > VERDICT_TTL


def _resolve_local(track_id):
    """A Track row from a universal id (numeric Deezer id or a local UUID)."""
    from ..deezer import archive

    if _valid_id(track_id):
        return archive.find_local_track(track_id)
    try:
        row = Track.get_or_none(Track.id == uuidlib.UUID(str(track_id)))
    except (ValueError, AttributeError):
        return None
    if row is None:
        # A YouTube search hit, offered as a replacement: made from the hit.
        from .youtube import materialize

        row = materialize(track_id)
    return row


@webapi.route("/track/<track_id>/probe")
@login_required
def probe_track(track_id):
    """Is this track actually playable, right now?

    The web player asks the moment playback errors out. The `<audio>` element
    only ever reports "it broke" — it cannot tell a dead track from a dropped
    packet — so this endpoint answers the question the element can't, and the
    player stops burning its retry budget on tracks that will never play.

    Cheap by design: a recorded verdict answers immediately, and only a stale (or
    absent) one costs a Deezer round-trip.
    """
    track = _resolve_local(track_id)
    if track is not None and not _may_access_track(track):
        return jsonify({"error": "not found"}), 404

    # A YouTube fallback track: on disk, or not yet fetched. Never asks YouTube
    # here — the stream itself is the one request it gets, and a verdict comes
    # only from YouTube answering that the video is gone.
    if track is not None and track.youtube_id and not track.deezer_id:
        import os.path

        if os.path.isfile(track.path):
            clear_unavailable(track)
            # What the file really holds: the player shows it when the quality
            # asked for is more than YouTube had (FLAC, Opus 320...).
            return jsonify(
                {"available": True, "reason": None, "bitrate": int(track.bitrate or 0)}
            )
        if track.unavailable is not None and not is_stale(track):
            return jsonify({"available": False, "reason": "unavailable"})
        return jsonify({"available": True, "reason": "unknown"})

    # A local file: available iff it is on disk. No Deezer involved.
    if track is not None and not track.deezer_id:
        import os.path

        ok = bool(track.path and os.path.isfile(track.path))
        if ok:
            clear_unavailable(track)
        else:
            mark_unavailable(track)
        return jsonify({"available": ok, "reason": None if ok else "missing file"})

    # Already archived means already playable, whatever Deezer thinks today.
    if track is not None and track.path:
        import os.path

        if os.path.isfile(track.path):
            clear_unavailable(track)
            return jsonify({"available": True, "reason": None})

    if track is not None and track.unavailable is not None and not is_stale(track):
        return jsonify({"available": False, "reason": "unavailable"})

    if not _valid_id(track_id):
        return jsonify({"available": False, "reason": "unknown track"})

    provider, err = _need_provider()
    if err:
        # No Deezer configured: we genuinely cannot tell. Saying "unavailable"
        # here would condemn every track on a proxy that is merely switched off.
        return jsonify({"available": True, "reason": "unknown"})
    try:
        provider.resolve(track_id)
    except TrackUnavailable:
        mark_unavailable(track)
        return jsonify({"available": False, "reason": "unavailable"})
    except (DeezerError, Exception):
        # Network, session, gateway: says nothing about the track. Treated as
        # available so the player keeps its normal retry behaviour.
        logger.debug("Probe of %s was inconclusive", track_id, exc_info=True)
        return jsonify({"available": True, "reason": "unknown"})
    clear_unavailable(track)
    return jsonify({"available": True, "reason": None})


@webapi.route("/unavailable")
@login_required
def unavailable_tracks():
    """Every track we know to be unplayable, newest verdict first.

    This is what the library's "Titres indisponibles" section lists, so each one
    can be replaced.
    """
    rows = (
        _visible_tracks(
            Track.select(Track, Album, Artist)
            .join(Album)
            .switch(Track)
            .join(Artist)
            .where(Track.unavailable.is_null(False))
        )
        .order_by(Track.unavailable.desc())
        .limit(500)
    )
    return jsonify({"tracks": [_unavailable_entry(t) for t in rows]})


def _unavailable_entry(t: Track) -> dict:
    """A track payload for the replacement UI, plus where it is still used."""
    out = _local_track(t) if not t.deezer_id else _archived_track_api(t)
    out["unavailable"] = True
    out["playlists"] = [
        {"id": str(p.id), "title": p.name}
        for p in (
            Playlist.select()
            .join(PlaylistTrack, on=(PlaylistTrack.playlist == Playlist.id))
            .where(PlaylistTrack.track == t.id)
            .distinct()
        )
    ]
    return out


def _archived_track_api(t: Track) -> dict:
    """Serialize a Deezer-backed Track ROW (not a live Deezer payload)."""
    cover = (
        _CDN.format(kind="cover", md5=t.album.cover_md5, w=500)
        if getattr(t.album, "cover_md5", None)
        else "/api/cover/" + str(t.deezer_id)
    )
    return {
        "deezer_id": str(t.deezer_id),
        "title": t.title,
        "duration": t.duration or 0,
        "explicit": False,
        "gain": t.gain,
        "artist": {"deezer_id": t.artist.deezer_id, "name": t.artist.name},
        "artists": [
            {
                "deezer_id": t.artist.deezer_id,
                "name": t.artist.name,
                "role": "Main",
            }
        ],
        "display_artist": t.artist.name,
        "album": {
            "deezer_id": t.album.deezer_id,
            "title": t.album.name,
            "cover": cover,
        },
    }


def _fold(text) -> str:
    """Case, accents and punctuation dropped: "Beyoncé - Halo!" → "beyonce halo"."""
    import unicodedata

    s = unicodedata.normalize("NFKD", str(text or "")).lower()
    s = "".join(ch if ch.isalnum() else " " for ch in s if not unicodedata.combining(ch))
    return " ".join(s.split())


_BRACKETS_RE = re.compile(r"[\(\[][^\)\]]*[\)\]]")
# A word that makes a recording a DIFFERENT recording of the song. A swap to one
# of those is a decision for somebody who listened, not a one-click default.
_VERSION_WORDS = frozenset(
    "remix live edit acoustic instrumental karaoke cover demo rework bootleg "
    "vip extended club dub sped slowed nightcore reprise orchestral unplugged "
    "cappella acapella".split()
)


def _title_parts(title):
    """``(core, version words)`` of a title."""
    raw = str(title or "")
    extras = " ".join(_BRACKETS_RE.findall(raw))
    core = _BRACKETS_RE.sub(" ", raw)
    if " - " in core:
        core, tail = core.split(" - ", 1)
        extras += " " + tail
    words = set(_fold(extras).split())
    # "Remastered", "Radio", "Album version"… name a pressing, not another
    # recording: only the words above count.
    versions = words & _VERSION_WORDS
    return _fold(core), versions


_CREDIT_SPLIT_RE = re.compile(r",|&|\bfeat\.?|\bft\.?|\bwith\b|\bx\b", re.IGNORECASE)


def _artist_names(c) -> set:
    """Every credited name of a candidate, one by one, folded."""
    names = {_fold(a.get("name")) for a in (c.get("artists") or []) if isinstance(a, dict)}
    if isinstance(c.get("artist"), dict):
        names.add(_fold(c["artist"].get("name")))
    for part in _CREDIT_SPLIT_RE.split(str(c.get("display_artist") or "")):
        names.add(_fold(part))
    names.discard("")
    return names


def match_score(track, c):
    """How safely ``c`` stands in for ``track``; None when it must not be offered.

    Required: the same title once versions are set aside, the same main artist,
    no version marker the dead track did not have, and a length within 15 s
    when both are known. Then closer is better, and a file on disk (which can
    never vanish again) wins a tie. A YouTube hit is judged the same way; the
    route only asks YouTube when nothing from Deezer or the disk is safe.
    """
    core, versions = _title_parts(track.title)
    c_core, c_versions = _title_parts(c.get("title"))
    if not core or core != c_core or c_versions - versions:
        return None
    artist = _fold(track.artist.name if track.artist else "")
    if not artist or artist not in _artist_names(c):
        return None  # another artist's take is a cover: not a one-click swap
    score = 10.0
    if versions == c_versions:
        score += 2
    if _fold(c.get("title")) == _fold(track.title):
        score += 1
    d0, d1 = track.duration or 0, c.get("duration") or 0
    if d0 and d1:
        delta = abs(d0 - d1)
        if delta > 15:
            return None
        score += 3 - delta / 5
    if c.get("local"):
        score += 0.5
    return score


YOUTUBE_SHOWN = 5
QUERY_MAX = 200


def _core_title(title) -> str:
    """The title without "(Remastered 2011)", "[Live]", " - Radio Edit" (unfolded)."""
    t = _BRACKETS_RE.sub(" ", str(title or ""))
    if " - " in t:
        t = t.split(" - ", 1)[0]
    return " ".join(t.split())


def closeness(track, c) -> float:
    """0..1: how close a candidate LOOKS to the dead track, to rank a search.

    Softer than ``match_score`` on purpose — it orders what a person will
    look at, it does not decide anything: the title's resemblance (the most
    of it), the artist, then the length.
    """
    from difflib import SequenceMatcher

    a, b = _fold(_core_title(track.title)), _fold(_core_title(c.get("title")))
    title = SequenceMatcher(None, a, b).ratio() if a and b else 0.0
    artist = _fold(track.artist.name if track.artist else "")
    credited = 1.0 if artist and artist in _artist_names(c) else 0.0
    d0, d1 = track.duration or 0, c.get("duration") or 0
    length = max(0.0, 1.0 - abs(d0 - d1) / 60.0) if d0 and d1 else 0.5
    return 0.6 * title + 0.3 * credited + 0.1 * length


def _youtube_closest(track, query, seen, n=YOUTUBE_SHOWN) -> list:
    """YouTube's songs for ``query``, the ``n`` closest to the dead track."""
    from .youtube import search_tracks

    hits = [t for t in search_tracks(query) if t["deezer_id"] not in seen and not t.get("unavailable")]
    hits.sort(key=lambda t: -closeness(track, t))
    return hits[:n]


@webapi.route("/replace/candidates/<track_id>")
@login_required
def replacement_candidates(track_id):
    """Plausible stand-ins for a dead track: same title, same artist, first.

    Local files come first — they are on disk, so they can never go away again —
    then Deezer's own results, with the dead track and anything else we already
    know to be unavailable filtered out. ``q`` replaces the query (the sheet's
    search box). YouTube is asked when the sheet asks for it (``youtube=1``)
    AND, without being asked, when Deezer found nothing: the fallback a person
    would have reached for next. Its five closest songs, never more.
    """
    track = _resolve_local(track_id)
    if track is None:
        return jsonify({"error": "not found"}), 404
    if not _may_access_track(track):
        return jsonify({"error": "not found"}), 404

    manual = " ".join(str(request.args.get("q") or "").split())[:QUERY_MAX]
    # Brackets and " - Remastered" are what a pressing calls itself, not what
    # the song is called: searching without them finds the other pressings.
    query = manual or f"{track.artist.name} {_core_title(track.title)}".strip()
    out = []
    seen = {str(track_id)}

    for t in _local_search_tracks(query, 10):
        if t["deezer_id"] in seen:
            continue
        seen.add(t["deezer_id"])
        out.append(t)
    if not manual:
        # "<artist> <title>" is one LIKE against each field, so it never finds
        # the file you already have of the same song. Its title does — kept
        # only when the artist is the same, or every "Intro" would come first.
        artist = _fold(track.artist.name if track.artist else "")
        for t in _local_search_tracks(_core_title(track.title) or track.title, 25):
            if t["deezer_id"] in seen or not artist or artist not in _artist_names(t):
                continue
            seen.add(t["deezer_id"])
            out.append(t)

    provider = _provider()
    if provider is not None:
        try:
            results = provider.dz.api.search(query, limit=25) or {}
            for raw in results.get("data", []) or []:
                item = _track_api(raw)
                if not item or item["deezer_id"] in seen:
                    continue
                seen.add(item["deezer_id"])
                out.append(item)
        except Exception:
            logger.info("Candidate search failed for %s", track_id, exc_info=True)

    # Drop the ones already known to be dead — offering a replacement that is
    # itself unplayable is worse than offering nothing.
    dead = {
        str(t.deezer_id)
        for t in Track.select(Track.deezer_id).where(
            Track.unavailable.is_null(False) & Track.deezer_id.is_null(False)
        )
    }
    out = [t for t in out if t["deezer_id"] not in dead][:30]

    # `best=N`: only the matches safe enough to offer as a ONE-CLICK swap (the
    # library list shows them inline) — same song, same artist, same version,
    # about the same length — best first. YouTube only when nothing from Deezer
    # or the disk is safe: it is the fallback, here as everywhere.
    best = request.args.get("best")
    if best:
        try:
            n = max(1, min(int(best), 5))
        except ValueError:
            n = 2

        def safest(cands):
            scored = [(match_score(track, c), i, c) for i, c in enumerate(cands)]
            scored = [x for x in scored if x[0] is not None]
            scored.sort(key=lambda x: (-x[0], x[1]))
            return [c for _, _, c in scored[:n]]

        picked = safest(out)
        youtube = False
        if not picked:
            picked = safest(_youtube_closest(track, query, seen, n=25))
            youtube = bool(picked)
        return jsonify({"query": query, "candidates": picked, "youtube": youtube})

    asked = request.args.get("youtube") in ("1", "true")
    youtube = False
    if asked or not out:
        extra = _youtube_closest(track, query, seen)
        youtube = not asked and bool(extra)  # reached for on its own
        out += extra
    return jsonify({"query": query, "candidates": out, "youtube_auto": youtube})


# -- replacement ------------------------------------------------------------
# Swapping a track everywhere it appears touches playlists (position by
# position) and favorites, and — for the admin's Deezer-backed playlists — has
# to be mirrored to Deezer as well. The Deezer half is slow and flaky, so the
# whole thing runs in a worker thread and the UI polls the job.

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
# Keep the job table from growing without bound over a long uptime.
_JOBS_MAX = 40


def _new_job(kind: str) -> str:
    job_id = uuidlib.uuid4().hex
    with _jobs_lock:
        if len(_jobs) >= _JOBS_MAX:
            for stale in sorted(_jobs, key=lambda k: _jobs[k]["started"])[:10]:
                _jobs.pop(stale, None)
        _jobs[job_id] = {
            "kind": kind,
            "started": now().isoformat(),
            "running": True,
            "ok": None,
            "playlists": 0,
            "favorites": 0,
            "error": None,
        }
    return job_id


def _finish_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job.update(fields)
        job["running"] = False


@webapi.route("/replace/status/<job_id>")
@login_required
def replace_status(job_id):
    with _jobs_lock:
        job = _jobs.get(str(job_id))
        # A snapshot: a bulk job's lists are appended to by its worker.
        if job is not None:
            job = {k: list(v) if isinstance(v, list) else v for k, v in job.items()}
    if job is None:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)


@webapi.route("/replace", methods=["POST"])
@login_required
def replace_track():
    """Replace every occurrence of one track by another.

    ``from`` and ``to`` are universal ids (a numeric Deezer id, or a UUID for a
    local file). The Deezer target is imported first — a replacement you cannot
    play would be no replacement at all.
    """
    data = request.get_json(silent=True) or {}
    src_id = str(data.get("from") or "")
    dst_id = str(data.get("to") or "")
    if not src_id or not dst_id or src_id == dst_id:
        return jsonify({"error": "invalid ids"}), 400

    source = _resolve_local(src_id)
    if source is None or not _may_access_track(source):
        return jsonify({"error": "unknown track"}), 404

    target = _resolve_local(dst_id)
    if target is None:
        # A Deezer track we've never imported: materialize the row now.
        if not _valid_id(dst_id):
            return jsonify({"error": "unknown replacement"}), 404
        provider, err = _need_provider()
        if err:
            return err
        from ..deezer import archive

        try:
            target = archive.import_track(provider, dst_id)
        except Exception:
            logger.warning("Import of replacement %s failed", dst_id, exc_info=True)
            return jsonify({"error": "replacement unavailable"}), 502
    if not _may_access_track(target):
        return jsonify({"error": "unknown replacement"}), 404
    if target.id == source.id:
        return jsonify({"error": "invalid ids"}), 400

    job_id = _new_job("replace")
    app = current_app._get_current_object()
    user_id = request.webuser.id
    admin = _is_admin()
    threading.Thread(
        target=_run_replace,
        args=(app, job_id, source.id, target.id, user_id, admin),
        name="track-replace",
        daemon=True,
    ).start()
    return jsonify({"ok": True, "job": job_id})


def replace_everywhere(app, source, target, user_id, admin):
    """Put ``target`` wherever ``source`` is; ``(playlists, favorites)`` touched.

    Only playlists the caller may edit (their own; every one for an admin) and
    their favourites (everyone's for an admin). Mirrored to Deezer for the
    admin, fail-soft; the source row is retired when nothing uses it any more.
    Shared by a person's replacement and the auto-match.
    """
    rows = (
        PlaylistTrack.select(PlaylistTrack, Playlist)
        .join(Playlist, on=(PlaylistTrack.playlist == Playlist.id))
        .where(PlaylistTrack.track == source.id)
    )
    if not admin:
        rows = rows.where(Playlist.user == user_id)

    touched = set()
    favorites = 0
    with db.atomic():
        for row in rows:
            # In place, at the same position: a replacement must not
            # reshuffle the playlist it repairs.
            PlaylistTrack.update(track=target.id).where(
                (PlaylistTrack.playlist == row.playlist_id)
                & (PlaylistTrack.track == source.id)
            ).execute()
            touched.add(row.playlist_id)

        # Favorites: whoever starred the dead track gets the new one.
        starred = StarredTrack.select().where(StarredTrack.starred == source.id)
        if not admin:
            starred = starred.where(StarredTrack.user == user_id)
        for star in starred:
            exists = StarredTrack.get_or_none(
                (StarredTrack.user == star.user_id)
                & (StarredTrack.starred == target.id)
            )
            if exists is None:
                StarredTrack.create(user=star.user_id, starred=target.id)
            star.delete_instance()
            favorites += 1

    _mirror_to_deezer(app, source, target, touched, admin)
    _retire_replaced(source)
    return len(touched), favorites


def _run_replace(app, job_id, source_id, target_id, user_id, admin):
    """Worker: rewrite playlists and favorites, then mirror to Deezer."""
    from ..db import close_connection, open_connection

    playlists = favorites = 0
    try:
        with app.app_context():
            open_connection(reuse=True)
            source = Track.get_or_none(Track.id == source_id)
            target = Track.get_or_none(Track.id == target_id)
            if source is None or target is None:
                _finish_job(job_id, ok=False, error="track vanished")
                return
            playlists, favorites = replace_everywhere(app, source, target, user_id, admin)
            _finish_job(job_id, ok=True, playlists=playlists, favorites=favorites)
    except Exception as exc:
        logger.warning("Replacing %s failed", source_id, exc_info=True)
        _finish_job(job_id, ok=False, error=str(exc), playlists=playlists,
                    favorites=favorites)
    finally:
        try:
            close_connection()
        except Exception:
            pass


# -- deletion ---------------------------------------------------------------
# The third answer, next to "replace it" and "give it a file of mine": drop it.
#
# What makes this safe is the DEFINITION of unavailable. It does not mean "Deezer
# no longer has it" — an archived track plays forever whatever Deezer does. It
# means neither source is left: no file on disk AND no Deezer source. Both are
# re-checked here, at the moment of deletion, because the stored verdict is a
# cache and this is not an operation you get to take back.


def verify_gone(track, track_id):
    """``(gone, reason)`` — is this track really beyond reach, right now?

    Returns ``gone=False`` for anything we cannot prove: an inconclusive network
    answer must never authorise a deletion, exactly as it never authorises an
    "unavailable" verdict.
    """
    import os.path

    if track is not None and track.path and os.path.isfile(track.path):
        # Archived. This is the whole point of archiving — it plays forever.
        clear_unavailable(track)
        return False, "archived"

    if track is not None and track.youtube_id and not track.deezer_id:
        # Not archived: gone only if YouTube itself said so (the verdict is
        # set by nothing else). Asking again here would be a YouTube call for
        # a button press, and "it did not answer" never authorises a deletion.
        if track.unavailable is not None:
            return True, "unavailable"
        return False, "inconclusive"

    if track is not None and not track.deezer_id:
        # A local upload with no file left. Nothing can bring it back, and
        # nothing else in the world has a copy: it is genuinely gone.
        return True, "missing file"

    if not _valid_id(track_id):
        return False, "unknown track"

    provider, err = _need_provider()
    if err:
        # Deezer is off. It may well still have the track — refusing here is the
        # difference between a cleanup and a data loss.
        return False, "no provider"
    try:
        provider.resolve(track_id)
    except TrackUnavailable:
        return True, "unavailable"
    except Exception:
        logger.info("Delete check for %s was inconclusive", track_id, exc_info=True)
        return False, "inconclusive"
    clear_unavailable(track)
    return False, "playable"


@webapi.route("/track/<track_id>", methods=["DELETE"])
@login_required
def delete_track(track_id):
    """Remove a track that no longer exists anywhere.

    Scoped like a replacement: anyone clears it out of their own playlists and
    favourites; an admin, who owns the shared library, also drops the row — and
    the row is what makes it show up in searches and in everyone else's lists.

    Refuses unless the track is verifiably gone from BOTH sources.
    """
    track = _resolve_local(track_id)
    if track is None:
        return jsonify({"error": "not found"}), 404
    if not _may_access_track(track):
        return jsonify({"error": "not found"}), 404

    gone, reason = verify_gone(track, track_id)
    if not gone:
        # 409, not 400: the request was fine, the world disagreed with it.
        return jsonify({"error": "track is available", "reason": reason}), 409

    job_id = _new_job("delete")
    app = current_app._get_current_object()
    threading.Thread(
        target=_run_delete,
        args=(app, job_id, track.id, request.webuser.id, _is_admin()),
        name="track-delete",
        daemon=True,
    ).start()
    return jsonify({"ok": True, "job": job_id, "reason": reason})


def _remove_everywhere(app, track, user_id, admin):
    """Unpick ``track`` from the caller's lists, drop the row (admin), mirror.

    Returns ``(playlists, favorites)`` touched. Shared by the single and the
    bulk deletion: the scope rules are the same for one track or two hundred.
    """
    deezer_id = track.deezer_id

    rows = (
        PlaylistTrack.select(PlaylistTrack, Playlist)
        .join(Playlist, on=(PlaylistTrack.playlist == Playlist.id))
        .where(PlaylistTrack.track == track.id)
    )
    if not admin:
        rows = rows.where(Playlist.user == user_id)
    touched = {row.playlist_id for row in rows}
    # Collected BEFORE the row goes: once the track is deleted the
    # PlaylistTrack links are gone and there is nothing left to mirror.
    mirrored = [
        pl.deezer_id
        for pl in Playlist.select().where(Playlist.id.in_(list(touched)))
        if pl.deezer_id
    ] if touched else []

    with db.atomic():
        for pid in touched:
            pl = Playlist.get_or_none(Playlist.id == pid)
            if pl is None:
                continue
            # Through the model, not a raw delete: the playlist keeps a
            # contiguous index, which every ordering read depends on.
            indexes = [
                i for i, t in enumerate(pl.get_tracks()) if t.id == track.id
            ]
            if indexes:
                pl.remove_at_indexes(indexes)

        starred = StarredTrack.select().where(StarredTrack.starred == track.id)
        if not admin:
            starred = starred.where(StarredTrack.user == user_id)
        favorites = starred.count()
        for star in starred:
            star.delete_instance()

        if admin:
            # recursive: the ArtistCredit rows, ratings and any
            # remaining starred/playlist links go with it.
            track.delete_instance(recursive=True)

    _purge_on_deezer(app, deezer_id, mirrored, admin)
    return len(touched), favorites


def _run_delete(app, job_id, track_id, user_id, admin):
    """Worker: unpick the track from everything, then drop the row (admin)."""
    from ..db import close_connection, open_connection

    playlists = favorites = 0
    try:
        with app.app_context():
            open_connection(reuse=True)
            track = Track.get_or_none(Track.id == track_id)
            if track is None:
                _finish_job(job_id, ok=True)  # someone got there first
                return
            playlists, favorites = _remove_everywhere(app, track, user_id, admin)
            _finish_job(job_id, ok=True, playlists=playlists, favorites=favorites)
    except Exception as exc:
        logger.warning("Deleting %s failed", track_id, exc_info=True)
        _finish_job(
            job_id, ok=False, error=str(exc), playlists=playlists, favorites=favorites
        )
    finally:
        try:
            close_connection()
        except Exception:
            pass


# -- deleting a selection ----------------------------------------------------
# The library's "Indisponibles" list lets you tick several dead tracks and drop
# them at once. Same guarantee as one at a time — every track is re-checked
# against BOTH sources at the moment it goes, and one that turns out to be
# playable is kept and reported — but the checks are a Deezer call each, so
# they run in the worker, never in the request thread.

BULK_DELETE_MAX = 200
# Each job is a thread making up to BULK_DELETE_MAX Deezer calls, outside the
# request pool that bounds everything else. Unbounded, a loop on this route is
# hundreds of threads hammering Deezer until its breaker opens for EVERYONE.
# One running job per user, a couple per server.
BULK_DELETE_JOBS = 2
_bulk_running: dict = {}  # user id -> job id, under _jobs_lock


@webapi.route("/tracks/delete", methods=["POST"])
@login_required
def delete_tracks():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > BULK_DELETE_MAX:
        return jsonify({"error": "invalid ids"}), 400

    todo = []  # (universal id, Track.id)
    missing = []
    seen = set()
    for raw in ids:
        uid = str(raw or "")
        if not uid or len(uid) > 64 or uid in seen:
            continue
        seen.add(uid)
        if not _valid_id(uid):
            try:
                uuidlib.UUID(uid)
            except ValueError:
                missing.append(uid)
                continue
            row = Track.get_or_none(Track.id == uuidlib.UUID(uid))
        else:
            from ..deezer import archive

            row = archive.find_local_track(uid)
        if row is None or not _may_access_track(row):
            missing.append(uid)
            continue
        todo.append((uid, row.id))
    if not todo:
        return jsonify({"error": "not found"}), 404

    user_id = request.webuser.id
    with _jobs_lock:
        busy = _bulk_running.get(user_id)
        if busy is not None:
            return jsonify({"error": "a deletion is already running", "job": busy}), 409
        if len(_bulk_running) >= BULK_DELETE_JOBS:
            return jsonify({"error": "server busy"}), 429, {"Retry-After": "10"}
        # Reserved in the same critical section as the check: two requests
        # arriving together must not both pass it.
        _bulk_running[user_id] = ""
    job_id = _new_job("delete-many")
    with _jobs_lock:
        _jobs[job_id].update(
            total=len(todo), done=0, deleted=[], kept=[], missing=missing
        )
        _bulk_running[user_id] = job_id
    app = current_app._get_current_object()
    threading.Thread(
        target=_run_delete_many,
        args=(app, job_id, todo, user_id, _is_admin()),
        name="track-delete-many",
        daemon=True,
    ).start()
    return jsonify({"ok": True, "job": job_id, "total": len(todo)})


def _run_delete_many(app, job_id, todo, user_id, admin):
    from ..db import close_connection, open_connection

    playlists = favorites = 0
    try:
        with app.app_context():
            open_connection(reuse=True)
            for uid, row_id in todo:
                outcome = None
                try:
                    track = Track.get_or_none(Track.id == row_id)
                    if track is None:
                        outcome = ("deleted", None)  # someone got there first
                    else:
                        gone, reason = verify_gone(track, uid)
                        if not gone:
                            outcome = ("kept", reason)
                        else:
                            p, f = _remove_everywhere(app, track, user_id, admin)
                            playlists += p
                            favorites += f
                            outcome = ("deleted", None)
                except Exception:
                    logger.warning("Deleting %s failed", uid, exc_info=True)
                    outcome = ("kept", "error")
                with _jobs_lock:
                    job = _jobs.get(job_id)
                    if job is not None:
                        if outcome[0] == "deleted":
                            job["deleted"].append(uid)
                        else:
                            job["kept"].append({"id": uid, "reason": outcome[1]})
                        job["done"] += 1
                        job["playlists"] = playlists
                        job["favorites"] = favorites
            _finish_job(job_id, ok=True)
    except Exception as exc:
        logger.warning("Bulk deletion failed", exc_info=True)
        _finish_job(job_id, ok=False, error=str(exc))
    finally:
        with _jobs_lock:
            if _bulk_running.get(user_id) == job_id:
                del _bulk_running[user_id]
        try:
            close_connection()
        except Exception:
            pass


def _purge_on_deezer(app, deezer_id, playlist_deezer_ids, admin):
    """Carry the removal over to the Deezer account too (best effort).

    Only the admin owns that account, and a Deezer failure must never undo the
    local removal that already succeeded.
    """
    if not admin or not deezer_id:
        return
    if not app.config["DEEZER"].get("push_to_deezer"):
        return
    provider = getattr(app, "deezer", None)
    if provider is None:
        return
    for dz_playlist in playlist_deezer_ids:
        try:
            provider.remove_songs_from_playlist(dz_playlist, [deezer_id])
        except Exception:
            logger.info(
                "Deezer removal from playlist %s failed", dz_playlist, exc_info=True
            )
    try:
        provider.dz.gw.remove_song_from_favorites(deezer_id)
        provider.invalidate_favorites_cache()
    except Exception:
        logger.info("Deezer unstar of %s failed", deezer_id, exc_info=True)


def _retire_replaced(source) -> bool:
    """Drop a dead track once nothing points at it any more.

    Without this, replacing a track fixed the playlists but left the corpse in
    the database — still flagged, so still listed under "Titres indisponibles"
    for ever, with nothing left to replace. The user did the work and the app
    kept asking.

    Deliberately narrow, because ``/api/replace`` accepts ANY source, not only
    dead ones: the row goes only when it is flagged unavailable, has no file on
    disk, and is referenced by no playlist and no favourite — anyone's. A
    non-admin's replacement rewrites only their own lists, so a track someone
    else still uses fails the reference check and stays, which is the point.
    """
    import os.path

    if source.unavailable is None:
        return False
    if source.path and os.path.isfile(source.path):
        # Archived after all: it plays, so it is not dead and not ours to drop.
        clear_unavailable(source)
        return False
    if PlaylistTrack.select().where(PlaylistTrack.track == source.id).exists():
        return False
    if StarredTrack.select().where(StarredTrack.starred == source.id).exists():
        return False
    try:
        source.delete_instance(recursive=True)
    except Exception:
        logger.info("Could not retire the replaced track %s", source.id, exc_info=True)
        return False
    logger.info("Retired replaced track %s (nothing referenced it)", source.deezer_id)
    return True


def _mirror_to_deezer(app, source, target, playlist_ids, admin):
    """Best effort: carry the swap over to the Deezer account too.

    Only the admin owns that account, only real Deezer playlists can be mirrored,
    and a Deezer failure must never undo the local swap that already succeeded.
    """
    if not admin or not app.config["DEEZER"].get("push_to_deezer"):
        return
    provider = getattr(app, "deezer", None)
    if provider is None or not target.deezer_id or not source.deezer_id:
        return
    for pid in playlist_ids:
        pl = Playlist.get_or_none(Playlist.id == pid)
        if pl is None or not pl.deezer_id:
            continue
        try:
            provider.remove_songs_from_playlist(pl.deezer_id, [source.deezer_id])
            provider.add_songs_to_playlist(pl.deezer_id, [target.deezer_id])
        except Exception:
            logger.info(
                "Deezer mirror of the replacement failed for playlist %s", pid,
                exc_info=True,
            )

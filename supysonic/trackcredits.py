# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Who wrote, composed and produced each track, kept in the database.

The performers of a track are ``TrackArtist`` rows. Everybody else on the
sleeve — composer, author, producer, engineer… — is a ``TrackCredit`` row: one
per person, role and SOURCE, so each source's statement can be replaced on its
own without touching what another one said. The sources, best first:

* ``deezer``: the gateway's ``SNG_CONTRIBUTORS`` (a role -> names map), the
  label's own declaration. Archived with the track (its sidecar) and stored
  here when it is archived, or when the credits panel asked Deezer about a
  track that is not on disk;
* ``tags``: what the owner of an upload wrote into the file;
* ``musicbrainz``: the recording's and its works' relations (composer and
  lyricist live on the WORK, the producer on the recording). It only fills the
  roles the two above did not state: a label's credit list beats a crowd's.

The rows of a library archived before this existed are filled once, in the
background (``backfill`` below): first from what is already on disk (sidecars,
tags), and only then by asking Deezer, in batches, behind anything a person is
waiting for.

Names are matched on ``name_key`` (case-folded, spaces collapsed): a person's
credits page is one indexed read.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time

from .db import Meta, Track, TrackCredit, close_connection, db, open_connection

logger = logging.getLogger(__name__)

SOURCES = ("deezer", "tags", "musicbrainz")
#: Bounds on what a source may make us store for one track.
MAX_PEOPLE = 40
MAX_ROLES = 40
MAX_TEXT = 160
MAX_ROLE = 40

#: The roles of the people ON the record, already ``TrackArtist`` rows: a
#: person's credits page lists what they wrote or made, not what they sang.
PERFORMER_ROLES = frozenset(
    {"main_artist", "mainartist", "featuring", "featuredartist", "featured_artist"}
)

#: MusicBrainz names (``enrich.musicbrainz.credits``) and the role each is kept
#: under. "author" is Deezer's word for the lyricist: MusicBrainz does not add a
#: lyricist to a track whose label already named its authors.
_MB_ROLES = (("composer", "composer"), ("lyricist", "lyricist"), ("producer", "producer"))
_SAME_ROLE = {"lyricist": ("author", "lyricist"), "composer": ("composer",), "producer": ("producer",)}

_SPACES = re.compile(r"\s+")


def _text(v, limit=MAX_TEXT) -> str:
    if not isinstance(v, (str, int, float)) or isinstance(v, bool):
        return ""
    return _SPACES.sub(" ", str(v)).strip()[:limit]


def name_key(name) -> str:
    """The form a name is matched by: case-folded, spaces collapsed."""
    return _text(name).casefold()


def _names(v) -> list[str]:
    """Names out of whatever a source put under a role: a list, or one string."""
    if isinstance(v, str):
        v = [v]
    if not isinstance(v, (list, tuple)):
        return []
    out, seen = [], set()
    for x in v:
        name = _text(x.get("ART_NAME") or x.get("name") if isinstance(x, dict) else x)
        if name and name.casefold() not in seen:
            seen.add(name.casefold())
            out.append(name)
        if len(out) >= MAX_PEOPLE:
            break
    return out


def clean(contrib) -> dict[str, list[str]]:
    """A role -> names map, bounded and normalised, from a source's payload.

    Roles are lower-case words (``"Composer"`` and ``"composer"`` are one), a
    role with nobody under it is dropped, and so is anything that is not a map.
    """
    if not isinstance(contrib, dict):
        return {}
    out: dict[str, list[str]] = {}
    for key, value in contrib.items():
        role = _text(key, MAX_ROLE).lower().replace(" ", "_")
        names = _names(value)
        if not role or not names:
            continue
        have = out.setdefault(role, [])
        have += [n for n in names if n not in have][: MAX_PEOPLE - len(have)]
        if len(out) >= MAX_ROLES:
            break
    return out


def split_names(raw, commas: bool = False) -> list[str]:
    """Names out of a tag value: ``"A; B"`` is two people, ``"Last, First"``
    one. ``commas`` is for what MusicBrainz said (``enrich.musicbrainz.credits``
    joins its names with ", ")."""
    raw = str(raw or "").replace("\x00", ";")
    parts = raw.split(", ") if commas and ";" not in raw else raw.split(";")
    return [n for n in (p.strip() for p in parts) if n]


# -- storage ----------------------------------------------------------------


def store(track_id, contrib, source: str) -> int:
    """Replace what ``source`` says about a track. Returns the rows written.

    An empty statement deletes the source's rows: what it says now is nothing.
    """
    if source not in SOURCES:
        raise ValueError(source)
    roles = clean(contrib)
    rows = [
        {
            "track": track_id,
            "source": source,
            "role": role,
            "name": name,
            "name_key": name.casefold(),
            "position": pos,
        }
        for pos, (role, name) in enumerate(
            (role, name) for role, names in roles.items() for name in names
        )
    ]
    with db.atomic():
        TrackCredit.delete().where(
            (TrackCredit.track == track_id) & (TrackCredit.source == source)
        ).execute()
        for i in range(0, len(rows), 100):
            TrackCredit.insert_many(rows[i : i + 100]).execute()
    return len(rows)


def stored(track_id) -> dict[str, dict[str, list[str]]]:
    """``{source: {role: [names]}}`` for one track, in the order stated."""
    out: dict[str, dict[str, list[str]]] = {}
    query = (
        TrackCredit.select(TrackCredit.source, TrackCredit.role, TrackCredit.name)
        .where(TrackCredit.track == track_id)
        .order_by(TrackCredit.source, TrackCredit.position)
        .tuples()
    )
    for source, role, name in query:
        out.setdefault(source, {}).setdefault(role, []).append(name)
    return out


def merge(by_source: dict) -> dict[str, list[str]]:
    """One role -> names map out of every source's statement.

    Deezer and the file's tags are the label's and the owner's word and are
    kept whole (Deezer's roles first); MusicBrainz only fills a role neither
    named.
    """
    out: dict[str, list[str]] = {}
    for source in ("deezer", "tags"):
        for role, names in (by_source.get(source) or {}).items():
            have = out.setdefault(role, [])
            have += [n for n in names if n.casefold() not in {h.casefold() for h in have}]
    mb = by_source.get("musicbrainz") or {}
    for role, names in mb.items():
        if any(out.get(r) for r in _SAME_ROLE.get(role, (role,))):
            continue
        out[role] = list(names)
    return out


def from_facts(facts: dict) -> dict[str, list[str]]:
    """What MusicBrainz said, out of a sidecar's ``facts`` block."""
    out = {}
    for key, role in _MB_ROLES:
        fact = facts.get(key) if isinstance(facts, dict) else None
        if isinstance(fact, dict) and fact.get("source") in ("musicbrainz", "acoustid"):
            names = split_names(fact.get("value"), commas=True)[:MAX_PEOPLE]
            if names:
                out[role] = names
    return out


def from_musicbrainz(extra: dict) -> dict[str, list[str]]:
    """What ``enrich.musicbrainz.credits`` answered (comma-joined names)."""
    return {
        role: split_names((extra or {}).get(key), commas=True)
        for key, role in _MB_ROLES
        if (extra or {}).get(key)
    }


#: Tracks a person's credits page lists at most.
PERSON_MAX = 500


def credited_query_many(keys):
    """The credits of the people whose folded names are ``keys``, performer
    roles left out (a performer has their own artist page for that)."""
    return TrackCredit.select().where(
        (TrackCredit.name_key << list(keys)) & ~(TrackCredit.role << sorted(PERFORMER_ROLES))
    )


# -- what the disk already knows --------------------------------------------


def local_statements(track) -> dict[str, dict[str, list[str]]]:
    """What the files of a track say, without any network: the sidecar's
    Deezer payload and MusicBrainz facts, and an upload's own tags."""
    from .deezer import library

    out: dict[str, dict[str, list[str]]] = {}
    if not track.path:
        return out
    meta = library.read_track_metadata(track) or {}
    gw = meta.get("gw") if isinstance(meta.get("gw"), dict) else {}
    if "SNG_CONTRIBUTORS" in gw:
        out["deezer"] = clean(gw["SNG_CONTRIBUTORS"])
    facts = meta.get("facts") if isinstance(meta.get("facts"), dict) else {}
    mb = from_facts(facts)
    if mb:
        out["musicbrainz"] = mb
    if track.deezer_id is None and track.youtube_id is None and os.path.isfile(track.path):
        from .filetags import read_file_facts

        try:
            tags = read_file_facts(track.path)
        except Exception:
            logger.debug("credits: cannot read the tags of %s", track.path, exc_info=True)
            tags = {}
        people = {
            role: split_names(tags[role])
            for role in ("composer", "lyricist", "producer")
            if tags.get(role)
        }
        out["tags"] = clean(people)
    return out


# -- the backfill -----------------------------------------------------------

#: ``Meta`` keys (32 characters at most).
CURSOR_KEY = "credits_cursor"
DONE_KEY = "credits_backfill"
#: Tracks asked of Deezer in one gateway call.
BATCH = 50
#: Between two Deezer calls (the gateway is shared with whoever is listening).
PAUSE = 0.5
#: Let the server finish coming up before a library job takes the disk.
RESUME_DELAY = 45

_lock = threading.Lock()
_job = None
_counts: dict = {}


def _new_counts():
    return {"local": 0, "deezer": 0, "none": 0, "unreachable": 0}


class _Backfill:
    """The per-track work and the Deezer batch it feeds.

    A track whose sidecar or tags already answer is stored at once. One that
    needs Deezer waits in ``pending``, asked with up to ``BATCH - 1`` others in
    ONE ``song.getListData`` call at the end of each page — before the page's
    checkpoint, so a restart never skips a track that was only queued.
    """

    def __init__(self, provider, counts):
        self.provider = provider
        self.counts = counts
        self.pending: list = []
        self.listdata_has_credits = None  # unknown until a batch answered
        self.failures: dict = {}

    def work(self, track):
        # What the label or the file said is already here: nothing to learn.
        # (MusicBrainz's rows alone do not count: Deezer may still name more.)
        if TrackCredit.select().where(
            (TrackCredit.track == track.id) & (TrackCredit.source << ["deezer", "tags"])
        ).exists():
            return None
        local = local_statements(track)
        for source, roles in local.items():
            store(track.id, roles, source)
        if "deezer" in local or track.deezer_id is None:
            self.counts["local" if any(local.values()) else "none"] += 1
            return None
        if self.provider is None:
            self.counts["none" if not local else "local"] += 1
            return None
        self.pending.append(track)
        return None

    def flush(self, rows=None):
        """Ask Deezer about the queued tracks. Returns ``{track_id: reason}``
        for the ones it could not answer."""
        failed = {}
        while self.pending:
            batch, self.pending = self.pending[:BATCH], self.pending[BATCH:]
            failed.update(self._ask(batch))
        return failed

    def _answers(self, batch):
        from .deezer.workload import quiet_wait

        ids = [str(t.deezer_id) for t in batch]
        got = {}
        if self.listdata_has_credits is not False:
            quiet_wait(5.0)
            rows = self.provider.get_tracks(ids) or []
            got = {
                str(r.get("SNG_ID")): r
                for r in rows
                if isinstance(r, dict) and r.get("SNG_ID") is not None
            }
            if any("SNG_CONTRIBUTORS" in r for r in got.values()):
                self.listdata_has_credits = True
            elif got:
                # The list call answered without credits: one call a track, then.
                self.listdata_has_credits = False
                got = {}
        if self.listdata_has_credits is False:
            for sid in ids:
                quiet_wait(5.0)
                info = self.provider.get_track_info(sid)
                if isinstance(info, dict) and info:
                    got[sid] = info
                if PAUSE:
                    time.sleep(PAUSE)
        elif PAUSE:
            time.sleep(PAUSE)
        return got

    def _ask(self, batch):
        from .deezer import library

        try:
            got = self._answers(batch)
        except Exception as exc:
            # Deezer not answering is not an answer about these tracks: they
            # are left for the next run.
            self.counts["unreachable"] += len(batch)
            reason = f"Deezer injoignable ({type(exc).__name__})"
            return {t.id: reason for t in batch}
        for track in batch:
            info = got.get(str(track.deezer_id))
            if info is None:
                self.counts["none"] += 1
                continue
            store(track.id, info.get("SNG_CONTRIBUTORS") or {}, "deezer")
            self.counts["deezer" if info.get("SNG_CONTRIBUTORS") else "none"] += 1
            # The archive describes itself: its sidecar takes what it lacked.
            if track.path and os.path.isfile(track.path) and "SNG_CONTRIBUTORS" in info:
                try:
                    library.add_sidecar_fields(
                        track,
                        {k: info[k] for k in ("SNG_CONTRIBUTORS", "LABEL_NAME") if k in info},
                    )
                except Exception:
                    logger.debug("credits: sidecar of %s not updated", track.id, exc_info=True)
        return {}


class BackfillJob:
    """``libjob.LibraryJob`` over every track, with the Deezer batch flushed
    at the end of each page."""

    def __init__(self, provider=None, force=False):
        from .libjob import LibraryJob

        global _counts
        _counts = _new_counts()
        self.state = _Backfill(provider, _counts)
        query = Track.select()
        self.job = LibraryJob(
            "credits", query, self.state.work, cursor_key=CURSOR_KEY, force=force,
            page_size=BATCH * 2, page_done=self._page_done,
        )

    def _page_done(self, rows):
        by_id = {r.id: r for r in rows}
        for tid, reason in self.state.flush().items():
            self.job.fail(by_id.get(tid), reason)

    def run(self, limit=None):
        return self.job.run(limit=limit)

    def snapshot(self):
        return self.job.snapshot()


def total() -> int:
    return Track.select().count()


def status() -> dict:
    with _lock:
        job = _job
        counts = dict(_counts)
    snap = job.snapshot() if job is not None else {
        "name": "credits", "running": False, "done": 0, "failed": 0,
        "failures": [], "failure_reasons": {}, "error": None,
    }
    snap["counts"] = counts
    snap["tracks"] = (
        TrackCredit.select(TrackCredit.track).distinct().count()
    )
    snap["completed"] = Meta.get_or_none(Meta.key == DONE_KEY) is not None
    return snap


def running() -> bool:
    with _lock:
        return bool(_job is not None and _job.snapshot()["running"])


def _mark_done():
    row = Meta.get_or_none(Meta.key == DONE_KEY)
    stamp = str(int(time.time()))
    if row is None:
        Meta.create(key=DONE_KEY, value=stamp)
    else:
        row.value = stamp
        row.save()


def _run(app, job):
    with app.app_context():
        try:
            open_connection(reuse=True)
            snap = job.run()
            # A run cut short, or one Deezer did not answer in full, runs again
            # at the next start; a complete one never does.
            if snap.get("finished") and not _counts.get("unreachable"):
                _mark_done()
        except Exception:
            logger.warning("Credits backfill crashed", exc_info=True)
        finally:
            try:
                close_connection()
            except Exception:
                pass


def start(app, force=False, *, wait=False):
    """Start the backfill on a daemon thread; a no-op while one is running."""
    global _job
    with _lock:
        if _job is not None and _job.snapshot()["running"]:
            return False
        provider = getattr(app, "deezer", None)
        _job = BackfillJob(provider, force)
        job = _job
        job.job._stats["running"] = True
        job.job._stats["total"] = total()
    t = threading.Thread(target=_run, args=(app, job), name="credits-backfill", daemon=True)
    t.start()
    if wait:
        t.join()
    return True


def start_if_needed(app):
    """After a start: run the backfill the library never completed (an
    upgrade, a run cut short by a restart, one Deezer did not answer)."""

    def go():
        time.sleep(RESUME_DELAY)
        with app.app_context():
            try:
                open_connection(reuse=True)
                needed = Meta.get_or_none(Meta.key == DONE_KEY) is None
            except Exception:
                logger.debug("Could not read the credits mark", exc_info=True)
                return
            finally:
                try:
                    close_connection()
                except Exception:
                    pass
        if needed:
            logger.info("Filling the credits of the library in the background")
            start(app)

    threading.Thread(target=go, name="credits-resume", daemon=True).start()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The releases of favourite artists, and the artists close to them.

Every few hours (``every``, 6 by default) a background thread asks each
provider that can answer (capability ``related``) what the artists people have
starred put out lately, and keeps it in ``artist_release``. Once a week per
favourite it also reads the artists the provider lists as close
(``artist_link``) and the most played titles of the nearest of them
(``artist_top``): the material discovery offers of an artist the library holds
nothing of. The ``close`` nearest artists of each favourite (2 by default, 60 in
all) are watched for releases too, so the "Nouveautés" shelf carries a few
artists very close to the favourites.

The rules are the house's:

* **Never in a click.** Screens read the tables; only this thread asks.
* **Spread and polite.** Each artist is due ``every`` hours after ITS last check,
  not all at once; one call at a time, a pause between them, the thread
  reniced, background work yielding to a foreground archive.
* **A failure is not a verdict.** A provider that does not answer stops the run
  with nothing marked: what was not checked is still due and is asked at the
  next tick. An artist the provider says is gone is marked checked (it is not
  asked again every tick) and nothing else.
* **Only ever adds**, apart from releases older than a year.

Settings live in ``Meta`` (``rel.*``) and are set from Réglages.
"""

import datetime
import logging
import threading
import time

from .db import (
    ArtistLink, ArtistRelease, ArtistTop, ArtistWatch, Artist, EntityRef, Meta,
    StarredArtist, close_connection, now, open_connection,
)

logger = logging.getLogger(__name__)

#: Meta keys (32 characters at most).
KEY_ON = "rel.on"
KEY_EVERY = "rel.every"
KEY_CLOSE = "rel.close"
KEY_WINDOW = "rel.window"
KEY_LISTENED = "rel.listened"
#: Defaults: on, every 6 hours, 2 close artists per favourite, releases of the
#: last 90 days, and the 30 artists each person listens to most (Release Radar
#: covers "the artists you follow and listen to most", ListenBrainz's fresh
#: releases the artists a person listened to).
DEFAULTS = {KEY_ON: True, KEY_EVERY: 6, KEY_CLOSE: 2, KEY_WINDOW: 90, KEY_LISTENED: 30}
BOUNDS = {KEY_EVERY: (1, 168), KEY_CLOSE: (0, 5), KEY_WINDOW: (7, 365), KEY_LISTENED: (0, 200)}
#: Listened artists whose close artists are also read (on top of favourites).
LINKS_OF_LISTENED = 20
#: Watched artists at most, all people together.
WATCH_MAX = 1500

#: The close artists watched for releases, all favourites together.
CLOSE_MAX = 60
#: Similar artists and their most played titles are re-read this often.
LINK_EVERY = datetime.timedelta(days=7)
#: How many similar artists are kept per favourite, and whose titles are read.
LINKS_KEPT = 20
TOPS_OF = 5
TOP_TITLES = 5
#: Releases older than this are dropped from the table.
KEEP_DAYS = 365
#: The thread wakes this often to look for due work; the first look waits.
TICK = 15 * 60
BOOT_DELAY = 90
#: Between two calls to a provider.
PAUSE = 1.0

_lock = threading.Lock()
_status = {"running": False, "last_run": None, "last_error": None, "asked": 0}
_thread = None


# -- settings ---------------------------------------------------------------------


def settings() -> dict:
    out = dict(DEFAULTS)
    for row in Meta.select().where(Meta.key.in_(list(DEFAULTS))):
        if row.key == KEY_ON:
            out[KEY_ON] = row.value == "1"
            continue
        try:
            lo, hi = BOUNDS[row.key]
            out[row.key] = min(hi, max(lo, int(row.value)))
        except (KeyError, ValueError, TypeError):
            pass
    return {"on": out[KEY_ON], "every": out[KEY_EVERY], "close": out[KEY_CLOSE],
            "window": out[KEY_WINDOW], "listened": out[KEY_LISTENED]}


def save_settings(values: dict) -> dict:
    """Store what ``values`` carries (validated, clamped) and return the whole."""
    names = {"on": KEY_ON, "every": KEY_EVERY, "close": KEY_CLOSE, "window": KEY_WINDOW,
             "listened": KEY_LISTENED}
    for name, key in names.items():
        if name not in values:
            continue
        raw = values[name]
        if key == KEY_ON:
            value = "1" if bool(raw) else "0"
        else:
            try:
                lo, hi = BOUNDS[key]
                value = str(min(hi, max(lo, int(raw))))
            except (TypeError, ValueError):
                raise ValueError(f"{name} must be a whole number") from None
        _meta_put(key, value)
    return settings()


def _meta_put(key, value):
    """Write one ``Meta`` row on any engine (PostgreSQL has no REPLACE)."""
    from .db import db

    if Meta.update(value=value).where(Meta.key == key).execute():
        return
    try:
        with db.atomic():
            Meta.create(key=key, value=value)
    except Exception:  # written meanwhile
        Meta.update(value=value).where(Meta.key == key).execute()


# -- who is watched -----------------------------------------------------------------


def favourite_refs(provider_id, users=None) -> dict:
    """``{ref: name}`` of the artists starred (by ``users``, or anybody) that
    ``provider_id`` knows: Deezer by the row's own id, any other provider by
    the ``entity_ref`` the import left."""
    q = (
        Artist.select(Artist.id, Artist.name, Artist.deezer_id)
        .join(StarredArtist, on=(StarredArtist.starred == Artist.id))
    )
    if users is not None:
        q = q.where(StarredArtist.user.in_(list(users)))
    rows = list(q.distinct().tuples())
    out = {}
    if provider_id == "deezer":
        for _aid, name, dz in rows:
            if dz:
                out[str(dz)] = name
        return out
    by_id = {aid: name for aid, name, _dz in rows}
    if by_id:
        for ref, entity in (
            EntityRef.select(EntityRef.ref, EntityRef.entity)
            .where(
                (EntityRef.kind == "artist")
                & (EntityRef.provider == provider_id)
                & EntityRef.entity.in_(list(by_id))
            )
            .tuples()
        ):
            out[ref] = by_id.get(entity, "")
    return out


def _refs_of(provider_id, artist_ids) -> dict:
    """``{ref: name}`` of library artists ``provider_id`` knows."""
    out = {}
    ids = list(artist_ids)
    if not ids:
        return out
    rows = []
    for i in range(0, len(ids), 500):
        rows += list(Artist.select(Artist.id, Artist.name, Artist.deezer_id)
                     .where(Artist.id.in_(ids[i : i + 500])).tuples())
    if provider_id == "deezer":
        for _aid, name, dz in rows:
            if dz:
                out[str(dz)] = name
        return out
    by_id = {aid: name for aid, name, _dz in rows}
    for ref, entity in (
        EntityRef.select(EntityRef.ref, EntityRef.entity)
        .where((EntityRef.kind == "artist") & (EntityRef.provider == provider_id)
               & EntityRef.entity.in_(list(by_id)))
        .tuples()
    ):
        out[ref] = by_id.get(entity, "")
    return out


def listened_artists(users=None, per_user=None) -> list:
    """The library artists each person (``users``, or everybody) listens to
    most, by the activation of their own history (supysonic/listening.py),
    best first; a person with no history of their own yet is answered by the
    shared play counters."""
    from . import listening
    from .db import Track, User
    from peewee import fn

    n = settings()["listened"] if per_user is None else per_user
    if n <= 0:
        return []
    people = list(User.select()) if users is None else list(User.select().where(User.id.in_(list(users))))
    out, seen = [], set()
    shared = None
    for user in people:
        top = listening.top_artists(user, n)
        # The shared counters are the owner's library from before the log, not
        # a guest's listening: only an admin falls back on them.
        if not top and user.admin:
            if shared is None:
                shared = [
                    a for (a,) in Track.select(Track.artist)
                    .where(Track.play_count > 0)
                    .group_by(Track.artist)
                    .order_by(fn.SUM(Track.play_count).desc())
                    .limit(n)
                    .tuples()
                ]
            top = shared
        for a in top:
            if a not in seen:
                seen.add(a)
                out.append(a)
    return out


def listened_refs(provider_id, users=None, per_user=None) -> dict:
    return _refs_of(provider_id, listened_artists(users, per_user))


_KIND_RANK = {"album": 3, "ep": 2, "single": 1}
_BRACKETS = None


def title_key(title) -> str:
    """A release title with its edition and format notes dropped: "Name",
    "Name (Deluxe)", "Name - Single" and "NAME" are one release."""
    import re
    import unicodedata

    global _BRACKETS
    if _BRACKETS is None:
        _BRACKETS = (
            re.compile(r"[\(\[][^\)\]]*[\)\]]"),
            re.compile(r"\s+-\s+(single|ep|deluxe.*|remaster.*|expanded.*)$", re.I),
            re.compile(r"[^\w]+"),
        )
    t = unicodedata.normalize("NFKD", str(title or "")).encode("ascii", "ignore").decode().lower()
    t = _BRACKETS[0].sub(" ", t)
    t = _BRACKETS[1].sub("", t.strip())
    return _BRACKETS[2].sub(" ", t).strip()


def shown_releases(rows):
    """What a feed shows of ``rows`` (newest first): no compilation (Release
    Radar leaves them out), and a release put out as a single then on an EP or
    an album under the same title once, as its most complete form
    (ListenBrainz de-duplicates near-identical titles)."""
    best = {}
    order = []
    for r in rows:
        kind = (r.kind or "album").lower()
        if kind in ("compile", "compilation"):
            continue
        k = (r.artist_ref, title_key(r.title) or r.ref)
        have = best.get(k)
        if have is None:
            best[k] = r
            order.append(k)
        elif _KIND_RANK.get(kind, 3) > _KIND_RANK.get((have.kind or "album").lower(), 3):
            best[k] = r
    return [best[k] for k in order]


def close_refs(provider_id, favs, per_fav, cap=CLOSE_MAX) -> dict:
    """``{ref: (name, picture)}``: the ``per_fav`` nearest artists of each
    favourite, nearest first round by round, at most ``cap``, favourites left
    out (they are watched anyway)."""
    if per_fav <= 0 or not favs:
        return {}
    by_fav = {}
    for a, o, name, pic, pos in (
        ArtistLink.select(
            ArtistLink.artist_ref, ArtistLink.other_ref, ArtistLink.other_name,
            ArtistLink.other_picture, ArtistLink.pos,
        )
        .where((ArtistLink.provider == provider_id) & ArtistLink.artist_ref.in_(list(favs)))
        .order_by(ArtistLink.pos)
        .tuples()
    ):
        if o in favs:
            continue
        by_fav.setdefault(a, []).append((o, name, pic))
    out = {}
    for rank in range(per_fav):
        for fav in sorted(by_fav):
            got = by_fav[fav]
            if rank < len(got) and got[rank][0] not in out:
                out[got[rank][0]] = (got[rank][1], got[rank][2])
                if len(out) >= cap:
                    return out
    return out


# -- one run ------------------------------------------------------------------------


class _Stop(Exception):
    """The provider stopped answering: end the run, mark nothing more."""


def _providers(app):
    from .providers import base

    reg = getattr(app, "providers", None)
    if reg is None:
        return []
    try:
        found = reg.with_capability(base.RELATED)
    except Exception:
        return []
    return [p for p in found if reg.is_enabled(p.id)]


def _ask(provider, method, ref, stats):
    """One call, translated: ``None`` when the provider answered there is no
    such artist (it is not asked again before its next turn), ``_Stop`` when
    it did not answer at all."""
    from .providers.errors import Gone, NotFound, ProviderError, ProviderHeld, ProviderUnavailable

    if not provider.available():
        raise _Stop()
    stats["asked"] = stats.get("asked", 0) + 1
    try:
        return getattr(provider, method)(ref)
    except (ProviderUnavailable, ProviderHeld) as exc:
        raise _Stop() from exc
    except (Gone, NotFound):
        return None
    except ProviderError as exc:
        logger.info("%s %s(%s): %s", provider.id, method, ref, exc)
        return None


def _pause(stats):
    if stats.get("pause", PAUSE) > 0:
        try:
            from .deezer import workload

            workload.quiet_wait(5.0)
        except Exception:
            logger.debug("releases: quiet_wait failed", exc_info=True)
        time.sleep(stats.get("pause", PAUSE))


def _store_links(provider_id, ref, others):
    rows = []
    n = len(others)
    for pos, o in enumerate(others[:LINKS_KEPT]):
        oref = str(o.get("ref") or "")[:128]
        if not oref or oref == ref:
            continue
        rows.append(
            {
                "provider": provider_id,
                "artist_ref": ref,
                "other_ref": oref,
                "other_name": str(o.get("name") or "")[:255] or oref,
                "other_picture": (str(o.get("cover_url") or "")[:512] or None),
                # Providers give an order, not a figure: the first is 1, the
                # last of a full list 0.4.
                "score": round(1.0 - 0.6 * pos / max(1, max(n, LINKS_KEPT) - 1), 4),
                "pos": pos,
                "fetched": now(),
            }
        )
    from .db import db

    with db.atomic():
        ArtistLink.delete().where(
            (ArtistLink.provider == provider_id) & (ArtistLink.artist_ref == ref)
        ).execute()
        if rows:
            ArtistLink.insert_many(rows).on_conflict_ignore().execute()


def _store_tops(provider_id, ref, name, hits):
    from .db import db

    rows = []
    for pos, h in enumerate(hits[:TOP_TITLES]):
        tref = str(h.get("ref") or "")[:128]
        if not tref:
            continue
        album = h.get("album") or {}
        artists = h.get("artists") or [{}]
        rows.append(
            {
                "provider": provider_id,
                "ref": tref,
                "artist_ref": ref,
                "artist_name": str(artists[0].get("name") or name or "")[:255],
                "title": str(h.get("title") or "")[:255],
                "album_ref": (str(album.get("ref") or "")[:128] or None),
                "album_title": (str(album.get("name") or "")[:255] or None),
                "cover": (str(h.get("cover_url") or "")[:512] or None),
                "duration": int(h.get("duration") or 0),
                "pos": pos,
                "fetched": now(),
            }
        )
    with db.atomic():
        ArtistTop.delete().where(
            (ArtistTop.provider == provider_id) & (ArtistTop.artist_ref == ref)
        ).execute()
        if rows:
            # A title can be another artist's top too: the first one keeps it.
            ArtistTop.insert_many(rows).on_conflict_ignore().execute()


def _store_releases(provider_id, ref, name, releases, since) -> int:
    rows = []
    for r in releases:
        date = r.get("release_date")
        rref = str(r.get("ref") or "")[:128]
        if not rref or not date or date < since:
            continue
        rows.append(
            {
                "provider": provider_id,
                "ref": rref,
                "artist_ref": ref,
                "artist_name": str(name or "")[:255],
                "title": str(r.get("title") or "")[:255],
                "cover": (str(r.get("cover_url") or "")[:512] or None),
                "kind": (str(r.get("kind") or "")[:12] or None),
                "released": str(date)[:10],
                "nb_tracks": r.get("tracks_count") or None,
                "found": now(),
            }
        )
    if not rows:
        return 0
    known = {
        x[0]
        for x in ArtistRelease.select(ArtistRelease.ref)
        .where((ArtistRelease.provider == provider_id) & ArtistRelease.ref.in_([r["ref"] for r in rows]))
        .tuples()
    }
    fresh = [r for r in rows if r["ref"] not in known]
    if fresh:
        ArtistRelease.insert_many(fresh).on_conflict_ignore().execute()
    return len(fresh)


def run_once(app, force=False, stats=None) -> dict:
    """One pass over what is due. ``force`` asks every watched artist now."""
    stats = stats if stats is not None else {}
    stats.setdefault("asked", 0)
    stats.setdefault("releases", 0)
    conf = settings()
    if not conf["on"]:
        stats["skipped"] = "off"
        return stats
    every = datetime.timedelta(hours=conf["every"])
    today = now().date()
    since = (today - datetime.timedelta(days=conf["window"])).isoformat()
    for provider in _providers(app):
        pid = provider.id
        try:
            favs = favourite_refs(pid)
            heard = {r: nm for r, nm in listened_refs(pid).items() if r not in favs}
            # 1. the favourites' neighbourhood, weekly
            linked = {
                r: at
                for r, at in ArtistWatch.select(ArtistWatch.ref, ArtistWatch.linked)
                .where(ArtistWatch.provider == pid)
                .tuples()
            }
            link_sources = dict(favs)
            for ref in list(heard)[:LINKS_OF_LISTENED]:
                link_sources.setdefault(ref, heard[ref])
            for ref, name in link_sources.items():
                at = linked.get(ref)
                if not force and at is not None and now() - at < LINK_EVERY:
                    continue
                others = _ask(provider, "similar_artists", ref, stats)
                if others is not None:
                    _store_links(pid, ref, others)
                    for o in others[:TOPS_OF]:
                        oref = str(o.get("ref") or "")
                        if not oref:
                            continue
                        fresh = ArtistTop.select().where(
                            (ArtistTop.provider == pid) & (ArtistTop.artist_ref == oref)
                            & (ArtistTop.fetched > now() - LINK_EVERY)
                        ).exists()
                        if fresh and not force:
                            continue
                        _pause(stats)
                        hits = _ask(provider, "artist_top", oref, stats)
                        if hits is not None:
                            _store_tops(pid, oref, o.get("name"), hits)
                _watch(pid, ref, name, linked=now())
                _pause(stats)
            # 2. who is watched: the favourites and their nearest
            close = close_refs(pid, favs, conf["close"])
            wanted = dict(favs)
            for ref, name in heard.items():
                if len(wanted) >= WATCH_MAX:
                    break
                wanted.setdefault(ref, name)
            for ref, (name, _pic) in close.items():
                wanted.setdefault(ref, name)
            ArtistWatch.delete().where(
                (ArtistWatch.provider == pid) & ArtistWatch.ref.not_in(list(wanted) or [""])
            ).execute()
            for ref, name in wanted.items():
                _watch(pid, ref, name)
            # 3. the releases of whoever is due
            due = ArtistWatch.select(ArtistWatch.ref, ArtistWatch.name).where(
                ArtistWatch.provider == pid
            )
            if not force:
                due = due.where(
                    ArtistWatch.checked.is_null(True) | (ArtistWatch.checked < now() - every)
                )
            for ref, name in list(due.order_by(ArtistWatch.checked).tuples()):
                got = _ask(provider, "artist_releases", ref, stats)
                if got is not None:
                    stats["releases"] += _store_releases(pid, ref, name, got, since)
                ArtistWatch.update(checked=now()).where(
                    (ArtistWatch.provider == pid) & (ArtistWatch.ref == ref)
                ).execute()
                _pause(stats)
        except _Stop:
            stats["stopped"] = pid
            logger.info("Releases: %s does not answer; the rest waits for the next tick", pid)
            continue
    cutoff = (today - datetime.timedelta(days=KEEP_DAYS)).isoformat()
    ArtistRelease.delete().where(ArtistRelease.released < cutoff).execute()
    return stats


def _watch(provider_id, ref, name, linked=None):
    row = ArtistWatch.get_or_none((ArtistWatch.provider == provider_id) & (ArtistWatch.ref == ref))
    if row is None:
        from .db import db

        try:
            with db.atomic():
                ArtistWatch.create(provider=provider_id, ref=ref, name=(name or ref)[:255], linked=linked)
        except Exception:  # created meanwhile by another run
            logger.debug("releases: %s/%s watched meanwhile", provider_id, ref)
        return
    changes = {}
    if linked is not None:
        changes["linked"] = linked
    if name and row.name != name[:255]:
        changes["name"] = name[:255]
    if changes:
        ArtistWatch.update(**changes).where(
            (ArtistWatch.provider == provider_id) & (ArtistWatch.ref == ref)
        ).execute()


# -- the thread ---------------------------------------------------------------------


def status() -> dict:
    with _lock:
        out = dict(_status)
    out["watched"] = ArtistWatch.select().count()
    out["favourites"] = len(favourite_refs("deezer"))
    out["releases"] = ArtistRelease.select().count()
    out["links"] = ArtistLink.select().count()
    out.update(settings())
    return out


def run_now(app, force=True) -> bool:
    """Start a pass on a thread unless one is running. False when one was."""
    with _lock:
        if _status["running"]:
            return False
        _status["running"] = True
    threading.Thread(target=_guarded, args=(app, force), name="releases-now", daemon=True).start()
    return True


def _guarded(app, force=False):
    stats = {}
    try:
        open_connection(reuse=True)
        run_once(app, force=force, stats=stats)
        with _lock:
            _status["last_error"] = None
    except Exception as exc:
        logger.warning("Releases check failed: %s", exc, exc_info=True)
        with _lock:
            _status["last_error"] = str(exc)[:200]
    finally:
        with _lock:
            _status["running"] = False
            _status["last_run"] = now().isoformat()
            _status["asked"] = stats.get("asked", 0)
            if stats.get("stopped"):
                _status["last_error"] = f"{stats['stopped']} ne répond pas : repris plus tard"
        try:
            close_connection()
        except Exception:
            logger.debug("releases: close_connection failed", exc_info=True)


def _loop(app):
    try:
        from .deezer import workload

        workload.renice()
    except Exception:
        logger.debug("releases: renice failed", exc_info=True)
    time.sleep(BOOT_DELAY)
    while True:
        with _lock:
            busy = _status["running"]
            if not busy:
                _status["running"] = True
        if not busy:
            _guarded(app)
        time.sleep(TICK)


def start(app):
    """Start the background thread once per process (never under test)."""
    global _thread
    if app.testing or _thread is not None:
        return None
    _thread = threading.Thread(target=_loop, args=(app,), name="releases", daemon=True)
    _thread.start()
    return _thread

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What a person's OWN account brings into their library (plan multi-provider
§15, lot P2): its favourite artists (followed, so their releases reach
Nouveautés), its loved tracks, its saved albums, its playlists.

Rules, each of which answers a way this goes wrong:

- **Each item is imported ONCE** (``library_item``). After that the local
  library is the one that counts: an artist unfollowed here, a star taken off a
  track, is not put back by tomorrow's import because the account still lists
  it. What the account ADDS later is imported on the next run.
- **Unticked is never imported** (``excluded``): the person's choice, kept
  until they tick it again. Unticking an artist or an album also takes its star
  off; a playlist already imported stays theirs (deleting somebody's playlist
  is not what "do not import it" means).
- **Read only.** Nothing is written to the account; the provider is asked for
  lists, and for the tracklists of the albums and playlists being imported.
- **A failure is not a verdict.** A refused credential marks the account
  (``status = "auth"``) and stops the automatic runs until it is linked again;
  the provider not answering is retried an hour later; nothing is removed.
- **Nothing is downloaded to import.** Rows are made from the provider's own
  listing; a starred track is archived the way every starred track is.

- **One platform syncs a person's favourites: their DEFAULT one** (``primary``
  in the account's options). Only that account is read again every day; any
  other linked account imports when its holder presses its button or ticks an
  item. Choosing a default imports from it at once. A person who never chose
  has their Deezer as default (what the old nightly sync mirrored).
- **An upgrade never re-creates what was removed here.** The old nightly sync
  mirrored the server account's favourites; the first run on that account, for
  a kind its holder already holds Deezer rows of, is a BASELINE: everything
  the account lists is recorded as seen, and only what is still here counts
  (``_baseline_wanted``). What the account lists and the library does not hold
  was taken off here, and stays off.
- **A run never holds the database for long and never competes with a
  person.** Each batch is its own short transaction, the thread is reniced, and
  between batches it waits for any foreground work to finish
  (``workload.quiet_wait``). Its progress (which list, how many of how many) is
  live in ``status``.

Runs happen when an account is linked, when it is made the default, from the
person's button, and once a day from the watcher for the default account
(never under test).
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import timedelta

from peewee import fn

from .db import (
    Album,
    Artist,
    EntityRef,
    LibraryItem,
    Playlist,
    PlaylistTrack,
    ProviderAccount,
    ServiceLink,
    StarredAlbum,
    StarredArtist,
    StarredTrack,
    Track,
    close_connection,
    db,
    now,
    open_connection,
)
from .providers.errors import ProviderAuth, ProviderError, ProviderUnavailable

logger = logging.getLogger(__name__)

KINDS = ("artists", "tracks", "albums", "playlists")
PICKABLE = ("artists", "albums", "playlists")  # listed one by one, to choose from
FEATURE = {
    "artists": "my_artists",
    "tracks": "my_tracks",
    "albums": "my_albums",
    "playlists": "my_playlists",
}
# On linking: the artists (what Nouveautés follows) and the loved tracks. An
# album or a playlist is a bigger thing to find in one's library unasked.
DEFAULT_AUTO = {"artists": True, "tracks": True, "albums": False, "playlists": False}
PROVIDERS = ("deezer", "youtube")
ENTITY_KIND = {"artists": "artist", "albums": "album", "playlists": "playlist"}

EVERY = timedelta(hours=24)
RETRY_NETWORK = timedelta(hours=1)
TICK = 30 * 60
BOOT_DELAY = 180
LISTING_TTL = 600
CHUNK = 200  # tracks asked of Deezer per call, ids per IN list
MAX_ITEMS = 20000  # an account's list is cut there (a malformed answer, not a library)


# -- options ------------------------------------------------------------------


def options(row) -> dict:
    try:
        raw = json.loads(row.options or "{}")
    except ValueError:
        raw = {}
    if not isinstance(raw, dict):  # "null", a list: written by hand, or by nobody
        raw = {}
    auto = dict(DEFAULT_AUTO)
    for k, v in (raw.get("auto") or {}).items():
        if k in auto:
            auto[k] = bool(v)
    last = raw.get("last") if isinstance(raw.get("last"), dict) else None
    lossless = raw.get("lossless") if isinstance(raw.get("lossless"), bool) else None
    # None: its holder never chose a default platform (see ``default_account``).
    primary = raw.get("primary") if isinstance(raw.get("primary"), bool) else None
    return {"auto": auto, "last": last, "lossless": lossless, "primary": primary}


def _save_options(row, opts):
    row.options = json.dumps(
        {
            "auto": opts["auto"],
            "last": opts.get("last"),
            "lossless": opts.get("lossless"),
            "primary": opts.get("primary"),
        }
    )
    ProviderAccount.update(options=row.options).where(ProviderAccount.id == row.id).execute()


def set_auto(row, changes: dict) -> dict:
    opts = options(row)
    for k, v in (changes or {}).items():
        if k in opts["auto"]:
            opts["auto"][k] = bool(v)
    _save_options(row, opts)
    return opts


# -- the default platform ------------------------------------------------------


def _default_of(rows):
    """The default account among one person's ``rows``: the one they chose; none
    when they chose none; their Deezer (else their first account) when they
    never chose — what the old nightly sync mirrored, kept on an upgrade."""
    chosen = [(r, options(r)["primary"]) for r in rows]
    for r, flag in chosen:
        if flag is True:
            return r
    if any(flag is False for _, flag in chosen):
        return None
    for r in rows:
        if r.provider == "deezer":
            return r
    return rows[0] if rows else None


def _rows_of(user_id):
    return list(
        ProviderAccount.select()
        .where((ProviderAccount.user == user_id) & ProviderAccount.provider.in_(list(SOURCES)))
        .order_by(ProviderAccount.created, ProviderAccount.provider)
    )


def default_account(user_id):
    return _default_of(_rows_of(user_id))


def keep_default(user_id, new_account_id):
    """A person links another account: their default stays the one it was. When
    they never chose, the choice the rule made for them is written down, so the
    new account (a Deezer next to a YouTube Music, say) does not take over."""
    rows = _rows_of(user_id)
    others = [r for r in rows if str(r.id) != str(new_account_id)]
    if not others or any(options(r)["primary"] is not None for r in others):
        for r in rows:
            if str(r.id) == str(new_account_id) and options(r)["primary"] is None and others:
                opts = options(r)
                opts["primary"] = False
                _save_options(r, opts)
        return
    current = _default_of(others)
    for r in rows:
        opts = options(r)
        opts["primary"] = current is not None and r.id == current.id
        _save_options(r, opts)


def set_default(app, user_id, account_id) -> bool:
    """Make ``account_id`` the person's default platform (None: none of them).
    Every one of their accounts records the choice, so a later link does not
    take it over. The new default imports at once. Returns whether it started."""
    rows = _rows_of(user_id)
    target = None
    for r in rows:
        on = account_id is not None and str(r.id) == str(account_id)
        if on:
            target = r
        opts = options(r)
        if opts["primary"] is not on:
            opts["primary"] = on
            _save_options(r, opts)
    if target is None or target.status == "auth":
        return False
    return start(app, target.id)


# -- credentials --------------------------------------------------------------


_clients: dict = {}
_clients_lock = threading.Lock()


def _decrypt(blob):
    from .managers.user import decrypt_password

    try:
        return decrypt_password(blob) if blob else None
    except Exception:
        return None  # a rotated server secret: the same as no credential


def _archive_dir(app):
    return (app.config.get("DEEZER") or {}).get("archive_dir")


def _deezer_client(app, row):
    """The DeezerProvider signed in as the account: the server's own object for
    the server account, a personal one (kept per account) otherwise."""
    from .access import SERVER

    if row.mode == SERVER:
        client = getattr(app, "deezer", None)
        if client is None:
            raise ProviderAuth("Deezer est désactivé sur ce serveur", provider="deezer")
        return client
    arl = _decrypt(row.secret)
    if not arl:
        raise ProviderAuth("aucun ARL enregistré pour ce compte", provider="deezer")
    key = str(row.id)
    with _clients_lock:
        held = _clients.get(key)
        if held is not None and held[0] == row.secret:
            return held[1]
        from .deezer.provider import DeezerProvider

        cfg = app.config.get("DEEZER") or {}
        client = DeezerProvider(arl, _archive_dir(app), cfg.get("quality") or "FLAC")
        _clients[key] = (row.secret, client)
        return client


def forget_client(account_id):
    with _clients_lock:
        held = _clients.pop(str(account_id), None)
    dz = getattr(held[1], "_dz", None) if held else None
    if dz is not None:
        try:
            dz.close()
        except Exception:
            logger.debug("library import: close failed", exc_info=True)


def _youtube_client(row):
    from .services import ytmusic

    link = ServiceLink.get_or_none(
        (ServiceLink.user == row.user_id) & (ServiceLink.service == "youtube")
    )
    headers = _decrypt(link.data) if link is not None else None
    if not headers:
        raise ProviderAuth("aucune session YouTube Music reliée", provider="youtube")
    return ytmusic.Client(headers)


# -- the two sources -----------------------------------------------------------


def _star(model, user_id, ids):
    ids = list(dict.fromkeys(ids))
    for i in range(0, len(ids), CHUNK):
        model.insert_many(
            [{"user": user_id, "starred": x, "date": now()} for x in ids[i : i + CHUNK]]
        ).on_conflict_ignore().execute()
    return len(ids)


def _save_playlist(user, local_id, name, comment, tracks, deezer_ref=None):
    """Create the person's playlist, or append the tracks it lacks (merge: an
    existing playlist keeps its name, order and every track). A playlist of the
    same id that is SOMEBODY ELSE'S is never touched: this one gets its own id."""
    existing = Playlist.get_or_none(Playlist.id == local_id)
    if existing is not None and existing.user_id != user.id:
        local_id = uuid.uuid5(local_id, str(user.id))
        existing = Playlist.get_or_none(Playlist.id == local_id)
        deezer_ref = None
    with db.atomic():
        if existing is None:
            existing = Playlist.create(
                id=local_id, user=user, name=(name or "Playlist")[:255],
                comment=(comment or None) and comment[:255], deezer_id=deezer_ref,
            )
            have, index = set(), -1
        else:
            have = {
                r for (r,) in PlaylistTrack.select(PlaylistTrack.track)
                .where(PlaylistTrack.playlist == existing.id).tuples()
            }
            last = (
                PlaylistTrack.select(fn.MAX(PlaylistTrack.index))
                .where(PlaylistTrack.playlist == existing.id).scalar()
            )
            index = -1 if last is None else last
        rows = []
        for t in tracks:
            if t.id in have:
                continue
            have.add(t.id)
            index += 1
            rows.append({"id": uuid.uuid4(), "playlist": existing.id, "track": t.id, "index": index})
        for i in range(0, len(rows), CHUNK):
            PlaylistTrack.insert_many(rows[i : i + CHUNK]).execute()
    return existing


class DeezerSource:
    provider = "deezer"

    def __init__(self, app, row):
        from .providers.deezer import DeezerAdapter

        self.app = app
        self.client = _deezer_client(app, row)
        self.adapter = DeezerAdapter(lambda: self.client)
        self._cache = None
        self._root = None

    def _errors(self, exc):
        """A Deezer failure as what it says: a refused ARL, Deezer not
        answering, or Deezer answering something else."""
        from deezerpy.errors import is_transport_failure

        if isinstance(exc, ProviderError):
            return exc
        login = getattr(self.client, "_login_error", None)
        if login and login[0] == "arl":
            return ProviderAuth(login[1], provider="deezer")
        if is_transport_failure(exc):
            return ProviderUnavailable(str(exc), provider="deezer")
        return ProviderError(str(exc) or exc.__class__.__name__, provider="deezer")

    def _call(self, fn_, *args, **kwargs):
        try:
            return fn_(*args, **kwargs)
        except Exception as exc:
            raise self._errors(exc) from exc

    def account_name(self):
        return self._call(lambda: self.client.dz.current_user.get("name")) or "Deezer"

    def listing(self, kind):
        if kind == "tracks":
            raw = self._call(lambda: self.client.dz.gw.get_user_favorite_ids(limit=100000)) or {}
            return [{"ref": str(x["SNG_ID"])} for x in raw.get("data", []) if x.get("SNG_ID")]
        return self._call(lambda: list(self.adapter.library(kind, account=self.client)))

    def _upsert(self, raw):
        from .deezer import library

        if self._root is None:
            self._root = library.get_root_folder(self.client.archive_dir)
            self._cache = library.ImportCache()
        out = []
        for t in raw or []:
            if t and t.get("SNG_ID") and str(t.get("SNG_ID")) != "0":
                out.append(
                    library.upsert_track(t, self._root, self.client.default_quality, cache=self._cache)
                )
        return out

    def apply(self, kind, items, user):
        from .deezer import ids, library

        if kind == "tracks":
            refs = [i["ref"] for i in items]
            tracks = []
            for i in range(0, len(refs), CHUNK):
                raw = self._call(self.client.dz.gw.get_tracks, refs[i : i + CHUNK])
                with db.atomic():
                    tracks += self._upsert(raw)
            return _star(StarredTrack, user.id, [t.id for t in tracks])
        if kind == "artists":
            rows = [library.upsert_artist(i["ref"], i.get("name") or "") for i in items]
            return _star(StarredArtist, user.id, [a.id for a in rows])
        if kind == "albums":
            starred = []
            for item in items:
                raw = self._call(self.client.dz.gw.get_album_tracks, item["ref"])
                with db.atomic():
                    self._upsert(raw)
                    album = Album.get_or_none(Album.id == ids.album_uuid(item["ref"]))
                    if album is None:
                        first = (item.get("artists") or [{}])[0]
                        artist = library.upsert_artist(first.get("ref") or 0, first.get("name") or "")
                        album = library.upsert_album(
                            item["ref"], item.get("title") or "", artist, item.get("picture")
                        )
                starred.append(album.id)
            return _star(StarredAlbum, user.id, starred)
        if kind == "playlists":
            for item in items:
                raw = self._call(self.client.dz.gw.get_playlist_tracks, item["ref"])
                with db.atomic():
                    tracks = self._upsert(raw)
                _save_playlist(
                    user, ids.playlist_uuid(item["ref"]), item.get("title"),
                    item.get("description"), tracks, deezer_ref=str(item["ref"]),
                )
            return len(items)
        return 0

    @staticmethod
    def local_ids(kind, refs):
        from .deezer import ids

        make = {"artists": ids.artist_uuid, "albums": ids.album_uuid, "playlists": ids.playlist_uuid}
        return {r: make[kind](r) for r in refs}


class YoutubeSource:
    provider = "youtube"

    def __init__(self, app, row):
        from .providers.youtube import YoutubeAdapter

        self.app = app
        self.client = _youtube_client(row)
        self.adapter = YoutubeAdapter()

    def account_name(self):
        try:
            return self.client.account()
        except Exception as exc:
            from .services import ServiceAuthError

            if isinstance(exc, ServiceAuthError):
                raise ProviderAuth(str(exc), provider="youtube") from exc
            raise ProviderUnavailable(str(exc), provider="youtube") from exc

    def listing(self, kind):
        return list(self.adapter.library(kind, account=self.client))

    def _tracks(self, hits):
        from .deezer import youtube as yt
        from .providers.youtube import youtube_from_hit

        archive_dir = _archive_dir(self.app)
        return [yt.upsert_track(youtube_from_hit(h), archive_dir) for h in hits]

    def _artist(self, ref, name):
        """The library's artist of that name when there is one (the same person
        is not a second row because YouTube spells their id differently), else
        a row of YouTube's own. Either way the ref is remembered."""
        from .deezer import ids, library
        from .sources import attach_entity

        row = None
        if name:
            row = (
                Artist.select()
                .where(fn.LOWER(Artist.name) == name.lower())
                .order_by(Artist.deezer_id.is_null(), Artist.id)
                .first()
            )
        if row is None:
            aid = ids.youtube_artist_uuid(ref)
            row = Artist.get_or_none(Artist.id == aid) or library.create_or_get(
                lambda: Artist.create(id=aid, name=name or "[unknown]", deezer_id=None),
                lambda: Artist.get_or_none(Artist.id == aid),
            )
        attach_entity("artist", "youtube", ref, row.id)
        return row

    def apply(self, kind, items, user):
        from .deezer import ids
        from .sources import attach_entity

        if kind == "tracks":
            with db.atomic():
                tracks = self._tracks(items)
            return _star(StarredTrack, user.id, [t.id for t in tracks])
        if kind == "artists":
            rows = [self._artist(i["ref"], i.get("name") or "") for i in items]
            return _star(StarredArtist, user.id, [a.id for a in rows])
        if kind == "albums":
            starred = []
            for item in items:
                hits = list(self.adapter.library_album(item["ref"], self.client))
                with db.atomic():
                    tracks = self._tracks(hits)
                album_id = tracks[0].album_id if tracks else None
                if album_id is not None:
                    attach_entity("album", "youtube", item["ref"], album_id)
                    starred.append(album_id)
            return _star(StarredAlbum, user.id, starred)
        if kind == "playlists":
            for item in items:
                hits = list(self.adapter.library_playlist(item["ref"], self.client))
                with db.atomic():
                    tracks = self._tracks(hits)
                local = ids.entity_uuid("youtube", "playlist", item["ref"])
                pl = _save_playlist(user, local, item.get("title"), item.get("description"), tracks)
                attach_entity("playlist", "youtube", item["ref"], pl.id)
            return len(items)
        return 0

    @staticmethod
    def local_ids(kind, refs):
        from .deezer import ids

        out = {}
        refs = list(refs)
        for i in range(0, len(refs), CHUNK):
            for ref, entity in (
                EntityRef.select(EntityRef.ref, EntityRef.entity)
                .where(
                    (EntityRef.kind == ENTITY_KIND[kind])
                    & (EntityRef.provider == "youtube")
                    & EntityRef.ref.in_(refs[i : i + CHUNK])
                )
                .tuples()
            ):
                out[ref] = entity
        if kind == "albums":
            for r in refs:
                out.setdefault(r, ids.youtube_album_uuid(r))
        return out


SOURCES = {"deezer": DeezerSource, "youtube": YoutubeSource}


def source_for(app, row):
    cls = SOURCES.get(row.provider)
    if cls is None:
        raise ProviderError(f"{row.provider}: no library import", provider=row.provider)
    return cls(app, row)


# -- the items already seen ---------------------------------------------------


def _known(account_id, kind):
    """``{ref: excluded}`` of the items this account's import has seen."""
    return {
        ref: bool(ex)
        for ref, ex in LibraryItem.select(LibraryItem.ref, LibraryItem.excluded)
        .where((LibraryItem.account == str(account_id)) & (LibraryItem.kind == kind))
        .tuples()
    }


def _remember(account_id, kind, refs):
    rows = [{"account": str(account_id), "kind": kind, "ref": str(r)[:64]} for r in refs]
    for i in range(0, len(rows), CHUNK):
        LibraryItem.insert_many(rows[i : i + CHUNK]).on_conflict_ignore().execute()


def forget_account(account_id):
    LibraryItem.delete().where(LibraryItem.account == str(account_id)).execute()
    forget_client(account_id)
    with _listing_lock:
        for key in [k for k in _listings if k[0] == str(account_id)]:
            _listings.pop(key, None)


# -- one run ------------------------------------------------------------------


_runs: dict = {}  # account id -> live progress of a run in flight
_runs_lock = threading.Lock()


def status(account_id):
    with _runs_lock:
        live = _runs.get(str(account_id))
        return dict(live) if live else None


def _note(account_id, **fields):
    with _runs_lock:
        live = _runs.get(str(account_id))
        if live is not None:
            live.update(fields)


BATCH = {"tracks": CHUNK, "artists": CHUNK, "albums": 5, "playlists": 1}
PAUSE = 0.05  # between two batches: the server's other threads get the database


def _mirrored_before(row, kind) -> bool:
    """Whether the OLD nightly sync mirrored this account's ``kind`` into its
    holder's library: the server account, whose holder already holds Deezer rows
    of that kind. Its first run is then a baseline (see the module's rules)."""
    from .access import SERVER

    if row.provider != "deezer" or row.mode != SERVER:
        return False
    uid = row.user_id
    if kind == "tracks":
        q = StarredTrack.select().join(Track, on=(StarredTrack.starred == Track.id)).where(
            (StarredTrack.user == uid) & Track.deezer_id.is_null(False)
        )
    elif kind == "artists":
        q = StarredArtist.select().join(Artist, on=(StarredArtist.starred == Artist.id)).where(
            (StarredArtist.user == uid) & Artist.deezer_id.is_null(False)
        )
    elif kind == "albums":
        q = StarredAlbum.select().join(Album, on=(StarredAlbum.starred == Album.id)).where(
            (StarredAlbum.user == uid) & Album.deezer_id.is_null(False)
        )
    else:
        q = Playlist.select().where((Playlist.user == uid) & Playlist.deezer_id.is_null(False))
    return q.exists()


def _yield():
    """Between two batches: let whatever a person is waiting on go first."""
    try:
        from .deezer import workload

        workload.quiet_wait(2.0)
    except Exception:
        logger.debug("library import: quiet_wait failed", exc_info=True)
    time.sleep(PAUSE)


def run(app, account_id, kinds=None, only=None) -> dict:
    """Import what is new in the account (``kinds``: those asked, else the ones
    its options import automatically; ``only``: ``{kind: [item]}``, those very
    items, ticked by the person). Synchronous; returns the run's report and
    writes it into the account's options. Each batch is remembered as it is
    done, so a run cut short (a restart, an outage) resumes where it stopped."""
    row = ProviderAccount.get_or_none(ProviderAccount.id == account_id)
    if row is None or row.user_id is None:
        return {"error": "compte inconnu"}
    user = row.user
    opts = options(row)
    if only:
        todo = [k for k in KINDS if k in only]
    else:
        todo = [k for k in KINDS if (kinds is None and opts["auto"][k]) or (kinds and k in kinds)]
    report = {"at": now().isoformat(), "added": {}, "error": None, "reason": None}
    kept = {}  # kind -> refs a baseline recorded without importing
    try:
        _note(account_id, kind=None, phase="connect", done=0, total=None)
        source = source_for(app, row)
        for kind in todo:
            _note(account_id, kind=kind, phase="list", done=0, total=None)
            known = _known(row.id, kind)
            if only:
                items = [i for i in only[kind] if not known.get(str(i["ref"]))]
            else:
                listed = source.listing(kind)[:MAX_ITEMS]
                if not known and _mirrored_before(row, kind):
                    refs = [str(i["ref"]) for i in listed]
                    _remember(row.id, kind, refs)
                    kept[kind] = len(refs)
                    report["added"][kind] = 0
                    continue
                items = [i for i in listed if str(i["ref"]) not in known]
            added = 0
            step = BATCH[kind]
            _note(account_id, phase="import", done=0, total=len(items))
            for i in range(0, len(items), step):
                batch = items[i : i + step]
                added += source.apply(kind, batch, user) or 0
                _remember(row.id, kind, [x["ref"] for x in batch])
                report["added"][kind] = added
                _note(account_id, done=min(i + step, len(items)), added=dict(report["added"]))
                if i + step < len(items):
                    _yield()
            report["added"][kind] = added
            _note(account_id, added=dict(report["added"]))
        row.status = "ok"
    except ProviderAuth as exc:
        report["error"], report["reason"] = str(exc)[:200], "auth"
        row.status = "auth"
    except ProviderUnavailable as exc:
        report["error"], report["reason"] = str(exc)[:200], "network"
        row.status = "network"
    except Exception as exc:  # a run must end with a report, whatever happened
        logger.warning("Library import of account %s failed", row.id, exc_info=True)
        report["error"], report["reason"] = (str(exc) or exc.__class__.__name__)[:200], "error"
    if kept:
        report["kept"] = kept
    ProviderAccount.update(status=row.status, checked=now()).where(
        ProviderAccount.id == row.id
    ).execute()
    if not only:
        opts = options(ProviderAccount.get_by_id(row.id))  # the default may have moved meanwhile
        opts["last"] = report
        _save_options(row, opts)
    if any(report["added"].values()):
        with _listing_lock:
            for key in [k for k in _listings if k[0] == str(row.id)]:
                _listings.pop(key, None)
    return report


def start(app, account_id, kinds=None, only=None) -> bool:
    """``run`` on a thread, one at a time per account. False when one runs."""
    key = str(account_id)
    with _runs_lock:
        if key in _runs:
            return False
        _runs[key] = {"running": True, "kind": None, "phase": "connect", "done": 0, "total": None, "added": {}}

    def work(own_connection=True):
        try:
            if own_connection:
                open_connection(reuse=True)
                try:
                    from .deezer import workload

                    workload.renice()  # this thread only: behind every request
                except Exception:
                    logger.debug("library import: renice failed", exc_info=True)
            run(app, account_id, kinds=kinds, only=only)
        finally:
            with _runs_lock:
                _runs.pop(key, None)
            if own_connection:
                try:
                    close_connection()
                except Exception:
                    logger.debug("library import: close_connection failed", exc_info=True)

    if app.testing:
        # Under test nothing runs behind the test's back (a real provider would
        # be asked); a test that wants the run says so and sees it through.
        if app.config.get("LIBRARY_IMPORT_INLINE"):
            work(own_connection=False)
        else:
            with _runs_lock:
                _runs.pop(key, None)
        return True
    threading.Thread(target=work, name=f"library-import-{key[:8]}", daemon=True).start()
    return True


# -- the picker ---------------------------------------------------------------


_listings: dict = {}  # (account id, kind) -> (time, items)
_listing_lock = threading.Lock()


def listing(app, row, kind, fresh=False):
    """The account's items of ``kind``, each with ``on`` (not unticked) and
    ``in_library`` (starred here / the playlist exists). Kept ten minutes: the
    picker is opened, scrolled and ticked without asking again."""
    key = (str(row.id), kind)
    with _listing_lock:
        held = _listings.get(key)
    if held is None or fresh or time.monotonic() - held[0] > LISTING_TTL:
        items = source_for(app, row).listing(kind)[:MAX_ITEMS]
        held = (time.monotonic(), items)
        with _listing_lock:
            _listings[key] = held
    items = held[1]
    known = _known(row.id, kind)
    source_cls = SOURCES[row.provider]
    local = source_cls.local_ids(kind, [str(i["ref"]) for i in items])
    present = _present(row, kind, list(local.values()))
    out = []
    for i in items:
        ref = str(i["ref"])
        entity = local.get(ref)
        out.append(
            dict(
                i,
                ref=ref,
                on=not known.get(ref, False),
                imported=ref in known,
                in_library=entity is not None and str(entity) in present,
            )
        )
    return out


def _present(row, kind, entities):
    entities = [e for e in entities if e is not None]
    found = set()
    for i in range(0, len(entities), CHUNK):
        part = entities[i : i + CHUNK]
        if kind == "artists":
            q = StarredArtist.select(StarredArtist.starred).where(
                (StarredArtist.user == row.user_id) & StarredArtist.starred.in_(part)
            )
        elif kind == "albums":
            q = StarredAlbum.select(StarredAlbum.starred).where(
                (StarredAlbum.user == row.user_id) & StarredAlbum.starred.in_(part)
            )
        else:
            q = Playlist.select(Playlist.id).where(
                (Playlist.user == row.user_id) & Playlist.id.in_(part)
            )
        found.update(str(x) for (x,) in q.tuples())
    return found


def set_items(app, row, kind, refs, on):
    """Tick or untick items. Unticked: never imported again, and an artist's
    or an album's star comes off (a playlist stays). Ticked: imported now, on
    a thread (``imported`` False when a run already in flight holds the
    account: the next run takes them). Returns ``{"on", "imported"}``."""
    refs = list(dict.fromkeys(str(r)[:64] for r in refs))
    account = str(row.id)
    if on:
        for i in range(0, len(refs), CHUNK):
            LibraryItem.delete().where(
                (LibraryItem.account == account) & (LibraryItem.kind == kind)
                & LibraryItem.ref.in_(refs[i : i + CHUNK])
            ).execute()
        with _listing_lock:
            held = _listings.get((account, kind))
        wanted = set(refs)
        items = [i for i in (held[1] if held else []) if str(i["ref"]) in wanted]
        started = bool(items) and start(app, row.id, only={kind: items})
        return {"on": True, "imported": started}
    with db.atomic():
        for i in range(0, len(refs), CHUNK):
            part = refs[i : i + CHUNK]
            LibraryItem.update(excluded=True).where(
                (LibraryItem.account == account) & (LibraryItem.kind == kind)
                & LibraryItem.ref.in_(part)
            ).execute()
            LibraryItem.insert_many(
                [{"account": account, "kind": kind, "ref": r, "excluded": True} for r in part]
            ).on_conflict_ignore().execute()
        entities = [e for e in SOURCES[row.provider].local_ids(kind, refs).values() if e is not None]
        model = {"artists": StarredArtist, "albums": StarredAlbum}.get(kind)
        for i in range(0, len(entities), CHUNK) if model is not None else ():
            model.delete().where(
                (model.user == row.user_id) & model.starred.in_(entities[i : i + CHUNK])
            ).execute()
    return {"on": False, "imported": False}


# -- the daily watcher ---------------------------------------------------------


def due(row, at=None) -> bool:
    """Whether the watcher runs this account now: something is imported
    automatically, the credential was not refused, and the last run is a day
    old (an hour, after the provider did not answer)."""
    if row.user_id is None or row.provider not in SOURCES or row.status == "auth":
        return False
    opts = options(row)
    if not any(opts["auto"].values()):
        return False
    last = opts["last"] or {}
    try:
        from datetime import datetime

        when = datetime.fromisoformat(last["at"])
    except (KeyError, TypeError, ValueError):
        return True
    wait = RETRY_NETWORK if last.get("reason") == "network" else EVERY
    at = at or now()
    if when.tzinfo is not None and at.tzinfo is None:
        when = when.replace(tzinfo=None)
    return at - when >= wait


def run_due(app):
    """Each person's DEFAULT account, when it is due. Their other accounts are
    imported only when they ask."""
    rows = {}
    for row in (
        ProviderAccount.select()
        .where(ProviderAccount.provider.in_(list(SOURCES)) & ProviderAccount.user.is_null(False))
        .order_by(ProviderAccount.created, ProviderAccount.provider)
    ):
        rows.setdefault(row.user_id, []).append(row)
    for mine in rows.values():
        row = _default_of(mine)
        if row is not None and due(row):
            start(app, row.id)


_thread = None


def _loop(app):
    try:
        from .deezer import workload

        workload.renice()
    except Exception:
        logger.debug("library import: renice failed", exc_info=True)
    time.sleep(BOOT_DELAY)
    while True:
        try:
            open_connection(reuse=True)
            run_due(app)
        except Exception:
            logger.warning("library import watcher failed", exc_info=True)
        finally:
            try:
                close_connection()
            except Exception:
                logger.debug("library import: close_connection failed", exc_info=True)
        time.sleep(TICK)


def start_watcher(app):
    """The daily import, once per process (never under test)."""
    global _thread
    if app.testing or _thread is not None:
        return None
    _thread = threading.Thread(target=_loop, args=(app,), name="library-import", daemon=True)
    _thread.start()
    return _thread

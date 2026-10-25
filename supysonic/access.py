# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Who may use which provider, for what (plan multi-provider §15).

The rules, in order:

1. what is archived on the server is everybody's: nothing on disk is filtered
   here (private uploads keep their owner rule, elsewhere);
2. a PERSONAL feature (an account's favourites, its playlists) is served to the
   account's holder only, and cannot be lent;
3. a SHARED feature is served to the holder of an account that provides it, and
   to whoever a grant names: ``all``, a group (``g:<id>``) or a person
   (``u:<id>``). A grant on feature ``*`` covers the whole account; a grant
   naming a feature replaces it for that feature, so a feature added later
   inherits the account's setting instead of being closed in silence.

Everything is read in one go and kept until a version in ``Meta`` moves
(checked once a second at most), so a check is a few dictionary lookups: it
runs on every request that might reach a provider.

The upgrade must change nothing: the first time this runs on a server, the
server's Deezer account (the ARL in Meta or the config, left where it is) and
YouTube's anonymous use are granted to ``all`` — exactly what everybody had.
"""

from __future__ import annotations

import logging
import threading
import time

from .providers import features as F

logger = logging.getLogger(__name__)

VERSION_KEY = "acc.v"
BOOT_KEY = "acc.boot"
CACHE_SECONDS = 1.0
ALL = "all"
SERVER = "server"
ANONYMOUS = ""  # the account column of a provider's anonymous use

#: Providers whose anonymous use everybody had before §15, granted to ``all``
#: on the first run.
ANONYMOUS_DEFAULTS = ("youtube",)

_lock = threading.Lock()
_state = None  # (checked monotonic, database, version, Snapshot)
_booted = set()  # the databases whose first run is known done (weakly: tokens)


class Snapshot:
    """The grants, the accounts and the groups, as dictionaries."""

    def __init__(self):
        # (provider, account) -> {feature: frozenset(subjects)}
        self.grants = {}
        # provider -> [(account id, owner user id or None, mode)]
        self.accounts = {}
        # user id -> frozenset(group ids)
        self.groups = {}

    def has_server_account(self):
        return any(m == SERVER for _a, _o, m in self.accounts.get("deezer", ()))

    def subjects_for(self, user_id):
        out = {ALL}
        if user_id:
            out.add(f"u:{user_id}")
            out.update(f"g:{g}" for g in self.groups.get(user_id, ()))
        return out

    def owns(self, user_id, provider):
        return any(owner == user_id for _a, owner, _m in self.accounts.get(provider, ()))

    def holds_server(self, user_id, provider):
        return any(
            owner == user_id and mode == SERVER for _a, owner, mode in self.accounts.get(provider, ())
        )

    def allowed(self, user_id, provider, feature):
        if F.is_personal(feature):
            # Their own favourites and playlists: the holder of an account, no one else.
            return bool(user_id) and self.owns(user_id, provider)
        # A shared feature runs through the server's account (a personal one does
        # not carry the catalogue yet: lot P3), so holding a personal account
        # opens nothing more than the grants already do.
        if user_id and self.holds_server(user_id, provider):
            return True
        mine = self.subjects_for(user_id)
        keys = [(provider, acc) for acc, _o, _m in self.accounts.get(provider, ())]
        keys.append((provider, ANONYMOUS))
        for key in keys:
            per = self.grants.get(key)
            if not per:
                continue
            who = per.get(feature)
            if who is None:
                who = per.get(F.ANY)
            if who and not who.isdisjoint(mine):
                return True
        return False


def _uid(user):
    if user is None:
        return None
    value = getattr(user, "id", user)
    return str(value) if value is not None else None


def _meta_get(key):
    from .db import Meta

    row = Meta.get_or_none(Meta.key == key)
    return row.value if row is not None else None


def _meta_set(key, value):
    from .db import Meta

    row = Meta.get_or_none(Meta.key == key)
    if row is None:
        Meta.create(key=key, value=value)
    else:
        row.value = value
        row.save()


def bump():
    """Tell every process the grants changed."""
    _meta_set(VERSION_KEY, str(time.time_ns()))
    invalidate()


def invalidate():
    global _state
    with _lock:
        _state = None


def _load():
    from .db import ProviderAccount, ProviderGrant, UserGroupMember

    snap = Snapshot()
    for provider, account, feature, subject in ProviderGrant.select(
        ProviderGrant.provider, ProviderGrant.account, ProviderGrant.feature, ProviderGrant.subject
    ).tuples():
        snap.grants.setdefault((provider, account), {}).setdefault(feature, set()).add(subject)
    for key, per in snap.grants.items():
        snap.grants[key] = {f: frozenset(s) for f, s in per.items()}
    for acc, provider, owner, mode in ProviderAccount.select(
        ProviderAccount.id, ProviderAccount.provider, ProviderAccount.user, ProviderAccount.mode
    ).tuples():
        snap.accounts.setdefault(provider, []).append(
            (str(acc), str(owner) if owner is not None else None, mode)
        )
    groups = {}
    for group, user in UserGroupMember.select(UserGroupMember.group, UserGroupMember.user).tuples():
        groups.setdefault(str(user), set()).add(str(group))
    snap.groups = {u: frozenset(g) for u, g in groups.items()}
    return snap


def _database():
    """Which database the snapshot was read from: a process can open another
    one (the tests do, one per test), and a snapshot never crosses over."""
    from .db import db

    obj = db.obj
    token = getattr(obj, "_ns_access", None)
    if token is None:
        # Marked on the object itself: an id() is reused once the previous
        # database object is collected.
        token = object()
        try:
            obj._ns_access = token
        except AttributeError:
            return id(obj)
    return token


def snapshot() -> Snapshot:
    global _state
    now = time.monotonic()
    state = _state
    where = _database()
    running = _deezer_running()
    if (
        state is not None
        and state[1] == where
        and now - state[0] < CACHE_SECONDS
        and not (running and not state[3].has_server_account())
    ):
        return state[3]
    try:
        if where not in _booted:
            if _meta_get(BOOT_KEY) is None:
                bootstrap()
            _booted.add(where)
        version = _meta_get(VERSION_KEY)
        if state is not None and state[1] == where and state[2] == version:
            snap = state[3]
        else:
            snap = _load()
        if running and not snap.has_server_account():
            # Deezer runs and no row says whose account it is: the first run
            # happened before the ARL arrived (saved later, or a proxy built
            # after the app), or the row went with its holder (a deleted
            # user). It is the server's account, open as it always was.
            ensure_server_account()
            version = _meta_get(VERSION_KEY)
            snap = _load()
    except Exception:
        # No table yet (a tool on an old database) or no database at all: fail
        # OPEN for the server account's old behaviour rather than shutting
        # everybody out of a working server; the next check retries.
        logger.debug("access: could not read the grants", exc_info=True)
        snap = Snapshot()
        snap.grants[("deezer", SERVER)] = {F.ANY: frozenset({ALL})}
        snap.accounts["deezer"] = [(SERVER, None, SERVER)]
        for pid in ANONYMOUS_DEFAULTS:
            snap.grants[(pid, ANONYMOUS)] = {F.ANY: frozenset({ALL})}
        return snap
    with _lock:
        _state = (now, where, version, snap)
    return snap


def can(user, provider_id, feature) -> bool:
    """May ``user`` use ``feature`` of ``provider_id``? Instant after the
    first call of the second."""
    return snapshot().allowed(_uid(user), provider_id, feature)


def features_for(user, provider) -> list:
    """The features of ``provider`` (an object) ``user`` may use, for the SPA."""
    snap = snapshot()
    uid = _uid(user)
    return [f for f in F.declared(provider) if snap.allowed(uid, provider.id, f)]


# -- the first run, and the server's account ----------------------------------


def _server_owner():
    """Who holds the server's Deezer account: the configured sync user, else
    the first admin by name (deterministic), else nobody."""
    from flask import current_app, has_app_context

    from .db import User

    name = None
    if has_app_context():
        name = (current_app.config.get("DEEZER") or {}).get("sync_user")
    if name:
        row = User.get_or_none(User.name == name)
        if row is not None:
            return row
    return User.select().where(User.admin == True).order_by(User.name).first()  # noqa: E712


def _deezer_running() -> bool:
    from flask import current_app, has_app_context

    return has_app_context() and getattr(current_app, "deezer", None) is not None


def server_configured() -> bool:
    from flask import current_app, has_app_context

    if not has_app_context():
        return False
    if getattr(current_app, "deezer", None) is not None:
        return True
    from .deezer import stored_arl

    return bool(stored_arl() or (current_app.config.get("DEEZER") or {}).get("arl"))


def ensure_server_account(owner=None, grant_all=True):
    """The row of the server's Deezer account, created if missing (its secret
    stays where it always was: the row only names its holder and its grants).
    Returns it."""
    from .db import ProviderAccount, ProviderGrant, db, now

    row = (
        ProviderAccount.select()
        .where(ProviderAccount.provider == "deezer", ProviderAccount.mode == SERVER)
        .first()
    )
    if row is not None:
        return row
    owner = owner if owner is not None else _server_owner()
    with db.atomic():
        existing = None
        if owner is not None:
            # The holder may already have linked a personal Deezer: that row
            # becomes the server's (one account per person and provider).
            existing = ProviderAccount.get_or_none(
                ProviderAccount.provider == "deezer", ProviderAccount.user == owner
            )
        if existing is not None:
            existing.mode = SERVER
            existing.save()
            row = existing
        else:
            row = ProviderAccount.create(
                provider="deezer", user=owner, label="Compte du serveur", mode=SERVER,
                status="ok", created=now(),
            )
        if grant_all:
            ProviderGrant.insert(
                provider="deezer", account=str(row.id), feature=F.ANY, subject=ALL
            ).on_conflict_ignore().execute()
    bump()
    return row


def bootstrap():
    """The first run on a server: what everybody had before §15, written down
    as grants. Runs once (``acc.boot``), and never takes anything away."""
    from .db import ProviderGrant, db

    with db.atomic():
        if _meta_get(BOOT_KEY) is not None:
            return
        for pid in ANONYMOUS_DEFAULTS:
            ProviderGrant.insert(
                provider=pid, account=ANONYMOUS, feature=F.ANY, subject=ALL
            ).on_conflict_ignore().execute()
        _meta_set(BOOT_KEY, "1")
    if server_configured():
        ensure_server_account()
    bump()


# -- editing -----------------------------------------------------------------


def parse_subject(value):
    """``all``, ``g:<uuid>`` or ``u:<uuid>``, checked against the database;
    None when it names nothing."""
    import uuid

    from .db import User, UserGroup

    value = str(value or "")
    if value == ALL:
        return ALL
    kind, _, ident = value.partition(":")
    try:
        ident = str(uuid.UUID(ident))
    except (ValueError, AttributeError):
        return None
    if kind == "g" and UserGroup.get_or_none(UserGroup.id == ident) is not None:
        return f"g:{ident}"
    if kind == "u" and User.get_or_none(User.id == ident) is not None:
        return f"u:{ident}"
    return None


def set_grants(provider_id, account, feature, subjects):
    """Replace who may use ``feature`` (or ``*``) of an account. ``subjects``
    None removes the per-feature row so the feature follows the account's
    setting again (refused for ``*``)."""
    from .db import ProviderGrant, db

    if feature != F.ANY and feature not in F.CATALOGUE:
        raise ValueError("unknown feature")
    if F.is_personal(feature):
        raise ValueError("a personal feature is never lent")
    with db.atomic():
        ProviderGrant.delete().where(
            ProviderGrant.provider == provider_id,
            ProviderGrant.account == account,
            ProviderGrant.feature == feature,
        ).execute()
        if subjects is None:
            if feature == F.ANY:
                raise ValueError("the account's own setting cannot be removed")
        else:
            for subject in sorted(set(subjects)):
                ProviderGrant.create(
                    provider=provider_id, account=account, feature=feature, subject=subject
                )
    bump()


def grants_of(provider_id, account) -> dict:
    """``{feature: sorted subjects}`` for one account (or the anonymous use)."""
    per = snapshot().grants.get((provider_id, account), {})
    return {f: sorted(s) for f, s in per.items()}


def forget_subject(subject):
    """A group or a person is gone: their grants go with them."""
    from .db import ProviderGrant

    ProviderGrant.delete().where(ProviderGrant.subject == subject).execute()
    bump()


def forget_account(account_id):
    from .db import ProviderGrant

    ProviderGrant.delete().where(ProviderGrant.account == str(account_id)).execute()
    bump()

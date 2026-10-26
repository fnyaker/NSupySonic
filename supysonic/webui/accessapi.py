# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Réglages → Sources et accès: what each provider does, its accounts, and who
may use them (plan multi-provider §15; the rules are in supysonic/access.py).

- ``GET /access``: every provider's declared features (with what each needs and
  the fields an information feature gives), its login modes, its accounts and
  their grants; the groups; the people one may name.
- ``PUT /access/grants``: who may use one feature (or the whole account).
  The holder sets their account's; any admin sets the server account's and a
  provider's anonymous use. A personal feature is never lent.
- ``/groups``: the admin's groups of people.
"""

from __future__ import annotations

import uuid

from flask import current_app, jsonify, request

from .. import access
from ..db import ProviderAccount, User, UserGroup, UserGroupMember, db
from ..providers import base
from ..providers import features as F
from . import admin_required, login_required, webapi

NAME_MAX = 64


def _builtin_classes():
    from ..providers.deezer import DeezerAdapter
    from ..providers.info import AcoustidProvider, LrclibProvider, MusicBrainzProvider
    from ..providers.youtube import YoutubeAdapter

    return (DeezerAdapter, YoutubeAdapter, MusicBrainzProvider, AcoustidProvider, LrclibProvider)


def catalogue():
    """The providers to describe, in the person's order: the registered ones,
    and the built-ins' declarations where they are not registered (a server
    whose registry is still filling up, the tests). The local files are not a
    provider anybody needs access to."""
    reg = getattr(current_app, "providers", None)
    if reg is None:
        found = []
    else:
        # The sources of sound in their order (main first), then the rest.
        found = reg.sound()
        found += [p for p in reg.ordered() if p not in found and p.id != "local"]
    have = {p.id for p in found}
    for cls in _builtin_classes():
        if cls.id not in have:
            found.append(cls)
    return found


def _is_admin(user):
    return bool(user and user.admin)


def _may_edit(user, provider, account_row):
    """The holder edits their account; an admin edits the server's and a
    provider's anonymous use. Facts-only providers have nothing to lend."""
    if provider.role == base.INFO_ROLE:
        return False
    if account_row is None:
        return _is_admin(user)
    if account_row.user_id is not None and str(account_row.user_id) == str(user.id):
        return True
    return _is_admin(user) and account_row.mode == access.SERVER


def _account(provider_id, account_id):
    if account_id == access.ANONYMOUS:
        return None, True
    try:
        uuid.UUID(str(account_id))
    except ValueError:
        return None, False
    row = ProviderAccount.get_or_none(
        ProviderAccount.id == account_id, ProviderAccount.provider == provider_id
    )
    return row, row is not None


def _names(ids):
    if not ids:
        return {}
    return {
        str(i): n for i, n in User.select(User.id, User.name).where(User.id.in_(list(ids))).tuples()
    }


@webapi.route("/access")
@login_required
def access_overview():
    me = request.webuser
    admin = _is_admin(me)
    snap = access.snapshot()
    providers = []
    rows = list(ProviderAccount.select())
    owners = _names({r.user_id for r in rows if r.user_id is not None})
    for p in catalogue():
        desc = F.describe(p)
        accounts = []
        for row in rows:
            if row.provider != p.id:
                continue
            mine = row.user_id is not None and str(row.user_id) == str(me.id)
            editable = _may_edit(me, p, row)
            if not (mine or editable or admin or row.mode == access.SERVER):
                continue  # somebody else's personal account: none of my business
            accounts.append(
                {
                    "id": str(row.id),
                    "mode": row.mode,
                    "label": row.label,
                    "server": row.mode == access.SERVER,
                    "owner": (
                        {"id": str(row.user_id), "name": owners.get(str(row.user_id))}
                        if row.user_id is not None
                        else None
                    ),
                    "mine": mine,
                    "editable": editable,
                    "grants": access.grants_of(p.id, str(row.id)) if editable or mine else {},
                }
            )
        anonymous = None
        if desc["anonymous"] and getattr(p, "anonymous_use", True) and p.role != base.INFO_ROLE:
            anonymous = {
                "editable": _may_edit(me, p, None),
                "grants": access.grants_of(p.id, access.ANONYMOUS),
            }
        desc["accounts"] = accounts
        desc["anonymous_use"] = anonymous
        desc["allowed"] = [f["id"] for f in desc["features"] if snap.allowed(str(me.id), p.id, f["id"])]
        providers.append(desc)

    groups = []
    for g in UserGroup.select().order_by(UserGroup.name):
        entry = {"id": str(g.id), "name": g.name}
        if admin:
            entry["members"] = []
        groups.append(entry)
    if admin and groups:
        index = {g["id"]: g for g in groups}
        for gid, uid, name in (
            UserGroupMember.select(UserGroupMember.group, User.id, User.name)
            .join(User, on=(UserGroupMember.user == User.id))
            .order_by(User.name)
            .tuples()
        ):
            index[str(gid)]["members"].append({"id": str(uid), "name": name})
    out = {"providers": providers, "groups": groups, "me": str(me.id), "admin": admin}
    # The people one may name in a grant: whoever has something to lend.
    if admin or any(a["editable"] for p in providers for a in p["accounts"]):
        out["users"] = [
            {"id": str(i), "name": n}
            for i, n in User.select(User.id, User.name).order_by(User.name).tuples()
        ]
    return jsonify(out)


@webapi.route("/access/grants", methods=["PUT"])
@login_required
def access_set_grants():
    data = request.get_json(silent=True) or {}
    provider_id = str(data.get("provider") or "")
    account_id = str(data.get("account") if data.get("account") is not None else "")
    feature = str(data.get("feature") or "")
    provider = next((p for p in catalogue() if p.id == provider_id), None)
    if provider is None:
        return jsonify({"error": "fournisseur inconnu"}), 404
    row, found = _account(provider_id, account_id)
    if not found:
        return jsonify({"error": "compte inconnu"}), 404
    if not _may_edit(request.webuser, provider, row):
        return jsonify({"error": "forbidden"}), 403
    if feature != F.ANY:
        if feature not in F.declared(provider):
            return jsonify({"error": "fonction inconnue"}), 400
        if F.is_personal(feature):
            return jsonify({"error": "une fonction personnelle ne se prête pas"}), 400
    raw = data.get("subjects")
    if raw is None:
        if feature == F.ANY:
            return jsonify({"error": "subjects requis"}), 400
        subjects = None
    else:
        if not isinstance(raw, list) or len(raw) > 200:
            return jsonify({"error": "subjects invalides"}), 400
        subjects = []
        for item in raw:
            subject = access.parse_subject(item)
            if subject is None:
                return jsonify({"error": "groupe ou personne inconnu"}), 400
            subjects.append(subject)
    access.set_grants(provider_id, account_id, feature, subjects)
    return jsonify({"grants": access.grants_of(provider_id, account_id)})


# -- groups ------------------------------------------------------------------


def _group_name(value):
    name = " ".join(str(value or "").split())
    if not name or len(name) > NAME_MAX:
        return None
    return name


def _group_json(group):
    members = (
        User.select(User.id, User.name)
        .join(UserGroupMember, on=(UserGroupMember.user == User.id))
        .where(UserGroupMember.group == group.id)
        .order_by(User.name)
        .tuples()
    )
    return {
        "id": str(group.id),
        "name": group.name,
        "members": [{"id": str(i), "name": n} for i, n in members],
    }


def _set_members(group, ids):
    wanted = set()
    for item in ids:
        try:
            wanted.add(str(uuid.UUID(str(item))))
        except ValueError:
            return False
    if wanted:
        found = {str(i) for (i,) in User.select(User.id).where(User.id.in_(list(wanted))).tuples()}
        if found != wanted:
            return False
    with db.atomic():
        UserGroupMember.delete().where(UserGroupMember.group == group.id).execute()
        if wanted:
            UserGroupMember.insert_many(
                [{"group": group.id, "user": u} for u in sorted(wanted)]
            ).execute()
    return True


@webapi.route("/groups", methods=["POST"])
@login_required
@admin_required
def group_create():
    data = request.get_json(silent=True) or {}
    name = _group_name(data.get("name"))
    if name is None:
        return jsonify({"error": "nom invalide"}), 400
    if UserGroup.get_or_none(UserGroup.name == name) is not None:
        return jsonify({"error": "ce groupe existe déjà"}), 409
    group = UserGroup.create(name=name)
    members = data.get("members")
    if isinstance(members, list) and not _set_members(group, members[:500]):
        group.delete_instance()
        return jsonify({"error": "membre inconnu"}), 400
    access.bump()
    return jsonify(_group_json(group)), 201


def _group(group_id):
    try:
        uuid.UUID(str(group_id))
    except ValueError:
        return None
    return UserGroup.get_or_none(UserGroup.id == group_id)


@webapi.route("/groups/<group_id>", methods=["PUT"])
@login_required
@admin_required
def group_update(group_id):
    group = _group(group_id)
    if group is None:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(silent=True) or {}
    if "name" in data:
        name = _group_name(data.get("name"))
        if name is None:
            return jsonify({"error": "nom invalide"}), 400
        other = UserGroup.get_or_none(UserGroup.name == name)
        if other is not None and other.id != group.id:
            return jsonify({"error": "ce groupe existe déjà"}), 409
        group.name = name
        group.save()
    if "members" in data:
        members = data.get("members")
        if not isinstance(members, list) or len(members) > 500 or not _set_members(group, members):
            return jsonify({"error": "membre inconnu"}), 400
    access.bump()
    return jsonify(_group_json(group))


@webapi.route("/groups/<group_id>", methods=["DELETE"])
@login_required
@admin_required
def group_delete(group_id):
    group = _group(group_id)
    if group is None:
        return jsonify({"error": "not found"}), 404
    subject = f"g:{group.id}"
    with db.atomic():
        group.delete_instance()  # the members go with it (CASCADE)
        UserGroupMember.delete().where(UserGroupMember.group == group.id).execute()
    access.forget_subject(subject)
    return jsonify({"ok": True})


def me_access(user) -> dict:
    """``{provider: [features this person may use]}``, for ``/api/me``: the
    web app hides what would be refused."""
    snap = access.snapshot()
    out = {}
    deezer_on = getattr(current_app, "deezer", None) is not None
    for p in catalogue():
        if p.role == base.INFO_ROLE or (p.id == "deezer" and not deezer_on):
            continue
        out[p.id] = [f for f in F.declared(p) if snap.allowed(str(user.id), p.id, f)]
    return out

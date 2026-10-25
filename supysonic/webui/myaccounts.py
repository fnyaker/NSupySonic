# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Réglages → Sources → *Mes comptes*: each person's own accounts, and what
they bring into that person's library (the engine is supysonic/libraryimport.py).

- ``GET /me/accounts``: my accounts (the server's Deezer account too, for
  whoever holds it), what each imports automatically and how the last import
  went. A YouTube Music session linked for the export is an account here.
- ``POST /me/accounts/deezer``: link my own Deezer with an ARL (typed, or read
  from Deezer's own login page by the Android app). Checked by signing in.
- ``DELETE /me/accounts/<id>``: unlink it (nothing imported is removed).
- ``PUT /me/accounts/<id>``: what is imported automatically.
- ``PUT /me/accounts/default``: my default platform, the ONE whose favourites
  are synced every day (``{"account": id}``, or null for none). Choosing one
  imports from it at once.
- ``POST /me/accounts/<id>/import``: import what is new now.
- ``GET|PUT /me/accounts/<id>/library/<kind>``: the account's artists, albums
  or playlists, to tick or untick one by one.

Every credential stays the holder's: no route here names or returns one, and
none is open to a remote-control session (``remote.POLICY``: NEVER).
"""

from __future__ import annotations

import logging
import uuid

from flask import current_app, jsonify, request

from .. import access, libraryimport as li
from ..db import ProviderAccount, ServiceLink, now
from ..providers.errors import ProviderAuth, ProviderError, ProviderUnavailable
from . import login_required, webapi

logger = logging.getLogger(__name__)

ARL_MAX = 512
NAMES = {"deezer": "Deezer", "youtube": "YouTube Music"}


def _me():
    return request.webuser


def _row(account_id):
    """My account of that id, or None (somebody else's is as good as absent)."""
    try:
        uuid.UUID(str(account_id))
    except ValueError:
        return None
    row = ProviderAccount.get_or_none(ProviderAccount.id == account_id)
    if row is None or row.user_id is None or str(row.user_id) != str(_me().id):
        return None
    if row.provider not in li.SOURCES:
        return None
    return row


def link_youtube(user_id, label=None):
    """The YouTube Music session linked for the export is also an account to
    import from: its row, made or refreshed. Returns (row, created)."""
    row = ProviderAccount.get_or_none(
        (ProviderAccount.provider == "youtube") & (ProviderAccount.user == user_id)
    )
    created = row is None
    if created:
        row = ProviderAccount.create(
            provider="youtube", user=user_id, label=(label or "YouTube Music")[:64],
            mode="headers", status="ok", checked=now(), created=now(),
        )
        li.keep_default(user_id, row.id)
    else:
        row.status, row.checked = "ok", now()
        if label:
            row.label = label[:64]
        row.save()
    access.bump()
    return row, created


def unlink(row):
    li.forget_account(row.id)
    access.forget_account(row.id)
    if row.provider == "youtube":
        ServiceLink.delete().where(
            (ServiceLink.user == row.user_id) & (ServiceLink.service == "youtube")
        ).execute()
    row.delete_instance()
    access.bump()


def unlink_youtube(user_id):
    row = ProviderAccount.get_or_none(
        (ProviderAccount.provider == "youtube") & (ProviderAccount.user == user_id)
    )
    if row is not None:
        unlink(row)


def _account_json(row, default_id=None):
    opts = li.options(row)
    live = li.status(row.id)
    return {
        "id": str(row.id),
        "provider": row.provider,
        "name": NAMES.get(row.provider, row.provider),
        "label": row.label,
        "mode": row.mode,
        "server": row.mode == access.SERVER,
        "status": row.status,
        "auto": opts["auto"],
        "last": opts["last"],
        "lossless": opts["lossless"],
        "running": live,
        "default": default_id is not None and str(default_id) == str(row.id),
        "kinds": list(li.KINDS),
        "pickable": list(li.PICKABLE),
    }


@webapi.route("/me/accounts")
@login_required
def my_accounts():
    me = _me()
    if (
        ServiceLink.get_or_none((ServiceLink.user == me.id) & (ServiceLink.service == "youtube"))
        is not None
        and ProviderAccount.get_or_none(
            (ProviderAccount.provider == "youtube") & (ProviderAccount.user == me.id)
        )
        is None
    ):
        # Linked for the export before accounts existed: it is one now.
        link = ServiceLink.get((ServiceLink.user == me.id) & (ServiceLink.service == "youtube"))
        link_youtube(me.id, link.account)
    return my_accounts_payload()


def my_accounts_payload(**extra):
    me = _me()
    rows = li._rows_of(me.id)
    holds_server = any(r.mode == access.SERVER for r in rows)
    default = li._default_of(rows)
    default_id = default.id if default is not None else None
    return jsonify(
        {
            "accounts": [_account_json(r, default_id) for r in rows],
            "default": str(default_id) if default_id is not None else None,
            # A personal Deezer next to the server's is one account too many:
            # whoever holds the server's imports from it.
            "can_link": {"deezer": not holds_server},
            **extra,
        }
    )


def _deezer_login(arl):
    """Sign in with ``arl`` once: ``{"id", "name"}`` of the account, or raises
    ProviderAuth (refused) / ProviderUnavailable (Deezer not answering)."""
    from deezerpy.errors import is_transport_failure

    from ..deezer.provider import DeezerProvider

    cfg = current_app.config.get("DEEZER") or {}
    probe = DeezerProvider(arl, cfg.get("archive_dir") or "", cfg.get("quality") or "FLAC")
    try:
        user = probe.dz.current_user or {}
        return {
            "id": str(user.get("id") or ""),
            "name": str(user.get("name") or "Deezer"),
            # Lot P3: an account that cannot stream FLAC never fetches the sound.
            "lossless": bool(user.get("can_stream_lossless")),
        }
    except Exception as exc:
        login = getattr(probe, "_login_error", None)
        if login and login[0] == "arl":
            raise ProviderAuth(login[1], provider="deezer") from exc
        if is_transport_failure(exc) or (login and login[0] == "network"):
            raise ProviderUnavailable(str(exc), provider="deezer") from exc
        raise ProviderError(str(exc), provider="deezer") from exc
    finally:
        dz = getattr(probe, "_dz", None)
        if dz is not None:
            try:
                dz.close()
            except Exception:
                logger.debug("closing a probe session failed", exc_info=True)


def _server_deezer_user_id():
    client = getattr(current_app, "deezer", None)
    dz = getattr(client, "_dz", None) if client is not None else None
    try:
        return str((dz.current_user or {}).get("id") or "") if dz is not None else ""
    except Exception:
        return ""


@webapi.route("/me/accounts/deezer", methods=["POST"])
@login_required
def my_accounts_link_deezer():
    from ..managers.user import encrypt_password

    me = _me()
    data = request.get_json(silent=True) or {}
    arl = "".join(str(data.get("arl") or "").split())
    if not arl or len(arl) > ARL_MAX or not arl.isalnum():
        return jsonify({"error": "Cet ARL n'a pas la forme d'un ARL."}), 400
    row = ProviderAccount.get_or_none(
        (ProviderAccount.provider == "deezer") & (ProviderAccount.user == me.id)
    )
    if row is not None and row.mode == access.SERVER:
        return jsonify(
            {"error": "Votre compte Deezer est celui du serveur : son ARL se change dans Compte Deezer."}
        ), 409
    try:
        who = _deezer_login(arl)
    except ProviderAuth:
        return jsonify({"error": "Deezer refuse cet ARL (expiré, révoqué ou mal copié)."}), 400
    except ProviderUnavailable:
        return jsonify({"error": "Deezer ne répond pas : réessayez dans un moment."}), 503
    except ProviderError:
        logger.warning("linking a Deezer account failed", exc_info=True)
        return jsonify({"error": "Deezer a refusé la connexion pour une autre raison : réessayez plus tard."}), 502
    if who["id"] and who["id"] == _server_deezer_user_id():
        return jsonify(
            {"error": "C'est le compte Deezer du serveur : demandez à son titulaire de vous le prêter (Sources)."}
        ), 409
    blob = encrypt_password(arl)
    mode = "browser" if data.get("mode") == "browser" else "arl"
    if row is None:
        row = ProviderAccount.create(
            provider="deezer", user=me.id, label=who["name"][:64], secret=blob, mode=mode,
            status="ok", checked=now(), created=now(),
        )
    else:
        li.forget_client(row.id)
        row.secret, row.label, row.mode, row.status, row.checked = blob, who["name"][:64], mode, "ok", now()
        row.save()
    opts = li.options(row)
    opts["lossless"] = who.get("lossless", False)
    li._save_options(row, opts)
    li.keep_default(me.id, row.id)
    access.bump()
    default = li.default_account(me.id)
    if default is not None and default.id == row.id:
        # Only the default platform syncs the favourites (and a first account is
        # the default until its holder chooses).
        li.start(current_app._get_current_object(), row.id)
    return jsonify({"account": _account_json(row, default.id if default is not None else None)})


@webapi.route("/me/accounts/<account_id>", methods=["DELETE"])
@login_required
def my_accounts_unlink(account_id):
    row = _row(account_id)
    if row is None:
        return jsonify({"error": "compte inconnu"}), 404
    if row.mode == access.SERVER:
        return jsonify({"error": "Le compte du serveur se règle dans Compte Deezer."}), 409
    unlink(row)
    return jsonify({"ok": True})


@webapi.route("/me/accounts/<account_id>", methods=["PUT"])
@login_required
def my_accounts_options(account_id):
    row = _row(account_id)
    if row is None:
        return jsonify({"error": "compte inconnu"}), 404
    auto = (request.get_json(silent=True) or {}).get("auto")
    if not isinstance(auto, dict) or any(k not in li.KINDS for k in auto):
        return jsonify({"error": "auto invalide"}), 400
    li.set_auto(row, auto)
    return jsonify({"account": _account_json(row, _default_id())})


def _default_id():
    default = li.default_account(_me().id)
    return default.id if default is not None else None


@webapi.route("/me/accounts/default", methods=["PUT"])
@login_required
def my_accounts_default():
    data = request.get_json(silent=True) or {}
    account = data.get("account")
    if account is not None and _row(account) is None:
        return jsonify({"error": "compte inconnu"}), 404
    started = li.set_default(current_app._get_current_object(), _me().id, account)
    return my_accounts_payload(started=started)


@webapi.route("/me/accounts/<account_id>/import", methods=["POST"])
@login_required
def my_accounts_import(account_id):
    row = _row(account_id)
    if row is None:
        return jsonify({"error": "compte inconnu"}), 404
    kinds = (request.get_json(silent=True) or {}).get("kinds")
    if kinds is not None and (not isinstance(kinds, list) or any(k not in li.KINDS for k in kinds)):
        return jsonify({"error": "kinds invalide"}), 400
    started = li.start(current_app._get_current_object(), row.id, kinds=kinds or None)
    row = ProviderAccount.get_by_id(row.id)
    return jsonify({"started": started, "account": _account_json(row, _default_id())}), 202


def _provider_error(exc):
    # 424, not 503: the web app retries a 5xx GET three times, and the
    # provider's own calls have already retried within their budget.
    if isinstance(exc, ProviderAuth):
        return jsonify({"error": "Le compte refuse la connexion : reliez-le à nouveau.", "reason": "auth"}), 409
    if isinstance(exc, ProviderUnavailable):
        return jsonify({"error": "Le service ne répond pas : réessayez dans un moment.", "reason": "network"}), 424
    logger.warning("reading an account's library failed: %r", exc)
    return jsonify({"error": "Le service a répondu par une erreur : réessayez plus tard.", "reason": "error"}), 502


@webapi.route("/me/accounts/<account_id>/library/<kind>")
@login_required
def my_accounts_library(account_id, kind):
    row = _row(account_id)
    if row is None or kind not in li.PICKABLE:
        return jsonify({"error": "introuvable"}), 404
    try:
        items = li.listing(current_app._get_current_object(), row, kind, fresh=request.args.get("fresh") == "1")
    except ProviderError as exc:
        return _provider_error(exc)
    return jsonify({"items": items})


@webapi.route("/me/accounts/<account_id>/library/<kind>", methods=["PUT"])
@login_required
def my_accounts_library_set(account_id, kind):
    row = _row(account_id)
    if row is None or kind not in li.PICKABLE:
        return jsonify({"error": "introuvable"}), 404
    data = request.get_json(silent=True) or {}
    refs = data.get("refs")
    if refs is None and data.get("ref") is not None:
        refs = [data.get("ref")]
    if (
        not isinstance(refs, list)
        or not refs
        or len(refs) > li.MAX_ITEMS
        or any(not isinstance(r, (str, int)) or not str(r) or len(str(r)) > 64 for r in refs)
        or not isinstance(data.get("on"), bool)
    ):
        return jsonify({"error": "refs (ou ref) et on requis"}), 400
    return jsonify(li.set_items(current_app._get_current_object(), row, kind, refs, data["on"]))

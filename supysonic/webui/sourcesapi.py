# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Réglages → Sources → *Ordre des sources*: the main source, then the others
in the order they are asked when it has nothing for a title (plan
multi-provider §3 and §5; the rules are in supysonic/providers/registry.py).

- ``GET /sources``: every source of sound in order, with its place (main,
  fallback n, off), the best quality it delivers and what it lacks. Read by
  every screen that names a source, so no screen writes a provider's name.
- ``PUT /sources``: the admin's order (main first) and switches,
  ``{"order": [ids], "enabled": {id: bool}}``.

What is archived plays whatever the order says: switching a source off erases
nothing.
"""

from __future__ import annotations

import logging

from flask import current_app, jsonify, request

from ..providers import quality
from . import admin_required, login_required, webapi

logger = logging.getLogger(__name__)

ORDER_MAX = 16  # what Meta can hold (registry.set_order) and more than will exist


def _registry():
    return getattr(current_app, "providers", None)


def _place(lead, fallbacks, provider_id):
    if lead is not None and provider_id == lead.id:
        return "main", 0
    if provider_id in fallbacks:
        return "fallback", fallbacks.index(provider_id) + 1
    return "off", None


def sources_brief():
    """What ``/me`` carries for every screen: each source's name and place,
    in order. Instant (no network, the registry's settings are cached)."""
    reg = _registry()
    if reg is None:
        return []
    lead = reg.main()
    fallbacks = [p.id for p in reg.fallbacks()]
    out = []
    for p in reg.sound():
        place, rank = _place(lead, fallbacks, p.id)
        note = reg.ceiling(p.id)
        out.append(
            {
                "id": p.id,
                "name": p.name,
                "place": place,
                "rank": rank,
                "quality": quality.label(note) if note.cls else "",
                "lossless": note.lossless,
            }
        )
    return out


def sources_payload():
    reg = _registry()
    me = request.webuser
    if reg is None:
        return {"sources": [], "main": None, "admin": bool(me and me.admin)}
    lead = reg.main()
    fallbacks = [p.id for p in reg.fallbacks()]
    out = []
    for p in reg.sound():
        enabled = reg.is_enabled(p.id)
        configured = p.configured()
        note = reg.ceiling(p.id)
        left, why = p.resting() if enabled else (0, "")
        place, rank = _place(lead, fallbacks, p.id)
        out.append(
            {
                "id": p.id,
                "name": p.name,
                "can_lead": p.role == "main",
                "place": place,
                "rank": rank,
                "enabled": enabled,
                "switchable": bool(getattr(p, "switchable", True)),
                "configured": configured,
                "setup": "" if configured else p.setup_hint(),
                "quality": {
                    "label": quality.label(note) if note.cls else "",
                    "class": note.cls,
                    "kbps": note.effective_kbps,
                    "lossless": note.lossless,
                },
                "resting": left,
                "resting_why": why,
            }
        )
    return {
        "sources": out,
        "main": lead.id if lead is not None else None,
        "admin": bool(me and me.admin),
    }


@webapi.route("/sources")
@login_required
def sources_get():
    return jsonify(sources_payload())


@webapi.route("/sources", methods=["PUT"])
@login_required
@admin_required
def sources_put():
    reg = _registry()
    if reg is None:
        return jsonify({"error": "aucune source"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "corps JSON attendu"}), 400
    order = data.get("order")
    enabled = data.get("enabled")
    if order is not None and (
        not isinstance(order, list)
        or len(order) > ORDER_MAX
        or not all(isinstance(x, str) and len(x) <= 16 for x in order)
    ):
        return jsonify({"error": "ordre invalide"}), 400
    if enabled is not None and (
        not isinstance(enabled, dict)
        or len(enabled) > ORDER_MAX
        or not all(isinstance(k, str) and isinstance(v, bool) for k, v in enabled.items())
    ):
        return jsonify({"error": "interrupteurs invalides"}), 400
    # The reason is asked for FIRST, so what is sent back is a sentence this
    # module wrote; an exception's own text never reaches a browser.
    refused = reg.check_sources(order=order, enabled=enabled)
    if refused:
        return jsonify({"error": refused}), 400
    try:
        reg.set_sources(order=order, enabled=enabled)
    except ValueError:
        logger.exception("sources refused")
        return jsonify({"error": "réglage refusé"}), 400
    return jsonify(sources_payload())

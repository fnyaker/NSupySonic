# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The button that completes the library's facts from MusicBrainz.

Admin-only, a worker and a poll, like the other library jobs: nothing here holds
a request, and nothing here reaches MusicBrainz — the worker does, at its pace.
"""

import threading

from flask import current_app, jsonify, request

from ..db import now
from ..enrich import backfill, queue as enrich_queue
from . import admin_required, login_required, webapi

_lock = threading.Lock()
_job = None
_started = None


def _snapshot():
    with _lock:
        job, started = _job, _started
    snap = job.snapshot() if job is not None else {"running": False}
    snap["started"] = started
    snap["coverage"] = backfill.coverage()
    opts = enrich_queue.options()
    snap["enabled"] = bool(opts.get("enabled"))
    from ..enrich import acoustid

    snap["acoustid"] = acoustid.available(opts.get("acoustid_key"))
    return snap


@webapi.route("/enrich/backfill", methods=["POST"])
@login_required
@admin_required
def enrich_backfill_start():
    global _job, _started
    data = request.get_json(silent=True) or {}
    force = bool(data.get("force") or request.args.get("force"))
    with _lock:
        if _job is None or not _job.snapshot()["running"]:
            _job = backfill.make_job(force=force)
            _started = now().isoformat()
            # Running from the first poll: the thread is only inside run() a
            # moment later and the poll must not see a gap.
            _job._stats["running"] = True
            _job._stats["total"] = backfill.total()
            backfill.start(current_app._get_current_object(), _job)
    return jsonify({"ok": True, **_snapshot()})


@webapi.route("/enrich/backfill")
@login_required
@admin_required
def enrich_backfill_status():
    return jsonify(_snapshot())

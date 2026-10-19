# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The button that recomputes every track's neighbours (``supysonic/similar.py``).

Admin-only, a worker and a poll, like the other library jobs: nothing here
holds a request. Recomputing one track happens by itself when its vector
arrives; this is for a library whose vectors were extracted before the index
existed, or after a change in how neighbours are scored.
"""

import threading

from flask import current_app, jsonify, request

from .. import similar
from ..db import Track, now
from . import admin_required, login_required, webapi

_lock = threading.Lock()
_job = None
_started = None


def _snapshot():
    with _lock:
        job, started = _job, _started
    snap = job.snapshot() if job is not None else {"running": False}
    snap["started"] = started
    snap.update(similar.status())
    return snap


@webapi.route("/similar/rebuild", methods=["POST"])
@login_required
@admin_required
def similar_rebuild_start():
    global _job, _started
    data = request.get_json(silent=True) or {}
    force = bool(data.get("force") or request.args.get("force"))
    with _lock:
        if _job is not None and _job.snapshot()["running"]:
            pass
        else:
            _job = similar.rebuild_job(force=force)
            _started = now().isoformat()
            # The job reports `running` only once its thread is inside run();
            # the poll that follows this answer must not see a gap.
            _job._stats["running"] = True
            _job._stats["total"] = Track.select().where(
                similar._archived()
            ).count()
            app = current_app._get_current_object()
            threading.Thread(
                target=similar.run_rebuild, args=(app, _job),
                name="similar-rebuild", daemon=True,
            ).start()
    return jsonify({"ok": True, **_snapshot()})


@webapi.route("/similar/rebuild")
@login_required
@admin_required
def similar_rebuild_status():
    return jsonify(_snapshot())

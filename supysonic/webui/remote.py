# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Remote control: a link that lets whoever holds it drive one of your players.

The owner makes a link on the device that plays (the phone in the living room,
the PC on the speakers), chooses how much it grants, and hands it over — as a
URL or a QR code. Whoever opens it gets THE SAME web app, logged in as the
owner, whose player is that device: pause, skip, the queue, a search, the
animations, depending on the level. There is no second interface; the app in
the holder's hands simply drives another player (webapp/src/lib/remote/).

Four levels, each a strict superset of the one before:

- ``queue`` — the transport (play, pause, previous, next, seek, volume) and
  the queue: see it, jump anywhere in it. Nothing else.
- ``read``  — the whole app, read-only: browse and search the owner's library,
  add to the queue, choose the animations. No edit to anything that is kept —
  playlists, favourites, settings.
- ``full``  — everything the owner can do, except administration; genre
  tagging included.
- ``admin`` — the owner's full access, administration included.

What no level grants, because it would take the owner's hand off their own
player: making or cutting links, posing as the controlled player, hosting a
listen party, reporting plays. The owner can cut any link at any moment, and
the sessions it opened end on their very next request.

**The token is the capability, and the database cannot hand one out.** A link
is ``<id>.<mac>``, the mac an HMAC of the id under the app's secret key: the
row names the grant, only this process can mint or check its token, and a copy
of the table opens nothing.

**Enforcement is one table, closed by default** (``POLICY``). Every /api
endpoint is listed with the lowest level that may call it; an endpoint missing
from it is refused to every remote session, and a test fails the day a route is
added without being classified. The owner's identity is otherwise left alone —
what the holder SEES is what the owner sees (the admin's Deezer mixes, their
favourites); only what they may DO is narrowed.

**Polling, never a held connection** — the rule the listen party lives by, for
the same reason (one worker, a handful of threads). The controlled device
publishes its state when it changes and asks for commands about every 0.7 s
while somebody is driving it (every few seconds otherwise, and not at all
without a live link); the controller reads the state about once a second and
extrapolates the position in between. The live part (the state, the queue, the
commands) is in memory and rebuilt by the player after a restart; the links
are rows, so a shared link outlives one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import zlib
from collections import deque
from datetime import timedelta

from flask import current_app, jsonify, request, session

from ..db import RemoteLink, User, now
from ..ratelimit import RateLimiter
from . import login_required, webapi
from .party import server_ms

LEVELS = ("queue", "read", "full", "admin")
_RANK = {name: i for i, name in enumerate(LEVELS)}
NEVER = "never"

# -- lifecycle ------------------------------------------------------------------

MAX_LINKS = 24  # live links per owner
TTL_MIN = 5 * 60
TTL_MAX = 90 * 24 * 3600
CMD_TTL = 8.0  # s: a command the player picks up later than this is dropped
MAX_CMDS = 64
HOST_ONLINE = 10.0  # s since the player's last poll before it reads as offline
CONTROLLER_TTL = 20.0  # s since a controller's last read before it is gone
CHANNEL_TTL = 3600.0
MAX_CHANNELS = 256
LINK_CACHE_TTL = 2.0
TOUCH_EVERY = 60.0  # s between last_used writes for one link
MAX_BODY = 8 * 1024 * 1024  # a decompressed publish (a 5000-track queue is ~1.5 MB)
MAX_QUEUE = 5000

_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{16,24}\Z")
_TOKEN_RE = re.compile(r"\A([A-Za-z0-9_-]{16,24})\.([A-Za-z0-9_-]{24})\Z")
_DEVICE_RE = re.compile(r"\A[A-Za-z0-9_-]{8,40}\Z")
# What may stand in a URL path segment. Every id the web app puts into a
# request path comes through here, so an id is never a way to steer the
# player's own requests somewhere else ("../../api/…").
_ENTITY_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

_claim_limiter = RateLimiter(max_attempts=20, window=300)

# -- the policy -----------------------------------------------------------------
#
# The lowest level that may call each endpoint (by view function), or NEVER.
# A dict splits one endpoint by method. HEAD reads as GET.
POLICY = {
    # who is here; leaving; logging in as yourself
    "login": "queue",
    "logout": "queue",
    "me": "queue",
    "app_version": "queue",
    "deezer_status": "queue",
    # the controller's own channel
    "remote_claim": "queue",
    "remote_leave": "queue",
    "remote_state": "queue",
    "remote_queue": "queue",
    "remote_cmd": "queue",
    # the queue shows art
    "cover": "queue",
    "local_cover": "queue",
    # the owner's own hand: never lent
    "remote_links": NEVER,
    "remote_link_create": NEVER,
    "remote_link_revoke": NEVER,
    "remote_links_revoke": NEVER,
    "remote_host_poll": NEVER,
    "remote_host_publish": NEVER,
    "party_create": NEVER,
    "party_mine": NEVER,
    "party_end": NEVER,
    "party_publish": NEVER,
    # the player's own reports: the controller plays nothing
    "report_listen": NEVER,
    "track_construction": NEVER,
    # a party's public pages carry their own capability and ignore the session
    "party_state": "queue",
    "party_clock": "queue",
    "party_join": "queue",
    "party_leave": "queue",
    "party_cover": "queue",
    "party_chunk": "queue",
    # reading the library
    "home": "read",
    "smarttracklist": "read",
    "search": "read",
    "search_podcasts": "read",
    "artist": "read",
    "artist_tracks": "read",
    "album": "read",
    "playlist": "read",
    "discography": "read",
    "lyrics": "read",
    "track_gain": "read",
    "track_gains": "read",  # a POST, and a read
    "flow": "read",
    "flow_clusters": "read",
    "track_radio": "read",
    "artist_radio": "read",
    "recommendations": "read",
    "my_playlists": "read",
    "my_favorite_ids": "read",
    "my_local": "read",
    "my_favorites": "read",
    "podcasts": "read",
    "podcast": "read",
    "podcast_progress": "read",
    "channel_markers": "read",
    "episode_markers": "read",
    "download_status": "read",
    "upload_usage": "read",
    "track_analysis": "read",
    "track_analyses": "read",  # a POST, and a read
    "probe_track": "read",
    "unavailable_tracks": "read",
    "replacement_candidates": "read",
    "replace_status": "read",
    "audio_edges": "read",
    "export_formats": "read",
    "genre_status": "read",
    "share_waveform": "read",
    # changing what is kept: the owner's own actions
    "set_flow_clusters": "full",
    "subscribe_podcast": "full",
    "unsubscribe_podcast": "full",
    "save_podcast_progress": "full",
    "add_episode_marker": "full",
    "delete_episode_marker": "full",
    "favorite": "full",
    "favorite_entity": "full",
    "create_playlist": "full",
    "edit_playlist": "full",
    "delete_playlist": "full",
    "add_playlist_tracks": "full",
    "remove_playlist_tracks": "full",
    "reorder_playlist": "full",
    "download": "full",
    "upload": "full",
    "delete_local": "full",
    "replace_track": "full",
    "delete_track": "full",
    "export_zip": "full",
    "share_file": "full",
    "share_clip": "full",
    "stream": "full",
    # tagging is the one piece of the genre studio `full` carries
    "genre_label": "full",
    "genre_bulk_preview": "full",
    "genre_bulk": "full",
    "genre_tag_create": "full",
    "genre_candidates": "full",
    "genre_labelled": "full",
    "genre_references": "full",
    "genre_reference_import": "full",
    "genre_model": {"GET": "read", "PUT": "admin", "DELETE": "admin"},
    # administration
    "trigger_sync": "admin",
    "sync_status": "admin",
    "get_settings": "admin",
    "set_settings": "admin",
    "analysis_backfill_start": "admin",
    "analysis_backfill_status": "admin",
    "genre_relabel": "admin",
    "genre_extractor_upload": "admin",
    "genre_extractor_delete": "admin",
    "genre_extractor_test": "admin",
    "genre_extractor_test_status": "admin",
    "genre_embed_start": "admin",
    "genre_embed_status": "admin",
    "genre_tags_defaults": "admin",
    "genre_tag_edit": "admin",
    "genre_construction": "admin",
    "genre_embeddings": "admin",
    "archive_status": "admin",
    "archive_backfill": "admin",
    "storage": "admin",
    "archive_rules": "admin",
    "set_archive_rules": "admin",
    "cleanup_preview": "admin",
    "cleanup_run": "admin",
    "flush_cache": "admin",
}


def required_level(endpoint, method):
    """The lowest level that may call ``endpoint`` with ``method``, or None."""
    if not endpoint or not endpoint.startswith("webapi."):
        return None
    rule = POLICY.get(endpoint[len("webapi."):])
    if isinstance(rule, dict):
        rule = rule.get("GET" if method == "HEAD" else method)
    if rule is None or rule == NEVER:
        return None
    return rule


def allows(level, need):
    return need is not None and level in _RANK and _RANK[level] >= _RANK[need]


# -- tokens ----------------------------------------------------------------------


def _mac(link_id: str) -> str:
    key = current_app.secret_key
    if isinstance(key, str):
        key = key.encode()
    digest = hmac.new(key, b"ns-remote-link:" + link_id.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()[:24]


def token_for(link_id: str) -> str:
    return f"{link_id}.{_mac(link_id)}"


def _parse_token(token):
    if not isinstance(token, str):
        return None
    m = _TOKEN_RE.match(token.strip())
    if not m:
        return None
    link_id, mac = m.groups()
    return link_id if hmac.compare_digest(mac, _mac(link_id)) else None


# -- live links -------------------------------------------------------------------

_cache_lock = threading.Lock()
_link_cache: dict = {}  # id -> (fetched at, row or None)
_device_cache: dict = {}  # (uid, device) -> (fetched at, [rows])
_touched: dict = {}  # id -> monotonic of the last last_used write


def _alive(row) -> bool:
    if row is None or row.revoked is not None:
        return False
    return row.expires is None or row.expires > now()


def live_link(link_id):
    """The link row if it still grants anything, else None. Cached briefly:
    every request of a remote session asks, and a cut drops the cache."""
    t = time.monotonic()
    with _cache_lock:
        hit = _link_cache.get(link_id)
    if hit is not None and t - hit[0] < LINK_CACHE_TTL:
        row = hit[1]
    else:
        row = RemoteLink.get_or_none(RemoteLink.id == link_id)
        with _cache_lock:
            if len(_link_cache) > 4096:
                _link_cache.clear()
            _link_cache[link_id] = (t, row)
    return row if _alive(row) else None


def _device_links(uid: str, device: str):
    """The owner's live links onto one device (cached like live_link)."""
    t = time.monotonic()
    key = (uid, device)
    with _cache_lock:
        hit = _device_cache.get(key)
    if hit is not None and t - hit[0] < LINK_CACHE_TTL:
        rows = hit[1]
    else:
        rows = list(
            RemoteLink.select().where(
                (RemoteLink.user == uid)
                & (RemoteLink.device == device)
                & RemoteLink.revoked.is_null(True)
            )
        )
        with _cache_lock:
            if len(_device_cache) > 1024:
                _device_cache.clear()
            _device_cache[key] = (t, rows)
    return [r for r in rows if _alive(r)]


def _forget(link_ids=(), device_key=None):
    with _cache_lock:
        for lid in link_ids:
            _link_cache.pop(lid, None)
        if device_key is not None:
            _device_cache.pop(device_key, None)


def _touch(row):
    t = time.monotonic()
    with _cache_lock:
        if t - _touched.get(row.id, -1e9) < TOUCH_EVERY:
            return
        _touched[row.id] = t
    try:
        RemoteLink.update(last_used=now()).where(RemoteLink.id == row.id).execute()
    except Exception:  # pragma: no cover - a timestamp is never worth a failure
        pass


# -- the session ------------------------------------------------------------------


def _end_remote_session():
    """Drop the remote grant from this session, and give back the account the
    browser was logged into before it claimed one. Returns that account's
    public identity, or None."""
    prev = session.get("rc_prev")
    session.clear()
    if not isinstance(prev, dict) or not prev.get("uid"):
        return None
    user = User.get_or_none(User.id == prev["uid"])
    if user is None or prev.get("epoch", 0) != (user.session_epoch or 0):
        return None
    session["uid"] = str(user.id)
    session["epoch"] = user.session_epoch or 0
    session.permanent = True
    return {"name": user.name, "admin": user.admin}


@webapi.before_request
def _remote_scope():
    link_id = session.get("rc")
    if not link_id:
        return None
    # Claiming another link or logging in replaces this session; neither may be
    # held hostage by the one it replaces.
    if request.endpoint in ("webapi.remote_claim", "webapi.login"):
        return None
    link = live_link(link_id)
    if link is None or str(link.user_id) != str(session.get("uid")):
        restored = _end_remote_session()
        return jsonify({"error": "remote ended", "restored": restored}), 401
    request.rc = link
    need = required_level(request.endpoint, request.method)
    if not allows(link.level, need):
        return jsonify({"error": "not allowed", "level": link.level}), 403
    _touch(link)
    return None


def describe(link) -> dict:
    """What a controller is told about its grant (also on /api/me)."""
    owner = User.get_or_none(User.id == link.user_id)
    return {
        "level": link.level,
        "owner": owner.name if owner else "",
        "device": link.device_name or "",
        "label": link.label or "",
        "expires": link.expires.isoformat() if link.expires else None,
    }


# -- sanitising what crosses ------------------------------------------------------


def _text(v, n=300):
    if not isinstance(v, str):
        return None
    return _CTRL_RE.sub("", v)[:n]


def _num(v, lo, hi, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f:  # NaN
        return default
    return max(lo, min(hi, f))


def _int(v, lo, hi, default=None):
    f = _num(v, lo, hi)
    return default if f is None else int(f)


def _clean(v, depth=0):
    """Bounded, inert JSON: short strings, finite numbers, small containers.

    Every key named like an id must be something a URL path can carry
    (``_ENTITY_ID_RE``) or it is dropped, since the web app builds request
    paths from them.
    """
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v if v == v and abs(v) < 1e15 else None
    if isinstance(v, str):
        return _CTRL_RE.sub("", v)[:600]
    if depth >= 4:
        return None
    if isinstance(v, list):
        return [_clean(x, depth + 1) for x in v[:40]]
    if isinstance(v, dict):
        out = {}
        for k, x in list(v.items())[:48]:
            if not isinstance(k, str) or len(k) > 40:
                continue
            if k in ("id", "deezer_id") or k.endswith("_id"):
                if x is not None and not (isinstance(x, str) and _ENTITY_ID_RE.match(x)):
                    if isinstance(x, int) and not isinstance(x, bool) and x >= 0:
                        x = str(x)
                    else:
                        continue
            out[k] = _clean(x, depth + 1)
        return out
    return None


def clean_track(t):
    """A track as the queue carries it, or None when it cannot be played."""
    if not isinstance(t, dict):
        return None
    tid = t.get("deezer_id")
    if isinstance(tid, int) and not isinstance(tid, bool):
        tid = str(tid)
    if not isinstance(tid, str) or not _ENTITY_ID_RE.match(tid):
        return None
    out = _clean(t)
    out["deezer_id"] = tid
    return out


def clean_tracks(ts, cap):
    if not isinstance(ts, list):
        return []
    out = []
    for t in ts[:cap]:
        c = clean_track(t)
        if c is not None:
            out.append(c)
    return out


def _clean_context(c):
    if not isinstance(c, dict):
        return None
    out = _clean({k: c.get(k) for k in ("kind", "id", "title") if k in c})
    return out or None


def _clean_state(s):
    s = s if isinstance(s, dict) else {}
    repeat = s.get("repeat")
    return {
        "index": _int(s.get("index"), -1, MAX_QUEUE * 4, -1),
        "playing": bool(s.get("playing")),
        "p": _num(s.get("p"), 0, 86400 * 2, 0.0),
        "duration": _num(s.get("duration"), 0, 86400 * 2, 0.0),
        "volume": _num(s.get("volume"), 0, 1, 1.0),
        "muted": bool(s.get("muted")),
        "shuffle": bool(s.get("shuffle")),
        "repeat": repeat if repeat in ("off", "all", "one") else "off",
        "status": _text(s.get("status"), 40) or "",
        "track": clean_track(s.get("track")),
        "context": _clean_context(s.get("context")),
    }


# -- the live channel ------------------------------------------------------------


class _Channel:
    """One controlled player: what it last published and what it is asked."""

    def __init__(self, uid, device):
        self.uid = uid
        self.device = device
        # Changes whenever the channel is rebuilt (a restart, an eviction), so
        # the player can tell its published state is gone and send it again.
        self.boot = secrets.token_urlsafe(6)
        self.state = None
        self.queue = []
        self.qv = ""
        self.settings = {}
        self.sv = ""
        self.cmds = deque(maxlen=MAX_CMDS)
        self.seq = 0
        self.ack = 0
        self.host_seen = 0.0
        self.controllers = {}  # cid -> {"link", "seen"}
        self.touched = time.monotonic()

    def online(self, t):
        return self.host_seen > 0 and t - self.host_seen < HOST_ONLINE

    def live_controllers(self, t):
        for cid, c in list(self.controllers.items()):
            if t - c["seen"] > CONTROLLER_TTL:
                del self.controllers[cid]
        return self.controllers


_lock = threading.Lock()
_channels: dict = {}  # (uid, device) -> _Channel


def _channel(uid, device, create=True):
    """Under _lock."""
    t = time.monotonic()
    key = (uid, device)
    ch = _channels.get(key)
    if ch is None:
        if not create:
            return None
        for k, c in list(_channels.items()):
            if t - c.touched > CHANNEL_TTL:
                del _channels[k]
        if len(_channels) >= MAX_CHANNELS:
            oldest = min(_channels, key=lambda k: _channels[k].touched)
            del _channels[oldest]
        ch = _channels[key] = _Channel(uid, device)
    ch.touched = t
    return ch


def _read_json_body():
    """The request's JSON, gzip-compressed or not, bounded after inflation."""
    data = request.get_data(cache=False)
    if (request.headers.get("Content-Encoding") or "").lower() == "gzip":
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            data = d.decompress(data, MAX_BODY)
        except zlib.error:
            return None
        if d.unconsumed_tail:
            return None
    if len(data) > MAX_BODY:
        return None
    try:
        return json.loads(data or b"null")
    except (ValueError, UnicodeDecodeError):
        return None


def _controller_view(ch, t, links):
    by_id = {r.id: r for r in links}
    out = []
    for cid, c in ch.live_controllers(t).items():
        r = by_id.get(c["link"])
        if r is None:
            continue
        out.append({"link": r.id, "level": r.level, "label": r.label or ""})
    return out


# -- the owner's hand -----------------------------------------------------------


def _link_json(row, t=None):
    t = time.monotonic() if t is None else t
    with _lock:
        ch = _channels.get((str(row.user_id), row.device))
        online = (
            sum(1 for c in ch.live_controllers(t).values() if c["link"] == row.id)
            if ch
            else 0
        )
    return {
        "id": row.id,
        "token": token_for(row.id),
        "level": row.level,
        "label": row.label or "",
        "device": row.device,
        "device_name": row.device_name or "",
        "created": row.created.isoformat() if row.created else None,
        "expires": row.expires.isoformat() if row.expires else None,
        "last_used": row.last_used.isoformat() if row.last_used else None,
        "controllers": online,
    }


@webapi.route("/remote/links")
@login_required
def remote_links():
    device = request.args.get("device")
    q = RemoteLink.select().where(
        (RemoteLink.user == request.webuser) & RemoteLink.revoked.is_null(True)
    )
    if device:
        q = q.where(RemoteLink.device == device)
    t = time.monotonic()
    rows = [r for r in q.order_by(RemoteLink.created.desc()) if _alive(r)]
    return jsonify({"links": [_link_json(r, t) for r in rows], "levels": list(LEVELS)})


@webapi.route("/remote/links", methods=["POST"])
@login_required
def remote_link_create():
    user = request.webuser
    data = request.get_json(silent=True) or {}
    level = data.get("level")
    if level not in LEVELS:
        return jsonify({"error": "unknown level"}), 400
    if level == "admin" and not user.admin:
        return jsonify({"error": "only an administrator can lend administration"}), 403
    device = data.get("device")
    if not isinstance(device, str) or not _DEVICE_RE.match(device):
        return jsonify({"error": "invalid device"}), 400
    ttl = data.get("ttl")
    expires = None
    if ttl is not None:
        seconds = _int(ttl, 0, TTL_MAX)
        if seconds is None or seconds < TTL_MIN:
            return jsonify({"error": "invalid duration"}), 400
        expires = now() + timedelta(seconds=seconds)
    live = [
        r
        for r in RemoteLink.select().where(
            (RemoteLink.user == user) & RemoteLink.revoked.is_null(True)
        )
        if _alive(r)
    ]
    if len(live) >= MAX_LINKS:
        return jsonify({"error": "too many links — cut one first"}), 409
    row = RemoteLink.create(
        id=secrets.token_urlsafe(12),
        user=user,
        level=level,
        device=device,
        device_name=_text(data.get("device_name"), 64) or None,
        label=_text(data.get("label"), 64) or None,
        created=now(),
        expires=expires,
    )
    _forget(device_key=(str(user.id), device))
    return jsonify({"link": _link_json(row)})


def _revoke(rows):
    stamp = now()
    ids = [r.id for r in rows]
    if not ids:
        return 0
    RemoteLink.update(revoked=stamp).where(RemoteLink.id.in_(ids)).execute()
    keys = {(str(r.user_id), r.device) for r in rows}
    for k in keys:
        _forget(ids, device_key=k)
    _forget(ids)
    with _lock:
        for k in keys:
            ch = _channels.get(k)
            if ch is None:
                continue
            for cid, c in list(ch.controllers.items()):
                if c["link"] in ids:
                    del ch.controllers[cid]
            ch.cmds = deque((c for c in ch.cmds if c["link"] not in ids), maxlen=MAX_CMDS)
    return len(ids)


@webapi.route("/remote/links/<link_id>", methods=["DELETE"])
@login_required
def remote_link_revoke(link_id):
    if not _ID_RE.match(link_id or ""):
        return jsonify({"error": "not found"}), 404
    row = RemoteLink.get_or_none(
        (RemoteLink.id == link_id) & (RemoteLink.user == request.webuser)
    )
    if row is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({"revoked": _revoke([row]) if row.revoked is None else 0})


@webapi.route("/remote/links", methods=["DELETE"])
@login_required
def remote_links_revoke():
    """Cut everything — on one device, or everywhere."""
    q = RemoteLink.select().where(
        (RemoteLink.user == request.webuser) & RemoteLink.revoked.is_null(True)
    )
    device = request.args.get("device")
    if device:
        q = q.where(RemoteLink.device == device)
    return jsonify({"revoked": _revoke(list(q))})


# -- the controlled player ---------------------------------------------------------


@webapi.route("/remote/host/<device>/poll")
@login_required
def remote_host_poll(device):
    if not _DEVICE_RE.match(device or ""):
        return jsonify({"error": "invalid device"}), 400
    uid = str(request.webuser.id)
    links = _device_links(uid, device)
    if not links:
        with _lock:
            _channels.pop((uid, device), None)
        return jsonify({"active": False})
    since = _int(request.args.get("since"), 0, 1e12, 0)
    t = time.monotonic()
    with _lock:
        ch = _channel(uid, device)
        ch.host_seen = t
        reset = request.args.get("chan") != ch.boot
        if reset:
            # A player that has not seen this channel yet (it is new, or the
            # server restarted under it) still gets what was asked of it in the
            # last few seconds — that is exactly a command sent while it was
            # reconnecting.
            since = 0
        cmds = [
            {k: c[k] for k in ("seq", "op", "args", "link")}
            for c in ch.cmds
            if c["seq"] > since and t - c["at"] < CMD_TTL
        ]
        return jsonify(
            {
                "active": True,
                "chan": ch.boot,
                "reset": reset,
                "seq": ch.seq,
                "cmds": cmds,
                "controllers": _controller_view(ch, t, links),
                "has_state": ch.state is not None,
            }
        )


@webapi.route("/remote/host/<device>", methods=["POST"])
@login_required
def remote_host_publish(device):
    if not _DEVICE_RE.match(device or ""):
        return jsonify({"error": "invalid device"}), 400
    uid = str(request.webuser.id)
    if not _device_links(uid, device):
        return jsonify({"active": False})
    body = _read_json_body()
    if not isinstance(body, dict):
        return jsonify({"error": "invalid body"}), 400
    state = _clean_state(body.get("state"))
    qv = _text(body.get("qv"), 40) or ""
    sv = _text(body.get("sv"), 40) or ""
    queue = body.get("queue")
    settings = body.get("settings")
    t = time.monotonic()
    with _lock:
        ch = _channel(uid, device)
        ch.host_seen = t
        if isinstance(queue, list):
            ch.queue = clean_tracks(queue, MAX_QUEUE)
            ch.qv = qv
        if isinstance(settings, dict):
            ch.settings = {
                k: _clean(v)
                for k, v in list(settings.items())[:160]
                if isinstance(k, str) and 0 < len(k) <= 40
            }
            ch.sv = sv
        state["qv"] = ch.qv
        state["t"] = server_ms()
        ch.state = state
        ack = _int(body.get("ack"), 0, 1e12, 0)
        ch.ack = max(ch.ack, min(ack, ch.seq))
        return jsonify(
            {
                "active": True,
                "chan": ch.boot,
                # What this channel lacks (after a restart it has neither):
                # the player sends it with its next publish.
                "need_queue": ch.qv != qv,
                "need_settings": ch.sv != sv,
            }
        )


# -- the controller -----------------------------------------------------------------


@webapi.route("/remote/claim", methods=["POST"])
def remote_claim():
    ip = request.remote_addr or "?"
    throttled = not current_app.testing
    if throttled and _claim_limiter.is_blocked(ip):
        return jsonify({"error": "too many attempts, try again later"}), 429
    token = (request.get_json(silent=True) or {}).get("token")
    link_id = _parse_token(token)
    link = live_link(link_id) if link_id else None
    owner = User.get_or_none(User.id == link.user_id) if link else None
    if link is None or owner is None:
        if throttled:
            _claim_limiter.record_failure(ip)
        return jsonify({"error": "this link is no longer valid"}), 404
    # Keep the account this browser was logged into, to give it back on leave.
    if session.get("rc"):
        prev = session.get("rc_prev")
    elif session.get("uid"):
        prev = {"uid": session["uid"], "epoch": session.get("epoch", 0)}
    else:
        prev = None
    session.clear()
    session["uid"] = str(owner.id)
    session["epoch"] = owner.session_epoch or 0
    session["rc"] = link.id
    session["rc_cid"] = secrets.token_urlsafe(9)
    if prev:
        session["rc_prev"] = prev
    session.permanent = True
    _touch(link)
    return jsonify(
        {
            "remote": describe(link),
            "user": {"name": owner.name, "admin": owner.admin},
        }
    )


@webapi.route("/remote/leave", methods=["POST"])
def remote_leave():
    if not session.get("rc"):
        return jsonify({"ok": True, "restored": None})
    return jsonify({"ok": True, "restored": _end_remote_session()})


def _this_link():
    return getattr(request, "rc", None)


@webapi.route("/remote/state")
@login_required
def remote_state():
    link = _this_link()
    if link is None:
        return jsonify({"error": "not a remote session"}), 404
    t = time.monotonic()
    with _lock:
        ch = _channel(str(link.user_id), link.device)
        cid = session.get("rc_cid") or "anon"
        ch.controllers[cid] = {"link": link.id, "seen": t}
        out = {
            "remote": {
                "level": link.level,
                "label": link.label or "",
                "device": link.device_name or "",
            },
            "online": ch.online(t),
            "state": ch.state,
            "qv": ch.qv,
            "sv": ch.sv,
            "ack": ch.ack,
            "seq": ch.seq,
            "now": server_ms(),
        }
        if request.args.get("sv") != ch.sv:
            out["settings"] = ch.settings
    return jsonify(out)


@webapi.route("/remote/queue")
@login_required
def remote_queue():
    link = _this_link()
    if link is None:
        return jsonify({"error": "not a remote session"}), 404
    with _lock:
        ch = _channel(str(link.user_id), link.device)
        return jsonify({"qv": ch.qv, "queue": ch.queue})


# Each command, the level that may send it, and how its arguments are read.
def _a_none(a, ch):
    return {}


def _a_seek(a, ch):
    t = _num(a.get("t"), 0, 86400 * 2)
    return None if t is None else {"t": t}


def _a_index(a, ch):
    i = _int(a.get("i"), 0, MAX_QUEUE * 4)
    tid = a.get("id")
    if i is None or not (isinstance(tid, str) and _ENTITY_ID_RE.match(tid)):
        return None
    return {"i": i, "id": tid}


def _a_move(a, ch):
    args = _a_index(a, ch)
    to = _int(a.get("to"), 0, MAX_QUEUE * 4)
    if args is None or to is None:
        return None
    args["to"] = to
    return args


def _a_volume(a, ch):
    v = _num(a.get("v"), 0, 1)
    return None if v is None else {"v": v}


def _a_tracks(cap):
    def read(a, ch):
        tracks = clean_tracks(a.get("tracks"), cap)
        if not tracks:
            return None
        out = {"tracks": tracks}
        if "start" in a:
            out["start"] = _int(a.get("start"), 0, cap, 0)
        if "context" in a:
            out["context"] = _clean_context(a.get("context"))
        return out

    return read


def _a_set(a, ch):
    key = a.get("key")
    # Only a setting the player published is one it has: nothing else can be
    # written through here, whatever the key.
    if not isinstance(key, str) or key not in ch.settings:
        return None
    value = _clean(a.get("value"))
    if len(json.dumps(value)) > 4096:
        return None
    return {"key": key, "value": value}


OPS = {
    "play": ("queue", _a_none),
    "pause": ("queue", _a_none),
    "toggle": ("queue", _a_none),
    "next": ("queue", _a_none),
    "prev": ("queue", _a_none),
    "seek": ("queue", _a_seek),
    "jump": ("queue", _a_index),
    "volume": ("queue", _a_volume),
    "mute": ("queue", _a_none),
    "shuffle": ("read", _a_none),
    "repeat": ("read", _a_none),
    "remove": ("read", _a_index),
    "move": ("read", _a_move),
    "clear": ("read", _a_none),
    "add": ("read", _a_tracks(2000)),
    "play_next": ("read", _a_tracks(2000)),
    "play_queue": ("read", _a_tracks(MAX_QUEUE)),
    "shuffle_play": ("read", _a_tracks(MAX_QUEUE)),
    "set": ("read", _a_set),
}

# The device's settings a read-only controller may still change: the pictures.
READ_SETTING_PREFIXES = ("viz.",)


def op_level(op, args=None):
    """The level a command needs (a setting outside the animations needs full)."""
    if op not in OPS:
        return None
    need = OPS[op][0]
    if op == "set":
        key = (args or {}).get("key") or ""
        if not key.startswith(READ_SETTING_PREFIXES):
            need = "full"
    return need


@webapi.route("/remote/cmd", methods=["POST"])
@login_required
def remote_cmd():
    link = _this_link()
    if link is None:
        return jsonify({"error": "not a remote session"}), 404
    data = request.get_json(silent=True) or {}
    op = data.get("op")
    raw = data.get("args") if isinstance(data.get("args"), dict) else {}
    if op not in OPS:
        return jsonify({"error": "unknown command"}), 400
    t = time.monotonic()
    with _lock:
        ch = _channel(str(link.user_id), link.device)
        args = OPS[op][1](raw, ch)
        if args is None:
            return jsonify({"error": "invalid arguments"}), 400
        if not allows(link.level, op_level(op, args)):
            return jsonify({"error": "not allowed", "level": link.level}), 403
        if not ch.online(t):
            return jsonify({"error": "player offline"}), 409
        cid = session.get("rc_cid") or "anon"
        ch.controllers[cid] = {"link": link.id, "seen": t}
        ch.seq += 1
        ch.cmds.append({"seq": ch.seq, "op": op, "args": args, "link": link.id, "at": t})
        return jsonify({"seq": ch.seq})


def _reset_for_tests():
    with _lock:
        _channels.clear()
    with _cache_lock:
        _link_cache.clear()
        _device_cache.clear()
        _touched.clear()
    with _claim_limiter._lock:
        _claim_limiter._fails.clear()

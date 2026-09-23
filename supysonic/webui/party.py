# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Listen party: one person plays, everyone holding the link hears it — in time.

The design follows beatsync (github.com/freeman-jiang/beatsync), adapted to a
server that answers from a small fixed pool of threads instead of a socket per
listener:

- **One clock.** Every participant measures its offset to THIS process's clock
  NTP-style (``/party/<id>/clock``: many cheap pings, the lowest round trip
  wins, because queueing can only ever ADD delay). All times below are in
  that clock, in milliseconds.

- **One timeline, published by the host.** The host's player is the reference:
  it measures where its own element is against the shared clock and publishes
  an ANCHOR — "at server time t the playhead was at p". Everyone derives the
  position at any moment from that line. The host republishes only when the
  line actually moves (a seek, a pause, a new track, or its own audio clock
  drifting a couple of milliseconds away from it), plus a heartbeat.

- **Audio as scheduled chunks, not a stream.** A guest cannot follow a stream
  to the sample: a media element starts when it feels like it. So the audio is
  cut into CHUNK_SECONDS pieces (sample-exact — ffmpeg seeks FLAC, Ogg and MP4
  to the sample; MP3 cannot be, so an MP3 is re-encoded once into an Ogg
  master first), each carrying CHUNK_OVERLAP extra at its tail. The guest
  decodes them and schedules each one on its AudioContext clock
  (``AudioBufferSourceNode.start(when, offset)``, sample-accurate), crossfading
  the overlap at every seam. A seam is also where each guest re-aligns to the
  shared clock, so drift between two devices' audio clocks never accumulates
  past one chunk. Joining mid-track costs one chunk, not the whole file.

- **Polling, never a held connection.** WebSockets or long-polls would pin one
  of the worker's threads per listener for the whole party. A guest polls the
  (tiny, in-memory) state about once a second instead. Continuous playback is
  unaffected by that latency — it is predicted from the anchor, and even the
  next track is announced in advance so guests start it on the beat; only the
  host's own actions (pause, seek, skip) reach guests up to a poll late.

The registry is in memory, which is right for the single worker this server
runs (see docker/gunicorn.conf.py): a party is a live, ephemeral thing, and the
host's page re-creates it if the server restarts under it.

Security: the party id is the capability — 128 random bits, unguessable — and
it only ever grants what the host is playing: the current, next and a few
previous tracks, their art, and nothing else in the library. Guests never
control anything.
"""

from __future__ import annotations

import logging
import math
import os
import re
import secrets
import subprocess
import threading
import time
import uuid

from flask import current_app, jsonify, request, send_file

from ..db import PodcastEpisode, Track
from . import (
    _may_access_track,
    _valid_id,
    cover_response,
    login_required,
    webapi,
)

logger = logging.getLogger(__name__)

# -- tunables ----------------------------------------------------------------

# One chunk of audio, and the extra tail it carries so two neighbours overlap
# and can be crossfaded. Six seconds: small enough that joining or seeking
# waits for ~150 KB, large enough that a four-minute track is forty requests.
# The overlap only has to be longer than the few milliseconds a seam can be
# re-aligned by; fifty keeps any lossy seam inaudible.
CHUNK_SECONDS = 6.0
CHUNK_OVERLAP = 0.05
# Opus is the house streaming format; 192k is transparent for this purpose.
CHUNK_OPUS_KBPS = 192
# FLAC is the fallback for a browser whose decodeAudioData refuses Ogg Opus.
CHUNK_RATES = (44100, 48000)
# A six-hour episode, in chunks: an upper bound on a chunk index when the
# duration is unknown.
MAX_CHUNK_INDEX = int(6 * 3600 / CHUNK_SECONDS)

# Lifecycle.
PARTY_TTL = 30 * 60  # a party whose host has been silent this long is over
HOST_OFFLINE = 150  # s without a heartbeat before guests are told
LISTENER_TTL = 45  # s without a poll before a listener is dropped
MAX_LISTENERS = 64
MAX_PARTIES = 64
# The tracks a party remembers (current, next, and the few before them — a
# guest one poll behind is still fading the previous one out).
MAX_MEDIA = 6
# A cold Deezer track is normally being archived by the HOST's own stream at
# the very moment guests first ask for it. Queuing a second download would
# fetch it twice; waiting this long first means that only happens when the
# host's copy is not coming (it played from an on-device download, say).
ARCHIVE_GRACE = 12.0

# ffmpeg: chunk cuts are short (~0.1 s) and latency-sensitive, so they get
# their own small pool instead of queueing behind a share transcode.
MAX_CONCURRENT_CUTS = 3
# Short on purpose: a request waiting for a slot is holding one of the worker's
# few threads. Past this the guest is told to come back (it retries on its own).
CUT_ACQUIRE_TIMEOUT = 2
CUT_TIMEOUT = 60
MASTER_TIMEOUT = 900

# Containers ffmpeg seeks to the exact sample (measured: FLAC, Ogg Opus and
# AAC-in-MP4 all land with zero lag). MP3 does not — a VBR file lands up to
# tens of milliseconds off, whatever -usetoc says — and a seam that is off by
# that much is an audible stutter every six seconds.
_EXACT_SEEK = {".flac", ".ogg", ".oga", ".opus", ".m4a", ".mp4", ".aac", ".wav", ".aif", ".aiff"}

_NORM_LEVELS = ("off", "low", "medium", "high")
_PID_RE = re.compile(r"\A[A-Za-z0-9_-]{16,64}\Z")
_LID_RE = re.compile(r"\A[A-Za-z0-9_-]{8,32}\Z")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

# -- the shared clock ----------------------------------------------------------

# Monotonic, so an NTP step on the server can never make the timeline jump, but
# anchored to the wall clock so the numbers are recognisable in a log.
_EPOCH = time.time() - time.monotonic()


def server_ms() -> float:
    return (time.monotonic() + _EPOCH) * 1000.0


# -- the registry ---------------------------------------------------------------

_lock = threading.Lock()
_parties: dict[str, "Party"] = {}


class Party:
    def __init__(self, pid: str, owner_id, owner_name: str):
        self.id = pid
        self.owner_id = owner_id
        self.owner_name = owner_name
        self.created = time.monotonic()
        self.host_seen = time.monotonic()
        self.version = 1
        # What guests follow. `anchor` is the line: position `p` (seconds) at
        # server time `t` (ms), advancing in real time while `playing`.
        self.state = {
            "track": None,
            "playing": False,
            # Not playing because the host is LOADING (a skip, a rebuffer),
            # not because it paused: guests say so, and look again sooner.
            "buf": False,
            "anchor": None,
            "xfade": 0.0,
            "next": None,
            "norm": "off",
        }
        # public id -> descriptor of media guests may fetch. Filled ONLY from
        # what the host published, and resolved/vetted as the host.
        self.media: dict[str, dict] = {}
        self.listeners: dict[str, dict] = {}

    # -- listeners
    def prune_listeners(self, now: float) -> None:
        dead = [k for k, v in self.listeners.items() if now - v["seen"] > LISTENER_TTL]
        for k in dead:
            del self.listeners[k]

    def listener_list(self):
        return [
            {"id": k, "name": v["name"], "q": v.get("q"), "st": v.get("st")}
            for k, v in sorted(self.listeners.items(), key=lambda kv: kv[1]["joined"])
        ]

    # -- media
    def allow(self, desc: dict) -> None:
        key = desc["id"]
        old = self.media.get(key)
        if old is not None:
            # Keep when it was first allowed: that is what the archive grace
            # counts from.
            desc["since"] = old["since"]
            desc["queued"] = old.get("queued", False)
        self.media[key] = desc
        desc["used"] = time.monotonic()
        if len(self.media) > MAX_MEDIA:
            stale = sorted(self.media.values(), key=lambda d: d["used"])
            for d in stale[: len(self.media) - MAX_MEDIA]:
                self.media.pop(d["id"], None)


def _prune_parties(now: float) -> None:
    for pid in [k for k, p in _parties.items() if now - p.host_seen > PARTY_TTL]:
        del _parties[pid]


def _get(pid: str) -> "Party | None":
    if not _PID_RE.fullmatch(pid or ""):
        return None
    with _lock:
        _prune_parties(time.monotonic())
        return _parties.get(pid)


def _not_found():
    resp = jsonify({"error": "party not found"})
    resp.status_code = 404
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _no_store(resp):
    resp.headers["Cache-Control"] = "no-store"
    return resp


# -- payload hygiene ------------------------------------------------------------


def _text(v, limit=300) -> str:
    if not isinstance(v, str):
        return ""
    return _CTRL_RE.sub("", v).strip()[:limit]


def _num(v, lo, hi, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(f):
        return default
    return min(hi, max(lo, f))


def _media_id(raw) -> "str | None":
    """A public media id — a Deezer numeric id or a UUID — or None."""
    s = str(raw or "")
    if _valid_id(s):
        return s
    try:
        return str(uuid.UUID(s))
    except ValueError:
        return None


def _resolve_media(mid: str) -> "dict | None":
    """What a published id points at, vetted as the (logged-in) host.

    A Deezer id need not have a row yet — the next track in a queue usually
    has not been imported — so it is accepted as is and resolved when a guest
    first asks for its audio. A UUID must be a track the host may read, or a
    podcast episode.
    """
    if _valid_id(mid):
        return {"id": mid, "kind": "track", "deezer_id": mid, "pk": None}
    key = uuid.UUID(mid)
    try:
        track = Track[key]
    except Track.DoesNotExist:
        track = None
    if track is not None:
        if not _may_access_track(track):
            return None
        return {"id": mid, "kind": "track", "deezer_id": None, "pk": key}
    try:
        PodcastEpisode[key]
    except PodcastEpisode.DoesNotExist:
        return None
    return {"id": mid, "kind": "episode", "deezer_id": None, "pk": key}


def _clean_track(raw) -> "tuple[dict, dict] | None":
    """(public track info, media descriptor) from the host's payload, or None."""
    if not isinstance(raw, dict):
        return None
    mid = _media_id(raw.get("id"))
    if mid is None:
        return None
    desc = _resolve_media(mid)
    if desc is None:
        return None
    desc["since"] = time.monotonic()
    info = {
        "id": mid,
        "title": _text(raw.get("title")) or "Sans titre",
        "artist": _text(raw.get("artist")),
        "album": _text(raw.get("album")),
        "duration": _num(raw.get("duration"), 0, 24 * 3600, 0.0),
        "podcast": bool(raw.get("podcast")),
        "gain": _num(raw.get("gain"), -60, 30),
    }
    return info, desc


def _public_track(pid: str, info: "dict | None"):
    if info is None:
        return None
    out = dict(info)
    # Guests have no session, so art always comes through the party.
    out["cover"] = f"/api/party/{pid}/cover/{info['id']}"
    return out


def _public_state(party: Party) -> dict:
    st = party.state
    nxt = st.get("next")
    now = time.monotonic()
    return {
        "id": party.id,
        "host": party.owner_name,
        "v": party.version,
        "live": now - party.host_seen < HOST_OFFLINE,
        "track": _public_track(party.id, st.get("track")),
        "playing": bool(st.get("playing")),
        "buf": bool(st.get("buf")),
        "anchor": st.get("anchor"),
        "xfade": st.get("xfade") or 0.0,
        "next": (
            dict(nxt, track=_public_track(party.id, nxt["track"])) if nxt else None
        ),
        "norm": st.get("norm") or "off",
        "chunk": {"len": CHUNK_SECONDS, "ov": CHUNK_OVERLAP},
        # Names only: a listener id is what authorises its own `leave`, so one
        # guest must never learn another's.
        "listeners": [{"name": x["name"]} for x in party.listener_list()],
    }


# -- host side ------------------------------------------------------------------


def _owned(pid: str):
    """(party, None) when the caller hosts `pid`, else (None, response)."""
    party = _get(pid)
    if party is None or party.owner_id != request.webuser.id:
        # Somebody else's party reads exactly like one that does not exist.
        return None, _not_found()
    return party, None


def _host_view(party: Party) -> dict:
    now = time.monotonic()
    party.prune_listeners(now)
    return {
        "id": party.id,
        "v": party.version,
        "path": f"/party/{party.id}",
        "listeners": party.listener_list(),
        "now": server_ms(),
    }


@webapi.route("/party", methods=["POST"])
@login_required
def party_create():
    """Start a listen party (or return the one this user is already hosting).

    One party per host: a second press re-opens the same link rather than
    minting a new one that the first set of guests would not be on.

    ``{"resume": "<id>"}`` re-creates a party under the id its host already
    handed out, when this process no longer has it — a server restart wipes
    the (in-memory) registry, and without this every guest would be stranded
    on a dead link while the host carried on playing. Only an id nobody holds
    can be taken, and only by a logged-in user; the id itself is still the
    capability, so this grants nothing a guest did not already have.
    """
    user = request.webuser
    body = request.get_json(silent=True)
    resume = body.get("resume") if isinstance(body, dict) else None
    now = time.monotonic()
    with _lock:
        _prune_parties(now)
        for p in _parties.values():
            if p.owner_id == user.id:
                p.host_seen = now
                return jsonify(_host_view(p))
        if len(_parties) >= MAX_PARTIES:
            return jsonify({"error": "too many parties"}), 503
        if isinstance(resume, str) and _PID_RE.fullmatch(resume) and len(resume) >= 22 and resume not in _parties:
            pid = resume
        else:
            pid = secrets.token_urlsafe(16)
        party = Party(pid, user.id, user.name)
        _parties[pid] = party
        logger.info("Listen party %s… started by %s", pid[:6], user.name)
        return jsonify(_host_view(party))


@webapi.route("/party/mine")
@login_required
def party_mine():
    """The party this user is hosting, if any — so a reloaded host page picks
    its party back up instead of stranding the guests on it."""
    user = request.webuser
    with _lock:
        _prune_parties(time.monotonic())
        for p in _parties.values():
            if p.owner_id == user.id:
                p.host_seen = time.monotonic()
                return _no_store(jsonify({"party": _host_view(p)}))
    return _no_store(jsonify({"party": None}))


@webapi.route("/party/<pid>", methods=["DELETE"])
@login_required
def party_end(pid):
    party, err = _owned(pid)
    if err:
        return err
    with _lock:
        _parties.pop(party.id, None)
    logger.info("Listen party %s… ended", party.id[:6])
    return jsonify({"ok": True})


@webapi.route("/party/<pid>/state", methods=["POST"])
@login_required
def party_publish(pid):
    """The host's timeline. Also its heartbeat: ``{"hb": 1}`` alone just says
    "still here" and returns the listener list."""
    party, err = _owned(pid)
    if err:
        return err
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid payload"}), 400

    now = time.monotonic()
    if body.get("hb") and "track" not in body:
        with _lock:
            party.host_seen = now
            return jsonify(_host_view(party))

    track = None
    if body.get("track") is not None:
        track = _clean_track(body.get("track"))
        if track is None:
            return jsonify({"error": "unknown track"}), 400

    anchor = None
    if track is not None:
        t = _num(body.get("t"), 0, 1e15)
        p = _num(body.get("p"), 0, 24 * 3600)
        # An anchor minutes away from the server's own clock is not a clock
        # estimate, it is garbage — and guests would schedule audio against it.
        if t is None or p is None or abs(t - server_ms()) > 10 * 60 * 1000:
            return jsonify({"error": "invalid anchor"}), 400
        anchor = {"t": t, "p": p}

    nxt = None
    raw_next = body.get("next")
    if track is not None and isinstance(raw_next, dict):
        cleaned = _clean_track(raw_next.get("track"))
        at = _num(raw_next.get("at"), 0, 24 * 3600)
        if cleaned is not None and at is not None:
            nxt = {
                "track": cleaned[0],
                # Where in the CURRENT track the next one takes over.
                "at": at,
                # Where the next one starts (its trimmed lead-in).
                "start": _num(raw_next.get("start"), 0, 60, 0.0),
                # The crossfade length, 0 for a plain cut.
                "fade": _num(raw_next.get("fade"), 0, 12, 0.0),
                # How late the host's own player usually is to start the next
                # track after that point (it has to load it) — so guests land
                # where the host will actually be, not where it would ideally.
                "gap": _num(raw_next.get("gap"), 0, 3, 0.0),
            }

    with _lock:
        party.host_seen = now
        if track is not None:
            party.allow(track[1])
        if nxt is not None:
            party.allow(cleaned[1])
        playing = bool(body.get("playing")) and track is not None
        party.state = {
            "track": track[0] if track else None,
            "playing": playing,
            "buf": bool(body.get("buf")) and track is not None and not playing,
            "anchor": anchor,
            "xfade": _num(body.get("xfade"), 0, 12, 0.0),
            "next": nxt,
            # The host's loudness normalisation, so every device in the room
            # plays each track at the same relative level the host hears.
            "norm": body.get("norm") if body.get("norm") in _NORM_LEVELS else "off",
        }
        party.version += 1
        return jsonify(_host_view(party))


# -- guest side -------------------------------------------------------------------


@webapi.route("/party/<pid>")
def party_state(pid):
    """What guests poll. ``l`` is the listener id (marks it alive), ``q`` its
    current sync estimate in ms and ``st`` its state, for the host's list."""
    party = _get(pid)
    if party is None:
        return _not_found()
    lid = request.args.get("l") or ""
    now = time.monotonic()
    me = None
    with _lock:
        if lid:
            me = _LID_RE.fullmatch(lid) is not None and lid in party.listeners
        if me:
            entry = party.listeners[lid]
            entry["seen"] = now
            q = _num(request.args.get("q"), 0, 10000)
            entry["q"] = round(q, 1) if q is not None else None
            st = request.args.get("st")
            entry["st"] = st if st in ("sync", "load", "idle", "pause") else None
        party.prune_listeners(now)
        out = _public_state(party)
    out["now"] = server_ms()
    if me is not None:
        # Whether the server still knows this listener: one dropped for going
        # quiet (a frozen background tab) takes a new seat instead of listening
        # on unseen.
        out["me"] = me
    return _no_store(jsonify(out))


@webapi.route("/party/<pid>/clock")
def party_clock(pid):
    """One NTP-style probe: the server's receive and send times, in ms.

    Deliberately does nothing else — every microsecond spent here is
    asymmetric delay in the measurement (the client already takes the lowest
    round trip of many, which is what filters out queueing).
    """
    t1 = server_ms()
    if _get(pid) is None:
        return _not_found()
    return _no_store(jsonify({"t1": t1, "t2": server_ms()}))


@webapi.route("/party/<pid>/join", methods=["POST"])
def party_join(pid):
    party = _get(pid)
    if party is None:
        return _not_found()
    body = request.get_json(silent=True) or {}
    name = _text(body.get("name") if isinstance(body, dict) else "", 32) or "Invité"
    now = time.monotonic()
    with _lock:
        party.prune_listeners(now)
        if len(party.listeners) >= MAX_LISTENERS:
            return jsonify({"error": "party full"}), 429
        lid = secrets.token_urlsafe(12)
        party.listeners[lid] = {"name": name, "seen": now, "joined": now}
        party.version += 1
    return _no_store(jsonify({"lid": lid}))


@webapi.route("/party/<pid>/leave", methods=["POST"])
def party_leave(pid):
    party = _get(pid)
    if party is None:
        return "", 204
    # sendBeacon posts text/plain; accept the id either way.
    body = request.get_json(silent=True, force=True) or {}
    lid = str(body.get("lid") or "") if isinstance(body, dict) else ""
    with _lock:
        if party.listeners.pop(lid, None) is not None:
            party.version += 1
    return "", 204


@webapi.route("/party/<pid>/cover/<mid>")
def party_cover(pid, mid):
    party = _get(pid)
    if party is None:
        return _not_found()
    with _lock:
        desc = party.media.get(mid)
    if desc is None:
        return jsonify({"error": "not found"}), 404
    if desc["kind"] == "episode":
        try:
            ep = PodcastEpisode[desc["pk"]]
        except PodcastEpisode.DoesNotExist:
            return jsonify({"error": "not found"}), 404
        return cover_response(str(ep.channel_id), vetted=True)
    return cover_response(mid, vetted=True)


# -- audio chunks ------------------------------------------------------------------

_cut_slots = threading.BoundedSemaphore(MAX_CONCURRENT_CUTS)
# Two guests asking for the same chunk at once must cut it once. Striped, so
# the lock table never grows.
_stripes = [threading.Lock() for _ in range(32)]
_masters_building: set = set()
_masters_lock = threading.Lock()


def _media_file(desc: dict):
    """(path, duration, cache key) of a party media, or (None, duration, None)
    while it is not on disk."""
    from ..deezer import archive

    if desc["kind"] == "episode":
        try:
            ep = PodcastEpisode[desc["pk"]]
        except PodcastEpisode.DoesNotExist:
            return None, 0, None
        path = ep.path if ep.path and os.path.isfile(ep.path) else None
        return path, ep.duration or 0, f"ep{ep.id.hex}"
    if desc["deezer_id"]:
        track = archive.find_local_track(desc["deezer_id"])
    else:
        try:
            track = Track[desc["pk"]]
        except Track.DoesNotExist:
            track = None
    if track is None:
        return None, 0, None
    path = track.path if os.path.isfile(track.path) else None
    return path, track.duration or 0, f"tr{track.id.hex}"


def _request_archive(party: Party, desc: dict) -> None:
    """Make sure a cold track is on its way to the disk — once, and only after
    the host's own download has had its chance."""
    if desc.get("queued"):
        return
    if time.monotonic() - desc.get("since", 0) < ARCHIVE_GRACE:
        return
    pf = getattr(current_app, "deezer_prefetch", None)
    if pf is None:
        return
    from ..deezer.workload import Priority

    desc["queued"] = True
    try:
        if desc["kind"] == "episode":
            pf.download_episode_ids([str(desc["pk"])], priority=Priority.USER)
        elif desc["deezer_id"]:
            pf.download_ids([desc["deezer_id"]], priority=Priority.USER)
    except Exception:  # best-effort: the guest keeps retrying either way
        logger.debug("party: archive request failed", exc_info=True)


def _preparing(retry=2):
    resp = jsonify({"error": "preparing"})
    resp.status_code = 503
    resp.headers["Retry-After"] = str(retry)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _master_key(key: str, mtime: int) -> str:
    return f"partysrc-{key}-{mtime}.ogg"


def _build_master(app, src: str, mkey: str) -> None:
    """Re-encode a source ffmpeg cannot seek exactly into one it can."""
    from .share import _ffmpeg_slots

    cmd = [
        "ffmpeg", "-v", "error", "-nostdin", "-i", src,
        "-map", "0:a:0", "-ac", "2", "-ar", "48000",
        "-c:a", "libopus", "-b:a", "256k", "-vbr", "on",
        "-map_metadata", "-1", "-f", "ogg", "pipe:1",
    ]
    try:
        with _ffmpeg_slots:
            out = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=MASTER_TIMEOUT,
                check=True,
            ).stdout
        if out:
            app.transcode_cache.set(mkey, out)
    except Exception:
        logger.warning("party: could not prepare a seekable copy of %s", src, exc_info=True)
    finally:
        with _masters_lock:
            _masters_building.discard(mkey)


def _seekable_source(path: str, key: str):
    """(path to cut from, None) — or (None, response) while an exact-seek copy
    of an MP3 is being prepared in the background."""
    if os.path.splitext(path)[1].lower() in _EXACT_SEEK:
        return path, None
    cache = current_app.transcode_cache
    mkey = _master_key(key, int(os.path.getmtime(path)))
    if cache.has(mkey):
        return cache.get(mkey), None
    with _masters_lock:
        if mkey not in _masters_building:
            _masters_building.add(mkey)
            threading.Thread(
                target=_build_master,
                args=(current_app._get_current_object(), path, mkey),
                name="party-master",
                daemon=True,
            ).start()
    return None, _preparing(2)


def _cut_cmd(src: str, k: int, fmt: str, rate: int) -> list:
    # -ss BEFORE -i: ffmpeg seeks the demuxer, then decodes and discards up to
    # the exact sample (accurate_seek) — measured at zero lag on FLAC, Ogg and
    # MP4 sources, which is what makes the seams line up.
    head = [
        "ffmpeg", "-v", "error", "-nostdin",
        "-ss", f"{k * CHUNK_SECONDS:.6f}", "-i", src,
        "-t", f"{CHUNK_SECONDS + CHUNK_OVERLAP:.6f}",
        "-map", "0:a:0", "-ac", "2", "-map_metadata", "-1",
    ]
    if fmt == "opus":
        # Opus is 48 kHz whatever the device asked for.
        return head + [
            "-ar", "48000", "-c:a", "libopus", "-b:a", f"{CHUNK_OPUS_KBPS}k",
            "-vbr", "on", "-f", "ogg", "pipe:1",
        ]
    # At the device's own rate, so the browser never resamples a chunk on its
    # own — a resampler starts cold at every chunk edge.
    return head + [
        "-ar", str(rate), "-c:a", "flac", "-sample_fmt", "s16",
        "-f", "flac", "pipe:1",
    ]


def _cut(src: str, k: int, fmt: str, rate: int) -> bytes:
    return subprocess.run(
        _cut_cmd(src, k, fmt, rate),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=CUT_TIMEOUT,
        check=True,
    ).stdout


_CHUNK_MIME = {"opus": ("audio/ogg", "ogg"), "flac": ("audio/flac", "flac")}


@webapi.route("/party/<pid>/chunk/<mid>/<int:k>")
def party_chunk(pid, mid, k):
    """Chunk ``k`` of a party track: [k·L, (k+1)·L + overlap) of its audio."""
    party = _get(pid)
    if party is None:
        return _not_found()
    fmt = request.args.get("f") or "opus"
    if fmt not in _CHUNK_MIME:
        return jsonify({"error": "unsupported format"}), 400
    try:
        rate = int(request.args.get("sr") or 48000)
    except ValueError:
        rate = 0
    if rate not in CHUNK_RATES:
        return jsonify({"error": "unsupported rate"}), 400
    if fmt == "opus":
        rate = 48000
    if not 0 <= k <= MAX_CHUNK_INDEX:
        return jsonify({"error": "invalid chunk"}), 400

    with _lock:
        desc = party.media.get(mid)
        if desc is not None:
            desc["used"] = time.monotonic()
    if desc is None:
        # Not something this party is playing: the library stays closed.
        return jsonify({"error": "not found"}), 404

    path, duration, key = _media_file(desc)
    if path is None:
        if desc["kind"] == "track" and not desc["deezer_id"]:
            # A local upload whose file is gone: nothing will ever bring it back.
            return jsonify({"error": "not found"}), 404
        with _lock:
            _request_archive(party, desc)
        return _preparing(2)
    if duration and k * CHUNK_SECONDS > duration + CHUNK_SECONDS:
        return jsonify({"error": "past the end"}), 404

    mime, ext = _CHUNK_MIME[fmt]
    ckey = f"party-{key}-{int(os.path.getmtime(path))}-{k}-{fmt}{rate}.{ext}"
    cache = current_app.transcode_cache

    def serve():
        resp = send_file(cache.get(ckey), mimetype=mime, conditional=True)
        # Immutable for this file: a guest re-joining, or seeking back, hits its
        # own HTTP cache instead of the server.
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp

    if cache.has(ckey):
        return serve()

    src, err = _seekable_source(path, key)
    if err:
        return err
    stripe = _stripes[hash(ckey) % len(_stripes)]
    if not stripe.acquire(timeout=CUT_ACQUIRE_TIMEOUT):
        return _preparing(1)
    try:
        if cache.has(ckey):
            return serve()
        if not _cut_slots.acquire(timeout=CUT_ACQUIRE_TIMEOUT):
            return _preparing(1)
        try:
            data = _cut(src, k, fmt, rate)
        except Exception:
            logger.warning("party: chunk %s of %s failed", k, mid, exc_info=True)
            return jsonify({"error": "chunk failed"}), 502
        finally:
            _cut_slots.release()
        if not data:
            return jsonify({"error": "past the end"}), 404
        cache.set(ckey, data)
    finally:
        stripe.release()
    return serve()

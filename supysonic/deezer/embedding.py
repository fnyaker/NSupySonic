# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Turning a track into a vector a classifier can learn from.

WHY AN EMBEDDING AND NOT A CLASSIFIER. The obvious idea — take a genre model
and fine-tune it on your own tags — is the wrong shape for this problem, and
much harder than it needs to be. The model that knows what music sounds like was
trained on millions of recordings; a personal taxonomy has a few hundred
examples. Fine-tuning something that big on something that small mostly destroys
what it knew.

So the big model is FROZEN and used only as a feature extractor: it turns three
minutes of audio into one vector of 1280 numbers that encodes what the music is
like. All the learning then happens in a small head on top of those vectors —
which is a few hundred examples by 1280 dimensions, i.e. a problem small enough
to train in a browser tab in milliseconds, with no WebAssembly and no training
framework. The literature is unambiguous that this beats end-to-end training at
this data size, and it has a second, unrelated advantage: the model is used
exactly as published and never modified, which is also what its licence asks.

WHAT IT COSTS. onnxruntime is an optional dependency (`pip install
supysonic[embedding]`, and it is in the Docker image). Without it this whole
module reports itself unavailable and nothing changes: the heuristic classifier
in analysis.py keeps doing the job it already does. numpy comes with
onnxruntime, which is what makes the mel front-end below cheap to write.

THE FRONT-END IS THE DANGEROUS PART. A model is only as good as the exact
features it was trained on: a mel-spectrogram computed with the wrong window,
scale or normalization produces vectors that look perfectly healthy and mean
nothing. The parameters below are the published MusiCNN ones — 16 kHz mono,
512-sample Hann frames, 256 hop, 96 Slaney mel bands, log10(10000·x + 1) — and
because "looks healthy but is wrong" is the failure mode, `self_test` exists to
catch it without needing a reference implementation: two halves of the SAME
track must embed close together and far from other tracks. A broken front-end
fails that immediately.
"""

from __future__ import annotations

import base64
import logging
import math
import os
import shutil
import struct
import subprocess
import threading
import time

logger = logging.getLogger(__name__)

# Bump when the extractor changes in a way that invalidates stored vectors.
EMBED_VERSION = 2
# discogs-effnet's penultimate layer, i.e. what ONE patch of the model emits.
MODEL_DIM = 1280
# What we STORE: the mean AND the standard deviation over the track's patches,
# concatenated. Mean alone throws away how much the track moves — a three-chord
# loop and a genre-hopping mashup can share a mean — and the standard deviation
# is the half that tells them apart. This is the aggregation the model's own
# authors publish (mean + std through time), and the one the music auto-tagging
# literature measures as a straight accuracy gain over the mean on a frozen
# extractor. Nothing downstream needed to learn it: the head simply sees 2560
# numbers instead of 1280.
EMBED_DIM = MODEL_DIM * 2
# What a v1 sidecar holds (the mean alone). Kept readable rather than deleted:
# a library extracted before this change must keep working on a server that can
# no longer extract, exactly like the v1 -> v2 story everywhere else here.
LEGACY_EMBED_DIM = MODEL_DIM

# The one export this front-end is written for. It must be the DYNAMIC-batch
# ONNX, not the "-bs64" one: the latter declares a fixed batch of 64, while the
# front-end feeds however many patches a track yields (up to MAX_PATCHES), so
# onnxruntime would refuse it. The name is otherwise fixed because the mel
# parameters below only match this model — a model the web UI uploads is stored
# under exactly this name.
MODEL_FILENAME = "discogs-effnet-bsdynamic-1.onnx"
# Where the operator gets it. Never fetched for them: third-party artefact,
# its own licence (non-commercial). Kept here so the studio can say precisely
# what to download instead of "the model file".
MODEL_URL = (
    "https://essentia.upf.edu/models/feature-extractors/discogs-effnet/"
    "discogs-effnet-bsdynamic-1.onnx"
)
# The published model is ~40 MB. A gigabyte is far past anything legitimate and
# stops one hostile upload from filling the disk.
MODEL_MAX_BYTES = 1024 * 1024 * 1024

# --- the published MusiCNN front-end spec ----------------------------------
SAMPLE_RATE = 16000
FRAME_SIZE = 512
HOP_SIZE = 256
MEL_BANDS = 96
PATCH_FRAMES = 128  # ~2.05 s per patch, the model's input length
# How many patches to embed, spread over the track. The whole point is a summary
# of the piece, and forty patches is two minutes of audio sampled across it —
# well past the point where the mean stops moving. The standard deviation needs
# a few more samples than the mean to settle, which is the other reason this is
# not smaller.
MAX_PATCHES = 60
FFMPEG_TIMEOUT = 300

_lock = threading.Lock()
_session = None
# Why the last load failed, so the studio can say more than "0 computed".
_session_error = None
# …and WHEN to try again. A failure here used to be permanent for the life of
# the process: one load that did not come off — the machine briefly out of
# memory under a parallel run, a file being replaced as it was read — and every
# track from then on reported "the model could not be loaded", for hours, with
# nothing wrong any more. A run that has already measured ten thousand tracks
# must not be ended by a bad second.
_session_retry_at = 0.0
SESSION_RETRY_DELAY = 60.0
_mel_fb = None


def onnxruntime_available() -> bool:
    try:
        import onnxruntime  # noqa: F401

        return True
    except Exception:
        return False


def ffmpeg_available() -> bool:
    """ffmpeg is not optional here: every extractor path decodes audio with it."""
    return shutil.which("ffmpeg") is not None


def available() -> bool:
    """True when this server can extract embeddings at all."""
    if not ffmpeg_available():
        return False
    try:
        import numpy  # noqa: F401
    except Exception:
        return False
    return onnxruntime_available()


def why_unavailable() -> str | None:
    """A sentence the CLI and the API can show, or None when it works."""
    if not ffmpeg_available():
        return "ffmpeg is not installed (the extractor decodes audio with it)"
    try:
        import numpy  # noqa: F401
    except Exception:
        return "numpy is not installed"
    if not onnxruntime_available():
        return "onnxruntime is not installed (pip install 'supysonic[embedding]')"
    if not model_path():
        return "no model file; upload it in the genre studio or set [deezer] embed_model"
    return None


def _config() -> dict:
    """The active config as a plain mapping, whichever context we run in.

    Under the server that is Flask's ``current_app``. Under the CLI there is no
    app context — and without a fallback `supysonic-cli deezer embed` could
    never see the very model the web UI just installed — so the process-wide
    config the CLI built is used instead.
    """
    try:
        from flask import current_app

        cfg = current_app.config
        if cfg:
            return {k: cfg[k] for k in ("WEBAPP", "DEEZER") if k in cfg}
    except Exception:
        pass
    try:
        from ..config import get_current_config

        conf = get_current_config()
    except Exception:
        return {}
    return {
        "WEBAPP": getattr(conf, "WEBAPP", {}) or {},
        "DEEZER": getattr(conf, "DEEZER", {}) or {},
    }


def _deezer_conf() -> dict:
    return _config().get("DEEZER", {}) or {}


def model_dirs() -> list:
    """Candidate ``models`` directories, most preferred first.

    The web cache comes first: it is where the studio writes an upload. The
    Deezer archive is the older documented location and stays legal — both live
    on the persistent volume in the Docker image. Duplicates are dropped."""
    cfg = _config()
    conf = cfg.get("DEEZER", {}) or {}
    webapp = cfg.get("WEBAPP", {}) or {}
    out = []
    bases = [webapp.get("cache_dir"), conf.get("cache_dir"), conf.get("archive_dir")]
    for base in filter(None, bases):
        d = os.path.join(str(base), "models")
        if d not in out:
            out.append(d)
    return out


def model_path() -> str | None:
    """Where the ONNX model is, or None.

    Deliberately NOT vendored in the repository and never fetched silently: the
    model is a third-party artefact with its own licence, so the operator points
    at a copy they obtained themselves — or uploads one in the web UI, which is
    stored under its canonical name in the cache's models directory.
    """
    explicit = _deezer_conf().get("embed_model")
    if explicit and os.path.isfile(explicit):
        return explicit
    dirs = model_dirs()
    for d in dirs:
        p = os.path.join(d, MODEL_FILENAME)
        if os.path.isfile(p):
            return p
    # An operator who dropped a differently-named export in by hand still works;
    # the newest one wins so a re-upload is picked up too.
    found = []
    for d in dirs:
        try:
            for name in os.listdir(d):
                if name.lower().endswith(".onnx"):
                    p = os.path.join(d, name)
                    if os.path.isfile(p):
                        found.append(p)
        except OSError:
            continue
    if found:
        return max(found, key=lambda p: os.path.getmtime(p))
    return None


def writable_model_dir() -> str | None:
    """The models directory the web UI can write to, creating it if needed."""
    for d in model_dirs():
        try:
            os.makedirs(d, exist_ok=True)
            if os.access(d, os.W_OK):
                return d
        except OSError:
            continue
    return None


def can_write_model() -> bool:
    """Whether an upload could be stored — without creating anything.

    The studio's status endpoint runs this on every page load, so it must stay
    read-only: a directory that does not exist yet is fine as long as its parent
    is writable."""
    for d in model_dirs():
        if os.path.isdir(d) and os.access(d, os.W_OK):
            return True
    for d in model_dirs():
        parent = os.path.dirname(d)
        if os.path.isdir(parent) and os.access(parent, os.W_OK):
            return True
    return False


def model_info() -> dict | None:
    """What the active model is, for the studio's status card."""
    path = model_path()
    if not path:
        return None
    explicit = _deezer_conf().get("embed_model")
    from_config = bool(
        explicit and os.path.abspath(path) == os.path.abspath(str(explicit))
    )
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return {
        "filename": os.path.basename(path),
        "size": size,
        "source": "config" if from_config else "models",
    }


def _input_problem(shape) -> str | None:
    """None when a declared input shape can be this front-end's output, else a
    sentence saying why not — used both to reject an upload and to refuse a
    model at inference time."""
    if not shape:
        return "the model declares no input shape"
    # The front-end feeds a different number of patches per track, so a fixed
    # batch axis is fatal — and it is the exact trap of grabbing the "-bs64"
    # export instead of the dynamic one. Non-positive integers are sentinels for
    # a dynamic axis in some exports, not a real batch size.
    if isinstance(shape[0], int) and shape[0] > 1:
        return (
            f"this model has a fixed batch size ({shape[0]}); use the "
            f"dynamic-batch export {MODEL_FILENAME}"
        )
    tail = [d for d in shape[1:] if isinstance(d, int)]
    if tail and tail[-1] != MEL_BANDS:
        return (
            f"this model expects {shape}, but the extractor expects "
            f"(n, {PATCH_FRAMES}, {MEL_BANDS})"
        )
    return None


def validate_model(path: str):
    """``(ok, reason)`` for a candidate extractor.

    Needs onnxruntime to say anything; without it the check is skipped and
    reported OK, because the caller could not use the model anyway and
    ``available()`` already explains that."""
    if not onnxruntime_available():
        return True, None
    try:
        session = _make_session(path)
    except Exception as exc:
        logger.warning("embedding: rejecting model %s", path, exc_info=True)
        return False, f"onnxruntime could not load this file: {exc}"
    inputs = session.get_inputs()
    if not inputs:
        return False, "the model exposes no input"
    problem = _input_problem(inputs[0].shape)
    return (False, problem) if problem else (True, None)


def _unlink(path) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def store_model(stream, filename: str):
    """Stream an uploaded ``.onnx`` into the writable models dir.

    Staged beside its destination and only renamed into place once it loads, so
    a bad upload can never destroy a working extractor. Returns ``(path, error)``
    — exactly one of which is set."""
    if not str(filename or "").lower().endswith(".onnx"):
        return None, "the extractor must be a .onnx file"
    dest_dir = writable_model_dir()
    if dest_dir is None:
        return None, "no writable models directory is configured"
    dest = os.path.join(dest_dir, MODEL_FILENAME)
    # Staged in a hidden subdirectory so a half-written upload is never picked up
    # by model discovery (which only looks at files directly in the models dir).
    staging_dir = os.path.join(dest_dir, ".incoming")
    try:
        os.makedirs(staging_dir, exist_ok=True)
    except OSError as exc:
        return None, f"could not write the model: {exc}"
    staging = os.path.join(staging_dir, MODEL_FILENAME)
    total = 0
    too_large = False
    try:
        with open(staging, "wb") as fp:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MODEL_MAX_BYTES:
                    too_large = True
                    break
                fp.write(chunk)
    except OSError as exc:
        _unlink(staging)
        return None, f"could not write the model: {exc}"
    if too_large:
        _unlink(staging)
        return None, "file too large"
    if total == 0:
        _unlink(staging)
        return None, "empty file"
    ok, reason = validate_model(staging)
    if not ok:
        _unlink(staging)
        return None, reason
    try:
        os.replace(staging, dest)
    except OSError as exc:
        _unlink(staging)
        return None, f"could not write the model: {exc}"
    reset_session()
    return dest, None


def delete_model() -> bool:
    """Remove the active model, but only if it lives in a models directory the
    web UI manages. A model named by the operator's ``embed_model`` is never
    touched."""
    path = model_path()
    if not path:
        return False
    explicit = _deezer_conf().get("embed_model")
    if explicit and os.path.abspath(path) == os.path.abspath(str(explicit)):
        return False
    real = os.path.realpath(path)
    for d in model_dirs():
        root = os.path.realpath(d)
        if real == root or real.startswith(root + os.sep):
            _unlink(real)
            reset_session()
            return True
    return False


def reset_session() -> None:
    """Forget the loaded model so the next extraction reloads from disk."""
    global _session, _session_error, _session_retry_at
    with _lock:
        _session = None
        _session_error = None
        _session_retry_at = 0.0


def _mel_filterbank(np):
    """Slaney-scale triangular mel filters, area-normalized.

    The same bank librosa builds with ``htk=False, norm='slaney'``, which is
    what MusiCNN was trained against. Built once and reused.
    """
    global _mel_fb
    if _mel_fb is not None:
        return _mel_fb

    f_sp = 200.0 / 3
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = math.log(6.4) / 27.0

    # atleast_1d so a scalar argument still takes the boolean-mask path below.
    def hz_to_mel(f):
        f = np.atleast_1d(np.asarray(f, dtype=np.float64))
        mel = f / f_sp
        hi = f >= min_log_hz
        mel[hi] = min_log_mel + np.log(f[hi] / min_log_hz) / logstep
        return mel

    def mel_to_hz(m):
        m = np.atleast_1d(np.asarray(m, dtype=np.float64))
        f = f_sp * m
        hi = m >= min_log_mel
        f[hi] = min_log_hz * np.exp(logstep * (m[hi] - min_log_mel))
        return f

    n_fft_bins = FRAME_SIZE // 2 + 1
    fft_freqs = np.linspace(0, SAMPLE_RATE / 2, n_fft_bins)
    mel_pts = np.linspace(
        float(hz_to_mel(0.0)[0]), float(hz_to_mel(SAMPLE_RATE / 2)[0]), MEL_BANDS + 2
    )
    hz_pts = mel_to_hz(mel_pts)

    fb = np.zeros((MEL_BANDS, n_fft_bins), dtype=np.float32)
    diff = np.diff(hz_pts)
    ramps = hz_pts.reshape(-1, 1) - fft_freqs.reshape(1, -1)
    for i in range(MEL_BANDS):
        lower = -ramps[i] / diff[i]
        upper = ramps[i + 2] / diff[i + 1]
        fb[i] = np.maximum(0, np.minimum(lower, upper))
    # Slaney normalization: each filter carries equal AREA, not equal peak.
    enorm = 2.0 / (hz_pts[2 : MEL_BANDS + 2] - hz_pts[:MEL_BANDS])
    fb *= enorm.reshape(-1, 1).astype(np.float32)
    _mel_fb = fb
    return fb


def _decode(path, seconds=None, start=None):
    """Mono float32 at 16 kHz, straight out of ffmpeg."""
    import numpy as np

    cmd = ["ffmpeg", "-v", "0"]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", path]
    if seconds:
        cmd += ["-t", f"{seconds:.3f}"]
    cmd += ["-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1"]
    raw = subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        timeout=FFMPEG_TIMEOUT, check=True,
    ).stdout
    if not raw:
        raise ValueError("no audio decoded")
    return np.frombuffer(raw, dtype=np.float32)


#: Samples one patch spans: 128 frames of 512, hopping 256. 33024 at 16 kHz.
PATCH_SAMPLES = (PATCH_FRAMES - 1) * HOP_SIZE + FRAME_SIZE


def patch_offsets(n_samples: int, take: int = MAX_PATCHES) -> list:
    """Where to cut the `take` patches this track is summarised from.

    Spread over the whole file rather than taken from the front: an intro is the
    least representative part of a piece, which is the entire reason this is
    measured over the whole file.
    """
    total = (n_samples - FRAME_SIZE) // HOP_SIZE + 1
    total = max(0, total) // PATCH_FRAMES
    if total < 1:
        return []
    take = max(1, min(total, take))
    last = max(0, n_samples - PATCH_SAMPLES)
    if take == 1:
        return [0]
    step = (total - 1) / (take - 1)
    out = []
    for i in range(take):
        off = min(last, int(round(i * step)) * PATCH_FRAMES * HOP_SIZE)
        if not out or off != out[-1]:
            out.append(off)
    return out


def _log_mel_patches(samples, offsets):
    """(patches, 128, 96) log-mel, to the published MusiCNN parametrization.

    ONLY the patches that will be embedded are transformed, and that is a
    correctness property as much as a speed one. Computing the whole file's
    spectrogram and then keeping a sixtieth of it made the cost — and the peak
    memory — scale with the length of the track: numpy's rfft returns complex128
    whatever it is fed, so an hour-long DJ set reached the better part of a
    gigabyte of temporaries for sixty patches of output. A library has hour-long
    sets in it, this runs alongside a music server, and that is what "it stops
    after ten thousand tracks" looks like from the inside. Here the working set
    is bounded by MAX_PATCHES, so a one-minute track and a two-hour one cost the
    same.
    """
    import numpy as np

    if not offsets:
        raise ValueError("too short to embed")
    block = np.empty((len(offsets), PATCH_FRAMES, FRAME_SIZE), dtype=np.float32)
    stride = samples.strides[0]
    for k, off in enumerate(offsets):
        seg = samples[off : off + PATCH_SAMPLES]
        if len(seg) < PATCH_SAMPLES:
            raise ValueError("too short to embed")
        block[k] = np.lib.stride_tricks.as_strided(
            seg, shape=(PATCH_FRAMES, FRAME_SIZE), strides=(stride * HOP_SIZE, stride)
        )
    window = np.hanning(FRAME_SIZE + 1)[:-1].astype(np.float32)
    block *= window
    spec = np.abs(np.fft.rfft(block, axis=2)) ** 2
    mel = spec.astype(np.float32) @ _mel_filterbank(np).T
    # The compression the model was trained with. Not a natural log: base 10.
    return np.log10(10000.0 * mel + 1.0).astype(np.float32)


def _make_session(path):
    """A CPU, single-threaded inference session for one model file."""
    import onnxruntime as ort

    opts = ort.SessionOptions()
    # One thread: this is background work that must never take the box away from
    # streaming.
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    return ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])


def _load_session():
    """The inference session, loading it once and retrying a failure later.

    A failure is remembered for SESSION_RETRY_DELAY and then forgotten, never
    for good. "No model file" is the one exception worth keeping cheap — it is
    answered from disk in microseconds and says nothing about a transient state
    — but even that is re-checked, because uploading the model is precisely how
    an operator fixes it.
    """
    global _session, _session_error, _session_retry_at
    if _session is not None:
        return _session
    if _session_error is not None and time.monotonic() < _session_retry_at:
        return None
    with _lock:
        if _session is not None:
            return _session
        if _session_error is not None and time.monotonic() < _session_retry_at:
            return None
        path = model_path()
        if not path:
            _session_error = "no model file"
            _session_retry_at = time.monotonic() + SESSION_RETRY_DELAY
            return None
        try:
            _session = _make_session(path)
            _session_error = None
            _session_retry_at = 0.0
            logger.info(
                "embedding model loaded: %s (inputs=%s outputs=%s)",
                os.path.basename(path),
                [(i.name, i.shape) for i in _session.get_inputs()],
                [o.name for o in _session.get_outputs()],
            )
        except Exception as exc:
            logger.warning("embedding: could not load %s", path, exc_info=True)
            _session = None
            _session_error = f"{os.path.basename(path)}: {exc}"
            _session_retry_at = time.monotonic() + SESSION_RETRY_DELAY
    return _session


def session_error() -> str | None:
    """Why the model cannot be used, or None when it loads.

    BLOCKS on the first call — loading a 40 MB ONNX graph takes seconds — so it
    belongs on a worker, never on a request thread. A page that only wants to
    SHOW the state asks `session_probe` instead.

    Loading is cached, so this is cheap after the first call. A backfill asks
    once before it starts: failing 3000 tracks one by one tells the operator
    nothing, while one sentence about the model tells them everything."""
    if _load_session() is not None:
        return None
    return _session_error or "the model could not be loaded (see the server log)"


_probe_thread = None


def session_probe() -> dict:
    """What we already know about the model, WITHOUT waiting to find out.

    ``{"state": "ok" | "error" | "checking", "error": str | None}``.

    The studio's first request used to load the model on the thread serving it,
    and a 40 MB graph is seconds — on a page that also wanted three other
    things, that was most of a minute before anything painted. Nobody needs the
    answer synchronously: the page can say "vérification…" and ask again. So
    this reports what is known and starts a background load when it is not,
    which the next poll picks up.
    """
    global _probe_thread
    with _lock:
        if _session is not None:
            return {"state": "ok", "error": None}
        err = _session_error
        stale = err is not None and time.monotonic() >= _session_retry_at
        busy = _probe_thread is not None and _probe_thread.is_alive()
        if err is not None and not stale:
            return {"state": "error", "error": err}
        if busy:
            return {"state": "checking", "error": None}
        _probe_thread = threading.Thread(
            target=_load_session, name="embed-probe", daemon=True
        )
        _probe_thread.start()
    return {"state": "checking", "error": None}


def _run(patches):
    """(patches, 128, 96) → every patch's penultimate embedding, one row each.

    The aggregation over patches happens in `_aggregate`, not here: the mean
    alone is no longer the whole answer, and keeping this at "what the model
    said about each patch" keeps the two responsibilities separate.
    """
    import numpy as np

    sess = _load_session()
    if sess is None:
        return None
    inp = sess.get_inputs()[0]
    # Believe the model, not our assumption: if its declared input is not what
    # we built, say so rather than feeding it something shaped plausibly wrong.
    problem = _input_problem(inp.shape)
    if problem:
        raise ValueError(f"{problem} (front-end makes {patches.shape})")
    outs = sess.run(None, {inp.name: patches.astype(np.float32)})
    # The published model has two outputs: the 400 style activations and the
    # penultimate embedding. Take whichever is MODEL_DIM wide; with a single
    # output, take it.
    pick = None
    for o in outs:
        if o.ndim == 2 and o.shape[1] == MODEL_DIM:
            pick = o
            break
    if pick is None:
        pick = outs[-1] if outs[-1].ndim == 2 else outs[-1].reshape(1, -1)
    return pick.astype(np.float32)


def _aggregate(rows):
    """Per-patch embeddings (n, 1280) → ONE stored vector (2560,).

    The mean and the standard deviation over the track, concatenated, exactly
    as the model's authors publish it. Each patch is L2-normalized first, so a
    loud patch does not outvote a quiet one (this is a summary of what the
    music IS, not of how loud the master is), then each half is normalized
    before the two are joined, so neither half can dominate the dot product a
    linear head performs.
    """
    import numpy as np

    x = np.asarray(rows, dtype=np.float32)
    if x.ndim == 1:
        x = x.reshape(1, -1)
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    x = x / np.maximum(norms, 1e-9)
    mean = x.mean(axis=0)
    std = x.std(axis=0) if x.shape[0] > 1 else np.zeros_like(mean)
    for half in (mean, std):
        n = float(np.linalg.norm(half))
        if n > 1e-9:
            half /= n
    vec = np.concatenate([mean, std]).astype(np.float32)
    norm = float(np.linalg.norm(vec))
    return (vec / norm) if norm > 1e-9 else vec


def embed_file(path):
    """A single L2-normalized vector summarising the whole file, or None."""
    vec, _reason = embed_file_verbose(path)
    return vec


def embed_file_verbose(path):
    """``(vector, reason)`` — exactly one of which is set.

    The reason is what turns "3000 tracks failed" into a sentence the operator
    can act on: a missing ffmpeg, a model with the wrong input shape, a file
    that is too short."""
    if not available():
        return None, why_unavailable() or "extractor unavailable"
    if not os.path.isfile(path):
        return None, "file missing"
    try:
        samples = _decode(path)
        patches = _log_mel_patches(samples, patch_offsets(len(samples)))
        del samples
    except Exception as exc:
        logger.warning("embedding: front-end failed for %s", path, exc_info=True)
        return None, f"decode/front-end: {exc}"
    try:
        rows = _run(patches)
    except Exception as exc:
        logger.warning("embedding: inference failed for %s", path, exc_info=True)
        return None, f"inference: {exc}"
    if rows is None:
        return None, session_error() or "no model session"
    return _aggregate(rows).astype("float32"), None


# --- storage ----------------------------------------------------------------
# Beside the audio, like the cover and the lyrics: an archived track carries its
# whole identity on disk, and a database restored from an old backup should not
# have to re-decode the library to get these back.
def sidecar_path(track) -> str | None:
    if not track or not track.path:
        return None
    base, _ext = os.path.splitext(track.path)
    return base + ".emb"


# Reading a vector back is deliberately numpy-free, and that is not a stylistic
# choice. EXTRACTING needs onnxruntime (and numpy with it); USING what was
# already extracted must not, or a server that lost the optional dependency —
# or never had it, and copied its archive from one that did — would answer
# "no vectors" about files that are sitting right there, and the studio would
# be dead on a stock install. struct's "e" format is float16 since 3.6, so the
# sidecar is exactly as portable either way.
def _pack_f16(vec) -> bytes:
    values = [float(v) for v in vec]
    return struct.pack(f"<{len(values)}e", *values)


def save_embedding(track, vec) -> bool:
    p = sidecar_path(track)
    if not p or vec is None:
        return False
    try:
        # float16 halves the file for a precision nothing downstream can see.
        with open(p, "wb") as fp:
            fp.write(_pack_f16(vec))
        return True
    except Exception:
        logger.warning("embedding: could not write %s", p, exc_info=True)
        return False


def load_embedding(track):
    """The stored vector as a list of floats, or None.

    A list, not an array: `genre.predict` works on plain floats and this is the
    only thing that reads it.

    The DIMENSION is the version. A v2 sidecar is 2·MODEL_DIM wide (mean and
    standard deviation); a v1 one, written before that change, is MODEL_DIM
    wide and still reads back — it is a perfectly good training row, it is just
    not what a v2-trained head expects. Callers that need a head to read it
    already check the width (`genre.predict` returns None on a mismatch), so a
    stale vector degrades to "no prediction" rather than to a wrong one.
    """
    p = sidecar_path(track)
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p, "rb") as fp:
            raw = fp.read()
        dim = len(raw) // 2
        if dim * 2 != len(raw) or dim not in (EMBED_DIM, LEGACY_EMBED_DIM):
            return None
        return list(struct.unpack(f"<{dim}e", raw))
    except Exception:
        return None


def embedding_version(track) -> int:
    """1 for a mean-only sidecar, 2 for the mean+std one, 0 for none.

    Read from the file's own width rather than a header byte: the sidecar is a
    raw float16 blob on purpose (see the module docstring), and a 1280-float
    file could only ever have been written by v1.
    """
    p = sidecar_path(track)
    if not p or not os.path.isfile(p):
        return 0
    try:
        size = os.path.getsize(p)
    except OSError:
        return 0
    if size == EMBED_DIM * 2:
        return 2
    if size == LEGACY_EMBED_DIM * 2:
        return 1
    return 0


def vector_is_current(vec) -> bool:
    """Whether a vector is the width the current extractor produces."""
    return vec is not None and len(vec) == EMBED_DIM


def encode_embedding(vec) -> str | None:
    """float16 base64 — what the API hands the browser to train on."""
    if vec is None:
        return None
    try:
        return base64.b64encode(_pack_f16(vec)).decode("ascii")
    except Exception:
        return None


def ensure_embedding(track):
    """The stored vector, computing and saving it if it is not there yet.

    A v1 (mean-only) sidecar is treated as absent and re-extracted, when the
    extractor is available: the vector is still readable, but a head trained on
    v2 vectors cannot use it, so leaving it would silently stop predicting.
    Without the extractor it is returned as it is — a library extracted on a
    server that no longer has onnxruntime keeps working exactly as before.
    """
    vec = load_embedding(track)
    if vec is not None and vector_is_current(vec):
        return vec
    if vec is not None and not available():
        return vec
    if not track or not track.path:
        return vec
    new = embed_file(track.path)
    if new is not None:
        save_embedding(track, new)
        return new
    return vec


# --- the self test ----------------------------------------------------------
def self_test(paths, progress=None):
    """Is the front-end right? Answered without a reference implementation.

    A wrong mel front-end does not crash and does not produce obviously broken
    numbers — it produces vectors that are simply meaningless, which is the
    worst possible failure because everything downstream keeps working and
    quietly learns nothing. The check that catches it needs no ground truth: two
    different halves of the SAME track must embed close together, and clearly
    closer than two different tracks do. An extractor that has lost the signal
    cannot do that.
    """
    import numpy as np

    say = progress or (lambda *_a: None)
    why = why_unavailable()
    if why:
        return {"ok": False, "reason": why}
    # A model that loads but cannot be fed is the failure this test exists to
    # catch — say which it is rather than "could not embed enough material".
    load_err = session_error()
    if load_err:
        return {"ok": False, "reason": f"the model cannot be used: {load_err}"}
    paths = [p for p in paths if p and os.path.isfile(p)][:6]
    if len(paths) < 2:
        return {"ok": False, "reason": "need at least two archived tracks to test"}

    halves = []
    first_error = None
    for p in paths:
        say(f"  {os.path.basename(p)}")
        try:
            dur = _probe_duration(p)
            if not dur or dur < 60:
                if first_error is None:
                    first_error = "the tracks tested are shorter than 60 s"
                continue
            a = _embed_span(p, start=dur * 0.15, seconds=min(40, dur * 0.3))
            b = _embed_span(p, start=dur * 0.6, seconds=min(40, dur * 0.3))
        except Exception as exc:
            logger.warning("embedding: self-test failed on %s", p, exc_info=True)
            if first_error is None:
                first_error = f"{os.path.basename(p)}: {exc}"
            continue
        if a is not None and b is not None:
            halves.append((a, b))
        elif first_error is None:
            first_error = f"{os.path.basename(p)}: the model produced no vector"
    if len(halves) < 2:
        return {
            "ok": False,
            "reason": first_error or "could not embed enough material to judge",
            "tracks": len(halves),
        }

    same = [float(np.dot(a, b)) for a, b in halves]
    other = []
    for i in range(len(halves)):
        for j in range(len(halves)):
            if i != j:
                other.append(float(np.dot(halves[i][0], halves[j][1])))
    same_mean = sum(same) / len(same)
    other_mean = sum(other) / len(other)
    margin = same_mean - other_mean
    ok = margin > 0.05 and same_mean > 0.3
    return {
        "ok": ok,
        "same_track": round(same_mean, 4),
        "different_tracks": round(other_mean, 4),
        "margin": round(margin, 4),
        "tracks": len(halves),
        "reason": None
        if ok
        else "two halves of the same track do not embed closer than two "
        "different tracks — the mel front-end almost certainly does not match "
        "what this model was trained on",
    }


def _probe_duration(path):
    import re

    out = subprocess.run(
        ["ffmpeg", "-nostats", "-v", "info", "-i", path, "-f", "null", "-"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        timeout=FFMPEG_TIMEOUT, check=False,
    ).stderr.decode("utf-8", "replace")
    last = None
    for m in re.finditer(r"time=\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)", out):
        last = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return last


def _embed_span(path, start, seconds):
    samples = _decode(path, seconds=seconds, start=start)
    offsets = patch_offsets(len(samples))
    if not offsets:
        return None
    rows = _run(_log_mel_patches(samples, offsets))
    return None if rows is None else _aggregate(rows)

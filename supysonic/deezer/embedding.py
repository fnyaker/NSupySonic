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
import struct
import subprocess
import threading

logger = logging.getLogger(__name__)

# Bump when the extractor changes in a way that invalidates stored vectors.
EMBED_VERSION = 1
EMBED_DIM = 1280  # discogs-effnet's penultimate layer

# --- the published MusiCNN front-end spec ----------------------------------
SAMPLE_RATE = 16000
FRAME_SIZE = 512
HOP_SIZE = 256
MEL_BANDS = 96
PATCH_FRAMES = 128  # ~2.05 s per patch, the model's input length
# How many patches to embed, spread over the track. The whole point is a summary
# of the piece, and forty patches is two minutes of audio sampled across it —
# well past the point where the mean stops moving.
MAX_PATCHES = 40
FFMPEG_TIMEOUT = 300

_lock = threading.Lock()
_session = None
_session_failed = False
_mel_fb = None


def available() -> bool:
    """True when this server can extract embeddings at all."""
    try:
        import numpy  # noqa: F401
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return True


def why_unavailable() -> str | None:
    """A sentence the CLI and the API can show, or None when it works."""
    try:
        import numpy  # noqa: F401
    except Exception:
        return "numpy is not installed"
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return "onnxruntime is not installed (pip install 'supysonic[embedding]')"
    if not model_path():
        return "no model file; set [deezer] embed_model or place it in the cache dir"
    return None


def model_path() -> str | None:
    """Where the ONNX model is, or None.

    Deliberately NOT vendored in the repository and never fetched silently: the
    model is a third-party artefact with its own licence, so the operator points
    at a copy they obtained themselves. `supysonic-cli deezer embed --help` says
    where to get it.
    """
    from flask import current_app

    try:
        conf = current_app.config.get("DEEZER", {})
    except Exception:
        conf = {}
    explicit = conf.get("embed_model")
    if explicit and os.path.isfile(explicit):
        return explicit
    for base in filter(None, [conf.get("cache_dir"), conf.get("archive_dir")]):
        p = os.path.join(base, "models", "discogs-effnet-bs64-1.onnx")
        if os.path.isfile(p):
            return p
    return None


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


def _log_mel(samples):
    """(frames, 96) log-mel, to the published MusiCNN parametrization."""
    import numpy as np

    n = 1 + max(0, (len(samples) - FRAME_SIZE) // HOP_SIZE)
    if n < PATCH_FRAMES:
        raise ValueError("too short to embed")
    # One strided view over the signal: no copy, no Python loop over frames.
    frames = np.lib.stride_tricks.as_strided(
        samples,
        shape=(n, FRAME_SIZE),
        strides=(samples.strides[0] * HOP_SIZE, samples.strides[0]),
    )
    window = np.hanning(FRAME_SIZE + 1)[:-1].astype(np.float32)
    spec = np.abs(np.fft.rfft(frames * window, axis=1)) ** 2
    mel = spec.astype(np.float32) @ _mel_filterbank(np).T
    # The compression the model was trained with. Not a natural log: base 10.
    return np.log10(10000.0 * mel + 1.0).astype(np.float32)


def _load_session():
    global _session, _session_failed
    if _session is not None or _session_failed:
        return _session
    with _lock:
        if _session is not None or _session_failed:
            return _session
        path = model_path()
        if not path:
            _session_failed = True
            return None
        try:
            import onnxruntime as ort

            opts = ort.SessionOptions()
            # One thread: this is background work that must never take the box
            # away from streaming.
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            _session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
            logger.info(
                "embedding model loaded: %s (inputs=%s outputs=%s)",
                os.path.basename(path),
                [(i.name, i.shape) for i in _session.get_inputs()],
                [o.name for o in _session.get_outputs()],
            )
        except Exception:
            logger.warning("embedding: could not load %s", path, exc_info=True)
            _session_failed = True
            _session = None
    return _session


def _run(patches):
    """(patches, 128, 96) → the model's embedding output, meaned over patches."""
    import numpy as np

    sess = _load_session()
    if sess is None:
        return None
    inp = sess.get_inputs()[0]
    # Believe the model, not our assumption: if its declared input is not what
    # we built, say so rather than feeding it something shaped plausibly wrong.
    want = [d for d in inp.shape if isinstance(d, int)]
    if want and want[-2:] != [PATCH_FRAMES, MEL_BANDS] and want[-1] != MEL_BANDS:
        raise ValueError(f"model expects {inp.shape}, front-end makes {patches.shape}")
    outs = sess.run(None, {inp.name: patches.astype(np.float32)})
    # The published model has two outputs: the 400 style activations and the
    # penultimate embedding. Take whichever is EMBED_DIM wide; with a single
    # output, take it.
    pick = None
    for o in outs:
        if o.ndim == 2 and o.shape[1] == EMBED_DIM:
            pick = o
            break
    if pick is None:
        pick = outs[-1]
    vec = pick.mean(axis=0)
    norm = float(np.linalg.norm(vec))
    return (vec / norm) if norm > 1e-9 else vec


def embed_file(path):
    """A single L2-normalized vector summarising the whole file, or None."""
    import numpy as np

    if not available() or not os.path.isfile(path):
        return None
    try:
        mel = _log_mel(_decode(path))
    except Exception:
        logger.warning("embedding: front-end failed for %s", path, exc_info=True)
        return None
    total = mel.shape[0] // PATCH_FRAMES
    if total < 1:
        return None
    # Spread the patches over the whole track rather than taking the first two
    # minutes: an intro is the least representative part of a piece, which is
    # the entire reason this is measured over the whole file.
    take = min(total, MAX_PATCHES)
    idx = [int(round(i * (total - 1) / max(1, take - 1))) for i in range(take)]
    patches = np.stack([mel[j * PATCH_FRAMES : (j + 1) * PATCH_FRAMES] for j in idx])
    try:
        vec = _run(patches)
    except Exception:
        logger.warning("embedding: inference failed for %s", path, exc_info=True)
        return None
    return None if vec is None else vec.astype("float32")


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
    """
    p = sidecar_path(track)
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p, "rb") as fp:
            raw = fp.read()
        if len(raw) != EMBED_DIM * 2:
            return None
        return list(struct.unpack(f"<{EMBED_DIM}e", raw))
    except Exception:
        return None


def encode_embedding(vec) -> str | None:
    """float16 base64 — what the API hands the browser to train on."""
    if vec is None:
        return None
    try:
        return base64.b64encode(_pack_f16(vec)).decode("ascii")
    except Exception:
        return None


def ensure_embedding(track):
    """The stored vector, computing and saving it if it is not there yet."""
    vec = load_embedding(track)
    if vec is not None:
        return vec
    vec = embed_file(track.path) if track and track.path else None
    if vec is not None:
        save_embedding(track, vec)
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
    paths = [p for p in paths if p and os.path.isfile(p)][:6]
    if len(paths) < 2:
        return {"ok": False, "reason": "need at least two archived tracks to test"}

    halves = []
    for p in paths:
        say(f"  {os.path.basename(p)}")
        try:
            dur = _probe_duration(p)
            if not dur or dur < 60:
                continue
            a = _embed_span(p, start=dur * 0.15, seconds=min(40, dur * 0.3))
            b = _embed_span(p, start=dur * 0.6, seconds=min(40, dur * 0.3))
        except Exception:
            continue
        if a is not None and b is not None:
            halves.append((a, b))
    if len(halves) < 2:
        return {"ok": False, "reason": "could not embed enough material to judge"}

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
    import numpy as np

    mel = _log_mel(_decode(path, seconds=seconds, start=start))
    total = mel.shape[0] // PATCH_FRAMES
    if total < 1:
        return None
    patches = np.stack([mel[i * PATCH_FRAMES : (i + 1) * PATCH_FRAMES] for i in range(total)])
    return _run(patches)

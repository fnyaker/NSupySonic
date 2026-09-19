# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Using the head the tagging studio trained.

The head is a plain linear map from the frozen extractor's 1280-dimensional
embedding to the user's own genre vocabulary: a weight matrix and a bias, and a
softmax. Evaluating it is a dot product — a few tens of thousands of multiplies,
microseconds — which is exactly why this server needs no machine-learning
framework to USE a model, only (optionally) to produce the embeddings it reads.

Kept deliberately dependency-free: it works on plain Python lists, so a server
that has embeddings from an earlier install but no onnxruntime today can still
classify what it already measured.
"""

from __future__ import annotations

import base64
import json
import logging
import math
import struct
import time

from ..db import GenreModel, GenreTag, Track, TrackTag

logger = logging.getLogger(__name__)

# The head is read on every analysed track; re-parsing 70 KB of base64 each time
# would be silly, and it changes only when the studio uploads a new one.
_cache = {"id": None, "at": 0.0, "head": None}
_CACHE_TTL = 5.0


def _decode_f16(blob: str):
    """base64 float16 -> a list of floats, without numpy.

    One unpack for the whole buffer rather than one per value: a hidden layer
    is three hundred thousand weights, and a per-element loop over that is half
    a second of pure Python every time the head is reloaded.
    """
    raw = base64.b64decode(blob)
    if len(raw) % 2:
        raise ValueError("odd float16 payload")
    return list(struct.unpack(f"<{len(raw) // 2}e", raw))


def active_head():
    """The live head as {labels, dim, w, b}, or None."""
    now = time.monotonic()
    if _cache["head"] is not None and now - _cache["at"] < _CACHE_TTL:
        return _cache["head"]
    row = (
        GenreModel.select()
        .where(GenreModel.active == True)  # noqa: E712 — peewee needs ==
        .order_by(GenreModel.created.desc())
        .first()
    )
    if row is None:
        _cache.update(id=None, at=now, head=None)
        return None
    if _cache["id"] == row.id and _cache["head"] is not None:
        _cache["at"] = now
        return _cache["head"]
    try:
        labels = json.loads(row.labels)
        flat = _decode_f16(row.weights)
        dim = int(row.dim or 1280)
        n = len(labels)
        kind = (row.kind or "linear").lower()
        hidden = int(row.hidden or 0)
        head = {"labels": labels, "dim": dim, "kind": kind, "hidden": hidden,
                "id": row.id, "version": row.version, "temperature": 1.0}
        # Temperature scaling, fit by the studio on held-out folds and carried
        # in the metrics JSON. Softmax logits are routinely OVER-confident on
        # few-shot training — a head that is right 70% of the time happily says
        # 0.95 — and the gate in analysis.py decides whether to act on a guess
        # by comparing that number to a threshold. So a head left at T=1 is
        # judged by a scale it never earned: miscalibration cost here is paid
        # in wrong labels APPLIED, not in the top-1 rate. Dividing the logits
        # by a fitted T above 1 flattens them so that "0.7" really does mean
        # seventy percent, and the gate then keeps the head's good calls and
        # drops its loud bad ones. It is a single scalar, needs no retraining,
        # and cannot change which label wins — only how much the winner claims.
        try:
            temp = float((json.loads(row.metrics or "{}") or {}).get("temperature") or 1.0)
            if 0.25 <= temp <= 8.0:
                head["temperature"] = temp
        except Exception:
            pass
        if kind == "mlp2":
            want = (
                hidden * dim + hidden
                + hidden * hidden + hidden
                + n * hidden + n
            )
            if n < 2 or hidden < 1 or len(flat) != want:
                raise ValueError(
                    f"weights are {len(flat)} long, expected {want} for a "
                    f"two-layer MLP of {dim}x{hidden}x{hidden}x{n}"
                )
            o = 0
            head["w1"] = [flat[o + i * dim : o + (i + 1) * dim] for i in range(hidden)]
            o += hidden * dim
            head["b1"] = flat[o : o + hidden]
            o += hidden
            head["w2"] = [flat[o + i * hidden : o + (i + 1) * hidden] for i in range(hidden)]
            o += hidden * hidden
            head["b2"] = flat[o : o + hidden]
            o += hidden
            head["w3"] = [flat[o + i * hidden : o + (i + 1) * hidden] for i in range(n)]
            o += n * hidden
            head["b3"] = flat[o : o + n]
        elif kind == "mlp":
            want = hidden * dim + hidden + n * hidden + n
            if n < 2 or hidden < 1 or len(flat) != want:
                raise ValueError(
                    f"weights are {len(flat)} long, expected {want} for an MLP "
                    f"of {dim}x{hidden}x{n}"
                )
            o = 0
            head["w1"] = [flat[o + i * dim : o + (i + 1) * dim] for i in range(hidden)]
            o += hidden * dim
            head["b1"] = flat[o : o + hidden]
            o += hidden
            head["w2"] = [flat[o + i * hidden : o + (i + 1) * hidden] for i in range(n)]
            o += n * hidden
            head["b2"] = flat[o : o + n]
        else:
            want = n * dim + n
            if n < 2 or len(flat) != want:
                raise ValueError(
                    f"weights are {len(flat)} long, expected {want} for "
                    f"{n} labels x {dim} dims"
                )
            head["w"] = [flat[i * dim : (i + 1) * dim] for i in range(n)]
            head["b"] = flat[n * dim :]
    except Exception:
        logger.warning("genre: stored head is unusable, ignoring it", exc_info=True)
        head = None
    _cache.update(id=row.id, at=now, head=head)
    return head


def invalidate():
    _cache.update(id=None, at=0.0, head=None)


def predict(vec):
    """(label, confidence, probabilities, margin) for one embedding, or None.

    ``margin`` is top1 − top2. It is reported because it is the better gate on
    whether a guess is worth acting on: a head can be 0.6 on the right label
    with the rest spread over ten neighbours (genuinely unsure), or 0.5 with
    everything else at 0.02 (genuinely sure). A threshold on the top probability
    alone cannot tell those apart; a decision that needs both is the honest one.
    """
    head = active_head()
    if head is None or vec is None:
        return None
    dim = head["dim"]
    x = list(vec)
    if len(x) != dim:
        return None
    if head["kind"] == "mlp2":
        h1 = []
        for row, bias in zip(head["w1"], head["b1"]):
            acc = bias
            for i in range(dim):
                acc += row[i] * x[i]
            h1.append(acc if acc > 0 else 0.0)  # relu
        h2 = []
        for row, bias in zip(head["w2"], head["b2"]):
            acc = bias
            for i, h in enumerate(h1):
                if h:
                    acc += row[i] * h
            h2.append(acc if acc > 0 else 0.0)  # relu
        logits = []
        for row, bias in zip(head["w3"], head["b3"]):
            acc = bias
            for i, h in enumerate(h2):
                if h:
                    acc += row[i] * h
            logits.append(acc)
    elif head["kind"] == "mlp":
        hid = []
        for row, bias in zip(head["w1"], head["b1"]):
            acc = bias
            for i in range(dim):
                acc += row[i] * x[i]
            hid.append(acc if acc > 0 else 0.0)  # relu
        logits = []
        for row, bias in zip(head["w2"], head["b2"]):
            acc = bias
            for i, h in enumerate(hid):
                if h:
                    acc += row[i] * h
            logits.append(acc)
    else:
        logits = []
        for row, bias in zip(head["w"], head["b"]):
            acc = bias
            for i in range(dim):
                acc += row[i] * x[i]
            logits.append(acc)
    # Temperature scaling, as loaded with the head. Dividing every logit by the
    # same T cannot reorder them, so the argmax — and therefore which label the
    # studio shows, and which the head would pick if the gate were open — is
    # untouched. What changes is the SHAPE of the distribution: T>1 flattens an
    # over-confident head, the margin shrinks with it, and a gate that would
    # have acted on 0.9-of-nothing declines. That is the whole point.
    temp = float(head.get("temperature") or 1.0)
    if temp != 1.0:
        logits = [v / temp for v in logits]
    top = max(logits)
    exps = [math.exp(v - top) for v in logits]
    total = sum(exps) or 1.0
    probs = [e / total for e in exps]
    order = sorted(range(len(probs)), key=probs.__getitem__, reverse=True)
    best = order[0]
    second = probs[order[1]] if len(order) > 1 else 0.0
    dist = {head["labels"][i]: round(probs[i], 4) for i in range(len(probs))}
    margin = round(max(0.0, probs[best] - second), 4)
    return head["labels"][best], round(probs[best], 4), dist, margin


def archetype_for(label):
    """The visual archetype the user attached to that genre, if any."""
    if not label:
        return None
    tag = GenreTag.get_or_none(GenreTag.name == label)
    return tag.archetype if tag else None


# --- the prototype classifier -------------------------------------------------
# Every genre's average vector, and a cosine similarity to it. This needs no
# training at all, which is the point: it exists for the state the studio is in
# for its whole first day, where a genre has one or two examples and the head
# has either nothing or a model too thin to trust.
#
# It is deliberately NOT wired into the analysis. A nearest-centroid guess has no
# confidence to gate on — "closest of eleven averages" is a decision even when
# the track is unlike all eleven — so letting it relabel tracks would be exactly
# the kind of unearned certainty this codebase spends the rest of its effort
# refusing. It is offered to the STUDIO, next to the head's own guess, where a
# human is looking and the worst case is a suggestion they ignore.
_centroid_cache = {"key": None, "at": 0.0, "data": None}
_CENTROID_TTL = 5.0


def _labelled_rows() -> list[tuple[str, list[float]]]:
    """(genre name, embedding) for every manually tagged track that has one.

    The vectors are read from disk, so this is not free — callers go through
    ``centroids()``, which caches. A track tagged before its embedding existed
    is simply not a row yet; the next extraction adds it.
    """
    from . import embedding as emb

    out = []
    for tt in TrackTag.select(TrackTag, Track, GenreTag).join(Track).switch(TrackTag).join(GenreTag):
        vec = emb.load_embedding(tt.track)
        if vec is None or len(vec) != emb.EMBED_DIM:
            continue
        name = tt.tag.name
        out.append((name, vec))
    return out


def _unit(vec):
    """L2-normalised, or None for a zero vector.

    Normalising before averaging is what keeps a loud track and a quiet one from
    pulling the prototype by their magnitudes rather than by their direction —
    the embedding's length is not a genre signal.
    """
    n = math.sqrt(sum(v * v for v in vec))
    if n <= 1e-9:
        return None
    return [v / n for v in vec]


def centroids():
    """{genre name: {centroid, n}} over the labelled set, or None.

    None means "nothing to say" — no labels, or no labelled track has a usable
    vector. That is different from an empty dict and the caller should keep the
    two apart.
    """
    now = time.monotonic()
    # The timestamp is the guard, not the payload: caching "there are no labels"
    # with the same TTL is the difference between a studio page costing one query
    # and costing a full read of every sidecar on disk.
    if _centroid_cache["at"] > 0 and now - _centroid_cache["at"] < _CENTROID_TTL:
        return _centroid_cache["data"]

    rows = _labelled_rows()
    if not rows:
        _centroid_cache.update(key=None, at=now, data=None)
        return None
    # A cheap signature of WHAT was read — names AND how many tracks back each
    # one — so a label added a moment ago is picked up without re-reading every
    # vector, but only when the TTL has lapsed, so the common case stays one dict
    # lookup. Counts are in the signature because labelling a second track under
    # an existing genre changes no name but does move that genre's centroid.
    counts_by_name = {}
    for name, _vec in rows:
        counts_by_name[name] = counts_by_name.get(name, 0) + 1
    key = tuple(sorted(counts_by_name.items()))
    if _centroid_cache["key"] == key and _centroid_cache["at"] > 0:
        _centroid_cache["at"] = now
        return _centroid_cache["data"]

    sums: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for name, vec in rows:
        u = _unit(vec)
        if u is None:
            continue
        acc = sums.get(name)
        if acc is None:
            sums[name] = list(u)
        else:
            for i in range(len(u)):
                acc[i] += u[i]
        counts[name] = counts.get(name, 0) + 1

    out = {}
    for name, acc in sums.items():
        c = _unit(acc)
        if c is not None:
            out[name] = {"centroid": c, "n": counts[name]}
    data = out or None
    _centroid_cache.update(key=key, at=now, data=data)
    return data


def prototype_predict(vec):
    """(label, similarity) of the nearest genre prototype, or None.

    Cosine, not Euclidean: the embeddings live on a sphere after the extractor's
    normalisation, and the angle is the part that carries the genre. The
    similarity is returned raw (roughly 0.5-0.95 in practice) rather than dressed
    up as a probability it does not mean.
    """
    if vec is None:
        return None
    table = centroids()
    if not table:
        return None
    u = _unit(list(vec))
    if u is None:
        return None
    best = None
    for name, row in table.items():
        c = row["centroid"]
        s = 0.0
        for i in range(len(c)):
            s += c[i] * u[i]
        if best is None or s > best[1]:
            best = (name, s)
    if best is None:
        return None
    return best[0], round(best[1], 4)


def invalidate_centroids():
    _centroid_cache.update(key=None, at=0.0, data=None)


# --- the studio's starting vocabulary ---------------------------------------
# A fresh studio opens onto nothing, which means every genre the engine can
# already guess has to be retyped before a single track can be confirmed. So the
# engine's own families (deezer/analysis.py) are seeded as ready-made tags.
# A Meta value remembers how many the engine knew last time, so a later release
# that adds families re-syncs them on the next admin visit — while a genre the
# user deleted stays deleted as long as the vocabulary has not changed.
SEED_META_KEY = "genre_seeded"
# Distinct hues, so a vocabulary seeded in one go never repeats a colour.
DEFAULT_COLORS = [
    "#f43f5e", "#f97316", "#eab308", "#84cc16", "#10b981", "#06b6d4",
    "#3b82f6", "#8b5cf6", "#d946ef", "#ec4899", "#64748b", "#14b8a6",
    "#ef4444", "#f59e0b", "#22c55e", "#0ea5e9", "#6366f1", "#a855f7",
    "#f472b6", "#94a3b8",
]


def seed_signature() -> str:
    """How many genres the engine knows — the seed's "already done" marker."""
    from .analysis import known_genres

    return str(len(known_genres()))


def seed_default_tags(force: bool = False) -> int:
    """Create the engine's genres as tags; returns how many were added.

    Idempotent and additive: existing names are left exactly as they are (the
    user may have recoloured or re-archetyped one), and nothing is ever edited
    or deleted. Runs when the engine's vocabulary has changed since the last run,
    or always with `force` (the studio's "Genres du moteur" button), which only
    fills in what is missing.
    """
    from ..db import Meta
    from .analysis import known_genres

    specs = known_genres()
    signature = str(len(specs))
    if not force:
        try:
            row = Meta.get_or_none(Meta.key == SEED_META_KEY)
            if row is not None and (row.value or "") == signature:
                return 0
        except Exception:
            logger.debug("genre: could not read the seed flag", exc_info=True)
            return 0

    created = 0
    try:
        existing = {t.name for t in GenreTag.select(GenreTag.name)}
        for i, (name, archetype) in enumerate(specs):
            name = str(name)[:48]
            if name in existing:
                continue
            try:
                GenreTag.create(
                    name=name,
                    color=DEFAULT_COLORS[i % len(DEFAULT_COLORS)],
                    archetype=archetype,
                )
                existing.add(name)
                created += 1
            except Exception:
                # A racing insert (two admins, two workers) is not worth failing
                # the page over: the tag exists either way.
                logger.warning("genre: could not seed %r", name, exc_info=True)
    except Exception:
        logger.warning("genre: seeding default tags failed", exc_info=True)

    try:
        row = Meta.get_or_none(Meta.key == SEED_META_KEY)
        if row is None:
            Meta.create(key=SEED_META_KEY, value=signature)
        else:
            row.value = signature
            row.save()
    except Exception:
        logger.debug("genre: could not store the seed flag", exc_info=True)
    return created

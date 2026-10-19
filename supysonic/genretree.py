# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The genre hierarchy: who is under whom, read from memory.

``genre_parent`` says "child sits under parent, this firmly" (weight 1 = a
sub-genre outright, less = related) and a genre may have several parents, so
the shape is a graph without cycles rather than a strict tree. ``genre_alias``
hangs the names other services use on a node.

The whole thing is a few hundred nodes, so it is loaded ONCE (a process cache
checked against ``Meta genre_tree_v`` at most every ``RECHECK`` seconds, and
dropped at once by any write made in this process) and every question below is
answered without SQL. Nodes are named by their tag's name, the same string a
verdict carries.

Until the default tree has been written to the database (a server that has not
been opened on the studio since the upgrade) the default data itself answers,
so what the tree decides never depends on whether somebody visited a page:
the nearest engine family of every label is the one the verdicts always used.

Writes go through ``add_parent`` / ``remove_parent`` / ``move`` / ``remove_node``
(cycles refused, version moved, the inverse of the write kept so ``undo`` can
take it back) and ``seed_tree`` / ``reset_tree``. Telling the devices and
re-deciding the verdicts is the caller's job (``webui/genre.py``).
"""

from __future__ import annotations

import heapq
import json
import logging
import threading
import time
import unicodedata

logger = logging.getLogger(__name__)

#: Meta keys (32 characters at most, 256 of value): the tree's version, the
#: version of the default data last seeded, the undo log and its counter, and
#: one marker per node whose place the person chose.
VERSION_KEY = "genre_tree_v"
SEEDED_KEY = "genre_tree_seeded"
LOG_COUNT_KEY = "genre_tree_logn"
LOG_PREFIX = "gtl:"
TOUCHED_PREFIX = "gtt:"

#: How often a cached tree is compared with the database's version.
RECHECK = 30.0
#: The undo log keeps this many writes.
LOG_MAX = 30
#: An edge of weight 1 is not free: the cheapest step is this.
MIN_EDGE = 0.1
#: A path as long as this is as far as two genres get ("far" = 1.0).
DIST_SCALE = 1.0


class CycleError(ValueError):
    """The edge would make a genre its own ancestor."""


def fold(name) -> str:
    """Lowercase, accents dropped: the form aliases are stored and looked up in."""
    s = unicodedata.normalize("NFD", str(name or "")).lower()
    return "".join(c for c in s if not unicodedata.combining(c)).strip()[:48]


# --- the in-memory tree -----------------------------------------------------
_FAMILY = {}  # fold(label or id) -> engine family id


def _family_ids():
    if not _FAMILY:
        from .deezer.analysis import FAMILIES

        for fid, label, _arch, _fn in FAMILIES:
            _FAMILY[fold(label)] = fid
            _FAMILY[fold(fid)] = fid
    return _FAMILY


class Tree:
    """An immutable snapshot with memoised answers."""

    def __init__(self, edges, aliases=(), nodes=(), version="0", virtual=False):
        self.version = version
        self.virtual = virtual
        self.parents = {}
        self.children = {}
        self.nodes = set(nodes)
        for child, parent, weight in edges:
            self.nodes.add(child)
            self.nodes.add(parent)
            self.parents.setdefault(child, []).append((parent, float(weight)))
            self.children.setdefault(parent, []).append((child, float(weight)))
        self.folded = {fold(n): n for n in self.nodes}
        self.aliases = {fold(k): v for k, v in aliases if v in self.nodes}
        self._up = {}
        self._down = {}
        self._fam = {}
        self._dist = {}

    def node(self, name):
        """The node a name stands for (exactly, folded, or by alias), or None."""
        if name in self.nodes:
            return name
        key = fold(name)
        return self.folded.get(key) or self.aliases.get(key)

    # -- walks ---------------------------------------------------------------
    def _walk(self, start, nexts):
        """{node: (hops, firmness)} from ``start`` along ``nexts``, nearest first."""
        seen = {start: (0, 1.0)}
        level = [start]
        hop = 0
        while level:
            hop += 1
            reached = {}
            for n in level:
                for m, w in nexts.get(n, ()):
                    if m in seen:
                        continue
                    f = seen[n][1] * w
                    if f > reached.get(m, 0.0):
                        reached[m] = f
            for m, f in reached.items():
                seen[m] = (hop, f)
            level = sorted(reached)
        return seen

    def up(self, name):
        got = self._up.get(name)
        if got is None:
            walk = self._walk(name, self.parents)
            got = [(n, h, f) for n, (h, f) in walk.items() if n != name]
            got.sort(key=lambda t: (t[1], -t[2], t[0]))
            self._up[name] = got
        return got

    def down(self, name):
        got = self._down.get(name)
        if got is None:
            walk = self._walk(name, self.children)
            got = [(n, h, f) for n, (h, f) in walk.items() if n != name]
            got.sort(key=lambda t: (t[1], -t[2], t[0]))
            self._down[name] = got
        return got

    def family(self, name):
        if name in self._fam:
            return self._fam[name]
        ids = _family_ids()
        out = ids.get(fold(name))
        if out is None:
            for n, _h, _f in self.up(name):
                out = ids.get(fold(n))
                if out is not None:
                    break
        self._fam[name] = out
        return out

    def distances(self, name):
        """Normalised distance from ``name`` to every node it can reach."""
        got = self._dist.get(name)
        if got is None:
            adj = {}
            for child, plist in self.parents.items():
                for parent, w in plist:
                    cost = max(MIN_EDGE, 1.0 - w)
                    adj.setdefault(child, []).append((parent, cost))
                    adj.setdefault(parent, []).append((child, cost))
            best = {name: 0.0}
            heap = [(0.0, name)]
            while heap:
                d, n = heapq.heappop(heap)
                if d > best.get(n, 9e9):
                    continue
                for m, cost in adj.get(n, ()):
                    nd = d + cost
                    if nd < best.get(m, 9e9):
                        best[m] = nd
                        heapq.heappush(heap, (nd, m))
            got = {n: min(1.0, d / DIST_SCALE) for n, d in best.items()}
            self._dist[name] = got
        return got


def default_edges():
    """The shipped data as ``(child, parent, weight)``."""
    from .deezer import genre_tree

    return list(genre_tree.TREE)


_lock = threading.RLock()
_cache = {"db": None, "tree": None, "at": 0.0}


def _db():
    from .db import db

    return getattr(db, "obj", None)


def _version_row():
    from .db import Meta

    row = Meta.get_or_none(Meta.key == VERSION_KEY)
    return (row.value if row is not None else "0")


def _seeded() -> bool:
    from .db import Meta

    return Meta.get_or_none(Meta.key == SEEDED_KEY) is not None


def _virtual() -> Tree:
    from .deezer import genre_tree

    return Tree(default_edges(), nodes=genre_tree.ROOTS, version="default", virtual=True)


def _load() -> Tree:
    from .db import GenreAlias, GenreParent, GenreTag

    version = _version_row()
    if not _seeded():
        return _virtual()
    names = {t.id: t.name for t in GenreTag.select(GenreTag.id, GenreTag.name)}
    edges = [
        (names[r.child_id], names[r.parent_id], r.weight)
        for r in GenreParent.select()
        if r.child_id in names and r.parent_id in names
    ]
    aliases = [(a.name, names[a.genre_id]) for a in GenreAlias.select() if a.genre_id in names]
    return Tree(edges, aliases, names.values(), version)


def get() -> Tree:
    """The tree. No SQL once loaded, until RECHECK seconds have gone by."""
    cur = _db()
    now = time.monotonic()
    with _lock:
        c = _cache
        tree = c["tree"]
        if tree is not None and c["db"] is cur and now - c["at"] < RECHECK:
            return tree
        try:
            if tree is not None and c["db"] is cur:
                seeded = _seeded()
                if tree.virtual != seeded and (tree.virtual or tree.version == _version_row()):
                    c["at"] = now
                    return tree
            tree = _load()
        except Exception:
            logger.debug("genretree: could not load, using the default data", exc_info=True)
            tree = _virtual()
            c.update(db=cur, tree=tree, at=now - RECHECK + 5.0)
            return tree
        c.update(db=cur, tree=tree, at=now)
        return tree


def invalidate():
    """Drop the cached tree: the next question reloads it."""
    with _lock:
        _cache.update(db=None, tree=None, at=0.0)


def version() -> str:
    return get().version


# --- the questions ----------------------------------------------------------
def ancestors(g):
    """Every genre above ``g``, nearest first (a name that is not a node: [])."""
    t = get()
    n = t.node(g)
    return [a for a, _h, _f in t.up(n)] if n is not None else []


def descendants(g):
    """Every genre under ``g``, nearest first."""
    t = get()
    n = t.node(g)
    return [a for a, _h, _f in t.down(n)] if n is not None else []


def family_of(g):
    """The engine family id of ``g``: itself when it is one, else the nearest
    ancestor that is (ties: the firmer link). None when there is none."""
    t = get()
    n = t.node(g)
    return t.family(n) if n is not None else None


def lca(a, b):
    """The lowest genre above (or equal to) both, or None."""
    t = get()
    na, nb = t.node(a), t.node(b)
    if na is None or nb is None:
        return None
    up_a = {na: (0, 1.0)}
    up_a.update({n: (h, f) for n, h, f in t.up(na)})
    best = None
    for n, h, f in [(nb, 0, 1.0)] + t.up(nb):
        if n in up_a:
            key = (up_a[n][0] + h, -(up_a[n][1] * f), n)
            if best is None or key < best:
                best = key
    return best[2] if best else None


def distance(a, b) -> float:
    """0 (same genre) to 1 (unrelated): the cheapest path over the links, a
    link costing ``1 - weight`` and never less than ``MIN_EDGE``."""
    t = get()
    na, nb = t.node(a), t.node(b)
    if na is None or nb is None:
        return 1.0
    if na == nb:
        return 0.0
    return t.distances(na).get(nb, 1.0)


def alias(name):
    """The node an outside name stands for, or None."""
    t = get()
    key = fold(name)
    return t.aliases.get(key) or t.folded.get(key)


def within(g, above) -> bool:
    """Is ``g`` the genre ``above`` or somewhere under it? ``above`` may be a
    node's name or an engine family id."""
    t = get()
    n = t.node(g)
    top = t.node(above)
    if top is None:
        from .deezer.analysis import FAMILY_LABEL

        top = t.node(FAMILY_LABEL.get(above, above))
    if n is None or top is None:
        return False
    return n == top or any(a == top for a, _h, _f in t.up(n))


def roots():
    t = get()
    return sorted(n for n in t.nodes if not t.parents.get(n))


# --- writes -----------------------------------------------------------------
def _tag(name):
    from .db import GenreTag

    tag = GenreTag.get_or_none(GenreTag.name == name)
    if tag is None:
        raise KeyError(name)
    return tag


def _meta_set(key, value):
    from .db import Meta

    row = Meta.get_or_none(Meta.key == key)
    if row is None:
        Meta.create(key=key, value=str(value))
    else:
        row.value = str(value)
        row.save()


def _meta_get(key, default=None):
    from .db import Meta

    row = Meta.get_or_none(Meta.key == key)
    return row.value if row is not None else default


def bump() -> str:
    """Move the tree's version (every cache, here and elsewhere, reloads)."""
    value = str(int(_meta_get(VERSION_KEY, "0") or 0) + 1)
    _meta_set(VERSION_KEY, value)
    invalidate()
    return value


def _materialise():
    """A tree that was only the default data becomes rows before the first
    edit, so an edit has something to edit."""
    if not _seeded():
        seed_tree()


def _touch(tag):
    _meta_set(TOUCHED_PREFIX + str(tag.id), "1")


def _log_push(ops):
    """Remember how to take a write back: ``ops`` = [(child_id, parent_id,
    previous weight or None)]. Kept as short text so it fits a Meta value."""
    from .db import Meta

    n = int(_meta_get(LOG_COUNT_KEY, "0") or 0) + 1
    text = ";".join(f"{c},{p},{'' if w is None else repr(w)}" for c, p, w in ops)
    if len(text) > 250:
        text = ""  # too long to keep: this write cannot be taken back
    _meta_set(LOG_PREFIX + str(n), text)
    _meta_set(LOG_COUNT_KEY, n)
    old = n - LOG_MAX
    if old > 0:
        Meta.delete().where(Meta.key == LOG_PREFIX + str(old)).execute()


def _set_edge(child_id, parent_id, weight):
    """Make the edge be ``weight`` (None: absent); returns its previous weight."""
    from .db import GenreParent

    row = GenreParent.get_or_none((GenreParent.child == child_id) & (GenreParent.parent == parent_id))
    old = row.weight if row is not None else None
    if weight is None:
        if row is not None:
            GenreParent.delete().where(
                (GenreParent.child == child_id) & (GenreParent.parent == parent_id)
            ).execute()
    elif row is None:
        GenreParent.create(child=child_id, parent=parent_id, weight=weight)
    elif row.weight != weight:
        GenreParent.update(weight=weight).where(
            (GenreParent.child == child_id) & (GenreParent.parent == parent_id)
        ).execute()
    return old


def _clamp(weight):
    try:
        w = float(weight)
    except (TypeError, ValueError):
        raise ValueError("weight must be a number")
    if not (w == w) or w <= 0 or w > 1:
        raise ValueError("weight must be in ]0, 1]")
    return round(w, 3)


def _check_cycle(child_name, parent_name):
    t = get()
    if child_name == parent_name or parent_name in {n for n, _h, _f in t.down(child_name)}:
        raise CycleError(f"{parent_name} is under {child_name}")


def add_parent(child, parent, weight=1.0):
    """Put ``child`` under ``parent`` (or change the link's weight)."""
    from .db import db

    w = _clamp(weight)
    _materialise()
    ctag, ptag = _tag(child), _tag(parent)
    invalidate()
    _check_cycle(ctag.name, ptag.name)
    with db.atomic():
        old = _set_edge(ctag.id, ptag.id, w)
        _touch(ctag)
        _log_push([(ctag.id, ptag.id, old)])
        return bump()


def remove_parent(child, parent):
    from .db import db

    _materialise()
    ctag, ptag = _tag(child), _tag(parent)
    with db.atomic():
        old = _set_edge(ctag.id, ptag.id, None)
        if old is None:
            return get().version
        _touch(ctag)
        _log_push([(ctag.id, ptag.id, old)])
        return bump()


def move(child, parent, weight=1.0, old_parent=None):
    """Move ``child`` under ``parent``: from ``old_parent`` when given (its
    other parents stay), else out of every parent it had. ``parent`` None makes
    it a root."""
    from .db import GenreParent, db

    _materialise()
    ctag = _tag(child)
    ptag = _tag(parent) if parent is not None else None
    w = _clamp(weight)
    invalidate()
    if ptag is not None:
        _check_cycle(ctag.name, ptag.name)
    with db.atomic():
        ops = []
        q = GenreParent.select().where(GenreParent.child == ctag.id)
        if old_parent is not None:
            q = q.where(GenreParent.parent == _tag(old_parent).id)
        for row in list(q):
            if ptag is not None and row.parent_id == ptag.id:
                continue
            ops.append((ctag.id, row.parent_id, _set_edge(ctag.id, row.parent_id, None)))
        if ptag is not None:
            ops.append((ctag.id, ptag.id, _set_edge(ctag.id, ptag.id, w)))
        if not ops:
            return get().version
        _touch(ctag)
        _log_push(ops)
        return bump()


def remove_node(name):
    """Take ``name`` out of the tree before its tag is deleted: its children
    rise to its parents (the weights multiply). Not undoable."""
    from .db import GenreParent, db

    if not _seeded():
        return get().version
    tag = _tag(name)
    with db.atomic():
        ups = [(r.parent_id, r.weight) for r in GenreParent.select().where(GenreParent.child == tag.id)]
        downs = [(r.child_id, r.weight) for r in GenreParent.select().where(GenreParent.parent == tag.id)]
        for cid, cw in downs:
            for pid, pw in ups:
                if cid == pid:
                    continue
                if GenreParent.get_or_none((GenreParent.child == cid) & (GenreParent.parent == pid)) is None:
                    GenreParent.create(child=cid, parent=pid, weight=max(0.05, round(cw * pw, 3)))
            _meta_set(TOUCHED_PREFIX + str(cid), "1")
        GenreParent.delete().where((GenreParent.child == tag.id) | (GenreParent.parent == tag.id)).execute()
        _log_clear()
        return bump()


def _log_clear():
    from .db import Meta

    Meta.delete().where(Meta.key.startswith(LOG_PREFIX)).execute()
    _meta_set(LOG_COUNT_KEY, 0)


def undo():
    """Take back the last write. The edges it changed go back to what they
    were; those whose tag has since been deleted are skipped. Returns False
    when there is nothing to undo."""
    from .db import GenreParent, GenreTag, Meta, db

    n = int(_meta_get(LOG_COUNT_KEY, "0") or 0)
    while n > 0:
        text = _meta_get(LOG_PREFIX + str(n))
        Meta.delete().where(Meta.key == LOG_PREFIX + str(n)).execute()
        n -= 1
        _meta_set(LOG_COUNT_KEY, n)
        if text is None:
            continue
        if text == "":
            return False
        ops = []
        for part in text.split(";"):
            c, p, w = part.split(",")
            ops.append((int(c), int(p), float(w) if w else None))
        with db.atomic():
            live = {t.id for t in GenreTag.select(GenreTag.id)}
            for c, p, w in reversed(ops):
                if c in live and p in live:
                    _set_edge(c, p, w)
            bump()
        return True
    return False


def can_undo() -> bool:
    n = int(_meta_get(LOG_COUNT_KEY, "0") or 0)
    return n > 0 and bool(_meta_get(LOG_PREFIX + str(n)))


# --- the default tree -------------------------------------------------------
def seed_tree() -> int:
    """Write the default tree into ``genre_parent``; returns the edges added.

    Additive and versioned: it does nothing when the data's ``TREE_VERSION`` is
    the one already seeded; otherwise it adds each default edge whose two tags
    exist and whose child nobody has placed by hand (``gtt:`` markers) — so a
    genre the person moved, un-parented or re-weighted is never put back, and
    one they deleted stays deleted. The shelves of ``UMBRELLAS`` are created
    the first time only. Existing tags are never touched."""
    from .db import GenreParent, GenreTag, Meta, db
    from .deezer import genre_tree
    from .deezer.genre import DEFAULT_COLORS

    done = _meta_get(SEEDED_KEY)
    if done is not None and str(done) == str(genre_tree.TREE_VERSION):
        return 0
    added = 0
    with db.atomic():
        tags = {t.name: t for t in GenreTag.select()}
        if done is None:
            for i, name in enumerate(genre_tree.UMBRELLAS):
                if name not in tags:
                    tags[name] = GenreTag.create(
                        name=name, color=DEFAULT_COLORS[(i + 7) % len(DEFAULT_COLORS)], archetype=None
                    )
        touched = {
            int(m.key[len(TOUCHED_PREFIX):])
            for m in Meta.select().where(Meta.key.startswith(TOUCHED_PREFIX))
            if m.key[len(TOUCHED_PREFIX):].isdigit()
        }
        have = {(r.child_id, r.parent_id) for r in GenreParent.select()}
        up = {}
        for c, p in have:
            up.setdefault(c, set()).add(p)
        for child, parent, weight in genre_tree.TREE:
            ct, pt = tags.get(child), tags.get(parent)
            if ct is None or pt is None or ct.id in touched or (ct.id, pt.id) in have:
                continue
            if _reaches(up, pt.id, ct.id):
                continue
            GenreParent.create(child=ct.id, parent=pt.id, weight=weight)
            have.add((ct.id, pt.id))
            up.setdefault(ct.id, set()).add(pt.id)
            added += 1
        _meta_set(SEEDED_KEY, genre_tree.TREE_VERSION)
        if added or done is None:
            bump()
        else:
            invalidate()
    return added


def _reaches(up, start, target):
    """Is ``target`` above (or equal to) ``start`` in the ``up`` adjacency?"""
    stack, seen = [start], set()
    while stack:
        n = stack.pop()
        if n == target:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack.extend(up.get(n, ()))
    return False


def reset_tree() -> int:
    """Back to the default tree: every edge and every "placed by hand" marker
    is dropped and the default data written again. Tags and aliases stay."""
    from .db import GenreParent, Meta, db

    with db.atomic():
        GenreParent.delete().execute()
        Meta.delete().where(Meta.key.startswith(TOUCHED_PREFIX)).execute()
        Meta.delete().where(Meta.key == SEEDED_KEY).execute()
        _log_clear()
        invalidate()
        return seed_tree()

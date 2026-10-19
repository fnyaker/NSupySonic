// The genre hierarchy, as the player needs it: "this genre has no picture of its
// own, which one above it does?". The tree itself is the server's
// (`supysonic/genretree.py`, served by GET /api/genre/tree); this is a small
// mirror of it that answers without a request.
//
// Three sources, best first: the tree the server last sent (kept on the device,
// so it works offline), and — for the few genres the default tree adds that
// the player's own tables cannot know — a static copy of THEIR links. Nodes
// are looked up by their flattened name (lowercase, letters and digits), the
// same key `style.js` and `skins.js` use, so "Hard dance" and "hard-dance" are
// one genre.
//
// This module imports nothing from the rest of the player: style.js and skins.js
// both reach for it, and a cycle here would be a cycle in the main bundle.

/** The links of the default tree that name a genre the player has no table
 *  row for (the shelves). Kept in step with supysonic/deezer/genre_tree.py by
 *  tests/test_multi_o.py. */
export const DEFAULT_EDGES = /*edges*/ [["Hard dance","Électronique",1]] /*end*/;

const KEY = "ns.genretree.v1";

export const flat = (v) =>
  String(v || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

let parents = new Map(); // flat child -> [[flat parent, weight]]
let names = new Map(); // flat -> display name
let version = null;
let live = false;
let warmed = false;
const memo = new Map();
const listeners = new Set();

function build(edges) {
  const p = new Map();
  const n = new Map();
  for (const [c, q, w] of edges) {
    const fc = flat(c);
    const fq = flat(q);
    if (!fc || !fq || fc === fq) continue;
    n.set(fc, c);
    n.set(fq, q);
    if (!p.has(fc)) p.set(fc, []);
    p.get(fc).push([fq, Number(w) || 1]);
  }
  return [p, n];
}

[parents, names] = build(DEFAULT_EDGES);

/** The server's tree: `{version, edges: [{child, parent, weight}]}`. */
export function setTree(data) {
  if (!data || !Array.isArray(data.edges)) return;
  [parents, names] = build(data.edges.map((e) => [e.child, e.parent, e.weight]));
  version = data.version ?? null;
  live = true;
  warmed = true;
  memo.clear();
  for (const fn of listeners) fn();
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: version, e: data.edges.map((e) => [e.child, e.parent, e.weight]) }));
  } catch {
    /* private window, quota: the tree is simply not kept */
  }
}

/** Called when the tree changes, so a cache of answers built on it can go. */
export function onTreeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function warm() {
  if (warmed) return;
  warmed = true;
  try {
    const raw = typeof localStorage !== "undefined" && localStorage.getItem(KEY);
    if (!raw) return;
    const kept = JSON.parse(raw);
    if (!kept || !Array.isArray(kept.e)) return;
    [parents, names] = build(kept.e);
    version = kept.v ?? null;
    live = true;
    memo.clear();
  } catch {
    /* an unreadable copy is no copy */
  }
}

/** Every genre above `name`, nearest first (hops, then the firmer link), as
 *  display names. [] when the name is not in the tree. */
export function ancestorsOf(name) {
  warm();
  const key = flat(name);
  if (!key) return [];
  let got = memo.get(key);
  if (got) return got;
  const seen = new Map([[key, 1]]);
  const out = [];
  let level = [key];
  while (level.length) {
    const reached = new Map();
    for (const n of level) {
      for (const [q, w] of parents.get(n) || []) {
        if (seen.has(q)) continue;
        const f = seen.get(n) * w;
        if (f > (reached.get(q) || 0)) reached.set(q, f);
      }
    }
    const next = [...reached.keys()].sort((a, b) => reached.get(b) - reached.get(a) || (a < b ? -1 : 1));
    for (const q of next) {
      seen.set(q, reached.get(q));
      out.push(names.get(q) || q);
    }
    level = next;
  }
  if (memo.size > 1024) memo.clear();
  memo.set(key, out);
  return out;
}

/** Is a fetched tree in use (as opposed to the static shelves)? */
export function treeLoaded() {
  warm();
  return live;
}

export function treeVersion() {
  warm();
  return version;
}

let refreshing = false;

/** Fetch the server's tree and keep it. Best effort: no network, no login or a
 *  server without the route leave the copy already held. */
export function refreshTree() {
  if (refreshing || typeof window === "undefined") return;
  refreshing = true;
  import("./api.js")
    .then(({ api }) => api.genreTree())
    .then((data) => setTree(data))
    .catch(() => {})
    .finally(() => {
      refreshing = false;
    });
}

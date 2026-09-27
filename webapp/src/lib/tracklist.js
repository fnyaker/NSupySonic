// Search and sort for the track lists — a playlist, the favourites, the
// downloads — over the app core's index (webapp/appcore/src/tracks.rs).
//
// The lists used to do it per KEYSTROKE: lowercase every title, every credit
// and every album (12 000+ fresh strings for a 4 000-track favourites page),
// and for a sort, lowercase both keys again inside the comparator. And the
// answer was wrong for a French library: a code-unit comparison put every
// accented capital after "z", and "beyonce" did not find "Beyoncé".
//
// Now a list is indexed ONCE, when it changes (reconcile.js keeps its identity
// when it did not): each field folded — case and accents dropped, ligatures
// spelled out — into one buffer in the core, each sort order computed the
// first time it is asked for and kept. A keystroke is one pass over the
// folded bytes in an order already computed. What comes back is the list's
// own objects, so the rows keep their identity (and their decoded covers).
//
// The unfiltered, unsorted view never touches the core: it is the list itself,
// the same array, which keeps the common case a no-op all the way down. And a
// page whose core failed to load (no WebAssembly) still filters and sorts, the
// old way.

import { adopt, appCore, release } from "./appcore/core.js";
import { artistSearch } from "./format.js";

export const SORTS = [
  { key: "default", label: "Ordre d'origine" },
  { key: "title", label: "Titre" },
  { key: "artist", label: "Artiste" },
  { key: "album", label: "Album" },
  { key: "duration", label: "Durée" },
  { key: "added", label: "Date d'ajout" },
];
const SORT_ID = { default: 0, title: 1, artist: 2, album: 3, duration: 4, added: 5 };

const US = "\u001f";
const RS = "\u001e";
const SEPS = /[\u001e\u001f]/g;
const enc = typeof TextEncoder === "function" ? new TextEncoder() : null;

// A field as the index reads it: a string with no separator in it.
function field(s) {
  if (typeof s !== "string") return s == null ? "" : String(s);
  return s.indexOf(US) < 0 && s.indexOf(RS) < 0 ? s : s.replace(SEPS, " ");
}

// Every credited name, as format.js#artistSearch joins them, before any
// lowercasing: the core folds it.
function allArtists(t) {
  const list = t && t.artists;
  if (!Array.isArray(list) || list.length === 0) return (t && t.artist && t.artist.name) || "";
  if (list.length === 1) return (list[0] && list[0].name) || "";
  let s = "";
  for (const a of list) if (a && a.name) s += (s ? " " : "") + a.name;
  return s;
}

/**
 * A projector: `project(tracks, sort, dir, query)` returns the list to show.
 * One per list on screen; `free()` it when the list goes away (a forgotten
 * one is freed when it is collected).
 */
export function createProjector() {
  let c = null;
  let h = 0;
  let indexed = null; // the array the core's index was built from
  const owner = {};

  function ensure(tracks) {
    if (!c) {
      c = appCore();
      if (!c || !enc) return false;
      h = c.x.tracks_new();
      adopt(owner, c, "tracks_free", h);
    }
    if (indexed === tracks) return true;
    const n = tracks.length;
    const parts = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = tracks[i] || {};
      parts[i] = field(t.title) + US + field(t.artist && t.artist.name) + US + field(allArtists(t)) + US + field(t.album && t.album.title);
    }
    const text = parts.join(RS);
    // UTF-8 takes at most three bytes per UTF-16 unit.
    const room = text.length * 3;
    c.x.tracks_reserve(h, room, n);
    const { written } = enc.encodeInto(text, c.u8(c.x.tracks_input_ptr(h), room));
    const nums = c.f64(c.x.tracks_nums_ptr(h), n * 2);
    for (let i = 0; i < n; i++) {
      const t = tracks[i] || {};
      nums[2 * i] = +t.duration || 0;
      nums[2 * i + 1] = +t.added || 0;
    }
    c.x.tracks_build(h, written, n);
    indexed = tracks;
    return true;
  }

  function project(tracks, sort = "default", dir = 1, query = "") {
    if (!Array.isArray(tracks)) return [];
    const q = (query || "").trim();
    const sid = SORT_ID[sort] ?? 0;
    if (!q && sid === 0) return dir === -1 ? tracks.slice().reverse() : tracks;
    if (!ensure(tracks)) return fallback(tracks, sort, dir, q);
    let qlen = 0;
    if (q) {
      const room = q.length * 3;
      qlen = enc.encodeInto(q, c.u8(c.x.tracks_query_ptr(h, room), room)).written;
    }
    const n = c.x.tracks_filter(h, sid, dir === -1 ? 1 : 0, qlen);
    const idx = c.u32(c.x.tracks_out_ptr(h), n);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = tracks[idx[i]];
    return out;
  }

  project.free = () => {
    release(owner, c, "tracks_free", h);
    h = 0;
    c = null;
    indexed = null;
  };
  return project;
}

// Without the core: what the lists did before it existed. Exported for the
// test that measures the index against it.
const lc = (s) => (s || "").toLowerCase();
export function fallback(list, sort, dir, query) {
  const q = lc(query);
  if (q)
    list = list.filter(
      (t) => lc(t.title).includes(q) || artistSearch(t).includes(q) || lc(t.album?.title).includes(q)
    );
  if (sort !== "default") {
    const key = {
      title: (t) => lc(t.title),
      artist: (t) => lc(t.artist?.name),
      album: (t) => lc(t.album?.title),
      duration: (t) => t.duration || 0,
      added: (t) => t.added || 0,
    }[sort];
    list = [...list].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka < kb ? -dir : ka > kb ? dir : 0;
    });
  } else if (dir === -1) {
    list = [...list].reverse();
  }
  return list;
}

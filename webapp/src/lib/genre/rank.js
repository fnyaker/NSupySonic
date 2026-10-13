// The vocabulary, in the order a person tagging ONE track wants it.
//
// The studio seeds ~220 genres. Listed alphabetically, the one you want is
// somewhere in a wall of chips and the number keys reach "Acid", "Acid house",
// "Acid techno"… — useless. So the order is the track's own: the server ranks
// every genre either opinion has a word on (`scores`: the trained head's
// calibrated probability blended with the nearest-prototype share, see
// deezer/genre.py#rank_scores), and those come first, best first. A genre
// nobody has an opinion on follows by how much it is used in this library,
// then by name — so even with no model at all the list opens on the genres you
// actually tag.

/** Case, accents and punctuation folded away, for matching what is typed. */
export function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * @param tags    [{id, name, color, …}] — the vocabulary
 * @param scores  [[label, score, head, proto]] for this track (may be empty)
 * @param counts  {name: tagged tracks} — the library's use of each genre
 * @returns [{tag, score, head, proto}] best first; score is null when no
 *          opinion exists
 */
export function rankTags(tags, scores, counts = {}) {
  const byName = new Map();
  for (const r of scores || []) {
    if (Array.isArray(r) && r.length >= 2 && !byName.has(r[0])) byName.set(r[0], r);
  }
  const rows = (tags || []).map((tag) => {
    const r = byName.get(tag.name);
    return {
      tag,
      score: r ? +r[1] || 0 : null,
      head: r && r[2] != null ? +r[2] : null,
      proto: r && r[3] != null ? +r[3] : null,
      used: counts[tag.name] || 0,
      key: fold(tag.name),
    };
  });
  rows.sort((a, b) => {
    if ((a.score != null) !== (b.score != null)) return a.score != null ? -1 : 1;
    if (a.score != null && b.score !== a.score) return b.score - a.score;
    if (b.used !== a.used) return b.used - a.used;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return rows;
}

/**
 * The ranked rows matching a typed query, keeping the rank order inside each
 * tier: a whole-name match, then a word that starts with the query, then the
 * query anywhere ("core" reaches Frenchcore and Hardcore, in this track's
 * order) — nothing is reordered alphabetically.
 */
export function searchTags(ranked, query) {
  const q = fold(query);
  if (!q) return ranked;
  const exact = [];
  const word = [];
  const inside = [];
  for (const r of ranked) {
    if (r.key === q) exact.push(r);
    else if (r.key.startsWith(q) || r.key.includes(" " + q)) word.push(r);
    else if (r.key.replace(/ /g, "").includes(q.replace(/ /g, ""))) inside.push(r);
  }
  return exact.concat(word, inside);
}

const RECENT_KEY = "genre.recent";
const RECENT_MAX = 6;

/** The tag ids last used on this device, newest first. */
export function recentTags() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function noteRecent(id) {
  if (!Number.isInteger(id)) return recentTags();
  const next = [id, ...recentTags().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* not remembered; the session still has it */
  }
  return next;
}

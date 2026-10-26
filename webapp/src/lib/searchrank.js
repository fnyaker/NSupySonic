// How the search's "Tout" tab is put together (design: /mnt/project-files/ui/
// refonte-navigation.md, *Recherche*). Pure functions, so the order is tested
// without a browser.
//
//   topResult(q, results, withPodcasts)  the ONE artist (or show) the query
//       plainly names, shown first and large — or null. Only a clear match
//       earns the place: a top card that is not what was typed pushes the
//       titles down for nothing.
//   mixPodcasts(albums, podcasts)        the shows among the albums, with
//       `podcast: true`: no category of their own, a small label instead.

import { fold } from "./genre/rank.js";

export { fold };

/** @returns {{kind: "artist"|"podcast", item}|null} */
export function topResult(q, results, withPodcasts = false) {
  const artists = results?.artists || [];
  const exact = fold(q);
  if (!exact) return null;
  // An artist named exactly, among the first few (the catalogue lists them
  // by popularity: the third "Indila" is a tribute act, the first is not).
  const same = artists.slice(0, 3).find((a) => fold(a.name) === exact);
  if (same) return { kind: "artist", item: same };
  if (withPodcasts) {
    const show = (results?.podcasts || []).slice(0, 3).find((p) => fold(p.title) === exact);
    if (show) return { kind: "podcast", item: show };
  }
  // Else only the FIRST artist, and only when the query is the start of its
  // name: what somebody types before they have finished typing it.
  const first = artists[0];
  if (first && exact.length >= 3 && startsName(exact, fold(first.name))) {
    return { kind: "artist", item: first };
  }
  return null;
}

function startsName(a, b) {
  // Folded names are words joined by single spaces, so a prefix of the whole
  // name starts on a word: "daft" and "daft p" name Daft Punk, "aft" does not.
  return b.startsWith(a);
}

/** The albums with the shows mixed in after the first two: what matched best
 *  stays first, and a show the query names is not buried at the end. */
export function mixPodcasts(albums, podcasts, after = 2) {
  const a = albums || [];
  const p = (podcasts || []).map((x) => ({ ...x, podcast: true }));
  if (!p.length) return a;
  return [...a.slice(0, after), ...p, ...a.slice(after)];
}

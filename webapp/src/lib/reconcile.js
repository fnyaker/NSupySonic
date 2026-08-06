// In-place reconciliation of a freshly fetched list against the one on screen.
//
// Playlists and favourites are painted from the offline cache the instant they
// come off disk, then again from the network a moment later. Replacing the
// array wholesale on that second paint throws away every row component and
// every loaded cover for a list that is usually IDENTICAL — a visible flash on
// a big list, and pointless work on a slow device.
//
// So: keep the objects that are still there (same identity => same component,
// same decoded artwork), drop the ones that went away, insert the new ones
// where the server put them. When nothing at all changed, hand back the very
// same array reference, which makes the update a no-op all the way down.

const idOf = (t) => String((t && (t.deezer_id ?? t.id)) ?? "");

// Merge `next` (authoritative order + content) into `prev`.
export function reconcileList(prev, next, key = idOf) {
  if (!Array.isArray(next)) return prev;
  if (!Array.isArray(prev) || prev.length === 0) return next;

  // A list can legitimately hold the same track twice (a playlist), so index by
  // key with a queue of the occurrences rather than a plain map.
  const pool = new Map();
  for (const item of prev) {
    const k = key(item);
    const bucket = pool.get(k);
    if (bucket) bucket.push(item);
    else pool.set(k, [item]);
  }

  let identical = next.length === prev.length;
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const fresh = next[i];
    const bucket = pool.get(key(fresh));
    const old = bucket && bucket.length ? bucket.shift() : null;
    // Reuse the old object only when it still says the same thing. Comparing
    // the fields the UI actually renders is cheaper than a deep equality pass
    // and catches the edits that matter (a retitled track, a fixed credit, a
    // new cover, a playlist position).
    if (old && sameTrack(old, fresh)) {
      out[i] = old;
      if (identical && prev[i] !== old) identical = false;
    } else {
      out[i] = fresh;
      identical = false;
    }
  }
  return identical ? prev : out;
}

function sameTrack(a, b) {
  if (a === b) return true;
  return (
    a.title === b.title &&
    a.duration === b.duration &&
    (a.album?.cover ?? null) === (b.album?.cover ?? null) &&
    (a.album?.title ?? null) === (b.album?.title ?? null) &&
    (a.artist?.name ?? null) === (b.artist?.name ?? null) &&
    (a.display_artist ?? null) === (b.display_artist ?? null) &&
    !!a.explicit === !!b.explicit
  );
}

// Same idea one level up: merge a fetched `{playlist, tracks}`-shaped payload
// into the one already on screen, so only what actually changed re-renders.
// Returns the previous object untouched when nothing did.
export function reconcilePayload(prev, next, listKey = "tracks") {
  if (!next) return next;
  if (!prev) return next;
  const tracks = reconcileList(prev[listKey], next[listKey]);
  const merged = { ...next, [listKey]: tracks };
  // Cheap structural check on the non-list part: if that matches too, keep the
  // old object so downstream `$:` blocks don't even see a change.
  if (tracks === prev[listKey] && shallowSame(prev, merged, listKey)) return prev;
  return merged;
}

function shallowSame(a, b, skip) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (k === skip) continue;
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    // One level deep is enough for the metadata objects we carry ({playlist:…}).
    if (va && vb && typeof va === "object" && typeof vb === "object") {
      const sa = Object.keys(va);
      if (sa.length !== Object.keys(vb).length) return false;
      for (const sk of sa) if (va[sk] !== vb[sk]) return false;
      continue;
    }
    return false;
  }
  return true;
}

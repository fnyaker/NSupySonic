// The little bit of CPU plumbing every world driver needs, and nothing else.
//
// A world's picture is a pure function of the music block and of a handful of
// EVENTS: "a main kick landed at beat 123.02 with this much power". The events
// live in the `uEv[8]` uniform array as (birth in beats, power, a, b), and a
// shader computes everything else — a shock front's radius, a spark's
// trajectory — from `uClock.x - birth`. No per-frame state, exact at any frame
// rate, and nothing to integrate on the CPU.

/** A ring of eight events over the `ev` Float32Array(32) the scene hands in. */
export function eventRing(ev) {
  let head = 0;
  ev.fill(0);
  return {
    push(birth, power, a = 0, b = 0) {
      const i = head * 4;
      ev[i] = birth;
      ev[i + 1] = power;
      ev[i + 2] = a;
      ev[i + 3] = b;
      head = (head + 1) % 8;
    },
    get head() {
      return head;
    },
  };
}

/**
 * Fires `fn(stamp, m)` once per NEW value of a musical stamp (m.stamp.main, …).
 * The stamps start at a large negative value, which is never reported.
 */
export function onStamp(read, fn) {
  let last = null;
  return (m) => {
    const s = read(m);
    if (last === null) {
      last = s;
      return;
    }
    if (s !== last) {
      last = s;
      if (s > -1e8) fn(s, m);
    }
  };
}

/** A deterministic 0..1 hash of an integer, for per-event variety. */
export function hashN(n) {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

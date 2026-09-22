// The host's side of the timeline: turn a stream of noisy readings of its own
// <audio> element into ONE straight line that guests can follow.
//
// A single `currentTime` read is only good to a few milliseconds — the value is
// refreshed per task, the read itself lands somewhere in a timer callback, and
// on some engines it steps per audio callback. But the element plays at one
// rate, so every reading taken while it plays continuously sits on the same
// line `position = c + time`. Each reading gives its own estimate of c, and the
// MEDIAN of the recent ones is far steadier than any of them (and not dragged
// by one late timer callback, which a mean would be).
//
// A reading far off the line is not noise: it is a seek, a stall that cost
// the element some time, a restart. The fit breaks there and starts over from
// that reading, and the host publishes the new line at once.

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class AnchorFit {
  constructor({ max = 24, breakS = 0.25 } = {}) {
    this.max = max;
    this.breakS = breakS;
    this.cs = [];
  }

  reset() {
    this.cs = [];
  }

  get n() {
    return this.cs.length;
  }

  // A reading taken at local time `perfMs` of an element at position `pos`
  // (seconds), while playing. Returns false when it broke the line.
  add(perfMs, pos) {
    const c = pos - perfMs / 1000;
    let continued = true;
    if (this.cs.length && Math.abs(c - median(this.cs)) > this.breakS) {
      this.cs = [];
      continued = false;
    }
    this.cs.push(c);
    if (this.cs.length > this.max) this.cs.shift();
    return continued;
  }

  // Where the line puts the playhead at local time `perfMs`.
  positionAt(perfMs) {
    if (!this.cs.length) return null;
    return median(this.cs) + perfMs / 1000;
  }
}

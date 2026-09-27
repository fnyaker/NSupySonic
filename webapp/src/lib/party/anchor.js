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

// THE FIT IS RUST (webapp/appcore/src/sync.rs#AnchorFit): the same median,
// in a fixed ring. The JavaScript it replaced copied and sorted the readings
// on every add and every read — four times a second for as long as a party
// runs — and is kept as the oracle in test/reference/sync.js. The core must
// be loaded (loadAppCore) before one is built; hosting a party awaits it.

import { adopt, release, requireCore } from "../appcore/core.js";

export class AnchorFit {
  constructor({ max = 24, breakS = 0.25 } = {}) {
    this.c = requireCore();
    this.h = this.c.x.fit_new(max, breakS);
    adopt(this, this.c, "fit_free", this.h);
  }

  reset() {
    if (this.h) this.c.x.fit_reset(this.h);
  }

  get n() {
    return this.h ? this.c.x.fit_len(this.h) : 0;
  }

  // A reading taken at local time `perfMs` of an element at position `pos`
  // (seconds), while playing. Returns false when it broke the line.
  add(perfMs, pos) {
    return this.h ? this.c.x.fit_add(this.h, perfMs, pos) === 1 : false;
  }

  // Where the line puts the playhead at local time `perfMs`.
  positionAt(perfMs) {
    if (!this.h) return null;
    const p = this.c.x.fit_position(this.h, perfMs);
    return Number.isNaN(p) ? null : p;
  }

  free() {
    release(this, this.c, "fit_free", this.h);
    this.h = 0;
  }
}

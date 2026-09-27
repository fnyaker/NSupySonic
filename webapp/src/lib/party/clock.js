// The shared clock of a listen party: how far this device's performance.now()
// is from the server's clock, NTP-style (the approach beatsync uses, over plain
// HTTP here — see supysonic/webui/party.py for why there is no socket).
//
// One probe gives four times: t0 (sent, local), t1 (received, server), t2
// (answered, server), t3 (answer arrived, local). If the two legs of the trip
// took equally long, the offset is ((t1 - t0) + (t2 - t3)) / 2 exactly. They
// rarely do — but QUEUEING ONLY EVER ADDS DELAY, so the probes with the
// smallest round trip are the ones least distorted by it (RFC 5905 §10). The
// estimate is therefore built from the fastest probes only, never an average
// of everything.
//
// Two clocks drift apart too: a crystal is good to tens of parts per million,
// which is milliseconds per minute — as much as the whole error budget. So once
// enough good probes span enough time, the offset is fitted as a LINE through
// them (offset against time) and read at "now", instead of treated as a
// constant that is quietly going stale.

export function probeSample(t0, t1, t2, t3) {
  return {
    at: t3,
    rtt: t3 - t0 - (t2 - t1),
    offset: (t1 - t0 + (t2 - t3)) / 2,
  };
}

// THE ESTIMATOR IS RUST (webapp/appcore/src/sync.rs#ClockEstimator): the
// same rules, in fixed buffers. The JavaScript it replaced built and threw
// away four arrays per estimate — a copy to sort for every median, a filter
// per pass — and the host asks for an estimate several times a second; it is
// kept as the oracle in test/reference/sync.js. The core must be loaded
// (loadAppCore) before one is built: joining and hosting a party await it.

import { adopt, release, requireCore } from "../appcore/core.js";

export class ClockEstimator {
  constructor({ max = 64, windowMs = 180_000, fitSpanMs = 20_000 } = {}) {
    this.c = requireCore();
    this.h = this.c.x.clock_new(max, windowMs, fitSpanMs);
    adopt(this, this.c, "clock_free", this.h);
  }

  reset() {
    if (this.h) this.c.x.clock_reset(this.h);
  }

  /** How many probes are held. */
  get size() {
    return this.h ? this.c.x.clock_len(this.h) : 0;
  }

  add(s) {
    if (!s || !this.h) return;
    this.c.x.clock_add(this.h, s.at, s.rtt, s.offset);
  }

  // { offset (server - local, ms), rtt (best, ms), spread (ms), n } or null.
  estimate(now) {
    if (!this.h) return null;
    const n = this.c.x.clock_estimate(this.h, now);
    if (!n) return null;
    const o = this.c.out();
    return { offset: o[0], rtt: o[1], spread: o[2], n };
  }

  free() {
    release(this, this.c, "clock_free", this.h);
    this.h = 0;
  }
}

// -- the probing loop (browser) ------------------------------------------------

const BURST = 12; // probes at start: enough for a min-RTT pick straight away
const BURST_GAP = 40; // ms between them
const STEADY = 2000; // ms between probes afterwards
const HIDDEN = 5000; // ...and while the page is hidden

// Probe `url` for as long as the returned stop() is not called. `onUpdate`
// receives every new estimate. The app core must be loaded. The estimator is returned too, for callers that
// need to read it synchronously (the scheduler does, many times a second).
export function startClock(url, onUpdate = () => {}) {
  const est = new ClockEstimator();
  let stopped = false;
  let timer = null;
  let burst = BURST;

  async function probe() {
    const t0 = performance.now();
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw Object.assign(new Error("clock"), { status: res.status });
    const j = await res.json();
    const t3 = performance.now();
    est.add(probeSample(t0, j.t1, j.t2, t3));
  }

  async function loop() {
    if (stopped) return;
    let wait = burst > 0 ? BURST_GAP : document.hidden ? HIDDEN : STEADY;
    try {
      await probe();
      if (burst > 0) burst--;
      const e = est.estimate(performance.now());
      if (e) onUpdate(e);
    } catch (e) {
      if (e && e.status === 404) {
        onUpdate(null, e);
        wait = STEADY * 2;
      } else wait = STEADY;
    }
    if (!stopped) timer = setTimeout(loop, wait);
  }

  // Coming back from the background: the device may have slept, and
  // performance.now() does not advance through a sleep everywhere. Re-burst.
  const onVis = () => {
    if (document.hidden) return;
    burst = BURST;
    clearTimeout(timer);
    loop();
  };
  document.addEventListener("visibilitychange", onVis);
  loop();

  return {
    estimator: est,
    now: () => est.estimate(performance.now()),
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      est.free();
    },
  };
}

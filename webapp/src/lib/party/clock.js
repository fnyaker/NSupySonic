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

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Skew beyond this is not a clock, it is a bug (or a device that slept).
const MAX_SKEW = 200e-6;
const RECENT_MS = 45_000;

export class ClockEstimator {
  constructor({ max = 64, windowMs = 180_000, fitSpanMs = 20_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.fitSpanMs = fitSpanMs;
    this.samples = [];
  }

  reset() {
    this.samples = [];
  }

  add(s) {
    if (!s || !Number.isFinite(s.rtt) || !Number.isFinite(s.offset) || s.rtt < 0) return;
    // A device that slept (or had its clock stepped) makes every older sample
    // wrong at once. One fast probe that disagrees with the estimate by far
    // more than any network could explain is that, not noise.
    const est = this.estimate(s.at);
    if (est && s.rtt <= est.rtt * 2 + 2 && Math.abs(s.offset - est.offset) > 50 + s.rtt) {
      this.samples = [];
    }
    this.samples.push(s);
    if (this.samples.length > this.max) this.samples.shift();
  }

  // The probes worth believing: within the window, and close to the fastest.
  good(now) {
    const recent = this.samples.filter((s) => now - s.at <= this.windowMs);
    if (!recent.length) return [];
    const best = Math.min(...recent.map((s) => s.rtt));
    const cut = best * 1.5 + 1;
    return recent.filter((s) => s.rtt <= cut);
  }

  // { offset (server - local, ms), rtt (best, ms), spread (ms), n } or null.
  estimate(now) {
    const g = this.good(now);
    if (!g.length) return null;
    const rtt = Math.min(...g.map((s) => s.rtt));
    // Without a line, only RECENT probes: under skew an old one is stale by
    // its age times the drift, however fast its round trip was.
    const recent = g.filter((s) => now - s.at <= RECENT_MS);
    let offsetAt = () => median((recent.length ? recent : g).map((s) => s.offset));
    const span = g.length > 1 ? Math.max(...g.map((s) => s.at)) - Math.min(...g.map((s) => s.at)) : 0;
    if (g.length >= 6 && span >= this.fitSpanMs) {
      // Least squares of offset against time, centred for precision.
      const mx = g.reduce((a, s) => a + s.at, 0) / g.length;
      const my = g.reduce((a, s) => a + s.offset, 0) / g.length;
      let sxx = 0;
      let sxy = 0;
      for (const s of g) {
        sxx += (s.at - mx) ** 2;
        sxy += (s.at - mx) * (s.offset - my);
      }
      const slope = Math.max(-MAX_SKEW, Math.min(MAX_SKEW, sxx ? sxy / sxx : 0));
      // Anchor the line on the MEDIAN residual, not the mean: one probe that
      // got lucky in only one direction must not drag it.
      const base = median(g.map((s) => s.offset - slope * (s.at - mx)));
      offsetAt = (t) => base + slope * (t - mx);
    }
    const offset = offsetAt(now);
    const spread = median(g.map((s) => Math.abs(s.offset - offsetAt(s.at))));
    return { offset, rtt, spread, n: g.length };
  }
}

// -- the probing loop (browser) ------------------------------------------------

const BURST = 12; // probes at start: enough for a min-RTT pick straight away
const BURST_GAP = 40; // ms between them
const STEADY = 2000; // ms between probes afterwards
const HIDDEN = 5000; // ...and while the page is hidden

// Probe `url` for as long as the returned stop() is not called. `onUpdate`
// receives every new estimate. The estimator is returned too, for callers that
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
    },
  };
}

//! THE TIME-SYNC ESTIMATORS: every place the app turns a stream of noisy
//! clock readings into one number it can schedule on.
//!
//!   ClockEstimator  the listen party's shared clock — how far this device's
//!                   performance.now() is from the server's, NTP-style, from
//!                   HTTP probes (lib/party/clock.js)
//!   AnchorFit       the party host's line: noisy readings of its own
//!                   <audio> element turned into ONE position = c + time
//!                   (lib/party/anchor.js)
//!   Bridge          a party guest's map from that shared clock onto its
//!                   AudioContext's (lib/party/engine.js#makeClockBridge)
//!   OutputClock     when the listener HEARS what the page plays — the
//!                   mapping from getOutputTimestamp() the animations, the
//!                   lyric line and the party host share (lib/audio/latency.js)
//!
//! They were JavaScript, and each ran its robust statistics the obvious way:
//! a median was `[...xs].sort()`, a filter was `.filter()`, an estimate was
//! three or four arrays built and thrown away — many times a second, on the
//! main thread, in the one subsystem where a garbage-collection pause is a
//! late chunk. Here every one of them works in fixed buffers and allocates
//! nothing after it is built. The rules are the JavaScript's, ported rule for
//! rule (the JavaScript is kept as the oracle, test/reference/sync.js, and
//! test/appcore.test.mjs holds the two to the same numbers); every constant
//! below was measured where the JavaScript says it was.

// --- a fixed ring of f64 --------------------------------------------------------------

/// A ring of at most `cap` values, oldest first.
pub struct Ring {
    buf: Vec<f64>,
    head: usize,
    len: usize,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring { buf: vec![0.0; cap.max(1)], head: 0, len: 0, cap: cap.max(1) }
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }
    #[inline]
    pub fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }
    /// Append; past the capacity the oldest value goes (JavaScript's
    /// push-then-shift).
    #[inline]
    pub fn push(&mut self, v: f64) {
        if self.len < self.cap {
            let i = (self.head + self.len) % self.cap;
            self.buf[i] = v;
            self.len += 1;
        } else {
            self.buf[self.head] = v;
            self.head = (self.head + 1) % self.cap;
        }
    }
    #[inline]
    pub fn get(&self, k: usize) -> f64 {
        self.buf[(self.head + k) % self.cap]
    }
    /// Copy into `out` (oldest first) and return how many.
    pub fn copy_to(&self, out: &mut [f64]) -> usize {
        for k in 0..self.len {
            out[k] = self.get(k);
        }
        self.len
    }
}

/// Insertion sort: every buffer here holds at most a few dozen values, where
/// it beats any general sort and keeps one out of the binary. Every value is
/// finite: the inputs are validated where they enter.
#[inline]
fn sort(xs: &mut [f64]) {
    for i in 1..xs.len() {
        let v = xs[i];
        let mut j = i;
        while j > 0 && xs[j - 1] > v {
            xs[j] = xs[j - 1];
            j -= 1;
        }
        xs[j] = v;
    }
}

/// The median as lib/party/*.js computes it: the mean of the two middle
/// values of an even count. Sorts `xs` in place.
#[inline]
fn median_mean(xs: &mut [f64]) -> f64 {
    let n = xs.len();
    if n == 0 {
        return 0.0;
    }
    sort(xs);
    let m = n >> 1;
    if n % 2 == 1 {
        xs[m]
    } else {
        (xs[m - 1] + xs[m]) / 2.0
    }
}

/// The median as lib/audio/latency.js computes it: the upper middle value.
#[inline]
fn median_upper(xs: &mut [f64]) -> f64 {
    sort(xs);
    xs[xs.len() >> 1]
}

#[inline]
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v > hi {
        hi
    } else if v < lo {
        lo
    } else {
        v
    }
}

// --- the party clock -----------------------------------------------------------------

/// Skew beyond this is not a clock, it is a bug (or a device that slept).
const MAX_SKEW: f64 = 200e-6;
const RECENT_MS: f64 = 45_000.0;
pub const MAX_PROBES: usize = 256;

#[derive(Clone, Copy, Default)]
struct Probe {
    at: f64,
    rtt: f64,
    offset: f64,
}

#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Estimate {
    /// server - local, ms
    pub offset: f64,
    /// the best round trip, ms
    pub rtt: f64,
    /// the median distance of the good probes from the estimate, ms
    pub spread: f64,
    pub n: u32,
}

/// One probe gives four times: t0 (sent, local), t1 (received, server), t2
/// (answered, server), t3 (answer arrived, local). If the two legs took
/// equally long the offset is ((t1 - t0) + (t2 - t3)) / 2 exactly. They rarely
/// do — but QUEUEING ONLY EVER ADDS DELAY, so the probes with the smallest
/// round trip are the least distorted by it (RFC 5905 §10): the estimate is
/// built from the fastest probes only. And two crystals drift apart by tens of
/// ppm, so once enough good probes span enough time the offset is fitted as a
/// LINE and read at "now" instead of treated as a constant going stale.
pub struct ClockEstimator {
    max: usize,
    window_ms: f64,
    fit_span_ms: f64,
    probes: Vec<Probe>,
    head: usize,
    len: usize,
    good: Vec<Probe>,
    scratch: Vec<f64>,
}

impl ClockEstimator {
    pub fn new(max: usize, window_ms: f64, fit_span_ms: f64) -> ClockEstimator {
        let max = max.clamp(1, MAX_PROBES);
        ClockEstimator {
            max,
            window_ms,
            fit_span_ms,
            probes: vec![Probe::default(); max],
            head: 0,
            len: 0,
            good: vec![Probe::default(); max],
            scratch: vec![0.0; max],
        }
    }

    pub fn reset(&mut self) {
        self.head = 0;
        self.len = 0;
    }

    pub fn len(&self) -> usize {
        self.len
    }

    #[inline]
    fn probe(&self, k: usize) -> Probe {
        self.probes[(self.head + k) % self.max]
    }

    pub fn add(&mut self, at: f64, rtt: f64, offset: f64) {
        if !rtt.is_finite() || !offset.is_finite() || rtt < 0.0 {
            return;
        }
        // A device that slept (or had its clock stepped) makes every older
        // sample wrong at once. One fast probe that disagrees with the
        // estimate by far more than any network could explain is that, not
        // noise.
        if let Some(est) = self.estimate(at) {
            if rtt <= est.rtt * 2.0 + 2.0 && (offset - est.offset).abs() > 50.0 + rtt {
                self.reset();
            }
        }
        let p = Probe { at, rtt, offset };
        if self.len < self.max {
            let i = (self.head + self.len) % self.max;
            self.probes[i] = p;
            self.len += 1;
        } else {
            self.probes[self.head] = p;
            self.head = (self.head + 1) % self.max;
        }
    }

    /// The probes worth believing into `self.good`: within the window, and
    /// close to the fastest. Returns how many.
    fn collect_good(&mut self, now: f64) -> usize {
        let mut best = f64::INFINITY;
        let mut any = false;
        for k in 0..self.len {
            let s = self.probe(k);
            if now - s.at <= self.window_ms {
                any = true;
                if s.rtt < best {
                    best = s.rtt;
                }
            }
        }
        if !any {
            return 0;
        }
        let cut = best * 1.5 + 1.0;
        let mut n = 0;
        for k in 0..self.len {
            let s = self.probe(k);
            if now - s.at <= self.window_ms && s.rtt <= cut {
                self.good[n] = s;
                n += 1;
            }
        }
        n
    }

    pub fn estimate(&mut self, now: f64) -> Option<Estimate> {
        let n = self.collect_good(now);
        if n == 0 {
            return None;
        }
        let g = &self.good[..n];
        let mut rtt = f64::INFINITY;
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for s in g {
            if s.rtt < rtt {
                rtt = s.rtt;
            }
            if s.at < lo {
                lo = s.at;
            }
            if s.at > hi {
                hi = s.at;
            }
        }
        // Without a line, only RECENT probes: under skew an old one is stale
        // by its age times the drift, however fast its round trip was.
        let mut m = 0;
        for s in g {
            if now - s.at <= RECENT_MS {
                self.scratch[m] = s.offset;
                m += 1;
            }
        }
        if m == 0 {
            for s in g {
                self.scratch[m] = s.offset;
                m += 1;
            }
        }
        let flat = median_mean(&mut self.scratch[..m]);
        let span = if n > 1 { hi - lo } else { 0.0 };
        // offset_at(t) = base + slope * (t - mx) along a line; `flat` without.
        let line = n >= 6 && span >= self.fit_span_ms;
        let (base, slope, mx) = if line {
            // Least squares of offset against time, centred for precision.
            let mut sa = 0.0;
            let mut so = 0.0;
            for s in g {
                sa += s.at;
            }
            for s in g {
                so += s.offset;
            }
            let mx = sa / n as f64;
            let my = so / n as f64;
            let mut sxx = 0.0;
            let mut sxy = 0.0;
            for s in g {
                let dx = s.at - mx;
                sxx += dx * dx;
                sxy += dx * (s.offset - my);
            }
            let slope = clamp(if sxx != 0.0 { sxy / sxx } else { 0.0 }, -MAX_SKEW, MAX_SKEW);
            // Anchored on the MEDIAN residual, not the mean: one probe that got
            // lucky in only one direction must not drag it.
            for (k, s) in g.iter().enumerate() {
                self.scratch[k] = s.offset - slope * (s.at - mx);
            }
            (median_mean(&mut self.scratch[..n]), slope, mx)
        } else {
            (flat, 0.0, 0.0)
        };
        let at = |t: f64| if line { base + slope * (t - mx) } else { base };
        let offset = at(now);
        let g = &self.good[..n];
        for (k, s) in g.iter().enumerate() {
            self.scratch[k] = (s.offset - at(s.at)).abs();
        }
        let spread = median_mean(&mut self.scratch[..n]);
        Some(Estimate { offset, rtt, spread, n: n as u32 })
    }
}

// --- the host's line ------------------------------------------------------------------

/// A single `currentTime` read is only good to a few milliseconds, but the
/// element plays at one rate, so every reading taken while it plays sits on
/// the line `position = c + time`. Each reading estimates c; the MEDIAN of the
/// recent ones is far steadier than any of them. A reading far off the line is
/// a seek, a stall or a restart: the fit breaks there and starts over.
pub struct AnchorFit {
    cs: Ring,
    break_s: f64,
    scratch: Vec<f64>,
}

impl AnchorFit {
    pub fn new(max: usize, break_s: f64) -> AnchorFit {
        let max = max.clamp(1, 1024);
        AnchorFit { cs: Ring::new(max), break_s, scratch: vec![0.0; max] }
    }

    pub fn reset(&mut self) {
        self.cs.clear();
    }

    pub fn len(&self) -> usize {
        self.cs.len()
    }

    fn median(&mut self) -> f64 {
        let n = self.cs.copy_to(&mut self.scratch);
        median_mean(&mut self.scratch[..n])
    }

    /// A reading at local time `perf_ms` of an element at `pos` seconds.
    /// False when it broke the line.
    pub fn add(&mut self, perf_ms: f64, pos: f64) -> bool {
        let c = pos - perf_ms / 1000.0;
        let mut continued = true;
        if self.cs.len() > 0 && (c - self.median()).abs() > self.break_s {
            self.cs.clear();
            continued = false;
        }
        self.cs.push(c);
        continued
    }

    /// Where the line puts the playhead at `perf_ms`; None with no reading.
    pub fn position_at(&mut self, perf_ms: f64) -> Option<f64> {
        if self.cs.len() == 0 {
            return None;
        }
        Some(self.median() + perf_ms / 1000.0)
    }
}

// --- a guest's audio clock -------------------------------------------------------------

const MAP_KEEP: usize = 15;
const MAP_READY: usize = 3;
const MAP_OUTLIER: f64 = 0.004; // s
// A move is believed once two readings in a row agree on it: they hold to
// ±0.1 ms, so two within a millisecond of each other and four or more from the
// mapping are not noise.
const MAP_AGREE: f64 = 0.001; // s
const LAG_KEEP: usize = 30;

/// The guest's map from its performance clock onto its AudioContext's: the
/// median of recent readings of `contextTime - performanceTime`, one far from
/// it refused until a second agrees with it — then the map is learnt afresh
/// from those two, and usable at once.
pub struct Bridge {
    ds: Ring,
    lags: Ring,
    rejected: Option<f64>,
    need: usize,
    scratch: Vec<f64>,
}

pub const OFFER_REFUSED: u32 = 0;
pub const OFFER_TAKEN: u32 = 1;
pub const OFFER_MOVED: u32 = 2;

impl Bridge {
    pub fn new() -> Bridge {
        Bridge { ds: Ring::new(MAP_KEEP), lags: Ring::new(LAG_KEEP), rejected: None, need: MAP_READY, scratch: vec![0.0; LAG_KEEP] }
    }

    pub fn median(&mut self) -> f64 {
        let n = self.ds.copy_to(&mut self.scratch);
        if n == 0 {
            return f64::NAN;
        }
        median_mean(&mut self.scratch[..n])
    }

    pub fn len(&self) -> usize {
        self.ds.len()
    }

    pub fn ready(&self) -> bool {
        self.ds.len() >= self.need
    }

    /// One reading `d` (seconds), with the context time and the performance
    /// time (ms) of the moment it was taken, for the output-lag record.
    pub fn offer(&mut self, d: f64, ctx_time: f64, perf_ms: f64) -> u32 {
        if !d.is_finite() {
            return OFFER_REFUSED;
        }
        let mut moved = false;
        if self.ds.len() >= self.need && (d - self.median()).abs() > MAP_OUTLIER {
            match self.rejected {
                Some(r) if (d - r).abs() <= MAP_AGREE => {
                    // It really moved: learn it again from the two readings
                    // that showed it.
                    self.ds.clear();
                    self.lags.clear();
                    self.ds.push(r);
                    self.need = 2;
                    moved = true;
                }
                _ => {
                    self.rejected = Some(d);
                    return OFFER_REFUSED;
                }
            }
        }
        self.rejected = None;
        self.ds.push(d);
        let lag = ctx_time - (perf_ms / 1000.0 + self.median());
        self.lags.push(lag);
        if moved {
            OFFER_MOVED
        } else {
            OFFER_TAKEN
        }
    }

    /// How far the context runs ahead of the listener, seconds; None until
    /// there are enough readings.
    pub fn output_lag(&mut self) -> Option<f64> {
        if self.lags.len() < MAP_READY * 3 {
            return None;
        }
        let n = self.lags.copy_to(&mut self.scratch);
        let m = median_mean(&mut self.scratch[..n]);
        Some(if m > 0.0 { m } else { 0.0 })
    }
}

// --- the output clock ------------------------------------------------------------------

const OUT_KEEP: usize = 25;
const OUT_OUTLIER: f64 = 0.004;
const OUT_AGREE: f64 = 0.001;
const OUT_LAG_KEEP: usize = 60;
const OUT_NEED: usize = 9;

/// `d` is contextTime − performanceTime for the sample being heard. The
/// median of recent readings is kept; one far from it is refused until a
/// second that agrees with it shows the mapping really moved, and then it is
/// learnt again from those two at once. Chromium does move it: a few seconds
/// after a context starts its mapping steps by a whole render burst (20-23 ms)
/// and stays there.
pub struct OutputClock {
    ds: Ring,
    lags: Ring,
    refused: Option<f64>,
    need: usize,
    since_sort: u32,
    lag_since_sort: u32,
    d_median: Option<f64>,
    lag_median: Option<f64>,
    generation: u32,
    scratch: Vec<f64>,
}

impl OutputClock {
    pub fn new() -> OutputClock {
        OutputClock {
            ds: Ring::new(OUT_KEEP),
            lags: Ring::new(OUT_LAG_KEEP),
            refused: None,
            need: OUT_NEED,
            since_sort: 0,
            lag_since_sort: 0,
            d_median: None,
            lag_median: None,
            generation: 0,
            scratch: vec![0.0; OUT_LAG_KEEP],
        }
    }

    /// A new context: nine readings before it is believed (its first can be
    /// ~140 ms off), and anything fitted on the old mapping starts again.
    pub fn forget(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.need = OUT_NEED;
        self.ds.clear();
        self.lags.clear();
        self.d_median = None;
        self.lag_median = None;
        self.refused = None;
        self.since_sort = 0;
        self.lag_since_sort = 0;
    }

    pub fn offer(&mut self, d: f64) {
        if !d.is_finite() {
            return;
        }
        if let Some(m) = self.d_median {
            if (d - m).abs() > OUT_OUTLIER && self.ds.len() >= self.need.min(3) {
                match self.refused {
                    Some(r) if (d - r).abs() <= OUT_AGREE => {
                        self.ds.clear();
                        self.lags.clear();
                        self.ds.push(r);
                        self.d_median = None;
                        self.need = 2;
                        self.generation = self.generation.wrapping_add(1);
                    }
                    _ => {
                        self.refused = Some(d);
                        return;
                    }
                }
            }
        }
        self.refused = None;
        self.ds.push(d);
        // Every third reading, counted — not by the buffer's length, which
        // stops growing at OUT_KEEP and froze a median keyed on it for good.
        self.since_sort += 1;
        if self.since_sort >= 3 || self.d_median.is_none() {
            self.since_sort = 0;
            let n = self.ds.copy_to(&mut self.scratch);
            self.d_median = Some(median_upper(&mut self.scratch[..n]));
        }
    }

    pub fn note_lag(&mut self, lag: f64) {
        if !lag.is_finite() {
            return;
        }
        self.lags.push(lag);
        self.lag_since_sort += 1;
        if self.lag_since_sort >= 4 || self.lag_median.is_none() {
            self.lag_since_sort = 0;
            let n = self.lags.copy_to(&mut self.scratch);
            self.lag_median = Some(median_upper(&mut self.scratch[..n]));
        }
    }

    pub fn d_median(&self) -> Option<f64> {
        self.d_median
    }
    pub fn lag_median(&self) -> Option<f64> {
        self.lag_median
    }
    pub fn lag_count(&self) -> usize {
        self.lags.len()
    }
    pub fn ready(&self) -> bool {
        self.d_median.is_some() && self.ds.len() >= self.need
    }
    pub fn generation(&self) -> u32 {
        self.generation
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_the_newest() {
        let mut r = Ring::new(3);
        for v in 0..5 {
            r.push(v as f64);
        }
        assert_eq!((r.get(0), r.get(1), r.get(2)), (2.0, 3.0, 4.0));
    }

    #[test]
    fn a_steady_clock_is_read_exactly() {
        let mut e = ClockEstimator::new(64, 180_000.0, 20_000.0);
        for k in 0..20 {
            let at = 1000.0 * k as f64;
            e.add(at, 10.0 + (k % 3) as f64, 500.0);
        }
        let est = e.estimate(20_000.0).unwrap();
        assert_eq!(est.offset, 500.0);
        assert_eq!(est.rtt, 10.0);
    }

    #[test]
    fn a_stepped_clock_starts_again() {
        let mut e = ClockEstimator::new(64, 180_000.0, 20_000.0);
        for k in 0..10 {
            e.add(1000.0 * k as f64, 4.0, 100.0);
        }
        e.add(11_000.0, 4.0, 30_100.0);
        assert_eq!(e.len(), 1);
    }

    #[test]
    fn the_line_breaks_on_a_seek() {
        let mut f = AnchorFit::new(24, 0.25);
        assert!(f.add(0.0, 10.0));
        assert!(f.add(250.0, 10.25));
        assert!(!f.add(500.0, 40.0));
        assert_eq!(f.len(), 1);
        assert!((f.position_at(1500.0).unwrap() - 41.0).abs() < 1e-12);
    }

    #[test]
    fn a_move_is_believed_on_the_second_agreeing_reading() {
        let mut b = Bridge::new();
        for _ in 0..5 {
            assert_eq!(b.offer(1.0, 0.0, 0.0), OFFER_TAKEN);
        }
        assert_eq!(b.offer(1.02, 0.0, 0.0), OFFER_REFUSED);
        assert_eq!(b.offer(1.0203, 0.0, 0.0), OFFER_MOVED);
        assert!(b.ready());
        assert!((b.median() - 1.02015).abs() < 1e-9);
    }
}

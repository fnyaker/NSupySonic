//! NSupySonic's APP CORE, compiled to WebAssembly for the page: the logic the
//! interface runs many times a second or over thousands of rows, where the
//! JavaScript it replaced allocated as it went.
//!
//!   sync.rs    every time-sync estimator the app has — the listen party's
//!              shared clock, the host's line, the guest's audio-clock
//!              bridge, and the output clock the animations, the lyric line
//!              and the party host share
//!   tracks.rs  the track lists' search and sort, over folded text (fold.rs)
//!
//! A separate module from the rhythm analyser on purpose: that one is 200 KB
//! and loads when an animation needs it; this one is a few dozen kilobytes and
//! a party guest with every animation off, or a person searching their
//! favourites, needs it at once.
//!
//! Everything is created through a HANDLE — a slot in a table, 1-based so that
//! 0 means "none" — and nothing allocates on the hot paths once an object is
//! built. Numbers come back as return values (NaN standing for "no value"),
//! or, where there are several, in `appcore_out`, eight f64 the page reads in
//! place.

pub mod fold;
pub mod sync;
pub mod tracks;

use sync::{AnchorFit, Bridge, ClockEstimator, OutputClock};
use tracks::TrackIndex;

struct Core {
    clocks: Vec<Option<ClockEstimator>>,
    fits: Vec<Option<AnchorFit>>,
    bridges: Vec<Option<Bridge>>,
    outputs: Vec<Option<OutputClock>>,
    // Boxed: the page holds pointers into an index's buffers between calls.
    tracks: Vec<Option<Box<TrackIndex>>>,
    out: [f64; 8],
}

static mut C: Option<Core> = None;

#[allow(static_mut_refs)]
fn c() -> &'static mut Core {
    // SAFETY: the page's WebAssembly is single-threaded and every entry point
    // runs to completion before the next one is called.
    unsafe {
        if C.is_none() {
            C = Some(Core {
                clocks: Vec::new(),
                fits: Vec::new(),
                bridges: Vec::new(),
                outputs: Vec::new(),
                tracks: Vec::new(),
                out: [0.0; 8],
            });
        }
        C.as_mut().unwrap()
    }
}

fn put<T>(slab: &mut Vec<Option<T>>, t: T) -> u32 {
    if let Some(i) = slab.iter().position(|s| s.is_none()) {
        slab[i] = Some(t);
        (i + 1) as u32
    } else {
        slab.push(Some(t));
        slab.len() as u32
    }
}

fn get<T>(slab: &mut [Option<T>], h: u32) -> Option<&mut T> {
    slab.get_mut((h as usize).wrapping_sub(1)).and_then(|s| s.as_mut())
}

fn drop_at<T>(slab: &mut [Option<T>], h: u32) {
    if let Some(s) = slab.get_mut((h as usize).wrapping_sub(1)) {
        *s = None;
    }
}

/// FNV-1a of src/*.rs (build.rs), so a stale committed binary fails a test.
#[no_mangle]
pub extern "C" fn appcore_src_hash() -> u32 {
    env!("APPCORE_SRC_HASH").parse().unwrap_or(0)
}

/// Eight f64 the calls with more than one answer write into.
#[no_mangle]
pub extern "C" fn appcore_out() -> *const f64 {
    c().out.as_ptr()
}

// --- the party clock -------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn clock_new(max: u32, window_ms: f64, fit_span_ms: f64) -> u32 {
    put(&mut c().clocks, ClockEstimator::new(max as usize, window_ms, fit_span_ms))
}

#[no_mangle]
pub extern "C" fn clock_free(h: u32) {
    drop_at(&mut c().clocks, h);
}

#[no_mangle]
pub extern "C" fn clock_reset(h: u32) {
    if let Some(e) = get(&mut c().clocks, h) {
        e.reset();
    }
}

#[no_mangle]
pub extern "C" fn clock_len(h: u32) -> u32 {
    get(&mut c().clocks, h).map_or(0, |e| e.len() as u32)
}

#[no_mangle]
pub extern "C" fn clock_add(h: u32, at: f64, rtt: f64, offset: f64) {
    if let Some(e) = get(&mut c().clocks, h) {
        e.add(at, rtt, offset);
    }
}

/// 0 when there is no estimate; otherwise the number of good probes, with
/// offset, rtt and spread in appcore_out[0..3].
#[no_mangle]
pub extern "C" fn clock_estimate(h: u32, now: f64) -> u32 {
    let core = c();
    let Some(e) = get(&mut core.clocks, h) else { return 0 };
    match e.estimate(now) {
        None => 0,
        Some(est) => {
            core.out[0] = est.offset;
            core.out[1] = est.rtt;
            core.out[2] = est.spread;
            est.n
        }
    }
}

// --- the host's line ---------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn fit_new(max: u32, break_s: f64) -> u32 {
    put(&mut c().fits, AnchorFit::new(max as usize, break_s))
}

#[no_mangle]
pub extern "C" fn fit_free(h: u32) {
    drop_at(&mut c().fits, h);
}

#[no_mangle]
pub extern "C" fn fit_reset(h: u32) {
    if let Some(f) = get(&mut c().fits, h) {
        f.reset();
    }
}

#[no_mangle]
pub extern "C" fn fit_len(h: u32) -> u32 {
    get(&mut c().fits, h).map_or(0, |f| f.len() as u32)
}

/// 1 when the reading continued the line, 0 when it broke it.
#[no_mangle]
pub extern "C" fn fit_add(h: u32, perf_ms: f64, pos: f64) -> u32 {
    get(&mut c().fits, h).map_or(0, |f| f.add(perf_ms, pos) as u32)
}

/// NaN with no reading.
#[no_mangle]
pub extern "C" fn fit_position(h: u32, perf_ms: f64) -> f64 {
    get(&mut c().fits, h).and_then(|f| f.position_at(perf_ms)).unwrap_or(f64::NAN)
}

// --- a guest's audio clock ---------------------------------------------------------------

#[no_mangle]
pub extern "C" fn bridge_new() -> u32 {
    put(&mut c().bridges, Bridge::new())
}

#[no_mangle]
pub extern "C" fn bridge_free(h: u32) {
    drop_at(&mut c().bridges, h);
}

/// sync::OFFER_REFUSED / OFFER_TAKEN / OFFER_MOVED.
#[no_mangle]
pub extern "C" fn bridge_offer(h: u32, d: f64, ctx_time: f64, perf_ms: f64) -> u32 {
    get(&mut c().bridges, h).map_or(0, |b| b.offer(d, ctx_time, perf_ms))
}

#[no_mangle]
pub extern "C" fn bridge_ready(h: u32) -> u32 {
    get(&mut c().bridges, h).map_or(0, |b| b.ready() as u32)
}

#[no_mangle]
pub extern "C" fn bridge_len(h: u32) -> u32 {
    get(&mut c().bridges, h).map_or(0, |b| b.len() as u32)
}

/// NaN with no reading.
#[no_mangle]
pub extern "C" fn bridge_median(h: u32) -> f64 {
    get(&mut c().bridges, h).map_or(f64::NAN, |b| b.median())
}

/// NaN until there are enough readings.
#[no_mangle]
pub extern "C" fn bridge_output_lag(h: u32) -> f64 {
    get(&mut c().bridges, h).and_then(|b| b.output_lag()).unwrap_or(f64::NAN)
}

// --- the output clock --------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn out_new() -> u32 {
    put(&mut c().outputs, OutputClock::new())
}

#[no_mangle]
pub extern "C" fn out_free(h: u32) {
    drop_at(&mut c().outputs, h);
}

#[no_mangle]
pub extern "C" fn out_forget(h: u32) {
    if let Some(o) = get(&mut c().outputs, h) {
        o.forget();
    }
}

#[no_mangle]
pub extern "C" fn out_offer(h: u32, d: f64) {
    if let Some(o) = get(&mut c().outputs, h) {
        o.offer(d);
    }
}

#[no_mangle]
pub extern "C" fn out_note_lag(h: u32, lag: f64) {
    if let Some(o) = get(&mut c().outputs, h) {
        o.note_lag(lag);
    }
}

/// NaN while there is no mapping.
#[no_mangle]
pub extern "C" fn out_d_median(h: u32) -> f64 {
    get(&mut c().outputs, h).and_then(|o| o.d_median()).unwrap_or(f64::NAN)
}

/// NaN while there is no lag reading.
#[no_mangle]
pub extern "C" fn out_lag_median(h: u32) -> f64 {
    get(&mut c().outputs, h).and_then(|o| o.lag_median()).unwrap_or(f64::NAN)
}

#[no_mangle]
pub extern "C" fn out_lag_count(h: u32) -> u32 {
    get(&mut c().outputs, h).map_or(0, |o| o.lag_count() as u32)
}

#[no_mangle]
pub extern "C" fn out_ready(h: u32) -> u32 {
    get(&mut c().outputs, h).map_or(0, |o| o.ready() as u32)
}

#[no_mangle]
pub extern "C" fn out_generation(h: u32) -> u32 {
    get(&mut c().outputs, h).map_or(0, |o| o.generation())
}

// --- the track lists ----------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn tracks_new() -> u32 {
    put(&mut c().tracks, Box::new(TrackIndex::new()))
}

#[no_mangle]
pub extern "C" fn tracks_free(h: u32) {
    drop_at(&mut c().tracks, h);
}

/// Make room for `bytes` of UTF-8 and `count` tracks; the page then writes
/// the text at tracks_input_ptr and the numbers at tracks_nums_ptr.
#[no_mangle]
pub extern "C" fn tracks_reserve(h: u32, bytes: u32, count: u32) {
    if let Some(t) = get(&mut c().tracks, h) {
        t.reserve(bytes as usize, count as usize);
    }
}

#[no_mangle]
pub extern "C" fn tracks_input_ptr(h: u32) -> *mut u8 {
    get(&mut c().tracks, h).map_or(core::ptr::null_mut(), |t| t.input.as_mut_ptr())
}

#[no_mangle]
pub extern "C" fn tracks_nums_ptr(h: u32) -> *mut f64 {
    get(&mut c().tracks, h).map_or(core::ptr::null_mut(), |t| t.nums.as_mut_ptr())
}

#[no_mangle]
pub extern "C" fn tracks_build(h: u32, used: u32, count: u32) {
    if let Some(t) = get(&mut c().tracks, h) {
        t.build(used as usize, count as usize);
    }
}

#[no_mangle]
pub extern "C" fn tracks_len(h: u32) -> u32 {
    get(&mut c().tracks, h).map_or(0, |t| t.len() as u32)
}

/// Room for a query of `bytes` UTF-8; the page writes it there.
#[no_mangle]
pub extern "C" fn tracks_query_ptr(h: u32, bytes: u32) -> *mut u8 {
    get(&mut c().tracks, h).map_or(core::ptr::null_mut(), |t| {
        t.query.clear();
        t.query.resize(bytes as usize, 0);
        t.query.as_mut_ptr()
    })
}

/// The matching rows in display order, at tracks_out_ptr; returns how many.
/// `sort` is tracks::SORT_*, `desc` 1 for descending.
#[no_mangle]
pub extern "C" fn tracks_filter(h: u32, sort: u32, desc: u32, qlen: u32) -> u32 {
    get(&mut c().tracks, h).map_or(0, |t| t.filter(sort, desc != 0, qlen as usize) as u32)
}

#[no_mangle]
pub extern "C" fn tracks_out_ptr(h: u32) -> *const u32 {
    get(&mut c().tracks, h).map_or(core::ptr::null(), |t| t.out.as_ptr())
}

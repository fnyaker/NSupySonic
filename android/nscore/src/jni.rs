//! The JNI entry points `NsCore.kt` declares (`external fun` on `object NsCore`,
//! `@JvmStatic`, so each is `Java_org_nsupysonic_app_NsCore_<name>(env, class, …)`).
//!
//! Written against the C ABI rather than a binding crate: two JNIEnv functions
//! are used, at their fixed slots in the interface table (checked against the
//! JDK's jni.h: NewStringUTF 167, NewDirectByteBuffer 229), and every other
//! argument is a primitive.
//!
//! A handle is a `Box` turned into a `jlong`; 0 is "none". Every entry point
//! accepts 0 and does nothing with it, so a Kotlin object freed twice, or used
//! after `free`, is a no-op rather than a crash — the same rule the web app's
//! core classes follow.

use crate::dsp::Chain;
use crate::Analyser;
use core::ffi::{c_char, c_void};

type JEnv = *mut *const *const c_void;
type JClass = *mut c_void;
type JObject = *mut c_void;

const NEW_STRING_UTF: usize = 167;
const NEW_DIRECT_BYTE_BUFFER: usize = 229;

unsafe fn env_fn(env: JEnv, slot: usize) -> *const c_void {
    *(*env).add(slot)
}

unsafe fn new_string(env: JEnv, s: &str) -> JObject {
    let mut z: Vec<u8> = s.bytes().filter(|b| *b != 0).collect();
    z.push(0);
    let f: extern "system" fn(JEnv, *const c_char) -> JObject = core::mem::transmute(env_fn(env, NEW_STRING_UTF));
    f(env, z.as_ptr() as *const c_char)
}

unsafe fn direct_buffer(env: JEnv, ptr: *mut f32, floats: usize) -> JObject {
    let f: extern "system" fn(JEnv, *mut c_void, i64) -> JObject =
        core::mem::transmute(env_fn(env, NEW_DIRECT_BYTE_BUFFER));
    f(env, ptr as *mut c_void, (floats * 4) as i64)
}

unsafe fn analyser<'a>(h: i64) -> Option<&'a mut Analyser> {
    (h as *mut Analyser).as_mut()
}


// --- the library ------------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_org_nsupysonic_app_NsCore_abiVersion(_: JEnv, _: JClass) -> i32 {
    crate::ABI_VERSION as i32
}

#[no_mangle]
pub extern "system" fn Java_org_nsupysonic_app_NsCore_srcHash(_: JEnv, _: JClass) -> i64 {
    crate::src_hash() as i64
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_layout(env: JEnv, _: JClass) -> JObject {
    new_string(env, crate::layout())
}

// --- the analyser -----------------------------------------------------------------

#[no_mangle]
pub extern "system" fn Java_org_nsupysonic_app_NsCore_analyserNew(_: JEnv, _: JClass, sr: f32) -> i64 {
    if !(sr.is_finite() && (8000.0..=384000.0).contains(&sr)) {
        return 0;
    }
    Box::into_raw(Box::new(Analyser::new(sr))) as i64
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserFree(_: JEnv, _: JClass, h: i64) {
    if h != 0 {
        drop(Box::from_raw(h as *mut Analyser));
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserInput(env: JEnv, _: JClass, h: i64) -> JObject {
    match analyser(h) {
        Some(a) => direct_buffer(env, a.input.as_mut_ptr(), a.input.len()),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserOutput(env: JEnv, _: JClass, h: i64) -> JObject {
    match analyser(h) {
        Some(a) => direct_buffer(env, a.output.as_mut_ptr(), a.output.len()),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserFrameLen(_: JEnv, _: JClass, h: i64) -> i32 {
    analyser(h).map_or(0, |a| a.frame_len as i32)
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserHop(_: JEnv, _: JClass, h: i64) -> i32 {
    analyser(h).map_or(0, |a| a.a.hop() as i32)
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserPush(_: JEnv, _: JClass, h: i64, n: i32) -> i32 {
    analyser(h).map_or(0, |a| a.push(n.max(0) as usize) as i32)
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserLoadFamilies(_: JEnv, _: JClass, h: i64, n: i32) -> bool {
    analyser(h).is_some_and(|a| a.load_families(n.max(0) as usize))
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserSetLevel(_: JEnv, _: JClass, h: i64, level: i32) {
    if let Some(a) = analyser(h) {
        a.a.set_level(level.clamp(0, 2) as u32);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserSeed(_: JEnv, _: JClass, h: i64, bpm: f32, conf: f32) -> bool {
    analyser(h).is_some_and(|a| a.a.seed(bpm, conf))
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserLockTempo(_: JEnv, _: JClass, h: i64, bpm: f32) -> bool {
    analyser(h).is_some_and(|a| a.a.lock_tempo(bpm))
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserSetRange(_: JEnv, _: JClass, h: i64, lo: f32, hi: f32) {
    if let Some(a) = analyser(h) {
        a.a.set_range(lo, hi);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserPinFamily(_: JEnv, _: JClass, h: i64, id: i32) {
    if let Some(a) = analyser(h) {
        a.a.pin_family(id);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserSetGroove(_: JEnv, _: JClass, h: i64, g: i32) {
    if let Some(a) = analyser(h) {
        a.a.set_groove(g.max(0) as u32);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserSetProfile(_: JEnv, _: JClass, h: i64, lull: f32, kicks: bool) {
    if let Some(a) = analyser(h) {
        a.a.set_profile(lull, kicks);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserSetClassify(_: JEnv, _: JClass, h: i64, on: bool) {
    if let Some(a) = analyser(h) {
        a.a.set_classify(on);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserSetLiveRange(_: JEnv, _: JClass, h: i64, on: bool) {
    if let Some(a) = analyser(h) {
        a.a.set_live_range(on);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_analyserReset(_: JEnv, _: JClass, h: i64) {
    if let Some(a) = analyser(h) {
        a.a.reset();
    }
}

// --- the output chain -------------------------------------------------------------

/// Frames the chain's buffer holds (a Media3 AudioProcessor hands a few
/// thousand at a time; a bigger input is processed in pieces by the caller).
pub const CHAIN_FRAMES: usize = 8192;

pub struct ChainBox {
    pub chain: Chain,
    pub buf: Vec<f32>,
}

unsafe fn chain_box<'a>(h: i64) -> Option<&'a mut ChainBox> {
    (h as *mut ChainBox).as_mut()
}

#[no_mangle]
pub extern "system" fn Java_org_nsupysonic_app_NsCore_chainNew(_: JEnv, _: JClass, sr: f32, channels: i32) -> i64 {
    if !(sr.is_finite() && (8000.0..=384000.0).contains(&sr)) || !(1..=8).contains(&channels) {
        return 0;
    }
    let chain = Chain::new(sr, channels as usize);
    let buf = vec![0.0; CHAIN_FRAMES * chain.channels()];
    Box::into_raw(Box::new(ChainBox { chain, buf })) as i64
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainFree(_: JEnv, _: JClass, h: i64) {
    if h != 0 {
        drop(Box::from_raw(h as *mut ChainBox));
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainBuffer(env: JEnv, _: JClass, h: i64) -> JObject {
    match chain_box(h) {
        Some(c) => direct_buffer(env, c.buf.as_mut_ptr(), c.buf.len()),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainProcess(_: JEnv, _: JClass, h: i64, frames: i32) {
    if let Some(c) = chain_box(h) {
        let n = (frames.max(0) as usize).min(CHAIN_FRAMES);
        c.chain.process(&mut c.buf, n);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainSetGain(_: JEnv, _: JClass, h: i64, db: f32, ramp_ms: f32) {
    if let (Some(c), true) = (chain_box(h), db.is_finite()) {
        c.chain.set_gain_db(db as f64, ramp_ms as f64);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainFadeTo(_: JEnv, _: JClass, h: i64, to: f32, ms: f32) {
    if let (Some(c), true) = (chain_box(h), to.is_finite() && ms.is_finite()) {
        c.chain.fade_to(to as f64, ms as f64);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainFade(_: JEnv, _: JClass, h: i64) -> f32 {
    chain_box(h).map_or(0.0, |c| c.chain.fade() as f32)
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainSetEq(_: JEnv, _: JClass, h: i64, band: i32, db: f32) {
    if let Some(c) = chain_box(h) {
        c.chain.set_eq(band.max(0) as usize, db as f64);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainSetBass(_: JEnv, _: JClass, h: i64, db: f32) {
    if let Some(c) = chain_box(h) {
        c.chain.set_bass(db as f64);
    }
}

#[no_mangle]
pub unsafe extern "system" fn Java_org_nsupysonic_app_NsCore_chainClear(_: JEnv, _: JClass, h: i64) {
    if let Some(c) = chain_box(h) {
        c.chain.clear_state();
    }
}


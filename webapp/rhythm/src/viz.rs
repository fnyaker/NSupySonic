//! The ANIMATIONS' arithmetic, for the page.
//!
//! The analyser (lib.rs) runs on the audio thread and says what the music is
//! doing; everything in the `viz_*` modules runs on the page and turns that into
//! what is drawn — the oscilloscope's trigger and trace, the bars' levelling,
//! the musical clock every world is timed by and the uniform block the shaders
//! read. The PIXELS stay on the GPU, in the worlds' GLSL: a browser runs no
//! other language there, and drawing them on the CPU instead, in any language,
//! would be tens of times slower. What the CPU does for them is here.
//!
//! Same crate, same binary as the analyser: the page already compiles this
//! module to start the AudioWorklet, so the animations instantiate it a second
//! time on the main thread for nothing — no second download, no second
//! compile. Each instance has its own memory; the two never share state.
//!
//! Many views can be on screen at once (the player, the settings preview, a
//! projector tab of its own), so every object is created through a HANDLE: a
//! slot in a table, 1-based so that 0 can mean "no". Nothing here allocates
//! once an object is built, so the views the page holds on this memory stay
//! valid from one frame to the next.

use crate::viz_bars::{Bars, MAX_BARS};
use crate::viz_motion::{layout_text, IN_FIELDS, IN_LEN, OUT_FIELDS, OUT_LEN};
use crate::viz_scene::{Scene, MAX_BANDS, MAX_BLOCK, PACK_FIELDS, PACK_LEN, PREP_FIELDS, PREP_LEN, SLOTS, SPEC_W};
use crate::viz_scope::{Scope, ScopeCfg, MAX_COLS, STATE_LEN, TRACE_LEN};

struct Viz {
    scopes: Vec<Option<Scope>>,
    bars: Vec<Option<Bars>>,
    // Boxed: the page holds views on a scene's buffers, and a box does not
    // move when the table grows.
    scenes: Vec<Option<Box<Scene>>>,
    text: String,
}

static mut V: Option<Viz> = None;

#[allow(static_mut_refs)]
fn v() -> &'static mut Viz {
    // SAFETY: the page's WebAssembly is single-threaded and every entry point
    // runs to completion before the next one is called.
    unsafe {
        if V.is_none() {
            V = Some(Viz { scopes: Vec::new(), bars: Vec::new(), scenes: Vec::new(), text: String::new() });
        }
        V.as_mut().unwrap()
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

// --- the oscilloscope ----------------------------------------------------------------

#[no_mangle]
pub extern "C" fn viz_scope_new() -> u32 {
    put(&mut v().scopes, Scope::new())
}

#[no_mangle]
pub extern "C" fn viz_scope_free(h: u32) {
    drop_at(&mut v().scopes, h);
}

#[no_mangle]
pub extern "C" fn viz_scope_max_cols() -> u32 {
    MAX_COLS as u32
}

#[no_mangle]
pub extern "C" fn viz_scope_trace_len() -> u32 {
    TRACE_LEN as u32
}

#[no_mangle]
pub extern "C" fn viz_scope_state_len() -> u32 {
    STATE_LEN as u32
}

#[no_mangle]
pub extern "C" fn viz_scope_config(h: u32, search_ms: f64, exact: u32, fine: u32, interp: u32) {
    if let Some(s) = get(&mut v().scopes, h) {
        s.cfg = ScopeCfg { search_ms, exact: exact != 0, fine: fine != 0, interp: interp != 0 };
    }
}

#[no_mangle]
pub extern "C" fn viz_scope_cols(h: u32, cols: u32) {
    if let Some(s) = get(&mut v().scopes, h) {
        s.set_cols(cols as usize);
    }
}

/// Where to write the next window: `left` then `right`, `size` samples each.
/// May grow the memory — call it BEFORE taking views for the frame.
#[no_mangle]
pub extern "C" fn viz_scope_wave(h: u32, size: u32) -> *mut f32 {
    match get(&mut v().scopes, h) {
        Some(s) => s.wave_ptr(size as usize),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn viz_scope_update(h: u32, size: u32, sr: f64, dt: f64) {
    if let Some(s) = get(&mut v().scopes, h) {
        s.update(size as usize, sr, dt);
    }
}

#[no_mangle]
pub extern "C" fn viz_scope_idle(h: u32, dt: f64) {
    if let Some(s) = get(&mut v().scopes, h) {
        s.idle(dt);
    }
}

#[no_mangle]
pub extern "C" fn viz_scope_trace(h: u32) -> *const f32 {
    match get(&mut v().scopes, h) {
        Some(s) => s.trace_ptr(),
        None => core::ptr::null(),
    }
}

/// `[gain, locked, peakEnv, trigEnv, signal, cols, 0, 0]`
#[no_mangle]
pub extern "C" fn viz_scope_state(h: u32) -> *const f32 {
    match get(&mut v().scopes, h) {
        Some(s) => s.state_ptr(),
        None => core::ptr::null(),
    }
}

// --- the spectrum bars (the canvas fallback) -------------------------------------------

#[no_mangle]
pub extern "C" fn viz_bars_new() -> u32 {
    put(&mut v().bars, Bars::new())
}

#[no_mangle]
pub extern "C" fn viz_bars_free(h: u32) {
    drop_at(&mut v().bars, h);
}

#[no_mangle]
pub extern "C" fn viz_bars_max() -> u32 {
    MAX_BARS as u32
}

#[no_mangle]
pub extern "C" fn viz_bars_count(h: u32, n: u32) {
    if let Some(b) = get(&mut v().bars, h) {
        b.set_count(n as usize);
    }
}

/// Where the page writes the analyser's bands for the next update.
#[no_mangle]
pub extern "C" fn viz_bars_input(h: u32) -> *mut f32 {
    match get(&mut v().bars, h) {
        Some(b) => b.input_ptr(),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn viz_bars_update(h: u32, nbands: u32, level: f64, dt: f64) {
    if let Some(b) = get(&mut v().bars, h) {
        b.update(nbands as usize, level, dt);
    }
}

/// `smooth` then `peaks`, MAX_BARS each; the first `count` of each are live.
#[no_mangle]
pub extern "C" fn viz_bars_output(h: u32) -> *const f32 {
    match get(&mut v().bars, h) {
        Some(b) => b.output_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn viz_bars_level(h: u32) -> f64 {
    get(&mut v().bars, h).map(|b| b.level()).unwrap_or(0.0)
}

// --- the GL scene: the musical reading and the uniform block ------------------------------

#[no_mangle]
pub extern "C" fn viz_scene_new() -> u32 {
    put(&mut v().scenes, Box::new(Scene::new()))
}

#[no_mangle]
pub extern "C" fn viz_scene_free(h: u32) {
    drop_at(&mut v().scenes, h);
}

/// A layout, as "name:offset:length;" — 0 the reading's input, 1 its output,
/// 2 what `pack` is told, 3 what `prepare` returns, 4 the block's slot names
/// (offset = their index). Returns the text's length; `viz_text` points at it
/// until the next call.
#[no_mangle]
pub extern "C" fn viz_scene_layout(which: u32) -> u32 {
    let slots: Vec<(&str, usize, usize)>;
    let fields: &[(&str, usize, usize)] = match which {
        0 => IN_FIELDS,
        1 => OUT_FIELDS,
        2 => PACK_FIELDS,
        3 => PREP_FIELDS,
        _ => {
            slots = SLOTS.iter().enumerate().map(|(i, n)| (*n, i, 1)).collect();
            &slots
        }
    };
    let viz = v();
    viz.text = layout_text(fields);
    viz.text.len() as u32
}

#[no_mangle]
pub extern "C" fn viz_text() -> *const u8 {
    v().text.as_ptr()
}

/// The length of buffer `which` (see `viz_scene_ptr`), in elements.
#[no_mangle]
pub extern "C" fn viz_scene_len(which: u32) -> u32 {
    (match which {
        0 => IN_LEN,
        1 => OUT_LEN,
        2 => MAX_BANDS,
        3 => 12,
        4 => PACK_LEN,
        5 => PREP_LEN,
        6 => MAX_BLOCK,
        7 => SPEC_W * 2,
        8 => SPEC_W,
        9 => SPEC_W,
        _ => 0,
    }) as u32
}

/// Where buffer `which` lives: 0 the reading's input (f64), 1 its output
/// (f64), 2 the bands (f32), 3 the chroma (f32), 4 what `pack` is told (f64),
/// 5 what `prepare` returned (f64), 6 the block (f32), 7 the spectrum texture
/// (u8, two rows), 8 the history row (u8), 9 the released spectrum (f32).
#[no_mangle]
pub extern "C" fn viz_scene_ptr(h: u32, which: u32) -> *const u8 {
    match get(&mut v().scenes, h) {
        Some(s) => match which {
            0 => s.m.input.as_ptr() as *const u8,
            1 => s.m.out.as_ptr() as *const u8,
            2 => s.bands.as_ptr() as *const u8,
            3 => s.chroma_in.as_ptr() as *const u8,
            4 => s.pack_in.as_ptr() as *const u8,
            5 => s.prep.as_ptr() as *const u8,
            6 => s.block.as_ptr() as *const u8,
            7 => s.spec.as_ptr(),
            8 => s.hist_row.as_ptr(),
            9 => s.spec_smooth.as_ptr() as *const u8,
            _ => core::ptr::null(),
        },
        None => core::ptr::null(),
    }
}

/// Slot `k` of the block (in `viz_scene_layout(4)` order) starts at `offset`.
#[no_mangle]
pub extern "C" fn viz_scene_slot(h: u32, k: u32, offset: u32) {
    if let Some(s) = get(&mut v().scenes, h) {
        s.set_slot(k as usize, offset as usize);
    }
}

#[no_mangle]
pub extern "C" fn viz_scene_block_len(h: u32, len: u32) {
    if let Some(s) = get(&mut v().scenes, h) {
        s.set_block_len(len as usize);
    }
}

/// One analysis frame (the reading's input and the bands already written).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn viz_scene_update(h: u32, dt: f64, now: f64, nbands: u32, flags: u32, pitch: f64, melody: f64, dynamics: f64) {
    if let Some(s) = get(&mut v().scenes, h) {
        s.update(dt, now, nbands as usize, flags, pitch, melody, dynamics);
    }
}

/// The first half of a picture. 1 when a history row is due.
#[no_mangle]
pub extern "C" fn viz_scene_prepare(h: u32, t: f64, rdt: f64) -> u32 {
    match get(&mut v().scenes, h) {
        Some(s) => s.prepare(t, rdt) as u32,
        None => 0,
    }
}

/// The second half: the block, from what `pack` was told.
#[no_mangle]
pub extern "C" fn viz_scene_pack(h: u32) {
    if let Some(s) = get(&mut v().scenes, h) {
        s.pack();
    }
}

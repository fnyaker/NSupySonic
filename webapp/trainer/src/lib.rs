//! NSupySonic's genre-studio TRAINER, compiled to WebAssembly for the studio's
//! worker (src/lib/genre/worker.js through core.js).
//!
//!   train.rs   the heads (a softmax plane, a stack of dense layers) and the
//!              run around them: folds, bags, projection, temperature
//!   cv.rs      the folds (stratified, or by artist), the temperature fit, the
//!              scores
//!   linalg.rs  the loops it is made of, SIMD128 where the build has it and
//!              the same bits where it does not
//!   rng.rs     the one seeded generator every random choice comes from
//!
//! It replaced two JavaScript trainers and a C kernel (kept as the oracle in
//! test/reference/). One job at a time, which is all a worker ever runs: the
//! page sizes it (`tr_new`), writes the rows into the buffers it is handed,
//! configures and starts it, then calls `tr_step` until the progress reads 1
//! and reads the head back out of this module's memory.

pub mod cv;
pub mod linalg;
pub mod rng;
pub mod train;

use train::{Data, Job, Opts};

static mut JOB: Option<Job> = None;
static mut RES: [f64; 16] = [0.0; 16];
// The temperature fit on its own, for the studio's tests: held-out logits
// (`rows × c`) and their true classes.
static mut TEMP_LOGITS: Vec<f32> = Vec::new();
static mut TEMP_LABELS: Vec<i32> = Vec::new();

#[allow(static_mut_refs)]
fn job() -> Option<&'static mut Job> {
    // SAFETY: a worker's WebAssembly is single-threaded and every entry point
    // runs to completion before the next one is called.
    unsafe { JOB.as_mut() }
}

/// FNV-1a of src/*.rs (build.rs), so a stale committed binary fails a test.
#[no_mangle]
pub extern "C" fn tr_src_hash() -> u32 {
    env!("TRAINER_SRC_HASH").parse().unwrap_or(0)
}

/// A new job over `n` rows of `d` numbers and `c` classes (the previous one is
/// dropped). 1 on success.
#[no_mangle]
pub extern "C" fn tr_new(n: u32, d: u32, c: u32) -> u32 {
    unsafe {
        JOB = None;
    }
    let (n, d, c) = (n as usize, d as usize, c as usize);
    if n == 0 || d == 0 || c == 0 || n.checked_mul(d).is_none() {
        return 0;
    }
    unsafe {
        JOB = Some(Job::new(Data::new(n, d, c), Opts::linear()));
    }
    1
}

/// The row matrix (`n × d`, row-major) for the page to fill.
#[no_mangle]
pub extern "C" fn tr_x() -> *mut f32 {
    job().map_or(core::ptr::null_mut(), |j| j.data.x.as_mut_ptr())
}

/// Each row's class index.
#[no_mangle]
pub extern "C" fn tr_y() -> *mut i32 {
    job().map_or(core::ptr::null_mut(), |j| j.data.y.as_mut_ptr())
}

/// Each row's group (artist) for grouped folds, -1 for none.
#[no_mangle]
pub extern "C" fn tr_groups() -> *mut i32 {
    job().map_or(core::ptr::null_mut(), |j| j.data.groups.as_mut_ptr())
}

/// `kind` 0 linear, 1 dense layers. Anything out of range is clamped rather
/// than trusted: these come from a settings screen.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn tr_config(
    kind: u32,
    epochs: u32,
    lr: f64,
    l2: f64,
    batch: u32,
    folds: u32,
    proj: u32,
    bag: u32,
    hidden: u32,
    hidden2: u32,
    noise: f64,
    seed: u32,
    grouped: u32,
) {
    if let Some(j) = job() {
        let finite = |v: f64, lo: f64, hi: f64, dflt: f64| if v.is_finite() { v.clamp(lo, hi) } else { dflt };
        j.opt = Opts {
            kind: kind.min(1),
            epochs: (epochs as usize).clamp(1, 2000),
            lr: finite(lr, 1e-6, 1.0, 0.05) as f32,
            l2: finite(l2, 0.0, 1.0, 1e-4) as f32,
            batch: (batch as usize).clamp(1, 4096),
            folds: (folds as usize).clamp(2, 20),
            proj: (proj as usize).min(8192),
            bag: (bag as usize).clamp(1, 8),
            hidden: (hidden as usize).clamp(1, 4096),
            hidden2: (hidden2 as usize).min(4096),
            noise: finite(noise, 0.0, 10.0, 0.0) as f32,
            seed,
            grouped: grouped != 0,
        };
    }
}

/// 0 once started; otherwise why not (train::StartError), or -1 with no job.
#[no_mangle]
pub extern "C" fn tr_start() -> i32 {
    match job() {
        Some(j) => match j.start() {
            Ok(()) => 0,
            Err(e) => e as i32,
        },
        None => -1,
    }
}

/// Up to `epochs` more epochs; the progress in [0, 1], 1 when finished.
#[no_mangle]
pub extern "C" fn tr_step(epochs: u32) -> f64 {
    match job() {
        Some(j) => j.step(epochs as usize),
        None => 1.0,
    }
}

/// The outcome's scalars: 0 kind, 1 folds, 2 projected, 3 bagged, 4 accuracy,
/// 5 balanced, 6 temperature, 7 retried, 8 evaluated, 9 layer count.
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn tr_res() -> *const f64 {
    unsafe {
        RES = [0.0; 16];
        if let Some(o) = job().and_then(|j| j.outcome.as_ref()) {
            RES[0] = o.kind as f64;
            RES[1] = o.folds as f64;
            RES[2] = o.projected as f64;
            RES[3] = o.bagged as f64;
            RES[4] = o.accuracy;
            RES[5] = o.balanced;
            RES[6] = o.temperature;
            RES[7] = if o.retried { 1.0 } else { 0.0 };
            RES[8] = o.evaluated as f64;
            RES[9] = o.layers.len() as f64;
        }
        RES.as_ptr()
    }
}

/// The held-out confusion matrix, `c × c`, true class by row.
#[no_mangle]
pub extern "C" fn tr_conf() -> *const i32 {
    job().and_then(|j| j.outcome.as_ref()).map_or(core::ptr::null(), |o| o.confusion.as_ptr())
}

fn layer(l: u32) -> Option<&'static train::Layer> {
    job().and_then(|j| j.outcome.as_ref()).and_then(|o| o.layers.get(l as usize))
}

#[no_mangle]
pub extern "C" fn tr_rows(l: u32) -> u32 {
    layer(l).map_or(0, |x| x.rows as u32)
}

#[no_mangle]
pub extern "C" fn tr_cols(l: u32) -> u32 {
    layer(l).map_or(0, |x| x.cols as u32)
}

#[no_mangle]
pub extern "C" fn tr_w(l: u32) -> *const f32 {
    layer(l).map_or(core::ptr::null(), |x| x.w.as_ptr())
}

#[no_mangle]
pub extern "C" fn tr_b(l: u32) -> *const f32 {
    layer(l).map_or(core::ptr::null(), |x| x.b.as_ptr())
}

/// Room for `rows` held-out logit vectors of `c` classes; returns where the
/// page writes them (the labels go to `tr_temp_labels`).
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn tr_temp_logits(rows: u32, c: u32) -> *mut f32 {
    unsafe {
        TEMP_LOGITS = vec![0.0; rows as usize * c as usize];
        TEMP_LABELS = vec![0; rows as usize];
        TEMP_LOGITS.as_mut_ptr()
    }
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn tr_temp_labels() -> *mut i32 {
    unsafe { TEMP_LABELS.as_mut_ptr() }
}

/// The temperature the trainer would fit on those (cv::temperature).
#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn tr_temperature(rows: u32, c: u32) -> f64 {
    unsafe {
        let (rows, c) = (rows as usize, c as usize);
        if TEMP_LOGITS.len() < rows * c || TEMP_LABELS.len() < rows || TEMP_LABELS[..rows].iter().any(|&v| v < 0 || v as usize >= c) {
            return 1.0;
        }
        cv::temperature(&TEMP_LOGITS[..rows * c], &TEMP_LABELS[..rows], c)
    }
}

/// Drop the job and everything it holds.
#[no_mangle]
pub extern "C" fn tr_free() {
    unsafe {
        JOB = None;
    }
}

#[cfg(test)]
mod tests {
    use super::cv;
    use super::rng::Rng;
    use super::train::{Data, Job, Opts};

    fn clusters(c: usize, per: usize, d: usize, noise: f32, seed: u32, artists_per_class: usize) -> Data {
        let mut r = Rng::new(seed);
        let centres: Vec<Vec<f32>> = (0..c).map(|_| (0..d).map(|_| (r.next() * 2.0 - 1.0) as f32).collect()).collect();
        let n = c * per;
        let mut data = Data::new(n, d, c);
        for k in 0..c {
            for j in 0..per {
                let i = k * per + j;
                for t in 0..d {
                    data.x[i * d + t] = centres[k][t] + ((r.next() * 2.0 - 1.0) as f32) * noise;
                }
                data.y[i] = k as i32;
                data.groups[i] = (k * artists_per_class + j % artists_per_class) as i32;
            }
        }
        data
    }

    #[test]
    fn grouped_folds_never_split_an_artist() {
        let data = clusters(4, 12, 8, 0.1, 3, 3);
        let mut r = Rng::new(9);
        let (assign, folds) = cv::grouped(&data.y, &data.groups, 4, 5, &mut r);
        assert_eq!(folds, 5);
        for g in 0..12 {
            let f: Vec<i32> = (0..data.n).filter(|&i| data.groups[i] == g).map(|i| assign[i]).collect();
            assert!(f.windows(2).all(|w| w[0] == w[1]), "artist {g} split across folds {f:?}");
        }
        // Every fold holds something out.
        for f in 0..folds as i32 {
            assert!(assign.iter().any(|&a| a == f));
        }
    }

    #[test]
    fn a_linear_head_learns_clusters() {
        let data = clusters(5, 16, 64, 0.2, 7, 4);
        let mut o = Opts::linear();
        o.proj = 0;
        o.epochs = 30;
        let mut job = Job::new(data, o);
        job.start().unwrap();
        job.finish();
        let out = job.outcome.unwrap();
        assert!(out.balanced > 0.95, "balanced {}", out.balanced);
        assert_eq!(out.evaluated, 80);
    }

    #[test]
    fn a_seed_repeats_a_run_exactly() {
        let run = || {
            let mut o = Opts::deep();
            o.hidden = 16;
            o.epochs = 10;
            let mut job = Job::new(clusters(3, 9, 16, 0.3, 5, 3), o);
            job.start().unwrap();
            job.finish();
            job.outcome.unwrap().layers[0].w.clone()
        };
        assert_eq!(run(), run());
    }
}

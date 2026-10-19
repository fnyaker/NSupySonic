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
            // Set apart by tr_pseudo, whichever is called first.
            pseudo: j.opt.pseudo,
        };
    }
}

/// Self-training: 0 off, else the probability a fold's head must give an
/// unlabelled row (class -1) before it learns from it (train::Opts::pseudo).
#[no_mangle]
pub extern "C" fn tr_pseudo(threshold: f64) {
    if let Some(j) = job() {
        j.opt.pseudo = if threshold.is_finite() { threshold.clamp(0.0, 0.999) as f32 } else { 0.0 };
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
/// 5 balanced, 6 temperature, 7 retried, 8 evaluated, 9 layer count,
/// 10 the fits' balanced accuracy on their own training rows, 11 the
/// self-trained head's held-out balanced accuracy (-1: not trained), 12 how
/// many pool rows the shipped head learnt from.
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
            RES[10] = o.fit_balanced;
            RES[11] = o.pseudo_balanced;
            RES[12] = o.pseudo_rows as f64;
        }
        RES.as_ptr()
    }
}

/// The held-out confusion matrix, `c × c`, true class by row.
#[no_mangle]
pub extern "C" fn tr_conf() -> *const i32 {
    job().and_then(|j| j.outcome.as_ref()).map_or(core::ptr::null(), |o| o.confusion.as_ptr())
}

/// Every row's held-out logits, `n × c` (before the temperature).
#[no_mangle]
pub extern "C" fn tr_held() -> *const f32 {
    job().and_then(|j| j.outcome.as_ref()).map_or(core::ptr::null(), |o| o.held.as_ptr())
}

/// 1 where a row was held out by some fold (its logits in `tr_held` mean
/// something), 0 where no fold could test it.
#[no_mangle]
pub extern "C" fn tr_held_mask() -> *const u8 {
    job().and_then(|j| j.outcome.as_ref()).map_or(core::ptr::null(), |o| o.held_mask.as_ptr())
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

    #[test]
    fn the_fit_on_training_rows_exposes_memorising() {
        // Labels with no relation to the rows: 6 classes over 60 points of
        // pure noise in 256 dimensions, where a linear head can fit anything.
        // It must read near chance held out and near perfect on what it trained
        // on — that gap is the overfitting the studio reports.
        let mut data = clusters(6, 10, 256, 0.0, 11, 5);
        let mut r = Rng::new(4);
        for v in data.x.iter_mut() {
            *v = (r.next() * 2.0 - 1.0) as f32;
        }
        let mut o = Opts::linear();
        o.proj = 0;
        o.epochs = 80;
        let mut job = Job::new(data, o);
        job.start().unwrap();
        job.finish();
        let out = job.outcome.unwrap();
        assert!(out.fit_balanced > 0.95, "fit {}", out.fit_balanced);
        assert!(out.balanced < 0.4, "held out {}", out.balanced);
        // ...and every row was held out once, its logits kept.
        assert!(out.held_mask.iter().all(|&m| m == 1));
        assert_eq!(out.held.len(), 60 * 6);
    }

    #[test]
    fn separable_data_has_no_gap() {
        let data = clusters(5, 16, 64, 0.2, 7, 4);
        let mut o = Opts::linear();
        o.proj = 0;
        o.epochs = 30;
        let mut job = Job::new(data, o);
        job.start().unwrap();
        job.finish();
        let out = job.outcome.unwrap();
        assert!(out.fit_balanced - out.balanced < 0.05, "fit {} held {}", out.fit_balanced, out.balanced);
    }

    /// `labelled` rows per class plus `pool` unlabelled ones (class -1) drawn
    /// from the same clusters; the pool's true classes are returned too.
    fn with_pool(c: usize, labelled: usize, pool: usize, d: usize, noise: f32, seed: u32) -> (Data, Vec<i32>) {
        let per = labelled + pool / c;
        let full = clusters(c, per, d, noise, seed, per);
        let n = c * per;
        let mut data = Data::new(n, d, c);
        data.x.copy_from_slice(&full.x);
        let mut truth = vec![0; n];
        for i in 0..n {
            truth[i] = full.y[i];
            let j = i % per;
            data.y[i] = if j < labelled { full.y[i] } else { -1 };
            data.groups[i] = full.groups[i];
        }
        (data, truth)
    }

    fn pool_accuracy(out: &super::train::Outcome, data: &Data, truth: &[i32]) -> f64 {
        let l = &out.layers[0];
        let (c, d) = (l.rows, l.cols);
        let (mut ok, mut all) = (0, 0);
        for i in 0..data.n {
            if data.y[i] >= 0 {
                continue;
            }
            let x = &data.x[i * d..(i + 1) * d];
            let mut best = (f32::NEG_INFINITY, 0);
            for k in 0..c {
                let v: f32 = l.w[k * d..(k + 1) * d].iter().zip(x).map(|(a, b)| a * b).sum::<f32>() + l.b[k];
                if v > best.0 {
                    best = (v, k);
                }
            }
            all += 1;
            ok += (best.1 as i32 == truth[i]) as i32;
        }
        ok as f64 / all as f64
    }

    fn run(data: &Data, pseudo: f32) -> super::train::Outcome {
        let mut o = Opts::linear();
        o.proj = 0;
        o.pseudo = pseudo;
        let mut job = Job::new(clone_data(data), o);
        job.start().unwrap();
        job.finish();
        job.outcome.unwrap()
    }

    #[test]
    fn unlabelled_rows_change_nothing_when_self_training_is_off() {
        let (data, _) = with_pool(5, 8, 200, 32, 2.0, 3);
        let mut bare = Data::new(40, 32, 5);
        let mut k = 0;
        for i in 0..data.n {
            if data.y[i] >= 0 {
                bare.x[k * 32..(k + 1) * 32].copy_from_slice(&data.x[i * 32..(i + 1) * 32]);
                bare.y[k] = data.y[i];
                bare.groups[k] = data.groups[i];
                k += 1;
            }
        }
        let (a, b) = (run(&data, 0.0), run(&bare, 0.0));
        assert_eq!(a.layers[0].w, b.layers[0].w);
        assert_eq!(a.balanced, b.balanced);
        assert_eq!((a.pseudo_balanced, a.pseudo_rows), (-1.0, 0));
    }

    #[test]
    fn the_self_trained_head_ships_only_on_a_held_out_gain() {
        // The teacher's fits all run before any self-trained one, so a run whose
        // second head did not earn its place ships the first, bit for bit.
        for seed in 1..=10u32 {
            let (data, _) = with_pool(6, 4, 600, 64, 3.0, seed);
            let (t, s) = (run(&data, 0.0), run(&data, 0.9));
            assert!(s.pseudo_balanced >= 0.0);
            if s.pseudo_rows > 0 {
                assert!(s.balanced >= t.balanced + 0.01 - 1e-9, "seed {seed}: {} vs {}", s.balanced, t.balanced);
                assert_eq!(s.balanced, s.pseudo_balanced);
            } else {
                assert_eq!(s.layers[0].w, t.layers[0].w, "seed {seed}");
                assert_eq!(s.balanced, t.balanced);
            }
        }
    }

    #[test]
    fn self_training_helps_where_the_labels_are_few() {
        // Six overlapping clusters, four tags each, 600 untagged rows from the
        // same clusters; scored on those rows' TRUE classes, which neither head
        // ever saw. Measured over ten seeds (ratio 3, weight 0.5): labels alone
        // 0.537, shipped 0.625; at eight tags and more noise the two agree to a
        // point (0.404 / 0.413) — it is a few-labels tool, and it is gated.
        let (mut t_pool, mut s_pool) = (0.0, 0.0);
        for seed in 1..=10u32 {
            let (data, truth) = with_pool(6, 4, 600, 64, 3.0, seed);
            t_pool += pool_accuracy(&run(&data, 0.0), &data, &truth);
            s_pool += pool_accuracy(&run(&data, 0.9), &data, &truth);
        }
        assert!(s_pool / 10.0 >= t_pool / 10.0 + 0.05, "labels only {:.3}, shipped {:.3}", t_pool / 10.0, s_pool / 10.0);
    }

    #[test]
    fn a_dense_stack_self_trains_too() {
        let (data, truth) = with_pool(4, 6, 200, 16, 1.5, 2);
        let mut o = Opts::deep();
        o.hidden = 16;
        o.epochs = 20;
        o.pseudo = 0.9;
        let mut job = Job::new(clone_data(&data), o);
        job.start().unwrap();
        job.finish();
        let out = job.outcome.unwrap();
        assert!(out.pseudo_balanced >= 0.0);
        assert_eq!(out.layers.len(), 2);
        assert!(out.held_mask.iter().zip(&data.y).all(|(&m, &y)| (m == 1) == (y >= 0)));
        let _ = truth;
    }

    #[test]
    #[ignore]
    fn measure_self_training() {
        for &(lab, noise) in &[(4usize, 3.0f32), (4, 4.5), (8, 4.5), (8, 6.0), (16, 6.0)] {
            let (mut t_pool, mut s_pool, mut t_held, mut s_held, mut shipped) = (0.0, 0.0, 0.0, 0.0, 0);
            for seed in 1..=10u32 {
                let (data, truth) = with_pool(6, lab, 600, 64, noise, seed);
                let (t, s) = (run(&data, 0.0), run(&data, 0.9));
                t_pool += pool_accuracy(&t, &data, &truth);
                s_pool += pool_accuracy(&s, &data, &truth);
                t_held += t.balanced;
                s_held += s.pseudo_balanced;
                shipped += (s.pseudo_rows > 0) as i32;
            }
            println!("lab {lab} noise {noise}: held teacher {:.3} student {:.3} | unseen: labels-only {:.3} shipped {:.3} | student shipped {shipped}/10",
                t_held / 10.0, s_held / 10.0, t_pool / 10.0, s_pool / 10.0);
        }
    }

    fn clone_data(d: &Data) -> Data {
        let mut o = Data::new(d.n, d.d, d.c);
        o.x.copy_from_slice(&d.x);
        o.y.copy_from_slice(&d.y);
        o.groups.copy_from_slice(&d.groups);
        o
    }
}

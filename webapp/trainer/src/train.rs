//! The two heads the genre studio trains over the frozen embedding — a softmax
//! plane (`linear`) and a stack of dense layers (`mlp`, one or two hidden) —
//! and the run around them: folds, bags, the projection, the temperature, the
//! confusion matrix. It used to be two JavaScript files and a C kernel
//! (test/reference/genre-*.js keep them, as the oracle this is held to).
//!
//! It runs in STEPS of whole epochs (`Job::step`) so the worker can report
//! progress between them, and it is seeded: the folds, every shuffle and every
//! initialisation come from one generator, so a run can be repeated exactly.

use crate::cv;
use crate::linalg::{adam, axpy, axpy4, dot, dot4, forward, unproject};
use crate::rng::Rng;
use std::collections::VecDeque;

/// A cross-validated balanced accuracy under this, after training in the
/// projected space, is weak enough that the projection is worth ruling out:
/// the linear run is repeated at full width and the better model ships.
const RETRY_BELOW: f64 = 0.8;
/// Below this many examples (or three per class) a bag of several fits is a
/// bag of near-identical ones, and collapses to one.
const BAG_MIN_EXAMPLES: usize = 12;
/// An output error this small is exactly nothing. Measured, it is the
/// difference between 1 GMAC/s and 8: once the head is sure, the softmax gives
/// the wrong classes probabilities near 1e-40, which are SUBNORMAL in f32, and
/// every multiply-add touching a subnormal takes the processor's slow path
/// (the JavaScript computed these in f64 and never met them). Nothing is lost
/// by dropping them: each parameter's gradient also carries its L2 term, around
/// 1e-5, so a 1e-20 contribution was already below f32's resolution of it.
const TINY: f32 = 1e-20;

#[inline]
fn flush(g: f32) -> f32 {
    if g.abs() < TINY {
        0.0
    } else {
        g
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Opts {
    /// 0 linear, 1 a stack of dense layers.
    pub kind: u32,
    pub epochs: usize,
    pub lr: f32,
    pub l2: f32,
    pub batch: usize,
    pub folds: usize,
    /// Random projection width, 0 for none.
    pub proj: usize,
    /// Linear only: fits averaged into the shipped head (and into each fold's
    /// held-out verdict).
    pub bag: usize,
    pub hidden: usize,
    pub hidden2: usize,
    /// Linear only: gaussian noise on the TRAINING rows, as a fraction of the
    /// embedding's scale. Off unless asked for.
    pub noise: f32,
    pub seed: u32,
    /// Hold out whole groups (artists) rather than rows.
    pub grouped: bool,
}

impl Opts {
    pub fn linear() -> Opts {
        Opts { kind: 0, epochs: 60, lr: 0.08, l2: 1e-4, batch: 32, folds: 5, proj: 256, bag: 3, hidden: 0, hidden2: 0, noise: 0.0, seed: 1, grouped: false }
    }
    pub fn deep() -> Opts {
        Opts { kind: 1, epochs: 120, lr: 0.02, l2: 3e-4, batch: 32, folds: 3, proj: 0, bag: 1, hidden: 256, hidden2: 0, noise: 0.0, seed: 1, grouped: false }
    }
}

pub struct Data {
    pub n: usize,
    pub d: usize,
    pub c: usize,
    pub x: Vec<f32>,
    pub y: Vec<i32>,
    pub groups: Vec<i32>,
}

impl Data {
    pub fn new(n: usize, d: usize, c: usize) -> Data {
        Data { n, d, c, x: vec![0.0; n * d], y: vec![0; n], groups: vec![-1; n] }
    }
}

/// Why a run could not start (the codes the page turns into sentences).
#[derive(Debug, PartialEq)]
pub enum StartError {
    TooFewLinear = 1,
    TooFewDeep = 2,
    BadData = 3,
    TooFewClasses = 4,
}

/// One output layer: `rows × cols` weights, row-major, and `rows` biases.
pub struct Layer {
    pub rows: usize,
    pub cols: usize,
    pub w: Vec<f32>,
    pub b: Vec<f32>,
}

pub struct Outcome {
    /// 0 linear, 1 one hidden layer, 2 two.
    pub kind: u32,
    pub layers: Vec<Layer>,
    pub confusion: Vec<i32>,
    pub folds: usize,
    pub projected: usize,
    pub bagged: usize,
    pub accuracy: f64,
    pub balanced: f64,
    pub temperature: f64,
    pub retried: bool,
    pub evaluated: usize,
}

// --- the space a run trains in -------------------------------------------------

struct Space {
    dim: usize,
    /// The rows in this space, or None for the data's own rows.
    z: Option<Vec<f32>>,
    /// Noisy copies of the rows, for training only.
    ztr: Option<Vec<f32>>,
    p: Option<Vec<f32>>,
}

impl Space {
    fn new(data: &Data, proj: usize, noise: f32, rng: &mut Rng) -> Space {
        let (n, d) = (data.n, data.d);
        let use_proj = proj > 0 && (d as f64) > proj as f64 * 1.5;
        let (z, p, dim) = if use_proj {
            let k = proj;
            let mut prng = Rng::new((rng.next() * 4_294_967_296.0) as u32);
            let scale = 1.0 / (k as f64).sqrt();
            let p: Vec<f32> = (0..k * d).map(|_| (prng.gauss() * scale) as f32).collect();
            // Blocked over rows, so each projection row is read once per block
            // of examples rather than once per example.
            let mut z = vec![0f32; n * k];
            const BLOCK: usize = 32;
            let mut i0 = 0;
            while i0 < n {
                let i1 = (i0 + BLOCK).min(n);
                for c in 0..k {
                    let pr = &p[c * d..(c + 1) * d];
                    for i in i0..i1 {
                        z[i * k + c] = dot(pr, &data.x[i * d..(i + 1) * d]);
                    }
                }
                i0 = i1;
            }
            (Some(z), Some(p), k)
        } else {
            (None, None, d)
        };
        let ztr = if noise > 0.0 {
            let mut nrng = Rng::new((rng.next() * 4_294_967_296.0) as u32);
            let mut out = z.clone().unwrap_or_else(|| data.x.clone());
            for v in out.iter_mut() {
                *v += (nrng.gauss() * noise as f64) as f32;
            }
            Some(out)
        } else {
            None
        };
        Space { dim, z, ztr, p }
    }

    #[inline]
    fn row<'a>(&'a self, data: &'a Data, i: usize) -> &'a [f32] {
        let src = self.z.as_deref().unwrap_or(&data.x);
        &src[i * self.dim..(i + 1) * self.dim]
    }

    #[inline]
    fn train_row<'a>(&'a self, data: &'a Data, i: usize) -> &'a [f32] {
        match &self.ztr {
            Some(t) => &t[i * self.dim..(i + 1) * self.dim],
            None => self.row(data, i),
        }
    }
}

/// Inverse-frequency class weights over `rows`, normalised so they sum to the
/// class count (the learning rate keeps meaning the same whatever the balance).
fn class_weights(y: &[i32], rows: &[u32], c: usize) -> Vec<f32> {
    let mut counts = vec![0f32; c];
    for &i in rows {
        counts[y[i as usize] as usize] += 1.0;
    }
    let n = rows.len() as f32;
    let mut cw = vec![0f32; c];
    let mut sum = 0f32;
    for k in 0..c {
        cw[k] = if counts[k] > 0.0 { n / (c as f32 * counts[k]) } else { 0.0 };
        sum += cw[k];
    }
    let norm = c as f32 / if sum != 0.0 { sum } else { 1.0 };
    for v in cw.iter_mut() {
        *v *= norm;
    }
    cw
}

/// Softmax of `logits` into `p` (f64), max-subtracted.
fn softmax(logits: &[f32], p: &mut [f64]) {
    let mut top = f64::NEG_INFINITY;
    for &v in logits {
        if (v as f64) > top {
            top = v as f64;
        }
    }
    let mut sum = 0.0;
    for (k, &v) in logits.iter().enumerate() {
        p[k] = (v as f64 - top).exp();
        sum += p[k];
    }
    let inv = 1.0 / if sum != 0.0 { sum } else { 1.0 };
    for v in p.iter_mut() {
        *v *= inv;
    }
}

// --- a linear fit ----------------------------------------------------------------
//
// Both fits work a MINIBATCH at a time and loop class-major (or unit-major)
// inside it: each weight row is read once per batch and dotted with every
// example of the batch while it sits in the cache, and each gradient row takes
// the whole batch's contribution the same way. The per-example loop the
// JavaScript had re-read the whole weight matrix for every example — 300 KB for
// thirty genres over the full embedding, several MB for a hidden layer — and was
// bound by memory, not arithmetic. The sums are the same sums in the same order
// (the weights only move at the end of a batch), so the result is identical.

struct LinFit {
    w: Vec<f32>,
    b: Vec<f32>,
    mw: Vec<f32>,
    vw: Vec<f32>,
    mb: Vec<f32>,
    vb: Vec<f32>,
    gw: Vec<f32>,
    gb: Vec<f32>,
    /// The batch's logits, then its output errors, `batch × c`.
    lg: Vec<f32>,
    p: Vec<f64>,
    /// The batch's non-zero errors for one class: (error, example).
    nz: Vec<(f32, usize)>,
    cw: Vec<f32>,
    order: Vec<u32>,
    t: i32,
}

/// y += Σ g·row(k) over `terms`, in order, four rows per pass over `y`.
#[inline]
fn accumulate<'a>(y: &mut [f32], terms: &[(f32, usize)], row: impl Fn(usize) -> &'a [f32]) {
    let mut j = 0;
    while j + 4 <= terms.len() {
        let (t0, t1, t2, t3) = (terms[j], terms[j + 1], terms[j + 2], terms[j + 3]);
        axpy4(y, [t0.0, t1.0, t2.0, t3.0], row(t0.1), row(t1.1), row(t2.1), row(t3.1));
        j += 4;
    }
    while j < terms.len() {
        axpy(y, terms[j].0, row(terms[j].1));
        j += 1;
    }
}

impl LinFit {
    fn new(dim: usize, c: usize, rows: &[u32], y: &[i32], batch: usize) -> LinFit {
        LinFit {
            w: vec![0.0; c * dim],
            b: vec![0.0; c],
            mw: vec![0.0; c * dim],
            vw: vec![0.0; c * dim],
            mb: vec![0.0; c],
            vb: vec![0.0; c],
            gw: vec![0.0; c * dim],
            gb: vec![0.0; c],
            lg: vec![0.0; batch.max(1) * c],
            p: vec![0.0; c],
            nz: Vec::with_capacity(batch.max(1)),
            cw: class_weights(y, rows, c),
            order: rows.to_vec(),
            t: 0,
        }
    }

    fn epoch(&mut self, data: &Data, sp: &Space, o: &Opts, rng: &mut Rng) {
        let (dim, c) = (sp.dim, data.c);
        rng.shuffle(&mut self.order);
        let len = self.order.len();
        let mut start = 0;
        while start < len {
            let end = (start + o.batch.max(1)).min(len);
            let rows = &self.order[start..end];
            // Forward: every class row against every example of the batch,
            // four examples per read of the row.
            let bsz = rows.len();
            let row = |k: usize| sp.train_row(data, rows[k] as usize);
            for cl in 0..c {
                let wr = &self.w[cl * dim..(cl + 1) * dim];
                let bc = self.b[cl];
                let mut k = 0;
                while k + 4 <= bsz {
                    let r4 = dot4(wr, row(k), row(k + 1), row(k + 2), row(k + 3));
                    for j in 0..4 {
                        self.lg[(k + j) * c + cl] = r4[j] + bc;
                    }
                    k += 4;
                }
                while k < bsz {
                    self.lg[k * c + cl] = dot(wr, row(k)) + bc;
                    k += 1;
                }
            }
            // The softmax error, weighted by the example's class.
            let mut wsum = 0f32;
            for (k, &i) in rows.iter().enumerate() {
                let lg = &mut self.lg[k * c..(k + 1) * c];
                softmax(lg, &mut self.p);
                let yi = data.y[i as usize] as usize;
                let wt = self.cw[yi];
                wsum += wt;
                for cl in 0..c {
                    lg[cl] = flush((wt as f64 * (self.p[cl] - if cl == yi { 1.0 } else { 0.0 })) as f32);
                }
            }
            // Gradient: every class row takes the whole batch, four examples
            // per pass over the row (the same additions in the same order).
            for cl in 0..c {
                self.nz.clear();
                for k in 0..bsz {
                    let g = self.lg[k * c + cl];
                    if g != 0.0 {
                        self.nz.push((g, k));
                    }
                }
                let gr = &mut self.gw[cl * dim..(cl + 1) * dim];
                accumulate(gr, &self.nz, row);
                for &(g, _) in &self.nz {
                    self.gb[cl] += g;
                }
            }
            let inv = 1.0 / if wsum != 0.0 { wsum } else { 1.0 };
            self.t += 1;
            let bc1 = (1.0 - 0.9f64.powi(self.t)) as f32;
            let bc2 = (1.0 - 0.999f64.powi(self.t)) as f32;
            adam(&mut self.w, &mut self.mw, &mut self.vw, &mut self.gw, inv, o.lr, o.l2, bc1, bc2);
            adam(&mut self.b, &mut self.mb, &mut self.vb, &mut self.gb, inv, o.lr, 0.0, bc1, bc2);
            start = end;
        }
    }
}

// --- a stack of dense layers -----------------------------------------------------

struct Dense {
    out: usize,
    inp: usize,
    w: Vec<f32>,
    b: Vec<f32>,
    gw: Vec<f32>,
    gb: Vec<f32>,
    mw: Vec<f32>,
    vw: Vec<f32>,
    mb: Vec<f32>,
    vb: Vec<f32>,
}

struct Net {
    layers: Vec<Dense>,
    batch: usize,
    /// Each layer's output for every example of the batch, `batch × out`
    /// (relu'd for the hidden layers; the last is the logits).
    acts: Vec<Vec<f32>>,
    /// The error arriving at each layer's output, same shape.
    delta: Vec<Vec<f32>>,
    p: Vec<f64>,
    nz: Vec<(f32, usize)>,
}

impl Net {
    fn new(widths: &[usize], batch: usize, rng: &mut Rng) -> Net {
        let batch = batch.max(1);
        let mut layers = Vec::new();
        for i in 1..widths.len() {
            let (out, inp) = (widths[i], widths[i - 1]);
            // He initialisation: a relu layer started from a uniform scale
            // either dies or saturates, and the first epochs are wasted.
            let s = (2.0 / inp as f64).sqrt();
            let w: Vec<f32> = (0..out * inp).map(|_| (rng.gauss() * s) as f32).collect();
            layers.push(Dense {
                out,
                inp,
                w,
                b: vec![0.0; out],
                gw: vec![0.0; out * inp],
                gb: vec![0.0; out],
                mw: vec![0.0; out * inp],
                vw: vec![0.0; out * inp],
                mb: vec![0.0; out],
                vb: vec![0.0; out],
            });
        }
        let acts = layers.iter().map(|l| vec![0f32; batch * l.out]).collect();
        let delta = layers.iter().map(|l| vec![0f32; batch * l.out]).collect();
        let c = widths[widths.len() - 1];
        let widest = widths.iter().copied().max().unwrap_or(1).max(batch);
        Net { layers, batch, acts, delta, p: vec![0.0; c], nz: Vec::with_capacity(widest) }
    }

    /// Forward the examples `rows` (at most `batch`), leaving every
    /// activation in `acts`.
    fn forward(&mut self, rows: &[u32], data: &Data, sp: &Space, train: bool) {
        let nl = self.layers.len();
        let bsz = rows.len();
        for l in 0..nl {
            let (before, rest) = self.acts.split_at_mut(l);
            let out = &mut rest[0];
            let layer = &self.layers[l];
            let (lo, li) = (layer.out, layer.inp);
            let input = |k: usize| -> &[f32] {
                if l == 0 {
                    let i = rows[k] as usize;
                    if train { sp.train_row(data, i) } else { sp.row(data, i) }
                } else {
                    &before[l - 1][k * li..(k + 1) * li]
                }
            };
            for r in 0..lo {
                let wr = &layer.w[r * li..(r + 1) * li];
                let br = layer.b[r];
                let mut k = 0;
                while k + 4 <= bsz {
                    let r4 = dot4(wr, input(k), input(k + 1), input(k + 2), input(k + 3));
                    for j in 0..4 {
                        out[(k + j) * lo + r] = r4[j] + br;
                    }
                    k += 4;
                }
                while k < bsz {
                    out[k * lo + r] = dot(wr, input(k)) + br;
                    k += 1;
                }
            }
            if l + 1 < nl {
                for v in out[..bsz * lo].iter_mut() {
                    if *v < 0.0 {
                        *v = 0.0;
                    }
                }
            }
        }
    }

    /// The logits of example `k` of the last forward.
    fn logits(&self, k: usize) -> &[f32] {
        let last = self.layers.len() - 1;
        let c = self.layers[last].out;
        &self.acts[last][k * c..(k + 1) * c]
    }

    /// Backward from the output errors already in `delta[last]`, accumulating
    /// every layer's gradient over the batch.
    fn backward(&mut self, rows: &[u32], data: &Data, sp: &Space) {
        let nl = self.layers.len();
        let bsz = rows.len();
        for l in (0..nl).rev() {
            let (dlo, dhi) = self.delta.split_at_mut(l);
            let g = &dhi[0];
            let layer = &mut self.layers[l];
            let (lo, li) = (layer.out, layer.inp);
            let acts = &self.acts;
            let a_prev = |k: usize| -> &[f32] {
                if l == 0 { sp.train_row(data, rows[k] as usize) } else { &acts[l - 1][k * li..(k + 1) * li] }
            };
            let nz = &mut self.nz;
            for r in 0..lo {
                nz.clear();
                for k in 0..bsz {
                    let gr = g[k * lo + r];
                    if gr != 0.0 {
                        nz.push((gr, k));
                    }
                }
                accumulate(&mut layer.gw[r * li..(r + 1) * li], nz, a_prev);
                for &(gr, _) in nz.iter() {
                    layer.gb[r] += gr;
                }
            }
            if l > 0 {
                let dprev = &mut dlo[l - 1];
                // The error sent down to each example: Σ_r g_r · W_r, in r order,
                // four weight rows per pass over the example's error.
                let w = &layer.w;
                let wrow = |r: usize| -> &[f32] { &w[r * li..(r + 1) * li] };
                for k in 0..bsz {
                    nz.clear();
                    for r in 0..lo {
                        let gr = g[k * lo + r];
                        if gr != 0.0 {
                            nz.push((gr, r));
                        }
                    }
                    let dk = &mut dprev[k * li..(k + 1) * li];
                    dk.iter_mut().for_each(|v| *v = 0.0);
                    accumulate(dk, nz, wrow);
                }
                let h = &self.acts[l - 1];
                for (d, &a) in dprev[..bsz * li].iter_mut().zip(h[..bsz * li].iter()) {
                    if a <= 0.0 || d.abs() < TINY {
                        *d = 0.0;
                    }
                }
            }
        }
    }
}

struct MlpFit {
    net: Net,
    order: Vec<u32>,
    t: i32,
    epoch: usize,
}

impl MlpFit {
    fn epoch(&mut self, data: &Data, sp: &Space, o: &Opts, cw: &[f32], rng: &mut Rng) {
        let c = data.c;
        // Cosine decay to a quarter of the rate: a big net trains fast at first
        // and then needs to settle.
        let lr = (o.lr as f64
            * (0.25 + 0.75 * (0.5 + 0.5 * (core::f64::consts::PI * self.epoch as f64 / o.epochs.max(1) as f64).cos())))
            as f32;
        rng.shuffle(&mut self.order);
        let len = self.order.len();
        let last = self.net.layers.len() - 1;
        let batch = self.net.batch;
        let mut start = 0;
        while start < len {
            let end = (start + batch).min(len);
            let rows = &self.order[start..end];
            self.net.forward(rows, data, sp, true);
            let mut wsum = 0f32;
            {
                let Net { acts, delta, p, .. } = &mut self.net;
                for (k, &i) in rows.iter().enumerate() {
                    softmax(&acts[last][k * c..(k + 1) * c], p);
                    let yi = data.y[i as usize] as usize;
                    let wt = cw[yi];
                    wsum += wt;
                    for cl in 0..c {
                        delta[last][k * c + cl] = flush((wt as f64 * (p[cl] - if cl == yi { 1.0 } else { 0.0 })) as f32);
                    }
                }
            }
            self.net.backward(rows, data, sp);
            self.t += 1;
            let scale = 1.0 / if wsum != 0.0 { wsum } else { 1.0 };
            let bc1 = (1.0 - 0.9f64.powi(self.t)) as f32;
            let bc2 = (1.0 - 0.999f64.powi(self.t)) as f32;
            for layer in self.net.layers.iter_mut() {
                adam(&mut layer.w, &mut layer.mw, &mut layer.vw, &mut layer.gw, scale, lr, o.l2, bc1, bc2);
                adam(&mut layer.b, &mut layer.mb, &mut layer.vb, &mut layer.gb, scale, lr, 0.0, bc1, bc2);
            }
            start = end;
        }
        self.epoch += 1;
    }
}

// --- the run ---------------------------------------------------------------------

enum Target {
    /// Held-out: the logits of these rows, averaged over `members` fits.
    Fold { test: Vec<u32>, members: usize },
    /// A member of the shipped head.
    Final { members: usize },
}

struct Task {
    rows: Vec<u32>,
    target: Target,
}

enum Fit {
    Lin(LinFit),
    Mlp(MlpFit),
}

struct Run {
    space: Space,
    tasks: VecDeque<Task>,
    cur: Option<(Task, Fit, usize)>,
    planned: usize,
    done: usize,
    held: Vec<f32>,
    held_mask: Vec<bool>,
    final_w: Vec<f32>,
    final_b: Vec<f32>,
    final_net: Option<Net>,
    final_members: usize,
}

pub struct Job {
    pub data: Data,
    pub opt: Opts,
    rng: Rng,
    assign: Vec<i32>,
    folds: usize,
    examples: Vec<usize>,
    widths: Vec<usize>,
    cw_all: Vec<f32>,
    run: Option<Run>,
    first: Option<Outcome>,
    retry_possible: bool,
    pub outcome: Option<Outcome>,
}

impl Job {
    pub fn new(data: Data, opt: Opts) -> Job {
        Job {
            data,
            opt,
            rng: Rng::new(opt.seed),
            assign: Vec::new(),
            folds: 0,
            examples: Vec::new(),
            widths: Vec::new(),
            cw_all: Vec::new(),
            run: None,
            first: None,
            retry_possible: false,
            outcome: None,
        }
    }

    fn bag_count(&self, rows: usize) -> usize {
        if self.opt.kind != 0 {
            return 1;
        }
        let want = self.opt.bag.clamp(1, 8);
        if want <= 1 || rows < BAG_MIN_EXAMPLES.max(self.data.c * 3) {
            return 1;
        }
        want
    }

    pub fn start(&mut self) -> Result<(), StartError> {
        // Seeded HERE, not at construction: the page configures a job after
        // creating it, and a generator seeded before that ignored the seed.
        self.rng = Rng::new(self.opt.seed);
        let (n, d, c) = (self.data.n, self.data.d, self.data.c);
        if c < 2 {
            return Err(StartError::TooFewClasses);
        }
        if d == 0 || self.data.x.len() != n * d || self.data.y.iter().any(|&v| v < 0 || v as usize >= c) {
            return Err(StartError::BadData);
        }
        if self.data.x.iter().any(|v| !v.is_finite()) {
            return Err(StartError::BadData);
        }
        if self.opt.kind == 0 && n < c * 2 {
            return Err(StartError::TooFewLinear);
        }
        if self.opt.kind != 0 && n < c * 3 {
            return Err(StartError::TooFewDeep);
        }
        self.examples = vec![0; c];
        for &k in &self.data.y {
            self.examples[k as usize] += 1;
        }
        let (assign, folds) = if self.opt.grouped {
            cv::grouped(&self.data.y, &self.data.groups, c, self.opt.folds, &mut self.rng)
        } else {
            cv::stratified(&self.data.y, c, self.opt.folds, &mut self.rng)
        };
        self.assign = assign;
        self.folds = folds;
        let all: Vec<u32> = (0..n as u32).collect();
        self.cw_all = class_weights(&self.data.y, &all, c);
        let proj = self.opt.proj;
        self.retry_possible = self.opt.kind == 0 && proj > 0 && (d as f64) > proj as f64 * 1.5;
        self.begin_run(proj);
        Ok(())
    }

    fn begin_run(&mut self, proj: usize) {
        let (n, c) = (self.data.n, self.data.c);
        let noise = if self.opt.kind == 0 { self.opt.noise.max(0.0) } else { 0.0 };
        let space = Space::new(&self.data, proj, noise, &mut self.rng);
        let dim = space.dim;
        self.widths = if self.opt.hidden2 > 0 {
            vec![dim, self.opt.hidden.max(1), self.opt.hidden2, c]
        } else {
            vec![dim, self.opt.hidden.max(1), c]
        };
        let mut tasks = VecDeque::new();
        for f in 0..self.folds {
            let mut train = Vec::new();
            let mut test = Vec::new();
            for i in 0..n {
                if self.assign[i] == f as i32 {
                    test.push(i as u32);
                } else {
                    train.push(i as u32);
                }
            }
            if train.is_empty() || test.is_empty() {
                continue;
            }
            let members = self.bag_count(train.len());
            for _ in 0..members {
                tasks.push_back(Task { rows: train.clone(), target: Target::Fold { test: test.clone(), members } });
            }
        }
        let members = self.bag_count(n);
        let all: Vec<u32> = (0..n as u32).collect();
        for _ in 0..members {
            tasks.push_back(Task { rows: all.clone(), target: Target::Final { members } });
        }
        let planned = tasks.len() * self.opt.epochs.max(1);
        self.run = Some(Run {
            space,
            tasks,
            cur: None,
            planned,
            done: 0,
            held: vec![0.0; n * c],
            held_mask: vec![false; n],
            final_w: if self.opt.kind == 0 { vec![0.0; c * dim] } else { Vec::new() },
            final_b: vec![0.0; c],
            final_net: None,
            final_members: members,
        });
    }

    /// Progress in [0, 1]; 1 once the outcome is ready.
    pub fn progress(&self) -> f64 {
        if self.outcome.is_some() {
            return 1.0;
        }
        let Some(run) = &self.run else { return 0.0 };
        let frac = run.done as f64 / run.planned.max(1) as f64;
        if !self.retry_possible {
            frac.min(0.999)
        } else if self.first.is_none() {
            0.5 * frac
        } else {
            (0.5 + 0.5 * frac).min(0.999)
        }
    }

    /// Up to `epochs` more epochs. Returns the progress.
    pub fn step(&mut self, epochs: usize) -> f64 {
        let mut budget = epochs.max(1);
        while budget > 0 && self.outcome.is_none() {
            if !self.advance() {
                break;
            }
            budget -= 1;
        }
        self.progress()
    }

    /// Run to the end (native tests and benches).
    pub fn finish(&mut self) {
        while self.outcome.is_none() {
            if !self.advance() {
                break;
            }
        }
    }

    /// One epoch of the current fit (starting or ending fits as needed).
    fn advance(&mut self) -> bool {
        let Some(run) = self.run.as_mut() else { return false };
        if run.cur.is_none() {
            match run.tasks.pop_front() {
                Some(task) => {
                    let fit = if self.opt.kind == 0 {
                        Fit::Lin(LinFit::new(run.space.dim, self.data.c, &task.rows, &self.data.y, self.opt.batch))
                    } else {
                        let net = Net::new(&self.widths, self.opt.batch, &mut self.rng);
                        Fit::Mlp(MlpFit { net, order: task.rows.clone(), t: 0, epoch: 0 })
                    };
                    run.cur = Some((task, fit, 0));
                }
                None => {
                    self.end_run();
                    return true;
                }
            }
        }
        let (_task, fit, ep) = run.cur.as_mut().unwrap();
        match fit {
            Fit::Lin(f) => f.epoch(&self.data, &run.space, &self.opt, &mut self.rng),
            Fit::Mlp(f) => f.epoch(&self.data, &run.space, &self.opt, &self.cw_all, &mut self.rng),
        }
        *ep += 1;
        run.done += 1;
        if *ep >= self.opt.epochs.max(1) {
            let (task, fit, _) = run.cur.take().unwrap();
            Self::close_fit(run, &self.data, task, fit);
        }
        true
    }

    fn close_fit(run: &mut Run, data: &Data, task: Task, fit: Fit) {
        let c = data.c;
        let dim = run.space.dim;
        match task.target {
            Target::Fold { test, members } => {
                // The held-out verdict is the AVERAGE of the fold's members, the
                // same object as the head that ships (itself an average). The
                // JavaScript summed them here while shipping the average, so the
                // temperature was fitted on logits `bag` times too large and the
                // shipped head came out that much too diffident — its good calls
                // then fell under the server's confidence gate.
                let inv = 1.0 / members as f32;
                match fit {
                    Fit::Lin(f) => {
                        let mut logits = vec![0f32; c];
                        for &i in &test {
                            let i = i as usize;
                            forward(&f.w, &f.b, run.space.row(data, i), &mut logits, c, dim);
                            axpy(&mut run.held[i * c..(i + 1) * c], inv, &logits);
                            run.held_mask[i] = true;
                        }
                    }
                    Fit::Mlp(mut m) => {
                        let batch = m.net.batch;
                        for chunk in test.chunks(batch) {
                            m.net.forward(chunk, data, &run.space, false);
                            for (k, &i) in chunk.iter().enumerate() {
                                let i = i as usize;
                                axpy(&mut run.held[i * c..(i + 1) * c], inv, m.net.logits(k));
                                run.held_mask[i] = true;
                            }
                        }
                    }
                }
            }
            Target::Final { members } => match fit {
                Fit::Lin(f) => {
                    let inv = 1.0 / members as f32;
                    axpy(&mut run.final_w, inv, &f.w);
                    axpy(&mut run.final_b, inv, &f.b);
                }
                Fit::Mlp(m) => run.final_net = Some(m.net),
            },
        }
    }

    fn end_run(&mut self) {
        let run = self.run.take().expect("a run to end");
        let (n, d, c) = (self.data.n, self.data.d, self.data.c);
        let dim = run.space.dim;
        let mut confusion = vec![0i32; c * c];
        let mut held = Vec::new();
        let mut held_y = Vec::new();
        for i in 0..n {
            if !run.held_mask[i] {
                continue;
            }
            let lg = &run.held[i * c..(i + 1) * c];
            let mut got = 0;
            for k in 1..c {
                if lg[k] > lg[got] {
                    got = k;
                }
            }
            let yi = self.data.y[i] as usize;
            confusion[yi * c + got] += 1;
            held.extend_from_slice(lg);
            held_y.push(yi as i32);
        }
        let (accuracy, balanced) = cv::scores(&confusion, &self.examples, c);
        let temperature = cv::temperature(&held, &held_y, c);
        let layers = if self.opt.kind == 0 {
            let w = match &run.space.p {
                Some(p) => unproject(&run.final_w, p, c, dim, d),
                None => run.final_w,
            };
            vec![Layer { rows: c, cols: d, w, b: run.final_b }]
        } else {
            let net = run.final_net.expect("the final fit");
            net.layers
                .into_iter()
                .enumerate()
                .map(|(l, layer)| match (&run.space.p, l) {
                    // The first layer is linear in its input, so a projection
                    // folds straight back into it: what ships is a plain MLP
                    // over the original embedding.
                    (Some(p), 0) => Layer { rows: layer.out, cols: d, w: unproject(&layer.w, p, layer.out, dim, d), b: layer.b },
                    _ => Layer { rows: layer.out, cols: layer.inp, w: layer.w, b: layer.b },
                })
                .collect()
        };
        let outcome = Outcome {
            kind: if self.opt.kind == 0 { 0 } else if self.opt.hidden2 > 0 { 2 } else { 1 },
            layers,
            confusion,
            folds: self.folds,
            projected: if run.space.p.is_some() { dim } else { 0 },
            bagged: if run.final_members > 1 { run.final_members } else { 0 },
            accuracy,
            balanced,
            temperature,
            retried: false,
            evaluated: held_y.len(),
        };
        // Projection costs a few percent of distance, which is nothing on
        // clustered data and everything on classes barely apart: a weak score
        // is retried at full width and the better model ships.
        if self.opt.kind == 0 && self.first.is_none() && self.retry_possible && balanced < RETRY_BELOW {
            self.first = Some(outcome);
            self.begin_run(0);
            return;
        }
        self.outcome = Some(match self.first.take() {
            Some(first) => {
                let mut winner = if outcome.balanced > first.balanced { outcome } else { first };
                winner.retried = true;
                winner
            }
            None => outcome,
        });
    }
}

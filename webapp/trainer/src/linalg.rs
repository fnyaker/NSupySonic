//! The four loops training is made of — a dot product, `y += a·x`, Adam over a
//! block, and a projection — written twice: with SIMD128 where the build has
//! it, and in scalar code laid out lane for lane like the SIMD one, so the two
//! builds compute the SAME bits (test/trainer.test.mjs trains one head with
//! each and compares them weight for weight).
//!
//! What makes that possible: Rust never contracts a multiply and an add into a
//! fused one on its own, `f32.sqrt` and `f32.div` are exact IEEE operations in
//! both instruction sets, and the one reduction here (the dot product) keeps
//! eight partial sums in the scalar build exactly where the two vectors of the
//! SIMD build keep them, and folds them in the same order.

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::*;

/// Σ a[i]·b[i], over the shorter of the two.
#[inline]
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let n8 = n & !7;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    let (l0, l1, l2, l3) = unsafe {
        let mut acc0 = f32x4_splat(0.0);
        let mut acc1 = f32x4_splat(0.0);
        let pa = a.as_ptr();
        let pb = b.as_ptr();
        let mut i = 0;
        while i < n8 {
            let a0 = v128_load(pa.add(i) as *const v128);
            let b0 = v128_load(pb.add(i) as *const v128);
            let a1 = v128_load(pa.add(i + 4) as *const v128);
            let b1 = v128_load(pb.add(i + 4) as *const v128);
            acc0 = f32x4_add(acc0, f32x4_mul(a0, b0));
            acc1 = f32x4_add(acc1, f32x4_mul(a1, b1));
            i += 8;
        }
        let acc = f32x4_add(acc0, acc1);
        (
            f32x4_extract_lane::<0>(acc),
            f32x4_extract_lane::<1>(acc),
            f32x4_extract_lane::<2>(acc),
            f32x4_extract_lane::<3>(acc),
        )
    };
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    let (l0, l1, l2, l3) = {
        // chunks_exact: the eight indices are known in range, so no bounds
        // check survives into the loop.
        let mut s = [0f32; 8];
        for (ca, cb) in a[..n8].chunks_exact(8).zip(b[..n8].chunks_exact(8)) {
            s[0] += ca[0] * cb[0];
            s[1] += ca[1] * cb[1];
            s[2] += ca[2] * cb[2];
            s[3] += ca[3] * cb[3];
            s[4] += ca[4] * cb[4];
            s[5] += ca[5] * cb[5];
            s[6] += ca[6] * cb[6];
            s[7] += ca[7] * cb[7];
        }
        (s[0] + s[4], s[1] + s[5], s[2] + s[6], s[3] + s[7])
    };
    let mut tail = 0f32;
    for (x, y) in a[n8..n].iter().zip(&b[n8..n]) {
        tail += x * y;
    }
    ((l0 + l1) + (l2 + l3)) + tail
}

/// Four dot products of one row `w` against four rows at once: `w` is read
/// once for all four. Each result is accumulated and folded exactly as `dot`
/// folds it, so `dot4(w, a, b, c, d)[1] == dot(w, b)` to the bit.
#[inline]
pub fn dot4(w: &[f32], x0: &[f32], x1: &[f32], x2: &[f32], x3: &[f32]) -> [f32; 4] {
    let n = w.len().min(x0.len()).min(x1.len()).min(x2.len()).min(x3.len());
    let n8 = n & !7;
    let mut lanes = [[0f32; 4]; 4];
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    unsafe {
        let z = f32x4_splat(0.0);
        let (mut a0, mut a1, mut b0, mut b1, mut c0, mut c1, mut d0, mut d1) = (z, z, z, z, z, z, z, z);
        let pw = w.as_ptr();
        let (p0, p1, p2, p3) = (x0.as_ptr(), x1.as_ptr(), x2.as_ptr(), x3.as_ptr());
        let mut i = 0;
        while i < n8 {
            let w0 = v128_load(pw.add(i) as *const v128);
            let w1 = v128_load(pw.add(i + 4) as *const v128);
            a0 = f32x4_add(a0, f32x4_mul(w0, v128_load(p0.add(i) as *const v128)));
            a1 = f32x4_add(a1, f32x4_mul(w1, v128_load(p0.add(i + 4) as *const v128)));
            b0 = f32x4_add(b0, f32x4_mul(w0, v128_load(p1.add(i) as *const v128)));
            b1 = f32x4_add(b1, f32x4_mul(w1, v128_load(p1.add(i + 4) as *const v128)));
            c0 = f32x4_add(c0, f32x4_mul(w0, v128_load(p2.add(i) as *const v128)));
            c1 = f32x4_add(c1, f32x4_mul(w1, v128_load(p2.add(i + 4) as *const v128)));
            d0 = f32x4_add(d0, f32x4_mul(w0, v128_load(p3.add(i) as *const v128)));
            d1 = f32x4_add(d1, f32x4_mul(w1, v128_load(p3.add(i + 4) as *const v128)));
            i += 8;
        }
        for (j, acc) in [f32x4_add(a0, a1), f32x4_add(b0, b1), f32x4_add(c0, c1), f32x4_add(d0, d1)].iter().enumerate() {
            lanes[j] = [
                f32x4_extract_lane::<0>(*acc),
                f32x4_extract_lane::<1>(*acc),
                f32x4_extract_lane::<2>(*acc),
                f32x4_extract_lane::<3>(*acc),
            ];
        }
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    {
        let xs = [&x0[..n8], &x1[..n8], &x2[..n8], &x3[..n8]];
        for (j, x) in xs.iter().enumerate() {
            let mut s = [0f32; 8];
            for (ca, cb) in w[..n8].chunks_exact(8).zip(x.chunks_exact(8)) {
                s[0] += ca[0] * cb[0];
                s[1] += ca[1] * cb[1];
                s[2] += ca[2] * cb[2];
                s[3] += ca[3] * cb[3];
                s[4] += ca[4] * cb[4];
                s[5] += ca[5] * cb[5];
                s[6] += ca[6] * cb[6];
                s[7] += ca[7] * cb[7];
            }
            lanes[j] = [s[0] + s[4], s[1] + s[5], s[2] + s[6], s[3] + s[7]];
        }
    }
    let xs = [x0, x1, x2, x3];
    let mut out = [0f32; 4];
    for j in 0..4 {
        let mut tail = 0f32;
        for (a, b) in w[n8..n].iter().zip(&xs[j][n8..n]) {
            tail += a * b;
        }
        let l = lanes[j];
        out[j] = ((l[0] + l[1]) + (l[2] + l[3])) + tail;
    }
    out
}

/// y[i] += a0·x0[i], then a1·x1[i], a2·x2[i], a3·x3[i] — the four `axpy`s in
/// that order, element for element, with `y` read and written once.
#[inline]
pub fn axpy4(y: &mut [f32], a: [f32; 4], x0: &[f32], x1: &[f32], x2: &[f32], x3: &[f32]) {
    let n = y.len().min(x0.len()).min(x1.len()).min(x2.len()).min(x3.len());
    let n4 = n & !3;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    unsafe {
        let (v0, v1, v2, v3) = (f32x4_splat(a[0]), f32x4_splat(a[1]), f32x4_splat(a[2]), f32x4_splat(a[3]));
        let py = y.as_mut_ptr();
        let (p0, p1, p2, p3) = (x0.as_ptr(), x1.as_ptr(), x2.as_ptr(), x3.as_ptr());
        let mut i = 0;
        while i < n4 {
            let mut vy = v128_load(py.add(i) as *const v128);
            vy = f32x4_add(vy, f32x4_mul(v0, v128_load(p0.add(i) as *const v128)));
            vy = f32x4_add(vy, f32x4_mul(v1, v128_load(p1.add(i) as *const v128)));
            vy = f32x4_add(vy, f32x4_mul(v2, v128_load(p2.add(i) as *const v128)));
            vy = f32x4_add(vy, f32x4_mul(v3, v128_load(p3.add(i) as *const v128)));
            v128_store(py.add(i) as *mut v128, vy);
            i += 4;
        }
    }
    let start = if cfg!(all(target_arch = "wasm32", target_feature = "simd128")) { n4 } else { 0 };
    let (y, x0, x1, x2, x3) = (&mut y[..n], &x0[..n], &x1[..n], &x2[..n], &x3[..n]);
    for i in start..n {
        let mut v = y[i];
        v += a[0] * x0[i];
        v += a[1] * x1[i];
        v += a[2] * x2[i];
        v += a[3] * x3[i];
        y[i] = v;
    }
}

/// y[i] += a·x[i]
#[inline]
pub fn axpy(y: &mut [f32], a: f32, x: &[f32]) {
    let n = y.len().min(x.len());
    let n4 = n & !3;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    unsafe {
        let va = f32x4_splat(a);
        let py = y.as_mut_ptr();
        let px = x.as_ptr();
        let mut i = 0;
        while i < n4 {
            let vy = v128_load(py.add(i) as *const v128);
            let vx = v128_load(px.add(i) as *const v128);
            v128_store(py.add(i) as *mut v128, f32x4_add(vy, f32x4_mul(va, vx)));
            i += 4;
        }
    }
    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    for (yv, xv) in y[..n4].iter_mut().zip(&x[..n4]) {
        *yv += a * xv;
    }
    for (yv, xv) in y[n4..n].iter_mut().zip(&x[n4..n]) {
        *yv += a * xv;
    }
}

/// One Adam step over a parameter block, with L2 on the parameter, and the
/// gradient cleared behind it:
///
///   g ← g·scale + l2·p;  m ← β1·m + (1-β1)·g;  v ← β2·v + (1-β2)·g²
///   p ← p − (lr/bc1)·m / (√v·(1/√bc2) + ε)
///
/// (the bias corrections folded into two constants, which leaves one square
/// root and one division per parameter where the textbook form has two
/// divisions: Adam is a fifth of a deep fit, since it touches every weight
/// every batch).
#[allow(clippy::too_many_arguments)]
#[inline]
pub fn adam(p: &mut [f32], m: &mut [f32], v: &mut [f32], g: &mut [f32], scale: f32, lr: f32, l2: f32, bc1: f32, bc2: f32) {
    const B1: f32 = 0.9;
    const B2: f32 = 0.999;
    const EPS: f32 = 1e-8;
    let n = p.len();
    let n4 = n & !3;
    let step_scale = (lr as f64 / bc1 as f64) as f32;
    let rbc2 = (1.0 / (bc2 as f64).sqrt()) as f32;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    unsafe {
        let (vs, vl2, vb1, vb1c, vb2, vb2c) =
            (f32x4_splat(scale), f32x4_splat(l2), f32x4_splat(B1), f32x4_splat(1.0 - B1), f32x4_splat(B2), f32x4_splat(1.0 - B2));
        let (va, vrb, veps, zero) = (f32x4_splat(step_scale), f32x4_splat(rbc2), f32x4_splat(EPS), f32x4_splat(0.0));
        let (pp, pm, pv, pg) = (p.as_mut_ptr(), m.as_mut_ptr(), v.as_mut_ptr(), g.as_mut_ptr());
        let mut i = 0;
        while i < n4 {
            let vp = v128_load(pp.add(i) as *const v128);
            let gi = f32x4_add(f32x4_mul(v128_load(pg.add(i) as *const v128), vs), f32x4_mul(vl2, vp));
            let mi = f32x4_add(f32x4_mul(vb1, v128_load(pm.add(i) as *const v128)), f32x4_mul(vb1c, gi));
            let vi = f32x4_add(f32x4_mul(vb2, v128_load(pv.add(i) as *const v128)), f32x4_mul(f32x4_mul(vb2c, gi), gi));
            v128_store(pm.add(i) as *mut v128, mi);
            v128_store(pv.add(i) as *mut v128, vi);
            let step = f32x4_div(f32x4_mul(va, mi), f32x4_add(f32x4_mul(f32x4_sqrt(vi), vrb), veps));
            v128_store(pp.add(i) as *mut v128, f32x4_sub(vp, step));
            v128_store(pg.add(i) as *mut v128, zero);
            i += 4;
        }
    }
    let start = if cfg!(all(target_arch = "wasm32", target_feature = "simd128")) { n4 } else { 0 };
    let (m, v, g) = (&mut m[..n], &mut v[..n], &mut g[..n]);
    for i in start..n {
        let gi = g[i] * scale + l2 * p[i];
        let mi = B1 * m[i] + (1.0 - B1) * gi;
        let vi = B2 * v[i] + ((1.0 - B2) * gi) * gi;
        m[i] = mi;
        v[i] = vi;
        p[i] -= (step_scale * mi) / (vi.sqrt() * rbc2 + EPS);
        g[i] = 0.0;
    }
}

/// Every out[r] = dot(W[r], x) + b[r], for a row-major `rows × cols` W.
#[inline]
pub fn forward(w: &[f32], b: &[f32], x: &[f32], out: &mut [f32], rows: usize, cols: usize) {
    for r in 0..rows {
        out[r] = dot(&w[r * cols..(r + 1) * cols], x) + b[r];
    }
}

/// W (rows × k) · P (k × d) → rows × d: a head trained in a projected space,
/// folded back onto the original one. Linear, so it commutes with everything
/// done to W before it.
pub fn unproject(w: &[f32], p: &[f32], rows: usize, k: usize, d: usize) -> Vec<f32> {
    let mut out = vec![0f32; rows * d];
    for r in 0..rows {
        let orow = &mut out[r * d..(r + 1) * d];
        for i in 0..k {
            let wi = w[r * k + i];
            if wi != 0.0 {
                axpy(orow, wi, &p[i * d..(i + 1) * d]);
            }
        }
    }
    out
}

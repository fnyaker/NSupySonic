//! A real-input FFT, sized once and reused: an N/2-point complex radix-2 FFT
//! plus the standard split to recover the N-point real transform.
//!
//! The output is scaled exactly as `AnalyserNode.getFloatFrequencyData` scales
//! it — a Blackman window (the Web Audio spec's, a = 0.16), the magnitude
//! divided by N — because everything downstream (the band plan's ceiling and
//! floor, every threshold features.rs inherited) was tuned against what the
//! browser's analyser reported. Nothing allocates after `new`.

use core::f32::consts::PI;

pub struct RealFft {
    n: usize,
    m: usize,
    rev: Vec<u32>,
    // Twiddles STAGE BY STAGE, each stage's contiguous: the stage whose
    // butterflies span `h` pairs reads exp(-i pi k / h), k < h, from [h-1,
    // 2h-1). The textbook layout (one table, strided by m / len) made every
    // early stage hop through memory, and the index arithmetic it needs kept
    // the bounds checks in the inner loop: measured, the FFT was half of the
    // whole analyser's instructions.
    tw_re: Vec<f32>,
    tw_im: Vec<f32>,
    post_re: Vec<f32>,
    post_im: Vec<f32>,
    re: Vec<f32>,
    im: Vec<f32>,
    window: Vec<f32>,
    // The ring buffer's two halves, made contiguous.
    buf: Vec<f32>,
}

impl RealFft {
    pub fn new(n: usize) -> RealFft {
        assert!(n.is_power_of_two() && n >= 8);
        let m = n / 2;
        let bits = m.trailing_zeros();
        let mut rev = vec![0u32; m];
        for (i, r) in rev.iter_mut().enumerate() {
            *r = ((i as u32).reverse_bits() >> (32 - bits)) as u32;
        }
        let mut tw_re = vec![0f32; m];
        let mut tw_im = vec![0f32; m];
        let mut h = 1;
        while h < m {
            for k in 0..h {
                let a = -core::f64::consts::PI * k as f64 / h as f64;
                tw_re[h - 1 + k] = a.cos() as f32;
                tw_im[h - 1 + k] = a.sin() as f32;
            }
            h <<= 1;
        }
        let mut post_re = vec![0f32; m + 1];
        let mut post_im = vec![0f32; m + 1];
        for k in 0..=m {
            let a = -2.0 * core::f64::consts::PI * k as f64 / n as f64;
            post_re[k] = a.cos() as f32;
            post_im[k] = a.sin() as f32;
        }
        // The Web Audio spec's Blackman window: a0 - a1 cos(2 pi n / N) +
        // a2 cos(4 pi n / N), with alpha = 0.16.
        let mut window = vec![0f32; n];
        for (i, w) in window.iter_mut().enumerate() {
            let x = i as f32 / n as f32;
            *w = 0.42 - 0.5 * (2.0 * PI * x).cos() + 0.08 * (4.0 * PI * x).cos();
        }
        RealFft {
            n,
            m,
            rev,
            tw_re,
            tw_im,
            post_re,
            post_im,
            re: vec![0f32; m],
            im: vec![0f32; m],
            window,
            buf: vec![0f32; n],
        }
    }

    /// Magnitudes |X[k]| / N for k in 0..N/2, of the N samples formed by
    /// `a` followed by `b` (a ring buffer's two halves), windowed.
    pub fn magnitudes(&mut self, a: &[f32], b: &[f32], out: &mut [f32]) {
        let n = self.n;
        let m = self.m;
        debug_assert_eq!(a.len() + b.len(), n);
        let buf = &mut self.buf[..n];
        buf[..a.len()].copy_from_slice(a);
        buf[a.len()..].copy_from_slice(&b[..n - a.len()]);
        for (v, w) in buf.iter_mut().zip(self.window.iter()) {
            *v *= *w;
        }
        // Even samples into re and odd into im, bit-reversed as we go.
        let re = &mut self.re[..m];
        let im = &mut self.im[..m];
        for (pair, &j) in buf.chunks_exact(2).zip(self.rev.iter()) {
            let j = j as usize;
            re[j] = pair[0];
            im[j] = pair[1];
        }
        Self::complex_in_place(re, im, &self.tw_re, &self.tw_im);
        // Split: X[k] = Fe[k] + W^k Fo[k], with Z[m-k] read from the far end.
        let scale = 1.0 / n as f32;
        let out = &mut out[..m];
        {
            // k = 0 pairs with itself.
            let (zr, zi) = (re[0], im[0]);
            let x0 = zr + zi;
            let _ = zi;
            out[0] = x0.abs() * scale;
        }
        let post_re = &self.post_re[1..m];
        let post_im = &self.post_im[1..m];
        let fwd_re = &re[1..m];
        let fwd_im = &im[1..m];
        for (k, (((o, (&zr, &zi)), (&cr0, &ci0)), (&wr, &wi))) in out[1..]
            .iter_mut()
            .zip(fwd_re.iter().zip(fwd_im.iter()))
            .zip(fwd_re.iter().rev().zip(fwd_im.iter().rev()))
            .zip(post_re.iter().zip(post_im.iter()))
            .enumerate()
        {
            let _ = k;
            let cr = cr0;
            let ci = -ci0;
            // Fe = (Z[k] + conj Z[m-k]) / 2 ; Fo = (Z[k] - conj Z[m-k]) / 2i
            let fer = 0.5 * (zr + cr);
            let fei = 0.5 * (zi + ci);
            let dr = 0.5 * (zr - cr);
            let di = 0.5 * (zi - ci);
            // divide by i: (dr + i di) / i = di - i dr
            let xr = fer + wr * di + wi * dr;
            let xi = fei - wr * dr + wi * di;
            *o = (xr * xr + xi * xi).sqrt() * scale;
        }
    }

    fn complex_in_place(re: &mut [f32], im: &mut [f32], tw_re: &[f32], tw_im: &[f32]) {
        let m = re.len();
        // The first stage's only twiddle is 1: a plain sum and difference.
        for (r, i) in re.chunks_exact_mut(2).zip(im.chunks_exact_mut(2)) {
            let (ar, ai, br, bi) = (r[0], i[0], r[1], i[1]);
            r[0] = ar + br;
            i[0] = ai + bi;
            r[1] = ar - br;
            i[1] = ai - bi;
        }
        let mut half = 2;
        while half < m {
            let len = half * 2;
            let wr = &tw_re[half - 1..2 * half - 1];
            let wi = &tw_im[half - 1..2 * half - 1];
            for (br, bi) in re.chunks_exact_mut(len).zip(im.chunks_exact_mut(len)) {
                let (lo_r, hi_r) = br.split_at_mut(half);
                let (lo_i, hi_i) = bi.split_at_mut(half);
                for ((((ar, ai), (xr, xi)), &cr), &ci) in lo_r
                    .iter_mut()
                    .zip(lo_i.iter_mut())
                    .zip(hi_r.iter_mut().zip(hi_i.iter_mut()))
                    .zip(wr.iter())
                    .zip(wi.iter())
                {
                    let tr = *xr * cr - *xi * ci;
                    let ti = *xr * ci + *xi * cr;
                    *xr = *ar - tr;
                    *xi = *ai - ti;
                    *ar += tr;
                    *ai += ti;
                }
            }
            half = len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sine_lands_in_its_bin_at_the_analyser_scale() {
        let n = 2048;
        let sr = 48000.0f32;
        let mut f = RealFft::new(n);
        let bin = 100usize;
        let hz = bin as f32 * sr / n as f32;
        let x: Vec<f32> = (0..n).map(|i| (2.0 * PI * hz * i as f32 / sr).sin()).collect();
        let mut out = vec![0f32; n / 2];
        f.magnitudes(&x, &[], &mut out);
        let mut best = 0;
        for k in 0..n / 2 {
            if out[k] > out[best] {
                best = k;
            }
        }
        assert_eq!(best, bin);
        // A unit sine through a Blackman window: coherent gain 0.42, half the
        // amplitude in each of the two conjugate bins -> 0.21.
        assert!((out[bin] - 0.21).abs() < 0.005, "{}", out[bin]);
    }

    #[test]
    fn matches_a_naive_dft() {
        let n = 64;
        let mut f = RealFft::new(n);
        let x: Vec<f32> = (0..n).map(|i| ((i * 7919) % 97) as f32 / 97.0 - 0.5).collect();
        let mut out = vec![0f32; n / 2];
        let (a, b) = x.split_at(20);
        f.magnitudes(a, b, &mut out);
        for k in 0..n / 2 {
            let mut sr = 0f64;
            let mut si = 0f64;
            for (i, v) in x.iter().enumerate() {
                let w = 0.42 - 0.5 * (2.0 * core::f64::consts::PI * i as f64 / n as f64).cos()
                    + 0.08 * (4.0 * core::f64::consts::PI * i as f64 / n as f64).cos();
                let ang = -2.0 * core::f64::consts::PI * (k * i) as f64 / n as f64;
                sr += *v as f64 * w * ang.cos();
                si += *v as f64 * w * ang.sin();
            }
            let want = (sr * sr + si * si).sqrt() / n as f64;
            assert!((out[k] as f64 - want).abs() < 1e-4, "bin {}: {} vs {}", k, out[k], want);
        }
    }
}

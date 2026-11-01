//! A plain radix-2 complex FFT in f64 and the real-input magnitude spectrum built on it.
//! Exactness over speed: these run once per 2048-sample frame and the numbers must
//! match the Python twin (supysonic/deezer/measure.py) to rounding.

pub struct Fft {
    n: usize,
    rev: Vec<usize>,
    cos: Vec<f64>,
    sin: Vec<f64>,
    re: Vec<f64>,
    im: Vec<f64>,
}

impl Fft {
    pub fn new(n: usize) -> Fft {
        assert!(n.is_power_of_two() && n >= 4);
        let bits = n.trailing_zeros();
        let rev = (0..n).map(|i| ((i as u32).reverse_bits() >> (32 - bits)) as usize).collect();
        let cos = (0..n / 2).map(|k| (-2.0 * core::f64::consts::PI * k as f64 / n as f64).cos()).collect();
        let sin = (0..n / 2).map(|k| (-2.0 * core::f64::consts::PI * k as f64 / n as f64).sin()).collect();
        Fft { n, rev, cos, sin, re: vec![0.0; n], im: vec![0.0; n] }
    }

    /// The forward transform of a complex sequence, in place (`re.len() == n`).
    pub fn transform(&mut self, re: &mut [f64], im: &mut [f64]) {
        let n = self.n;
        for i in 0..n {
            let j = self.rev[i];
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            let mut start = 0;
            while start < n {
                for k in 0..half {
                    let (c, s) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = re[b] * c - im[b] * s;
                    let ti = re[b] * s + im[b] * c;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
                start += len;
            }
            len <<= 1;
        }
    }

    /// `|rfft(x)|` for the first `bins` bins, `x.len() == n`.
    pub fn magnitude(&mut self, x: &[f64], bins: usize, out: &mut [f64]) {
        let n = self.n;
        for i in 0..n {
            self.re[self.rev[i]] = x[i];
            self.im[self.rev[i]] = 0.0;
        }
        let mut len = 2;
        while len <= n {
            let half = len / 2;
            let step = n / len;
            let mut start = 0;
            while start < n {
                for k in 0..half {
                    let (c, s) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = self.re[b] * c - self.im[b] * s;
                    let ti = self.re[b] * s + self.im[b] * c;
                    self.re[b] = self.re[a] - tr;
                    self.im[b] = self.im[a] - ti;
                    self.re[a] += tr;
                    self.im[a] += ti;
                }
                start += len;
            }
            len <<= 1;
        }
        for k in 0..bins {
            out[k] = (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt();
        }
    }
}

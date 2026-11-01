//! EBU R128 / ITU-R BS.1770 integrated loudness and loudness range, replacing
//! ffmpeg's `ebur128`. K-weighting by the two biquads of BS.1770 (re-derived for
//! any rate), 400 ms blocks every 100 ms, gates at -70 LUFS absolute and -10 LU
//! (integrated) / -20 LU (range) relative; the range is the 10th-95th percentile
//! spread of the 3 s short-term loudness. ffmpeg bins the range's histogram at
//! 0.1 LU; this uses exact percentiles, so a small difference there is expected.

struct Biquad { b: [f64; 3], a: [f64; 2], z: [f64; 2] }

impl Biquad {
    fn run(&mut self, x: f64) -> f64 {
        // transposed direct form II
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

fn k_weighting(rate: f64) -> (Biquad, Biquad) {
    let pi = core::f64::consts::PI;
    let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let k = (pi * f0 / rate).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b: [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
        a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        z: [0.0; 2],
    };
    let (f1, q1) = (38.13547087602444, 0.5003270373238773);
    let k = (pi * f1 / rate).tan();
    let a0 = 1.0 + k / q1 + k * k;
    let hp = Biquad { b: [1.0, -2.0, 1.0], a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q1 + k * k) / a0], z: [0.0; 2] };
    (shelf, hp)
}

fn lufs(power: f64) -> f64 {
    -0.691 + 10.0 * power.log10()
}

/// `(integrated LUFS, LRA in LU)`; `None` for audio too short for one block.
pub fn measure(channels: &[&[f32]], rate: f64) -> Option<(f64, f64)> {
    let n = channels.iter().map(|c| c.len()).min()?;
    let step = (rate * 0.1).round() as usize;
    let block = step * 4;
    if n < block || channels.is_empty() {
        return None;
    }
    // Per-100 ms sub-block sum of weighted squares over all channels.
    let subs = n / step;
    let mut energy = vec![0.0f64; subs];
    for ch in channels {
        let (mut shelf, mut hp) = k_weighting(rate);
        for (s, e) in energy.iter_mut().enumerate() {
            let mut acc = 0.0;
            for i in s * step..(s + 1) * step {
                let y = hp.run(shelf.run(ch[i] as f64));
                acc += y * y;
            }
            *e += acc / step as f64; // channel weight 1.0 (mono / stereo)
        }
    }
    let window = |len: usize| -> Vec<f64> {
        (0..=subs.saturating_sub(len))
            .filter(|_| subs >= len)
            .map(|i| energy[i..i + len].iter().sum::<f64>() / len as f64)
            .collect()
    };
    // Integrated: 400 ms momentary blocks.
    let mom = window(4);
    let above: Vec<f64> = mom.iter().copied().filter(|&p| p > 0.0 && lufs(p) > -70.0).collect();
    if above.is_empty() {
        return None;
    }
    let rel = lufs(above.iter().sum::<f64>() / above.len() as f64) - 10.0;
    let kept: Vec<f64> = above.iter().copied().filter(|&p| lufs(p) > rel).collect();
    let integrated = if kept.is_empty() { lufs(above.iter().sum::<f64>() / above.len() as f64) } else { lufs(kept.iter().sum::<f64>() / kept.len() as f64) };
    // Range: 3 s short-term blocks.
    let short: Vec<f64> = window(30).into_iter().filter(|&p| p > 0.0 && lufs(p) > -70.0).collect();
    let lra = if short.is_empty() {
        0.0
    } else {
        let rel = lufs(short.iter().sum::<f64>() / short.len() as f64) - 20.0;
        let mut l: Vec<f64> = short.iter().map(|&p| lufs(p)).filter(|&v| v > rel).collect();
        l.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        if l.len() < 2 { 0.0 } else {
            let at = |q: f64| l[((q * (l.len() - 1) as f64).round() as usize).min(l.len() - 1)];
            at(0.95) - at(0.10)
        }
    };
    Some((integrated, lra))
}

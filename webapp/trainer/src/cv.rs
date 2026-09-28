//! Cross-validation: which rows each fold holds out, the temperature fitted on
//! what was held out, and the scores read off the confusion matrix.

use crate::rng::Rng;

/// Round to three decimals, as the studio shows (and as the JavaScript's
/// `+x.toFixed(3)` did before its comparisons).
pub fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Stratified folds: each class's rows shuffled and dealt round the folds, so a
/// genre with eleven examples cannot land in one fold and turn the score into a
/// coin toss. Returns (fold of each row, fold count).
pub fn stratified(y: &[i32], c: usize, want: usize, rng: &mut Rng) -> (Vec<i32>, usize) {
    let mut by_class: Vec<Vec<usize>> = vec![Vec::new(); c];
    for (i, &k) in y.iter().enumerate() {
        by_class[k as usize].push(i);
    }
    let smallest = by_class.iter().map(|l| l.len()).filter(|&l| l > 0).min().unwrap_or(2);
    let folds = want.min(smallest).max(2);
    let mut assign = vec![0i32; y.len()];
    for list in by_class.iter_mut() {
        rng.shuffle(list);
        for (k, &idx) in list.iter().enumerate() {
            assign[idx] = (k % folds) as i32;
        }
    }
    (assign, folds)
}

/// Folds that never split a GROUP (an artist): every row of a group is held
/// out together or trained on together.
///
/// Two tracks off one album share a production, a mastering chain and usually
/// a sound; their embeddings sit next to each other. With plain stratified
/// folds one of them trains the model and the other then "tests" it, so the
/// held-out score measures recognising an album rather than a genre — and the
/// temperature fitted on those easy calls leaves the head over-confident,
/// which is what the server's gate reads. Grouping answers the question the
/// studio actually asks: would this head name the genre of an artist it has
/// never heard?
///
/// Greedy, largest group first: each goes to the fold where its classes are
/// currently scarcest (relative to how common each class is), so the folds stay
/// close to stratified. A row with no group (-1) is a group of its own. A class
/// whose every example comes from ONE artist cannot be tested on anyone else,
/// and it will score what it honestly scores.
pub fn grouped(y: &[i32], groups: &[i32], c: usize, want: usize, rng: &mut Rng) -> (Vec<i32>, usize) {
    let n = y.len();
    // Group ids are arbitrary; gather rows per distinct id.
    let mut ids: Vec<(i32, usize)> = Vec::with_capacity(n);
    let mut singles = 0i32;
    for i in 0..n {
        let g = groups.get(i).copied().unwrap_or(-1);
        if g < 0 {
            singles += 1;
            ids.push((i32::MIN + singles, i));
        } else {
            ids.push((g, i));
        }
    }
    ids.sort_unstable();
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut last: Option<i32> = None;
    for &(g, i) in &ids {
        if last != Some(g) {
            members.push(Vec::new());
            last = Some(g);
        }
        members.last_mut().unwrap().push(i);
    }
    let folds = want.min(members.len()).max(2);
    // Random order among equals, then biggest first.
    rng.shuffle(&mut members);
    members.sort_by(|a, b| b.len().cmp(&a.len()));

    let mut total = vec![0f64; c];
    for &k in y {
        total[k as usize] += 1.0;
    }
    let mut fold_class = vec![vec![0f64; c]; folds];
    let mut fold_size = vec![0f64; folds];
    let mut assign = vec![0i32; n];
    let mut gc = vec![0f64; c];
    for rows in &members {
        gc.iter_mut().for_each(|v| *v = 0.0);
        for &i in rows {
            gc[y[i] as usize] += 1.0;
        }
        let mut best = 0usize;
        let mut best_cost = f64::INFINITY;
        for f in 0..folds {
            let mut cost = 0.0;
            for k in 0..c {
                if gc[k] > 0.0 {
                    cost += gc[k] * (fold_class[f][k] + gc[k]) / total[k].max(1.0);
                }
            }
            // A whisper of overall size, so equal costs fill the emptier fold.
            cost += 1e-6 * (fold_size[f] + rows.len() as f64);
            if cost < best_cost {
                best_cost = cost;
                best = f;
            }
        }
        for &i in rows {
            assign[i] = best as i32;
            fold_class[best][y[i] as usize] += 1.0;
        }
        fold_size[best] += rows.len() as f64;
    }
    (assign, folds)
}

/// One scalar temperature, fitted on held-out logits by minimum NLL over a
/// grid 2^(k/20), k = -20..20 (0.5 to 4). Dividing every logit by it cannot
/// move an argmax; it only makes the confidence the server gates on mean what
/// it says. `held` is row-major, `rows × c`.
pub fn temperature(held: &[f32], labels: &[i32], c: usize) -> f64 {
    let rows = labels.len();
    if rows == 0 || c < 2 {
        return 1.0;
    }
    let mut best_t = 1.0;
    let mut best = f64::INFINITY;
    for step in -20..=20 {
        let t = 2f64.powf(step as f64 / 20.0);
        let mut nll = 0.0;
        for e in 0..rows {
            let lg = &held[e * c..(e + 1) * c];
            let y = labels[e] as usize;
            let mut top = f64::NEG_INFINITY;
            for &v in lg {
                let s = v as f64 / t;
                if s > top {
                    top = s;
                }
            }
            let mut sum = 0.0;
            for &v in lg {
                sum += (v as f64 / t - top).exp();
            }
            let p = (lg[y] as f64 / t - top).exp() / if sum != 0.0 { sum } else { 1.0 };
            nll -= p.max(1e-12).ln();
        }
        if nll < best {
            best = nll;
            best_t = t;
        }
    }
    round3(best_t)
}

/// (accuracy, balanced accuracy) off a `c × c` confusion matrix (true class by
/// row). Balanced: the mean recall over the classes that have examples at all,
/// so one dominant genre cannot flatter a model that always answers it.
pub fn scores(confusion: &[i32], examples: &[usize], c: usize) -> (f64, f64) {
    let mut correct = 0i64;
    let mut total = 0i64;
    let mut recall_sum = 0.0;
    let mut classes = 0usize;
    for k in 0..c {
        let row = &confusion[k * c..(k + 1) * c];
        let seen: i64 = row.iter().map(|&v| v as i64).sum();
        correct += row[k] as i64;
        total += seen;
        if examples[k] > 0 {
            classes += 1;
            if seen > 0 {
                recall_sum += round3(row[k] as f64 / seen as f64);
            }
        }
    }
    let acc = if total > 0 { round3(correct as f64 / total as f64) } else { 0.0 };
    let bal = round3(recall_sum / classes.max(1) as f64);
    (acc, bal)
}

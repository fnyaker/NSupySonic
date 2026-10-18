// What can go wrong when a head is trained on a few hundred hand-tagged
// tracks, caught and — where it can be — avoided WITHOUT asking anybody.
//
// Two halves, both pure (test/genrehealth.test.mjs):
//
//   prepare()  runs BEFORE training, on the labelled rows. It removes what
//              would bias the head or the score: a genre with too few examples
//              to be learnt or tested, the same recording tagged twice (one
//              copy trains the head and the other "tests" it), the same
//              recording tagged two DIFFERENT ways (the head cannot learn
//              both), and one artist making up most of a genre (the head would
//              learn the artist). Each thing it did is reported once, in a
//              sentence.
//
//   assess()   runs AFTER, on the numbers the trainer measured. It turns them
//              into ONE verdict (good / to watch / unreliable) and at most
//              three things worth knowing, each with what to do about it. The
//              full tables stay one click away; nothing here should need them.
//
// Every threshold is a literal next to the reason it is that number.

/** Under this many tracks a genre is left out of training: five folds cannot
 *  each hold one out and still train on four, and a recall measured on two
 *  tracks is a coin toss. The tag itself still applies — it is only not
 *  something the head is asked to predict yet. */
export const MIN_EXAMPLES = 5;
/** One artist may supply at most this share of a genre's examples (and never
 *  fewer than ARTIST_CAP_MIN tracks): past it, the head's cheapest way to the
 *  genre is the artist's production, which is the bias this exists to stop. */
export const ARTIST_SHARE_MAX = 0.4;
export const ARTIST_CAP_MIN = 5;
/** Training-fold score minus held-out score. A linear head on well-separated
 *  genres measured 0.00-0.03 (trainer test `separable_data_has_no_gap`); one
 *  fitted to labels unrelated to the audio, 0.6+. */
export const GAP_WATCH = 0.15;
export const GAP_BAD = 0.3;
/** Score with ordinary folds minus score with whole artists held out. Measured
 *  on artists whose sound outweighs their genre: 0.96-0.98 against 0.74-0.83. */
export const ARTIST_EFFECT_WATCH = 0.12;
/** A genre recognised less than half the time is worth saying so. */
export const WEAK_RECALL = 0.5;
/** A label the held-out head gives under this much while it puts at least
 *  SUSPECT_OTHER on one other genre: worth a second listen. */
export const SUSPECT_OWN = 0.15;
export const SUSPECT_OTHER = 0.6;
/** Balanced accuracy under this and the model is not worth serving. */
export const POOR_BALANCED = 0.6;

/** A cheap identity for a vector: identical recordings (two editions of one
 *  album, one file tagged under two Deezer ids) embed to the same numbers. */
export function vectorKey(vec) {
  let h = 0x811c9dc5;
  const n = Math.min(vec.length, 96);
  for (let i = 0; i < n; i++) {
    const q = Math.round(vec[i] * 500);
    h ^= q & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= q >>> 16;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const list = (names, max = 3) =>
  names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} et ${names.length - max} autre${names.length - max > 1 ? "s" : ""}`;
const plural = (n, one, many = one + "s") => `${n} ${n > 1 ? many : one}`;

/**
 * @param rows [{label, artist (string|null), key (vectorKey), …}] newest first
 * @returns {keep: indices into rows, done: [sentence], excluded: [label],
 *           conflicts: [[i, j]], capped: {label: dropped}}
 */
export function prepare(rows) {
  const done = [];
  // 1. The same recording twice: one copy kept (the newest tag), and when the
  //    copies disagree, neither — the head cannot learn both answers.
  const byKey = new Map();
  rows.forEach((r, i) => {
    const g = byKey.get(r.key);
    if (g) g.push(i);
    else byKey.set(r.key, [i]);
  });
  const drop = new Set();
  const conflicts = [];
  let dupes = 0;
  for (const idx of byKey.values()) {
    if (idx.length < 2) continue;
    const labels = new Set(idx.map((i) => rows[i].label));
    if (labels.size > 1) {
      conflicts.push(idx);
      idx.forEach((i) => drop.add(i));
    } else {
      idx.slice(1).forEach((i) => drop.add(i));
      dupes += idx.length - 1;
    }
  }
  if (dupes) done.push(`${plural(dupes, "doublon")} écarté${dupes > 1 ? "s" : ""} (le même enregistrement étiqueté deux fois)`);

  // 2. One artist making up most of a genre: its newest tracks are kept up to
  //    the cap, the rest sit this run out.
  let live = rows.map((_, i) => i).filter((i) => !drop.has(i));
  const perLabel = new Map();
  for (const i of live) {
    const l = rows[i].label;
    if (!perLabel.has(l)) perLabel.set(l, []);
    perLabel.get(l).push(i);
  }
  const capped = {};
  for (const [label, idx] of perLabel) {
    const cap = Math.max(ARTIST_CAP_MIN, Math.ceil(idx.length * ARTIST_SHARE_MAX));
    const seen = new Map();
    for (const i of idx) {
      const a = rows[i].artist;
      if (!a) continue;
      const k = (seen.get(a) || 0) + 1;
      seen.set(a, k);
      if (k > cap) {
        drop.add(i);
        capped[label] = (capped[label] || 0) + 1;
      }
    }
  }
  const cappedNames = Object.keys(capped);
  if (cappedNames.length) {
    const total = Object.values(capped).reduce((a, b) => a + b, 0);
    done.push(
      `${plural(total, "titre")} d'un artiste surreprésenté mis de côté (${list(cappedNames)}), pour que le modèle apprenne le genre et pas l'artiste`
    );
  }

  // 3. Genres too thin to learn or to test.
  live = rows.map((_, i) => i).filter((i) => !drop.has(i));
  const count = new Map();
  for (const i of live) count.set(rows[i].label, (count.get(rows[i].label) || 0) + 1);
  const excluded = [...count].filter(([, n]) => n < MIN_EXAMPLES).map(([l]) => l).sort();
  if (excluded.length)
    done.push(`${list(excluded)} pas encore appris (moins de ${MIN_EXAMPLES} titres)`);
  const out = new Set(excluded);
  const keep = live.filter((i) => !out.has(rows[i].label));
  return { keep, done, excluded, conflicts, capped };
}

/** Whether whole artists can be held out: most genres need two artists. */
export function canGroup(rows, keep) {
  const artists = new Map();
  let known = 0;
  for (const i of keep) {
    const r = rows[i];
    if (r.artist) known++;
    if (!artists.has(r.label)) artists.set(r.label, new Set());
    artists.get(r.label).add(r.artist || `#${i}`);
  }
  if (!keep.length || known < keep.length * 0.8) return false;
  const sets = [...artists.values()];
  return sets.filter((s) => s.size >= 2).length >= Math.max(2, Math.ceil(sets.length * 0.75));
}

/**
 * The tracks whose label the held-out head disagrees with, most confident
 * disagreement first.
 * @param heldProbs Float32Array n*C (NaN where not held out)
 * @param y         Int32Array n
 * @returns [{row, label, predicted, own, other}]
 */
export function suspects(heldProbs, y, labels, max = 30) {
  if (!heldProbs) return [];
  const C = labels.length;
  const out = [];
  for (let i = 0; i < y.length; i++) {
    if (y[i] < 0) continue; // an untagged row (self-training) has no label to doubt
    const own = heldProbs[i * C + y[i]];
    if (!Number.isFinite(own) || own >= SUSPECT_OWN) continue;
    let best = -1;
    for (let k = 0; k < C; k++) if (k !== y[i] && (best < 0 || heldProbs[i * C + k] > heldProbs[i * C + best])) best = k;
    const other = heldProbs[i * C + best];
    if (other >= SUSPECT_OTHER) out.push({ row: i, label: labels[y[i]], predicted: labels[best], own, other });
  }
  out.sort((a, b) => b.other - a.other);
  return out.slice(0, max);
}

/**
 * @param m        head.metrics (balanced, fitBalanced, perClass, grouped…)
 * @param extra    { prep (prepare's result), stratified (balanced with
 *                   ordinary folds when the headline is by artist),
 *                   suspects: [..], mode: what auto chose and why }
 * @returns { level: "good"|"watch"|"poor", headline, issues: [{severity,
 *            title, detail, action}], done: [sentence] }
 */
export function assess(m, extra = {}) {
  const issues = [];
  const bal = m.balanced || 0;
  const gap = Number.isFinite(m.fitBalanced) ? m.fitBalanced - bal : 0;

  if (gap >= GAP_WATCH)
    issues.push({
      code: "overfit",
      severity: gap >= GAP_BAD ? "bad" : "watch",
      title: "Le modèle apprend ses exemples par cœur",
      detail: `${Math.round((m.fitBalanced || 0) * 100)} % sur les titres qu'il a vus, ${Math.round(bal * 100)} % sur les autres.`,
      action: "Il lui faut des exemples plus variés : d'autres artistes, d'autres albums, pour chaque genre.",
    });

  if (Number.isFinite(extra.stratified) && m.grouped && extra.stratified - bal >= ARTIST_EFFECT_WATCH)
    issues.push({
      code: "artist",
      severity: "watch",
      title: "Il reconnaît surtout des artistes",
      detail: `${Math.round(extra.stratified * 100)} % sur des artistes déjà entendus, ${Math.round(bal * 100)} % sur des inconnus.`,
      action: "Étiqueter quelques titres d'autres artistes dans chaque genre.",
    });

  const solo = (m.perClass || []).filter((c) => c.artists === 1).map((c) => c.label);
  if (m.grouped && solo.length)
    issues.push({
      code: "solo",
      severity: "watch",
      title: solo.length > 1 ? "Des genres n'ont qu'un artiste" : `« ${solo[0]} » n'a qu'un artiste`,
      detail: solo.length > 1 ? list(solo) : "Rien ne prouve encore que le modèle connaît le genre plutôt que cet artiste.",
      action: "Un ou deux titres d'un autre artiste suffisent.",
    });

  const weak = (m.perClass || [])
    .filter((c) => c.recall < WEAK_RECALL && !(m.grouped && c.artists === 1))
    .sort((a, b) => a.recall - b.recall)
    .map((c) => c.label);
  if (weak.length)
    issues.push({
      code: "weak",
      severity: "watch",
      title: weak.length > 1 ? "Genres encore mal reconnus" : `« ${weak[0]} » est encore mal reconnu`,
      detail: weak.length > 1 ? list(weak, 4) : "Reconnu moins d'une fois sur deux.",
      action: "Plus d'exemples de ces genres — et un coup d'œil aux confusions.",
    });

  const sus = extra.suspects || [];
  if (sus.length)
    issues.push({
      code: "suspects",
      severity: "info",
      title: `${plural(sus.length, "étiquette")} à revérifier`,
      detail: "Le modèle, sans les avoir vus, les classe ailleurs avec assurance : erreur d'étiquette, ou titre vraiment à part.",
      action: "review",
    });

  const conflicts = extra.prep?.conflicts?.length || 0;
  if (conflicts)
    issues.push({
      code: "conflict",
      severity: "watch",
      title: `${plural(conflicts, "enregistrement")} étiqueté${conflicts > 1 ? "s" : ""} de deux façons`,
      detail: "Le même son porte deux genres différents ; il est laissé hors de l'entraînement.",
      action: "Choisir un seul genre pour ces titres.",
    });

  if (bal < POOR_BALANCED)
    issues.unshift({
      code: "poor",
      severity: "bad",
      title: "Trop peu fiable pour être servi",
      detail: `Il ne reconnaît le bon genre que ${Math.round(bal * 100)} % du temps, à poids égal par genre.`,
      action: "Étiqueter davantage avant d'envoyer — le serveur garderait sinon des verdicts faux.",
    });

  const rank = { bad: 0, watch: 1, info: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const level = issues.some((i) => i.severity === "bad") ? "poor" : issues.some((i) => i.severity === "watch") ? "watch" : "good";
  const headline =
    level === "good"
      ? `Fiable : ${Math.round(bal * 100)} % de bonnes réponses sur des titres qu'il n'a pas vus`
      : level === "watch"
        ? `Utilisable, à surveiller : ${Math.round(bal * 100)} % sur des titres qu'il n'a pas vus`
        : `Peu fiable : ${Math.round(bal * 100)} % sur des titres qu'il n'a pas vus`;
  const done = [...(extra.prep?.done || [])];
  if (extra.mode) done.push(extra.mode);
  return { level, headline, issues: issues.slice(0, 3), more: Math.max(0, issues.length - 3), done };
}

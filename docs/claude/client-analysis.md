# Analysis on the client PC (WASM): state, findings, what blocks it

> Part of the project docs split out of CLAUDE.md (index: `CLAUDE.md`). Read when: working on running the analysis in the browser (Rust/WASM), on `deezer/measure.py`, or on anything that changes how `centroid/spread/flatness/entropy/rolloff/flux` are measured.

**Status: NOT built.** The goal (measure, embed and classify on the admin's PC, results pushed per
track, resumable) hit a numerical wall that has to be decided before any Rust is written.

## What was established (measured, `supysonic/deezer/measure.py`)

`analysis._spectral` takes its numbers from ffmpeg's `aspectralstats` run on the SOURCE signal (its
own rate, every channel, pooled). Frame by frame against ffmpeg, a numpy twin reproduces:

- the framing: 2048-sample symmetric Hann window, hop 1024, the first frame half silence;
  magnitude = `|rfft|/2048` over the first 1024 bins (Nyquist excluded), `f[k] = k·rate/2048`;
- **centroid, spread, skewness, kurtosis, mean, crest** — to rounding;
- **rolloff** = `f[first k where cumsum(m) ≥ 0.85·Σm]` — exact;
- **flux** = `‖m − m_prev‖₂` (first frame against zeros) — exact.

On 30 real files the per-track medians agree to ~0.1% for centroid / spread / rolloff / flux_peak
on mp3 and ogg, but drift 4–8% on some loud files (not understood: not channel pooling, not the
rate; probably a clipping/float-range difference in decode).

## What cannot be matched

- **entropy**: no definition tried (Shannon of m, m², √m, other normalisations, lags) reproduces
  ffmpeg's value; the best is correlation ~0.8 with Shannon-of-m. The classifier's hard-dance rules
  (zaag, frenchcore, uptempo, krach, pieep, tribe, hardtekk — 12 of them) read it in tight
  windows (0.32–0.78).
- **flatness**: matches on a synthetic signal and on some frames, but on real, low-passed material
  (mp3/ogg with a 16 kHz cut) the per-track median differs 3–6× (0.104 vs 0.038): the geometric mean
  is dominated by bins at the FFT's float32 noise floor, which is a property of ffmpeg's FFT, not of the
  music. A browser's FFT and Opus decode have another floor. `flatness`/`flatness_hi` are also read by
  the hard families.

So a client implementation is NOT interchangeable with the server's ffmpeg numbers, and the
classifier's thresholds were fitted on ffmpeg's. Two ways out, decided with the owner (chosen:
"our own measures everywhere"): replace the two descriptors with ones we define (a floor-robust
flatness, a Shannon entropy) in BOTH the server (numpy) and the client (Rust), bump
`ANALYSIS_VERSION`, and **re-fit the rules that read them on real hard-dance tracks** — which needs
data from the owner's library, not from this repo.

## The tool for that: `supysonic-cli deezer measure-compare`

Writes `measure-compare.csv`: for N archived tracks spread over the library, ffmpeg's descriptors
next to `measure.py`'s, with the track's style. Run it on the real library (a few hundred tracks across
the hard genres), keep the CSV; the new definitions and thresholds are fitted on it.

## What remains once the descriptors are settled

1. Rust crate `webapp/measure` (no dependencies, like `trainer`): the descriptors above, EBU R128
   LUFS/LRA (replacing ebur128), the beat tracker (port of `deezer/beats.py`, 577 lines of numpy),
   the log-mel front-end + patch aggregation (`embedding._log_mel_patches`, `_aggregate`); parity
   tests against the Python twin on fixtures.
2. The embedding network itself runs through onnxruntime-web on the operator's own `.onnx`, served
   to the admin only (its licence is non-commercial and no-derivatives: unmodified, operator's copy).
3. Client runner: Opus 64 k in Range blocks (resumable), decode, worker pool, throttle, results
   pushed per track (`POST /api/analysis/<id>/measures`, version-checked, validated), then the SERVER
   classifies from the stored measures (tag, head and heuristic live there; one decision function
   for both modes).
4. A `where` setting (server | client) so the nightly window and the client runner never both work.

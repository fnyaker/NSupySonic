#!/usr/bin/env python3
"""The server's whole-file tempo estimator, scored on material with an answer.

    python tools/tempo_eval.py DIR            # score what is in DIR
    python tools/tempo_eval.py --render DIR   # render it first (needs node + ffmpeg)

DIR holds the arranged records of webapp/test/songs.mjs as WAV files plus their
truth.json (webapp/test/eval/render-wavs.mjs writes both), and a tones/
directory of steady sounds that have NO beat — held notes, a held chord, a
detuned-saw pad — which --render also makes with ffmpeg. Any other audio file
dropped in DIR/real is measured and listed without a verdict.

It scores analysis._measure_tempo, which is the beat tracker (deezer/beats.py)
when numpy is installed and the envelope estimator otherwise. A change to
either is an ANALYSIS_VERSION bump that re-measures every library; run this before and after, and compare.
"""

import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TONES = {
    **{f"tone{f}": f"sine=frequency={f}:sample_rate=44100:duration=30" for f in (40, 55, 82, 110, 147, 220)},
    "chord": "aevalsrc='0.25*sin(2*PI*55*t)+0.2*sin(2*PI*82.4*t)+0.15*sin(2*PI*110*t)':s=44100:d=30",
    "sawpad": "aevalsrc='0.3*(2*mod(110*t\\,1)-1)+0.3*(2*mod(110.7*t\\,1)-1)+0.3*(2*mod(109.4*t\\,1)-1)':s=44100:d=30",
}


def render(out):
    subprocess.run(["node", "test/eval/render-wavs.mjs", out], cwd=os.path.join(ROOT, "webapp"), check=True)
    tones = os.path.join(out, "tones")
    os.makedirs(tones, exist_ok=True)
    for name, graph in TONES.items():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", graph, os.path.join(tones, name + ".wav")], check=True)


def verdict(bpm, conf, ref, no_beat):
    if no_beat:
        return "ok" if bpm is None or conf < 0.1 else "PHANTOM"
    if bpm is None:
        return "MISS"
    r = bpm / ref
    if abs(r - 1) < 0.035:
        return "ok"
    for k, name in ((2, "x2"), (0.5, "/2"), (1.5, "x3/2"), (2 / 3, "x2/3"), (3, "x3"), (1 / 3, "/3")):
        if abs(r / k - 1) < 0.035:
            return "octave " + name
    return "WRONG"


def no_deezer(dirpath):
    """Two columns: the tracker alone, and the tracker with a perfect Deezer witness.

    Deezer publishes no figure for nearly all of a hard-dance library (see
    deezer/analysis.py), so the first column is what those tracks get. The
    witness only ever settles the octave (``_reconcile_tracked``).
    """
    from supysonic.deezer.analysis import _measure_tempo, _reconcile_tracked

    truth = json.load(open(os.path.join(dirpath, "truth.json")))
    print(f"{'record':32s} {'truth':>7s} {'alone':>8s}  {'verdict':10s} {'witnessed':>9s}  verdict")
    alone_ok = wit_ok = n = 0
    for rid, t in truth.items():
        if t["noBeat"]:
            continue
        bpm, conf, _g = _measure_tempo(os.path.join(dirpath, rid + ".wav"))
        v1 = verdict(bpm, conf, t["bpm"], False)
        if bpm is None:
            wit, v2 = None, v1
        else:
            wit, _c, _s = _reconcile_tracked(t["bpm"], bpm, conf)
            v2 = verdict(wit, conf, t["bpm"], False)
        n += 1
        alone_ok += v1 == "ok"
        wit_ok += v2 == "ok"
        print(f"{rid:32s} {t['bpm']:>7} {str(bpm):>8s}  {v1:10s} {str(wit):>9s}  {v2}")
    print(f"\nrecords with a beat: {n} | tracker alone {alone_ok}/{n} exact | "
          f"with a Deezer witness {wit_ok}/{n}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dir")
    ap.add_argument("--render", action="store_true")
    ap.add_argument(
        "--no-deezer",
        action="store_true",
        help="score the tracker with NO Deezer figure, next to the same records "
        "reconciled with a Deezer figure equal to the truth (the best Deezer can do)",
    )
    a = ap.parse_args()
    if a.no_deezer:
        return no_deezer(a.dir)
    if a.render:
        render(a.dir)
    from supysonic.deezer.analysis import _measure_tempo

    rows = []
    truth = json.load(open(os.path.join(a.dir, "truth.json")))
    for rid, t in truth.items():
        bpm, conf, _grid = _measure_tempo(os.path.join(a.dir, rid + ".wav"))
        rows.append((rid, t["bpm"], t["noBeat"], bpm, conf, verdict(bpm, conf, t["bpm"], t["noBeat"])))
    tones = os.path.join(a.dir, "tones")
    for name in sorted(os.listdir(tones)) if os.path.isdir(tones) else []:
        bpm, conf, _grid = _measure_tempo(os.path.join(tones, name))
        rows.append(("tone:" + name, None, True, bpm, conf, verdict(bpm, conf, None, True)))
    real = os.path.join(a.dir, "real")
    for name in sorted(os.listdir(real)) if os.path.isdir(real) else []:
        bpm, conf, _grid = _measure_tempo(os.path.join(real, name))
        rows.append(("real:" + name[:30], "?", False, bpm, conf, ""))
    for rid, ref, nb, bpm, conf, v in rows:
        want = "no beat" if nb else str(ref)
        print(f"{rid:38s} {want:>8s}  measured {str(bpm):>7s} conf {conf:.2f}  {v}")
    beat = [r for r in rows if r[1] not in (None, "?") and not r[2]]
    print(
        f"\nwith a beat: {sum(r[5] == 'ok' for r in beat)}/{len(beat)} right, "
        f"{sum(r[5].startswith('octave') for r in beat)} octave, "
        f"{sum(r[5] in ('WRONG', 'MISS') for r in beat)} wrong | "
        f"phantoms: {sum(r[5] == 'PHANTOM' for r in rows)}"
    )


if __name__ == "__main__":
    main()

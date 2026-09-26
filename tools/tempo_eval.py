#!/usr/bin/env python3
"""The server's whole-file tempo estimator, scored on material with an answer.

    python tools/tempo_eval.py DIR            # score what is in DIR
    python tools/tempo_eval.py --render DIR   # render it first (needs node + ffmpeg)

DIR holds the arranged records of webapp/test/songs.mjs as WAV files plus their
truth.json (webapp/test/eval/render-wavs.mjs writes both), and a tones/
directory of steady sounds that have NO beat — held notes, a held chord, a
detuned-saw pad — which --render also makes with ffmpeg. Any other audio file
dropped in DIR/real is measured and listed without a verdict.

A change to supysonic/deezer/analysis.py's tempo pass is an ANALYSIS_VERSION
bump that re-measures every library; run this before and after, and compare.
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


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dir")
    ap.add_argument("--render", action="store_true")
    a = ap.parse_args()
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

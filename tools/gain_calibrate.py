#!/usr/bin/env python3
"""Deezer's GAIN against the loudness measured on the files.

    python tools/gain_calibrate.py [--config supysonic.conf]

For every track that has both a ``Track.gain`` and an analysed ``lufs``, prints
the median and spread of ``gain - lufs``. ``analysis.GAIN_FROM_LUFS_OFFSET`` is
that median: ``gain = lufs + offset`` then gives the player the level it has
today. Run it BEFORE the first analysis pass overwrites the Deezer gains.
"""

import argparse
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", default=None)
    a = ap.parse_args()
    from supysonic.config import IniConfig
    from supysonic.db import Track, TrackAnalysis, init_database
    from supysonic.deezer.analysis import GAIN_FROM_LUFS_OFFSET

    config = IniConfig.from_common_locations() if not a.config else IniConfig(a.config)
    init_database(config.BASE["database_uri"])
    diffs = []
    q = TrackAnalysis.select(TrackAnalysis.data, Track.gain).join(Track).where(
        Track.gain.is_null(False)
    )
    for row in q.objects():
        try:
            lufs = json.loads(row.data or "{}").get("lufs")
        except ValueError:
            continue
        if lufs is not None and lufs > -70:
            diffs.append(row.gain - lufs)
    if not diffs:
        print(f"No track has both figures. Theoretical offset kept: {GAIN_FROM_LUFS_OFFSET}")
        return
    med = statistics.median(diffs)
    sd = statistics.pstdev(diffs)
    print(f"{len(diffs)} tracks: median(gain - lufs) = {med:+.2f} dB, sd {sd:.2f} dB")
    print(f"current GAIN_FROM_LUFS_OFFSET = {GAIN_FROM_LUFS_OFFSET}")


if __name__ == "__main__":
    main()

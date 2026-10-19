#!/usr/bin/env python3
"""How much of the archive has synced lyrics, plain ones, or none.

    python tools/lyrics_coverage.py [--config supysonic.conf]

Reads the ``.lrc`` sidecars only: no network.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", default=None)
    a = ap.parse_args()
    from supysonic.config import IniConfig
    from supysonic.db import Track, init_database
    from supysonic.deezer import lyrics

    config = IniConfig.from_common_locations() if not a.config else IniConfig(a.config)
    init_database(config.BASE["database_uri"])
    n = {"synced": 0, "plain": 0, "none": 0}
    for t in Track.select(Track.path):
        if not t.path or not os.path.isfile(t.path):
            continue
        lyr = lyrics.read_sidecar(t)
        n["synced" if lyr and lyr.get("synced") else "plain" if lyr else "none"] += 1
    total = sum(n.values()) or 1
    for k, v in n.items():
        print(f"{k:7s} {v:7d}  {100 * v / total:5.1f}%")


if __name__ == "__main__":
    main()

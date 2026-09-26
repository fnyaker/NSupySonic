#!/usr/bin/env python3
# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Print the Python requirements of the image, read from setup.cfg alone.

    python docker/requirements.py postgresql embedding > requirements.txt

The Dockerfile installs these in a layer of their own, BEFORE the source is
copied in: the ~120 MB of wheels (onnxruntime, numpy, Pillow, psycopg2) then
come from the layer cache on every build that did not touch setup.cfg,
instead of being downloaded and unpacked again — under QEMU, for arm64 —
because a comment changed somewhere in the tree. The package itself is then
installed with --no-deps, and `pip check` in the same layer fails the build if
this list ever falls short of what setup.cfg declares.

tests/test_harness.py checks the output against the package's own metadata.
"""

import configparser
import os
import sys


def requirements(setup_cfg, extras):
    cfg = configparser.ConfigParser()
    if not cfg.read(setup_cfg):
        raise SystemExit(f"cannot read {setup_cfg}")

    def lines(value):
        # configparser keeps full-line comments inside a multi-line value.
        return [
            line.strip()
            for line in value.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]

    out = lines(cfg["options"]["install_requires"])
    declared = cfg["options.extras_require"]
    for extra in extras:
        if extra not in declared:
            raise SystemExit(f"setup.cfg declares no extra named {extra!r}")
        out += lines(declared[extra])
    return out


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(here, "setup.cfg"), os.path.join(here, "..", "setup.cfg")]
    setup_cfg = next((p for p in candidates if os.path.isfile(p)), candidates[0])
    print("\n".join(requirements(setup_cfg, argv)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Run the unittest suite across several processes.

    python tools/partest.py                 # all of it, one worker per core
    python tools/partest.py -j8             # pick the worker count
    python tools/partest.py tests.test_webui tests.test_deezer
    python tools/partest.py --coverage      # under coverage; then: coverage combine

Two decisions shape this:

**Processes, not threads.** ``supysonic.db`` keeps the peewee database on a
module global and every test case rebinds it to its own temporary SQLite file in
setUp, so two test cases sharing an interpreter would fight over it. One
interpreter per batch is the only safe split — and it also means a segfault
takes out one batch instead of the whole run.

**Exactly `-j` processes, each given a pre-balanced batch** — not one process
per test class. Importing Flask, peewee and supysonic costs a second or two of
CPU *per interpreter*, and the suite has ~40 test classes: a process each burned
more CPU on imports than it saved in parallelism (measured: 310s of CPU for a
185s suite, and barely 1.8x). Paying that cost `-j` times instead is what makes
the difference.

Batches are packed longest-first into the emptiest worker (LPT) using per-test
timings recorded in ``.partest-timings.json``. The first run has no timings and
packs by test count; from the second run on it packs by measured time, which
matters because the suite is lopsided — ``tests/base/test_watcher`` alone is a
third of the wall clock, since its tests wait on real filesystem events.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMINGS = os.path.join(ROOT, ".partest-timings.json")
# Running this as a script puts tools/ on sys.path, not the repo root, so
# `partest.py tests.test_webui` couldn't import its own targets. (The no-target
# path never noticed: discover() puts top_level_dir on the path itself.)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
# What we assume a test costs before we've ever timed it.
DEFAULT_TEST_SECONDS = 0.4


def collect(targets):
    """({TestCase class -> [test ids]}, [ids that failed to import])."""
    loader = unittest.TestLoader()
    if targets:
        suite = loader.loadTestsFromNames(targets)
    else:
        suite = loader.discover(start_dir=os.path.join(ROOT, "tests"), top_level_dir=ROOT)

    classes: dict[str, list[str]] = {}
    errors: list[str] = []

    def walk(s):
        for item in s:
            if isinstance(item, unittest.TestSuite):
                walk(item)
                continue
            # A module that fails to import is loaded as a _FailedTest; keep it
            # so the run reports the import error instead of silently skipping.
            if type(item).__name__ == "_FailedTest":
                errors.append(item.id())
                continue
            cls = type(item)
            classes.setdefault(f"{cls.__module__}.{cls.__qualname__}", []).append(item.id())

    walk(suite)
    return classes, errors


def pack(classes, timings, jobs):
    """Balance the test classes into `jobs` batches, longest-first (LPT).

    Whole classes are kept together where they fit — their tests share fixtures
    and warm the same caches. A class heavy enough to unbalance the run on its
    own is split across batches instead; that is always correct, since each
    batch is its own interpreter and setUpClass simply runs again.
    """

    def cost(ids):
        return sum(timings.get(i, DEFAULT_TEST_SECONDS) for i in ids)

    items = sorted(((cost(ids), name, ids) for name, ids in classes.items()), reverse=True)
    total = sum(c for c, _, _ in items)
    # Anything above a fair share leaves every other worker idle at the end, so
    # break it up. The small slack keeps ordinary classes whole while still
    # splitting the one that would otherwise set the floor for the whole run
    # (here: the watcher tests, which are nothing but sleeps waiting on real
    # filesystem events, and so are both the longest class and the easiest to
    # spread).
    limit = (total / jobs) * 1.05 if jobs > 1 else float("inf")

    units = []  # (cost, [ids])
    for c, _name, ids in items:
        if c <= limit or len(ids) < 2:
            units.append((c, ids))
            continue
        parts = min(int(c // limit) + 1, len(ids))
        size = -(-len(ids) // parts)
        for i in range(0, len(ids), size):
            batch = ids[i : i + size]
            units.append((cost(batch), batch))
    units.sort(reverse=True, key=lambda u: u[0])

    batches = [[0.0, []] for _ in range(jobs)]
    for c, ids in units:
        light = min(batches, key=lambda b: b[0])
        light[0] += c
        light[1].extend(ids)
    return [(round(c, 1), ids) for c, ids in batches if ids]


def run_batch(index, ids, coverage):
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as fh:
        timings_path = fh.name
    cmd = [sys.executable]
    if coverage:
        # -p keeps one data file per process; the caller runs `coverage combine`.
        cmd += ["-m", "coverage", "run", "-p"]
    cmd += ["-m", "tools._partest_worker", timings_path, *ids]
    t0 = time.time()
    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        with open(timings_path) as fh:
            measured = json.load(fh)
    except (OSError, ValueError):
        measured = {}
    finally:
        try:
            os.unlink(timings_path)
        except OSError:
            pass
    return index, proc.returncode, proc.stdout + proc.stderr, time.time() - t0, measured


def parse_counts(output):
    """(tests, failures, errors, skipped) from a unittest tail."""
    tests = fails = errs = skips = 0
    for line in output.splitlines():
        if line.startswith("Ran ") and " test" in line:
            try:
                tests += int(line.split()[1])
            except (IndexError, ValueError):
                pass
        elif line.startswith("FAILED (") or line.startswith("OK ("):
            body = line[line.index("(") + 1 : line.rindex(")")]
            for part in body.split(","):
                key, _, val = part.strip().partition("=")
                try:
                    n = int(val)
                except ValueError:
                    continue
                if key == "failures":
                    fails += n
                elif key == "errors":
                    errs += n
                elif key in ("skipped", "skip"):
                    skips += n
    return tests, fails, errs, skips


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("targets", nargs="*", help="test ids to run (default: the whole suite)")
    ap.add_argument("-j", "--jobs", type=int, default=0, help="workers (default: one per core)")
    ap.add_argument("--coverage", action="store_true", help="run under `coverage run -p`")
    ap.add_argument("-q", "--quiet", action="store_true", help="summary and failures only")
    args = ap.parse_args()

    classes, import_errors = collect(args.targets)
    if not classes:
        print("no tests found")
        for eid in import_errors:
            print(f"  could not import: {eid}")
        return 1

    try:
        with open(TIMINGS) as fh:
            timings = json.load(fh)
    except (OSError, ValueError):
        timings = {}
        print("(no timings yet — this run packs by test count and records them)")

    jobs = args.jobs or (os.cpu_count() or 4)
    batches = pack(classes, timings, max(1, jobs))
    total_tests = sum(len(ids) for ids in classes.values())
    print(f"{total_tests} tests across {len(batches)} workers\n")

    t0 = time.time()
    results = []
    # One thread per worker, each blocking on its subprocess: the work is in the
    # children, so these threads only wait.
    with ThreadPoolExecutor(max_workers=len(batches)) as pool:
        futures = [
            pool.submit(run_batch, i, ids, args.coverage)
            for i, (_, ids) in enumerate(batches)
        ]
        for fut in futures:
            index, code, output, secs, measured = fut.result()
            timings.update(measured)
            results.append((index, code, output, secs))
            if not args.quiet:
                mark = "ok  " if code == 0 else "FAIL"
                print(
                    f"  {mark} worker {index + 1}: {len(batches[index][1]):3d} tests, "
                    f"{secs:6.1f}s (estimated {batches[index][0]:.0f}s)"
                )
    wall = time.time() - t0

    try:
        with open(TIMINGS, "w") as fh:
            json.dump(timings, fh, indent=0, sort_keys=True)
    except OSError:
        pass

    ran = fails = errs = skips = 0
    bad = []
    for index, code, output, _ in results:
        t, f, e, s = parse_counts(output)
        ran += t
        fails += f
        errs += e
        skips += s
        if code != 0:
            bad.append((index, output))

    if bad:
        print("\n" + "=" * 70)
        for index, output in bad:
            print(f"\n---- worker {index + 1} ----")
            print(output.strip())
    for eid in import_errors:
        print(f"\n---- could not import: {eid} ----")

    slowest = max((secs for _, _, _, secs in results), default=0.0)
    print(f"\nRan {ran} tests in {wall:.1f}s (slowest worker {slowest:.1f}s)")
    if skips:
        print(f"skipped {skips}")
    ok = not bad and not import_errors
    print("OK" if ok else f"FAILED (failures={fails}, errors={errs + len(import_errors)})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

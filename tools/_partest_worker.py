# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""One partest worker: run a batch of tests and report how long each took.

Invoked as ``python -m tools._partest_worker <timings.json> <test id>...``.
The timings are what lets the next run pack the batches evenly, so they're
written even when the batch fails.
"""

from __future__ import annotations

import json
import sys
import time
import unittest


class _TimingResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.timings = {}
        self._start = 0.0

    def startTest(self, test):
        self._start = time.perf_counter()
        super().startTest(test)

    def stopTest(self, test):
        self.timings[test.id()] = round(time.perf_counter() - self._start, 3)
        super().stopTest(test)


def main(argv):
    out, ids = argv[0], argv[1:]
    suite = unittest.TestLoader().loadTestsFromNames(ids)
    runner = unittest.TextTestRunner(resultclass=_TimingResult, verbosity=1)
    result = runner.run(suite)
    try:
        with open(out, "w") as fh:
            json.dump(result.timings, fh)
    except OSError:
        pass
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""What the Docker build assumes about the packaging, checked.

The image installs its dependencies from docker/requirements.py in a cached
layer, then the package with --no-deps. That split is only safe while the
script lists exactly what the package declares — so this compares it with the
metadata pip itself would act on.
"""

import os
import re
import subprocess
import sys
import unittest
from importlib.metadata import PackageNotFoundError, requires

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE_EXTRAS = ("postgresql", "embedding")  # what the Dockerfile asks for


def _normalize(req):
    """'zipstream-ng >=1.1.0, <2.0.0' and 'zipstream-ng<2.0.0,>=1.1.0' alike."""
    req = req.split(";", 1)[0]
    m = re.match(r"\s*([A-Za-z0-9._-]+)\s*(.*)", req)
    name = re.sub(r"[-_.]+", "-", m.group(1)).lower()
    specs = frozenset(s.replace(" ", "") for s in m.group(2).split(",") if s.strip())
    return name, specs


class DockerRequirementsTestCase(unittest.TestCase):
    def _script(self, *extras):
        out = subprocess.run(
            [sys.executable, os.path.join(ROOT, "docker", "requirements.py"), *extras],
            capture_output=True, text=True, check=True, cwd=ROOT,
        ).stdout
        return {_normalize(line) for line in out.splitlines() if line.strip()}

    def test_it_lists_what_the_package_declares(self):
        try:
            declared = requires("supysonic") or []
        except PackageNotFoundError:  # pragma: no cover - not pip-installed
            self.skipTest("supysonic is not installed (pip install -e .)")
        wanted = set()
        for req in declared:
            marker = re.search(r"""extra\s*==\s*["']([^"']+)["']""", req)
            if marker is None or marker.group(1) in IMAGE_EXTRAS:
                wanted.add(_normalize(req))
        self.assertEqual(self._script(*IMAGE_EXTRAS), wanted)

    def test_an_unknown_extra_fails_the_build(self):
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "docker", "requirements.py"), "nope"],
            capture_output=True, text=True, cwd=ROOT,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("nope", proc.stderr)

    def test_the_dockerfile_asks_for_those_extras(self):
        with open(os.path.join(ROOT, "Dockerfile")) as fh:
            dockerfile = fh.read()
        self.assertIn("requirements.py " + " ".join(IMAGE_EXTRAS), dockerfile)


if __name__ == "__main__":
    unittest.main()

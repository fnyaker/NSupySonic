# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot G: the web app keys a track on its UUID. The browser computes the UUID of a
Deezer id itself (``webapp/src/lib/trackkey.js``); these are the values it is
held to, so the two sides cannot drift."""

import re
import unittest
from pathlib import Path

from supysonic.deezer import ids

ROOT = Path(__file__).resolve().parent.parent


class TrackKeyVectors(unittest.TestCase):
    def test_the_js_table_matches_python(self):
        src = (ROOT / "webapp" / "test" / "trackkey.test.mjs").read_text()
        pairs = re.findall(r'"(\d+)": "([0-9a-f-]{36})"', src)
        self.assertGreaterEqual(len(pairs), 6)
        for dz, uuid in pairs:
            self.assertEqual(str(ids.track_uuid(dz)), uuid, dz)

    def test_the_js_namespace_is_python_s(self):
        src = (ROOT / "webapp" / "src" / "lib" / "trackkey.js").read_text()
        m = re.search(r'const NS_TRACK = "([0-9a-f-]{36})"', src)
        self.assertEqual(m.group(1), str(ids.NS_TRACK))


if __name__ == "__main__":
    unittest.main()

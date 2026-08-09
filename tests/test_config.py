# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Config discovery — specifically, which file wins.

The container renders a config from the environment and points at it with
SUPYSONIC_CONFIG. If that file did not override the one baked into the image,
every deployment would silently run on the image's placeholder database
credentials.
"""

import os
import tempfile
import unittest

from supysonic.config import IniConfig


class ConfigOverrideTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.previous = os.environ.get("SUPYSONIC_CONFIG")

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("SUPYSONIC_CONFIG", None)
        else:
            os.environ["SUPYSONIC_CONFIG"] = self.previous

    def _write(self, name, body):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
        return path

    def test_the_env_pointed_config_wins_over_the_discovered_ones(self):
        """This is what keeps the app and the daemon from fighting over one
        rendered file: each points at its own, and its own wins."""
        baked = self._write(
            "baked.conf", "[base]\ndatabase_uri = postgresql://u:placeholder@db/x\n"
        )
        mine = self._write(
            "mine.conf", "[base]\ndatabase_uri = postgresql://u:real@db/x\n"
        )
        os.environ["SUPYSONIC_CONFIG"] = mine

        original = IniConfig.common_paths
        IniConfig.common_paths = [baked]
        try:
            config = IniConfig.from_common_locations()
        finally:
            IniConfig.common_paths = original
        self.assertEqual(config.BASE["database_uri"], "postgresql://u:real@db/x")

    def test_without_the_variable_the_discovered_config_still_applies(self):
        baked = self._write(
            "baked.conf", "[base]\ndatabase_uri = postgresql://u:placeholder@db/x\n"
        )
        os.environ.pop("SUPYSONIC_CONFIG", None)

        original = IniConfig.common_paths
        IniConfig.common_paths = [baked]
        try:
            config = IniConfig.from_common_locations()
        finally:
            IniConfig.common_paths = original
        self.assertEqual(config.BASE["database_uri"], "postgresql://u:placeholder@db/x")

    def test_a_missing_override_is_not_an_error(self):
        """A path that isn't there yet must not stop the process booting."""
        os.environ["SUPYSONIC_CONFIG"] = os.path.join(self.dir, "absent.conf")
        original = IniConfig.common_paths
        IniConfig.common_paths = []
        try:
            config = IniConfig.from_common_locations()
        finally:
            IniConfig.common_paths = original
        self.assertIn("database_uri", config.BASE)  # the built-in default


if __name__ == "__main__":
    unittest.main()

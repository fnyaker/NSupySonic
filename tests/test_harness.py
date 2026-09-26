# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The suite's own shortcuts must not change what the suite is testing.

``tests/__init__.py`` makes the run fast in two ways that reach into
libraries: cheap argon2 parameters (pinned as test-only by
``tests.managers.test_manager_user``) and one compiled werkzeug URL builder per
rule shape instead of one per rule per app. This module pins the second: for
every rule the fully mounted app registers, a URL built through a shared
builder is byte for byte the URL werkzeug's own compilation produces.
"""

import os
import shutil
import tempfile
import unittest
import uuid

from flask import url_for
from werkzeug.routing.rules import Rule

from supysonic.db import release_database
from supysonic.web import create_application

from .testbase import TestConfig

# One value per converter the app's rules actually use (see the assertion in
# test_every_rule_builds_what_werkzeug_builds): an unknown converter must fail
# the test rather than be skipped, or a new route type would go unchecked.
_SAMPLES = {
    "UnicodeConverter": "a b&c",
    "PathConverter": "dir/sub dir/file.flac",
    "IntegerConverter": 1234,
    "FloatConverter": 1.5,
    "UUIDConverter": uuid.UUID(int=0xABCDEF),
}


class SharedUrlBuildersTestCase(unittest.TestCase):
    def _app(self):
        fd, path = tempfile.mkstemp()
        cache = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, cache, True)
        self.addCleanup(os.remove, path)
        self.addCleanup(os.close, fd)
        config = TestConfig(True, True)
        config.BASE["database_uri"] = "sqlite:///" + path
        config.WEBAPP["cache_dir"] = cache
        app = create_application(config)
        release_database()
        return app

    @staticmethod
    def _values(rule):
        return {
            name: _SAMPLES[type(conv).__name__]
            for name, conv in rule._converters.items()
        }

    def test_the_shortcut_is_installed(self):
        # If this fails the suite is merely slow again, not wrong — but it
        # would be slow silently, which is how the cost crept in to begin with.
        self.assertTrue(getattr(Rule._compile_builder, "_shared", False))

    def test_every_rule_builds_what_werkzeug_builds(self):
        app = self._app()
        original = Rule._compile_builder._original
        rules = list(app.url_map.iter_rules())
        self.assertGreater(len(rules), 200)  # both blueprints are mounted

        for rule in rules:
            with self.subTest(rule=rule.rule):
                unknown = {
                    n: type(c).__name__
                    for n, c in rule._converters.items()
                    if type(c).__name__ not in _SAMPLES
                }
                self.assertFalse(unknown, "add a sample for this converter")
                values = self._values(rule)
                fresh = original(rule, False).__get__(rule, None)
                fresh_unknown = original(rule, True).__get__(rule, None)
                self.assertEqual(rule._build(**values), fresh(**values))
                # Unknown arguments become the query string: sorted, encoded.
                extra = dict(values, zeta="1 2", alpha="é&")
                self.assertEqual(
                    rule._build_unknown(**extra), fresh_unknown(**extra)
                )

    def test_url_for_matches_an_app_built_without_the_shortcut(self):
        shared_app = self._app()
        shortcut = Rule._compile_builder
        Rule._compile_builder = shortcut._original
        try:
            plain_app = self._app()
        finally:
            Rule._compile_builder = shortcut

        def urls(app):
            out = {}
            with app.test_request_context():
                for rule in app.url_map.iter_rules():
                    if rule.endpoint == "static":
                        continue
                    values = self._values(rule)
                    out[(rule.endpoint, rule.rule)] = url_for(
                        rule.endpoint, **values, extra="x y"
                    )
            return out

        shared, plain = urls(shared_app), urls(plain_app)
        self.assertEqual(shared.keys(), plain.keys())
        self.assertEqual(shared, plain)

    def test_rules_of_the_same_shape_share_one_function(self):
        # The point of the shortcut: the second app compiles nothing.
        first, second = self._app(), self._app()
        by_rule = {r.rule: r for r in first.url_map.iter_rules()}
        shared = 0
        for rule in second.url_map.iter_rules():
            twin = by_rule.get(rule.rule)
            if twin is None or twin.endpoint != rule.endpoint:
                continue
            self.assertIsNot(twin, rule)  # two apps, two Rule objects...
            self.assertIs(twin._build.__func__, rule._build.__func__)  # ...one builder
            shared += 1
        self.assertGreater(shared, 200)


if __name__ == "__main__":
    unittest.main()

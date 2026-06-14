# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Unit tests for the security hardening primitives (no network, no DB)."""

import hashlib
import os
import shutil
import tempfile
import time
import unittest

from supysonic.cache import Cache
from supysonic.ratelimit import RateLimiter


class CacheKeyTraversalTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cache = Cache(self.dir, 1024 * 1024, min_time=0)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_rejects_traversal_keys(self):
        for bad in ("../x", "..", ".", "a/b", "a\\b", "/abs", "x/../y", ""):
            with self.assertRaises(ValueError):
                self.cache._filepath(bad)

    def test_accepts_plain_key_inside_dir(self):
        p = self.cache._filepath("abc-128.opus")
        self.assertEqual(os.path.dirname(p), os.path.abspath(self.dir))

    def test_set_get_roundtrip_still_works(self):
        self.cache.set("good-key.bin", b"payload")
        self.assertEqual(self.cache.get_value("good-key.bin"), b"payload")


class RateLimiterTestCase(unittest.TestCase):
    def test_blocks_after_threshold(self):
        rl = RateLimiter(max_attempts=3, window=300)
        self.assertFalse(rl.is_blocked("ip"))
        for _ in range(3):
            rl.record_failure("ip")
        self.assertTrue(rl.is_blocked("ip"))

    def test_reset_clears_block(self):
        rl = RateLimiter(max_attempts=2, window=300)
        rl.record_failure("ip")
        rl.record_failure("ip")
        self.assertTrue(rl.is_blocked("ip"))
        rl.reset("ip")
        self.assertFalse(rl.is_blocked("ip"))

    def test_window_expiry_drops_old_failures(self):
        rl = RateLimiter(max_attempts=2, window=0)
        rl.record_failure("ip")
        rl.record_failure("ip")
        time.sleep(0.01)  # window=0 => anything older than "now" is dropped
        self.assertFalse(rl.is_blocked("ip"))

    def test_keys_are_isolated(self):
        rl = RateLimiter(max_attempts=1, window=300)
        rl.record_failure("a")
        self.assertTrue(rl.is_blocked("a"))
        self.assertFalse(rl.is_blocked("b"))


class SafeRedirectTestCase(unittest.TestCase):
    def test_only_local_paths_allowed(self):
        from supysonic.frontend.user import safe_redirect_target

        fallback = "/home"
        self.assertEqual(safe_redirect_target("/playlists", fallback), "/playlists")
        self.assertEqual(safe_redirect_target("/a/b?c=1", fallback), "/a/b?c=1")
        for bad in (
            "https://evil.example",
            "//evil.example",
            "http://x",
            "javascript:alert(1)",
            "evil.example",
            "",
            None,
        ):
            self.assertEqual(safe_redirect_target(bad, fallback), fallback)


class SecretFromEnvTestCase(unittest.TestCase):
    def test_env_secret_takes_precedence_and_avoids_db(self):
        from supysonic.utils import get_secret_key

        os.environ["SUPYSONIC_SECRET_UNITTESTKEY"] = "hunter2"
        try:
            key = get_secret_key("unittestkey")  # unique name -> no cache clash
        finally:
            del os.environ["SUPYSONIC_SECRET_UNITTESTKEY"]
        # Derived purely from the env value (sha256), never touching the DB.
        self.assertEqual(key, hashlib.sha256(b"hunter2").digest())


class ProxyFixTestCase(unittest.TestCase):
    def _make_app(self, hops):
        from tests.testbase import TestConfig
        from supysonic.web import create_application

        cfg = TestConfig(True, True)
        cfg.BASE["database_uri"] = "sqlite:///" + tempfile.mkstemp()[1]
        cfg.WEBAPP["cache_dir"] = tempfile.mkdtemp()
        cfg.WEBAPP["proxy_fix_hops"] = hops
        return create_application(cfg)

    def test_disabled_by_default(self):
        from werkzeug.middleware.proxy_fix import ProxyFix

        app = self._make_app(0)
        self.assertNotIsInstance(app.wsgi_app, ProxyFix)

    def test_enabled_resolves_real_client_ip(self):
        from werkzeug.middleware.proxy_fix import ProxyFix

        app = self._make_app(2)
        self.assertIsInstance(app.wsgi_app, ProxyFix)

        seen = {}

        @app.route("/_probe_ip")
        def _probe():
            from flask import request

            seen["ip"] = request.remote_addr
            return "ok"

        app.testing = True
        app.test_client().get(
            "/_probe_ip",
            headers={"X-Forwarded-For": "203.0.113.7, 10.0.0.1"},
            environ_overrides={"REMOTE_ADDR": "10.0.0.1"},
        )
        self.assertEqual(seen.get("ip"), "203.0.113.7")


if __name__ == "__main__":
    unittest.main()

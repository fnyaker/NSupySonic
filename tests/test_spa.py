# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

import os
import os.path
import shutil
import tempfile
import unittest

from flask import Flask

from supysonic.webui import spa as spa_module
from supysonic.webui.spa import spa


class SpaServeTestCase(unittest.TestCase):
    """Serving rules for the built SPA (with the global nosniff header)."""

    def setUp(self):
        self.dist = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dist, "assets"))
        with open(os.path.join(self.dist, "index.html"), "w") as fh:
            fh.write("<!doctype html><html><body>spa</body></html>")
        with open(os.path.join(self.dist, "assets", "app-abc123.js"), "w") as fh:
            fh.write("console.log(1)")

        self._orig_dist = spa_module.DIST_DIR
        spa_module.DIST_DIR = self.dist

        app = Flask(__name__)
        app.register_blueprint(spa)

        @app.after_request
        def _nosniff(response):  # mirror the real app's security header
            response.headers.setdefault("X-Content-Type-Options", "nosniff")
            return response

        self.client = app.test_client()

    def tearDown(self):
        spa_module.DIST_DIR = self._orig_dist
        shutil.rmtree(self.dist)

    def test_hashed_asset_served_as_js_and_immutable(self):
        rv = self.client.get("/app/assets/app-abc123.js")
        self.assertEqual(rv.status_code, 200)
        # Content-Type is forced by extension, never empty (would be nosniff-blocked).
        # werkzeug appends "; charset=utf-8" to text/* types, which is fine.
        self.assertTrue(
            rv.headers["Content-Type"].startswith("text/javascript"),
            rv.headers["Content-Type"],
        )
        self.assertIn("immutable", rv.headers.get("Cache-Control", ""))

    def test_css_asset_served_with_css_mime(self):
        with open(os.path.join(self.dist, "assets", "app-abc123.css"), "w") as fh:
            fh.write("body{}")
        rv = self.client.get("/app/assets/app-abc123.css")
        self.assertEqual(rv.status_code, 200)
        self.assertTrue(
            rv.headers["Content-Type"].startswith("text/css"),
            rv.headers["Content-Type"],
        )

    def test_missing_asset_404s_instead_of_html_fallback(self):
        # A stale asset hash must NOT be answered with index.html (text/html),
        # which the browser would block as a forbidden MIME type under nosniff.
        rv = self.client.get("/app/assets/stale-deadbeef.js")
        self.assertEqual(rv.status_code, 404)

    def test_unknown_route_serves_index_with_no_cache(self):
        rv = self.client.get("/app/some/deep/link")
        self.assertEqual(rv.status_code, 200)
        self.assertIn("text/html", rv.headers["Content-Type"])
        self.assertEqual(rv.headers.get("Cache-Control"), "no-cache")

    def test_webmanifest_served_with_manifest_mime(self):
        # The PWA manifest must carry an explicit type; under nosniff a generic
        # octet-stream would be rejected by some browsers for rel=manifest.
        with open(os.path.join(self.dist, "manifest.webmanifest"), "w") as fh:
            fh.write('{"name":"x"}')
        rv = self.client.get("/app/manifest.webmanifest")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.headers["Content-Type"], "application/manifest+json")

    # -- precompressed copies (vite.config.js#precompress) --------------------

    def _write_encoded(self, name, body):
        """The build's three copies of one file: plain, .br, .gz. The .br is
        not real brotli (the stdlib has none) — what is tested is which copy
        is chosen and how it is labelled, not the codec."""
        import gzip

        path = os.path.join(self.dist, "assets", name)
        with open(path, "wb") as fh:
            fh.write(body)
        with open(path + ".br", "wb") as fh:
            fh.write(b"BR:" + body[:40])
        with open(path + ".gz", "wb") as fh:
            fh.write(gzip.compress(body))
        return path

    def test_the_smallest_accepted_copy_is_served(self):
        import gzip

        body = b"console.log('a bundle');" * 400
        self._write_encoded("big-abc.js", body)
        rv = self.client.get("/app/assets/big-abc.js", headers={"Accept-Encoding": "gzip, deflate, br"})
        self.assertEqual(rv.headers.get("Content-Encoding"), "br")
        self.assertEqual(rv.get_data(), b"BR:" + body[:40])
        # The type is the FILE's, never the encoding's, and it stays immutable.
        self.assertTrue(rv.headers["Content-Type"].startswith("text/javascript"))
        self.assertIn("immutable", rv.headers.get("Cache-Control", ""))
        self.assertIn("Accept-Encoding", rv.headers.get("Vary", ""))

        rv = self.client.get("/app/assets/big-abc.js", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(rv.headers.get("Content-Encoding"), "gzip")
        self.assertEqual(gzip.decompress(rv.get_data()), body)

        # br refused explicitly (q=0) is refused.
        rv = self.client.get("/app/assets/big-abc.js", headers={"Accept-Encoding": "br;q=0, gzip"})
        self.assertEqual(rv.headers.get("Content-Encoding"), "gzip")

        rv = self.client.get("/app/assets/big-abc.js", headers={"Accept-Encoding": "identity"})
        self.assertIsNone(rv.headers.get("Content-Encoding"))
        self.assertEqual(rv.get_data(), body)
        self.assertIn("Accept-Encoding", rv.headers.get("Vary", ""))

    def test_wasm_is_served_precompressed_with_its_own_type(self):
        self._write_encoded("core-abc.wasm", b"\0asm" + bytes(3000))
        rv = self.client.get("/app/assets/core-abc.wasm", headers={"Accept-Encoding": "br"})
        self.assertEqual(rv.headers.get("Content-Encoding"), "br")
        self.assertEqual(rv.headers["Content-Type"], "application/wasm")

    def test_a_file_with_no_compressed_copy_is_served_plain(self):
        rv = self.client.get("/app/assets/app-abc123.js", headers={"Accept-Encoding": "gzip, br"})
        self.assertIsNone(rv.headers.get("Content-Encoding"))
        self.assertEqual(rv.get_data(), b"console.log(1)")

    def test_images_are_never_given_an_encoding(self):
        path = os.path.join(self.dist, "assets", "pic.png")
        with open(path, "wb") as fh:
            fh.write(b"\x89PNG" + bytes(4000))
        with open(path + ".gz", "wb") as fh:
            fh.write(b"not for images")
        rv = self.client.get("/app/assets/pic.png", headers={"Accept-Encoding": "gzip"})
        self.assertIsNone(rv.headers.get("Content-Encoding"))
        self.assertNotIn("Accept-Encoding", rv.headers.get("Vary", ""))

    def test_a_compressed_copy_is_not_a_route_out_of_the_build(self):
        secret = os.path.join(os.path.dirname(self.dist), "secret.js.gz")
        with open(secret, "wb") as fh:
            fh.write(b"outside")
        try:
            rv = self.client.get("/app/../secret.js", headers={"Accept-Encoding": "gzip"})
            self.assertNotEqual(rv.get_data(), b"outside")
            rv = self.client.get("/app/assets/..%2f..%2fsecret.js", headers={"Accept-Encoding": "gzip"})
            self.assertNotEqual(rv.get_data(), b"outside")
        finally:
            os.remove(secret)


if __name__ == "__main__":
    unittest.main()

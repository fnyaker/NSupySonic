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


if __name__ == "__main__":
    unittest.main()

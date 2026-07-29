# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Unit tests for the security hardening primitives (no network, no DB)."""

import hashlib
import os
import re
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

    def test_rejects_backslash_forms(self):
        """Browsers fold "\\" into "/", so /\\evil.com reaches the network as
        //evil.com — a protocol-relative URL — even though urlsplit() reports no
        netloc for it."""
        from supysonic.frontend.user import safe_redirect_target

        fallback = "/home"
        for bad in (
            "/\\evil.example",
            "/\\/evil.example",
            "\\\\evil.example",
            "/\\\\evil.example",
            "\t/\\evil.example",
            " //evil.example",
        ):
            self.assertEqual(
                safe_redirect_target(bad, fallback), fallback, f"leaked: {bad!r}"
            )


class ValidIdTestCase(unittest.TestCase):
    def test_rejects_unicode_digits_and_negatives(self):
        from supysonic.webui import _valid_id

        for good in ("0", "1", "123456789", "9" * 20):
            self.assertTrue(_valid_id(good), good)
        for bad in ("-5", "١٢٣", "²", "٤", "1.5", "1e3", "", None, "1 2", "9" * 21):
            self.assertFalse(_valid_id(bad), repr(bad))


class LikeTermTestCase(unittest.TestCase):
    def test_strips_the_multi_character_wildcard(self):
        from supysonic.utils import like_term

        # A bare "%" matched the whole library through peewee's `contains`.
        self.assertIsNone(like_term("%"))
        self.assertIsNone(like_term("%%%%"))
        self.assertIsNone(like_term("a"))  # below the 2-character floor
        self.assertEqual(like_term("a", minimum=1), "a")
        # A literal "50%" still finds "50% off" via the surviving "50".
        self.assertEqual(like_term("50%"), "50")
        self.assertEqual(like_term(" pink floyd "), "pink floyd")


class JsonpCallbackTestCase(unittest.TestCase):
    def test_callback_must_be_an_identifier(self):
        from supysonic.api.formatters import JSONPFormatter

        from tests.testbase import TestConfig
        from supysonic.web import create_application

        cfg = TestConfig(False, True)
        cfg.BASE["database_uri"] = "sqlite:///" + tempfile.mkstemp()[1]
        cfg.WEBAPP["cache_dir"] = tempfile.mkdtemp()
        app = create_application(cfg)

        with app.test_request_context("/"):
            good = JSONPFormatter("myCallback").make_response("x", {"a": 1})
            self.assertIn("myCallback(", good.get_data(as_text=True))

            bad = JSONPFormatter("alert(document.cookie);//").make_response(
                "x", {"a": 1}
            )
            body = bad.get_data(as_text=True)
            self.assertNotIn("alert(", body)
            self.assertIn("Invalid callback", body)


class PasswordEncryptionTestCase(unittest.TestCase):
    def setUp(self):
        os.environ["SUPYSONIC_SECRET_PASSWORD_SECRET"] = "unit-test-secret"
        import supysonic.utils as utils

        utils.__dict__["_utils__key_cache"] = {}

    def tearDown(self):
        os.environ.pop("SUPYSONIC_SECRET_PASSWORD_SECRET", None)
        import supysonic.utils as utils

        utils.__dict__["_utils__key_cache"] = {}

    def test_roundtrip_and_tamper_detection(self):
        from supysonic.managers.user import decrypt_password, encrypt_password

        blob = encrypt_password("Sup3rSecret#42")
        self.assertTrue(blob.startswith("gcm:"))
        self.assertEqual(decrypt_password(blob), "Sup3rSecret#42")

        # AES-GCM is authenticated: a flipped ciphertext byte must not decrypt.
        import base64

        raw = bytearray(base64.b64decode(blob[4:]))
        raw[-1] ^= 0x01
        tampered = "gcm:" + base64.b64encode(bytes(raw)).decode()
        with self.assertRaises(Exception):
            decrypt_password(tampered)

    def test_legacy_cfb_blobs_still_decrypt(self):
        """Accounts created before authenticated encryption must keep working."""
        import base64

        try:
            from Crypto.Cipher import AES
            from Crypto.Random import get_random_bytes
        except ImportError:
            from Cryptodome.Cipher import AES
            from Cryptodome.Random import get_random_bytes

        from supysonic.managers.user import _password_key, decrypt_password

        iv = get_random_bytes(16)
        cipher = AES.new(_password_key(), AES.MODE_CFB, iv)
        legacy = base64.b64encode(iv + cipher.encrypt(b"old-style")).decode()
        self.assertEqual(decrypt_password(legacy), "old-style")


class PasswordPolicyTestCase(unittest.TestCase):
    def test_rejects_the_documented_placeholders(self):
        from supysonic.managers.user import UserManager

        for bad in ("", "changeme", "CHANGEME", " supysonic ", "password", "123456"):
            with self.assertRaises(ValueError, msg=bad):
                UserManager.check_password_policy(bad)

    def test_accepts_an_ordinary_password(self):
        from supysonic.managers.user import UserManager

        UserManager.check_password_policy("B0b")  # no length floor by default

    def test_length_floor_is_opt_in(self):
        from supysonic.managers.user import UserManager

        os.environ["SUPYSONIC_MIN_PASSWORD_LENGTH"] = "12"
        try:
            with self.assertRaises(ValueError):
                UserManager.check_password_policy("short")
            UserManager.check_password_policy("long-enough-password")
        finally:
            del os.environ["SUPYSONIC_MIN_PASSWORD_LENGTH"]


class RateLimiterCompositeKeyTestCase(unittest.TestCase):
    def test_success_does_not_clear_the_ip_counter(self):
        """An attacker holding one valid account used to reset their own
        guessing history on every successful login."""
        rl = RateLimiter(max_attempts=3, window=300)
        for _ in range(3):
            rl.record_failure("10.0.0.1", "victim")
        self.assertTrue(rl.is_blocked_any("10.0.0.1"))
        self.assertTrue(rl.is_blocked_any(None, "victim"))

        rl.reset_user("attacker")  # a successful login as another account
        self.assertTrue(rl.is_blocked_any("10.0.0.1"))

        rl.reset_user("victim")
        self.assertFalse(rl.is_blocked_any(None, "victim"))
        self.assertTrue(rl.is_blocked_any("10.0.0.1"))

    def test_account_is_limited_across_source_addresses(self):
        rl = RateLimiter(max_attempts=3, window=300)
        for i in range(3):
            rl.record_failure(f"10.0.0.{i}", "victim")
        self.assertFalse(rl.is_blocked_any("10.0.0.0"))  # no single IP is over
        self.assertTrue(rl.is_blocked_any("10.0.0.9", "victim"))


class SsrfGuardTestCase(unittest.TestCase):
    def test_refuses_private_and_non_http_targets(self):
        from supysonic.deezer.provider import DeezerError, check_public_url

        for bad in (
            "http://127.0.0.1:5722/rest/ping",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/x",
            "file:///etc/passwd",
            "gopher://example.com/",
            "http://",
        ):
            with self.assertRaises(DeezerError, msg=bad):
                check_public_url(bad)

    def test_allows_a_public_host(self):
        from supysonic.deezer.provider import check_public_url

        check_public_url("https://93.184.216.34/episode.mp3")


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


class WebHardeningTestCase(unittest.TestCase):
    """Black-box checks on a real application, the way the audit ran them."""

    def setUp(self):
        from tests.testbase import TestConfig
        from supysonic.managers.user import UserManager
        from supysonic.web import create_application

        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        cfg = TestConfig(True, True)
        cfg.BASE["database_uri"] = "sqlite:///" + self.__db[1]
        cfg.WEBAPP["cache_dir"] = self.__dir
        cfg.WEBAPP["session_cookie_secure"] = True
        self.app = create_application(cfg)
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0b")
        self.client = self.app.test_client()

    def tearDown(self):
        from supysonic.db import release_database

        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    # -- NS-01: the cookie flags reach the wire ---------------------------

    def test_session_cookie_has_samesite_secure_and_httponly(self):
        """Asserts on the real Set-Cookie header: app.config would pass even
        when setdefault() silently did nothing, which is how this shipped."""
        rv = self.client.post(
            "/api/login", json={"username": "alice", "password": "Alic3"}
        )
        self.assertEqual(rv.status_code, 200)
        cookie = rv.headers["Set-Cookie"]
        self.assertIn("SameSite=Lax", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("Secure", cookie)

    def test_security_headers(self):
        headers = self.client.get("/user/login").headers
        csp = headers["Content-Security-Policy"]
        self.assertIn("object-src 'none'", csp)
        # No blanket https: wildcard — that made any injection an exfil channel.
        self.assertNotIn("connect-src 'self' https:", csp)
        self.assertNotIn("img-src 'self' data: https:;", csp)
        self.assertIn("Permissions-Policy", headers)

    # -- NS-02: CSRF and GET mutations ------------------------------------

    def _frontend_login(self):
        from supysonic.frontend import CSRF_FIELD

        page = self.client.get("/user/login").get_data(as_text=True)
        token = re.search(r'name="_csrf" value="([^"]+)"', page).group(1)
        self.client.post(
            "/user/login",
            data={"user": "alice", "password": "Alic3", CSRF_FIELD: token},
        )
        home = self.client.get("/").get_data(as_text=True)
        return re.search(r'name="csrf-token" content="([^"]+)"', home).group(1)

    def test_admin_mutations_reject_get(self):
        from supysonic.db import User

        self._frontend_login()
        bob = str(User.get(name="bob").id)
        for path in (
            f"/user/del/{bob}",
            "/folder/scan",
            f"/folder/del/{bob}",
            "/user/me/lastfm/unlink",
            "/user/me/listenbrainz/unlink",
            "/playlist/del/" + bob,
        ):
            self.assertEqual(
                self.client.get(path).status_code, 405, f"{path} still answers GET"
            )
        self.assertTrue(User.select().where(User.name == "bob").exists())

        # /user/logout can't answer 405: the "/user/<uid>" profile route also
        # matches that path, so werkzeug falls through to it. What matters is
        # that a GET no longer ends the session.
        self.client.get("/user/logout")
        self.assertEqual(self.client.get("/user").status_code, 200)

    def test_post_without_csrf_token_is_rejected(self):
        from supysonic.db import User

        token = self._frontend_login()
        bob = str(User.get(name="bob").id)

        rv = self.client.post(f"/user/del/{bob}")
        self.assertEqual(rv.status_code, 400)
        self.assertTrue(User.select().where(User.name == "bob").exists())

        rv = self.client.post(f"/user/del/{bob}", data={"_csrf": "wrong"})
        self.assertEqual(rv.status_code, 400)
        self.assertTrue(User.select().where(User.name == "bob").exists())

        rv = self.client.post(f"/user/del/{bob}", data={"_csrf": token})
        self.assertEqual(rv.status_code, 302)
        self.assertFalse(User.select().where(User.name == "bob").exists())

    def test_api_rejects_cross_site_state_changes(self):
        self.client.post("/api/login", json={"username": "alice", "password": "Alic3"})
        for headers in (
            {"Sec-Fetch-Site": "cross-site"},
            {"Sec-Fetch-Site": "same-site"},
            {"Origin": "https://evil.example"},
        ):
            rv = self.client.post("/api/favorite", json={"deezer_id": "1"}, headers=headers)
            self.assertEqual(rv.status_code, 403, headers)
        # Same-origin still works (503 = Deezer proxy disabled, not blocked).
        rv = self.client.post(
            "/api/favorite",
            json={"deezer_id": "1"},
            headers={"Sec-Fetch-Site": "same-origin"},
        )
        self.assertNotEqual(rv.status_code, 403)

    # -- NS-05: mass assignment -------------------------------------------

    def test_user_add_ignores_unknown_fields(self):
        from supysonic.db import User

        token = self._frontend_login()
        rv = self.client.post(
            "/user/add",
            data={
                "user": "mallory",
                "passwd": "s3cret-enough",
                "passwd_confirm": "s3cret-enough",
                "password_clear": "pwned",
                "session_epoch": "99",
                "_csrf": token,
            },
        )
        self.assertEqual(rv.status_code, 302)
        mallory = User.get(name="mallory")
        self.assertFalse(mallory.admin)
        self.assertEqual(mallory.session_epoch, 0)
        self.assertNotEqual(mallory.password_clear, "pwned")

    def test_user_manager_add_refuses_unknown_kwargs(self):
        from supysonic.managers.user import UserManager

        with self.assertRaises(ValueError):
            UserManager.add("eve", "s3cret-enough", password_clear="pwned")

    # -- NS-12: sessions --------------------------------------------------

    def test_password_change_revokes_other_sessions(self):
        from supysonic.managers.user import UserManager

        self.client.post("/api/login", json={"username": "bob", "password": "B0b"})
        self.assertEqual(self.client.get("/api/me").status_code, 200)

        UserManager.change_password2("bob", "n3w-password")
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_login_clears_a_planted_session(self):
        with self.client.session_transaction() as sess:
            sess["planted"] = "attacker-value"
        self.client.post("/api/login", json={"username": "alice", "password": "Alic3"})
        with self.client.session_transaction() as sess:
            self.assertNotIn("planted", sess)


class UploadIsolationTestCase(unittest.TestCase):
    """NS-06 / NS-07: one user's upload must not be readable by another."""

    def setUp(self):
        from tests.testbase import TestConfig
        from supysonic.deezer import library, local
        from supysonic.managers.user import UserManager
        from supysonic.web import create_application

        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        self.archive = tempfile.mkdtemp()
        cfg = TestConfig(True, True)
        cfg.BASE["database_uri"] = "sqlite:///" + self.__db[1]
        cfg.WEBAPP["cache_dir"] = self.__dir
        cfg.DEEZER["archive_dir"] = self.archive
        self.app = create_application(cfg)
        self.app.config["DEEZER"]["archive_dir"] = self.archive

        UserManager.add("alice", "Alic3", admin=True)
        self.guest = UserManager.add("guest", "Gu3st")
        self.mallory = UserManager.add("mallory", "M4llory")

        root = library.get_root_folder(self.archive)
        # guest's private upload, in the layout the upload endpoint produces
        updir = os.path.join(self.archive, "Uploads", str(self.guest.id))
        os.makedirs(updir, exist_ok=True)
        self.private = os.path.join(updir, "private.mp3")
        with open(self.private, "wb") as fh:
            fh.write(b"\x00" * 1024)
        # a plain library file nobody owns
        self.shared = os.path.join(self.archive, "shared.mp3")
        with open(self.shared, "wb") as fh:
            fh.write(b"\x00" * 1024)
        # and a non-audio file sitting in the tree
        self.secret = os.path.join(self.archive, "SECRET_NOTES.txt")
        with open(self.secret, "w") as fh:
            fh.write("the arl is ...")

        class FakeTag:
            artist = "Up"
            albumartist = None
            album = "Al"
            genre = None
            title = "Song"
            disc = 1
            track = 1
            year = None
            length = 10.0
            bitrate = 128000
            images = []

        orig = local._load_tag
        local._load_tag = lambda p: FakeTag()
        try:
            self.private_track = local.import_local_file(
                self.private, root, owner=self.guest
            )
            self.shared_track = local.import_local_file(self.shared, root)
        finally:
            local._load_tag = orig
        self.root_folder = root
        self.client = self.app.test_client()

    def tearDown(self):
        from supysonic.db import release_database

        release_database()
        for d in (self.__dir, self.archive):
            shutil.rmtree(d, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    def _login(self, name, password):
        return self.client.post(
            "/api/login", json={"username": name, "password": password}
        )

    def test_guest_cannot_read_another_users_upload(self):
        tid = str(self.private_track.id)
        self._login("mallory", "M4llory")

        listed = self.client.get("/api/me/local").get_json()["tracks"]
        self.assertNotIn(tid, [t["deezer_id"] for t in listed])
        self.assertIn(str(self.shared_track.id), [t["deezer_id"] for t in listed])

        self.assertEqual(self.client.get(f"/api/stream/{tid}").status_code, 400)
        self.assertEqual(self.client.get(f"/api/share/file/{tid}").status_code, 404)
        self.assertEqual(self.client.get(f"/api/localcover/{tid}").status_code, 404)

    def test_owner_and_admin_can_read_it(self):
        tid = str(self.private_track.id)

        self._login("guest", "Gu3st")
        listed = self.client.get("/api/me/local").get_json()["tracks"]
        self.assertIn(tid, [t["deezer_id"] for t in listed])
        self.assertEqual(self.client.get(f"/api/stream/{tid}").status_code, 200)

        self.client.post("/api/logout")
        self._login("alice", "Alic3")
        listed = self.client.get("/api/me/local").get_json()["tracks"]
        self.assertIn(tid, [t["deezer_id"] for t in listed])

    def test_owner_can_delete_only_their_own_upload(self):
        tid = str(self.private_track.id)

        self._login("mallory", "M4llory")
        self.assertEqual(self.client.delete(f"/api/local/{tid}").status_code, 404)
        self.assertTrue(os.path.isfile(self.private))
        self.client.post("/api/logout")

        self._login("guest", "Gu3st")
        # A shared-library track is not an upload: nobody may delete it here.
        self.assertEqual(
            self.client.delete(f"/api/local/{self.shared_track.id}").status_code, 403
        )
        self.assertEqual(self.client.delete(f"/api/local/{tid}").status_code, 200)
        self.assertFalse(os.path.isfile(self.private))

    def test_folder_download_excludes_non_audio_and_other_uploads(self):
        import io
        import zipfile

        from supysonic.db import ClientPrefs, User

        mallory = User.get(name="mallory")
        ClientPrefs.get_or_create(user=mallory, client_name="tests")
        rv = self.client.get(
            "/rest/download",
            query_string={
                "u": "mallory",
                "p": "M4llory",
                "c": "tests",
                "f": "json",
                "id": str(self.root_folder.id),
            },
        )
        self.assertEqual(rv.status_code, 200)
        names = zipfile.ZipFile(io.BytesIO(rv.get_data())).namelist()
        self.assertTrue(any(n.endswith("shared.mp3") for n in names), names)
        self.assertFalse(any("SECRET_NOTES" in n for n in names), names)
        self.assertFalse(any("private.mp3" in n for n in names), names)


if __name__ == "__main__":
    unittest.main()

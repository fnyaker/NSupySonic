# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2017-2024 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import logging

from supysonic.frontend import CSRF_FIELD, CSRF_SESSION_KEY

from ..testbase import TestBase


class FrontendTestBase(TestBase):
    __with_webui__ = True

    def setUp(self):
        super().setUp()
        logging.getLogger("supysonic.frontend.user").addHandler(logging.NullHandler())
        self._patch_client()
        self._patch_csrf()

    def csrf_token(self):
        """The session's CSRF token, minting one if the session has none yet.

        A browser gets this from the rendered page; tests post directly, so the
        token is seeded into the session instead. Requests that must be checked
        *without* a token pass ``csrf=False`` (see ``_patch_csrf``).
        """
        with self.client.session_transaction() as sess:
            token = sess.get(CSRF_SESSION_KEY)
            if not token:
                token = "test-csrf-token"
                sess[CSRF_SESSION_KEY] = token
        return token

    def _patch_csrf(self):
        """Add the CSRF field to every form POST the tests make.

        Keeps the existing call sites untouched; tests/test_security.py covers
        the rejection path explicitly.
        """
        original = self.client.post

        def post(*args, csrf=True, **kwargs):
            data = kwargs.get("data")
            if csrf and isinstance(data, dict) and CSRF_FIELD not in data:
                data = dict(data)
                data[CSRF_FIELD] = self.csrf_token()
                kwargs["data"] = data
            elif csrf and data is None and "json" not in kwargs:
                kwargs["data"] = {CSRF_FIELD: self.csrf_token()}
            return original(*args, **kwargs)

        self.client.post = post

    def _login(self, username, password):
        return self.client.post(
            "/user/login",
            data={"user": username, "password": password},
            follow_redirects=True,
        )

    def _logout(self):
        return self.client.post("/user/logout", follow_redirects=True)

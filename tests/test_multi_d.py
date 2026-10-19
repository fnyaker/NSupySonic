# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot D: a show opens by its row's UUID or by Deezer's id.

A catalogue card names its show by the provider's id (a UUID cannot be turned
back into it), so `/api/podcast/<x>` takes both forms; anything else is a 404,
never a 500.
"""

import unittest
import uuid

from supysonic.db import PodcastChannel, User

from . import test_webui


class PodcastByEitherIdTestCase(unittest.TestCase):
    # The fixtures of the web UI suite, without re-running its tests.
    setUp = test_webui.WebUITestCase.setUp
    tearDown = test_webui.WebUITestCase.tearDown
    _login = test_webui.WebUITestCase._login

    def _channel(self):
        return PodcastChannel.create(
            user=User.get(name="alice"),
            url="https://feed.example/x",
            title="Mon Show",
            deezer_id="99",
        )

    def test_by_uuid_and_by_deezer_id_are_one_page(self):
        self._login()
        c = self._channel()
        a = self.client.get("/api/podcast/%s" % c.id)
        b = self.client.get("/api/podcast/99")
        self.assertEqual(a.status_code, 200)
        self.assertEqual(b.status_code, 200)
        self.assertEqual(a.get_json(), b.get_json())

    def test_unknown_or_hostile_ids_are_404(self):
        self._login()
        self._channel()
        for raw in ("12345", str(uuid.uuid4()), "99abc", "-1", "9" * 40):
            rv = self.client.get("/api/podcast/" + raw)
            self.assertEqual(rv.status_code, 404, raw)

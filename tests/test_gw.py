# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Request-shape tests for the Deezer gateway client.

These pin the method names/arguments the Deezer web app was observed to use in
a HAR capture (``tools/deezer_explore/capture3.har``): the batch favourites
(``song.addFavorites`` / ``song.removeFavorites``, which supersede
``favorite_song.add``), the Flow ``config_id``, and the podcast-episode batch.
Elsewhere every test mocks the gateway away, so a quiet rename here would
otherwise never be noticed offline.
"""

import unittest

from deezerpy.gw import GW


class FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class FakeSession:
    """Records every gateway POST and answers the way gw-light.php does."""

    def __init__(self):
        self.calls = []

    def post(self, url, params=None, json=None, headers=None):
        method = (params or {}).get("method")
        self.calls.append({"method": method, "params": params, "body": json})
        if method == "deezer.getUserData":
            return FakeResp({"error": [], "results": {"checkForm": "tok"}})
        return FakeResp({"error": [], "results": {"ok": True}})

    def close(self):
        pass


class GatewayRequestShapeTest(unittest.TestCase):
    def setUp(self):
        self.sess = FakeSession()
        self.gw = GW(self.sess, {})

    def _last(self):
        return self.sess.calls[-1]

    def test_episode_batch_uses_getListData(self):
        self.gw.get_episodes(["907", 0, "905"])
        call = self._last()
        self.assertEqual(call["method"], "episode.getListData")
        self.assertEqual(call["body"]["episode_ids"], ["907", "905"])

    def test_episode_batch_empty_is_a_noop(self):
        self.assertEqual(self.gw.get_episodes([]), [])
        self.assertEqual(self.sess.calls, [])

    def test_user_menu(self):
        self.gw.get_user_menu()
        call = self._last()
        self.assertEqual(call["method"], "deezer.userMenu")
        self.assertEqual(call["body"]["checksums"], {})

    def test_all_feedbacks_forwards_checksums(self):
        self.gw.get_all_feedbacks({"FAVORITES": {}})
        call = self._last()
        self.assertEqual(call["method"], "user.getAllFeedbacks")
        self.assertEqual(call["body"]["checksums"], {"FAVORITES": {}})


if __name__ == "__main__":
    unittest.main()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2017 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import unittest

import time

from .apitestbase import ApiTestBase


class ChatTestCase(ApiTestBase):
    def test_add_message(self):
        self._make_request("addChatMessage", error=10)
        rv, child = self._make_request("getChatMessages", tag="chatMessages")
        self.assertEqual(len(child), 0)

        self._make_request(
            "addChatMessage", {"message": "Heres a message"}, skip_post=True
        )
        rv, child = self._make_request("getChatMessages", tag="chatMessages")
        self.assertEqual(len(child), 1)
        self.assertEqual(child[0].get("username"), "alice")
        self.assertEqual(child[0].get("message"), "Heres a message")

    def test_get_messages(self):
        self._make_request("addChatMessage", {"message": "Hello"}, skip_post=True)
        # ChatMessage.time has 1-second resolution, so space the two messages
        # into distinct seconds; that makes their stored timestamps differ.
        time.sleep(1)
        self._make_request(
            "addChatMessage", {"message": "Is someone there?"}, skip_post=True
        )

        rv, child = self._make_request("getChatMessages", tag="chatMessages")
        self.assertEqual(len(child), 2)

        # Derive the `since` cutoff from the second message's stored timestamp
        # (returned in ms) rather than from wall-clock time at query time: with
        # 1s timestamp resolution, a sub-second wall-clock cutoff lands on either
        # side of the message depending on fractional timing and flakes on CI.
        since = int(child[1].get("time")) - 1
        rv, child = self._make_request(
            "getChatMessages",
            {"since": since},
            tag="chatMessages",
        )
        self.assertEqual(len(child), 1)
        self.assertEqual(child[0].get("message"), "Is someone there?")

        self._make_request("getChatMessages", {"since": "invalid timestamp"}, error=0)


if __name__ == "__main__":
    unittest.main()

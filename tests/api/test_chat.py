# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2017 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import unittest

from supysonic.api import chat
from supysonic.db import ChatMessage

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
        # ChatMessage.time has 1-second resolution, so put the first message
        # in an earlier second than the second one — by writing its timestamp,
        # not by sleeping across a boundary.
        ChatMessage.update(time=ChatMessage.time - 5).execute()
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

    # -- the abuse limits (supysonic/api/chat.py) ---------------------------

    def _post(self, message, user=("alice", "Alic3"), error=None):
        args = {"message": message, "u": user[0], "p": user[1]}
        return self._make_request("addChatMessage", args, error=error, skip_post=True)

    def test_blank_message_is_refused(self):
        self._post("   \t ", error=0)
        self.assertEqual(ChatMessage.select().count(), 0)

    def test_long_message_is_cut_to_the_column(self):
        self._post("x" * (chat.MAX_MESSAGE_LENGTH * 3))
        stored = ChatMessage.get().message
        self.assertEqual(len(stored), chat.MAX_MESSAGE_LENGTH)

    def test_a_flood_is_refused_per_user(self):
        for i in range(chat.MAX_MESSAGES_PER_USER):
            self._post(f"m{i}")
        self._post("one too many", error=0)
        self.assertEqual(ChatMessage.select().count(), chat.MAX_MESSAGES_PER_USER)
        # The limit is alice's, not the room's.
        self._post("hi", user=("bob", "B0b"))
        # And it is a WINDOW: once her messages are older than it, she may
        # post again.
        ChatMessage.update(time=ChatMessage.time - chat.MESSAGE_WINDOW - 1).where(
            ChatMessage.message != "hi"
        ).execute()
        self._post("back again")

    def test_the_table_keeps_only_the_newest(self):
        cap = 5
        original = chat.MAX_MESSAGES
        chat.MAX_MESSAGES = cap
        self.addCleanup(setattr, chat, "MAX_MESSAGES", original)
        for i in range(cap + 3):
            self._post(f"m{i}")
            # Distinct seconds, oldest first, so "oldest" is unambiguous.
            ChatMessage.update(time=ChatMessage.time - 1).execute()
        kept = [m.message for m in ChatMessage.select().order_by(ChatMessage.time)]
        self.assertEqual(kept, [f"m{i}" for i in range(3, cap + 3)])


if __name__ == "__main__":
    unittest.main()

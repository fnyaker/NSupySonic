# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2022 Alban 'spl0k' Féron
#
# Distributed under terms of the GNU AGPLv3 license.

import time

from flask import request

from ..db import ChatMessage
from . import api_routing
from .exceptions import GenericError

# The chat had no length limit, no rate limit and no retention: a 100 000-char
# message was accepted and kept forever, and any account could fill the table.
MAX_MESSAGE_LENGTH = 512
MAX_MESSAGES = 1000
# Most messages one user may post per MESSAGE_WINDOW seconds.
MAX_MESSAGES_PER_USER = 20
MESSAGE_WINDOW = 60


@api_routing("/getChatMessages")
def get_chat():
    since = request.values.get("since")
    since = int(since) / 1000 if since else None

    query = ChatMessage.select().order_by(ChatMessage.time)
    if since:
        query = query.where(ChatMessage.time > since)

    return request.formatter(
        "chatMessages", {"chatMessage": [msg.responsize() for msg in query]}
    )


@api_routing("/addChatMessage")
def add_chat_message():
    msg = request.values["message"].strip()
    if not msg:
        raise GenericError("Empty message")
    msg = msg[:MAX_MESSAGE_LENGTH]

    recent = (
        ChatMessage.select()
        .where(
            ChatMessage.user == request.user,
            ChatMessage.time > int(time.time()) - MESSAGE_WINDOW,
        )
        .count()
    )
    if recent >= MAX_MESSAGES_PER_USER:
        raise GenericError("Too many messages, slow down")

    ChatMessage.create(user=request.user, message=msg)

    # Keep the table bounded: drop the oldest once past the cap.
    total = ChatMessage.select().count()
    if total > MAX_MESSAGES:
        stale = (
            ChatMessage.select(ChatMessage.id)
            .order_by(ChatMessage.time)
            .limit(total - MAX_MESSAGES)
        )
        ChatMessage.delete().where(ChatMessage.id.in_(stale)).execute()

    return request.formatter.empty

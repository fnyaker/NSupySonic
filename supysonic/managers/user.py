# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2022 Alban 'spl0k' Féron
#                    2017 Óscar García Amor
#
# Distributed under terms of the GNU AGPLv3 license.

import base64
import hashlib
import random
import string
import uuid

try:  # pycryptodome
    from Crypto.Cipher import AES
    from Crypto.Random import get_random_bytes
except ImportError:  # pycryptodomex
    from Cryptodome.Cipher import AES
    from Cryptodome.Random import get_random_bytes

from ..db import User
from ..utils import get_secret_key


def _password_key():
    return hashlib.sha256(get_secret_key("password_secret")).digest()


def encrypt_password(plaintext):
    """Reversibly encrypt a password with the server secret (for token auth)."""
    iv = get_random_bytes(16)
    cipher = AES.new(_password_key(), AES.MODE_CFB, iv)
    return base64.b64encode(iv + cipher.encrypt(plaintext.encode("utf-8"))).decode()


def decrypt_password(blob):
    raw = base64.b64decode(blob)
    iv, ct = raw[:16], raw[16:]
    cipher = AES.new(_password_key(), AES.MODE_CFB, iv)
    return cipher.decrypt(ct).decode("utf-8")


class UserManager:
    @staticmethod
    def get(uid):
        if isinstance(uid, uuid.UUID):
            pass
        elif isinstance(uid, str):
            uid = uuid.UUID(uid)
        else:
            raise TypeError("Invalid user id")

        return User[uid]

    @staticmethod
    def add(name, password, **kwargs):
        if User.select().where(User.name == name).exists():
            raise ValueError(f"User '{name}' exists")

        crypt, salt = UserManager.__encrypt_password(password)
        return User.create(
            name=name,
            password=crypt,
            salt=salt,
            password_clear=encrypt_password(password),
            **kwargs,
        )

    @staticmethod
    def delete(uid):
        user = UserManager.get(uid)
        user.delete_instance(recursive=True)

    @staticmethod
    def delete_by_name(name):
        user = User.get(name=name)
        user.delete_instance(recursive=True)

    @staticmethod
    def try_auth(name, password):
        user = User.get_or_none(name=name)
        if user is None:
            return None
        elif UserManager.__encrypt_password(password, user.salt)[0] != user.password:
            return None
        else:
            # Backfill the recoverable password so token auth works for users
            # created before this was added (after one password login).
            if not user.password_clear:
                user.password_clear = encrypt_password(password)
                user.save()
            return user

    @staticmethod
    def try_auth_token(name, token, salt):
        """Subsonic token auth: token == md5(password + salt)."""
        user = User.get_or_none(name=name)
        if user is None or not user.password_clear:
            return None
        try:
            password = decrypt_password(user.password_clear)
        except Exception:
            return None
        expected = hashlib.md5((password + salt).encode("utf-8")).hexdigest()
        if expected == str(token).lower():
            return user
        return None

    @staticmethod
    def change_password(uid, old_pass, new_pass):
        user = UserManager.get(uid)
        if UserManager.__encrypt_password(old_pass, user.salt)[0] != user.password:
            raise ValueError("Wrong password")

        user.password = UserManager.__encrypt_password(new_pass, user.salt)[0]
        user.password_clear = encrypt_password(new_pass)
        user.save()

    @staticmethod
    def change_password2(name_or_user, new_pass):
        if isinstance(name_or_user, User):
            user = name_or_user
        elif isinstance(name_or_user, str):
            user = User.get(name=name_or_user)
        else:
            raise TypeError("Requires a User instance or a user name (string)")

        user.password = UserManager.__encrypt_password(new_pass, user.salt)[0]
        user.password_clear = encrypt_password(new_pass)
        user.save()

    @staticmethod
    def __encrypt_password(password, salt=None):
        if salt is None:
            salt = "".join(random.choice(string.printable.strip()) for _ in range(6))
        return (
            hashlib.sha1(salt.encode("utf-8") + password.encode("utf-8")).hexdigest(),
            salt,
        )

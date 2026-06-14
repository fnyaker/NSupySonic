# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2013-2022 Alban 'spl0k' Féron
#                    2017 Óscar García Amor
#
# Distributed under terms of the GNU AGPLv3 license.

import base64
import hashlib
import hmac
import secrets
import string
import uuid

from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error

try:  # pycryptodome
    from Crypto.Cipher import AES
    from Crypto.Random import get_random_bytes
except ImportError:  # pycryptodomex
    from Cryptodome.Cipher import AES
    from Cryptodome.Random import get_random_bytes

from ..db import User
from ..utils import get_secret_key

# Password hashing: argon2id for everything new. Legacy users carry a 40-char
# SHA1(salt+password) hash and are transparently upgraded on next login.
_hasher = PasswordHasher()


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

        crypt, salt = UserManager._hash_fields(password)
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
        if not UserManager._verify_password(user, password):
            return None
        # Backfill the recoverable password so token auth works for users
        # created before that was added (after one password login).
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
        if hmac.compare_digest(expected, str(token).lower()):
            return user
        return None

    @staticmethod
    def change_password(uid, old_pass, new_pass):
        user = UserManager.get(uid)
        if not UserManager._verify_password(user, old_pass):
            raise ValueError("Wrong password")

        user.password, user.salt = UserManager._hash_fields(new_pass)
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

        user.password, user.salt = UserManager._hash_fields(new_pass)
        user.password_clear = encrypt_password(new_pass)
        user.save()

    @staticmethod
    def _hash_fields(password):
        """argon2id hash + a throwaway salt (the salt column is NOT NULL but is
        unused for argon2, whose salt is embedded in the hash)."""
        salt = "".join(secrets.choice(string.printable.strip()) for _ in range(6))
        return _hasher.hash(password), salt

    @staticmethod
    def _verify_password(user, password):
        """Verify `password` against the stored hash, upgrading legacy hashes.

        Handles both argon2id and legacy SHA1(salt+password). On a successful
        legacy verification the password is transparently rehashed with argon2
        and saved, so old accounts migrate on their next login.
        """
        stored = user.password or ""
        if stored.startswith("$argon2"):
            try:
                _hasher.verify(stored, password)
            except Argon2Error:
                return False
            if _hasher.check_needs_rehash(stored):
                user.password, user.salt = UserManager._hash_fields(password)
                user.save()
            return True

        # Legacy SHA1(salt + password), constant-time compared.
        if not hmac.compare_digest(
            UserManager.__legacy_sha1(password, user.salt), stored
        ):
            return False
        user.password, user.salt = UserManager._hash_fields(password)
        user.save()
        return True

    @staticmethod
    def __legacy_sha1(password, salt):
        return hashlib.sha1(
            salt.encode("utf-8") + password.encode("utf-8")
        ).hexdigest()

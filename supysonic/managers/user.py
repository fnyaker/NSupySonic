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
import os
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


# Marker for the authenticated (AES-GCM) format. Blobs written before this are
# raw base64 of `iv || AES-CFB(password)`: unauthenticated, hence malleable —
# anyone with write access to the database could flip plaintext bits without
# detection. They still decrypt (see below) and are rewritten in the new format
# on the user's next password change or login backfill.
_GCM_PREFIX = "gcm:"


def encrypt_password(plaintext):
    """Reversibly encrypt a password with the server secret (for token auth)."""
    nonce = get_random_bytes(12)
    cipher = AES.new(_password_key(), AES.MODE_GCM, nonce=nonce)
    ct, tag = cipher.encrypt_and_digest(plaintext.encode("utf-8"))
    return _GCM_PREFIX + base64.b64encode(nonce + tag + ct).decode()


def decrypt_password(blob):
    if blob.startswith(_GCM_PREFIX):
        raw = base64.b64decode(blob[len(_GCM_PREFIX) :])
        nonce, tag, ct = raw[:12], raw[12:28], raw[28:]
        cipher = AES.new(_password_key(), AES.MODE_GCM, nonce=nonce)
        # Raises ValueError if the ciphertext was tampered with.
        return cipher.decrypt_and_verify(ct, tag).decode("utf-8")

    # Legacy unauthenticated AES-CFB blob.
    raw = base64.b64decode(blob)
    iv, ct = raw[:16], raw[16:]
    cipher = AES.new(_password_key(), AES.MODE_CFB, iv)
    return cipher.decrypt(ct).decode("utf-8")


# Passwords that are effectively public knowledge — including the ones this
# project's own docs and docker-compose use as placeholders, which is exactly
# how they end up in production untouched. Always refused, no configuration.
BANNED_PASSWORDS = frozenset(
    {
        "changeme",
        "supysonic",
        "password",
        "passw0rd",
        "admin",
        "administrator",
        "letmein",
        "qwerty",
        "azerty",
        "123456",
        "1234567",
        "12345678",
        "123456789",
        "1234567890",
        "iloveyou",
        "welcome",
        "abc123",
        "motdepasse",
    }
)

# Minimum password length. Off (0) by default so existing accounts and small
# LAN installs keep working; set SUPYSONIC_MIN_PASSWORD_LENGTH=12 on anything
# reachable from the internet.
_MIN_PASSWORD_LENGTH_ENV = "SUPYSONIC_MIN_PASSWORD_LENGTH"


def _min_password_length() -> int:
    try:
        return max(0, int(os.environ.get(_MIN_PASSWORD_LENGTH_ENV, "0")))
    except ValueError:
        return 0


class UserManager:
    @staticmethod
    def check_password_policy(password):
        """Raise ValueError if `password` is unacceptable.

        Deliberately minimal by default: the only unconditional rules are "not
        empty" and "not one of the passwords everybody tries first". A length
        floor is opt-in through SUPYSONIC_MIN_PASSWORD_LENGTH.
        """
        if not password:
            raise ValueError("The password can't be empty")
        if password.strip().lower() in BANNED_PASSWORDS:
            raise ValueError("This password is too common, pick another one")
        minimum = _min_password_length()
        if minimum and len(password) < minimum:
            raise ValueError(f"The password must be at least {minimum} characters long")

    @staticmethod
    def get(uid):
        if isinstance(uid, uuid.UUID):
            pass
        elif isinstance(uid, str):
            uid = uuid.UUID(uid)
        else:
            raise TypeError("Invalid user id")

        return User[uid]

    # The only User columns a caller may set at creation time. Everything else
    # (password, salt, password_clear, session_epoch, last_play...) is derived
    # here. Without this whitelist, any form field that reached **kwargs became
    # a column write — `admin=1` on the add-user form was a one-request
    # privilege escalation.
    CREATABLE_FIELDS = frozenset({"mail", "admin", "jukebox"})

    @staticmethod
    def add(name, password, **kwargs):
        unknown = set(kwargs) - UserManager.CREATABLE_FIELDS
        if unknown:
            raise ValueError("Unknown field: " + ", ".join(sorted(unknown)))

        if User.select().where(User.name == name).exists():
            raise ValueError(f"User '{name}' exists")

        UserManager.check_password_policy(password)
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
            # Verify against a throwaway hash so a missing account costs the
            # same as a wrong password. Returning early made the response time
            # a reliable "does this user exist?" oracle with production argon2
            # parameters (~60 ms vs ~1 ms).
            UserManager._burn_verify_time()
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

        UserManager.check_password_policy(new_pass)
        user.password, user.salt = UserManager._hash_fields(new_pass)
        user.password_clear = encrypt_password(new_pass)
        # Revoke every session minted with the old password (see db.User).
        user.session_epoch = (user.session_epoch or 0) + 1
        user.save()

    @staticmethod
    def change_password2(name_or_user, new_pass):
        if isinstance(name_or_user, User):
            user = name_or_user
        elif isinstance(name_or_user, str):
            user = User.get(name=name_or_user)
        else:
            raise TypeError("Requires a User instance or a user name (string)")

        UserManager.check_password_policy(new_pass)
        user.password, user.salt = UserManager._hash_fields(new_pass)
        user.password_clear = encrypt_password(new_pass)
        user.session_epoch = (user.session_epoch or 0) + 1
        user.save()

    # A hash of a value nobody can supply, used to equalise the timing of a
    # login for a nonexistent user. Built lazily so importing this module stays
    # cheap, and reused so the cost matches a real verify.
    __dummy_hash = None

    @staticmethod
    def _burn_verify_time():
        if UserManager.__dummy_hash is None:
            UserManager.__dummy_hash = _hasher.hash(secrets.token_hex(16))
        try:
            _hasher.verify(UserManager.__dummy_hash, "")
        except Argon2Error:
            pass

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

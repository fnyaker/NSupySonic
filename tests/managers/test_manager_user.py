# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2017-2025 Alban 'spl0k' Féron
#                    2017 Óscar García Amor
#
# Distributed under terms of the GNU AGPLv3 license.

from supysonic import db
from supysonic.managers.user import UserManager

import unittest
import uuid


class UserManagerTestCase(unittest.TestCase):
    def setUp(self):
        # Create an empty sqlite database in memory
        db.init_database("sqlite:")

    def tearDown(self):
        db.release_database()

    def create_data(self):
        # Create some users
        alice = UserManager.add("alice", "ALICE", admin=True)
        self.assertIsInstance(alice, db.User)
        self.assertTrue(alice.admin)

        bob = UserManager.add("bob", "BOB")
        self.assertIsInstance(bob, db.User)
        self.assertFalse(bob.admin)

        self.assertIsInstance(UserManager.add("charlie", "CHARLIE"), db.User)

        folder = db.Folder.create(name="Root", path="tests/assets", root=True)
        artist = db.Artist.create(name="Artist")
        album = db.Album.create(name="Album", artist=artist)
        track = db.Track.create(
            title="Track",
            disc=1,
            number=1,
            duration=1,
            artist=artist,
            album=album,
            path="tests/assets/empty",
            folder=folder,
            root_folder=folder,
            bitrate=320,
            last_modification=0,
        )

        playlist = db.Playlist.create(name="Playlist", user=db.User.get(name="alice"))
        playlist.add(track)

    def test_legacy_sha1(self):
        # The legacy SHA1(salt+password) verifier, kept for migrating old hashes.
        func = UserManager._UserManager__legacy_sha1
        self.assertEqual(
            func("password", "salt"), "59b3e8d637cf97edbe2384cf59cb7453dfe30789"
        )
        self.assertEqual(
            func("pass-word", "pepper"), "d68c95a91ed7773aa57c7c044d2309a5bf1da2e7"
        )
        self.assertEqual(
            func("éèàïô", "ABC+"), "b639ba5217b89c906019d89d5816b407d8730898"
        )

    def test_new_passwords_use_argon2(self):
        alice = UserManager.add("alice", "ALICE")
        self.assertTrue(alice.password.startswith("$argon2"))
        self.assertIsNotNone(UserManager.try_auth("alice", "ALICE"))
        self.assertIsNone(UserManager.try_auth("alice", "wrong"))

    def test_legacy_hash_upgraded_on_login(self):
        # Simulate a pre-argon2 account: SHA1(salt+password) in the password
        # column. A correct login must succeed and transparently rehash.
        import hashlib

        salt = "abcdef"
        legacy = hashlib.sha1((salt + "secret").encode()).hexdigest()
        db.User.create(name="old", password=legacy, salt=salt)

        self.assertIsNone(UserManager.try_auth("old", "wrong"))
        self.assertIsNotNone(UserManager.try_auth("old", "secret"))
        # Rehashed to argon2 in place, still verifiable afterwards.
        self.assertTrue(db.User.get(name="old").password.startswith("$argon2"))
        self.assertIsNotNone(UserManager.try_auth("old", "secret"))

    def test_get_user(self):
        self.create_data()

        # Get existing users
        for name in ["alice", "bob", "charlie"]:
            user = db.User.get(name=name)
            self.assertEqual(UserManager.get(user.id), user)

        # Get with invalid UUID
        self.assertRaises(ValueError, UserManager.get, "invalid-uuid")
        self.assertRaises(TypeError, UserManager.get, 0xFEE1BAD)

        # Non-existent user
        self.assertRaises(db.User.DoesNotExist, UserManager.get, uuid.uuid4())

    def test_add_user(self):
        self.create_data()
        self.assertEqual(db.User.select().count(), 3)

        # Create duplicate
        self.assertRaises(ValueError, UserManager.add, "alice", "Alic3", admin=True)

    def test_delete_user(self):
        self.create_data()

        # Delete invalid UUID
        self.assertRaises(ValueError, UserManager.delete, "invalid-uuid")
        self.assertRaises(TypeError, UserManager.delete, 0xFEE1B4D)
        self.assertEqual(db.User.select().count(), 3)

        # Delete non-existent user
        self.assertRaises(db.User.DoesNotExist, UserManager.delete, uuid.uuid4())
        self.assertEqual(db.User.select().count(), 3)

        # Delete existing users
        for name in ["alice", "bob", "charlie"]:
            user = db.User.get(name=name)
            db.ClientPrefs.create(
                user=user, client_name="tests"
            )  # test for FK handling
            UserManager.delete(user.id)
            self.assertRaises(db.User.DoesNotExist, db.User.__getitem__, user.id)
        self.assertEqual(db.User.select().count(), 0)

    def test_delete_by_name(self):
        self.create_data()

        # Delete existing users
        for name in ["alice", "bob", "charlie"]:
            user = db.User.get(name=name)
            db.ClientPrefs.create(
                user=user, client_name="tests"
            )  # test for FK handling
            UserManager.delete_by_name(name)
            self.assertFalse(db.User.select().where(db.User.name == name).exists())

        # Delete non-existent user
        self.assertRaises(db.User.DoesNotExist, UserManager.delete_by_name, "null")

    def test_try_auth(self):
        self.create_data()

        # Test authentication
        for name in ["alice", "bob", "charlie"]:
            user = db.User.get(name=name)
            authed = UserManager.try_auth(name, name.upper())
            self.assertEqual(authed, user)

        # Wrong password
        self.assertIsNone(UserManager.try_auth("alice", "bad"))
        self.assertIsNone(UserManager.try_auth("alice", "alice"))

        # Non-existent user
        self.assertIsNone(UserManager.try_auth("null", "null"))

    def test_change_password(self):
        self.create_data()

        # With existing users
        for name in ["alice", "bob", "charlie"]:
            user = db.User.get(name=name)
            # Good password
            UserManager.change_password(user.id, name.upper(), "newpass")
            self.assertEqual(UserManager.try_auth(name, "newpass"), user)
            # Old password
            self.assertEqual(UserManager.try_auth(name, name.upper()), None)
            # Wrong password
            self.assertRaises(
                ValueError, UserManager.change_password, user.id, "badpass", "newpass"
            )

        # Ensure we still got the same number of users
        self.assertEqual(db.User.select().count(), 3)

        # With invalid UUID
        self.assertRaises(
            ValueError,
            UserManager.change_password,
            "invalid-uuid",
            "oldpass",
            "newpass",
        )

        # Non-existent user
        self.assertRaises(
            db.User.DoesNotExist,
            UserManager.change_password,
            uuid.uuid4(),
            "oldpass",
            "newpass",
        )

    def test_change_password2(self):
        self.create_data()

        self.assertRaises(TypeError, UserManager.change_password2, uuid.uuid4(), "pass")

        # With existing users
        for name in ["alice", "bob", "charlie"]:
            UserManager.change_password2(name, "newpass")
            user = db.User.get(name=name)
            self.assertEqual(UserManager.try_auth(name, "newpass"), user)
            self.assertEqual(UserManager.try_auth(name, name.upper()), None)

            # test passing the user directly
            UserManager.change_password2(user, "NEWPASS")
            self.assertEqual(UserManager.try_auth(name, "NEWPASS"), user)

        # Non-existent user
        self.assertRaises(
            db.User.DoesNotExist, UserManager.change_password2, "null", "newpass"
        )

    def test_production_password_hashing_is_not_weakened(self):
        """The suite swaps in cheap argon2 parameters (see tests/__init__.py)
        because hashing was half its wall clock. This guards that the swap stays
        TEST-only: production must go on using argon2's own defaults, and those
        defaults must stay above the OWASP floor."""
        import inspect

        from argon2 import PasswordHasher

        from supysonic.managers import user as user_module

        # What the module constructs at import time, evaluated fresh.
        prod = PasswordHasher()
        self.assertGreaterEqual(prod.memory_cost, 19 * 1024, "argon2id wants >=19 MiB")
        self.assertGreaterEqual(prod.time_cost, 2)

        # …and the module really does take those defaults, unparameterised. If
        # this line ever changes, the change is security-relevant: read it.
        self.assertIn("_hasher = PasswordHasher()", inspect.getsource(user_module))


if __name__ == "__main__":
    unittest.main()

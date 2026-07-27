# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Copyright (C) 2017-2019 Alban 'spl0k' Féron
#               2017 Óscar García Amor
#
# Distributed under terms of the GNU AGPLv3 license.

import os.path


def _use_fast_password_hashing():
    """Hash passwords with deliberately cheap argon2 parameters, in tests only.

    The suite hashes constantly — every user fixture, every authenticated
    request. A full run does 512 hashes and 1050 verifies, which at argon2's
    production parameters is ~92 s: half the entire wall clock. Worse, it is the
    part that refuses to parallelise, because argon2id is memory-hard and its
    default ``parallelism=4`` means a single hash already saturates the machine.
    Cheap parameters take it from ~60 ms per hash to ~0.03 ms.

    This is TEST-ONLY and deliberately lives here rather than in the
    application: nothing under ``supysonic/`` reads it, production keeps
    argon2's real defaults, and ``tests.managers.test_manager_user`` pins those
    defaults so this can never quietly become the shipped configuration.
    """
    from argon2 import PasswordHasher

    from supysonic.managers import user as _user

    _user._hasher = PasswordHasher(time_cost=1, memory_cost=8, parallelism=1)


_use_fast_password_hashing()


def load_tests(loader, tests, pattern):
    this_dir = os.path.dirname(__file__)
    tests.addTests(loader.discover(start_dir=this_dir, pattern="test*.py"))
    tests.addTests(loader.discover(start_dir=this_dir, pattern="issue*.py"))
    return tests

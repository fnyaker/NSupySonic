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


def _share_compiled_url_builders():
    """Compile each distinct werkzeug URL builder once per process, in tests only.

    Every test builds its own Flask app, and binding a rule to a map makes
    werkzeug generate and ``compile()`` two Python functions for it — the URL
    builders behind ``url_for``. With the Subsonic API and the SPA's /api both
    mounted that is 532 compilations, ~75 ms and 95% of ``create_application``,
    paid again by each of ~700 tests: ~25 s of CPU, over half of the whole
    suite's, spent regenerating byte-identical code.

    The generated function depends on the rule's SHAPE only (its trace, its
    default names, ``append_unknown`` and, for its name, the rule string);
    everything else it touches — the converters, the query encoding, the map's
    settings — it reads through its ``self`` argument at call time. Identical
    shapes can therefore share one compiled function, bound to each rule exactly
    as werkzeug binds its own. A rule with a default folded into its path as a
    constant (the one case whose code depends on a converter's output) is
    compiled the normal way.

    TEST-only, like the argon2 swap above: production builds its app once.
    ``tests.test_harness`` checks every builder of a fully mounted app against
    a fresh werkzeug compilation, so a werkzeug upgrade that changes what the
    code depends on fails loudly instead of building wrong URLs.
    """
    try:
        from werkzeug.routing.rules import Rule
    except ImportError:  # pragma: no cover - a werkzeug that moved it: run slow
        return
    original = getattr(Rule, "_compile_builder", None)
    if original is None or getattr(original, "_shared", False):
        return  # pragma: no cover - renamed upstream, or already installed

    compiled = {}

    def _compile_builder(self, append_unknown=True):
        defaults = self.defaults or {}
        trace = tuple(self._trace)
        if any(dynamic and data in defaults for dynamic, data in trace):
            return original(self, append_unknown)
        key = (self.rule, bool(append_unknown), trace, tuple(map(str, defaults)))
        func = compiled.get(key)
        if func is None:
            func = compiled[key] = original(self, append_unknown)
        return func

    _compile_builder._shared = True
    _compile_builder._original = original
    Rule._compile_builder = _compile_builder


_share_compiled_url_builders()


def load_tests(loader, tests, pattern):
    this_dir = os.path.dirname(__file__)
    tests.addTests(loader.discover(start_dir=this_dir, pattern="test*.py"))
    tests.addTests(loader.discover(start_dir=this_dir, pattern="issue*.py"))
    return tests

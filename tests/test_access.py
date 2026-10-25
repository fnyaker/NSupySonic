# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Plan multi-provider §15, lot P1: what each provider declares it does, the
groups, and who may use which account. Archived content stays everybody's; a
person a grant does not name gets the route's local answer, never an outage."""

import os
import shutil
import sqlite3
import tempfile
import unittest
from unittest import mock

from supysonic import access
from supysonic import db as dbmod
from supysonic.db import (
    Meta,
    ProviderAccount,
    ProviderGrant,
    User,
    UserGroup,
    UserGroupMember,
    init_database,
    release_database,
)
from supysonic.managers.user import UserManager
from supysonic.providers import base
from supysonic.providers import features as F
from supysonic.providers.deezer import DeezerAdapter
from supysonic.providers.info import LrclibProvider, MusicBrainzProvider

from .test_deezer import count_statements
from . import test_webui


class DeclarationTestCase(unittest.TestCase):
    def test_deezer_says_what_needs_its_account(self):
        got = F.declared(DeezerAdapter)
        self.assertEqual(got["search"]["auth"], "none")
        self.assertEqual(got["stream"]["auth"], "account")
        for personal in ("my_tracks", "my_albums", "my_artists", "my_playlists"):
            self.assertEqual(got[personal]["auth"], "account")
            self.assertEqual(F.scope(personal), F.PERSONAL)
        self.assertIn("isrc", got["track_info"]["fields"])
        self.assertEqual([m["id"] for m in DeezerAdapter.auth_modes], ["browser", "arl"])

    def test_the_facts_providers_give_facts_only(self):
        for cls in (MusicBrainzProvider, LrclibProvider):
            self.assertEqual(cls.role, base.INFO_ROLE)
            self.assertEqual(cls.capabilities, frozenset({base.INFO}))
        self.assertEqual(
            F.declared(MusicBrainzProvider)["track_info"]["fields"],
            ["isrc", "first_release", "mbid", "composer", "lyricist", "producer"],
        )
        desc = F.describe(LrclibProvider)
        self.assertEqual([f["id"] for f in desc["features"]], ["lyrics"])
        self.assertEqual(
            [x["label"] for x in desc["features"][0]["fields"]], ["texte", "synchronisées"]
        )

    def test_a_provider_without_a_declaration_gets_what_its_capabilities_carry(self):
        class Old(base.Provider):
            id = "old"
            capabilities = frozenset({base.SEARCH, base.AUDIO})

        self.assertEqual(set(F.declared(Old)), {"search", "stream"})
        self.assertEqual({v["auth"] for v in F.declared(Old).values()}, {"none"})

    def test_a_malformed_declaration_is_refused(self):
        def provider(**attrs):
            cls = type("P", (base.Provider,), dict(
                id="p", capabilities=frozenset({base.SEARCH}),
                search=lambda self, *a, **k: {}, **attrs,
            ))
            return cls()

        for features in (
            {"teleport": {"auth": "none"}},  # unknown feature
            {"stream": {"auth": "none"}},  # capability not declared
            {"search": {"auth": "maybe"}},  # bad auth
        ):
            with self.assertRaises(ValueError, msg=features):
                base.check_declared(provider(features=features))
        with self.assertRaises(ValueError):
            base.check_declared(provider(auth_modes=({"id": "telepathy"},)))
        lib = type("L", (base.Provider,), dict(
            id="l", capabilities=frozenset({base.LIBRARY}), library=lambda self, k, a=None: [],
            features={"my_tracks": {"auth": "none"}},  # personal without an account
        ))
        with self.assertRaises(ValueError):
            base.check_declared(lib())
        with self.assertRaises(ValueError):
            base.check_declared(provider(features={"track_info": {"fields": ["x"]}}))


class _Case(unittest.TestCase):
    """WebUITestCase's server (a mock Deezer, alice the admin), without
    inheriting its tests."""

    def setUp(self):
        test_webui.WebUITestCase.setUp(self)
        UserManager.add("bob", "B0bpass", admin=False)
        UserManager.add("carol", "Car0lpass", admin=False)
        self.alice = User.get(name="alice")
        self.bob = User.get(name="bob")
        self.carol = User.get(name="carol")
        if self.CLOSE_ANONYMOUS:
            self.close_anonymous()

    #: These cases are about lending the server's account: the public API
    #: (lot P3) would answer the pages they expect refused, so it is closed.
    CLOSE_ANONYMOUS = True

    def close_anonymous(self):
        self.as_alice()
        self.grant("*", [], account="")
        self.client.post("/api/logout")

    def tearDown(self):
        test_webui.WebUITestCase.tearDown(self)

    def login(self, who, pw):
        self.client.post("/api/logout")
        rv = self.client.post("/api/login", json={"username": who, "password": pw})
        self.assertEqual(rv.status_code, 200)

    def as_alice(self):
        self.login("alice", "Alic3")

    def as_bob(self):
        self.login("bob", "B0bpass")

    def as_carol(self):
        self.login("carol", "Car0lpass")

    def server_account(self):
        self.client.get("/api/me")  # the first look writes it down
        return ProviderAccount.get(ProviderAccount.provider == "deezer", ProviderAccount.mode == "server")

    def grant(self, feature, subjects, account=None, provider="deezer", status=200):
        if account is None:
            account = str(self.server_account().id)
        rv = self.client.put(
            "/api/access/grants",
            json={"provider": provider, "account": account, "feature": feature, "subjects": subjects},
        )
        self.assertEqual(rv.status_code, status, rv.get_data(as_text=True))
        return rv.get_json()

    def denied_page(self):
        """A page only Deezer has, as the current person."""
        rv = self.client.get("/api/album/987654")
        return rv.status_code == 403 and rv.headers.get("X-NS-Error") == "deezer-denied"


class UpgradeBehaviourTestCase(_Case):
    def test_after_an_upgrade_everybody_has_what_they_had(self):
        self.as_bob()
        self.assertFalse(self.denied_page())
        acc = self.server_account()
        self.assertEqual(acc.user_id, self.alice.id)  # the first admin holds it
        self.assertEqual(
            {(g.feature, g.subject) for g in ProviderGrant.select().where(ProviderGrant.account == str(acc.id))},
            {("*", "all")},
        )
        yt = ProviderGrant.get(ProviderGrant.provider == "youtube", ProviderGrant.account == "")
        self.assertEqual((yt.feature, yt.subject), ("*", "all"))
        me = self.client.get("/api/me").get_json()
        self.assertIn("stream", me["user"]["access"]["deezer"])
        self.assertNotIn("my_tracks", me["user"]["access"]["deezer"])  # personal: the holder's

    def test_the_first_run_happens_once(self):
        self.as_bob()
        self.client.get("/api/me")
        n = ProviderGrant.select().count()
        access.invalidate()
        self.client.get("/api/me")
        self.assertEqual(ProviderGrant.select().count(), n)
        self.assertEqual(Meta["acc.boot"].value, "1")

    def test_a_check_costs_no_statement_within_the_second(self):
        self.as_bob()
        self.client.get("/api/me")
        with self.app.test_request_context():
            with count_statements() as c:
                for _ in range(50):
                    access.can(self.bob, "deezer", "stream")
        self.assertEqual(sum(c.values()), 0, dict(c))


class GrantsTestCase(_Case):
    def make_group(self, name, members):
        self.as_alice()
        rv = self.client.post("/api/groups", json={"name": name, "members": [str(m.id) for m in members]})
        self.assertEqual(rv.status_code, 201, rv.get_data(as_text=True))
        return rv.get_json()

    def test_lending_the_account_to_a_group_only(self):
        group = self.make_group("Proches", [self.bob])
        self.grant("*", ["g:" + group["id"]])
        self.as_bob()
        self.assertFalse(self.denied_page())
        self.as_carol()
        self.assertTrue(self.denied_page())
        me = self.client.get("/api/me").get_json()
        self.assertEqual(me["user"]["access"]["deezer"], [])
        # the holder always keeps it
        self.as_alice()
        self.assertFalse(self.denied_page())

    def test_a_person_directly_and_a_feature_overriding_the_account(self):
        self.as_alice()
        self.grant("*", ["u:" + str(self.bob.id)])
        self.grant("browse", ["all"])  # catalogue pages for everybody
        self.as_carol()
        self.assertFalse(self.denied_page())
        me = self.client.get("/api/me").get_json()
        self.assertEqual(me["user"]["access"]["deezer"], ["browse"])
        # removing the override: the feature follows the account again
        self.as_alice()
        rv = self.client.put("/api/access/grants", json={
            "provider": "deezer", "account": str(self.server_account().id), "feature": "browse", "subjects": None,
        })
        self.assertEqual(rv.status_code, 200)
        self.as_carol()
        self.assertTrue(self.denied_page())

    def test_a_refused_person_still_plays_what_is_archived(self):
        self.as_alice()
        self.grant("*", [])
        self.as_bob()
        with self.app.test_request_context():
            from flask import request

            request.webuser = self.bob
            self.assertFalse(access.can(self.bob, "deezer", "stream"))
        # the library's own answers do not ask: the home and the favourites answer
        self.assertEqual(self.client.get("/api/me/favorites").status_code, 200)
        rv = self.client.get("/api/search?q=x")
        self.assertEqual(rv.status_code, 200)

    def test_a_personal_feature_is_never_lent(self):
        self.as_alice()
        self.grant("my_tracks", ["all"], status=400)
        self.grant("teleport", ["all"], status=400)

    def test_only_the_holder_or_an_admin_for_the_server_account_edits(self):
        self.as_bob()
        self.grant("*", ["all"], status=403)
        self.grant("*", ["all"], account="", provider="youtube", status=403)
        self.as_alice()
        self.grant("*", ["all"], account="", provider="youtube")
        # an account somebody else holds is theirs to lend, not the admin's
        other = ProviderAccount.create(provider="youtube", user=self.bob, mode="headers", status="ok")
        self.grant("*", ["all"], account=str(other.id), provider="youtube", status=403)
        self.as_bob()
        self.grant("*", ["u:" + str(self.carol.id)], account=str(other.id), provider="youtube")

    def test_a_subject_must_name_something(self):
        self.as_alice()
        for bad in (["g:not-a-uuid"], ["u:00000000-0000-0000-0000-000000000000"], ["everyone"], "all"):
            self.grant("*", bad, status=400)

    def test_youtube_can_be_kept_for_a_group(self):
        group = self.make_group("Famille", [self.carol])
        self.grant("*", ["g:" + group["id"]], account="", provider="youtube")
        self.as_bob()
        from supysonic.deezer import youtube as yt

        with mock.patch.object(yt, "installed", return_value=True):
            rv = self.client.get("/api/youtube/search?q=x")
            self.assertEqual(rv.status_code, 403)
            self.assertEqual(rv.headers["X-NS-Error"], "youtube-denied")
            status = self.client.get("/api/youtube/status").get_json()
            self.assertEqual(status["allowed"], {"search": False, "stream": False})


class GroupsTestCase(_Case):
    def test_groups_are_the_admin_s(self):
        self.as_bob()
        self.assertEqual(self.client.post("/api/groups", json={"name": "X"}).status_code, 403)
        self.as_alice()
        rv = self.client.post("/api/groups", json={"name": "  Proches  ", "members": [str(self.bob.id)]})
        self.assertEqual(rv.status_code, 201)
        g = rv.get_json()
        self.assertEqual(g["name"], "Proches")
        self.assertEqual([m["name"] for m in g["members"]], ["bob"])
        self.assertEqual(self.client.post("/api/groups", json={"name": "Proches"}).status_code, 409)
        self.assertEqual(self.client.post("/api/groups", json={"name": "x" * 65}).status_code, 400)
        bad = self.client.post("/api/groups", json={"name": "Y", "members": ["nope"]})
        self.assertEqual(bad.status_code, 400)
        self.assertIsNone(UserGroup.get_or_none(UserGroup.name == "Y"))
        rv = self.client.put(f"/api/groups/{g['id']}", json={"members": [str(self.carol.id), str(self.bob.id)]})
        self.assertEqual([m["name"] for m in rv.get_json()["members"]], ["bob", "carol"])

    def test_deleting_a_group_takes_its_grants_with_it(self):
        self.as_alice()
        g = self.client.post("/api/groups", json={"name": "P", "members": [str(self.bob.id)]}).get_json()
        self.grant("*", ["g:" + g["id"], "all"])
        self.assertEqual(self.client.delete(f"/api/groups/{g['id']}").status_code, 200)
        self.assertEqual(UserGroupMember.select().count(), 0)
        self.assertEqual(ProviderGrant.select().where(ProviderGrant.subject.startswith("g:")).count(), 0)
        self.assertEqual(self.client.delete("/api/groups/nope").status_code, 404)

    def test_the_overview(self):
        self.as_alice()
        self.client.post("/api/groups", json={"name": "Proches", "members": [str(self.bob.id)]})
        j = self.client.get("/api/access").get_json()
        ids = [p["id"] for p in j["providers"]]
        self.assertIn("deezer", ids)
        self.assertNotIn("local", ids)
        dz = next(p for p in j["providers"] if p["id"] == "deezer")
        # Lot P3: its public API answers anybody it is opened to (closed here).
        self.assertEqual(dz["anonymous_use"]["grants"], {})
        acc = dz["accounts"][0]
        self.assertTrue(acc["server"] and acc["editable"])
        self.assertEqual(acc["owner"]["name"], "alice")
        self.assertEqual(acc["grants"], {"*": ["all"]})
        mb = next(p for p in j["providers"] if p["id"] == "musicbrainz")
        self.assertEqual(mb["role"], "info")
        self.assertEqual(j["groups"][0]["members"][0]["name"], "bob")
        self.assertIn("users", j)
        # somebody with nothing to lend sees no member list and no user list
        self.as_bob()
        j = self.client.get("/api/access").get_json()
        self.assertNotIn("members", j["groups"][0])
        self.assertNotIn("users", j)
        dz = next(p for p in j["providers"] if p["id"] == "deezer")
        self.assertEqual(dz["accounts"][0]["grants"], {})


class SubsonicStreamTestCase(_Case):
    def test_the_subsonic_stream_asks_the_same_question(self):
        from supysonic.api import media

        self.as_alice()
        self.grant("*", [])
        with self.app.test_request_context():
            from flask import request

            request.user = self.bob
            self.assertFalse(media._may_use("deezer", "stream"))
            request.user = self.alice
            self.assertTrue(media._may_use("deezer", "stream"))


class MigrationTestCase(unittest.TestCase):
    """A server at 20261022 boots on this code: the tables appear, the account
    column too, and nothing else moves."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "t.db")
        self.uri = "sqlite:///" + self.path

    def tearDown(self):
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_upgrade_from_20261022(self):
        init_database(self.uri)
        User.create(name="admin", password="x", salt="x", admin=True)
        release_database()
        conn = sqlite3.connect(self.path)
        for table in ("user_group_member", "user_group", "provider_grant"):
            conn.execute(f"DROP TABLE {table}")
        conn.execute("ALTER TABLE provider_account DROP COLUMN mode")
        conn.execute("UPDATE meta SET value = '20261022' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

        init_database(self.uri)
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
        self.assertEqual(UserGroup.select().count(), 0)
        self.assertEqual(ProviderGrant.select().count(), 0)
        ProviderAccount.create(provider="deezer", mode="arl", status="ok")
        self.assertEqual(User.select().count(), 1)
        # idempotent: the script again over the new tables
        release_database()
        conn = sqlite3.connect(self.path)
        conn.execute("UPDATE meta SET value = '20261022' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()
        init_database(self.uri)
        self.assertEqual(ProviderAccount.select().count(), 1)

    def test_the_tables_are_in_the_copy_between_engines(self):
        init_database(self.uri)
        order = {m._meta.table_name for m in dbmod._migration_order()}
        self.assertLessEqual({"user_group", "user_group_member", "provider_grant"}, order)


if __name__ == "__main__":
    unittest.main()

# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot A of the multi-provider plan: the schema (track_source, entity_ref,
provider_account), the provider interface, the registry, the fake provider, the
sources of a title and the identity of a record. An existing server upgrades
with every id, path and row intact."""

import collections
import os
import shutil
import sqlite3
import tempfile
import unittest
import uuid

from supysonic import db as dbmod
from supysonic import sources
from supysonic.db import (
    Album,
    Artist,
    EntityRef,
    Folder,
    Meta,
    Playlist,
    PlaylistTrack,
    ProviderAccount,
    StarredTrack,
    Track,
    TrackSource,
    User,
    init_database,
    release_database,
)
from supysonic.deezer import ids, library, youtube
from supysonic.providers import (
    CapabilityMissing,
    Gone,
    Provider,
    ProviderUnavailable,
    Registry,
)
from supysonic.providers import base
from supysonic.providers.fake import FakeProvider
from supysonic.providers.registry import MemoryStore

from .multi_helpers import assert_calls, hit, registry_with
from .test_deezer import count_statements


def raw_track(sid, title="Song", alb="600"):
    return {
        "SNG_ID": str(sid), "SNG_TITLE": title, "ART_NAME": "Artist",
        "ART_ID": "500", "ALB_TITLE": "Album", "ALB_ID": alb,
        "DURATION": "200", "TRACK_NUMBER": "1", "DISK_NUMBER": "1",
    }


class _DbCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "t.db")
        self.uri = "sqlite:///" + self.path
        init_database(self.uri)
        self.archive = os.path.join(self.dir, "archive")
        os.makedirs(self.archive)

    def tearDown(self):
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)

    def deezer_track(self, sid="1", title="Song"):
        root = library.get_root_folder(self.archive)
        return library.upsert_track(raw_track(sid, title), root)

    def upload(self, name="mine.flac"):
        root = library.get_root_folder(self.archive)
        artist = Artist.create(name="Me")
        album = Album.create(name="Mine", artist=artist)
        path = os.path.join(self.archive, name)
        return Track.create(
            disc=1, number=1, title="Upload", duration=10, has_art=False,
            album=album, artist=artist, bitrate=0, path=path,
            last_modification=1, root_folder=root, folder=root,
        )


class SchemaTestCase(_DbCase):
    def test_the_new_tables_are_in_a_fresh_database(self):
        self.assertEqual(Meta["schema_version"].value, "20261021")
        self.assertEqual(TrackSource.select().count(), 0)
        self.assertEqual(EntityRef.select().count(), 0)
        self.assertEqual(ProviderAccount.select().count(), 0)

    def test_the_tables_are_in_the_copy_between_engines(self):
        order = {m._meta.table_name for m in dbmod._migration_order()}
        self.assertLessEqual({"track_source", "entity_ref", "provider_account"}, order)

    def test_a_provider_record_belongs_to_one_title(self):
        a, b = self.deezer_track("1"), self.deezer_track("2", "Two")
        row = sources.attach(a, "jamendo", "J1")
        again = sources.attach(b, "jamendo", "J1")
        self.assertEqual(again.track_id, a.id)
        self.assertEqual(TrackSource.select().where(TrackSource.provider == "jamendo").count(), 1)
        self.assertEqual(row.track_id, a.id)

    def test_deleting_a_track_deletes_its_sources(self):
        t = self.deezer_track("1")
        self.assertEqual(TrackSource.select().count(), 1)
        Track.delete().where(Track.id == t.id).execute()
        self.assertEqual(TrackSource.select().count(), 0)


class UpgradeTestCase(_DbCase):
    """A server at 20261019, with data, boots on this code."""

    def rewind(self):
        release_database()
        conn = sqlite3.connect(self.path)
        for table in ("track_source", "entity_ref", "provider_account"):
            conn.execute(f"DROP TABLE {table}")
        conn.execute("UPDATE meta SET value = '20261019' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

    def snapshot(self):
        conn = sqlite3.connect(self.path)
        try:
            return {
                t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall()
                for t in ("track", "album", "artist", "playlist", "starred_track", "playlist_track")
            }
        finally:
            conn.close()

    def test_an_existing_library_gets_exactly_its_sources_and_changes_nothing_else(self):
        dz = self.deezer_track("111", "Deezer one")
        dz2 = self.deezer_track("222", "Deezer two")
        yt = youtube.upsert_track(
            {"video_id": "abcdefghijk", "title": "YT", "artists": [{"name": "Y"}],
             "duration": 100},
            self.archive,
        )
        up = self.upload()
        pl = Playlist.create(user=User.create(name="bob", password="x", salt="x", admin=False), name="P")
        PlaylistTrack.create(playlist=pl, track=dz, index=0)
        PlaylistTrack.create(playlist=pl, track=up, index=1)
        StarredTrack.create(user=pl.user, starred=dz2, date=dbmod.now())
        self.rewind()
        before = self.snapshot()
        ids_before = {t: str(t) for t in (dz.id, dz2.id, yt.id, up.id)}

        init_database(self.uri)
        self.assertEqual(Meta["schema_version"].value, "20261021")
        self.assertEqual(self.snapshot(), before)  # not one existing row touched
        got = {(s.provider, s.ref): s.track_id for s in TrackSource.select()}
        self.assertEqual(
            got,
            {("deezer", "111"): dz.id, ("deezer", "222"): dz2.id, ("youtube", "abcdefghijk"): yt.id},
        )
        self.assertNotIn(up.id, got.values())  # an upload has no source
        refs = {(e.kind, e.provider, e.ref): e.entity for e in EntityRef.select()}
        self.assertEqual(refs[("album", "deezer", "600")], ids.album_uuid("600"))
        self.assertEqual(refs[("artist", "deezer", "500")], ids.artist_uuid("500"))
        # The UUIDs are the ones the deterministic functions give.
        self.assertEqual(dz.id, ids.track_uuid("111"))
        self.assertEqual(ids_before[dz.id], str(ids.track_uuid("111")))
        # Booting again is a no-op (the migration is idempotent).
        release_database()
        init_database(self.uri)
        self.assertEqual(TrackSource.select().count(), 3)

    def test_the_migration_runs_twice_without_duplicating(self):
        self.deezer_track("1")
        self.rewind()
        init_database(self.uri)
        n = TrackSource.select().count()
        release_database()
        conn = sqlite3.connect(self.path)
        conn.execute("UPDATE meta SET value = '20261019' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()
        init_database(self.uri)  # the script runs again over filled tables
        self.assertEqual(TrackSource.select().count(), n)

    def test_the_old_config_and_the_app_still_boot(self):
        from supysonic.config import DefaultConfig
        from supysonic.web import create_application

        self.deezer_track("1")
        self.rewind()
        path, cache, archive = self.path, self.dir, self.archive

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache)
                self.DEEZER = dict(
                    self.DEEZER, enabled=True, arl="x" * 192,
                    archive_dir=archive, push_to_deezer=True,
                )

        app = create_application(Config())
        self.assertEqual(TrackSource.select().count(), 1)
        self.assertIsNotNone(app.deezer)  # [deezer] arl still builds the client
        self.assertEqual([p.id for p in app.providers.all()], ["fake"])


class InterfaceTestCase(unittest.TestCase):
    def test_a_provider_with_only_search_registers(self):
        class OnlySearch(Provider):
            id = "onlysearch"
            capabilities = frozenset({base.SEARCH})

            def search(self, query, kinds=("track",), limit=20):
                return {"tracks": []}

        reg = Registry(store=MemoryStore())
        reg.register(OnlySearch())
        self.assertIs(reg.require("onlysearch", base.SEARCH), reg.get("onlysearch"))
        with self.assertRaises(CapabilityMissing) as cm:
            reg.require("onlysearch", base.AUDIO)
        self.assertIn("audio", str(cm.exception))
        with self.assertRaises(NotImplementedError):
            reg.get("onlysearch").offers("x")

    def test_a_declared_capability_must_be_implemented(self):
        class Liar(Provider):
            id = "liar"
            capabilities = frozenset({base.AUDIO})

        with self.assertRaisesRegex(ValueError, "does not implement"):
            Registry(store=MemoryStore()).register(Liar())

    def test_the_id_is_a_clean_key(self):
        for bad in ("", "Deezer", "a" * 17, "no-dash", "sp ace"):
            fake = FakeProvider(id="x")
            fake.id = bad
            with self.assertRaises(ValueError, msg=bad):
                Registry(store=MemoryStore()).register(fake)

    def test_a_second_provider_under_the_same_id_is_refused(self):
        reg = registry_with(FakeProvider("a"))
        with self.assertRaises(ValueError):
            reg.register(FakeProvider("a"))

    def test_only_an_answer_is_a_verdict(self):
        self.assertTrue(issubclass(Gone, Exception))
        self.assertFalse(issubclass(ProviderUnavailable, Gone))


class FakeProviderTestCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeProvider("fk", {"r1": hit("Hello"), "r2": hit("World", "Other")})

    def test_it_searches_and_counts_its_calls(self):
        out = self.fake.search("hel")
        self.assertEqual([h["ref"] for h in out["tracks"]], ["r1"])
        assert_calls(self.fake, search=1)

    def test_it_writes_a_real_audio_file(self):
        import wave

        d = tempfile.mkdtemp()
        try:
            dest = os.path.join(d, "a.wav")
            self.fake.fetch("r1", None, dest)
            with wave.open(dest) as w:
                self.assertAlmostEqual(w.getnframes() / w.getframerate(), 0.2, places=2)
        finally:
            shutil.rmtree(d)

    def test_it_simulates_gone_an_outage_and_nothing_else(self):
        self.fake.gone.add("r1")
        with self.assertRaises(Gone):
            self.fake.offers("r1")
        self.fake.go_down()
        with self.assertRaises(ProviderUnavailable):
            self.fake.search("x")
        self.fake.come_back()
        self.assertEqual(len(self.fake.offers("r2")), 1)

    def test_available_costs_no_call(self):
        self.fake.available()
        assert_calls(self.fake)


class RegistryTestCase(_DbCase):
    def test_the_order_and_the_switches_persist_in_meta(self):
        reg = Registry()
        for pid in ("a", "b", "c"):
            reg.register(FakeProvider(pid))
        self.assertEqual([p.id for p in reg.ordered()], ["a", "b", "c"])
        reg.set_order(["c", "a"])
        reg.set_enabled("a", False)
        again = Registry()  # a restart: a new registry, the same database
        for pid in ("a", "b", "c"):
            again.register(FakeProvider(pid))
        self.assertEqual([p.id for p in again.ordered()], ["c", "a", "b"])
        self.assertEqual([p.id for p in again.enabled()], ["c", "b"])
        self.assertEqual([p.id for p in again.all()], ["a", "b", "c"])  # off, not gone
        self.assertEqual(Meta["prov.a.on"].value, "0")
        self.assertTrue(all(len(m.key) <= 32 for m in Meta.select()))

    def test_a_provider_that_needs_credentials_is_on_once_it_has_them(self):
        reg = registry_with(FakeProvider("k", requires_credentials=True, ready=False))
        self.assertEqual(reg.enabled(), [])
        reg.get("k").ready = True
        reg._cache = None
        self.assertEqual([p.id for p in reg.enabled()], ["k"])
        reg.set_enabled("k", False)
        self.assertEqual(reg.enabled(), [])

    def test_a_broken_entry_point_does_not_stop_the_start(self):
        from importlib import metadata
        from unittest import mock

        class Good(FakeProvider):
            def __init__(self):
                super().__init__("good")

        def boom():
            raise ImportError("third party is broken")

        points = [
            mock.Mock(**{"name": "bad", "load.side_effect": ImportError("x")}),
            mock.Mock(**{"name": "malformed", "load.return_value": object}),
            mock.Mock(**{"name": "good", "load.return_value": Good}),
        ]
        reg = Registry(store=MemoryStore())
        with mock.patch.object(metadata, "entry_points", return_value=points):
            with self.assertLogs("supysonic.providers.registry", "ERROR"):
                loaded = reg.load_entry_points()
        self.assertEqual([p.id for p in loaded], ["good"])
        self.assertEqual([p.id for p in reg.all()], ["good"])

    def test_the_app_builds_a_registry(self):
        from supysonic.config import DefaultConfig
        from supysonic.web import create_application

        path, cache = os.path.join(self.dir, "app.db"), self.dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache)

        release_database()
        app = create_application(Config())
        self.assertIsInstance(app.providers, Registry)
        self.assertTrue(hasattr(app, "deezer"))


class SourcesTestCase(_DbCase):
    def test_a_deezer_import_gives_the_title_its_source(self):
        t = self.deezer_track("42")
        rows = sources.for_track(t)
        self.assertEqual([(r["provider"], r["ref"]) for r in rows], [("deezer", "42")])
        self.assertEqual(t.id, ids.track_uuid("42"))
        self.assertEqual(Track.get_by_id(t.id).deezer_id, "42")

    def test_attach_is_idempotent_and_refreshes_the_offer(self):
        t = self.deezer_track("1")
        sources.attach(t, "deezer", "1", {"quality": 5, "fmt": "flac", "bitrate": 900})
        sources.attach(t, "deezer", "1", {"quality": 5, "fmt": "flac", "bitrate": 900})
        row = sources.for_track(t)[0]
        self.assertEqual((row["quality"], row["fmt"], row["bitrate"]), (5, "flac", 900))
        self.assertEqual(TrackSource.select().count(), 1)

    def test_attach_writes_the_legacy_column_in_the_same_call(self):
        t = self.upload()
        self.assertIsNone(t.youtube_id)
        sources.attach(t, "youtube", "vid12345678")
        self.assertEqual(Track.get_by_id(t.id).youtube_id, "vid12345678")
        self.assertEqual(t.youtube_id, "vid12345678")
        # A second id for the same provider never replaces the first.
        sources.attach(t, "youtube", "other1234567")
        self.assertEqual(Track.get_by_id(t.id).youtube_id, "vid12345678")
        self.assertEqual(len(sources.for_track(t)), 2)
        # Another provider has no legacy column: only track_source.
        sources.attach(t, "jamendo", "9")
        self.assertEqual(len(sources.for_track(t)), 3)

    def test_for_tracks_is_one_statement_for_two_hundred_titles(self):
        ts = []
        root = library.get_root_folder(self.archive)
        with dbmod.db.atomic():
            for i in range(200):
                ts.append(library.upsert_track(raw_track(i + 1, f"T{i}"), root))
        with count_statements() as n:
            out = sources.for_tracks([t.id for t in ts])
        self.assertEqual(sum(n.values()), 1, n)
        self.assertEqual(len(out), 200)

    def test_a_verdict_is_about_the_source_and_clears(self):
        t = self.deezer_track("1")
        sources.attach(t, "jamendo", "J")
        self.assertEqual(sources.mark_gone(t, "deezer"), 1)
        by = {r["provider"]: r for r in sources.for_track(t)}
        self.assertIsNotNone(by["deezer"]["unavailable"])
        self.assertIsNone(by["jamendo"]["unavailable"])
        self.assertIsNone(Track.get_by_id(t.id).unavailable)  # the title is not condemned
        sources.clear_gone(t, "deezer")
        self.assertIsNone(sources.for_track(t)[0]["unavailable"])

    def test_albums_artists_and_shows_get_their_refs(self):
        t = self.deezer_track("1")
        refs = {(e.kind, e.ref): e.entity for e in EntityRef.select()}
        self.assertEqual(refs[("album", "600")], t.album_id)
        self.assertEqual(refs[("artist", "500")], t.artist_id)
        # Re-importing the same title costs no new ref.
        self.deezer_track("1")
        self.assertEqual(EntityRef.select().count(), 2)

    def test_a_youtube_row_has_its_source(self):
        t = youtube.upsert_track(
            {"video_id": "abcdefghijk", "title": "YT", "artists": [{"name": "Y"}], "duration": 9},
            self.archive,
        )
        self.assertEqual([(r["provider"], r["ref"]) for r in sources.for_track(t)], [("youtube", "abcdefghijk")])

    def test_dropping_an_entity_forgets_its_refs(self):
        from supysonic.webui import refs

        t = self.deezer_track("1")
        refs.drop_entity("album", t.album_id)
        self.assertEqual(EntityRef.select().where(EntityRef.kind == "album").count(), 0)


class IdentityTestCase(_DbCase):
    def test_deezer_and_youtube_uuids_are_the_ones_written_down(self):
        # Literals taken from master BEFORE this lot: every client's ids depend
        # on them, so they are never computed from the function under test.
        self.assertEqual(str(ids.entity_uuid("deezer", "track", "3135556")), "07e9d96b-af2c-5213-96bf-e9d8ea203276")
        self.assertEqual(str(ids.entity_uuid("deezer", "album", "1")), "36a0c40c-51ef-5eb0-9de3-d35c031043de")
        self.assertEqual(str(ids.entity_uuid("youtube", "track", "abcdefghijk")), "fb634cf7-dec1-5e72-b93f-46a7da1fe3f3")
        self.assertEqual(ids.entity_uuid("deezer", "artist", "1"), ids.artist_uuid("1"))
        self.assertEqual(ids.entity_uuid("deezer", "playlist", "1"), ids.playlist_uuid("1"))
        self.assertEqual(ids.entity_uuid("deezer", "show", "1"), ids.show_uuid("1"))
        self.assertEqual(ids.entity_uuid("youtube", "album", "k"), ids.youtube_album_uuid("k"))

    def test_another_provider_is_derived_and_stable(self):
        a = ids.entity_uuid("jamendo", "track", "9")
        self.assertEqual(a, ids.entity_uuid("jamendo", "track", "9"))
        self.assertNotEqual(a, ids.entity_uuid("jamendo", "album", "9"))
        self.assertNotEqual(a, ids.entity_uuid("other", "track", "9"))
        self.assertEqual(str(a), "5fa27a36-c3e9-57ef-8c28-ee54f48b659f")

    def test_resolve_ref_prefers_what_the_database_knows(self):
        from supysonic.webui import refs

        t = self.deezer_track("1")
        sources.attach(t, "jamendo", "J1")
        self.assertEqual(refs.resolve_ref("jamendo", "track", "J1"), t.id)
        # Unknown: the deterministic UUID, so a search result plays before it has a row.
        self.assertEqual(
            refs.resolve_ref("jamendo", "track", "J2"), ids.entity_uuid("jamendo", "track", "J2")
        )
        self.assertEqual(refs.resolve_ref("deezer", "album", "600"), t.album_id)
        self.assertEqual(refs.resolve_ref("deezer", "album", "601"), ids.album_uuid("601"))

    def test_the_id_of_a_title_found_under_another_provider_is_the_existing_one(self):
        from supysonic.webui import refs

        t = self.deezer_track("1")
        sources.attach(t, "jamendo", "J1")
        self.assertEqual(refs.resolve_ref("jamendo", "track", "J1"), t.id)
        self.assertNotEqual(ids.entity_uuid("jamendo", "track", "J1"), t.id)


class ResolveTracksTestCase(_DbCase):
    def setUp(self):
        super().setUp()
        from supysonic.config import DefaultConfig
        from supysonic.web import create_application

        release_database()
        path, cache = os.path.join(self.dir, "r.db"), self.dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache)

        self.app = create_application(Config())
        from supysonic.managers.user import UserManager

        UserManager.add("alice", "Alic3", admin=True)

    def resolve(self, raws, counting=None):
        from supysonic.webui import refs

        with self.app.test_request_context():
            from flask import request

            request.webuser = User.get(name="alice")
            if counting is None:
                return refs.resolve_tracks(raws)
            with count_statements() as n:
                out = refs.resolve_tracks(raws)
            counting.update(n)
            return out

    def test_prefixed_ids_resolve_alongside_uuids_and_numbers(self):
        a = self.deezer_track("1")
        b = self.deezer_track("2", "Two")
        c = self.deezer_track("3", "Three")
        sources.attach(c, "jamendo", "J3")
        y = youtube.upsert_track(
            {"video_id": "abcdefghijk", "title": "YT", "artists": [{"name": "Y"}], "duration": 9},
            self.archive,
        )
        out = self.resolve(
            [str(a.id), "2", "deezer:1", "jamendo:J3", "youtube:abcdefghijk", "jamendo:nope", "bad id:1", "x:"]
        )
        self.assertEqual(
            [t.id if t else None for t in out],
            [a.id, b.id, a.id, c.id, y.id, None, None, None],
        )

    def test_two_hundred_mixed_ids_cost_two_statements_at_most(self):
        root = library.get_root_folder(self.archive)
        raws = []
        with dbmod.db.atomic():
            for i in range(60):
                t = library.upsert_track(raw_track(i + 1, f"T{i}"), root)
                raws.append(str(t.id))
                raws.append(str(i + 1000))  # unknown deezer id
                raws.append(f"deezer:{i + 1}")
                if i % 3 == 0:
                    sources.attach(t, "jamendo", f"J{i}")
                    raws.append(f"jamendo:J{i}")
        raws = raws[:200]
        n = collections.Counter()
        out = self.resolve(raws, counting=n)
        self.assertLessEqual(sum(n.values()), 2, n)
        self.assertEqual(len(raws), 200)
        # Every id but the unknown numeric ones resolves.
        self.assertEqual([r for r, t in zip(raws, out) if t is None], [r for r in raws if r.isdigit()])
        self.assertEqual(sum(1 for t in out if t), 200 - 60)

    def test_an_id_that_could_steer_a_query_is_refused(self):
        self.assertEqual(self.resolve(["jamendo:a b", "jamendo:" + "x" * 129, "jamendo:'; --", ":1"]), [None] * 4)


class FirstImportCostTestCase(_DbCase):
    def test_a_new_track_costs_one_source_statement_not_five(self):
        root = library.get_root_folder(self.archive)
        library.upsert_track(raw_track(1, "A"), root)
        with count_statements() as n:
            library.upsert_track(raw_track(2, "B"), root)  # same artist and album
        self.assertEqual(TrackSource.select().count(), 2)
        # The track and ONE insert for the source (nothing else is written:
        # the artist and the album already exist).
        self.assertEqual(n["INSERT"], 2, n)
        # Re-importing an unchanged track writes nothing at all.
        with count_statements() as again:
            library.upsert_track(raw_track(2, "B"), root)
        self.assertEqual(again["INSERT"], 0, again)

    def test_attach_new_ignores_a_conflict(self):
        t = self.deezer_track("1")
        sources.attach_new(t, "deezer", "1")
        sources.attach_new(t, "deezer", "1")
        self.assertEqual(TrackSource.select().count(), 1)

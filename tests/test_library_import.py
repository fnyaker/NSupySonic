# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Plan multi-provider §15, lot P2: what a person's own account brings into
their library. Each item is imported once (the local library counts after
that), an unticked one never, nothing is written to the account, a refused
credential stops the daily run, and nobody reads or drives another person's."""

import os
import shutil
import sqlite3
import tempfile
import unittest
from datetime import timedelta
from unittest import mock

from supysonic import db as dbmod
from supysonic import libraryimport as li
from supysonic import releases
from supysonic.db import (
    Artist,
    EntityRef,
    LibraryItem,
    Meta,
    Playlist,
    PlaylistTrack,
    ProviderAccount,
    ServiceLink,
    StarredAlbum,
    StarredArtist,
    StarredTrack,
    User,
    init_database,
    now,
    release_database,
)
from supysonic.deezer import ids
from supysonic.deezer.provider import DeezerProvider
from supysonic.managers.user import encrypt_password
from supysonic.providers.errors import ProviderAuth

from .test_access import _Case
from .test_deezer import count_statements
from .test_webui import MockDz, MockGW, raw_track


class LibraryGW(MockGW):
    """The account's own library, as the gateway lists it."""

    def __init__(self, artists=(("9", "Foo"), ("8", "Bar")), favs=("1", "2"), albums=(("10", "Album"),)):
        super().__init__()
        self.artists = list(artists)
        self.favs = list(favs)
        self.albums = list(albums)
        self.calls = []

    def get_user_favorite_ids(self, checksum=None, limit=10000, start=0):
        self.calls.append("favs")
        return {"data": [{"SNG_ID": s} for s in self.favs], "checksum": None}

    def get_tracks(self, sng_ids):
        self.calls.append(("tracks", tuple(sng_ids)))
        return [raw_track(s, f"T{s}") for s in sng_ids]

    def get_user_profile_page(self, user_id, tab, limit=10):
        self.calls.append(("profile", tab))
        if tab == "artists":
            data = [{"ART_ID": a, "ART_NAME": n, "ART_PICTURE": "p"} for a, n in self.artists]
        else:
            data = [
                {"ALB_ID": a, "ALB_TITLE": n, "ART_ID": "1", "ART_NAME": "Artist", "ALB_PICTURE": "c"}
                for a, n in self.albums
            ]
        return {"TAB": {tab: {"data": data}}}


def personal_provider(archive, gw=None, user=None):
    provider = DeezerProvider("personal", archive, "FLAC")
    provider._dz = MockDz()
    provider._dz.gw = gw or LibraryGW()
    provider._dz.current_user = user or {"id": 77, "name": "bob-dz"}
    return provider


class _ImportCase(_Case):
    def setUp(self):
        super().setUp()
        self.app.config["LIBRARY_IMPORT_INLINE"] = True
        self.gw = LibraryGW()
        self.app.deezer._dz.gw = self.gw

    def tearDown(self):
        li._clients.clear()
        li._listings.clear()
        li._runs.clear()
        super().tearDown()

    def my_accounts(self):
        rv = self.client.get("/api/me/accounts")
        self.assertEqual(rv.status_code, 200)
        return rv.get_json()["accounts"]

    def run_import(self, account, status=202, **body):
        rv = self.client.post(f"/api/me/accounts/{account}/import", json=body)
        self.assertEqual(rv.status_code, status, rv.get_data(as_text=True))
        return rv.get_json()

    def stars(self, model, user):
        return {str(s) for (s,) in model.select(model.starred).where(model.user == user.id).tuples()}


class ServerAccountTestCase(_ImportCase):
    def test_the_holder_of_the_server_account_imports_its_artists_and_tracks(self):
        self.as_alice()
        self.server_account()
        (acc,) = self.my_accounts()
        self.assertTrue(acc["server"])
        self.assertEqual(acc["auto"], {"artists": True, "tracks": True, "albums": False, "playlists": False})
        self.run_import(acc["id"])

        self.assertEqual(
            self.stars(StarredArtist, self.alice), {str(ids.artist_uuid(9)), str(ids.artist_uuid(8))}
        )
        self.assertEqual(
            self.stars(StarredTrack, self.alice), {str(ids.track_uuid(1)), str(ids.track_uuid(2))}
        )
        self.assertEqual(self.stars(StarredAlbum, self.alice), set())  # off by default
        # Followed: what Nouveautés watches.
        self.assertEqual(releases.favourite_refs("deezer", [self.alice.id]), {"9": "Foo", "8": "Bar"})
        (acc,) = self.my_accounts()
        self.assertEqual(acc["last"]["added"], {"artists": 2, "tracks": 2})
        self.assertIsNone(acc["last"]["error"])
        self.assertEqual(acc["status"], "ok")

    def test_what_was_taken_off_here_is_not_put_back(self):
        self.as_alice()
        acc = str(self.server_account().id)
        self.run_import(acc)
        StarredArtist.delete().where(StarredArtist.starred == ids.artist_uuid(9)).execute()
        StarredTrack.delete().where(StarredTrack.starred == ids.track_uuid(1)).execute()
        self.gw.artists.append(("7", "New"))
        self.gw.favs.append("3")
        self.gw.calls.clear()
        self.run_import(acc)

        self.assertEqual(
            self.stars(StarredArtist, self.alice), {str(ids.artist_uuid(8)), str(ids.artist_uuid(7))}
        )
        self.assertEqual(
            self.stars(StarredTrack, self.alice), {str(ids.track_uuid(2)), str(ids.track_uuid(3))}
        )
        # Only the new track's record was asked for.
        self.assertIn(("tracks", ("3",)), self.gw.calls)
        self.assertNotIn(("tracks", ("1", "2", "3")), self.gw.calls)

    def test_a_second_run_with_nothing_new_writes_nothing(self):
        self.as_alice()
        acc = str(self.server_account().id)
        self.run_import(acc)
        with count_statements() as counts:
            self.run_import(acc)
        # The account, the two lists' known items, the report: no insert.
        self.assertEqual(counts["INSERT"], 0)
        self.assertLessEqual(sum(counts.values()), 20, counts)

    def test_a_thousand_new_tracks_cost_a_bounded_number_of_statements(self):
        self.gw.favs = [str(i) for i in range(1, 1001)]
        self.gw.artists = []
        self.as_alice()
        acc = str(self.server_account().id)
        with count_statements() as counts:
            self.run_import(acc, kinds=["tracks"])
        self.assertEqual(StarredTrack.select().where(StarredTrack.user == self.alice.id).count(), 1000)
        # The stars and the seen items go in batches of 200, not one per track.
        self.assertLessEqual(counts["INSERT"] - 3 * 1000, 30, counts)

    def test_the_options_choose_what_is_imported(self):
        self.as_alice()
        acc = str(self.server_account().id)
        rv = self.client.put(f"/api/me/accounts/{acc}", json={"auto": {"tracks": False, "albums": True}})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(rv.get_json()["account"]["auto"]["albums"], True)
        self.run_import(acc)
        self.assertEqual(self.stars(StarredTrack, self.alice), set())
        self.assertEqual(self.stars(StarredAlbum, self.alice), {str(ids.album_uuid(10))})
        # The album came with its whole tracklist.
        self.assertIn("10", self.gw.taken_albums)
        self.assertEqual(
            self.client.put(f"/api/me/accounts/{acc}", json={"auto": {"nope": True}}).status_code, 400
        )

    def test_playlists_are_merged_and_never_touch_somebody_elses(self):
        self.as_alice()
        acc = str(self.server_account().id)
        theirs = Playlist.create(id=ids.playlist_uuid(77), user=self.bob, name="Bob's", deezer_id="77")
        self.run_import(acc, kinds=["playlists"])
        theirs = Playlist.get_by_id(theirs.id)
        self.assertEqual(theirs.name, "Bob's")
        self.assertEqual(PlaylistTrack.select().where(PlaylistTrack.playlist == theirs.id).count(), 0)
        mine = Playlist.get(Playlist.user == self.alice.id)
        self.assertEqual(mine.name, "P")
        self.assertEqual(PlaylistTrack.select().where(PlaylistTrack.playlist == mine.id).count(), 5)

    def test_the_holder_of_the_server_account_cannot_link_a_second_deezer(self):
        self.as_alice()
        self.server_account()
        rv = self.client.post("/api/me/accounts/deezer", json={"arl": "a" * 192})
        self.assertEqual(rv.status_code, 409)
        acc = str(self.server_account().id)
        self.assertEqual(self.client.delete(f"/api/me/accounts/{acc}").status_code, 409)


class PickerTestCase(_ImportCase):
    def test_unticking_an_artist_unfollows_it_for_good(self):
        self.as_alice()
        acc = str(self.server_account().id)
        self.run_import(acc)
        rv = self.client.get(f"/api/me/accounts/{acc}/library/artists")
        items = {i["ref"]: i for i in rv.get_json()["items"]}
        self.assertTrue(items["9"]["on"] and items["9"]["in_library"])

        rv = self.client.put(f"/api/me/accounts/{acc}/library/artists", json={"ref": "9", "on": False})
        self.assertEqual(rv.get_json()["on"], False)
        self.assertNotIn(str(ids.artist_uuid(9)), self.stars(StarredArtist, self.alice))
        items = {i["ref"]: i for i in self.client.get(f"/api/me/accounts/{acc}/library/artists").get_json()["items"]}
        self.assertEqual((items["9"]["on"], items["9"]["in_library"]), (False, False))

        # Never imported again, not even after it is forgotten and listed anew.
        StarredArtist.delete().execute()
        self.run_import(acc)
        self.assertEqual(self.stars(StarredArtist, self.alice), set())  # 8 was imported once already

        # Ticked again: imported at once.
        self.client.put(f"/api/me/accounts/{acc}/library/artists", json={"ref": "9", "on": True})
        self.assertIn(str(ids.artist_uuid(9)), self.stars(StarredArtist, self.alice))

    def test_a_whole_list_is_ticked_or_unticked_in_one_request(self):
        self.as_alice()
        acc = str(self.server_account().id)
        self.run_import(acc)
        self.client.get(f"/api/me/accounts/{acc}/library/artists")
        with count_statements() as counts:
            rv = self.client.put(f"/api/me/accounts/{acc}/library/artists", json={"refs": ["9", "8"], "on": False})
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(self.stars(StarredArtist, self.alice), set())
        self.assertLessEqual(sum(counts.values()), 15, counts)  # not a statement per artist
        rv = self.client.put(f"/api/me/accounts/{acc}/library/artists", json={"refs": ["9", "8"], "on": True})
        self.assertTrue(rv.get_json()["imported"])
        self.assertEqual(len(self.stars(StarredArtist, self.alice)), 2)

    def test_an_artist_never_imported_can_be_unticked_before_the_first_run(self):
        self.as_alice()
        acc = str(self.server_account().id)
        self.client.put(f"/api/me/accounts/{acc}", json={"auto": {"artists": False}})
        self.client.get(f"/api/me/accounts/{acc}/library/artists")
        self.client.put(f"/api/me/accounts/{acc}/library/artists", json={"ref": "8", "on": False})
        self.client.put(f"/api/me/accounts/{acc}", json={"auto": {"artists": True}})
        self.run_import(acc)
        self.assertEqual(self.stars(StarredArtist, self.alice), {str(ids.artist_uuid(9))})

    def test_a_bad_request_is_refused(self):
        self.as_alice()
        acc = str(self.server_account().id)
        for body in ({"ref": "9"}, {"on": True}, {"ref": "x" * 65, "on": True}, {"ref": "9", "on": "yes"},
                     {"refs": [], "on": True}, {"refs": [{"x": 1}], "on": True}, {"refs": "9", "on": True}):
            rv = self.client.put(f"/api/me/accounts/{acc}/library/artists", json=body)
            self.assertEqual(rv.status_code, 400, body)
        self.assertEqual(self.client.get(f"/api/me/accounts/{acc}/library/tracks").status_code, 404)
        self.assertEqual(self.client.get("/api/me/accounts/not-a-uuid/library/artists").status_code, 404)


class PersonalDeezerTestCase(_ImportCase):
    def link_bob(self, provider=None):
        provider = provider or personal_provider(self.archive)
        with mock.patch(
            "supysonic.webui.myaccounts._deezer_login", return_value={"id": "77", "name": "bob-dz"}
        ), mock.patch.object(li, "_deezer_client", return_value=provider):
            rv = self.client.post("/api/me/accounts/deezer", json={"arl": "ab12" * 48})
        self.assertEqual(rv.status_code, 200, rv.get_data(as_text=True))
        return rv.get_json()["account"], provider

    def test_bob_links_his_own_deezer_and_his_library_fills(self):
        self.as_bob()
        acc, _p = self.link_bob()
        self.assertEqual((acc["label"], acc["server"], acc["mode"]), ("bob-dz", False, "arl"))
        self.assertEqual(
            self.stars(StarredArtist, self.bob), {str(ids.artist_uuid(9)), str(ids.artist_uuid(8))}
        )
        self.assertEqual(self.stars(StarredArtist, self.alice), set())
        row = ProviderAccount.get_by_id(acc["id"])
        self.assertNotIn("ab12", row.secret)  # stored encrypted
        body = self.client.get("/api/me/accounts").get_data(as_text=True)
        self.assertNotIn(row.secret, body)
        self.assertNotIn("ab12ab12", body)

    def test_an_arl_deezer_refuses_is_not_kept(self):
        self.as_bob()
        with mock.patch(
            "supysonic.webui.myaccounts._deezer_login", side_effect=ProviderAuth("no", provider="deezer")
        ):
            rv = self.client.post("/api/me/accounts/deezer", json={"arl": "ab12" * 48})
        self.assertEqual(rv.status_code, 400)
        self.assertEqual(ProviderAccount.select().where(ProviderAccount.user == self.bob.id).count(), 0)
        for arl in ("", "not an arl!", "a" * 600):
            self.assertEqual(self.client.post("/api/me/accounts/deezer", json={"arl": arl}).status_code, 400)

    def test_the_servers_own_account_cannot_be_linked_as_a_personal_one(self):
        self.as_bob()
        with mock.patch(
            "supysonic.webui.myaccounts._deezer_login", return_value={"id": "42", "name": "tester"}
        ):
            rv = self.client.post("/api/me/accounts/deezer", json={"arl": "ab12" * 48})
        self.assertEqual(rv.status_code, 409)

    def test_nobody_else_reads_or_drives_bobs_account(self):
        self.as_bob()
        acc, _p = self.link_bob()
        for who in (self.as_carol, self.as_alice):
            who()
            self.assertNotIn(acc["id"], [a["id"] for a in self.my_accounts()])
            self.assertEqual(self.client.post(f"/api/me/accounts/{acc['id']}/import").status_code, 404)
            self.assertEqual(self.client.get(f"/api/me/accounts/{acc['id']}/library/artists").status_code, 404)
            self.assertEqual(
                self.client.put(f"/api/me/accounts/{acc['id']}/library/artists", json={"ref": "9", "on": False}).status_code,
                404,
            )
            self.assertEqual(self.client.delete(f"/api/me/accounts/{acc['id']}").status_code, 404)

    def test_unlinking_keeps_what_was_imported(self):
        self.as_bob()
        acc, _p = self.link_bob()
        self.assertEqual(self.client.delete(f"/api/me/accounts/{acc['id']}").status_code, 200)
        self.assertIsNone(ProviderAccount.get_or_none(ProviderAccount.id == acc["id"]))
        self.assertEqual(LibraryItem.select().where(LibraryItem.account == acc["id"]).count(), 0)
        self.assertEqual(len(self.stars(StarredArtist, self.bob)), 2)

    def test_a_refused_credential_stops_the_daily_run(self):
        self.as_bob()
        acc, provider = self.link_bob()
        provider._dz = None
        provider._login_error = ("arl", "Deezer rejected the ARL")
        provider._login_retry_at = float("inf")
        row = ProviderAccount.get_by_id(acc["id"])
        with mock.patch.object(li, "_deezer_client", return_value=provider):
            report = li.run(self.app, row.id)
        self.assertEqual(report["reason"], "auth")
        row = ProviderAccount.get_by_id(acc["id"])
        self.assertEqual(row.status, "auth")
        self.assertFalse(li.due(row))
        # Nothing imported is taken away by a failure.
        self.assertEqual(len(self.stars(StarredArtist, self.bob)), 2)


class DueTestCase(unittest.TestCase):
    def row(self, last=None, auto=None, status="ok"):
        row = ProviderAccount(provider="deezer", status=status, mode="arl")
        row.user_id = "u"
        import json

        row.options = json.dumps({"auto": auto or {}, "last": last})
        return row

    def test_once_a_day_and_an_hour_after_an_outage(self):
        t = now()
        self.assertTrue(li.due(self.row()))
        self.assertFalse(li.due(self.row({"at": (t - timedelta(hours=23)).isoformat()}), t))
        self.assertTrue(li.due(self.row({"at": (t - timedelta(hours=24)).isoformat()}), t))
        net = {"at": (t - timedelta(minutes=61)).isoformat(), "reason": "network"}
        self.assertTrue(li.due(self.row(net), t))
        net["at"] = (t - timedelta(minutes=30)).isoformat()
        self.assertFalse(li.due(self.row(net), t))
        off = {k: False for k in li.KINDS}
        self.assertFalse(li.due(self.row(auto=off)))
        self.assertFalse(li.due(self.row(status="auth")))


class FakeYtm:
    def __init__(self):
        self.calls = []

    def get_liked_songs(self, limit=100):
        self.calls.append("liked")
        return {"tracks": [{"videoId": "abcdefghijk", "title": "Song", "artists": [{"name": "Foo", "id": "UCfoo"}],
                            "album": {"name": "LP", "id": "MPREb_lp"}, "duration_seconds": 200}]}

    def get_library_subscriptions(self, limit=25):
        self.calls.append("subs")
        return [{"browseId": "UCfoo", "artist": "foo"}, {"browseId": "UCnew", "artist": "Brand New"}]

    def get_library_playlists(self, limit=25):
        return [{"playlistId": "LM", "title": "Liked"}, {"playlistId": "PLx", "title": "Mix", "count": "1"}]

    def get_playlist(self, ref, limit=100):
        return {"tracks": [{"videoId": "bcdefghijkl", "title": "Two", "artists": [{"name": "Foo", "id": "UCfoo"}]}]}

    def get_library_albums(self, limit=25):
        return []


class FakeYtClient:
    def __init__(self):
        self.ytm = FakeYtm()

    def account(self):
        return "Bob YT"


class YoutubeTestCase(_ImportCase):
    def test_a_youtube_music_session_imports_subscriptions_and_likes(self):
        Artist.create(id=ids.artist_uuid(9), name="Foo", deezer_id="9")
        ServiceLink.create(user=self.bob, service="youtube", data=encrypt_password("{}"), account="Bob YT", updated=now())
        self.as_bob()
        (acc,) = self.my_accounts()  # the export's session is an account too
        self.assertEqual((acc["provider"], acc["label"]), ("youtube", "Bob YT"))
        fake = FakeYtClient()
        with mock.patch.object(li, "_youtube_client", return_value=fake):
            self.run_import(acc["id"], kinds=["artists", "tracks", "playlists"])
            # "foo" is the library's Foo: followed, not a second Foo.
            self.assertEqual(Artist.select().where(Artist.name ** "foo").count(), 1)
            starred = self.stars(StarredArtist, self.bob)
            self.assertIn(str(ids.artist_uuid(9)), starred)
            self.assertIn(str(ids.youtube_artist_uuid("UCnew")), starred)
            self.assertEqual(releases.favourite_refs("youtube", [self.bob.id]), {"UCfoo": "Foo", "UCnew": "Brand New"})
            self.assertEqual(self.stars(StarredTrack, self.bob), {str(ids.youtube_track_uuid("abcdefghijk"))})
            pl = Playlist.get(Playlist.user == self.bob.id)
            self.assertEqual((pl.name, PlaylistTrack.select().where(PlaylistTrack.playlist == pl.id).count()), ("Mix", 1))
            items = self.client.get(f"/api/me/accounts/{acc['id']}/library/playlists").get_json()["items"]
            self.assertEqual([(i["ref"], i["in_library"]) for i in items], [("PLx", True)])  # "Liked" is the likes
        self.assertEqual(EntityRef.select().where(EntityRef.provider == "youtube", EntityRef.kind == "artist").count(), 2)

    def test_unlinking_the_export_session_unlinks_the_account(self):
        ServiceLink.create(user=self.bob, service="youtube", data=encrypt_password("{}"), account="Bob YT", updated=now())
        self.as_bob()
        (acc,) = self.my_accounts()
        self.assertEqual(self.client.delete("/api/services/youtube").status_code, 200)
        self.assertEqual(self.my_accounts(), [])
        self.assertIsNone(ProviderAccount.get_or_none(ProviderAccount.id == acc["id"]))

    def test_a_dead_session_is_an_auth_failure_not_an_outage(self):
        ServiceLink.create(user=self.bob, service="youtube", data=encrypt_password("{}"), account="Bob YT", updated=now())
        self.as_bob()
        (acc,) = self.my_accounts()
        fake = FakeYtClient()
        fake.ytm.get_library_subscriptions = mock.Mock(side_effect=Exception("HTTP 401: Sign in"))
        with mock.patch.object(li, "_youtube_client", return_value=fake):
            self.run_import(acc["id"], kinds=["artists"])
        self.assertEqual(ProviderAccount.get_by_id(acc["id"]).status, "auth")


class UpgradeBaselineTestCase(_ImportCase):
    """A server the OLD nightly sync mirrored: its holder's favourites are
    already here, minus what they took off. The first import on that account
    must not put any of it back (Maître, 2026-10-25: titles removed here, or
    replaced by a YouTube fallback, came back because Deezer still listed
    them)."""

    def mirrored_library(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive)
        # The old sync had starred 1 and 2 and followed 9 and 8; the holder
        # then took 1 and 8 off here. Deezer still lists all four.
        library.upsert_track(raw_track(1, "T1"), root, "FLAC")
        two = library.upsert_track(raw_track(2, "T2"), root, "FLAC")
        StarredTrack.create(user=self.alice, starred=two.id)
        nine = library.upsert_artist("9", "Foo")
        library.upsert_artist("8", "Bar")
        StarredArtist.create(user=self.alice, starred=nine.id)

    def test_what_was_taken_off_before_the_upgrade_stays_off(self):
        self.mirrored_library()
        self.as_alice()
        acc = str(self.server_account().id)
        self.run_import(acc)
        self.assertEqual(self.stars(StarredTrack, self.alice), {str(ids.track_uuid(2))})
        self.assertEqual(self.stars(StarredArtist, self.alice), {str(ids.artist_uuid(9))})
        (row,) = [a for a in self.my_accounts() if a["id"] == acc]
        self.assertEqual(row["last"]["added"], {"artists": 0, "tracks": 0})
        self.assertEqual(row["last"]["kept"], {"artists": 2, "tracks": 2})
        # Nothing of the favourites' records was even asked for.
        self.assertFalse([c for c in self.gw.calls if c[0] == "tracks"])
        # What the account adds AFTER the upgrade is imported as usual.
        self.gw.favs.append("3")
        self.gw.artists.append(("7", "New"))
        self.run_import(acc)
        self.assertEqual(
            self.stars(StarredTrack, self.alice), {str(ids.track_uuid(2)), str(ids.track_uuid(3))}
        )
        self.assertEqual(
            self.stars(StarredArtist, self.alice), {str(ids.artist_uuid(9)), str(ids.artist_uuid(7))}
        )

    def test_a_fresh_server_imports_everything(self):
        # No Deezer favourite here yet: nothing was mirrored, so nothing was
        # taken off, and the first run brings the account in.
        self.as_alice()
        acc = str(self.server_account().id)
        self.run_import(acc)
        self.assertEqual(len(self.stars(StarredTrack, self.alice)), 2)

    def test_a_personal_account_is_never_a_baseline(self):
        # bob starred Deezer titles here by hand, then links his own account:
        # its favourites are new to this library, and come in.
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive)
        StarredTrack.create(user=self.bob, starred=library.upsert_track(raw_track(5, "T5"), root, "FLAC").id)
        self.as_bob()
        PersonalDeezerTestCase.link_bob(self)
        self.assertEqual(
            self.stars(StarredTrack, self.bob),
            {str(ids.track_uuid(5)), str(ids.track_uuid(1)), str(ids.track_uuid(2))},
        )


class DefaultPlatformTestCase(_ImportCase):
    link_bob = PersonalDeezerTestCase.link_bob

    def youtube_too(self):
        ServiceLink.create(user=self.bob, service="youtube", data=encrypt_password("{}"), account="Bob YT", updated=now())
        return [a for a in self.my_accounts() if a["provider"] == "youtube"][0]

    def test_only_the_default_platform_syncs_every_day(self):
        self.as_bob()
        dz, _p = self.link_bob()
        yt = self.youtube_too()
        payload = self.client.get("/api/me/accounts").get_json()
        self.assertEqual(payload["default"], dz["id"])  # never chosen: their Deezer
        self.assertEqual({a["id"]: a["default"] for a in payload["accounts"]}, {dz["id"]: True, yt["id"]: False})
        self.assertEqual(self.started_for_bob(), [])  # dz ran at linking
        row = ProviderAccount.get_by_id(dz["id"])
        opts = li.options(row)
        opts["last"] = None
        li._save_options(row, opts)
        self.assertEqual(self.started_for_bob(), [dz["id"]])

    def started_for_bob(self):
        mine = {str(r.id) for r in ProviderAccount.select().where(ProviderAccount.user == self.bob.id)}
        with mock.patch.object(li, "start") as start:
            li.run_due(self.app)
        return [str(c.args[1]) for c in start.call_args_list if str(c.args[1]) in mine]

    def test_choosing_a_default_imports_from_it_at_once_and_sticks(self):
        self.as_bob()
        dz, _p = self.link_bob()
        yt = self.youtube_too()
        with mock.patch.object(li, "_youtube_client", return_value=FakeYtClient()):
            rv = self.client.put("/api/me/accounts/default", json={"account": yt["id"]})
        self.assertEqual(rv.status_code, 200, rv.get_data(as_text=True))
        body = rv.get_json()
        self.assertTrue(body["started"])
        self.assertEqual(body["default"], yt["id"])
        self.assertEqual([a["id"] for a in body["accounts"] if a["default"]], [yt["id"]])
        self.assertIn(str(ids.youtube_track_uuid("abcdefghijk")), self.stars(StarredTrack, self.bob))
        # Deezer is no longer read every day; YouTube Music is, when due.
        for acc_id in (dz["id"], yt["id"]):
            row = ProviderAccount.get_by_id(acc_id)
            opts = li.options(row)
            opts["last"] = None
            li._save_options(row, opts)
        self.assertEqual(self.started_for_bob(), [yt["id"]])
        # None at all: nothing is read every day.
        rv = self.client.put("/api/me/accounts/default", json={"account": None})
        self.assertIsNone(rv.get_json()["default"])
        self.assertEqual(self.started_for_bob(), [])

    def test_somebody_elses_account_cannot_be_my_default(self):
        self.as_bob()
        dz, _p = self.link_bob()
        self.as_carol()
        rv = self.client.put("/api/me/accounts/default", json={"account": dz["id"]})
        self.assertEqual(rv.status_code, 404)
        self.as_bob()
        self.assertEqual(self.client.get("/api/me/accounts").get_json()["default"], dz["id"])

    def test_a_second_account_linked_does_not_import_on_its_own(self):
        self.as_bob()
        yt = self.youtube_too()  # the first account: the default
        with mock.patch.object(li, "start") as start:
            dz, _p = self.link_bob()
        start.assert_not_called()
        self.assertFalse(dz["default"])
        # ... and does not take the default over, even being a Deezer.
        self.assertEqual(self.client.get("/api/me/accounts").get_json()["default"], yt["id"])


class ProgressTestCase(_ImportCase):
    def test_a_run_says_which_list_and_how_far(self):
        self.gw.favs = [str(i) for i in range(1, 451)]
        self.as_alice()
        acc = str(self.server_account().id)
        seen = []
        real = self.gw.get_tracks

        def watched(refs):
            seen.append(li.status(acc))
            return real(refs)

        self.gw.get_tracks = watched
        with mock.patch.object(li, "_yield") as yielded:
            self.client.put(f"/api/me/accounts/{acc}", json={"auto": {"artists": False}})
            li._runs[acc] = {"running": True}
            try:
                li.run(self.app, acc)
            finally:
                li._runs.pop(acc, None)
        self.assertEqual(
            [(s["kind"], s["phase"], s["done"], s["total"]) for s in seen],
            [("tracks", "import", 0, 450), ("tracks", "import", 200, 450), ("tracks", "import", 400, 450)],
        )
        # Between two batches, whatever a person waits on goes first.
        self.assertEqual(yielded.call_count, 2)

    def test_between_two_batches_the_import_waits_for_a_person(self):
        from supysonic.deezer import workload

        with mock.patch.object(workload, "quiet_wait") as wait, mock.patch.object(li.time, "sleep") as sleep:
            li._yield()
        wait.assert_called_once()
        sleep.assert_called_once_with(li.PAUSE)


class FavouritesCompleteTestCase(_ImportCase):
    """Every star is in the favourites list, whatever the title is made of,
    and a replacement keeps its place there."""

    def test_every_star_is_listed_and_a_replacement_keeps_its_place(self):
        from datetime import datetime

        from supysonic.deezer import library
        from supysonic.deezer import youtube as yt
        from supysonic.providers.youtube import youtube_from_hit
        from supysonic.webui.availability import replace_everywhere

        root = library.get_root_folder(self.archive)
        dead = library.upsert_track(raw_track(1, "Dead"), root, "FLAC")
        kept = library.upsert_track(raw_track(2, "Kept"), root, "FLAC")
        hit = {"ref": "abcdefghijk", "title": "Dead", "artists": [{"name": "Foo", "ref": "UCfoo"}],
               "album": {"name": "LP", "ref": "MPREb_lp"}, "duration": 200}
        fallback = yt.upsert_track(youtube_from_hit(hit), self.archive)
        StarredTrack.create(user=self.alice, starred=dead.id, date=datetime(2024, 1, 1))
        StarredTrack.create(user=self.alice, starred=kept.id, date=datetime(2024, 1, 2))
        replace_everywhere(self.app, dead, fallback, self.alice.id, True)

        self.as_alice()
        listed = [t["id"] for t in self.client.get("/api/me/favorites").get_json()["tracks"]]
        # Newest star first, the stand-in where the dead title was (not on top).
        self.assertEqual(listed, [str(kept.id), str(fallback.id)])
        ids_ = self.client.get("/api/me/favorite-ids").get_json()["ids"]
        self.assertEqual(len(ids_), StarredTrack.select().where(StarredTrack.user == self.alice.id).count())
        self.assertEqual(ids_, ["2", str(fallback.id)])


class CliTestCase(_ImportCase):
    def test_the_cli_import_is_the_same_remembering_import(self):
        from click.testing import CliRunner

        from supysonic import cli as cli_mod

        class Conf:
            DEEZER = {"sync_user": "alice", "archive_dir": self.archive}

        StarredTrack.delete().execute()
        runner = CliRunner()
        with mock.patch.object(cli_mod, "_require_provider", return_value=self.app.deezer):
            rv = runner.invoke(cli_mod.cli, ["deezer", "import-account"], obj=Conf())
            self.assertEqual(rv.exit_code, 0, rv.output)
            self.assertIn("tracks: 2 added", rv.output)
            StarredTrack.delete().where(StarredTrack.starred == ids.track_uuid(1)).execute()
            rv = runner.invoke(cli_mod.cli, ["deezer", "import-account"], obj=Conf())
        self.assertEqual(rv.exit_code, 0, rv.output)
        self.assertEqual(self.stars(StarredTrack, self.alice), {str(ids.track_uuid(2))})


class MigrationTestCase(unittest.TestCase):
    """A server at 20261025 boots on this code: the table and the column appear,
    and nothing else moves."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "t.db")
        self.uri = "sqlite:///" + self.path

    def tearDown(self):
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)

    def downgrade(self):
        conn = sqlite3.connect(self.path)
        conn.execute("UPDATE meta SET value = '20261025' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

    def test_upgrade_from_20261025(self):
        init_database(self.uri)
        user = User.create(name="admin", password="x", salt="x", admin=True)
        ProviderAccount.create(provider="deezer", user=user, mode="server", status="ok")
        release_database()
        conn = sqlite3.connect(self.path)
        conn.execute("DROP TABLE library_item")
        conn.execute("ALTER TABLE provider_account DROP COLUMN options")
        conn.commit()
        conn.close()
        self.downgrade()

        init_database(self.uri)
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
        row = ProviderAccount.get()
        self.assertIsNone(row.options)
        self.assertEqual(li.options(row)["auto"], li.DEFAULT_AUTO)
        LibraryItem.create(account=str(row.id), kind="artists", ref="9")
        self.assertFalse(LibraryItem.get().excluded)
        release_database()
        self.downgrade()  # the script again over the new table: harmless
        init_database(self.uri)
        self.assertEqual(LibraryItem.select().count(), 1)

    def test_the_table_is_in_the_copy_between_engines(self):
        init_database(self.uri)
        self.assertIn("library_item", {m._meta.table_name for m in dbmod._migration_order()})


if __name__ == "__main__":
    unittest.main()

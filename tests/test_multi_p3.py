# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Plan multi-provider §15, lot P3: which Deezer serves a person. Their own
account first, then the server's, then one lent to them, then the public API
for what it answers to anybody; the sound only through an account that may
fetch FLAC."""

from unittest import mock

from supysonic import access
from supysonic import libraryimport as li
from supysonic.db import Meta, ProviderAccount, ProviderGrant, now
from supysonic.deezer import accounts as dz_accounts

from .test_access import _Case
from .test_webui import api_track


class FakePublic:
    """api.deezer.com as the routes use it, paged like the real one: a page
    carries ``next`` while there is more."""

    def __init__(self, n_tracks=3, down=False):
        self.calls = []
        self.n_tracks = n_tracks
        self.down = down

    def _call(self, name, *args):
        self.calls.append((name,) + args)
        if self.down:
            from deezerpy.errors import DeezerUnavailable

            raise DeezerUnavailable("api.deezer.com is not answering")

    def _page(self, items, index, limit):
        chunk = items[index : index + limit]
        page = {"data": chunk, "total": len(items)}
        if index + limit < len(items):
            page["next"] = "https://api.deezer.com/next"
        return page

    def get_album(self, album_id):
        self._call("album", album_id)
        if str(album_id) == "404":
            return {"error": {"type": "DataException", "code": 800}}
        return {
            "id": int(album_id), "title": "Public album", "cover_big": "https://img/big.jpg",
            "artist": {"id": 1, "name": "Artist"}, "nb_tracks": self.n_tracks,
            "release_date": "2024-03-01",
        }

    def get_album_tracks(self, album_id, index=0, limit=-1):
        self._call("album_tracks", album_id, index, limit)
        items = []
        for i in range(1, self.n_tracks + 1):
            t = api_track(1000 + i)
            del t["album"]  # the album's own tracklist leaves the album out
            items.append(t)
        return self._page(items, index, limit)

    def get_playlist(self, playlist_id):
        self._call("playlist", playlist_id)
        return {"id": int(playlist_id), "title": "Public playlist", "picture_medium": "https://img/p.jpg",
                "nb_tracks": 2, "duration": 400, "user": {"name": "someone"}}

    def get_playlist_tracks(self, playlist_id, index=0, limit=-1):
        self._call("playlist_tracks", playlist_id, index, limit)
        return self._page([api_track(2001), api_track(2002)], index, limit)

    def get_artist_albums(self, artist_id, index=0, limit=-1):
        self._call("artist_albums", artist_id, index, limit)
        items = [
            {"id": 31, "title": "Old", "record_type": "album", "release_date": "2001-01-01", "nb_tracks": 9},
            {"id": 32, "title": "New", "record_type": "album", "release_date": "2023-01-01", "nb_tracks": 11},
            {"id": 33, "title": "Single", "record_type": "single", "release_date": "2022-05-05", "nb_tracks": 1},
        ]
        return self._page(items, index, limit)


class _P3Case(_Case):
    CLOSE_ANONYMOUS = False

    def setUp(self):
        super().setUp()
        self.public = FakePublic()
        patcher = mock.patch.object(dz_accounts, "public_api", lambda: self.public)
        patcher.start()
        self.addCleanup(patcher.stop)

    def lend_only_to_bob(self):
        """The server's account lent to bob alone: carol has no account."""
        self.as_alice()
        self.grant("*", ["u:" + str(self.bob.id)])

    def own_account(self, user, status="ok", lossless=None):
        opts = '{"auto": {}, "last": null, "lossless": %s}' % (
            "null" if lossless is None else str(lossless).lower()
        )
        row = ProviderAccount.create(
            provider="deezer", user=user.id, label=user.name, secret="x", mode="arl",
            status=status, checked=now(), created=now(), options=opts,
        )
        access.bump()
        return row


class UpgradeTestCase(_P3Case):
    def test_the_public_api_is_opened_once_and_a_closing_sticks(self):
        self.as_bob()
        self.client.get("/api/me")
        anon = ProviderGrant.get(ProviderGrant.provider == "deezer", ProviderGrant.account == "")
        self.assertEqual((anon.feature, anon.subject), ("*", "all"))
        self.assertEqual(Meta["acc.anon.deezer"].value, "1")
        # the server's account is still everybody's, as before the upgrade
        acc = self.server_account()
        self.assertEqual(
            {(g.feature, g.subject) for g in ProviderGrant.select().where(ProviderGrant.account == str(acc.id))},
            {("*", "all")},
        )
        self.as_alice()
        self.grant("*", [], account="")
        access.invalidate()
        self.client.get("/api/me")
        self.assertEqual(
            ProviderGrant.select().where(ProviderGrant.provider == "deezer", ProviderGrant.account == "").count(), 0
        )

    def test_with_the_server_account_lent_to_all_nothing_moves(self):
        self.as_carol()
        rv = self.client.get("/api/album/987654")
        self.assertEqual(rv.status_code, 200)
        self.assertEqual(self.public.calls, [])  # the server's account answered, through the gateway


class PublicApiTestCase(_P3Case):
    def test_an_album_page_from_the_public_api(self):
        self.lend_only_to_bob()
        self.as_carol()
        with mock.patch("supysonic.webui.PUBLIC_PAGE", 2):
            rv = self.client.get("/api/album/600")
        self.assertEqual(rv.status_code, 200, rv.get_data(as_text=True))
        j = rv.get_json()
        self.assertEqual(j["album"]["title"], "Public album")
        self.assertEqual(j["album"]["cover"], "https://img/big.jpg")
        self.assertEqual([t["deezer_id"] for t in j["tracks"]], ["1001", "1002", "1003"])
        # every page of the tracklist was read, and each track knows its album
        self.assertEqual([c[2] for c in self.public.calls if c[0] == "album_tracks"], [0, 2])
        self.assertEqual({t["album"]["title"] for t in j["tracks"]}, {"Public album"})

    def test_an_album_deezer_does_not_have_is_a_404_and_an_outage_a_503(self):
        self.lend_only_to_bob()
        self.as_carol()
        self.assertEqual(self.client.get("/api/album/404").status_code, 404)
        self.public.down = True
        rv = self.client.get("/api/album/600")
        self.assertEqual(rv.status_code, 503)
        self.assertEqual(rv.headers.get("X-NS-Error"), "deezer-unreachable")

    def test_a_playlist_and_a_discography(self):
        self.lend_only_to_bob()
        self.as_carol()
        j = self.client.get("/api/playlist/77").get_json()
        self.assertEqual(j["playlist"]["title"], "Public playlist")
        self.assertFalse(j["playlist"]["editable"])
        self.assertEqual([t["deezer_id"] for t in j["tracks"]], ["2001", "2002"])
        d = self.client.get("/api/artist/5/discography").get_json()["discography"]
        self.assertEqual([x["title"] for x in d["all"]], ["New", "Single", "Old"])
        self.assertEqual([x["title"] for x in d["album"]], ["New", "Old"])
        self.assertEqual([x["title"] for x in d["single"]], ["Single"])

    def test_what_needs_an_account_is_refused_not_an_outage(self):
        self.lend_only_to_bob()
        self.as_carol()
        rv = self.client.post("/api/favorite", json={"deezer_id": "88888"})
        self.assertEqual(rv.status_code, 403)
        self.assertEqual(rv.headers.get("X-NS-Error"), "deezer-denied")
        self.assertEqual(self.public.calls, [])

    def test_a_closed_public_api_is_a_refusal(self):
        self.lend_only_to_bob()
        self.grant("*", [], account="")
        self.as_carol()
        rv = self.client.get("/api/album/600")
        self.assertEqual(rv.status_code, 403)
        self.assertEqual(rv.headers.get("X-NS-Error"), "deezer-denied")
        self.assertEqual(self.public.calls, [])

    def test_deezer_switched_off_is_never_the_public_api(self):
        self.app.deezer = None
        self.as_carol()
        rv = self.client.get("/api/album/600")
        self.assertEqual(rv.headers.get("X-NS-Error"), "deezer-disabled")
        self.assertEqual(self.public.calls, [])


class ServingOrderTestCase(_P3Case):
    def serving(self, user, feature):
        with self.app.test_request_context():
            return dz_accounts.serving(self.app, user, feature)

    def own_client(self):
        client = mock.Mock(name="bob's Deezer")
        client._login_error = None
        return client

    def test_ones_own_account_first(self):
        self.as_bob()
        self.client.get("/api/me")
        row = self.own_account(self.bob, lossless=True)
        client = self.own_client()
        with mock.patch.object(li, "_deezer_client", return_value=client) as made:
            self.assertIs(self.serving(self.bob, "browse")[0], client)
            self.assertIs(self.serving(self.bob, "stream")[0], client)
        self.assertEqual({c.args[1].id for c in made.call_args_list}, {row.id})
        # carol has none of her own: the server's
        self.assertIs(self.serving(self.carol, "browse")[0], self.app.deezer)

    def test_an_account_without_flac_never_fetches_the_sound(self):
        self.as_bob()
        self.client.get("/api/me")
        self.own_account(self.bob, lossless=False)
        client = self.own_client()
        with mock.patch.object(li, "_deezer_client", return_value=client):
            self.assertIs(self.serving(self.bob, "browse")[0], client)
            self.assertIs(self.serving(self.bob, "stream")[0], self.app.deezer)

    def test_an_offer_never_read_is_asked_once_and_kept(self):
        self.as_bob()
        self.client.get("/api/me")
        row = self.own_account(self.bob)
        client = self.own_client()
        client.dz.current_user = {"can_stream_lossless": True}
        with mock.patch.object(li, "_deezer_client", return_value=client):
            self.assertIs(self.serving(self.bob, "stream")[0], client)
        self.assertTrue(li.options(ProviderAccount.get_by_id(row.id))["lossless"])

    def test_a_refused_account_is_passed_over(self):
        self.as_bob()
        self.client.get("/api/me")
        self.own_account(self.bob, status="auth", lossless=True)
        with mock.patch.object(li, "_deezer_client") as made:
            self.assertIs(self.serving(self.bob, "browse")[0], self.app.deezer)
        made.assert_not_called()
        # and one Deezer refused at its last sign-in, before the import noticed
        ProviderAccount.update(status="ok").execute()
        access.bump()
        client = self.own_client()
        client._login_error = ("arl", "expired")
        with mock.patch.object(li, "_deezer_client", return_value=client):
            self.assertIs(self.serving(self.bob, "browse")[0], self.app.deezer)

    def test_nobody_lent_anything_is_the_public_api_for_the_catalogue_only(self):
        self.lend_only_to_bob()
        self.assertEqual(self.serving(self.carol, "browse"), (None, True))
        self.assertEqual(self.serving(self.carol, "search"), (None, True))
        self.assertEqual(self.serving(self.carol, "stream"), (None, False))
        self.assertEqual(self.serving(self.carol, "podcasts"), (None, False))

    def test_linking_records_the_offer(self):
        self.as_bob()
        who = {"id": "990001", "name": "Bob", "lossless": False}
        with mock.patch("supysonic.webui.myaccounts._deezer_login", return_value=who), \
                mock.patch.object(li, "start"):
            rv = self.client.post("/api/me/accounts/deezer", json={"arl": "a" * 192})
        self.assertEqual(rv.status_code, 200, rv.get_data(as_text=True))
        self.assertIs(rv.get_json()["account"]["lossless"], False)
        row = ProviderAccount.get(ProviderAccount.user == self.bob.id, ProviderAccount.mode == "arl")
        self.assertIs(li.options(row)["lossless"], False)

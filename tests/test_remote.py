# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Remote control (supysonic/webui/remote.py).

A link lends the owner's identity to whoever holds it, narrowed to a level.
What is pinned here is exactly what that must never get wrong: every endpoint
is classified and an unclassified one is refused; each level reaches what it
names and not one step further; nothing lets a controller take the owner's
hand off their own player (make or cut links, pose as the player); a cut ends
a session on its very next request and gives the browser its own account
back; and what crosses between the two devices is bounded and inert.
"""

import gzip
import json
import os
import shutil
import tempfile
import time
import unittest
from datetime import timedelta

from supysonic.config import DefaultConfig
from supysonic.db import RemoteLink, User, now, release_database
from supysonic.managers.user import UserManager
from supysonic.web import create_application
from supysonic.webui import remote as R

DEVICE = "livingroom-pc-0001"


class RemoteTestCase(unittest.TestCase):
    def setUp(self):
        R._reset_for_tests()
        self.__db = tempfile.mkstemp()
        self.__dir = tempfile.mkdtemp()
        db_path = self.__db[1]
        cache = self.__dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(
                    self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True
                )

        self.app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bbb", admin=False)
        self.owner = self._login("alice", "Alic3")

    def tearDown(self):
        R._reset_for_tests()
        release_database()
        shutil.rmtree(self.__dir, ignore_errors=True)
        os.close(self.__db[0])
        os.remove(self.__db[1])

    # -- fixtures -----------------------------------------------------------------

    def _login(self, name, password):
        c = self.app.test_client()
        r = c.post("/api/login", json={"username": name, "password": password})
        self.assertEqual(r.status_code, 200)
        return c

    def _link(self, level="queue", owner=None, **extra):
        owner = owner or self.owner
        r = owner.post(
            "/api/remote/links",
            json={"level": level, "device": DEVICE, "device_name": "PC du salon", **extra},
        )
        self.assertEqual(r.status_code, 200, r.get_json())
        return r.get_json()["link"]

    def _controller(self, level="queue", client=None):
        link = self._link(level)
        c = client or self.app.test_client()
        r = c.post("/api/remote/claim", json={"token": link["token"]})
        self.assertEqual(r.status_code, 200, r.get_json())
        return c, link

    def _host_online(self):
        r = self.owner.get(f"/api/remote/host/{DEVICE}/poll?since=0")
        self.assertTrue(r.get_json()["active"])
        return r.get_json()

    # -- the policy ------------------------------------------------------------------

    def test_every_endpoint_is_classified(self):
        """An endpoint missing from POLICY is refused to every remote session —
        which is safe, but it also means a new screen silently does nothing
        for a controller. So the table must name each route, and no more."""
        endpoints = {
            rule.endpoint[len("webapi."):]
            for rule in self.app.url_map.iter_rules()
            if rule.endpoint.startswith("webapi.")
        }
        self.assertEqual(sorted(endpoints - set(R.POLICY)), [], "unclassified endpoints")
        self.assertEqual(sorted(set(R.POLICY) - endpoints), [], "stale policy entries")
        for name, rule in R.POLICY.items():
            rules = rule.values() if isinstance(rule, dict) else [rule]
            for r in rules:
                self.assertIn(r, R.LEVELS + (R.NEVER,), name)

    def test_levels_are_nested(self):
        self.assertEqual(R.LEVELS, ("queue", "read", "full", "admin"))
        self.assertTrue(R.allows("admin", "queue"))
        self.assertFalse(R.allows("read", "full"))
        self.assertFalse(R.allows("admin", None), "NEVER is never")

    # -- making links ----------------------------------------------------------------

    def test_a_link_is_made_listed_and_its_token_is_not_its_id(self):
        link = self._link("read", label="Léa")
        self.assertEqual(link["level"], "read")
        self.assertEqual(link["label"], "Léa")
        self.assertTrue(link["token"].startswith(link["id"] + "."))
        self.assertEqual(len(link["token"].split(".")[1]), 24)
        listed = self.owner.get("/api/remote/links").get_json()["links"]
        self.assertEqual([x["id"] for x in listed], [link["id"]])
        # The id alone opens nothing, nor does a token with a forged mac.
        c = self.app.test_client()
        self.assertEqual(c.post("/api/remote/claim", json={"token": link["id"]}).status_code, 404)
        forged = link["id"] + "." + "A" * 24
        self.assertEqual(c.post("/api/remote/claim", json={"token": forged}).status_code, 404)

    def test_only_an_admin_lends_administration(self):
        bob = self._login("bob", "B0bbb")
        r = bob.post("/api/remote/links", json={"level": "admin", "device": DEVICE})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(
            bob.post("/api/remote/links", json={"level": "full", "device": DEVICE}).status_code, 200
        )

    def test_bad_requests_make_no_link(self):
        for body in (
            {"level": "root", "device": DEVICE},
            {"level": "queue", "device": "../../etc"},
            {"level": "queue", "device": DEVICE, "ttl": 10},
            {"level": "queue", "device": DEVICE, "ttl": "soon"},
        ):
            self.assertEqual(self.owner.post("/api/remote/links", json=body).status_code, 400, body)
        self.assertEqual(RemoteLink.select().count(), 0)

    # -- claiming ---------------------------------------------------------------------

    def test_a_claimed_session_is_the_owner_narrowed(self):
        c, link = self._controller("read")
        me = c.get("/api/me").get_json()
        self.assertEqual(me["user"], {"name": "alice", "admin": True})
        self.assertEqual(me["remote"]["level"], "read")
        self.assertEqual(me["remote"]["owner"], "alice")
        self.assertEqual(me["remote"]["device"], "PC du salon")

    def test_queue_reaches_the_player_and_nothing_else(self):
        c, _ = self._controller("queue")
        self.assertEqual(c.get("/api/remote/state").status_code, 200)
        self.assertNotEqual(c.get("/api/cover/123").status_code, 403)
        for path in ("/api/search?q=a", "/api/me/favorites", "/api/lyrics/1", "/api/home"):
            self.assertEqual(c.get(path).status_code, 403, path)

    def test_read_sees_everything_and_changes_nothing_kept(self):
        c, _ = self._controller("read")
        for path in ("/api/me/favorites", "/api/me/playlists", "/api/search?q=a"):
            self.assertNotEqual(c.get(path).status_code, 403, path)
        # A POST that is a read.
        self.assertNotEqual(c.post("/api/gains", json={"ids": []}).status_code, 403)
        for method, path, body in (
            ("post", "/api/favorite", {"id": "1", "on": True}),
            ("post", "/api/playlists", {"title": "x"}),
            ("post", "/api/settings", {}),
            ("get", "/api/settings", None),
            ("get", "/api/stream/1", None),
            ("post", "/api/genre/label", {}),
        ):
            r = getattr(c, method)(path, json=body) if body is not None else getattr(c, method)(path)
            self.assertEqual(r.status_code, 403, f"{method} {path}")

    def test_full_is_everything_but_administration_and_may_tag(self):
        c, _ = self._controller("full")
        self.assertNotEqual(c.post("/api/favorite", json={"id": "1", "on": True}).status_code, 403)
        self.assertNotEqual(c.post("/api/genre/label", json={}).status_code, 403)
        for method, path in (
            ("get", "/api/settings"),
            ("post", "/api/sync"),
            ("post", "/api/cache/flush"),
            ("post", "/api/genre/embed"),
            ("put", "/api/genre/model"),
        ):
            self.assertEqual(getattr(c, method)(path, json={}).status_code, 403, path)

    def test_admin_administrates(self):
        c, _ = self._controller("admin")
        self.assertEqual(c.get("/api/settings").status_code, 200)

    def test_no_level_takes_the_owners_hand(self):
        c, link = self._controller("admin")
        for method, path in (
            ("get", "/api/remote/links"),
            ("post", "/api/remote/links"),
            ("delete", f"/api/remote/links/{link['id']}"),
            ("delete", "/api/remote/links"),
            ("get", f"/api/remote/host/{DEVICE}/poll"),
            ("post", f"/api/remote/host/{DEVICE}"),
            ("post", "/api/party"),
            ("post", "/api/listen"),
        ):
            r = getattr(c, method)(path, json={"level": "admin", "device": DEVICE})
            self.assertEqual(r.status_code, 403, f"{method} {path}")
        self.assertIsNone(RemoteLink.get_by_id(link["id"]).revoked)

    def test_a_remote_session_is_not_a_login_to_the_admin_pages(self):
        c, _ = self._controller("admin")
        r = c.get("/")
        self.assertIn(r.status_code, (302, 303))
        self.assertIn("/user/login", r.headers["Location"])

    # -- ending --------------------------------------------------------------------------

    def test_a_cut_ends_the_session_on_its_next_request(self):
        c, link = self._controller("full")
        self.assertEqual(c.get("/api/me").status_code, 200)
        self.assertEqual(self.owner.delete(f"/api/remote/links/{link['id']}").get_json()["revoked"], 1)
        r = c.get("/api/me")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.get_json()["error"], "remote ended")
        # ...and it stays ended: the grant is gone from the cookie.
        self.assertEqual(c.get("/api/me").status_code, 401)
        self.assertEqual(c.get("/api/me").get_json()["error"], "unauthorized")

    def test_cutting_a_device_cuts_every_link_onto_it(self):
        c1, _ = self._controller("queue")
        c2, _ = self._controller("read")
        self.assertEqual(self.owner.delete(f"/api/remote/links?device={DEVICE}").get_json()["revoked"], 2)
        self.assertEqual(c1.get("/api/remote/state").status_code, 401)
        self.assertEqual(c2.get("/api/remote/state").status_code, 401)
        self.assertEqual(self.owner.get("/api/remote/links").get_json()["links"], [])

    def test_leaving_gives_the_browser_its_own_account_back(self):
        bob = self._login("bob", "B0bbb")
        self._controller("read", client=bob)
        self.assertEqual(bob.get("/api/me").get_json()["user"]["name"], "alice")
        r = bob.post("/api/remote/leave")
        self.assertEqual(r.get_json()["restored"], {"name": "bob", "admin": False})
        me = bob.get("/api/me").get_json()
        self.assertEqual(me["user"]["name"], "bob")
        self.assertNotIn("remote", me)

    def test_logging_out_of_a_lent_session_only_ends_the_loan(self):
        bob = self._login("bob", "B0bbb")
        _, link = self._controller("read", client=bob)
        r = bob.post("/api/logout")
        self.assertEqual(r.get_json()["restored"], {"name": "bob", "admin": False})
        me = bob.get("/api/me").get_json()
        self.assertEqual(me["user"]["name"], "bob")
        self.assertNotIn("remote", me)
        # ...and the link itself is still the owner's to cut or keep.
        self.assertEqual([l["id"] for l in self.owner.get("/api/remote/links").get_json()["links"]], [link["id"]])
        # A browser with no account of its own is simply logged out.
        c, _ = self._controller("read")
        self.assertIsNone(c.post("/api/logout").get_json()["restored"])
        self.assertEqual(c.get("/api/me").status_code, 401)

    def test_a_cut_gives_it_back_too(self):
        bob = self._login("bob", "B0bbb")
        _, link = self._controller("read", client=bob)
        self.owner.delete(f"/api/remote/links/{link['id']}")
        r = bob.get("/api/me")
        self.assertEqual(r.get_json()["restored"], {"name": "bob", "admin": False})
        self.assertEqual(bob.get("/api/me").get_json()["user"]["name"], "bob")

    def test_an_expired_link_ends_its_sessions(self):
        c, link = self._controller("read")
        RemoteLink.update(expires=now() - timedelta(seconds=1)).where(
            RemoteLink.id == link["id"]
        ).execute()
        R._reset_for_tests()  # past the 2 s cache
        self.assertEqual(c.get("/api/me").status_code, 401)
        self.assertEqual(self.owner.get("/api/remote/links").get_json()["links"], [])

    def test_the_owners_new_password_ends_every_lent_session(self):
        c, _ = self._controller("full")
        UserManager.change_password2("alice", "N3wpass")
        self.assertEqual(c.get("/api/me").status_code, 401)

    # -- the channel ------------------------------------------------------------------

    def test_a_command_reaches_the_player_only_while_it_listens(self):
        c, link = self._controller("queue")
        self.assertEqual(c.post("/api/remote/cmd", json={"op": "pause"}).status_code, 409)
        poll = self._host_online()
        r = c.post("/api/remote/cmd", json={"op": "pause"})
        self.assertEqual(r.status_code, 200)
        seq = r.get_json()["seq"]
        got = self.owner.get(f"/api/remote/host/{DEVICE}/poll?since=0&chan={poll['chan']}").get_json()
        self.assertEqual([(x["seq"], x["op"]) for x in got["cmds"]], [(seq, "pause")])
        self.assertEqual(got["controllers"], [{"link": link["id"], "level": "queue", "label": ""}])
        # Once seen, not again.
        again = self.owner.get(f"/api/remote/host/{DEVICE}/poll?since={seq}&chan={poll['chan']}").get_json()
        self.assertEqual(again["cmds"], [])

    def test_a_stale_command_is_dropped_not_replayed(self):
        """Five skips pressed while the player was unreachable must not all
        land the moment it comes back."""
        c, _ = self._controller("queue")
        poll = self._host_online()
        c.post("/api/remote/cmd", json={"op": "next"})
        with R._lock:
            ch = R._channels[(str(User.get(name="alice").id), DEVICE)]
            for cmd in ch.cmds:
                cmd["at"] -= 8.5  # past CMD_TTL (8 s)
        got = self.owner.get(f"/api/remote/host/{DEVICE}/poll?since=0&chan={poll['chan']}").get_json()
        self.assertEqual(got["cmds"], [])

    def test_each_level_sends_only_its_commands(self):
        q, _ = self._controller("queue")
        self._host_online()
        track = {"deezer_id": "3135556", "title": "Harder, Better"}
        self.assertEqual(q.post("/api/remote/cmd", json={"op": "seek", "args": {"t": 30}}).status_code, 200)
        self.assertEqual(q.post("/api/remote/cmd", json={"op": "add", "args": {"tracks": [track]}}).status_code, 403)
        self.assertEqual(q.post("/api/remote/cmd", json={"op": "shuffle"}).status_code, 403)
        r, _ = self._controller("read")
        self.assertEqual(r.post("/api/remote/cmd", json={"op": "add", "args": {"tracks": [track]}}).status_code, 200)

    def test_settings_only_those_the_player_has_and_the_pictures_from_read(self):
        r, _ = self._controller("read")
        poll = self._host_online()
        self.owner.post(
            f"/api/remote/host/{DEVICE}",
            json={"state": {}, "settings": {"viz.mode": "smart", "fx.eq.enabled": False}, "sv": "s1"},
        )
        ok = r.post("/api/remote/cmd", json={"op": "set", "args": {"key": "viz.mode", "value": "bars"}})
        self.assertEqual(ok.status_code, 200)
        eq = r.post("/api/remote/cmd", json={"op": "set", "args": {"key": "fx.eq.enabled", "value": True}})
        self.assertEqual(eq.status_code, 403)
        unknown = r.post("/api/remote/cmd", json={"op": "set", "args": {"key": "auth.user", "value": {}}})
        self.assertEqual(unknown.status_code, 400)
        f, _ = self._controller("full")
        eq = f.post("/api/remote/cmd", json={"op": "set", "args": {"key": "fx.eq.enabled", "value": True}})
        self.assertEqual(eq.status_code, 200)
        got = self.owner.get(f"/api/remote/host/{DEVICE}/poll?since=0&chan={poll['chan']}").get_json()
        self.assertEqual(
            [(x["op"], x["args"]) for x in got["cmds"]],
            [("set", {"key": "viz.mode", "value": "bars"}), ("set", {"key": "fx.eq.enabled", "value": True})],
        )

    def test_an_id_can_never_steer_the_players_requests(self):
        """The web app builds request paths from track ids; a controller must
        not be able to hand the player one that walks out of its segment."""
        c, _ = self._controller("read")
        self._host_online()
        for bad in ("../../api/logout", "1/../2", "a b", "x" * 80, None):
            r = c.post("/api/remote/cmd", json={"op": "jump", "args": {"i": 0, "id": bad}})
            self.assertEqual(r.status_code, 400, bad)
            r = c.post("/api/remote/cmd", json={"op": "add", "args": {"tracks": [{"deezer_id": bad}]}})
            self.assertEqual(r.status_code, 400, bad)
        # Nested ids are dropped, the track kept.
        t = {"deezer_id": "1", "album": {"deezer_id": "../x", "title": "A"}, "artist": {"deezer_id": 42}}
        self.assertEqual(R.clean_track(t), {"deezer_id": "1", "album": {"title": "A"}, "artist": {"deezer_id": "42"}})

    def test_what_the_player_publishes_is_what_the_controller_reads(self):
        c, _ = self._controller("read")
        self._host_online()
        queue = [{"deezer_id": str(i), "title": f"T{i}", "album": {"cover": "https://e-cdns-images.dzcdn.net/x.jpg"}} for i in range(3)]
        body = {
            "state": {"index": 1, "playing": True, "p": 42.5, "duration": 200, "volume": 0.4,
                      "repeat": "all", "track": queue[1], "status": "x" * 100},
            "queue": queue,
            "qv": "q1",
            "settings": {"viz.mode": "smart"},
            "sv": "s1",
        }
        # Compressed, as the player sends a long queue.
        r = self.owner.post(
            f"/api/remote/host/{DEVICE}",
            data=gzip.compress(json.dumps(body).encode()),
            headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
        )
        self.assertEqual(r.get_json(), {"active": True, "chan": r.get_json()["chan"], "need_queue": False, "need_settings": False})
        st = c.get("/api/remote/state").get_json()
        self.assertTrue(st["online"])
        self.assertEqual(st["state"]["index"], 1)
        self.assertEqual(st["state"]["p"], 42.5)
        self.assertEqual(st["state"]["repeat"], "all")
        self.assertEqual(len(st["state"]["status"]), 40)
        self.assertEqual(st["qv"], "q1")
        self.assertEqual(st["settings"], {"viz.mode": "smart"})
        self.assertLessEqual(abs(st["now"] - st["state"]["t"]), 2000)
        # Asked with the settings it already holds, it is not sent them again.
        self.assertNotIn("settings", c.get("/api/remote/state?sv=s1").get_json())
        self.assertEqual([t["deezer_id"] for t in c.get("/api/remote/queue").get_json()["queue"]], ["0", "1", "2"])

    def test_a_restart_is_repaired_by_the_player(self):
        """The live channel is memory; the player rebuilds it on its own."""
        self._link("queue")
        poll = self._host_online()
        self.owner.post(f"/api/remote/host/{DEVICE}", json={"state": {}, "queue": [], "qv": "q1", "sv": "s1", "settings": {}})
        R._reset_for_tests()  # the process restarted
        again = self.owner.get(f"/api/remote/host/{DEVICE}/poll?since=12&chan={poll['chan']}").get_json()
        self.assertTrue(again["reset"])
        self.assertFalse(again["has_state"])
        r = self.owner.post(f"/api/remote/host/{DEVICE}", json={"state": {}, "qv": "q1", "sv": "s1"}).get_json()
        self.assertTrue(r["need_queue"] and r["need_settings"])

    def test_a_command_sent_while_the_player_reconnects_is_not_lost(self):
        c, _ = self._controller("queue")
        poll = self._host_online()
        R._reset_for_tests()
        self._host_online()  # the player's first poll after the restart…
        c.post("/api/remote/cmd", json={"op": "toggle"})
        # …and its second, still holding the old channel id: it gets the command.
        got = self.owner.get(f"/api/remote/host/{DEVICE}/poll?since=99&chan={poll['chan']}").get_json()
        self.assertEqual([x["op"] for x in got["cmds"]], ["toggle"])

    def test_a_player_with_no_live_link_is_told_to_stop_asking(self):
        link = self._link("queue")
        self._host_online()
        self.owner.delete(f"/api/remote/links/{link['id']}")
        self.assertEqual(self.owner.get(f"/api/remote/host/{DEVICE}/poll").get_json(), {"active": False})
        self.assertEqual(self.owner.post(f"/api/remote/host/{DEVICE}", json={}).get_json(), {"active": False})

    def test_a_decompression_bomb_is_refused(self):
        self._link("queue")
        bomb = gzip.compress(b"[" + b"0," * (R.MAX_BODY // 2 + 10) + b"0]")
        r = self.owner.post(
            f"/api/remote/host/{DEVICE}",
            data=bomb,
            headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
        )
        self.assertEqual(r.status_code, 400)

    # -- the short link ------------------------------------------------------------

    def test_the_short_link_forwards_into_the_app_and_claims_nothing(self):
        """A messaging app fetches the link to preview it: that fetch must not
        take the grant (the claim is the app's own POST), and it must not say
        anything once the link is dead."""
        link = self._link("read")
        anon = self.app.test_client()
        r = anon.get(f"/rc/{link['token']}")
        self.assertEqual(r.status_code, 200)
        page = r.get_data(as_text=True)
        self.assertIn(f"url=/app/#/rc/{link['token']}", page)
        self.assertIn("Piloter le lecteur de alice", page)
        self.assertEqual(r.headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(anon.get("/api/me").status_code, 401, "opening the page claimed nothing")
        self.owner.delete(f"/api/remote/links/{link['id']}")
        R._reset_for_tests()
        dead = anon.get(f"/rc/{link['token']}").get_data(as_text=True)
        self.assertIn("plus valide", dead)
        self.assertNotIn("alice", dead)
        self.assertEqual(anon.get("/rc/" + link["id"] + "." + "A" * 24).status_code, 404)
        self.assertEqual(anon.get("/rc/<script>").status_code, 404)


if __name__ == "__main__":
    unittest.main()

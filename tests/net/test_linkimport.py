# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The shared-playlist readers against the real pages (weekly in CI).

The offline suite holds the parsers to fixtures written in each page's shape;
only this says the shape is still the one the services serve. Long-lived
editorial playlists, so a failure means a page changed, not a list deleted.
"""

import unittest

from deezerpy import _Session

from supysonic import linkimport


class LinkImportNetTestCase(unittest.TestCase):
    def setUp(self):
        self.session = _Session()

    def tearDown(self):
        self.session.close()

    def check(self, playlist, at_least=10):
        self.assertTrue(playlist["name"])
        self.assertGreaterEqual(len(playlist["tracks"]), at_least)
        with_artist = [t for t in playlist["tracks"] if t["artists"]]
        with_length = [t for t in playlist["tracks"] if t["duration"]]
        self.assertGreater(len(with_artist), 0.9 * len(playlist["tracks"]))
        self.assertGreater(len(with_length), 0.9 * len(playlist["tracks"]))

    def test_spotify(self):
        link = linkimport.parse("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")
        self.check(linkimport.read_spotify(self.session, link))

    def test_apple_music(self):
        link = linkimport.parse(
            "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb"
        )
        self.check(linkimport.read_apple(self.session, link))

    def test_deezer(self):
        from deezerpy.api import API

        link = linkimport.parse("https://www.deezer.com/fr/playlist/1109890291")
        self.check(linkimport.read_deezer(API(self.session, {}), link))

    @unittest.skipUnless(__import__("importlib").util.find_spec("ytmusicapi"), "ytmusicapi missing")
    def test_youtube(self):
        link = linkimport.parse(
            "https://music.youtube.com/playlist?list=RDCLAK5uy_kmPRjHDECIcuVwnKsx2Ng7fyNgFKWNJFs"
        )
        self.check(linkimport.read_youtube(link))


if __name__ == "__main__":
    unittest.main()

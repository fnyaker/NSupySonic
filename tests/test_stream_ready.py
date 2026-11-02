# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic API server.
#
# Distributed under terms of the GNU AGPLv3 license.

"""``/api/stream/<id>/ready``: is the stream a finished file yet? The player asks this before it
re-fetches a stream for a seek (a first play is generated as it is sent: no length, no ranges)."""

import os
import unittest

from supysonic.db import Track

from .test_discover import _Library


class StreamReadyTestCase(_Library):
    def _track(self):
        from supysonic.deezer import library

        root = library.get_root_folder(self.archive)
        return library.upsert_track(
            {"SNG_ID": "777001", "SNG_TITLE": "T", "ART_ID": "1", "ART_NAME": "A", "ALB_ID": "2",
             "ALB_TITLE": "L", "ALB_PICTURE": "x", "DURATION": 200, "TRACK_NUMBER": 1,
             "DISK_NUMBER": 1, "EXPLICIT_LYRICS": "0", "GAIN": "-7.0"}, root)

    def test_a_track_not_on_disk_is_not_ready_and_nothing_is_started(self):
        t = self._track()
        self.assertFalse(os.path.exists(t.path))
        r = self.client.get("/api/stream/777001/ready")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json["ready"])

    def test_an_archived_track_is_ready_and_an_opus_one_only_once_cached(self):
        t = self._track()
        os.makedirs(os.path.dirname(t.path), exist_ok=True)
        with open(t.path, "wb") as fp:
            fp.write(b"x" * 100)
        self.assertTrue(self.client.get("/api/stream/777001/ready").json["ready"])
        # the Opus transcode is a file only once it is in the cache
        self.assertFalse(self.client.get("/api/stream/777001/ready?q=OPUS_128").json["ready"])
        self.app.transcode_cache.set(f"deezer-{t.id}-opus128.ogg", b"ogg")
        self.assertTrue(self.client.get("/api/stream/777001/ready?q=OPUS_128").json["ready"])

    def test_junk_ids_are_refused_and_an_unknown_one_is_just_not_ready(self):
        self.assertEqual(self.client.get("/api/stream/not-an-id/ready").status_code, 400)
        r = self.client.get("/api/stream/999999999/ready")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json["ready"])

    def test_it_asks_nothing_of_the_provider(self):
        self.app.deezer = None
        self.assertEqual(self.client.get("/api/stream/123456/ready").status_code, 200)


if __name__ == "__main__":
    unittest.main()

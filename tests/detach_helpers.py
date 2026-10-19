# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Counting what the app writes to the Deezer account.

The detachment's promise is that nothing the user does here changes their Deezer
account any more. ``record_deezer_writes`` wraps the simulated provider and its
gateway so a test can perform a whole cycle and then say, with a number, that no
write went out.
"""

# The provider-level names (``DeezerProvider``) of everything that writes.
DEEZER_WRITES = (
    "create_playlist",
    "add_songs_to_playlist",
    "remove_songs_from_playlist",
    "delete_playlist",
    "edit_playlist",
    "add_song_to_favorites",
    "remove_song_from_favorites",
    "add_favorite_album",
    "remove_favorite_album",
    "add_favorite_artist",
    "remove_favorite_artist",
    "add_favorite_playlist",
    "remove_favorite_playlist",
    "add_favorite_show",
    "remove_favorite_show",
    "set_episode_position",
    "report_listen",
    "set_flow_clusters",
)

# The same writes under the names the gateway and the GraphQL client give them
# (what ``MockGW`` / ``MockGQL`` in tests/test_webui.py answer to).
GATEWAY_WRITES = (
    "add_album_to_favorites",
    "remove_album_from_favorites",
    "add_artist_to_favorites",
    "remove_artist_from_favorites",
    "add_playlist_to_favorites",
    "remove_playlist_from_favorites",
    "set_episode_bookmark",
    "log_listen",
    "update_flow_clusters",
)

ALL_WRITES = tuple(dict.fromkeys(DEEZER_WRITES + GATEWAY_WRITES))


class DeezerWriteRecorder:
    """Wraps the write methods found on ``targets`` and remembers each call."""

    def __init__(self, *targets):
        self.calls = []
        for target in targets:
            if target is None:
                continue
            for name in ALL_WRITES:
                original = getattr(target, name, None)
                if callable(original):
                    setattr(target, name, self._wrap(name, original))

    def _wrap(self, name, original):
        def recorded(*args, **kwargs):
            self.calls.append(name)
            return original(*args, **kwargs)

        return recorded

    def reset(self):
        self.calls.clear()

    def __len__(self):
        return len(self.calls)


def record_deezer_writes(provider):
    """Record the writes of a provider whose client is the simulated one."""
    dz = getattr(provider, "_dz", None)
    return DeezerWriteRecorder(
        provider,
        dz,
        getattr(dz, "gw", None),
        getattr(dz, "gql", None),
        getattr(dz, "api", None),
    )


def assert_no_deezer_writes(test, recorder):
    """Fail ``test`` if anything was written to the Deezer account."""
    test.assertEqual(
        recorder.calls, [], "writes reached the Deezer account: %r" % recorder.calls
    )
